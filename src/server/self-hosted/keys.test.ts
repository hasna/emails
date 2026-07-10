import { describe, expect, test } from "bun:test";
import { hashToken, verifyApiKeyToken, type ApiKeyRecord, type MintedApiKey } from "@hasna/contracts/auth";
import { issueSelfHostedApiKey, listSelfHostedApiKeys, revokeSelfHostedApiKey, rotateToEmailsApiKey } from "./keys.js";

const SIGNING_SECRET = "a-test-signing-secret-that-is-long-enough";

function memoryStore() {
  const rows = new Map<string, ApiKeyRecord>();
  return {
    rows,
    async insertMinted(minted: MintedApiKey, createdBy?: string) {
      rows.set(minted.kid, {
        kid: minted.kid,
        app: minted.claims.app,
        agent: minted.claims.agent ?? null,
        scopes: minted.claims.scopes,
        tokenHash: minted.tokenHash,
        issuedAt: new Date(minted.claims.iat * 1000).toISOString(),
        expiresAt: minted.claims.exp === null ? null : new Date(minted.claims.exp * 1000).toISOString(),
        revokedAt: null,
        revokedReason: null,
        lastUsedAt: null,
        createdBy: createdBy ?? null,
      });
    },
    async list(options?: { app?: string; includeRevoked?: boolean }) {
      return [...rows.values()].filter((row) =>
        (!options?.app || row.app === options.app)
        && (options?.includeRevoked || !row.revokedAt));
    },
    async revoke(kid: string, reason?: string) {
      const row = rows.get(kid);
      if (!row) return false;
      rows.set(kid, { ...row, revokedAt: new Date().toISOString(), revokedReason: reason ?? null });
      return true;
    },
  };
}

describe("self-hosted API key lifecycle", () => {
  test("mints a scoped token once and persists only its hash and metadata", async () => {
    const store = memoryStore();
    const minted = await issueSelfHostedApiKey(store, SIGNING_SECRET, {
      scopes: ["emails:read", "emails:write"],
      ttlDays: 7,
      agent: "operator",
    });
    const row = store.rows.get(minted.kid)!;

    expect(verifyApiKeyToken(minted.token, { expectedApp: "emails", signingSecret: SIGNING_SECRET }).ok).toBe(true);
    expect(row.tokenHash).toBe(hashToken(minted.token));
    expect(JSON.stringify(row)).not.toContain(minted.token);
    expect(await listSelfHostedApiKeys(store)).toEqual([
      expect.not.objectContaining({ tokenHash: expect.anything() }),
    ]);
  });

  test("revokes an issued key by kid", async () => {
    const store = memoryStore();
    const minted = await issueSelfHostedApiKey(store, SIGNING_SECRET);
    expect(await revokeSelfHostedApiKey(store, minted.kid, "rotation")).toBe(true);
    expect(store.rows.get(minted.kid)).toMatchObject({ revokedReason: "rotation" });
    expect(await revokeSelfHostedApiKey(store, "missing")).toBe(false);
  });

  test("rotation mints an Emails key without revoking the rollback key", async () => {
    const store = memoryStore();
    store.rows.set("legacy-kid", {
      kid: "legacy-kid", app: "mailery", agent: null, scopes: ["mailery:*"], tokenHash: "hash-only",
      issuedAt: new Date().toISOString(), expiresAt: null, revokedAt: null, revokedReason: null,
      lastUsedAt: null, createdBy: "old-cli",
    });
    const result = await rotateToEmailsApiKey(store, SIGNING_SECRET);
    expect(result.minted.claims.app).toBe("emails");
    expect(result.retainedLegacyKids).toEqual(["legacy-kid"]);
    expect(store.rows.get("legacy-kid")?.revokedAt).toBeNull();
  });
});
