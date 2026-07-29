import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { assertProviderCredentialsStorable, createProvider, listProviders, listProviderSummaries, deleteProvider, getProvider, getProviderWithCredentials, resolveProviderId, updateProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import {
  providerSecretsKeyStatus,
  rewrapProviderSecrets,
  revokeProviderSecretsRootKey,
  rotateProviderSecretsRootKey,
} from "../../db/provider-secrets.js";
import { getAdapter } from "../../providers/index.js";
import { log } from "../../lib/logger.js";
import { getEmailsMode } from "../../lib/mode.js";
import type { Provider } from "../../types/index.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

type SupportedProviderType = "resend" | "ses" | "sandbox";

function parseProviderType(value: string): SupportedProviderType {
  if (value === "resend" || value === "ses" || value === "sandbox") return value;
  handleError(new Error("Provider type must be 'resend', 'ses', or 'sandbox'"));
  return "sandbox";
}

interface ProviderCredentialInput {
  name: string;
  type: SupportedProviderType;
  apiKey?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

/**
 * An in-memory provider built from EXACTLY what the operator typed.
 *
 * Validation must exercise the supplied credentials, not whatever the persisted
 * row happens to contain. In self_hosted mode the stored row carries no
 * credentials at all, so validating it fell through to the CLI machine's
 * ambient AWS chain and reported "Provider credentials are invalid" for
 * credentials that were perfectly valid — the operator-facing half of the
 * 2026-07-25 incident.
 */
function candidateProvider(input: ProviderCredentialInput): Provider {
  const now = new Date().toISOString();
  return {
    id: "candidate",
    name: input.name,
    type: input.type,
    api_key: input.apiKey?.trim() || null,
    region: input.region?.trim() || null,
    access_key: input.accessKey?.trim() || null,
    secret_key: input.secretKey?.trim() || null,
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
    active: true,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Validate a candidate against the provider API.
 *
 * Returns a human-readable note when validation was deliberately NOT performed,
 * so the command never implies an unverified provider was verified.
 */
async function validateProviderCandidate(
  candidate: Provider,
  opts: { skipValidation?: boolean },
): Promise<{ validated: boolean; note?: string }> {
  if (opts.skipValidation) return { validated: false, note: "credential validation skipped (--skip-validation)" };
  if (candidate.type === "sandbox") return { validated: false };
  const hasCredentials = Boolean(candidate.api_key || candidate.access_key || candidate.secret_key);
  if (!hasCredentials && getEmailsMode() === "self_hosted") {
    // Nothing was supplied and the SERVER holds the real credentials. Probing
    // this machine's ambient AWS chain would tell the operator nothing about
    // whether the server can send, so do not pretend it did.
    return {
      validated: false,
      note: "credentials were not validated: in self_hosted mode the server signs outbound mail with its own "
        + "environment credentials, which this client cannot reach",
    };
  }
  const adapter = getAdapter(candidate);
  await adapter.listDomains();
  return { validated: true };
}

function credentialValidationError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `The supplied provider credentials were rejected by the provider API: ${detail}. Nothing was saved.`,
  );
}

export function registerProviderCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const providerCmd = program.command("provider").description("Manage email providers");

  const secretsCmd = providerCmd.command("secrets").description("Manage the local provider credential keyring");

  secretsCmd
    .command("status")
    .description("Show root-key IDs and envelope bindings (never secret values)")
    .action(() => {
      try {
        const status = providerSecretsKeyStatus(getDatabase());
        output(status, [
          `Provider secret keyring: ${status.source}`,
          `Active root key: ${status.activeKeyId ?? "not initialized"}`,
          `Referenced root keys: ${status.referencedKeyIds.join(", ") || "none"}`,
        ].join("\n"));
      } catch (e) { handleError(e); }
    });

  secretsCmd
    .command("rewrap")
    .description("Rewrap all provider data keys with the active root key")
    .action(() => {
      try {
        const count = rewrapProviderSecrets(getDatabase());
        output({ rewrapped: count }, chalk.green(`✓ Rewrapped ${count} provider secret envelope(s).`));
      } catch (e) { handleError(e); }
    });

  secretsCmd
    .command("rotate-root")
    .description("Stage a new root key and rewrap all provider data keys")
    .action(() => {
      try {
        const result = rotateProviderSecretsRootKey(getDatabase());
        output(result, chalk.green(`✓ Root key rotated to ${result.activeKeyId}; ${result.rewrapped} envelope(s) rewrapped.`));
      } catch (e) { handleError(e); }
    });

  secretsCmd
    .command("revoke-root <keyId>")
    .description("Remove an unreferenced, inactive provider root key")
    .option("--yes", "Skip confirmation prompt")
    .action(async (keyId: string, opts: { yes?: boolean }) => {
      try {
        await confirmDestructiveAction(`Revoke provider root key ${keyId}?`, opts.yes);
        revokeProviderSecretsRootKey(keyId, getDatabase());
        output({ revoked: keyId }, chalk.green(`✓ Revoked provider root key ${keyId}.`));
      } catch (e) { handleError(e); }
    });

  providerCmd
    .command("add")
    .description("Add an email provider (resend, ses, or sandbox)")
    .requiredOption("--name <name>", "Provider name")
    .requiredOption("--type <type>", "Provider type: resend | ses | sandbox")
    .option("--api-key <key>", "Resend API key")
    .option("--region <region>", "SES region")
    .option("--access-key <key>", "SES access key ID")
    .option("--secret-key <key>", "SES secret access key")
    .option("--skip-validation", "Skip credential validation after adding")
    .action(async (opts: {
      name: string;
      type: string;
      apiKey?: string;
      region?: string;
      accessKey?: string;
      secretKey?: string;
      skipValidation?: boolean;
    }) => {
      try {
        const type = parseProviderType(opts.type);
        // Refuse credentials the selected backend cannot store BEFORE spending a
        // provider round-trip validating them.
        assertProviderCredentialsStorable({
          name: opts.name,
          type,
          api_key: opts.apiKey,
          region: opts.region,
          access_key: opts.accessKey,
          secret_key: opts.secretKey,
        });
        // Validate BEFORE persisting, and with the credentials the operator
        // actually supplied. The old order (create → validate the stored row →
        // delete on failure) both lied about why validation failed and left the
        // deletion as the only cleanup.
        const candidate = candidateProvider({
          name: opts.name,
          type,
          apiKey: opts.apiKey,
          region: opts.region,
          accessKey: opts.accessKey,
          secretKey: opts.secretKey,
        });
        let validation: { validated: boolean; note?: string };
        try {
          validation = await validateProviderCandidate(candidate, opts);
        } catch (validationErr) {
          return handleError(credentialValidationError(validationErr));
        }

        const provider = createProvider({
          name: opts.name,
          type,
          api_key: opts.apiKey,
          region: opts.region,
          access_key: opts.accessKey,
          secret_key: opts.secretKey,
        });

        if (type === "sandbox") {
          log.success(`✓ Sandbox provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
          log.info(chalk.dim("  Emails sent to this provider are captured locally, not delivered."));
        } else {
          log.success(`✓ Provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
          if (validation.validated) log.info(chalk.dim("  Credentials validated against the provider API."));
        }
        if (validation.note) log.info(chalk.yellow(`  ⚠ ${validation.note}`));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("list")
    .description("List configured providers")
    .option("--limit <n>", "Maximum providers to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of providers to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const page = parseCliListPage(opts);
        const providers = listProviderSummaries(page);
        if (providers.length === 0) {
          output([], chalk.dim("No providers configured. Use 'emails provider add' to add one."));
          return;
        }
        const lines: string[] = [chalk.bold("\nProviders:")];
        for (const p of providers) {
          const status = p.active ? chalk.green("active") : chalk.yellow("inactive");
          lines.push(`  ${chalk.cyan(p.id.slice(0, 8))}  ${p.name}  [${p.type}]  ${status}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: providers.length,
          limit: page.limit,
          offset: page.offset,
          noun: "provider",
          detailCommand: "use emails provider update <id> --help for editable fields",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(providers, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("remove <id>")
    .description("Remove a provider")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const resolvedId = resolveProviderId(id);
        if (!resolvedId) handleError(new Error(`Provider not found or ambiguous: ${id}`));
        const provider = getProvider(resolvedId);
        if (!provider) handleError(new Error(`Provider not found: ${id}`));
        await confirmDestructiveAction(`Remove provider ${provider.name}?`, opts.yes);
        deleteProvider(resolvedId);
        console.log(chalk.green(`✓ Provider removed: ${provider.name}`));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("update <id>")
    .description("Update an existing provider")
    .option("--name <name>", "Provider name")
    .option("--api-key <key>", "Resend API key")
    .option("--region <region>", "SES region")
    .option("--access-key <key>", "SES access key ID")
    .option("--secret-key <key>", "SES secret access key")
    .option("--skip-validation", "Skip credential validation after update")
    .action(async (id: string, opts: {
      name?: string;
      apiKey?: string;
      region?: string;
      accessKey?: string;
      secretKey?: string;
      skipValidation?: boolean;
    }) => {
      try {
        const resolvedId = resolveProviderId(id);
        if (!resolvedId) handleError(new Error(`Provider not found or ambiguous: ${id}`));
        const existing = getProvider(resolvedId);
        if (!existing) handleError(new Error(`Provider not found: ${id}`));

        const original = { ...(getProviderWithCredentials(resolvedId) ?? existing!) };
        const updates: Record<string, string | undefined> = {};
        if (opts.name !== undefined) updates.name = opts.name;
        if (opts.apiKey !== undefined) updates.api_key = opts.apiKey;
        if (opts.region !== undefined) updates.region = opts.region;
        if (opts.accessKey !== undefined) updates.access_key = opts.accessKey;
        if (opts.secretKey !== undefined) updates.secret_key = opts.secretKey;

        assertProviderCredentialsStorable(updates as Partial<Parameters<typeof createProvider>[0]>);
        // Same rule as `add`: verify the credentials that WOULD take effect,
        // before anything is written, so a rejection never requires a revert
        // and never blames the wrong identity.
        const candidate = candidateProvider({
          name: opts.name ?? original.name,
          type: original.type as SupportedProviderType,
          apiKey: opts.apiKey ?? original.api_key ?? undefined,
          region: opts.region ?? original.region ?? undefined,
          accessKey: opts.accessKey ?? original.access_key ?? undefined,
          secretKey: opts.secretKey ?? original.secret_key ?? undefined,
        });
        let validation: { validated: boolean; note?: string };
        try {
          validation = await validateProviderCandidate(candidate, opts);
        } catch (validationErr) {
          return handleError(credentialValidationError(validationErr));
        }

        const updated = updateProvider(resolvedId, updates);

        log.success(`✓ Provider updated: ${updated.name} (${updated.id.slice(0, 8)})`);
        if (validation.validated) log.info(chalk.dim("  Credentials validated against the provider API."));
        if (validation.note) log.info(chalk.yellow(`  ⚠ ${validation.note}`));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("status")
    .description("Health check active supported providers")
    .action(async () => {
      try {
        const { checkAllProviders, formatProviderHealth } = await import("../../lib/health.js");
        const results = await checkAllProviders();
        if (results.length === 0) {
          output([], chalk.dim("No active supported providers. Add one with 'emails provider add'"));
          return;
        }
        const lines: string[] = [chalk.bold("\nProvider Health:\n")];
        for (const h of results) {
          lines.push(formatProviderHealth(h));
          lines.push("");
        }
        output(results, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("check")
    .description("Verify supported providers are healthy")
    .action(async () => {
      try {
        const providers = listProviders();
        if (providers.length === 0) {
          console.log(chalk.dim("No providers configured."));
          console.log(chalk.bold("\nQuick setup:"));
          console.log(chalk.dim("  SES:    emails provider add --type ses --name \"My SES\" --region us-east-1 --access-key ... --secret-key ..."));
          console.log(chalk.dim("  Resend: emails provider add --type resend --name \"My Resend\" --api-key re_..."));
          console.log(chalk.dim("  Sandbox: emails provider add --type sandbox --name \"Local Sandbox\""));
          return;
        }

        console.log(chalk.bold(`\nChecking ${providers.length} provider(s)...\n`));
        for (const p of providers) {
          const executable = getProviderWithCredentials(p.id) ?? p;
          const icon = p.active ? "" : chalk.dim("[inactive] ");
          process.stdout.write(`  ${icon}${chalk.cyan(p.name)} (${p.type}) ... `);
          if (p.type === "ses") {
            if (!executable.access_key || !executable.secret_key) {
              console.log(chalk.yellow("⚠ missing credentials"));
            } else {
              try {
                const adapter = getAdapter(executable);
                await adapter.listDomains();
                console.log(chalk.green("✓ connected"));
              } catch (e) {
                console.log(chalk.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
              }
            }
          } else if (p.type === "resend") {
            if (!executable.api_key) {
              console.log(chalk.yellow("⚠ missing API key"));
            } else {
              try {
                const adapter = getAdapter(executable);
                await adapter.listDomains();
                console.log(chalk.green("✓ connected"));
              } catch (e) {
                console.log(chalk.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
              }
            }
          } else {
            console.log(chalk.dim("sandbox (no auth needed)"));
          }
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });
}
