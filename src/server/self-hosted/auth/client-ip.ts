// Client-IP resolution for the per-IP auth rate limits (login brute-force,
// signup/forgot/reset throttles).
//
// `X-Forwarded-For` is APPENDED to by each proxy, so the LEFTMOST entry is
// whatever the client itself sent — fully attacker-controlled. Keying a rate
// limiter on it means an attacker rotates one header value and the limiter never
// fires: the login brute-force limit, the signup throttle, and the argon2id
// reset throttle all evaporate.
//
// The trustworthy entry is counted from the RIGHT, and only the operator knows
// how many appending proxies sit in front of the service. So the depth is
// configured (`EMAILS_TRUSTED_PROXY_HOPS`) and the default trusts NOTHING:
// unless told otherwise we key on the socket peer address, which no header can
// forge.
//
// Pure module (no I/O) — unit-tested.

export const TRUSTED_PROXY_HOPS_ENV = "EMAILS_TRUSTED_PROXY_HOPS";

/**
 * Number of X-Forwarded-For-appending proxies between the client and this
 * service.
 *
 * - `0` (default): no proxy is trusted. Forwarding headers are ignored entirely
 *   and the socket peer address is used.
 * - `1`: one appending proxy (an AWS ALB, or a single Caddy/nginx). The client
 *   IP is the LAST X-Forwarded-For entry, because that proxy appended it.
 * - `n`: n chained proxies. The client IP is the nth entry from the right.
 *
 * An unparseable or negative value is treated as `0` — misconfiguration must
 * never widen trust.
 */
export function resolveTrustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[TRUSTED_PROXY_HOPS_ENV] ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Reject anything that is not a bare IP literal. A proxy appends bare addresses;
 * junk means the header did not come from the proxy chain we were told about, so
 * it must not become a rate-limit key.
 */
function normalizeIp(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  // Some proxies bracket IPv6 and/or append a source port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1] as string;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  value = value.trim().toLowerCase();
  if (value.length === 0 || value.length > 45) return null;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number(octet) <= 255 && !/^0\d/.test(octet)) ? value : null;
  }
  // Loose IPv6 shape check: hex groups, at most one "::", optional IPv4 tail.
  if (/^[0-9a-f:]+(?:\.\d{1,3}){0,3}$/.test(value) && value.includes(":") && !/:::/.test(value)) {
    return value;
  }
  return null;
}

export function parseForwardedFor(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== null);
}

export interface ClientIpInput {
  headers: Headers;
  /** Socket peer address, e.g. `server.requestIP(req)?.address`. */
  socketAddress?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the address the per-IP rate limits are keyed on.
 *
 * With `hops = 0` the forwarding headers are ignored. With `hops >= n` the nth
 * entry from the right of `X-Forwarded-For` is used; if the header carries FEWER
 * entries than the configured chain, it did not traverse that chain, so it is
 * discarded and the socket peer address is used instead. An attacker can
 * therefore neither pick their own key nor strip the header to escape the limit.
 */
export function resolveClientIp(input: ClientIpInput): string | null {
  const socket = input.socketAddress ? normalizeIp(input.socketAddress) : null;
  const hops = resolveTrustedProxyHops(input.env);
  if (hops === 0) return socket;

  const forwarded = parseForwardedFor(input.headers.get("x-forwarded-for"));
  if (forwarded.length >= hops) return forwarded[forwarded.length - hops] as string;

  // Deliberately NO `X-Real-IP` fallback: it is a single-value header that a
  // client can set as freely as X-Forwarded-For, and unlike XFF there is no
  // position in it that a proxy is known to own. Falling back to it would hand
  // the rate-limit key straight back to the attacker. An operator whose proxy
  // only sets X-Real-IP should leave the hop count at 0 and accept
  // socket-address (per-proxy) granularity.
  return socket;
}
