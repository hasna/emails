// Self-hosted-ONLY: the domain repo routes every read/write to `/v1/domains`, so
// these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore — the deleted
// `../../db/database.js` and the previously-embedded stand-in server are gone.
//
// Coverage here is the client-flip contract: `add`/`list`/`remove`/`status`
// route reads AND writes to the self-hosted HTTP API (never a local island), id
// PREFIX resolution scans the /v1 dataset, and the genuinely server-owned
// subcommands (DNS/verify/warm/lifecycle mutations) still fail loud with the
// current source message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerDomainCommands } from "./domain.js";

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

// Blocking subcommands call handleError() -> console.error + process.exit(1).
// Capture both so we can assert the process exits and on the emitted message.
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

async function serverDomains(): Promise<Array<Record<string, unknown>>> {
  return stub.list("domains");
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

describe("domain CLI — self-hosted (self_hosted) /v1 routing", () => {
  it("add writes to the self-hosted API (not a local provider)", async () => {
    const { data } = await runDomainCommand(["domain", "add", "cloudy.example.com", "--provider", "selfHosted"]);
    const entity = data as { id: string; domain: string };
    expect(entity.domain).toBe("cloudy.example.com");
    const remote = await serverDomains();
    expect(remote.map((d) => d["domain"])).toEqual(["cloudy.example.com"]);
  });

  it("list reads from the self-hosted API", async () => {
    await runDomainCommand(["domain", "add", "one.example.com", "--provider", "selfHosted"]);
    await runDomainCommand(["domain", "add", "two.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domain", "list"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain).sort()).toEqual(["one.example.com", "two.example.com"]);
  });

  it("domains list (plural) reads from the self-hosted API instead of blocking", async () => {
    await runDomainCommand(["domain", "add", "alpha.example.com", "--provider", "selfHosted"]);
    await runDomainCommand(["domain", "add", "beta.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domains", "list"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain).sort()).toEqual(["alpha.example.com", "beta.example.com"]);
  });

  it("domains status (no arg) lists via the self-hosted API instead of blocking", async () => {
    await runDomainCommand(["domain", "add", "gamma.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domains", "status"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain)).toEqual(["gamma.example.com"]);
  });

  it("domains status <domain> shows the API record in self_hosted", async () => {
    await runDomainCommand(["domain", "add", "delta.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domains", "status", "delta.example.com"]);
    const rec = data as { domain: string };
    expect(rec.domain).toBe("delta.example.com");
  });

  it("add is idempotent by name against the self-hosted API", async () => {
    await runDomainCommand(["domain", "add", "dup.example.com", "--provider", "selfHosted"]);
    await runDomainCommand(["domain", "add", "dup.example.com", "--provider", "selfHosted"]);
    expect((await serverDomains()).length).toBe(1);
  });

  it("remove deletes from the self-hosted API", async () => {
    await runDomainCommand(["domain", "add", "gone.example.com", "--provider", "selfHosted"]);
    const remote = await serverDomains();
    expect(remote.length).toBe(1);
    const id = remote[0]!["id"] as string;
    await runDomainCommand(["domain", "remove", id, "--yes"]);
    expect((await serverDomains()).length).toBe(0);
  });

  it("resolves an id PREFIX against the self-hosted dataset for remove", async () => {
    await runDomainCommand(["domain", "add", "prefix.example.com", "--provider", "selfHosted"]);
    const remote = await serverDomains();
    const id = remote[0]!["id"] as string;
    // An 8-char prefix must be resolved by listing the self-hosted store — proving
    // reads route to the /v1 API, not a (non-existent) local island.
    await runDomainCommand(["domain", "remove", id.slice(0, 8), "--yes"]);
    expect((await serverDomains()).length).toBe(0);
  });

  it("blocks server-owned domain subcommands with the self-hosted client message", async () => {
    // These have no /v1 equivalent (live DNS/provider orchestration, warming, and
    // the server-owned lifecycle ledger) and must fail loud. Required options are
    // supplied so commander reaches the action rather than erroring on parse.
    const blocked = [
      ["domain", "status"],
      ["domain", "connect", "ex.com", "--provider", "x"],
      ["domain", "dns", "ex.com"],
      ["domain", "verify", "ex.com"],
      ["domain", "check", "ex.com"],
      ["domain", "warm-list"],
      ["domains", "connect", "ex.com", "--provider", "x"],
      ["domains", "dns", "ex.com"],
      ["domains", "verify", "ex.com"],
      ["domains", "check", "ex.com"],
      ["domains", "enable-inbound", "ex.com"],
      ["domains", "enable-outbound", "ex.com"],
      ["domains", "disable-outbound", "ex.com"],
    ];
    for (const args of blocked) {
      const result = await runDomainCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("is not available in the self-hosted client");
      expect(result.stderr).toContain("it runs on the self-hosted server");
    }
    // None of the blocked reads/writes reached the store.
    expect((await serverDomains()).length).toBe(0);
  });

  it("domain adopt cannot run in the bare self-hosted client without a resolvable provider", async () => {
    // adopt is an operator command that resolves a provider from /v1/providers and
    // then wires live SES/S3. With no provider present it fails loud at resolution
    // instead of silently no-oping.
    const result = await runDomainCommandExpectingExit(["domain", "adopt", "example.com", "--provider", "ses-provider"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("Could not resolve ID");
    expect(result.stderr).toContain("providers");
  });
});
