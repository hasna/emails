// Self-hosted-ONLY: the providers repo routes every read/write to the /v1
// `providers` API. This exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. The self-hosted `providers`
// resource carries ONLY non-secret metadata (id, name, type, region, active,
// timestamps): provider credentials are NEVER distributed to or fetched by a
// client, so api_key/access_key/secret_key/oauth_* always map to null. The old
// assertions that a created provider echoed back its secret were local-only and
// are updated to assert the credential-free contract instead.
//
// Also DROPPED: the SQL-projection inspection tests (recording db.query and
// asserting no "SELECT *" / no secret column names). Those checked local SQL that
// no longer exists; the meaningful part (summaries omit secret fields, and even a
// server that returns secrets is not leaked) is retained functionally below.
//
// Ordering-sensitive tests seed explicit created_at (create sets created_at≈now).

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createProvider,
  getProvider,
  getProviderByNameAndType,
  listProviders,
  listProviderSummaries,
  listProviderNamesByIds,
  listActiveProviders,
  listActiveProviderSummaries,
  getLatestActiveProvider,
  getLatestActiveProviderId,
  updateProvider,
  deleteProvider,
  getActiveProvider,
} from "./providers.js";
import { ProviderNotFoundError } from "../types/index.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

/** A snake_case /v1 provider row (extra secret fields exercise non-leakage). */
function prov(row: {
  id: string;
  name: string;
  type: string;
  region?: string | null;
  active?: boolean;
  created_at?: string;
  secrets?: boolean;
}): Record<string, unknown> {
  const ts = row.created_at ?? "2026-01-01T00:00:00.000Z";
  const base: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    type: row.type,
    region: row.region ?? null,
    active: row.active ?? true,
    created_at: ts,
    updated_at: ts,
  };
  if (row.secrets) {
    Object.assign(base, {
      api_key: "re_secret_value",
      access_key: "AKIA_secret",
      secret_key: "shhh_secret",
      oauth_client_secret: "oauth_secret_token",
      oauth_refresh_token: "refresh_secret_token",
      oauth_access_token: "access_secret_token",
    });
  }
  return base;
}

describe("createProvider", () => {
  it("creates a resend provider without echoing credentials", () => {
    const p = createProvider({ name: "Resend Prod", type: "resend", api_key: "re_abc123" });
    expect(p.id).toHaveLength(36);
    expect(p.name).toBe("Resend Prod");
    expect(p.type).toBe("resend");
    // Credentials are never distributed to the client.
    expect(p.api_key).toBeNull();
    expect(p.active).toBe(true);
  });

  it("creates an SES provider (region kept, credentials dropped)", () => {
    const p = createProvider({ name: "SES US", type: "ses", region: "us-east-1", access_key: "AKIA", secret_key: "secret" });
    expect(p.type).toBe("ses");
    expect(p.region).toBe("us-east-1");
    expect(p.access_key).toBeNull();
    expect(p.secret_key).toBeNull();
    expect(p.api_key).toBeNull();
  });

  it("returns null for optional fields when not provided", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    expect(p.api_key).toBeNull();
    expect(p.region).toBeNull();
    expect(p.access_key).toBeNull();
    expect(p.secret_key).toBeNull();
  });
});

describe("getProvider", () => {
  it("retrieves provider by id", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const found = getProvider(p.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(p.id);
  });

  it("returns null for unknown id", () => {
    expect(getProvider("nonexistent")).toBeNull();
  });
});

describe("getProviderByNameAndType", () => {
  it("finds the exact provider by name and type", () => {
    const resend = createProvider({ name: "Shared", type: "resend" });
    const ses = createProvider({ name: "Shared", type: "ses" });

    expect(getProviderByNameAndType("Shared", "ses")?.id).toBe(ses.id);
    expect(getProviderByNameAndType("Shared", "resend")?.id).toBe(resend.id);
    expect(getProviderByNameAndType("Missing", "sandbox")).toBeNull();
  });
});

