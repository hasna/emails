// The transport: one `fetch` per operation, asynchronous, and nothing else.
//
// THIS IS THE MODULE THAT REPLACES `spawnSync("curl")`. The store seam requires
// every operation to return a Promise (repositories.ts rule 1) for one reason: the
// previous HTTP arm shelled out to `curl` through `spawnSync` so a network call
// could pretend to be a blocking one, and that pretence is why the arm could never
// be honest — it could not stream, could not time out per-request without a signal,
// and made every caller's control flow depend on which store it held. So:
//
//   * `fetch` only. No child process, no synchronous IO, no polling loop.
//   * A per-request `AbortSignal` timeout, so a hung service fails this operation
//     rather than the process.
//   * A response-size ceiling, because an unbounded `text()` on a service that
//     answers with something unexpected is a memory fault, not a refusal.
//
// The transport NEVER decides whether an operation succeeded. It hands back the
// status and the parsed body; outcome.ts decides what they mean. That split is what
// keeps "the API declined" and "the transport broke" from being answered by the same
// code path.

import { EmailsApiFault } from "./outcome.js";
import {
  EMAILS_SELF_HOSTED_API_KEY_ENV,
  EMAILS_SESSION_TOKEN_ENV,
  type EmailsClientCredentialCandidate,
  type EmailsClientCredentialSetting,
} from "../lib/client-env.js";

