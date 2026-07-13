// Signup/login email-domain allowlist — design Addendum A1.
//
// Only addresses whose domain matches `hasna.<tld>` may sign up, log in, OR be
// invited (hasna.com, hasna.xyz, hasna.studio, …). Enforced by ONE predicate so
// every gate (signup / login / invite) shares identical semantics; a non-match is
// rejected with a generic 403 and never reveals whether the account exists.
//
// The allowed pattern is env-configurable (`EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS`)
// so it can widen later without a code change. The default `hasna.*` compiles to
// the design's regex `^[^@]+@hasna\.[a-z0-9-]+$` (case-insensitive).
//
// Pure module (no I/O) — unit-tested.

const DEFAULT_ALLOWED_DOMAINS = "hasna.*";

/**
 * Translate one allowed-domain glob into a domain-matching RegExp source
 * (the part after the `@`). `*` is the only wildcard and matches one or more of
 * the DNS-label character class `[a-z0-9-]`; every other character is escaped so
 * a pattern like `hasna.*` cannot smuggle in regex metacharacters. `hasna.*`
 * therefore yields `hasna\.[a-z0-9-]+` — i.e. exactly one tld label after
 * `hasna.` (matching the design's `^[^@]+@hasna\.[a-z0-9-]+$`).
 */
function globToDomainSource(glob: string): string {
  let out = "";
  for (const ch of glob.trim().toLowerCase()) {
    if (ch === "*") out += "[a-z0-9-]+";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Parse the env override into a list of raw domain globs (comma/space separated). */
function parseAllowedDomains(raw: string | undefined): string[] {
  const value = (raw ?? "").trim() || DEFAULT_ALLOWED_DOMAINS;
  return value
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/**
 * Build a single case-insensitive email-allowlist RegExp from the configured
 * domain globs. Anchored full-match: `^[^@]+@(<domainA>|<domainB>|…)$`.
 */
export function buildAllowedEmailPattern(env: NodeJS.ProcessEnv = process.env): RegExp {
  const globs = parseAllowedDomains(env["EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS"]);
  const domainAlternatives = (globs.length ? globs : [DEFAULT_ALLOWED_DOMAINS])
    .map(globToDomainSource)
    .join("|");
  return new RegExp(`^[^@\\s]+@(?:${domainAlternatives})$`, "i");
}

/**
 * Whether `email` is permitted to sign up / log in / be invited. Trims and
 * lowercases before matching; a non-string or empty value is never allowed.
 * `env` is threaded so the caller can build the pattern once per process (the
 * default reads it fresh each call, which is fine for the low-frequency auth
 * gates).
 */
export function isAllowedSignupEmail(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320) return false;
  return buildAllowedEmailPattern(env).test(normalized);
}
