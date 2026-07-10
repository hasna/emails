import { ApiKeyStore } from "@hasna/contracts/auth";
import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { closeSelfHostedPool, getSelfHostedPool, requireSigningSecret } from "../../server/self-hosted/env.js";
import { issueSelfHostedApiKey, listSelfHostedApiKeys, revokeSelfHostedApiKey, rotateToEmailsApiKey } from "../../server/self-hosted/keys.js";
import { handleError } from "../utils.js";

async function keyStore(): Promise<{ store: ApiKeyStore; signingSecret: string }> {
  const signingSecret = requireSigningSecret();
  const store = new ApiKeyStore(getSelfHostedPool().client);
  await store.ensureSchema();
  return { store, signingSecret };
}

export function registerSelfHostedCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const selfHosted = program.command("self-hosted").description("Operate your self-hosted Emails deployment");
  const key = selfHosted.command("key").description("Create, list, and revoke self-hosted API keys");

  key.command("create")
    .description("Mint and persist an API key; the plaintext token is shown once")
    .option("--scope <scope...>", "Granted scope(s): emails:read, emails:write, emails:*", ["emails:*"])
    .option("--ttl-days <days>", "Expiry in days", "90")
    .option("--no-expiry", "Create a key without expiry")
    .option("--agent <name>", "Optional key subject")
    .action(async (opts: { scope: string[]; ttlDays: string; expiry: boolean; agent?: string }) => {
      try {
        const { store, signingSecret } = await keyStore();
        const minted = await issueSelfHostedApiKey(store, signingSecret, {
          scopes: opts.scope,
          ttlDays: opts.expiry === false ? null : Number(opts.ttlDays),
          agent: opts.agent,
        });
        const result = { token: minted.token, kid: minted.kid, scopes: minted.claims.scopes, expiresAt: minted.claims.exp === null ? null : new Date(minted.claims.exp * 1000).toISOString() };
        output(result, `${chalk.green("API key created. Save this token now; it will not be shown again:")}\n${minted.token}\n\nKey id: ${minted.kid}`);
      } catch (error) {
        handleError(error);
      } finally {
        await closeSelfHostedPool();
      }
    });

  key.command("list")
    .description("List key metadata without plaintext tokens or hashes")
    .action(async () => {
      try {
        const { store } = await keyStore();
        const records = await listSelfHostedApiKeys(store);
        output(records, records.length ? records.map((record) => `${record.kid}  ${record.scopes.join(",")}  ${record.revokedAt ? "revoked" : "active"}`).join("\n") : chalk.dim("No API keys."));
      } catch (error) {
        handleError(error);
      } finally {
        await closeSelfHostedPool();
      }
    });

  key.command("rotate")
    .description("Mint an Emails key while retaining active legacy keys for rollback")
    .option("--scope <scope...>", "Granted scope(s)", ["emails:*"])
    .option("--ttl-days <days>", "Expiry in days", "90")
    .option("--agent <name>", "Optional key subject")
    .action(async (opts: { scope: string[]; ttlDays: string; agent?: string }) => {
      try {
        const { store, signingSecret } = await keyStore();
        const result = await rotateToEmailsApiKey(store, signingSecret, {
          scopes: opts.scope,
          ttlDays: Number(opts.ttlDays),
          agent: opts.agent,
        });
        const data = {
          token: result.minted.token,
          kid: result.minted.kid,
          retainedLegacyKids: result.retainedLegacyKids,
        };
        output(data, `${chalk.green("Emails API key created. Save this token now; it will not be shown again:")}\n${result.minted.token}\n\nLegacy rollback keys retained: ${result.retainedLegacyKids.length}`);
      } catch (error) {
        handleError(error);
      } finally {
        await closeSelfHostedPool();
      }
    });

  key.command("revoke <kid>")
    .description("Revoke an API key by key id")
    .option("--reason <reason>", "Revocation reason", "revoked by operator")
    .action(async (kid: string, opts: { reason: string }) => {
      try {
        const { store } = await keyStore();
        const revoked = await revokeSelfHostedApiKey(store, kid, opts.reason);
        if (!revoked) throw new Error(`API key not found: ${kid}`);
        output({ kid, revoked: true }, chalk.green(`Revoked API key ${kid}.`));
      } catch (error) {
        handleError(error);
      } finally {
        await closeSelfHostedPool();
      }
    });
}
