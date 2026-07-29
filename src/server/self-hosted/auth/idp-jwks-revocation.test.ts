// JWKS revocation honesty for the IdP credential class (ADR-0001).
//
// Two properties the authenticator must hold, distinct from the stale-if-error
// resilience the existing suite pins:
//
//   1. An EMPTY-but-valid JWKS document is a REVOCATION, not an error. The
//      standard way an IdP fully withdraws a compromised signing key is to
//      publish a JWKS with zero keys; that must REPLACE the cached key set so
//      previously-signed tokens fail typed — never be mistaken for a fetch
//      failure that keeps the removed key trusted until a process restart.
//
//   2. Staleness has a CEILING. A fetch failure may serve the last-good key set
//      for a bounded window only; past it, verification fails with the typed
//      503 the module header promises, instead of trusting unverifiable keys
//      forever on a permanently unreachable JWKS endpoint.
//
// Hermetic: stubbed fetch, virtual clock, no network.

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_IDP_JWKS_CACHE_SECONDS,
  DEFAULT_IDP_JWKS_MAX_STALE_SECONDS,
  IDP_JWKS_MAX_STALE_SECONDS_ENV,
  IDP_JWKS_URL_ENV,
  IdpTokenAuthenticator,
  buildIdpAuthenticatorFromEnv,
  type IdpJwksEvent,
} from "./idp-token.js";
import { generateTestIdpKey, signTestIdpToken } from "./idp-test-support.js";

const key = generateTestIdpKey("kid-revoke");
const AUDS = ["emails", "mailery"] as const;
const JWKS_URL = "https://idp.example.com/v1/.well-known/jwks.json";

function authenticator(options: {
  fetchJwks: (url: string) => Promise<unknown>;
  nowMs?: () => number;
  cacheSeconds?: number;
  maxStaleSeconds?: number;
  onEvent?: (event: IdpJwksEvent) => void;
}): IdpTokenAuthenticator {
  return new IdpTokenAuthenticator({
    jwksUrl: JWKS_URL,
    expectedAudiences: [...AUDS],
    ...options,
  });
}

describe("empty JWKS document — full key revocation", () => {
  it("REPLACES the cached key set when the IdP publishes an empty key list (tokens fail typed)", async () => {
    let now = 1_000_000_000_000;
    let document: unknown = { keys: [key.publicJwk] };
    const auth = authenticator({
      cacheSeconds: 1,
      nowMs: () => now,
      fetchJwks: async () => document,
    });
    const { token } = signTestIdpToken(key, { nowMs: now });
    expect((await auth.authenticate(token)).ok).toBe(true);

    // The IdP withdraws every signing key. Past the cache TTL the next
    // authenticate must observe the revocation, not keep the stale key.
    document = { keys: [] };
    now += 5_000;
    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "unknown_kid", status: 401 });
  });

  it("treats a valid document with no USABLE keys the same way (nothing left to verify against)", async () => {
    let now = 1_000_000_000_000;
    let document: unknown = { keys: [key.publicJwk] };
    const auth = authenticator({
      cacheSeconds: 1,
      nowMs: () => now,
      fetchJwks: async () => document,
    });
    const { token } = signTestIdpToken(key, { nowMs: now });
    expect((await auth.authenticate(token)).ok).toBe(true);

    document = { keys: [{ kty: "RSA", kid: "rsa-1", n: "xx", e: "AQAB" }] };
    now += 5_000;
    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "unknown_kid", status: 401 });
  });

  it("keeps the revocation distinct from a fetch ERROR: a later re-publish restores verification", async () => {
    let now = 1_000_000_000_000;
    let document: unknown = { keys: [key.publicJwk] };
    const events: IdpJwksEvent[] = [];
    const auth = authenticator({
      cacheSeconds: 1,
      nowMs: () => now,
      fetchJwks: async () => document,
      onEvent: (event) => events.push(event),
    });
    const { token } = signTestIdpToken(key, { nowMs: now });
    expect((await auth.authenticate(token)).ok).toBe(true);

    document = { keys: [] };
    now += 5_000;
    expect((await auth.authenticate(token)).ok).toBe(false);
    // The empty set arrived through the REFRESH path (kids: []), not the error path.
    expect(events.some((e) => e.type === "refresh" && e.kids?.length === 0)).toBe(true);
    expect(events.every((e) => e.type !== "error")).toBe(true);

    document = { keys: [key.publicJwk] };
    now += 5_000;
    expect((await auth.authenticate(token)).ok).toBe(true);
  });

  it("still refuses a MALFORMED document as an error, serving the last-good keys within the ceiling", async () => {
    let now = 1_000_000_000_000;
    let document: unknown = { keys: [key.publicJwk] };
    const auth = authenticator({
      cacheSeconds: 1,
      nowMs: () => now,
      fetchJwks: async () => document,
    });
    const { token } = signTestIdpToken(key, { nowMs: now });
    expect((await auth.authenticate(token)).ok).toBe(true);

    document = { nonsense: true };
    now += 5_000;
    // Malformed is NOT a revocation: stale-if-error still applies inside the ceiling.
    expect((await auth.authenticate(token)).ok).toBe(true);
  });
});

