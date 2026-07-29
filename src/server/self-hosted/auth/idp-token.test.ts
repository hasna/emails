import { describe, expect, it } from "bun:test";
import {
  DEFAULT_IDP_JWKS_CACHE_SECONDS,
  IDP_JWKS_URL_ENV,
  IdpTokenAuthenticator,
  buildIdpAuthenticatorFromEnv,
  looksLikeIdpToken,
  normalizeIdpScopes,
  verifyIdpToken,
  type IdpJwk,
} from "./idp-token.js";
import { generateTestIdpKey, signTestIdpToken } from "./idp-test-support.js";

const key = generateTestIdpKey("kid-a");
const AUDS = ["emails", "mailery"] as const;

function verify(token: string, overrides: { jwks?: IdpJwk[]; nowMs?: number; leewaySeconds?: number } = {}) {
  return verifyIdpToken(token, {
    jwks: overrides.jwks ?? [key.publicJwk],
    expectedAudiences: AUDS,
    nowMs: overrides.nowMs,
    leewaySeconds: overrides.leewaySeconds,
  });
}

describe("looksLikeIdpToken", () => {
  it("detects a signed idp token structurally", () => {
    const { token } = signTestIdpToken(key);
    expect(looksLikeIdpToken(token)).toBe(true);
  });

  it("rejects the existing credential classes and junk", () => {
    expect(looksLikeIdpToken("hasna_abc.def.ghi")).toBe(false);
    expect(looksLikeIdpToken("emss_token")).toBe(false);
    expect(looksLikeIdpToken("")).toBe(false);
    expect(looksLikeIdpToken("a.b")).toBe(false);
    expect(looksLikeIdpToken("not.base64.json")).toBe(false);
  });
});