describe("listProviders", () => {
  it("returns empty array when no providers", () => {
    expect(listProviders()).toEqual([]);
  });

  it("lists all providers", () => {
    const p1 = createProvider({ name: "First", type: "resend" });
    const p2 = createProvider({ name: "Second", type: "ses" });
    const list = listProviders();
    expect(list.length).toBe(2);
    expect(list.map((p) => p.id)).toContain(p1.id);
    expect(list.map((p) => p.id)).toContain(p2.id);
  });

  it("paginates providers newest first", async () => {
    await stub.seed({
      providers: Array.from({ length: 4 }, (_v, i) =>
        prov({ id: `p${i + 1}`, name: `Provider ${i + 1}`, type: "sandbox", created_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    });

    const page = listProviders({ limit: 2, offset: 1 });

    expect(page.map((provider) => provider.name)).toEqual(["Provider 3", "Provider 2"]);
  });
});

describe("listProviderSummaries", () => {
  it("uses a credential-free projection", async () => {
    await stub.seed({
      providers: [prov({ id: "p1", name: "Secretful", type: "resend", secrets: true })],
    });

    const [summary] = listProviderSummaries({ limit: 1 });

    expect(summary).toBeDefined();
    expect(summary?.name).toBe("Secretful");
    expect(summary?.type).toBe("resend");
    expect("oauth_client_secret" in summary!).toBe(false);
    expect("oauth_refresh_token" in summary!).toBe(false);
    expect("oauth_access_token" in summary!).toBe(false);
    expect("api_key" in summary!).toBe(false);
    expect("secret_key" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("token");
  });

  it("paginates provider summaries newest first", async () => {
    await stub.seed({
      providers: Array.from({ length: 4 }, (_v, i) =>
        prov({ id: `p${i + 1}`, name: `Summary Provider ${i + 1}`, type: "sandbox", created_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    });

    const page = listProviderSummaries({ limit: 2, offset: 1 });

    expect(page.map((provider) => provider.name)).toEqual(["Summary Provider 3", "Summary Provider 2"]);
  });
});

describe("listProviderNamesByIds", () => {
  it("returns names for selected provider ids only", () => {
    const first = createProvider({ name: "First", type: "resend" });
    const second = createProvider({ name: "Second", type: "ses" });
    createProvider({ name: "Other", type: "sandbox" });

    expect([...listProviderNamesByIds([first.id, second.id, first.id]).entries()].sort()).toEqual([
      [first.id, "First"],
      [second.id, "Second"],
    ].sort());
    expect(listProviderNamesByIds([]).size).toBe(0);
  });
});

describe("listActiveProviders", () => {
  it("lists active providers with optional type filtering in newest-first order", async () => {
    await stub.seed({
      providers: [
        prov({ id: "old", name: "Old", type: "resend", active: true, created_at: "2026-01-01T00:00:00.000Z" }),
        prov({ id: "inactive", name: "Inactive", type: "resend", active: false, created_at: "2026-01-02T00:00:00.000Z" }),
        prov({ id: "sandbox", name: "Sandbox", type: "sandbox", active: true, created_at: "2026-01-03T00:00:00.000Z" }),
      ],
    });

    expect(listActiveProviders().map((provider) => provider.id)).toEqual(["sandbox", "old"]);
    expect(listActiveProviders("resend").map((provider) => provider.id)).toEqual(["old"]);
    expect(listActiveProviders("sandbox").map((provider) => provider.id)).toEqual(["sandbox"]);
  });
});

describe("listActiveProviderSummaries", () => {
  it("lists active providers without credential columns", async () => {
    await stub.seed({
      providers: [
        prov({ id: "old", name: "Old", type: "resend", active: true, secrets: true, created_at: "2026-01-01T00:00:00.000Z" }),
        prov({ id: "inactive", name: "Inactive", type: "ses", region: "us-east-1", active: false, secrets: true, created_at: "2026-01-02T00:00:00.000Z" }),
        prov({ id: "sandbox", name: "Sandbox", type: "sandbox", active: true, created_at: "2026-01-03T00:00:00.000Z" }),
      ],
    });

    const all = listActiveProviderSummaries(undefined, { limit: 10 });
    const sandboxOnly = listActiveProviderSummaries("sandbox");

    expect(all.map((provider) => provider.id)).toEqual(["sandbox", "old"]);
    expect(sandboxOnly.map((provider) => provider.id)).toEqual(["sandbox"]);
    // listActiveProviderSummaries returns the Provider superset: credential
    // columns are present but ALWAYS null. Assert no seeded secret VALUE leaks and
    // that every credential column resolves to null.
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain("re_secret_value");
    expect(serialized).not.toContain("refresh_secret_token");
    expect(serialized).not.toContain("access_secret_token");
    for (const provider of all as Array<Record<string, unknown>>) {
      expect(provider["api_key"] ?? null).toBeNull();
      expect(provider["secret_key"] ?? null).toBeNull();
      expect(provider["oauth_refresh_token"] ?? null).toBeNull();
    }
  });
});

describe("getLatestActiveProvider", () => {
  it("returns the newest active provider, optionally by type", async () => {
    await stub.seed({
      providers: [
        prov({ id: "old", name: "Old", type: "resend", active: true, created_at: "2026-01-01T00:00:00.000Z" }),
        prov({ id: "inactive", name: "Inactive", type: "ses", active: false, created_at: "2026-01-02T00:00:00.000Z" }),
        prov({ id: "latest", name: "Latest", type: "sandbox", active: true, created_at: "2026-01-03T00:00:00.000Z" }),
      ],
    });

    expect(getLatestActiveProvider()?.id).toBe("latest");
    expect(getLatestActiveProvider("resend")?.id).toBe("old");
    expect(getLatestActiveProvider("sandbox")?.id).toBe("latest");
    expect(getLatestActiveProvider("ses")).toBeNull();
  });

  it("returns only the newest active provider id", async () => {
    await stub.seed({
      providers: [
        prov({ id: "old", name: "Old", type: "resend", active: true, secrets: true, created_at: "2026-01-01T00:00:00.000Z" }),
        prov({ id: "latest", name: "Latest", type: "sandbox", active: true, created_at: "2026-01-02T00:00:00.000Z" }),
      ],
    });

    expect(getLatestActiveProviderId()).toBe("latest");
    expect(getLatestActiveProviderId("resend")).toBe("old");
    expect(getLatestActiveProviderId("sandbox")).toBe("latest");
  });
});

describe("updateProvider", () => {
  it("updates name", () => {
    const p = createProvider({ name: "Old", type: "resend" });
    const updated = updateProvider(p.id, { name: "New" });
    expect(updated.name).toBe("New");
  });

  it("updates active status", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const updated = updateProvider(p.id, { active: false });
    expect(updated.active).toBe(false);
  });

  it("throws ProviderNotFoundError for unknown id", () => {
    expect(() => updateProvider("nonexistent", { name: "x" })).toThrow(ProviderNotFoundError);
  });
});

describe("deleteProvider", () => {
  it("deletes a provider", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const deleted = deleteProvider(p.id);
    expect(deleted).toBe(true);
    expect(getProvider(p.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteProvider("nonexistent")).toBe(false);
  });
});

describe("getActiveProvider", () => {
  it("returns the first active provider", () => {
    const p = createProvider({ name: "Active", type: "resend" });
    const active = getActiveProvider();
    expect(active.id).toBe(p.id);
  });

  it("throws ProviderNotFoundError when no active providers", () => {
    expect(() => getActiveProvider()).toThrow(ProviderNotFoundError);
  });
});