describe("maximum staleness ceiling", () => {
  it("fails typed-503 once a failing JWKS endpoint leaves the cached keys older than the ceiling", async () => {
    let now = 1_000_000_000_000;
    let healthy = true;
    const auth = authenticator({
      cacheSeconds: 1,
      maxStaleSeconds: 60,
      nowMs: () => now,
      fetchJwks: async () => {
        if (!healthy) throw new Error("idp unreachable");
        return { keys: [key.publicJwk] };
      },
    });
    const token = () => signTestIdpToken(key, { nowMs: now }).token;
    expect((await auth.authenticate(token())).ok).toBe(true);

    healthy = false;
    // Inside the ceiling: stale-if-error keeps serving.
    now += 30_000;
    expect((await auth.authenticate(token())).ok).toBe(true);
    // Past the ceiling: the last-good keys are no longer evidence — typed 503.
    now += 40_000;
    expect(await auth.authenticate(token())).toEqual({
      ok: false,
      reason: "jwks_unavailable",
      status: 503,
    });
    // Recovery is possible the moment the endpoint answers again.
    healthy = true;
    expect((await auth.authenticate(token())).ok).toBe(true);
  });

  it("has a bounded default ceiling and rejects a ceiling below the cache TTL at boot", () => {
    expect(DEFAULT_IDP_JWKS_MAX_STALE_SECONDS).toBeGreaterThanOrEqual(DEFAULT_IDP_JWKS_CACHE_SECONDS);
    // A day is the outstanding-token lifetime; trusting keys longer than that
    // has no justification the module header could honor.
    expect(DEFAULT_IDP_JWKS_MAX_STALE_SECONDS).toBeLessThanOrEqual(86_400);

    expect(() =>
      buildIdpAuthenticatorFromEnv(
        {
          [IDP_JWKS_URL_ENV]: JWKS_URL,
          [IDP_JWKS_MAX_STALE_SECONDS_ENV]: "not-a-number",
        },
        [...AUDS],
      ),
    ).toThrow(IDP_JWKS_MAX_STALE_SECONDS_ENV);
    expect(() =>
      buildIdpAuthenticatorFromEnv(
        {
          [IDP_JWKS_URL_ENV]: JWKS_URL,
          [IDP_JWKS_MAX_STALE_SECONDS_ENV]: "1",
        },
        [...AUDS],
      ),
    ).toThrow(IDP_JWKS_MAX_STALE_SECONDS_ENV);

    const auth = buildIdpAuthenticatorFromEnv(
      {
        [IDP_JWKS_URL_ENV]: JWKS_URL,
        [IDP_JWKS_MAX_STALE_SECONDS_ENV]: "7200",
      },
      [...AUDS],
    );
    expect(auth).toBeInstanceOf(IdpTokenAuthenticator);
  });
});
