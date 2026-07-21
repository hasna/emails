import { describe, expect, it } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { verifyApiKeyWithAliases } from "./api-key-verifier.js";
import { SELF_HOSTED_APP, SELF_HOSTED_APP_ALIASES } from "./env.js";

const SIGNING = "a-signing-secret-at-least-32-chars-long!!";
const APPS = [SELF_HOSTED_APP, ...SELF_HOSTED_APP_ALIASES] as [string, ...string[]];

function headers(token: string): Headers {
  return new Headers({ "x-api-key": token });
}

describe("verifyApiKeyWithAliases (emails -> mailery app rename)", () => {
  const verifier = verifyApiKeyWithAliases({ signingSecret: SIGNING }, APPS);

  it("reports the canonical app slug", () => {
    expect(verifier.app).toBe("mailery");
    expect(SELF_HOSTED_APP).toBe("mailery");
    expect(SELF_HOSTED_APP_ALIASES).toContain("emails");
  });

  it("accepts a key minted under the canonical mailery app", async () => {
    const token = mintApiKey({ app: "mailery", scopes: ["emails:*"], signingSecret: SIGNING }).token;
    const decision = await verifier.authenticate(headers(token));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.principal.app).toBe("mailery");
  });

  it("accepts a legacy key minted under the emails alias", async () => {
    const token = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING }).token;
    const decision = await verifier.authenticate(headers(token));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.principal.app).toBe("emails");
  });

  it("rejects a key minted for a foreign app", async () => {
    const token = mintApiKey({ app: "todos", scopes: ["todos:*"], signingSecret: SIGNING }).token;
    const decision = await verifier.authenticate(headers(token));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("app_mismatch");
  });

  it("returns a terminal failure without falling through to aliases", async () => {
    // Valid canonical app but wrong signature -> bad_signature, not app_mismatch.
    const token = mintApiKey({ app: "mailery", scopes: ["emails:*"], signingSecret: "another-signing-secret-32-chars-xx!!" }).token;
    const decision = await verifier.authenticate(headers(token));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("bad_signature");
  });

  it("denies a REVOKED legacy emails key and preserves its kid in the audit line", async () => {
    const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING });
    const events: { outcome: string; kid: string | null; reason: unknown }[] = [];
    const revoking = verifyApiKeyWithAliases(
      {
        signingSecret: SIGNING,
        isRevoked: (kid) => kid === minted.kid,
        audit: (e) => { events.push({ outcome: e.outcome, kid: e.kid, reason: e.reason }); },
      },
      APPS,
    );
    const decision = await revoking.authenticate(headers(minted.token));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("revoked");
    expect(events).toEqual([{ outcome: "deny", kid: minted.kid, reason: "revoked" }]);
  });

  it("falls through app_mismatch to a terminal failure raised at the alias verifier", async () => {
    // A legacy emails token with a bad signature: mailery -> app_mismatch (fall
    // through), then emails -> bad_signature (terminal, not app_mismatch).
    const token = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: "another-signing-secret-32-chars-xx!!" }).token;
    const decision = await verifier.authenticate(headers(token));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("bad_signature");
  });

  it("fires the audit hook exactly once for an accepted alias key", async () => {
    const outcomes: string[] = [];
    const audited = verifyApiKeyWithAliases(
      { signingSecret: SIGNING, audit: (e) => { outcomes.push(e.outcome); } },
      APPS,
    );
    const token = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING }).token;
    await audited.authenticate(headers(token));
    expect(outcomes).toEqual(["allow"]);
  });
});
