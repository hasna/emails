// `emails email send` — the subcommand whose help line calls it an alias of the
// top-level `emails send`.
//
// WHY THIS FILE EXISTS. Before the fix it pins, the alias declared a plausible
// option surface (--from/--to/--subject/--body/--provider), accepted a fully
// specified send, printed a dim one-line usage hint, and exited 0. An operator —
// or an agent scripting the CLI — who ran `emails email send --from a --to b
// --subject s --body t` got a SUCCESS exit code and NO email: the worst shape of
// lie the CLI can tell (task 95f66fd3). The alias now forwards its argv verbatim
// to the real `send` command, so it sends, refuses, and drifts exactly as
// `emails send` does — including options added to the real command later.
//
// WHY A SUBPROCESS. `handleError` (src/cli/utils.ts) ends in `process.exit(1)`,
// so the refusal half of the contract cannot be observed in-process without
// killing the test runner. Same harness as email-log-provider-filter.test.ts:
// temp HOME, temp SQLite, scrubbed environment.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Anything that could point the process at a real endpoint, account or second
// store. Scrubbed BY PREFIX rather than by an enumerated key list: the fleet
// shell exports this package's whole client configuration (endpoint, credential,
// and the deployment variable this repo is deleting), and an enumerated list
// that named each one would both go stale and re-introduce the very identifiers
// the mode-axis ratchet counts.
const SCRUBBED_ENV_PREFIXES = ["EMAILS_", "HASNA_EMAILS_", "MAILERY_", "HASNA_MAILERY_"] as const;
const SCRUBBED_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "RESEND_API_KEY",
] as const;

function scrubbedBaseEnv(): NodeJS.ProcessEnv {
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete base[key];
  }
  for (const key of SCRUBBED_ENV_KEYS) delete base[key];
  return base;
}

const tempDirs: string[] = [];

/** A fresh local CLI environment: temp HOME, temp SQLite, no credentials, no endpoint. */
function localEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-send-alias-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  return { ...scrubbedBaseEnv(), EMAILS_DB_PATH: join(dir, "emails.db"), HOME: homePath, NO_COLOR: "1" };
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

/** A sandbox provider created through the CLI, asserted present so the send cases cannot pass vacuously. */
function seedProvider(env: NodeJS.ProcessEnv): void {
  const created = runCli(["--json", "provider", "add", "--name", "alias-sandbox", "--type", "sandbox"], env);
  expect(created.exitCode, `provider add failed: ${created.stderr}`).toBe(0);
  const listed = runCli(["--json", "provider", "list"], env);
  expect(listed.exitCode, `provider list failed: ${listed.stderr}`).toBe(0);
  const providers = JSON.parse(listed.stdout) as Array<{ name: string }>;
  expect(providers.some((row) => row.name === "alias-sandbox"), `seed provider missing from ${listed.stdout}`).toBe(true);
}

/** Subjects the ledger currently holds, read back through the CLI itself. */
function ledgerSubjects(env: NodeJS.ProcessEnv): string[] {
  const logged = runCli(["--json", "email", "list"], env);
  expect(logged.exitCode, `email list failed: ${logged.stderr}`).toBe(0);
  const rows = JSON.parse(logged.stdout) as Array<{ subject?: string }>;
  return rows.map((row) => row.subject ?? "");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("`emails email send` forwards to the real send command", () => {
  // STRONG: the alias must actually SEND. The email lands in the sent ledger,
  // observable through the CLI's own `email list --json`.
  it("delivers a fully-specified send to the sent ledger", () => {
    const env = localEnv();
    seedProvider(env);

    const sent = runCli([
      "email", "send",
      "--from", "agent@alias.example",
      "--to", "person@alias.example",
      "--subject", "alias must really send",
      "--body", "delivered through the alias",
    ], env);

    expect(sent.exitCode, `alias send failed: ${sent.stderr}\n${sent.stdout}`).toBe(0);
    expect(ledgerSubjects(env)).toContain("alias must really send");
  }, 120_000);

  // STRONG: an incomplete send must REFUSE, not exit 0. Before the fix, every
  // invocation — complete or not — exited 0 having done nothing.
  it("refuses a send with no recipients instead of exiting 0", () => {
    const env = localEnv();
    seedProvider(env);

    const run = runCli([
      "email", "send",
      "--from", "agent@alias.example",
      "--subject", "no recipient",
      "--body", "should refuse",
    ], env);

    expect(run.exitCode, `expected a refusal, got exit 0: ${run.stdout}`).not.toBe(0);
    expect(`${run.stderr}${run.stdout}`.toLowerCase()).toContain("recipient");
    expect(ledgerSubjects(env)).not.toContain("no recipient");
  }, 120_000);

  // STRONG: the forwarded surface is the REAL one, not the five options the stub
  // used to declare. --dry-run only exists on the real command; it must preview
  // and write nothing.
  it("honours the real command's --dry-run: previews, records nothing", () => {
    const env = localEnv();
    seedProvider(env);

    const run = runCli([
      "email", "send",
      "--from", "agent@alias.example",
      "--to", "person@alias.example",
      "--subject", "alias dry run",
      "--body", "must not be recorded",
      "--dry-run",
    ], env);

    expect(run.exitCode, `dry-run failed: ${run.stderr}\n${run.stdout}`).toBe(0);
    expect(run.stdout.toLowerCase()).toContain("dry run");
    expect(ledgerSubjects(env)).not.toContain("alias dry run");
  }, 120_000);
});

describe("both arms register the forwarding alias, not a re-declared surface", () => {
  // WEAK detectors, deliberately: the API-backed arm cannot be exercised
  // end-to-end from this suite without configuring the deployment variable the
  // mode-axis ratchet counts at zero slack, so its `email send` is pinned
  // STRUCTURALLY instead. What is asserted is the exact shape the old stub did
  // not have — a variadic passthrough argument and NO re-declared options —
  // which is also the shape a divergent re-implementation would break first.
  // The local arm's behaviour is already pinned above; these prove the two arms
  // share it.
  const armModules = [
    { arm: "local", path: "./email-log.local.js" },
    { arm: "api-backed", path: "./email-log.remote.js" },
  ] as const;

  for (const { arm, path } of armModules) {
    it(`the ${arm} arm's \`email send\` is a verbatim passthrough`, async () => {
      const { Command } = await import("commander");
      const module = await import(path) as {
        registerEmailLogCommands: (program: unknown, output: (data: unknown, formatted: string) => void) => void;
      };
      const program = new Command();
      module.registerEmailLogCommands(program, () => {});
      const emailCmd = program.commands.find((c) => c.name() === "email");
      expect(emailCmd, "no `email` command registered").toBeDefined();
      const sendCmd = emailCmd?.commands.find((c) => c.name() === "send");
      expect(sendCmd, "no `email send` subcommand registered").toBeDefined();

      // The stub declared five options and no argument; the passthrough
      // declares no options and one variadic argument.
      const declared = sendCmd as unknown as {
        options: unknown[];
        registeredArguments: Array<{ variadic: boolean }>;
      };
      expect(declared.options.length,
        "`email send` re-declares options — a partial copy of the real surface is the bug this suite pins").toBe(0);
      expect(declared.registeredArguments.length).toBe(1);
      expect(declared.registeredArguments[0]?.variadic).toBe(true);
    });
  }
});
