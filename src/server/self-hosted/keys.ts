import {
  mintApiKey,
  type ApiKeyRecord,
  type ApiKeyStore,
  type MintedApiKey,
} from "@hasna/contracts/auth";
import { SELF_HOSTED_APP } from "./env.js";

export type SelfHostedKeyStore = Pick<ApiKeyStore, "insertMinted" | "list" | "revoke">;

export interface PublicApiKeyRecord {
  kid: string;
  app: string;
  agent: string | null;
  scopes: string[];
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  createdBy: string | null;
}

function validateEmailsScopes(scopes: string[]): void {
  if (scopes.length === 0 || scopes.some((scope) => !["emails:read", "emails:write", "emails:*"].includes(scope))) {
    throw new Error("Scopes must be one or more of emails:read, emails:write, or emails:*.");
  }
}

function publicRecord(record: ApiKeyRecord): PublicApiKeyRecord {
  return {
    kid: record.kid,
    app: record.app,
    agent: record.agent,
    scopes: record.scopes,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
    lastUsedAt: record.lastUsedAt,
    createdBy: record.createdBy,
  };
}

export async function issueSelfHostedApiKey(
  store: SelfHostedKeyStore,
  signingSecret: string,
  options: { scopes?: string[]; ttlDays?: number | null; agent?: string; createdBy?: string } = {},
): Promise<MintedApiKey> {
  const scopes = [...new Set(options.scopes ?? ["emails:*"])];
  validateEmailsScopes(scopes);
  const ttlDays = options.ttlDays === undefined ? 90 : options.ttlDays;
  if (ttlDays !== null && (!Number.isFinite(ttlDays) || ttlDays <= 0)) {
    throw new Error("ttlDays must be a positive number or null.");
  }
  const minted = mintApiKey({
    app: SELF_HOSTED_APP,
    scopes,
    signingSecret,
    ttlSeconds: ttlDays === null ? null : Math.floor(ttlDays * 86_400),
    agent: options.agent,
  });
  await store.insertMinted(minted, options.createdBy ?? "emails-cli");
  return minted;
}

export async function listSelfHostedApiKeys(store: SelfHostedKeyStore): Promise<PublicApiKeyRecord[]> {
  return (await store.list({ app: SELF_HOSTED_APP, includeRevoked: true })).map(publicRecord);
}

export async function revokeSelfHostedApiKey(
  store: SelfHostedKeyStore,
  kid: string,
  reason = "revoked by operator",
): Promise<boolean> {
  const normalized = kid.trim();
  if (!normalized) throw new Error("A key id is required.");
  return store.revoke(normalized, reason);
}

export async function rotateToEmailsApiKey(
  store: SelfHostedKeyStore,
  signingSecret: string,
  options: { scopes?: string[]; ttlDays?: number | null; agent?: string; createdBy?: string } = {},
): Promise<{ minted: MintedApiKey; retainedLegacyKids: string[] }> {
  const legacy = await store.list({ app: "mailery", includeRevoked: false });
  const minted = await issueSelfHostedApiKey(store, signingSecret, options);
  return { minted, retainedLegacyKids: legacy.map((record) => record.kid) };
}