/** The default per-request deadline, matching `EMAILS_SELF_HOSTED_HTTP_TIMEOUT`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The default response ceiling, matching the existing async wire's 8 MiB. */
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The `fetch` shape this store needs. Injectable so a test drives a real server. */
export type FetchImplementation = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface TransportOptions {
  /**
   * The service origin, with or without a trailing `/v1`. Normalised to end in
   * exactly one `/v1` — the same normalisation `toV1BaseUrl` performs — so a caller
   * configuring either spelling reaches the same routes.
   */
  baseUrl: string;
  /** The API key or session token. Sent as a bearer credential, never logged. */
  credential: string;
  /** Which setting supplied `credential`; safe to report. */
  credentialSetting?: EmailsClientCredentialSetting;
  /** Later credentials to try after a selected session token needs reauthentication. */
  credentialFallbacks?: readonly EmailsClientCredentialCandidate[];
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** A query value. An array becomes a repeated parameter, which is how `domain` works. */
export type QueryValue = string | number | boolean | readonly string[] | undefined | null;

export interface WireResponse {
  status: number;
  /** The parsed JSON body, or null when the service sent none. */
  body: unknown;
}

export interface Transport {
  request(
    method: string,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<WireResponse>;
  /** The credential-free origin, for `StoreDescriptor.detail`. */
  readonly safeBaseUrl: string;
}

/**
 * Normalise a configured URL to the `/v1` base, and strip anything that must never
 * reach a log.
 *
 * `username`/`password` are cleared rather than preserved: a URL-embedded credential
 * would otherwise travel into `descriptor.detail`, which descriptor.ts requires to be
 * safe to print. The search string and hash go for the same reason.
 */
export function toV1BaseUrl(configured: string): { requestBase: string; safeBase: string } {
  const parsed = new URL(configured);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const trimmed = parsed.toString().replace(/\/+$/, "");
  const requestBase = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return { requestBase, safeBase: requestBase.replace(/\/v1$/, "") };
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    // An array becomes a REPEATED parameter rather than a comma-joined one: the
    // service reads `domain` repeatably, and a comma-joined value would silently
    // scope a query to one impossible domain name instead of to several.
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
      continue;
    }
    params.append(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

function credentialCandidates(options: TransportOptions): readonly EmailsClientCredentialCandidate[] {
  return [
    { setting: options.credentialSetting ?? EMAILS_SELF_HOSTED_API_KEY_ENV, value: options.credential },
    ...(options.credentialFallbacks ?? []),
  ];
}

function errorReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const fields = body as { reason?: unknown; code?: unknown };
  if (typeof fields.reason === "string") return fields.reason;
  if (typeof fields.code === "string") return fields.code;
  return null;
}

function shouldTryNextCredential(candidate: EmailsClientCredentialCandidate, response: WireResponse): boolean {
  return candidate.setting === EMAILS_SESSION_TOKEN_ENV
    && response.status === 401
    && errorReason(response.body) === "reauthenticate";
}

export function createTransport(options: TransportOptions): Transport {
  const { requestBase, safeBase } = toV1BaseUrl(options.baseUrl);
  const doFetch: FetchImplementation = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const candidates = credentialCandidates(options);

  return {
    safeBaseUrl: safeBase,
    async request(method, path, requestOptions): Promise<WireResponse> {
      const url = `${requestBase}${path}${buildQuery(requestOptions?.query)}`;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const response = await requestOnce(
          doFetch,
          timeoutMs,
          maxResponseBytes,
          candidate.value,
          url,
          method,
          path,
          requestOptions,
        );
        if (index < candidates.length - 1 && shouldTryNextCredential(candidate, response)) continue;
        return response;
      }
      return requestOnce(doFetch, timeoutMs, maxResponseBytes, options.credential, url, method, path, requestOptions);
    },
  };
}

async function requestOnce(
  doFetch: FetchImplementation,
  timeoutMs: number,
  maxResponseBytes: number,
  credential: string,
  url: string,
  method: string,
  path: string,
  requestOptions: { query?: Record<string, QueryValue>; body?: unknown } | undefined,
): Promise<WireResponse> {
  const headers: Record<string, string> = {
    // Bearer, matching what both existing self-hosted clients send and what the
    // service's `extractToken` accepts alongside `x-api-key`.
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
  };
  const hasBody = requestOptions?.body !== undefined;
  if (hasBody) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  // The deadline covers the BODY READ, not just the headers. Cleared in the outer
  // `finally` below rather than as soon as `fetch` resolves: a service that sends
  // headers promptly and then stalls the body would otherwise hang this call
  // forever, with the timeout already disarmed — the failure mode a per-request
  // deadline exists to prevent, reintroduced by clearing it one step too early.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(requestOptions?.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // A transport failure is a FAULT, never a refusal — see outcome.ts RULE 1.
      // The message names the method and path but never the query string, which can
      // carry a recipient address, and never the headers, which carry the credential.
      const cause = error instanceof Error ? error.message : String(error);
      throw new EmailsApiFault(0, `${method} ${path} could not reach the Emails API: ${cause}`);
    }

    let text: string;
    try {
      text = await readBounded(response, maxResponseBytes, controller.signal, `${method} ${path}`);
    } catch (error) {
      // The BODY READ gets the same treatment as the connection: a mid-body reset, a
      // TLS failure or the deadline firing is a FAULT and must arrive as the typed
      // one, because callers discriminate with `instanceof EmailsApiFault`. An earlier
      // version called this outside the try/catch above, so those rejections escaped
      // raw while outcome.ts promised every network error would be typed.
      if (error instanceof EmailsApiFault) throw error;
      const cause = error instanceof Error ? error.message : String(error);
      throw new EmailsApiFault(0, `${method} ${path} failed while reading the response: ${cause}`);
    }
    if (text.length === 0) return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      // Unparseable body on a SUCCESS status is a fault: the caller asked a question
      // and there is no answer to read. On an error status the status still carries
      // meaning, so the body is reported as absent and outcome.ts maps the status.
      if (response.status >= 200 && response.status < 300) {
        throw new EmailsApiFault(response.status, `${method} ${path} answered with a body that is not JSON`);
      }
      return { status: response.status, body: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reject as soon as the deadline fires, whoever is or is not honouring the signal.
 *
 * THE DEADLINE MUST NOT DEPEND ON THE TRANSPORT COOPERATING. `fetch` is injectable here,
 * and the real one does wire an `AbortSignal` into the body stream — but a stub, a
 * caching layer, or an older polyfill may hand back a stream that ignores it entirely.
 * When that happens `reader.read()` never settles, and awaiting it alone hangs the call
 * forever with the timeout already fired and nothing to observe it. Adversarial review
 * found exactly that, using a stub whose stream ignored the signal: the guard was written
 * to trust the very thing it was guarding against.
 *
 * So every read is RACED against the signal. The abort is then enforced by this module
 * regardless of what the stream does, which is the only version of a deadline that holds
 * for an injectable transport.
 */
function abortRace<TValue>(work: Promise<TValue>, signal: AbortSignal, what: string): Promise<TValue> {
  if (!signal.aborted && typeof signal.addEventListener !== "function") return work;
  return new Promise<TValue>((resolve, reject) => {
    const fail = (): void =>
      reject(new EmailsApiFault(0, `${what} exceeded its deadline before the response finished`));
    if (signal.aborted) {
      fail();
      return;
    }
    const onAbort = (): void => fail();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Read a response body, stopping at the ceiling instead of after exceeding it.
 *
 * The earlier version called `response.text()` and THEN compared the length, which
 * enforced nothing that mattered: the whole body was already decoded into memory by the
 * time the ceiling was consulted, so the check reported a memory fault it had just
 * finished causing. Streaming and aborting mid-read is the only version of this guard
 * that does what its comment claims.
 *
 * `Content-Length` is consulted first as a cheap early exit, but it is NOT trusted as
 * the only check: it is absent on a chunked response, which is exactly the shape an
 * unbounded body arrives in.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  what: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new EmailsApiFault(
        response.status,
        `${what} declared ${length} bytes, over the ${maxBytes}-byte ceiling`,
      );
    }
  }
  const body = response.body;
  if (!body) {
    // No stream to read from — an empty body, or a `fetch` implementation that does not
    // expose one. The buffered read cannot be bounded as it goes, so it is bounded after
    // the fact AND raced against the deadline, which is strictly better than the
    // unbounded `text()` this branch used to be.
    const buffered = await abortRace(response.text(), signal, what);
    const size = new TextEncoder().encode(buffered).byteLength;
    if (size > maxBytes) {
      throw new EmailsApiFault(response.status, `${what} answered with ${size} bytes, over the ${maxBytes}-byte ceiling`);
    }
    return buffered;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortRace(reader.read(), signal, what);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new EmailsApiFault(
          response.status,
          `${what} answered with more than the ${maxBytes}-byte ceiling`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Release the body whether the read finished or was abandoned, so an over-ceiling or
    // timed-out response does not leave the connection held open. `cancel` is best-effort
    // and deliberately not awaited on the abort path: a stream that ignored the signal
    // may well ignore this too, and waiting on it would restore the hang.
    reader.releaseLock();
    if (total > maxBytes || signal.aborted) void body.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
