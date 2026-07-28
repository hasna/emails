// @hasna/contracts 0.4.2 -> 0.8.2 API-key compatibility.
//
// Production servers (1.3.0, real tenants) hold keys minted by
// @hasna/contracts@0.4.2. This suite pins THREE literal tokens that were minted
// by executing 0.4.2's `mintApiKey` (deterministic inputs below) and asserts
// they still fully verify under the currently installed contracts version. If
// any assertion here fails, upgrading @hasna/contracts would invalidate every
// issued credential — do NOT ship that upgrade without a key-migration plan.
//
// Fixture provenance — produced by @hasna/contracts@0.4.2 `mintApiKey` with:
//   signingSecret: FIXTURE_SIGNING  (test-only material, below)
//   nowMs:         Date.UTC(2026, 0, 2, 3, 4, 5)  -> iat 1767323045
//   FINITE:  { app: "emails",  scopes: ["emails:*"], kid: "compat042finite",
//              agent: "compat-fixture" }               (default 90-day TTL)
//   ETERNAL: { app: "emails",  scopes: ["emails:read", "emails:write"],
//              kid: "compat042eternal", ttlSeconds: null }
//   ALIAS:   { app: "mailery", scopes: ["emails:*"], kid: "compat042alias",
//              ttlSeconds: null }
// The token strings and their sha-256 hashes are pinned verbatim; they must
// never be regenerated with a newer contracts version, because their whole
// point is to be 0.4.2 artifacts.

import { describe, expect, it } from "bun:test";
import { hashToken, mintApiKey, verifyApiKeyToken } from "@hasna/contracts/auth";
import { verifyApiKeyWithAliases } from "./api-key-verifier.js";
import { SELF_HOSTED_APP, SELF_HOSTED_APP_ALIASES } from "./env.js";

const FIXTURE_SIGNING = "compat-fixture-signing-material-0-4-2-not-a-real-credential";
const FIXTURE_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
/** Inside the finite token's 90-day window, after issuance. */
const VERIFY_NOW_MS = FIXTURE_NOW_MS + 60_000;

const FINITE_042_TOKEN =
  "hasna_emails_eyJ2IjoxLCJraWQiOiJjb21wYXQwNDJmaW5pdGUiLCJhcHAiOiJlbWFpbHMiLCJzY29wZXMiOlsiZW1haWxzOioiXSwiaWF0IjoxNzY3MzIzMDQ1LCJleHAiOjE3NzUwOTkwNDUsImFnZW50IjoiY29tcGF0LWZpeHR1cmUifQ.eAaAHg9e88ShQ_PW5YTKu6Bbb8yD1aIl6R3jZjXV738";
const FINITE_042_HASH = "c99af6ea49a9af9c5ebe4b84bb74099967c0f194cd8561ada941f10620c88ac2";

const ETERNAL_042_TOKEN =
  "hasna_emails_eyJ2IjoxLCJraWQiOiJjb21wYXQwNDJldGVybmFsIiwiYXBwIjoiZW1haWxzIiwic2NvcGVzIjpbImVtYWlsczpyZWFkIiwiZW1haWxzOndyaXRlIl0sImlhdCI6MTc2NzMyMzA0NSwiZXhwIjpudWxsfQ.rPkJCo3HlqkrN2083En_BD639bJ704_JhDew8ANd0Vc";
const ETERNAL_042_HASH = "9761c7323ea24eadff338473ba61c507c446ea0b1248cb2bfae44844d2d71d57";

const ALIAS_042_TOKEN =
  "hasna_mailery_eyJ2IjoxLCJraWQiOiJjb21wYXQwNDJhbGlhcyIsImFwcCI6Im1haWxlcnkiLCJzY29wZXMiOlsiZW1haWxzOioiXSwiaWF0IjoxNzY3MzIzMDQ1LCJleHAiOm51bGx9.73_nYyp7k002rgj9hPxJHDq0eDek8hD9MiRT6_TqhvQ";
const ALIAS_042_HASH = "580d299803f3bae3668a7c168dde02869954ec52640d19382d7cf332b73e9f3c";

