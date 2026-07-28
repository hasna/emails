// Idp-token verification for the emails self-hosted service (ADR-0001/0002).
//
// The IdP (@hasna/tenants) mints EdDSA (Ed25519) compact-JWS access tokens
// and publishes the matching public keys as a JWKS. Emails VERIFIES those tokens
// statelessly — it never signs them, never holds IdP key material, and refuses
// the whole credential class (typed) until an operator configures the JWKS URL.
//
// WIRE CONTRACT (pinned here, mirrored from open-tenants src/idp/tokens.ts, and
// destined for @hasna/contracts per ADR-0002 §Contracts): header
// `{ alg: "EdDSA", kid, typ: "at+jwt" }`, claims `{ iss, aud, sub, tid, pt,
// scope, iat, exp, jti }`, issuer fixed to the cross-idp string "identities".
// The verify failure reasons form a CLOSED, typed set so audit lines are
// comparable across apps. Until the contracts module exists, idp-token.test.ts
// pins these values; drift breaks a test, not production.
//
// REVOCATION HONESTY (ADR-0001): this is the stateless check — it cannot see the
// IdP's jti denylist. IdP-side revocation stops new tokens; outstanding tokens
// live ≤24h. The immediate emails-side kill is the mapping row's revoked_at
// (idp_principal_tenants), enforced by resolveRequestContext, not here.

import { createPublicKey, verify as edVerify } from "node:crypto";

export const IDP_TOKEN_ISSUER = "identities";
export const IDP_TOKEN_ALG = "EdDSA";
export const IDP_TOKEN_TYPE = "at+jwt";

/** Operator config: the IdP's published JWKS URL. Unset ⇒ class refused. */
export const IDP_JWKS_URL_ENV = "EMAILS_IDP_JWKS_URL";
/** Optional override for the JWKS cache TTL (seconds). */
export const IDP_JWKS_CACHE_SECONDS_ENV = "EMAILS_IDP_JWKS_CACHE_SECONDS";
export const DEFAULT_IDP_JWKS_CACHE_SECONDS = 300;

export interface IdpTokenClaims {
  /** Fixed idp issuer string (IDP_TOKEN_ISSUER). */
  iss: string;
  /** App slug the token was minted for. */
  aud: string;
  /** Principal id — IdP user id or service-principal id. The mapping key. */
  sub: string;
  /** IdP tenant UUID (NOT an emails tenant — mapping decides that). */
  tid: string;
  /** Principal type. */
  pt: "user" | "service";
  /** Granted scopes (`<app>:<action>` / `<app>:*` / `*`). */
  scope: string[];
  iat: number;
  exp: number;
  /** Token id (audit join key between IdP and emails). */
  jti: string;
}

export interface IdpJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use?: "sig";
  alg?: "EdDSA";
}

export type IdpVerifyFailureReason =
  | "malformed"
  | "unsupported_alg"
  | "missing_kid"
  | "unknown_kid"
  | "bad_signature"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "expired"
  | "not_yet_valid"
  | "invalid_claims";

export type IdpVerifyResult =
  | { ok: true; claims: IdpTokenClaims; kid: string }
  | { ok: false; reason: IdpVerifyFailureReason };

/**
 * Structural detection only (no signature trust): is this bearer credential a
 * idp JWS? Used by the credential dispatcher AFTER the `hasna_`/`emss_` prefix
 * classes, so the existing classes are byte-equivalent with this class present.
 */
export function looksLikeIdpToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    return header?.typ === IDP_TOKEN_TYPE || header?.alg === IDP_TOKEN_ALG;
  } catch {
    return false;
  }
}

/**
 * Structural claims parse with NO signature trust — audit forensics only
 * (mirrors the API-key path's structural kid recovery for deny lines). The ids
 * it returns must never feed an authorization decision.
 */
export function parseIdpClaimsUnverified(
  token: string,
): { sub: string | null; tid: string | null; jti: string | null; kid: string | null } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { kid?: unknown };
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return { sub: str(claims["sub"]), tid: str(claims["tid"]), jti: str(claims["jti"]), kid: str(header.kid) };
  } catch {
    return null;
  }
}

/** Structural claims validation: everything the mapping/scope steps rely on. */
function validClaims(claims: IdpTokenClaims): boolean {
  return (
    typeof claims.sub === "string" && claims.sub.trim().length > 0 &&
    typeof claims.tid === "string" && claims.tid.trim().length > 0 &&
    typeof claims.jti === "string" &&
    (claims.pt === "user" || claims.pt === "service") &&
    Array.isArray(claims.scope) && claims.scope.every((s) => typeof s === "string")
  );
}

