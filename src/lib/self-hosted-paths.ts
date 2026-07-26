/** Normalize the native client's `/api/v1` alias onto the public `/v1` API. */
export function canonicalizeApiV1Pathname(pathname: string): string {
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
    return pathname.slice("/api".length);
  }
  return pathname;
}

/** Normalize native-client identity and API-key segments onto canonical routes. */
export function canonicalizeClientDialectPathname(pathname: string): string {
  if (pathname === "/v1/auth/me") return "/v1/me";
  if (pathname === "/v1/api-keys") return "/v1/keys";
  if (pathname.startsWith("/v1/api-keys/")) {
    return `/v1/keys/${pathname.slice("/v1/api-keys/".length)}`;
  }
  return pathname;
}

/** The one path mapping shared by request routing and response validation. */
export function canonicalizeSelfHostedPathname(pathname: string): string {
  return canonicalizeClientDialectPathname(canonicalizeApiV1Pathname(pathname));
}
