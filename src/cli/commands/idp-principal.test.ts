// The `emails self-hosted idp-principal` operator verbs (ADR-0001/0002).
//
// The federation slice had NO CLI surface: creating a grant or throwing the
// revoked_at kill switch meant hand SQL against production. These verbs make a
// grant one command and — the incident path — a revocation one command,
// against the server's own database exactly like `self-hosted key`.
//
// The store is injected, so this suite asserts the COMMAND: argument parsing,
// tenant scoping, and what reaches the store. The store methods themselves are
// proven in idp-multi-grant.test.ts and idp.integration.test.ts.

import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerIdpPrincipalCommands, type IdpPrincipalStore } from "./idp-principal.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Calls {
  upserts: unknown[];
  revokes: unknown[];
  restores: unknown[];
  lists: unknown[];
}

function harness(overrides: Partial<IdpPrincipalStore> = {}) {
  const calls: Calls = { upserts: [], revokes: [], restores: [], lists: [] };
  const outputs: unknown[] = [];
  const store: IdpPrincipalStore = {
    async upsertIdpPrincipalTenant(input) {
      calls.upserts.push(input);
      return {
        sub: input.sub,
        tenantId: input.tenantId,
        idpTid: input.idpTid ?? null,
        principalType: input.principalType ?? "service",
        revokedAt: null,
      };
    },
    async revokeIdpPrincipalTenant(sub, tenantId) {
      calls.revokes.push({ sub, tenantId });
      return true;
    },
    async restoreIdpPrincipalTenant(sub, tenantId) {
      calls.restores.push({ sub, tenantId });
      return true;
    },
    async listIdpPrincipalTenants(tenantId) {
      calls.lists.push(tenantId);
      return [
        {
          sub: "sp-known",
          tenantId,
          idpTid: null,
          principalType: "service",
          note: null,
          createdAt: "2026-07-01T00:00:00Z",
          revokedAt: null,
        },
      ];
    },
    ...overrides,
  };
  const program = new Command();
  program.exitOverride();
  const selfHosted = program.command("self-hosted");
  registerIdpPrincipalCommands(
    selfHosted,
    (data) => outputs.push(data),
    async () => ({ store, close: async () => {} }),
  );
  const run = (argv: string[]) => program.parseAsync(["node", "emails", "self-hosted", ...argv]);
  return { run, calls, outputs };
}

describe("idp-principal grant", () => {
  it("grants sub -> tenant with the pinned IdP tenant and note", async () => {
    const { run, calls, outputs } = harness();
    await run([
      "idp-principal", "grant", "sp-agent-1",
      "--tenant", TENANT,
      "--idp-tid", "11111111-2222-3333-4444-555555555555",
      "--type", "service",
      "--note", "ci agent",
    ]);
    expect(calls.upserts).toEqual([
      {
        sub: "sp-agent-1",
        tenantId: TENANT,
        idpTid: "11111111-2222-3333-4444-555555555555",
        principalType: "service",
        note: "ci agent",
      },
    ]);
    expect(outputs[0]).toMatchObject({ sub: "sp-agent-1", tenantId: TENANT });
  });

  it("refuses to grant without an explicit tenant", async () => {
    const { run, calls } = harness();
    await expect(run(["idp-principal", "grant", "sp-agent-1"])).rejects.toThrow();
    expect(calls.upserts).toEqual([]);
  });
});

describe("idp-principal revoke — the kill switch", () => {
  it("revokes one tenant grant when --tenant is given", async () => {
    const { run, calls } = harness();
    await run(["idp-principal", "revoke", "sp-agent-1", "--tenant", TENANT]);
    expect(calls.revokes).toEqual([{ sub: "sp-agent-1", tenantId: TENANT }]);
  });

  it("revokes EVERY grant of the sub when --tenant is omitted (incident path, one command)", async () => {
    const { run, calls } = harness();
    await run(["idp-principal", "revoke", "sp-agent-1"]);
    expect(calls.revokes).toEqual([{ sub: "sp-agent-1", tenantId: undefined }]);
  });

  it("reports a no-op revoke as an error instead of implying the switch was thrown", async () => {
    const { run } = harness({
      async revokeIdpPrincipalTenant() {
        return false;
      },
    });
    await expect(run(["idp-principal", "revoke", "sp-gone"])).rejects.toThrow();
  });
});

describe("idp-principal restore and list", () => {
  it("restore requires the tenant (deliberate, single-grant act)", async () => {
    const { run, calls } = harness();
    await run(["idp-principal", "restore", "sp-agent-1", "--tenant", TENANT]);
    expect(calls.restores).toEqual([{ sub: "sp-agent-1", tenantId: TENANT }]);
    await expect(run(["idp-principal", "restore", "sp-agent-1"])).rejects.toThrow();
  });

  it("lists a tenant's grants", async () => {
    const { run, calls, outputs } = harness();
    await run(["idp-principal", "list", "--tenant", TENANT]);
    expect(calls.lists).toEqual([TENANT]);
    expect(outputs[0]).toMatchObject([{ sub: "sp-known" }]);
  });
});
