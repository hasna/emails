// Signup/login email-domain allowlist — design Addendum A1.
//
// The self-hosted auth surface is restricted to an OPERATOR-DECLARED set of email
// domains: only addresses whose domain matches one of the configured globs may
// sign up, log in, OR be invited. Enforced by ONE predicate so every gate
// (signup / login / invite) shares identical semantics; a non-match is rejected
// with a generic 403 and never reveals whether the account exists.
//
// There is deliberately NO built-in default. `EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS`
// is REQUIRED and this module fails CLOSED without it, because both alternatives
// are wrong for a package other people deploy: a hardcoded domain list pins the
// auth surface to whoever published the build, so every other operator's own
// staff is rejected by a deliberately opaque 403 with no diagnostic; and a
// permit-all fallback would silently widen the signup surface of every existing
// deployment on upgrade. `buildSelfHostedService` asserts the variable at boot so
// a missing allowlist is a loud startup error that names it.
//
// Pure module (no I/O) — unit-tested.

/** The required allowlist variable — single source of truth for messages/tests. */
export const ALLOWED_EMAIL_DOMAINS_ENV = "EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS";

/** Operator-facing reason the auth surface refuses to run unconfigured. */
export const MISSING_ALLOWED_EMAIL_DOMAINS_MESSAGE =
  `${ALLOWED_EMAIL_DOMAINS_ENV} is required: the self-hosted auth surface only ` +
  `accepts signup, login, and invites for an explicit email-domain allowlist and ` +
  `ships no default. Set it to a comma- or space-separated list of domain globs ` +
  `you control (for example "example.com" or "example.com,example.org"; "*" ` +
  `matches exactly one DNS label, so "example.*" allows example.com and ` +
  `example.org but not sub.example.com).`;

/**
 * Translate one allowed-domain glob into a domain-matching RegExp source
 * (the part after the `@`). `*` is the only wildcard and matches one or more of
 * the DNS-label character class `[a-z0-9-]`; every other character is escaped so
 * a pattern like `example.*` cannot smuggle in regex metacharacters. `example.*`
 * therefore yields `example\.[a-z0-9-]+` — i.e. exactly one tld label after
 * `example.` (matching the design's `^[^@]+@example\.[a-z0-9-]+$` shape).
 */
function globToDomainSource(glob: string): string {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[a-z0-9-]+";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * A well-formed domain glob: two or more DNS-ish labels of `[a-z0-9*]` (internal
 * hyphens allowed), e.g. `example.com`, `example.*`, `partner.example.net`.
 *
 * This is checked because a malformed glob is silently catastrophic. Non-emptiness
 * alone is not enough: `example_corp.com`, `.com`, `example.`, `'example.com'` and
 * a full address like `user@example.com` all compile to a regex that matches
 * nothing, so every real user is refused by the same deliberately opaque 403 this
 * change exists to eliminate — only now with the operator's typo as the cause. A
 * single bare `*` is also rejected: one label matches `root@localhost`, which is
 * never what an operator means.
 */
const DOMAIN_GLOB_RE = /^[a-z0-9*](?:[a-z0-9*-]*[a-z0-9*])?(?:\.[a-z0-9*](?:[a-z0-9*-]*[a-z0-9*])?)+$/;

/** Parse the configured allowlist into raw domain globs (comma/space separated). */
function parseAllowedDomains(raw: string | undefined): string[] {
  const globs = (raw ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  for (const glob of globs) {
    if (!DOMAIN_GLOB_RE.test(glob)) {
      throw new Error(
        `${ALLOWED_EMAIL_DOMAINS_ENV} contains "${glob}", which is not a domain glob. ` +
          `Each entry must be two or more labels of letters, digits, hyphens or "*" ` +
          `(for example "example.com" or "example.*") — not an email address, not a ` +
          `quoted string, and not a bare "*". A malformed entry matches no address, so ` +
          `every signup and login would be refused with a generic 403.`,
      );
    }
  }
  return globs;
}

/**
 * Build a single case-insensitive email-allowlist RegExp from the configured
 * domain globs. Anchored full-match: `^[^@]+@(<domainA>|<domainB>|…)$`.
 *
 * @throws when `EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS` is unset or empty — there is
 * no default allowlist, so an unconfigured deployment fails closed and loudly.
 */
export function buildAllowedEmailPattern(env: NodeJS.ProcessEnv = process.env): RegExp {
  const globs = parseAllowedDomains(env[ALLOWED_EMAIL_DOMAINS_ENV]);
  if (globs.length === 0) throw new Error(MISSING_ALLOWED_EMAIL_DOMAINS_MESSAGE);
  return new RegExp(`^[^@\\s]+@(?:${globs.map(globToDomainSource).join("|")})$`, "i");
}

/**
 * Assert the signup/login/invite allowlist is configured. Called at service boot
 * so a missing `EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS` surfaces as a startup error
 * naming the variable instead of an opaque 403 on every auth request.
 */
export function assertAllowedEmailDomainsConfigured(env: NodeJS.ProcessEnv = process.env): void {
  buildAllowedEmailPattern(env);
}

/**
 * Whether `email` is permitted to sign up / log in / be invited. Trims and
 * lowercases before matching; a non-string or empty value is never allowed.
 * `env` is threaded so the caller can build the pattern once per process (the
 * default reads it fresh each call, which is fine for the low-frequency auth
 * gates).
 *
 * @throws the missing-configuration error from `buildAllowedEmailPattern` when no
 * allowlist is configured. Reachable only if the boot-time assertion was
 * bypassed; failing loudly beats inventing an allowlist.
 */
export function isAllowedSignupEmail(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const pattern = buildAllowedEmailPattern(env);
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320) return false;
  return pattern.test(normalized);
}
