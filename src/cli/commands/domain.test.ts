// Self-hosted-ONLY: the domain repo routes every read/write to `/v1/domains`
// (and providers to `/v1/providers`), so these tests drive the REAL command
// against an out-of-process /v1 stub (see src/test-support/v1-stub.ts). The
// deleted `../../db/database.js` and all local-SQLite seeding are gone.
//
// What is covered here (command-level behaviour on top of /v1):
//   - `domain add` / `domains add` dry-run planning (no mutation)
//   - `domain buy` Route 53 contact normalization (pure @hasna/domains, mocked)
//   - `domain list` and `domain usable` pagination/filtering over /v1
//   - `domain move-provider` writing through /v1 (server owns address moves)
//   - the previously-local commands that now fail loud (server-owned)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerDomainCommands } from "./domain.js";

const mockR53CheckAvailability = mock(async (domain: string) => ({
  domain,
  available: true,
  price: "12",
  currency: "USD",
}));
const mockR53RegisterDomain = mock(async () => ({ operationId: "op-123" }));

mock.module("@hasna/domains", () => ({
  r53CheckAvailability: mockR53CheckAvailability,
  r53RegisterDomain: mockR53RegisterDomain,
}));

let stub: V1Stub;

async function runDomainCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDomainCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

// Server-owned subcommands call handleError() -> console.error + process.exit(1).
async function runDomainCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runDomainCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  mockR53CheckAvailability.mockReset();
  mockR53CheckAvailability.mockImplementation(async (domain: string) => ({
    domain,
    available: true,
    price: "12",
    currency: "USD",
  }));
  mockR53RegisterDomain.mockReset();
  mockR53RegisterDomain.mockImplementation(async () => ({ operationId: "op-123" }));
});
afterEach(() => stub.clearEnv());

describe("domain add command", () => {
  it("supports dry-run without mutating domain state", async () => {
    const result = await runDomainCommand(["domain", "add", "example.com", "--provider", "sandbox", "--dry-run"]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider_id: "sandbox",
      would_create_domain: true,
      // The self-hosted client never calls a provider adapter — the /v1 API owns creation.
      would_call_provider: false,
    });
    expect(await stub.list("domains")).toHaveLength(0);
  });
});

describe("domain buy command", () => {
  it("omits Route53 contact state for Romania even when --state is provided", async () => {
    await runDomainCommand([
      "domain", "buy", "example.ro",
      "--email", "owner@example.com",
      "--first-name", "Mika",
      "--last-name", "Paper",
      "--phone", "+40.123456789",
      "--address", "Main 1",
      "--city", "Bucuresti",
      "--state", "Bucuresti",
      "--country", "RO",
      "--zip", "010101",
    ]);

    const contact = mockR53RegisterDomain.mock.calls[0]?.[1] as { state?: string; country_code?: string };
    expect(contact.country_code).toBe("RO");
    expect("state" in contact).toBe(false);
  });

  it("allows domain purchase without --state and preserves it for countries that accept it", async () => {
    await runDomainCommand([
      "domain", "buy", "example.com",
      "--email", "owner@example.com",
      "--first-name", "Mika",
      "--last-name", "Paper",
      "--phone", "+1.5551234567",
      "--address", "Main 1",
      "--city", "Seattle",
      "--country", "US",
      "--zip", "98101",
    ]);
    expect(mockR53RegisterDomain.mock.calls[0]?.[1]).not.toHaveProperty("state");

    mockR53RegisterDomain.mockClear();
    await runDomainCommand([
      "domain", "buy", "example.net",
      "--email", "owner@example.com",
      "--first-name", "Mika",
      "--last-name", "Paper",
      "--phone", "+1.5551234567",
      "--address", "Main 1",
      "--city", "Seattle",
      "--state", "WA",
      "--country", "US",
      "--zip", "98101",
    ]);
    expect(mockR53RegisterDomain.mock.calls[0]?.[1]).toMatchObject({ state: "WA", country_code: "US" });
  });
});