describe("verifyIdpToken", () => {
  it("accepts a valid token and returns its claims", () => {
    const { token, claims } = signTestIdpToken(key, { sub: "sp-1", scope: ["emails:read"] });
    const result = verify(token);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.claims).toEqual(claims);
    expect(result.kid).toBe("kid-a");
  });

  it("accepts the mailery alias audience", () => {
    const { token } = signTestIdpToken(key, { aud: "mailery" });
    expect(verify(token).ok).toBe(true);
  });

  it.each([
    ["malformed", "only.two"],
    ["malformed", "%%%.%%%.%%%"],
  ] as const)("returns %s for structurally broken input", (reason, token) => {
    const result = verify(token);
    expect(result).toEqual({ ok: false, reason });
  });

  it("refuses a non-EdDSA header (unsupported_alg)", () => {
    const { token } = signTestIdpToken(key, { header: { alg: "HS256", kid: key.kid, typ: "at+jwt" } });
    expect(verify(token)).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  it("refuses a signed JWS that is not explicitly an access token", () => {
    const wrongType = signTestIdpToken(key, { header: { alg: "EdDSA", kid: key.kid, typ: "JWT" } });
    expect(looksLikeIdpToken(wrongType.token)).toBe(true);
    expect(verify(wrongType.token)).toEqual({ ok: false, reason: "malformed" });

    const missingType = signTestIdpToken(key, { header: { alg: "EdDSA", kid: key.kid } });
    expect(looksLikeIdpToken(missingType.token)).toBe(true);
    expect(verify(missingType.token)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a header without kid (missing_kid)", () => {
    const { token } = signTestIdpToken(key, { header: { alg: "EdDSA", typ: "at+jwt" } });
    expect(verify(token)).toEqual({ ok: false, reason: "missing_kid" });
  });

  it("refuses a kid absent from the JWKS (unknown_kid)", () => {
    const { token } = signTestIdpToken(generateTestIdpKey("kid-other"));
    expect(verify(token)).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("refuses a signature from a different key under the same kid (bad_signature)", () => {
    const imposter = generateTestIdpKey("kid-a");
    const { token } = signTestIdpToken(imposter);
    expect(verify(token)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered payload (bad_signature)", () => {
    const { token } = signTestIdpToken(key);
    const [h, , s] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: "sp-evil" })).toString("base64url");
    expect(verify(`${h}.${forged}.${s}`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("pins the idp issuer (issuer_mismatch)", () => {
    const { token } = signTestIdpToken(key, { iss: "someone-else" });
    expect(verify(token)).toEqual({ ok: false, reason: "issuer_mismatch" });
  });

  it("enforces the audience set (audience_mismatch)", () => {
    const { token } = signTestIdpToken(key, { aud: "todos" });
    expect(verify(token)).toEqual({ ok: false, reason: "audience_mismatch" });
  });

  it("refuses an expired token, honoring leeway", () => {
    const now = Date.now();
    const { token } = signTestIdpToken(key, { nowMs: now - 10_000_000, ttlSeconds: 60 });
    expect(verify(token, { nowMs: now })).toEqual({ ok: false, reason: "expired" });
    expect(verify(token, { nowMs: now, leewaySeconds: 10_000 }).ok).toBe(true);
  });

  it("refuses a token issued in the future (not_yet_valid)", () => {
    const now = Date.now();
    const { token } = signTestIdpToken(key, { nowMs: now + 600_000 });
    expect(verify(token, { nowMs: now })).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("refuses claims missing the mapping-critical fields (invalid_claims)", () => {
    const { token } = signTestIdpToken(key, { sub: "" });
    expect(verify(token)).toEqual({ ok: false, reason: "invalid_claims" });
    const noScope = signTestIdpToken(key, { scope: "emails:*" as unknown as string[] });
    expect(verify(noScope.token)).toEqual({ ok: false, reason: "invalid_claims" });
  });
});

describe("normalizeIdpScopes", () => {
  it("maps the bare wildcard and alias-app scopes onto the emails vocabulary", () => {
    expect(normalizeIdpScopes(["*"])).toEqual(["emails:*"]);
    expect(normalizeIdpScopes(["mailery:read", "emails:write"])).toEqual(["emails:read", "emails:write"]);
  });

  it("drops foreign-app scopes and dedupes", () => {
    expect(normalizeIdpScopes(["todos:*", "emails:read", "mailery:read"])).toEqual(["emails:read"]);
  });
});

describe("IdpTokenAuthenticator", () => {
  const jwksBody = { keys: [key.publicJwk] };

  function authenticator(overrides: {
    fetchJwks?: (url: string) => Promise<unknown>;
    cacheSeconds?: number;
    nowMs?: () => number;
  } = {}) {
    return new IdpTokenAuthenticator({
      jwksUrl: "https://idp.example.com/v1/.well-known/jwks.json",
      expectedAudiences: [...AUDS],
      fetchJwks: overrides.fetchJwks ?? (async () => jwksBody),
      cacheSeconds: overrides.cacheSeconds,
      nowMs: overrides.nowMs,
    });
  }

  it("verifies a token via the fetched JWKS and caches the fetch", async () => {
    let fetches = 0;
    const auth = authenticator({
      fetchJwks: async () => {
        fetches += 1;
        return jwksBody;
      },
    });
    const { token } = signTestIdpToken(key);
    expect((await auth.authenticate(token)).ok).toBe(true);
    expect((await auth.authenticate(token)).ok).toBe(true);
    expect(fetches).toBe(1);
  });

  it("refetches once on an unknown kid (key rotation), then fails typed if still unknown", async () => {
    const rotated = generateTestIdpKey("kid-b");
    let fetches = 0;
    const auth = authenticator({
      fetchJwks: async () => {
        fetches += 1;
        return fetches === 1 ? jwksBody : { keys: [key.publicJwk, rotated.publicJwk] };
      },
    });
    // Prime the cache with the pre-rotation key set.
    expect((await auth.authenticate(signTestIdpToken(key).token)).ok).toBe(true);
    // A token under the rotated kid forces exactly one refetch and then verifies.
    expect((await auth.authenticate(signTestIdpToken(rotated).token)).ok).toBe(true);
    expect(fetches).toBe(2);
    // A genuinely unknown kid refetches once more and fails typed.
    const unknown = await auth.authenticate(signTestIdpToken(generateTestIdpKey("kid-zzz")).token);
    expect(unknown).toEqual({ ok: false, reason: "unknown_kid", status: 401 });
  });

  it("fails typed (503 jwks_unavailable) when the JWKS cannot be fetched and no cache exists", async () => {
    const auth = authenticator({
      fetchJwks: async () => {
        throw new Error("connect refused");
      },
    });
    const { token } = signTestIdpToken(key);
    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "jwks_unavailable", status: 503 });
  });

  it("serves from a stale cache when a refresh fails (keys rotate rarely; signatures still decide)", async () => {
    let fetches = 0;
    let now = 1_000_000_000_000;
    const auth = authenticator({
      cacheSeconds: 1,
      nowMs: () => now,
      fetchJwks: async () => {
        fetches += 1;
        if (fetches > 1) throw new Error("idp briefly down");
        return jwksBody;
      },
    });
    const { token } = signTestIdpToken(key, { nowMs: now });
    expect((await auth.authenticate(token)).ok).toBe(true);
    now += 5_000; // cache expired; refresh will fail; stale keys still verify
    expect((await auth.authenticate(token)).ok).toBe(true);
    expect(fetches).toBe(2);
  });

  it("rejects a malformed JWKS document as unavailable (fail closed, typed)", async () => {
    const auth = authenticator({ fetchJwks: async () => ({ nonsense: true }) });
    const { token } = signTestIdpToken(key);
    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "jwks_unavailable", status: 503 });
  });
});

describe("buildIdpAuthenticatorFromEnv", () => {
  it("returns null when the JWKS URL is unset — the credential class stays refused", () => {
    expect(buildIdpAuthenticatorFromEnv({}, [...AUDS])).toBeNull();
    expect(buildIdpAuthenticatorFromEnv({ [IDP_JWKS_URL_ENV]: "   " }, [...AUDS])).toBeNull();
  });

  it("builds an authenticator from a valid https URL", () => {
    const auth = buildIdpAuthenticatorFromEnv(
      { [IDP_JWKS_URL_ENV]: "https://idp.example.com/v1/.well-known/jwks.json" },
      [...AUDS],
    );
    expect(auth).toBeInstanceOf(IdpTokenAuthenticator);
    expect(auth!.jwksUrl).toBe("https://idp.example.com/v1/.well-known/jwks.json");
  });

  it("throws at boot on an unparseable URL (loud, not per-request)", () => {
    expect(() => buildIdpAuthenticatorFromEnv({ [IDP_JWKS_URL_ENV]: "not a url" }, [...AUDS])).toThrow(
      IDP_JWKS_URL_ENV,
    );
  });

  it("refuses a non-HTTP JWKS URL and plaintext HTTP off loopback", () => {
    expect(() => buildIdpAuthenticatorFromEnv(
      { [IDP_JWKS_URL_ENV]: "file:///tmp/jwks.json" },
      [...AUDS],
    )).toThrow("must use http or https");
    expect(() => buildIdpAuthenticatorFromEnv(
      { [IDP_JWKS_URL_ENV]: "http://idp.example.com/v1/.well-known/jwks.json" },
      [...AUDS],
    )).toThrow("must use https except for a loopback");
  });

  it("allows plaintext HTTP only for a loopback development JWKS", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const auth = buildIdpAuthenticatorFromEnv(
        { [IDP_JWKS_URL_ENV]: `http://${host}:8080/v1/.well-known/jwks.json` },
        [...AUDS],
      );
      expect(auth).toBeInstanceOf(IdpTokenAuthenticator);
    }
  });

  it("has a sane default cache TTL", () => {
    expect(DEFAULT_IDP_JWKS_CACHE_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