export interface VerifyIdpTokenOptions {
  /** Public JWKs to verify against. */
  jwks: readonly IdpJwk[];
  /** Accepted `aud` values (canonical app slug + back-compat aliases). */
  expectedAudiences: readonly string[];
  /** Clock-skew leeway in seconds. Default 0. */
  leewaySeconds?: number;
  nowMs?: number;
}

/**
 * Fully verify an IdP token: signature, pinned issuer, audience set, expiry,
 * structural claims. Stateless; see the revocation note in the module header.
 */
export function verifyIdpToken(token: string, options: VerifyIdpTokenOptions): IdpVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: IdpTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== IDP_TOKEN_ALG) return { ok: false, reason: "unsupported_alg" };
  if (!header.kid) return { ok: false, reason: "missing_kid" };
  const jwk = options.jwks.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown_kid" };

  let verified = false;
  try {
    const publicKey = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: "jwk" } as never);
    verified = edVerify(null, Buffer.from(`${headerB64}.${payloadB64}`), publicKey, Buffer.from(sigB64, "base64url"));
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!verified) return { ok: false, reason: "bad_signature" };

  if (claims.iss !== IDP_TOKEN_ISSUER) return { ok: false, reason: "issuer_mismatch" };
  if (!options.expectedAudiences.includes(claims.aud)) return { ok: false, reason: "audience_mismatch" };
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const leeway = options.leewaySeconds ?? 0;
  if (typeof claims.exp !== "number" || nowSec > claims.exp + leeway) return { ok: false, reason: "expired" };
  if (typeof claims.iat === "number" && claims.iat - leeway > nowSec) return { ok: false, reason: "not_yet_valid" };
  if (!validClaims(claims)) return { ok: false, reason: "invalid_claims" };
  return { ok: true, claims, kid: header.kid };
}

/**
 * Normalize token scopes onto the emails vocabulary the route gates enforce:
 * the bare wildcard becomes `emails:*`, alias-app scopes (`mailery:x`) become
 * `emails:x`, foreign-app scopes are DROPPED (an `aud: emails` token should not
 * carry them; if it does they grant nothing here), and duplicates collapse.
 */
export function normalizeIdpScopes(scopes: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of scopes) {
    let scope = raw === "*" ? "emails:*" : raw;
    const colon = scope.indexOf(":");
    if (colon > 0) {
      const app = scope.slice(0, colon);
      if (app === "mailery") scope = `emails${scope.slice(colon)}`;
      else if (app !== "emails") continue;
    } else if (scope !== "emails:*") {
      continue;
    }
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

export type IdpAuthenticateResult =
  | { ok: true; claims: IdpTokenClaims; kid: string }
  | { ok: false; reason: IdpVerifyFailureReason; status: 401 }
  | { ok: false; reason: "jwks_unavailable"; status: 503 };

export interface IdpJwksEvent {
  type: "refresh" | "error";
  /** Host only — never a token, never key material. */
  urlHost: string;
  kids?: string[];
  error?: string;
}

export interface IdpTokenAuthenticatorOptions {
  jwksUrl: string;
  expectedAudiences: readonly string[];
  cacheSeconds?: number;
  leewaySeconds?: number;
  /** Test/embedding seam; production uses the built-in fetch. */
  fetchJwks?: (url: string) => Promise<unknown>;
  nowMs?: () => number;
  /** Secret-free observability hook for JWKS refreshes/failures. */
  onEvent?: (event: IdpJwksEvent) => void;
}

function parseJwksDocument(value: unknown): IdpJwk[] | null {
  if (!value || typeof value !== "object") return null;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  const out: IdpJwk[] = [];
  for (const entry of keys) {
    if (!entry || typeof entry !== "object") continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk["kty"] === "OKP" && jwk["crv"] === "Ed25519" && typeof jwk["x"] === "string" && typeof jwk["kid"] === "string") {
      out.push({ kty: "OKP", crv: "Ed25519", x: jwk["x"], kid: jwk["kid"], use: "sig", alg: "EdDSA" });
    }
  }
  return out.length > 0 ? out : null;
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
  return await response.json();
}

/**
 * Verifies idp tokens against a cached JWKS fetched from the configured URL.
 *
 * Cache policy: TTL-cached; an UNKNOWN kid forces one refetch within a request
 * (key rotation); a failed refresh falls back to the last good key set (keys
 * rotate rarely and signatures still decide) but NEVER to accepting anything —
 * with no key set at all the result is a typed 503, fail closed.
 */
