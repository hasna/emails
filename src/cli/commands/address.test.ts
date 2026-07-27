// Self-hosted-ONLY: the address repo routes every read/write to `/v1/addresses`,
// so these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore. Ownership routes
// over /v1 too (`/v1/owners`, owner_id/administrator_id on `/v1/addresses/<id>`,
// `/v1/address-ownership-events`) and is covered below. Only the local
// provisioning orchestration is server-owned and still fails loud.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createAddress } from "../../db/addresses.js";
import { assignAddressOwner, createOwner } from "../../db/owners.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerAddressCommands } from "./address.js";

let stub: V1Stub;

async function runAddressCommand(args: string[]) {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = ((message?: unknown) => { logs.push(String(message ?? "")); }) as typeof console.log;
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAddressCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: [...logs, ...out].join("\n") };
  } finally {
    console.log = originalLog;
  }
}

// Some address subcommands are owned by the self-hosted server and fail loud in
// the client. handleError() logs to console.error then process.exit(1); stub both
// so the exit becomes observable instead of tearing down the test runner.
async function runAddressCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runAddressCommand(args);
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
});
afterEach(() => stub.clearEnv());

describe("address list command", () => {
  it("uses a compact implicit default and honors explicit limits", async () => {
    const addresses = [];
    for (let i = 1; i <= 25; i++) {
      const stamp = `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`;
      addresses.push({
        id: crypto.randomUUID(),
        email: `bulk-${String(i).padStart(2, "0")}@example.com`,
        provider_id: "prov-1",
        status: "active",
        verified: false,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    await stub.seed({ addresses });

    const compact = await runAddressCommand(["address", "list", "--provider", "prov-1"]);
    expect(compact.data).toHaveLength(20);
    expect(compact.out).toContain("use --verbose");
    expect(compact.out).toContain("--offset 20");

    const explicit = await runAddressCommand(["address", "list", "--provider", "prov-1", "--limit", "25"]);
    expect(explicit.data).toHaveLength(25);
  });

  it("paginates enriched address output", async () => {
    const addresses = [];
    for (let i = 1; i <= 4; i++) {
      const stamp = `2026-01-0${i}T00:00:00.000Z`;
      addresses.push({
        id: crypto.randomUUID(),
        email: `addr-${i}@example.com`,
        provider_id: "prov-1",
        status: "active",
        verified: false,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    await stub.seed({ addresses });

    const result = await runAddressCommand([
      "address", "list",
      "--provider", "prov-1",
      "--limit", "2",
      "--offset", "1",
    ]);

    expect(result.out).toContain("addr-3@example.com");
    expect(result.out).toContain("addr-2@example.com");
    expect(result.out).not.toContain("addr-4@example.com");
    expect(result.data).toMatchObject([
      { email: "addr-3@example.com" },
      { email: "addr-2@example.com" },
    ]);
  });

  it("reports an empty configuration", async () => {
    const result = await runAddressCommand(["address", "list"]);
    expect(result.data).toEqual([]);
    expect(result.out).toContain("No addresses configured.");
  });
});

describe("address add / verify / suggest commands", () => {
  it("adds a sender address through the /v1 API", async () => {
    const added = await runAddressCommand(["address", "add", "ops@example.com", "--provider", "prov-1", "--name", "Ops"]);
    expect(added.out).toContain("Address added: ops@example.com");
    expect((added.data as { email: string }).email).toBe("ops@example.com");
    expect((await stub.list("addresses")).map((a) => a["email"])).toContain("ops@example.com");

    // Adding the same email again is idempotent (dedup by email over /v1).
    const again = await runAddressCommand(["address", "add", "ops@example.com", "--provider", "prov-1"]);
    expect(again.out).toContain("already exists");
    expect((await stub.list("addresses")).filter((a) => a["email"] === "ops@example.com")).toHaveLength(1);
  });

  it("reports verification status from the /v1 record", async () => {
    await stub.seed({
      addresses: [
        { id: crypto.randomUUID(), email: "verified@example.com", verified: true, status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: crypto.randomUUID(), email: "pending@example.com", verified: false, status: "active", created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const verified = await runAddressCommand(["address", "verify", "verified@example.com"]);
    expect(verified.out).toContain("verified@example.com is verified");

    const pending = await runAddressCommand(["address", "verify", "pending@example.com"]);
    expect(pending.out).toContain("pending@example.com is not yet verified");
  });

  it("suggests unused local parts for a domain", async () => {
    createAddress({ provider_id: "prov-1", email: "hello@example.com" });
    createAddress({ provider_id: "prov-1", email: "support@example.com" });

    const result = await runAddressCommand(["address", "suggest", "--domain", "Example.com"]);

    expect(result.out).not.toContain("hello@example.com");
    expect(result.out).not.toContain("support@example.com");
    expect(result.out).toContain("hi@example.com");
    expect(result.data).toMatchObject({
      domain: "example.com",
      suggestions: expect.arrayContaining(["hi@example.com"]),
    });
  });
});

describe("address remove / lifecycle commands", () => {
  it("removes a sender address resolved by id prefix", async () => {
    const id = "rm000000-1111-2222-3333-444444444444";
    await stub.seed({
      addresses: [{ id, email: "gone@example.com", status: "active", verified: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    });

    const result = await runAddressCommand(["address", "remove", "rm000000", "--yes"]);
    expect(result.out).toContain("Address removed: gone@example.com");
    expect((await stub.list("addresses")).some((a) => a["id"] === id)).toBe(false);
  });

  it("suspends, activates, and sets a daily quota via /v1 PATCH", async () => {
    const id = crypto.randomUUID();
    await stub.seed({
      addresses: [{ id, email: "svc@example.com", status: "active", verified: true, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    });

    const suspended = await runAddressCommand(["address", "suspend", id]);
    expect(suspended.out).toContain("Suspended svc@example.com");
    expect((suspended.data as { status: string }).status).toBe("suspended");

    const activated = await runAddressCommand(["address", "activate", id]);
    expect(activated.out).toContain("Activated svc@example.com");
    expect((activated.data as { status: string }).status).toBe("active");

    const quota = await runAddressCommand(["address", "quota", id, "10"]);
    expect(quota.out).toContain("Daily quota for svc@example.com: 10/day");
    expect((quota.data as { daily_quota: number | null }).daily_quota).toBe(10);

    const cleared = await runAddressCommand(["address", "quota", id, "none"]);
    expect(cleared.out).toContain("Cleared daily quota for svc@example.com");
    expect((cleared.data as { daily_quota: number | null }).daily_quota).toBeNull();
  });
});

describe("address server-only lifecycle commands still block", () => {
  // Only the local provisioning orchestration (S3/SES receive setup + the
  // provisioning ledger) is server-owned. Ownership is NOT — see below.
  const blocked: Array<[string, string[]]> = [
    ["emails address provision", ["address", "provision", "svc@example.com", "--provider", "prov-1"]],
  ];

  for (const [label, args] of blocked) {
    it(`${label} says it is unimplemented and names what to run instead`, async () => {
      const result = await runAddressCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(`${label} is not implemented in this build`);
      expect(result.stderr).toContain("emails address add <email> --provider <id>");
      // The message that shipped named a server route that does not exist, and
      // named it unconditionally — so it lied in local mode too.
      expect(result.stderr).not.toContain("not available in the self-hosted client");
      expect(result.stderr).not.toContain("runs on the self-hosted server");
    });
  }
});

describe("address ownership commands over /v1", () => {
  async function seedOwnedAddress() {
    const address = createAddress({ provider_id: "prov-1", email: "svc@example.com" });
    const human = createOwner({ type: "human", name: "ada" });
    const agent = createOwner({ type: "agent", name: "ops-bot" });
    return { address, human, agent };
  }

  it("set-owner assigns owner + administrator and persists them on the /v1 address", async () => {
    const { address, human, agent } = await seedOwnedAddress();

    const result = await runAddressCommand([
      "address", "set-owner", "svc@example.com", "--owner", "ada", "--administrator", "ops-bot",
    ]);

    expect(result.out).toContain("svc@example.com owned by ada (human), administered by ops-bot");
    expect(result.data).toMatchObject({
      address: { email: "svc@example.com", owner: { id: human.id, name: "ada" }, administrator: { id: agent.id, name: "ops-bot" } },
      ownership: { owner_id: human.id, owner_type: "human", administrator_id: agent.id },
    });

    const stored = (await stub.list("addresses")).find((a) => a["id"] === address.id);
    expect(stored).toMatchObject({ owner_id: human.id, administrator_id: agent.id });
  });

  it("owner reports the assigned owner and administrator", async () => {
    const { human, agent } = await seedOwnedAddress();
    await runAddressCommand(["address", "set-owner", "svc@example.com", "--owner", "ada", "--administrator", "ops-bot"]);

    const result = await runAddressCommand(["address", "owner", "svc@example.com"]);

    expect(result.out).toContain("Owner:    ada (human)");
    expect(result.out).toContain("Admin:    ops-bot (agent)");
    expect(result.data).toMatchObject({
      address: { owner: { id: human.id }, administrator: { id: agent.id } },
      ownership: { owner_id: human.id, administrator_id: agent.id },
    });
  });

  it("transfer-owner records the new owner plus an audit event", async () => {
    await seedOwnedAddress();
    createOwner({ type: "agent", name: "successor-bot" });
    await runAddressCommand(["address", "set-owner", "svc@example.com", "--owner", "ada", "--administrator", "ops-bot"]);

    const result = await runAddressCommand([
      "address", "transfer-owner", "svc@example.com", "--owner", "successor-bot", "--reason", "handoff", "--yes",
    ]);

    expect(result.out).toContain("svc@example.com transferred — owned by successor-bot (agent)");
    const events = await stub.list("address-ownership-events");
    expect(events.map((e) => e["action"])).toContain("transfer");
    expect(events.find((e) => e["action"] === "transfer")).toMatchObject({ reason: "handoff" });
  });

  it("unassign-owner clears ownership on the /v1 address", async () => {
    const { address } = await seedOwnedAddress();
    await runAddressCommand(["address", "set-owner", "svc@example.com", "--owner", "ada", "--administrator", "ops-bot"]);

    const result = await runAddressCommand([
      "address", "unassign-owner", "svc@example.com", "--reason", "retired", "--yes",
    ]);

    expect(result.out).toContain("svc@example.com is now unowned");
    const stored = (await stub.list("addresses")).find((a) => a["id"] === address.id);
    expect(stored?.["owner_id"] ?? null).toBeNull();
    expect(stored?.["administrator_id"] ?? null).toBeNull();
  });

  it("owner-history lists the audit trail newest first", async () => {
    await seedOwnedAddress();
    await runAddressCommand(["address", "set-owner", "svc@example.com", "--owner", "ada", "--administrator", "ops-bot"]);
    await runAddressCommand(["address", "unassign-owner", "svc@example.com", "--reason", "retired", "--yes"]);

    const result = await runAddressCommand(["address", "owner-history", "svc@example.com"]);

    const history = (result.data as { history: Array<{ action: string; reason: string | null }> }).history;
    expect(history.map((e) => e.action)).toEqual(["unassign", "assign"]);
    expect(result.out).toContain("unassign");
    expect(result.out).toContain("retired");
  });

  it("owner-history reports an empty trail truthfully", async () => {
    await seedOwnedAddress();

    const result = await runAddressCommand(["address", "owner-history", "svc@example.com"]);

    expect(result.out).toContain("No ownership changes recorded.");
    expect((result.data as { history: unknown[] }).history).toEqual([]);
  });

  it("set-owner refuses a human owner without an agent administrator", async () => {
    await seedOwnedAddress();

    const result = await runAddressCommandExpectingExit(["address", "set-owner", "svc@example.com", "--owner", "ada"]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("human-owned address requires an agent administrator");
  });
});

describe("address list reports real ownership", () => {
  it("hydrates owner/administrator in the table and in --json", async () => {
    const address = createAddress({ provider_id: "prov-1", email: "owned@example.com" });
    const human = createOwner({ type: "human", name: "ada" });
    const agent = createOwner({ type: "agent", name: "ops-bot" });
    assignAddressOwner(address.id, human.id, agent.id);

    const result = await runAddressCommand(["address", "list"]);

    expect(result.data).toMatchObject([
      { email: "owned@example.com", owner: { id: human.id, name: "ada" }, administrator: { id: agent.id, name: "ops-bot" } },
    ]);
    expect(result.out).toContain("ada:ops-bot");
  });

  it("--verbose shows owner and administrator instead of ignoring the flag", async () => {
    const address = createAddress({ provider_id: "prov-1", email: "owned@example.com" });
    const human = createOwner({ type: "human", name: "ada" });
    const agent = createOwner({ type: "agent", name: "ops-bot" });
    assignAddressOwner(address.id, human.id, agent.id);

    const result = await runAddressCommand(["address", "list", "--verbose"]);

    expect(result.out).toContain("owner ada (human)");
    expect(result.out).toContain("admin ops-bot");
  });

  it("shows an unowned address as unowned", async () => {
    createAddress({ provider_id: "prov-1", email: "free@example.com" });

    const result = await runAddressCommand(["address", "list"]);

    expect(result.data).toMatchObject([{ email: "free@example.com", owner: null, administrator: null }]);
  });
});