describe("contracts auth 0.4.2 -> current: issued keys keep verifying", () => {
  it("fully verifies a 0.4.2-minted key (signature, app, TTL, scopes)", () => {
    const result = verifyApiKeyToken(FINITE_042_TOKEN, {
      signingSecret: FIXTURE_SIGNING,
      expectedApp: "emails",
      nowMs: VERIFY_NOW_MS,
      requiredScopes: ["emails:read", "emails:write"], // satisfied by emails:*
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kid).toBe("compat042finite");
      expect(result.app).toBe("emails");
      expect(result.claims.agent).toBe("compat-fixture");
      // Pre-`tid` keys are UNTENANTED: they verify, and report no tenant.
      expect(result.tid).toBeNull();
    }
  });

  it("fully verifies a 0.4.2-minted non-expiring key with concrete scopes", () => {
    const result = verifyApiKeyToken(ETERNAL_042_TOKEN, {
      signingSecret: FIXTURE_SIGNING,
      expectedApp: "emails",
      nowMs: VERIFY_NOW_MS,
      requiredScopes: ["emails:read", "emails:write"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kid).toBe("compat042eternal");
      expect(result.claims.exp).toBeNull();
      expect(result.tid).toBeNull();
    }
  });

  it("still enforces expiry on the 0.4.2 token (not a verification stub)", () => {
    const afterExpiry = (1_775_099_045 + 1) * 1000;
    const result = verifyApiKeyToken(FINITE_042_TOKEN, {
      signingSecret: FIXTURE_SIGNING,
      expectedApp: "emails",
      nowMs: afterExpiry,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("still rejects a tampered 0.4.2 token signature", () => {
    const tampered = `${FINITE_042_TOKEN.slice(0, -4)}AAAA`;
    const result = verifyApiKeyToken(tampered, {
      signingSecret: FIXTURE_SIGNING,
      expectedApp: "emails",
      nowMs: VERIFY_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("hashes the 0.4.2 token to the SAME at-rest hash (stored api_keys rows keep matching)", () => {
    expect(hashToken(FINITE_042_TOKEN)).toBe(FINITE_042_HASH);
    expect(hashToken(ETERNAL_042_TOKEN)).toBe(ETERNAL_042_HASH);
    expect(hashToken(ALIAS_042_TOKEN)).toBe(ALIAS_042_HASH);
  });

  it("re-minting with 0.4.2's inputs reproduces the 0.4.2 tokens byte-for-byte", () => {
    // Untenanted minting must stay byte-identical to the pre-`tid` format, so
    // the wire format itself — not just verification leniency — is unchanged.
    const finite = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: FIXTURE_SIGNING,
      kid: "compat042finite",
      nowMs: FIXTURE_NOW_MS,
      agent: "compat-fixture",
    });
    expect(finite.token).toBe(FINITE_042_TOKEN);
    const eternal = mintApiKey({
      app: "emails",
      scopes: ["emails:read", "emails:write"],
      signingSecret: FIXTURE_SIGNING,
      kid: "compat042eternal",
      nowMs: FIXTURE_NOW_MS,
      ttlSeconds: null,
    });
    expect(eternal.token).toBe(ETERNAL_042_TOKEN);
  });

  it("authenticates 0.4.2 keys through the real server verifier (canonical + alias)", async () => {
    const verifier = verifyApiKeyWithAliases(
      { signingSecret: FIXTURE_SIGNING, nowMs: () => VERIFY_NOW_MS },
      [SELF_HOSTED_APP, ...SELF_HOSTED_APP_ALIASES] as [string, ...string[]],
    );

    const canonical = await verifier.authenticate(new Headers({ "x-api-key": FINITE_042_TOKEN }));
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(canonical.principal.app).toBe("emails");
      expect(canonical.principal.kid).toBe("compat042finite");
      expect(canonical.principal.tid).toBeNull();
    }

    const alias = await verifier.authenticate(new Headers({ "x-api-key": ALIAS_042_TOKEN }));
    expect(alias.ok).toBe(true);
    if (alias.ok) {
      expect(alias.principal.app).toBe("mailery");
      expect(alias.principal.kid).toBe("compat042alias");
      expect(alias.principal.tid).toBeNull();
    }
  });
});