export class IdpTokenAuthenticator {
  readonly jwksUrl: string;
  private readonly expectedAudiences: readonly string[];
  private readonly cacheMs: number;
  private readonly leewaySeconds: number | undefined;
  private readonly fetchJwks: (url: string) => Promise<unknown>;
  private readonly nowMs: () => number;
  private readonly onEvent: ((event: IdpJwksEvent) => void) | undefined;
  private keys: IdpJwk[] | null = null;
  private fetchedAtMs = 0;
  private inflight: Promise<void> | null = null;

  constructor(options: IdpTokenAuthenticatorOptions) {
    this.jwksUrl = options.jwksUrl;
    this.expectedAudiences = options.expectedAudiences;
    this.cacheMs = (options.cacheSeconds ?? DEFAULT_IDP_JWKS_CACHE_SECONDS) * 1_000;
    this.leewaySeconds = options.leewaySeconds;
    this.fetchJwks = options.fetchJwks ?? defaultFetchJwks;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.onEvent = options.onEvent;
  }

  private urlHost(): string {
    try {
      return new URL(this.jwksUrl).host;
    } catch {
      return "?";
    }
  }

  /** Refresh the cache (deduped across concurrent requests). Errors are kept. */
  private async refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const parsed = parseJwksDocument(await this.fetchJwks(this.jwksUrl));
          if (!parsed) throw new Error("JWKS document has no usable Ed25519 keys");
          this.keys = parsed;
          this.fetchedAtMs = this.nowMs();
          this.onEvent?.({ type: "refresh", urlHost: this.urlHost(), kids: parsed.map((k) => k.kid) });
        } catch (error) {
          this.onEvent?.({
            type: "error",
            urlHost: this.urlHost(),
            error: error instanceof Error ? error.message : String(error),
          });
          // Keep any previous key set (stale-if-error); callers fail typed when none exists.
        } finally {
          this.inflight = null;
        }
      })();
    }
    await this.inflight;
  }

  private async currentKeys(): Promise<IdpJwk[] | null> {
    const fresh = this.keys !== null && this.nowMs() - this.fetchedAtMs < this.cacheMs;
    if (!fresh) await this.refresh();
    return this.keys;
  }

  async authenticate(token: string): Promise<IdpAuthenticateResult> {
    let keys = await this.currentKeys();
    if (!keys) return { ok: false, reason: "jwks_unavailable", status: 503 };
    let result = verifyIdpToken(token, {
      jwks: keys,
      expectedAudiences: this.expectedAudiences,
      leewaySeconds: this.leewaySeconds,
      nowMs: this.nowMs(),
    });
    if (!result.ok && result.reason === "unknown_kid") {
      // Possible key rotation since the last fetch: refresh once and retry.
      await this.refresh();
      keys = this.keys;
      if (!keys) return { ok: false, reason: "jwks_unavailable", status: 503 };
      result = verifyIdpToken(token, {
        jwks: keys,
        expectedAudiences: this.expectedAudiences,
        leewaySeconds: this.leewaySeconds,
        nowMs: this.nowMs(),
      });
    }
    if (!result.ok) return { ok: false, reason: result.reason, status: 401 };
    return { ok: true, claims: result.claims, kid: result.kid };
  }
}

/**
 * Build the authenticator from operator config, or return null when the JWKS
 * URL is unset — the caller then refuses the credential class with a typed
 * error (fail closed). An unparseable URL throws HERE, at boot, loudly.
 */
export function buildIdpAuthenticatorFromEnv(
  env: NodeJS.ProcessEnv,
  expectedAudiences: readonly string[],
  onEvent?: (event: IdpJwksEvent) => void,
): IdpTokenAuthenticator | null {
  const url = env[IDP_JWKS_URL_ENV]?.trim();
  if (!url) return null;
  try {
    new URL(url);
  } catch {
    throw new Error(`${IDP_JWKS_URL_ENV} is not a valid URL.`);
  }
  const cacheRaw = env[IDP_JWKS_CACHE_SECONDS_ENV]?.trim();
  const cacheSeconds = cacheRaw ? Number(cacheRaw) : undefined;
  if (cacheSeconds !== undefined && (!Number.isFinite(cacheSeconds) || cacheSeconds <= 0)) {
    throw new Error(`${IDP_JWKS_CACHE_SECONDS_ENV} must be a positive number of seconds.`);
  }
  return new IdpTokenAuthenticator({
    jwksUrl: url,
    expectedAudiences,
    ...(cacheSeconds !== undefined ? { cacheSeconds } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
}
