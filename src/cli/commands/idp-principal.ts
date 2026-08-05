// `emails self-hosted idp-principal` — the operator surface for IdP-principal
// federation grants (ADR-0001/0002), against the server's own database exactly
// like `self-hosted key`.
//
// Grants are privilege-granting rows (idp_principal_tenants): they decide
// which tenant a verified IdP token may act in, and `revoked_at` on them is
// the ONLY revocation the emails side can enforce within a token's ≤24h life.
// These verbs make a grant auditable and a revocation ONE command during an
// incident — no hand SQL. A re-grant never lifts the kill switch; `restore`
// is the separate, deliberate act that does.
//
// The store is injected so the command surface is testable without a
// database; the default factory wires the self-hosted Postgres pool.

import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import type { IdpPrincipalMapping } from "../../server/self-hosted/auth/store.js";

/** The slice of AuthStore these verbs need (kept narrow for injection). */
export interface IdpPrincipalStore {
  upsertIdpPrincipalTenant(input: {
    sub: string;
    tenantId: string;
    idpTid?: string | null;
    principalType?: "user" | "service";
    note?: string | null;
    createdByUserId?: string | null;
  }): Promise<IdpPrincipalMapping | null>;
  revokeIdpPrincipalTenant(sub: string, tenantId?: string): Promise<boolean>;
  restoreIdpPrincipalTenant(sub: string, tenantId: string): Promise<boolean>;
  listIdpPrincipalTenants(tenantId: string): Promise<Array<IdpPrincipalMapping & {
    note: string | null;
    createdAt: string;
  }>>;
}

export type IdpPrincipalStoreFactory = () => Promise<{
  store: IdpPrincipalStore;
  close: () => Promise<void>;
}>;

/** Default factory: the self-hosted server's own Postgres (like `self-hosted key`). */
async function defaultStoreFactory(): Promise<{ store: IdpPrincipalStore; close: () => Promise<void> }> {
  const { getSelfHostedPool, closeSelfHostedPool } = await import("../../server/self-hosted/env.js");
  const { AuthStore } = await import("../../server/self-hosted/auth/store.js");
  return {
    store: new AuthStore(getSelfHostedPool().client),
    close: () => closeSelfHostedPool(),
  };
}

function grantLine(grant: IdpPrincipalMapping & { note?: string | null; createdAt?: string }): string {
  const state = grant.revokedAt ? chalk.red(`revoked ${grant.revokedAt}`) : chalk.green("active");
  return `${grant.sub}  tenant=${grant.tenantId}  idp-tid=${grant.idpTid ?? "-"}  type=${grant.principalType}  ${state}`;
}

export function registerIdpPrincipalCommands(
  selfHosted: Command,
  output: (data: unknown, formatted: string) => void,
  storeFactory: IdpPrincipalStoreFactory = defaultStoreFactory,
): void {
  const idp = selfHosted
    .command("idp-principal")
    .description("Grant, revoke, restore, and list IdP-principal federation grants");

  async function withStore<T>(fn: (store: IdpPrincipalStore) => Promise<T>): Promise<T> {
    const { store, close } = await storeFactory();
    try {
      return await fn(store);
    } finally {
      await close();
    }
  }

  idp.command("grant <sub>")
    .description("Grant an IdP principal (sub) access to ONE tenant; a re-grant never un-revokes")
    .requiredOption("--tenant <tenant-id>", "Tenant the principal may act in")
    .option("--idp-tid <idp-tenant-id>", "Pin the IdP tenant; a token with a different tid is refused")
    .option("--type <type>", "Principal type: user or service", "service")
    .option("--note <note>", "Operator note recorded on the grant")
    .action(async (sub: string, opts: { tenant: string; idpTid?: string; type: string; note?: string }) => {
      const principalType = opts.type;
      if (principalType !== "user" && principalType !== "service") {
        throw new Error("--type must be 'user' or 'service'");
      }
      const grant = await withStore((store) =>
        store.upsertIdpPrincipalTenant({
          sub,
          tenantId: opts.tenant,
          idpTid: opts.idpTid ?? null,
          principalType,
          note: opts.note ?? null,
        }),
      );
      if (!grant) throw new Error("the grant could not be persisted");
      const revokedWarning = grant.revokedAt
        ? `\n${chalk.yellow("This grant is REVOKED; a re-grant never lifts the kill switch. Use 'idp-principal restore' to do that deliberately.")}`
        : "";
      output(grant, `${chalk.green("Granted.")} ${grantLine(grant)}${revokedWarning}`);
    });

  idp.command("revoke <sub>")
    .description("Throw the kill switch: with --tenant one grant, without it EVERY grant of the sub")
    .option("--tenant <tenant-id>", "Limit the revocation to one tenant grant")
    .action(async (sub: string, opts: { tenant?: string }) => {
      const revoked = await withStore((store) => store.revokeIdpPrincipalTenant(sub, opts.tenant));
      if (!revoked) {
        throw new Error(
          opts.tenant
            ? `no live grant for '${sub}' in tenant ${opts.tenant} — nothing was revoked`
            : `no live grants for '${sub}' — nothing was revoked`,
        );
      }
      output(
        { sub, tenantId: opts.tenant ?? null, revoked: true },
        chalk.green(opts.tenant ? `Revoked '${sub}' in tenant ${opts.tenant}.` : `Revoked every grant of '${sub}'.`),
      );
    });

  idp.command("restore <sub>")
    .description("Deliberately lift the kill switch on ONE (sub, tenant) grant")
    .requiredOption("--tenant <tenant-id>", "Tenant whose grant is restored")
    .action(async (sub: string, opts: { tenant: string }) => {
      const restored = await withStore((store) => store.restoreIdpPrincipalTenant(sub, opts.tenant));
      if (!restored) {
        throw new Error(`no revoked grant for '${sub}' in tenant ${opts.tenant} — nothing was restored`);
      }
      output({ sub, tenantId: opts.tenant, restored: true }, chalk.green(`Restored '${sub}' in tenant ${opts.tenant}.`));
    });

  idp.command("list")
    .description("List a tenant's IdP-principal grants, revoked ones included")
    .requiredOption("--tenant <tenant-id>", "Tenant whose grants are listed")
    .action(async (opts: { tenant: string }) => {
      const grants = await withStore((store) => store.listIdpPrincipalTenants(opts.tenant));
      output(
        grants,
        grants.length ? grants.map((grant) => grantLine(grant)).join("\n") : chalk.dim("No idp principal grants."),
      );
    });
}
