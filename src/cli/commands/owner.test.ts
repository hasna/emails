// Self-hosted-ONLY: owners route to `/v1/owners` and address ownership fields are
// patched on `/v1/addresses`, so these tests drive the REAL command against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts). No local SQLite
// exists anymore.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createAddress } from "../../db/addresses.js";
import { createOwner, assignAddressOwner } from "../../db/owners.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerOwnerCommands } from "./owner.js";

let stub: V1Stub;

async function runOwnerCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerOwnerCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
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

describe("owner commands", () => {
  it("paginates owner list output", async () => {
    const owners = [];
    for (let i = 0; i < 5; i++) {
      const stamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      owners.push({
        id: crypto.randomUUID(),
        type: "agent",
        name: `owner-${i}`,
        contact_email: null,
        external_id: null,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    await stub.seed({ owners });

    const result = await runOwnerCommand(["owner", "list", "--type", "agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string }>;

    expect(data.map((owner) => owner.name)).toEqual(["owner-3", "owner-2"]);
    expect(result.out).toContain("owner-3");
    expect(result.out).not.toContain("owner-4");
  });

  it("lists owned addresses with owner and administrator ids", async () => {
    const human = createOwner({ type: "human", name: "human-user" });
    const agent = createOwner({ type: "agent", name: "agent-admin" });
    const address = createAddress({ provider_id: "prov-1", email: "human@example.com" });
    assignAddressOwner(address.id, human.id, agent.id);

    const result = await runOwnerCommand(["owner", "addresses", "human-user"]);

    expect(result.out).toContain("human-user owns");
    expect(result.out).toContain("human@example.com");
    expect(result.out).toContain(`owner=${human.id.slice(0, 8)}`);
    expect(result.out).toContain(`admin=${agent.id.slice(0, 8)}`);
    expect(result.data).toMatchObject([
      {
        email: "human@example.com",
        owner_id: human.id,
        administrator_id: agent.id,
      },
    ]);
  });

  it("paginates owner addresses", async () => {
    const agentId = crypto.randomUUID();
    const addresses = [];
    for (let i = 0; i < 5; i++) {
      const stamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      addresses.push({
        id: crypto.randomUUID(),
        email: `paged-${i}@example.com`,
        provider_id: "prov-1",
        status: "active",
        verified: false,
        owner_id: agentId,
        administrator_id: agentId,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    await stub.seed({
      owners: [
        { id: agentId, type: "agent", name: "paged-owner", contact_email: null, external_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      ],
      addresses,
    });

    const result = await runOwnerCommand(["owner", "addresses", "paged-owner", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ email: string }>;

    expect(data.map((address) => address.email)).toEqual([
      "paged-3@example.com",
      "paged-2@example.com",
    ]);
    expect(result.out).not.toContain("paged-4@example.com");
  });
});
