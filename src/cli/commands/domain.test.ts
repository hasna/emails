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
//   - `domain warm-list` reading the /v1 `warming` resource
//   - the genuinely server-owned commands that fail loud (live DNS/provider
//     orchestration and the lifecycle-readiness ledger)
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
      "--dry-run",
    ]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider_id: "sandbox",
      // Reported, not requested: the client always creates `/v1`-owned domains.
      source_of_truth: "postgres",
      would_create_domain: true,
      cli_equivalent: "emails domains add example.com --provider sandbox",
    });
    expect(await stub.list("domains")).toHaveLength(0);
  });

  // The flag was declared on all four of these and read by nothing: the action
  // reports a hardcoded "postgres". Commander now rejects it, so the CLI can no
  // longer accept an input it silently discards.
  it("rejects --source-of-truth instead of silently discarding it", async () => {
    for (const command of ["add", "connect"]) {
      for (const noun of ["domain", "domains"]) {
        await expect(runDomainCommand([
          noun, command, "example.com", "--provider", "sandbox", "--source-of-truth", "postgres",
        ])).rejects.toThrow(/unknown option '--source-of-truth'/);
      }
    }
  });

  it("fails loud on lifecycle mutations that do not ship, naming a real next step", async () => {
    for (const args of [
      ["domains", "connect", "owned.example.com", "--provider", "x"],
      ["domains", "enable-inbound", "ready.example.com"],
      ["domains", "enable-outbound", "ready.example.com"],
      ["domains", "disable-outbound", "ready.example.com"],
    ]) {
      const result = await runDomainCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("is not implemented in this build");
      // Every refusal has to leave the operator somewhere to go, and the old
      // one-line message left them with a server that has no such route.
      expect(result.stderr).toMatch(/'emails [a-z]/);
      expect(result.stderr).not.toContain("not available in the self-hosted client");
      expect(result.stderr).not.toContain("runs on the self-hosted server");
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
  // The refusal that was reaching `next_actions` via the status payload. It now
  // says what is missing (nothing is wired to the readiness ledger) and points at
  // two commands that run, instead of at a server route that does not exist.
  it("fails loud without blaming a mode, and names commands that run", async () => {
    const result = await runDomainCommandExpectingExit(["domain", "status"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails domain status is not implemented in this build");
    expect(result.stderr).toContain("emails domains status [domain]");
    expect(result.stderr).toContain("emails domain check <domain>");
    expect(result.stderr).not.toContain("not available in the self-hosted client");
  });
});

describe("domain dns command", () => {
  // `domain dns` and `domain check` were unconditional refusals whose entire
  // implementation already shipped in src/lib/dns.ts and src/lib/dns-check.ts —
  // pure, tested, mode-free code that no command reached. `dns` resolves nothing
  // over the network, so it is asserted here; `check` is asserted live in
  // src/cli/unshipped-surface.test.ts.
  it("returns the generic SPF/DMARC pair when no provider resolves", async () => {
    const result = await runDomainCommand(["domain", "dns", "unregistered.example.com"]);
    expect(result.data).toMatchObject({
      domain: "unregistered.example.com",
      provider_id: null,
      records: [
        { purpose: "SPF", type: "TXT", name: "unregistered.example.com" },
        { purpose: "DMARC", type: "TXT", name: "_dmarc.unregistered.example.com" },
      ],
    });
    // Silently omitting DKIM would read as "no DKIM required", so say it.
    expect(result.out).toContain("No provider resolved");
    expect(result.out).toContain("Pass --provider <id> to include the provider's DKIM records.");
  });

  it("refuses an unresolvable --provider instead of falling back to generic records", async () => {
    const result = await runDomainCommandExpectingExit([
      "domain", "dns", "example.com", "--provider", "does-not-exist",
    ]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).not.toContain("v=spf1");
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
  it("lists warming schedules from /v1 with --status filtering and pagination", async () => {
    await stub.seed({
      warming: [1, 2, 3].map((i) => ({
        id: `warm-${i}`,
        domain: `warm-${i}.example.com`,
        provider_id: null,
        target_daily_volume: 100 * i,
        start_date: "2026-01-01",
        status: i === 3 ? "paused" : "active",
        created_at: `2026-01-0${i}T00:00:00.000Z`,
        updated_at: `2026-01-0${i}T00:00:00.000Z`,
      })),
    });

    const all = await runDomainCommand(["domain", "warm-list"]);
    // Newest-first, exactly like every other /v1-backed list command.
    expect((all.data as Array<{ domain: string }>).map((row) => row.domain)).toEqual([
      "warm-3.example.com",
      "warm-2.example.com",
      "warm-1.example.com",
    ]);
    expect(all.out).toContain("warm-1.example.com");
    expect(all.out).toContain("Showing 3 warming schedules");

    const active = await runDomainCommand(["domain", "warm-list", "--status", "active"]);
    expect((active.data as Array<{ domain: string }>).map((row) => row.domain)).toEqual([
      "warm-2.example.com",
      "warm-1.example.com",
    ]);

    const page = await runDomainCommand(["domain", "warm-list", "--limit", "1", "--offset", "1"]);
    expect((page.data as Array<{ domain: string }>).map((row) => row.domain)).toEqual(["warm-2.example.com"]);
  });

  it("rejects an unknown --status instead of returning everything", async () => {
    const result = await runDomainCommandExpectingExit(["domain", "warm-list", "--status", "warming"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("Invalid --status 'warming'");
  });
});
