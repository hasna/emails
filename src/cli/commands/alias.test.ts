// Self-hosted-ONLY: the alias repo routes every read/write to `/v1/aliases`, so
// these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createAlias, ensureDefaultCatchAll } from "../../db/aliases.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerAliasCommands } from "./alias.js";

let stub: V1Stub;

async function runAliasCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAliasCommands(program, (d, formatted) => {
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

describe("alias list command", () => {
  it("paginates aliases for human and structured output", async () => {
    ensureDefaultCatchAll();
    createAlias("b@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const result = await runAliasCommand(["alias", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(result.out).toContain("a@x.com");
    expect(result.out).not.toContain("*@*");
  });

  it("paginates domain-filtered aliases", async () => {
    createAlias("c@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("b@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const result = await runAliasCommand(["alias", "list", "--domain", "x.com", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "b@x.com",
      "c@x.com",
    ]);
    expect(result.out).not.toContain("a@y.com");
  });

  it("routes add/resolve/remove through the /v1 API", async () => {
    const created = await runAliasCommand(["alias", "add", "hello@acme.com", "ops@acme.com"]);
    const alias = created.data as { id: string; target_address: string };
    expect(alias.target_address).toBe("ops@acme.com");
    expect((await stub.list("aliases")).map((a) => a["local_part"])).toContain("hello");

    const resolved = await runAliasCommand(["alias", "resolve", "hello@acme.com"]);
    expect(resolved.data).toEqual({ recipient: "hello@acme.com", target: "ops@acme.com" });

    await runAliasCommand(["alias", "remove", alias.id]);
    expect((await stub.list("aliases")).some((a) => a["id"] === alias.id)).toBe(false);
  });
});
