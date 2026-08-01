// SELECTORS THE CLI PRINTS BUT REFUSES TO ACCEPT (task 55c19dde).
//
// Every list in this CLI displays 8-character id prefixes, and several verbs
// also accept human selectors (an address's email, a domain's name) — but the
// remove/revoke/mutate verbs of six families refused exactly those selectors:
//
//  * `alias remove <8-char id>` and `alias remove <alias address>` — not found;
//    only the full UUID worked, and the full UUID is only visible via --json.
//  * `sendkey revoke <8-char id>` — not found.
//  * `sequence step remove <8-char id>` — not found, and the full id was
//    UNOBTAINABLE: `step add` prints the short id and `step list --json`
//    emitted prose lines, so the command was unusable from the CLI.
//  * `domain remove <domain-name>` — not found, though every sibling domain
//    verb takes the name.
//  * `address remove|activate|quota <email>` — not found/could-not-resolve,
//    though sibling address verbs accept the email.
//
// A CLI that prints a handle must accept that handle back.
//
// Subprocess harness (temp HOME/SQLite, env scrubbed BY PREFIX — enumerating
// this package's env keys here would add references the mode-axis ratchet
// counts).

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRUBBED_ENV_PREFIXES = ["EMAILS_", "HASNA_EMAILS_", "MAILERY_", "HASNA_MAILERY_"] as const;
const SCRUBBED_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "RESEND_API_KEY",
] as const;

const tempDirs: string[] = [];

function localEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-selector-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete base[key];
  }
  for (const key of SCRUBBED_ENV_KEYS) delete base[key];
  return { ...base, EMAILS_DB_PATH: join(dir, "emails.db"), HOME: homePath, NO_COLOR: "1" };
}

interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): CliRun {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function ok(run: CliRun, what: string): CliRun {
  expect(run.exitCode, `${what} failed: ${run.stderr}\n${run.stdout}`).toBe(0);
  return run;
}

function rows(run: CliRun, what: string): Array<Record<string, unknown>> {
  return JSON.parse(ok(run, what).stdout) as Array<Record<string, unknown>>;
}

function seedProvider(env: NodeJS.ProcessEnv): string {
  ok(runCli(["--json", "provider", "add", "--name", "selector-sandbox", "--type", "sandbox"], env), "provider add");
  const providers = rows(runCli(["--json", "provider", "list"], env), "provider list");
  const provider = providers.find((row) => row["name"] === "selector-sandbox");
  expect(provider, "seed provider missing").toBeDefined();
  return String((provider as Record<string, unknown>)["id"]);
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("alias remove accepts what alias list prints", () => {
  // The list also carries the protected default catch-all row, so the cases
  // target the alias they created rather than "the only row".
  function aliasRow(env: NodeJS.ProcessEnv, localPart: string): Record<string, unknown> | undefined {
    return rows(runCli(["--json", "alias", "list"], env), "alias list")
      .find((row) => row["local_part"] === localPart);
  }

  it("removes by 8-char id prefix", () => {
    const env = localEnv();
    ok(runCli(["alias", "add", "hello@acme.example", "ops@acme.example"], env), "alias add");
    const added = aliasRow(env, "hello");
    expect(added, "the added alias is not in alias list").toBeDefined();
    const shortId = String(added?.["id"]).slice(0, 8);

    ok(runCli(["alias", "remove", shortId], env), `alias remove ${shortId}`);
    expect(aliasRow(env, "hello")).toBeUndefined();
  }, 120_000);

  it("removes by the alias address", () => {
    const env = localEnv();
    ok(runCli(["alias", "add", "hola@acme.example", "ops@acme.example"], env), "alias add");
    expect(aliasRow(env, "hola"), "the added alias is not in alias list").toBeDefined();

    ok(runCli(["alias", "remove", "hola@acme.example"], env), "alias remove by address");
    expect(aliasRow(env, "hola")).toBeUndefined();
  }, 120_000);
});

describe("sendkey revoke accepts the short id sendkey list prints", () => {
  it("revokes by 8-char id prefix", () => {
    const env = localEnv();
    ok(runCli(["owner", "register", "robot", "--type", "agent"], env), "owner register");
    ok(runCli(["sendkey", "create", "robot"], env), "sendkey create");
    const keys = rows(runCli(["--json", "sendkey", "list"], env), "sendkey list");
    const shortId = String(keys[0]?.["id"]).slice(0, 8);

    ok(runCli(["sendkey", "revoke", shortId], env), `sendkey revoke ${shortId}`);
    const after = rows(runCli(["--json", "sendkey", "list"], env), "sendkey list after");
    expect(after[0]?.["revoked_at"], "the key must actually be revoked").toBeTruthy();
  }, 120_000);
});

describe("sequence step remove is usable from the CLI", () => {
  it("step list --json emits rows, and step remove accepts the printed short id", () => {
    const env = localEnv();
    ok(runCli(["template", "add", "step-tpl", "--subject", "s", "--text", "b"], env), "template add");
    ok(runCli(["sequence", "create", "drip"], env), "sequence create");
    ok(runCli(["sequence", "step", "add", "drip", "--step", "1", "--delay", "24", "--template", "step-tpl"], env), "step add");

    const steps = rows(runCli(["--json", "sequence", "step", "list", "drip"], env), "step list");
    expect(steps).toHaveLength(1);
    const shortId = String(steps[0]?.["id"]).slice(0, 8);
    expect(shortId.length).toBe(8);

    ok(runCli(["sequence", "step", "remove", shortId], env), `step remove ${shortId}`);
    expect(rows(runCli(["--json", "sequence", "step", "list", "drip"], env), "step list after")).toHaveLength(0);
  }, 120_000);
});

describe("domain remove accepts the domain name like its sibling verbs", () => {
  it("removes by name", () => {
    const env = localEnv();
    const providerId = seedProvider(env);
    // --send-only ON PURPOSE: this test covers the remove-by-name selector, not
    // inbound provisioning. Default `domain add` now provisions the SES receipt
    // rule too (and refuses when it cannot) — covered in
    // domain.inbound-provisioning.test.ts.
    ok(runCli(["domain", "add", "acme.example", "--provider", providerId, "--send-only"], env), "domain add");

    ok(runCli(["domain", "remove", "acme.example", "--yes"], env), "domain remove by name");
    const after = runCli(["--json", "domain", "list"], env);
    expect(ok(after, "domain list after").stdout).not.toContain("acme.example");
  }, 120_000);
});

describe("address verbs accept the email like their siblings", () => {
  function seedAddress(env: NodeJS.ProcessEnv, providerId: string): void {
    ok(runCli(["address", "add", "sender@acme.example", "--provider", providerId], env), "address add");
  }

  it("address remove <email>", () => {
    const env = localEnv();
    const providerId = seedProvider(env);
    seedAddress(env, providerId);

    ok(runCli(["address", "remove", "sender@acme.example", "--yes"], env), "address remove by email");
    const after = runCli(["--json", "address", "list"], env);
    expect(ok(after, "address list after").stdout).not.toContain("sender@acme.example");
  }, 120_000);

  it("address quota <email> and activate <email>", () => {
    const env = localEnv();
    const providerId = seedProvider(env);
    seedAddress(env, providerId);

    const quota = ok(runCli(["--json", "address", "quota", "sender@acme.example", "5"], env), "address quota by email");
    expect((JSON.parse(quota.stdout) as Record<string, unknown>)["daily_quota"]).toBe(5);

    const activated = ok(runCli(["--json", "address", "activate", "sender@acme.example"], env), "address activate by email");
    expect((JSON.parse(activated.stdout) as Record<string, unknown>)["email"]).toBe("sender@acme.example");
  }, 120_000);

  // The complement: an ambiguous or unknown selector must refuse, not guess.
  it("refuses an unknown selector with a resolvable error", () => {
    const env = localEnv();
    seedProvider(env);

    const run = runCli(["--json", "address", "remove", "nobody@acme.example", "--yes"], env);
    expect(run.exitCode).not.toBe(0);
    const failure = JSON.parse(run.stderr) as { error: { message: string } };
    expect(failure.error.message.toLowerCase()).toContain("not found");
  }, 120_000);
});
