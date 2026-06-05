import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createAddress } from "../../db/addresses.js";
import { createOwner } from "../../db/owners.js";
import { registerAddressCommands } from "./address.js";

async function runAddressCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAddressCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("address ownership commands", () => {
  it("shows and assigns an agent owner by address email", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createAddress({ provider_id: provider.id, email: "ops@example.com" });
    createOwner({ type: "agent", name: "cli-agent" });

    const set = await runAddressCommand(["address", "set-owner", "ops@example.com", "--owner", "cli-agent"]);
    expect(set.out).toContain("owned by cli-agent");
    expect(set.data).toMatchObject({ address: { email: "ops@example.com", owner: { name: "cli-agent" } } });

    const owner = await runAddressCommand(["address", "owner", "ops@example.com"]);
    expect(owner.out).toContain("Owner:");
    expect(owner.data).toMatchObject({ address: { owner: { name: "cli-agent" } } });
  });

  it("enriches address list output with owner and administrator", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = createAddress({ provider_id: provider.id, email: "human@example.com" });
    const human = createOwner({ type: "human", name: "human-user" });
    const agent = createOwner({ type: "agent", name: "support-agent" });
    getDatabase().run("UPDATE addresses SET owner_id = ?, administrator_id = ? WHERE id = ?", [human.id, agent.id, address.id]);

    const list = await runAddressCommand(["address", "list"]);
    expect(list.out).toContain("owner human-user (human)");
    expect(list.out).toContain("admin support-agent");
    expect(list.data).toMatchObject([{ email: "human@example.com", owner: { name: "human-user" }, administrator: { name: "support-agent" } }]);
  });

  it("transfers, unassigns, and shows ownership history", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createAddress({ provider_id: provider.id, email: "move@example.com" });
    createOwner({ type: "agent", name: "first-agent" });
    createOwner({ type: "agent", name: "second-agent" });

    await runAddressCommand(["address", "set-owner", "move@example.com", "--owner", "first-agent"]);

    const transfer = await runAddressCommand([
      "address", "transfer-owner", "move@example.com",
      "--owner", "second-agent",
      "--reason", "handoff",
      "--actor", "test",
      "--yes",
    ]);
    expect(transfer.out).toContain("transferred to second-agent");
    expect(transfer.data).toMatchObject({ address: { owner: { name: "second-agent" } } });

    const unassign = await runAddressCommand([
      "address", "unassign-owner", "move@example.com",
      "--reason", "retired",
      "--actor", "test",
      "--yes",
    ]);
    expect(unassign.out).toContain("is now unowned");
    expect(unassign.data).toMatchObject({ address: { owner: null, administrator: null } });

    const history = await runAddressCommand(["address", "owner-history", "move@example.com"]);
    expect(history.out).toContain("Ownership history");
    expect(history.out).toContain("unassign");
    expect(history.out).toContain("transfer");
    expect(history.data).toMatchObject({
      history: [
        { action: "unassign", reason: "retired", actor: "test" },
        { action: "transfer", reason: "handoff", actor: "test" },
        { action: "assign" },
      ],
    });
  });
});
