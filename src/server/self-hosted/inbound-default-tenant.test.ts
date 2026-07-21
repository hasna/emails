// Regression tests for the single-tenant self-hosted inbound fallback.
//
// Incident: after migration 0016 dropped the transitional `messages.tenant_id`
// DEFAULT, inbound rows written without an explicit tenant (and thus without a
// matching `app.current_tenant`) failed the FORCE-RLS WITH CHECK on `messages`.
// The forward fix routes unrouted-but-valid envelope recipients to a configured
// default inbound tenant so the tenant-aware write path stamps tenant_id + sets
// the GUC (RLS satisfied) instead of quarantining. These tests pin that logic.

import { describe, expect, test } from "bun:test";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";
const ROUTED_TENANT = "11111111-1111-1111-1111-111111111111";

function makeStore(opts: {
  routes?: Array<{ domain: string; tenant_id: string }>;
  defaultTenantActive?: boolean;
} = {}): { store: EmailsSelfHostedStore; tenantLookups: string[] } {
  const tenantLookups: string[] = [];
  const client: TypedQueryClient = {
    async query() { throw new Error("query not expected"); },
    async many<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM inbound_domain_routes")) return (opts.routes ?? []) as T[];
      throw new Error(`unexpected many SQL: ${sql.slice(0, 80)}`);
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (sql.includes("FROM tenants WHERE id")) {
        tenantLookups.push(String(params?.[0]));
        return opts.defaultTenantActive ? ({ id: String(params?.[0]) } as T) : null;
      }
      throw new Error(`unexpected get SQL: ${sql.slice(0, 80)}`);
    },
    async one() { throw new Error("one not expected"); },
    async execute() {},
  };
  return { store: new EmailsSelfHostedStore(client), tenantLookups };
}

describe("resolveInboundRecipients single-tenant fallback", () => {
  test("quarantines an unrouted recipient when NO default tenant is configured (unchanged behavior)", async () => {
    const { store, tenantLookups } = makeStore({ routes: [] });
    const res = await store.resolveInboundRecipients(["vivaan@aibrokethis.com"]);
    expect(res.groups).toEqual([]);
    expect(res.unresolved).toEqual(["vivaan@aibrokethis.com"]);
    expect(tenantLookups).toEqual([]); // no default lookup performed
  });

  test("routes an unrouted recipient to the default tenant when configured and active", async () => {
    const { store, tenantLookups } = makeStore({ routes: [], defaultTenantActive: true });
    const res = await store.resolveInboundRecipients(["vivaan@aibrokethis.com"], {
      defaultTenantId: DEFAULT_TENANT,
    });
    expect(res.groups).toEqual([{ tenantId: DEFAULT_TENANT, recipients: ["vivaan@aibrokethis.com"] }]);
    expect(res.unresolved).toEqual([]);
    expect(tenantLookups).toEqual([DEFAULT_TENANT]);
  });

  test("quarantines (does not default) when the configured default tenant is missing/inactive", async () => {
    const { store } = makeStore({ routes: [], defaultTenantActive: false });
    const res = await store.resolveInboundRecipients(["vivaan@aibrokethis.com"], {
      defaultTenantId: DEFAULT_TENANT,
    });
    expect(res.groups).toEqual([]);
    expect(res.unresolved).toEqual(["vivaan@aibrokethis.com"]);
  });

  test("an explicit route still wins; only unrouted domains fall back to the default tenant", async () => {
    const { store } = makeStore({
      routes: [{ domain: "strober.com", tenant_id: ROUTED_TENANT }],
      defaultTenantActive: true,
    });
    const res = await store.resolveInboundRecipients(
      ["one@strober.com", "vivaan@aibrokethis.com"],
      { defaultTenantId: DEFAULT_TENANT },
    );
    const byTenant = Object.fromEntries(res.groups.map((g) => [g.tenantId, g.recipients]));
    expect(byTenant[ROUTED_TENANT]).toEqual(["one@strober.com"]);
    expect(byTenant[DEFAULT_TENANT]).toEqual(["vivaan@aibrokethis.com"]);
    expect(res.unresolved).toEqual([]);
  });

  test("does not query the default tenant when every domain already has a route", async () => {
    const { store, tenantLookups } = makeStore({
      routes: [{ domain: "strober.com", tenant_id: ROUTED_TENANT }],
      defaultTenantActive: true,
    });
    const res = await store.resolveInboundRecipients(["one@strober.com"], {
      defaultTenantId: DEFAULT_TENANT,
    });
    expect(res.groups).toEqual([{ tenantId: ROUTED_TENANT, recipients: ["one@strober.com"] }]);
    expect(tenantLookups).toEqual([]);
  });
});
