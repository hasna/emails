// THE SENT LEDGER'S PROVIDER FILTER, AT THE SURFACE AN OPERATOR ACTUALLY TYPES.
//
// `src/db/emails` has collapsed onto the store seam, and no message projection there carries a
// provider — so `listEmails` REFUSES a `provider_id` filter rather than ignoring it. Serving
// every provider's mail under one provider's heading and serving none of it are both wrong,
// and this is a capability the CLI advertises with a `--provider` flag.
//
// WHY THIS FILE EXISTS AT ALL, given the refusal is already pinned at `/api/emails`,
// `/api/export/emails` and the MCP `list_emails` tool. Those three pin the STORE-LAYER guard.
// What none of them can catch is the CLI quietly dropping `--provider` on the floor before the
// read ever sees it: the flag would parse, the refusal would never fire, and the operator would
// get the whole ledger under one provider's name — which is the exact answer the refusal exists
// to prevent. Removing a capability is allowed; removing it silently is not.
//
// WHY A SUBPROCESS. `handleError` (src/cli/utils.ts) ends in `process.exit(1)`, so an
// in-process registration cannot observe the error path without killing the test runner — the
// reason `src/cli/commands/email-log.local.test.ts` has no error cases and
// `src/cli/commands/domain.warming.test.ts` spawns the real binary. This file does the same,
// against a temp SQLite file with a scrubbed environment: no credential, no endpoint, no
// deployment variable set (the store resolves from storage configuration, which is the whole
// point of the collapse).

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Anything that could point the process at a real endpoint, account or second store. */
const SCRUBBED_ENV_KEYS = [
  "EMAILS_DB_PATH", "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL", "EMAILS_SELF_HOSTED_API_KEY", "EMAILS_SESSION_TOKEN",
  "EMAILS_CLIENT_ENV_SECRET", "EMAILS_DATABASE_URL", "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_STORAGE_MODE", "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL", "MAILERY_API_KEY", "HASNA_MAILERY_API_URL", "HASNA_MAILERY_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "RESEND_API_KEY",
] as const;

const tempDirs: string[] = [];

/** A fresh CLI environment: temp HOME, temp SQLite, no credentials, no endpoint. */
function localEnv(): NodeJS.ProcessEnv {
  // mkdtempSync creates the directory 0700, which the SQLite path guard requires.
  const dir = mkdtempSync(join(tmpdir(), "emails-ledger-provider-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  const base = { ...process.env };
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

/**
 * A provider row, created through the CLI so the id is one the CLI can resolve.
 *
 * `provider add --json` reports lines rather than the row, so the id is taken from
 * `provider list --json`, which does return rows. Both calls are asserted: a seed that
 * silently produced no provider would make the refusal cases pass for the wrong reason.
 */
function seedProvider(env: NodeJS.ProcessEnv): string {
  const created = runCli(["--json", "provider", "add", "--name", "ledger-filter", "--type", "sandbox"], env);
  expect(created.exitCode, `provider add failed: ${created.stderr}`).toBe(0);

  const listed = runCli(["--json", "provider", "list"], env);
  expect(listed.exitCode, `provider list failed: ${listed.stderr}`).toBe(0);
  const providers = JSON.parse(listed.stdout) as Array<{ id: string; name: string }>;
  const provider = providers.find((row) => row.name === "ledger-filter");
  expect(provider, `the seeded provider is not in ${listed.stdout}`).toBeDefined();
  expect((provider as { id: string }).id.length).toBeGreaterThan(0);
  return (provider as { id: string }).id;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("the sent ledger's provider filter, at the CLI", () => {
  it("refuses `email list --provider` instead of answering with every provider's mail", () => {
    const env = localEnv();
    const providerId = seedProvider(env);

    const run = runCli(["--json", "email", "list", "--provider", providerId], env);

    expect(run.exitCode, `expected a refusal, got: ${run.stdout}`).not.toBe(0);
    const failure = JSON.parse(run.stderr) as { error: { message: string } };
    expect(failure.error.message).toContain("provider");
    // The refusal must say WHY, not merely fail: an operator has to learn that the store does
    // not record which provider sent a message, or they will just retry the same flag.
    expect(failure.error.message).toContain("provider_id");
    // And it must not be a plausible empty answer dressed up as an error.
    expect(run.stdout.trim()).not.toBe("[]");
  }, 120_000);

  it("refuses `export emails --provider` instead of writing every provider's mail to a file", () => {
    const env = localEnv();
    const providerId = seedProvider(env);

    const run = runCli(["--json", "export", "emails", "--provider", providerId], env);

    expect(run.exitCode, `expected a refusal, got: ${run.stdout}`).not.toBe(0);
    const failure = JSON.parse(run.stderr) as { error: { message: string } };
    expect(failure.error.message).toContain("provider");
    expect(run.stdout.trim()).not.toContain("id,from,to,subject,status,sent_at");
  }, 120_000);

  it("still lists and exports the whole ledger when no provider is named", () => {
    // THE COMPLEMENT, and it is the half that matters most. An unconditional guard does not
    // refuse one filter, it takes the command down — which is exactly what an early draft of
    // this collapse shipped, and it was found by review rather than by a test.
    const env = localEnv();
    seedProvider(env);

    const listed = runCli(["--json", "email", "list"], env);
    expect(listed.exitCode, `email list failed: ${listed.stderr}`).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);

    const exported = runCli(["--json", "export", "emails"], env);
    expect(exported.exitCode, `export emails failed: ${exported.stderr}`).toBe(0);
  }, 120_000);
});
