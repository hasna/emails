import { MAILERY_ENV_BRIDGE_DENYLIST } from "./mode.js";

// ── MAILERY_* env compatibility shim ────────────────────────────────────────
//
// The package's public env prefix moved EMAILS_ -> MAILERY_ (repo/brand rename
// to mailery). The codebase still reads the EMAILS_* names internally, so at
// process startup we mirror every MAILERY_* / HASNA_MAILERY_* variable onto its
// EMAILS_* / HASNA_EMAILS_* counterpart. Semantics: dual-read, PREFER NEW — a
// MAILERY_* value overrides the EMAILS_* alias; an EMAILS_*-only environment is
// left untouched (fallback). Existing installs keep working; new installs use
// the MAILERY_* names.
//
// This is additive: the MAILERY_* key is NOT deleted, so anything that inspects
// it directly (e.g. the mode resolver reporting the offending key) still sees
// the canonical name.

const NEW_PREFIX = "MAILERY_";
const NEW_HASNA_PREFIX = "HASNA_MAILERY_";
const OLD_PREFIX = "EMAILS_";
const OLD_HASNA_PREFIX = "HASNA_EMAILS_";

// The set of MAILERY_-prefixed names that must NEVER be bridged onto an EMAILS_
// alias (hosted control-plane creds + removed runtime knobs) lives in mode.ts
// so its literal names stay confined to one strippable declaration. Leaving
// those vars under their MAILERY_ name means the mode/self-hosted guards keep
// rejecting them — this stays a cloud-free OSS package.

/** Legacy EMAILS_ name a MAILERY_ key bridges onto, or null if not bridged. */
export function legacyEnvNameFor(key: string): string | null {
  if (MAILERY_ENV_BRIDGE_DENYLIST.has(key)) return null;
  if (key.startsWith(NEW_HASNA_PREFIX)) return OLD_HASNA_PREFIX + key.slice(NEW_HASNA_PREFIX.length);
  if (key.startsWith(NEW_PREFIX)) return OLD_PREFIX + key.slice(NEW_PREFIX.length);
  return null;
}

/**
 * Mirror MAILERY_* env vars onto their EMAILS_* aliases (prefer new). Idempotent
 * and safe to call at every entry point. Call this BEFORE any code reads the
 * environment (mode resolution, config, self-hosted bootstrap).
 */
export function applyMaileryEnvCompat(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    const legacyKey = legacyEnvNameFor(key);
    if (!legacyKey) continue;
    const value = env[key];
    if (value === undefined) continue;
    env[legacyKey] = value;
  }
}