describe("domain list command", () => {
  it("paginates domain output from /v1", async () => {
    await stub.seed({
      domains: [1, 2, 3, 4].map((i) => ({
        id: `dom-${i}`,
        domain: `domain-${i}.example.com`,
        provider: "sandbox",
        verified: false,
        created_at: `2026-01-0${i}T00:00:00.000Z`,
      })),
    });

    const result = await runDomainCommand([
      "domain", "list",
      "--provider", "sandbox",
      "--limit", "2",
      "--offset", "1",
    ]);

    // Newest-first ordering: 4, 3, 2, 1 -> offset 1, limit 2 -> 3, 2.
    expect(result.out).toContain("domain-3.example.com");
    expect(result.out).toContain("domain-2.example.com");
    expect(result.out).not.toContain("domain-4.example.com");
    expect(result.data).toMatchObject([
      { domain: "domain-3.example.com" },
      { domain: "domain-2.example.com" },
    ]);
  });
});

describe("domains lifecycle commands", () => {
  it("supports plural add dry-run without mutating state", async () => {
    const result = await runDomainCommand([
      "domains", "add", "example.com",
      "--provider", "sandbox",
      "--source-of-truth", "postgres",
      "--dry-run",
    ]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider_id: "sandbox",
      source_of_truth: "postgres",
      would_create_domain: true,
      cli_equivalent: "emails domains add example.com --provider sandbox",
    });
    expect(await stub.list("domains")).toHaveLength(0);
  });

  it("fails loud on server-owned lifecycle mutations", async () => {
    for (const args of [
      ["domains", "connect", "owned.example.com", "--provider", "x"],
      ["domains", "enable-inbound", "ready.example.com"],
      ["domains", "enable-outbound", "ready.example.com"],
      ["domains", "disable-outbound", "ready.example.com"],
    ]) {
      const result = await runDomainCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("is not available in the self-hosted client");
    }
  });
});

describe("domain move-provider command", () => {
  it("moves a domain to another provider through /v1 (server owns address moves)", async () => {
    await stub.seed({
      providers: [
        { id: "prov-source", name: "ses-sandbox", type: "ses", region: "us-east-1", active: true },
        { id: "prov-target", name: "ses-production", type: "ses", region: "us-east-1", active: true },
      ],
      domains: [
        { id: "dom-1", domain: "example.com", provider: "prov-source", verified: false },
      ],
    });

    const result = await runDomainCommand([
      "domain", "move-provider", "example.com",
      "--from-provider", "prov-source",
      "--to-provider", "prov-target",
      "--yes",
    ]);

    expect(result.data).toMatchObject({
      domain: { provider_id: "prov-target", domain: "example.com" },
      to_provider_name: "ses-production",
      moved_addresses: 0,
    });
    // The write reached /v1: the stored row now points at the new provider.
    const stored = (await stub.list("domains")).find((d) => d["id"] === "dom-1");
    expect(stored?.["provider"]).toBe("prov-target");
  });
});

describe("domain status command", () => {
  it("fails loud — readiness is served by the self-hosted operator API", async () => {
    const result = await runDomainCommandExpectingExit(["domain", "status"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails domain status is not available in the self-hosted client");
  });
});

describe("domain usable command", () => {
  it("paginates verified domains from /v1", async () => {
    await stub.seed({
      domains: [1, 2, 3, 4].map((i) => ({
        id: `use-${i}`,
        domain: `usable-${i}.example.com`,
        provider: "ses",
        verified: true,
        created_at: `2026-01-0${i}T00:00:00.000Z`,
      })),
    });

    const result = await runDomainCommand(["domain", "usable", "--send", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("usable-3.example.com");
    expect(result.out).toContain("usable-2.example.com");
    expect(result.out).not.toContain("usable-4.example.com");
    expect(result.data).toMatchObject([
      { domain: "usable-3.example.com" },
      { domain: "usable-2.example.com" },
    ]);
  });

  it("filters by provider label", async () => {
    await stub.seed({
      domains: [
        { id: "d1", domain: "first.example.com", provider: "first-ses", verified: true, created_at: "2026-01-01T00:00:00.000Z" },
        { id: "d2", domain: "second.example.com", provider: "second-ses", verified: true, created_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const result = await runDomainCommand(["domain", "usable", "--provider", "first-ses"]);

    expect(result.out).toContain("first.example.com");
    expect(result.out).not.toContain("second.example.com");
    expect(result.data).toMatchObject([
      { domain: "first.example.com", provider_id: "first-ses" },
    ]);
  });
});

describe("domain warm-list command", () => {
  it("fails loud — warming schedules live on the self-hosted server", async () => {
    const result = await runDomainCommandExpectingExit(["domain", "warm-list"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails domain warm-list is not available in the self-hosted client");
  });
});
