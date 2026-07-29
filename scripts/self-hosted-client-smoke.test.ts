import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startV1Stub, type V1Stub } from "../src/test-support/v1-stub.js";

const root = resolve(import.meta.dir, "..");
const smokeScript = join(root, "scripts", "self-hosted-client-smoke.sh");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function runSmoke(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([smokeScript], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let stub: V1Stub;
let testRoot: string;
let home: string;
let dataDir: string;
let database: string;
let quarantine: string;
let wrapper: string;

beforeAll(async () => {
  stub = await startV1Stub({ openapi: true });
  await stub.seed({
    providers: [{ id: "provider-smoke", name: "Smoke SES", type: "ses", active: true }],
    messages: [{
      id: "message-smoke",
      direction: "inbound",
      from_addr: "sender@example.test",
      to_addrs: ["station@example.test"],
      cc_addrs: [],
      subject: "Station smoke",
      status: "received",
      is_read: false,
      is_starred: false,
      labels: [],
      attachments: [],
    }],
  });

  testRoot = mkdtempSync(join(tmpdir(), "emails-station-retirement-"));
  home = join(testRoot, "home");
  dataDir = join(home, ".hasna", "emails");
  database = join(dataDir, "emails.db");
  quarantine = join(testRoot, "quarantine");
  wrapper = join(testRoot, "emails-test-cli");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "attachments", "message-smoke"), { recursive: true });
  mkdirSync(join(dataDir, "cache"), { recursive: true });
  mkdirSync(quarantine);

  // This deliberately is not SQLite. Any accidental local open would fail the
  // smoke instead of letting an empty fallback database masquerade as success.
  writeFileSync(database, "retired-local-database-sentinel\n", { mode: 0o600 });
  writeFileSync(join(dataDir, "attachments", "message-smoke", "proof.txt"), "attachment-state\n");
  writeFileSync(join(dataDir, "cache", "proof"), "cache-state\n");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "src", "cli", "index.tsx"))} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
});

afterAll(() => {
  stub.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("published self-hosted client smoke", () => {
  it("passes before and after quarantine without opening or recreating local state", async () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      EMAILS_MODE: "self_hosted",
      EMAILS_SELF_HOSTED_URL: stub.baseUrl,
      EMAILS_SELF_HOSTED_API_KEY: stub.apiKey,
      EMAILS_SMOKE_CLI: wrapper,
      NO_COLOR: "1",
    };

    const originalDatabaseHash = sha256(database);
    const originalAttachmentHash = sha256(join(dataDir, "attachments", "message-smoke", "proof.txt"));
    const originalCacheHash = sha256(join(dataDir, "cache", "proof"));

    const before = await runSmoke(env);
    expect(before.exitCode, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({
      schema_version: 1,
      purpose: "self-hosted-client-smoke",
      status: "passed",
    });
    expect(sha256(database)).toBe(originalDatabaseHash);

    renameSync(database, join(quarantine, "emails.db"));
    renameSync(join(dataDir, "attachments"), join(quarantine, "attachments"));
    renameSync(join(dataDir, "cache"), join(quarantine, "cache"));
    expect(existsSync(database)).toBe(false);

    const after = await runSmoke(env);
    expect(after.exitCode, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout).commands).toEqual([
      "emails --version",
      "emails status --json",
      "emails provider list --json",
      "emails inbox list --limit 1 --json",
    ]);
    expect(existsSync(database), "remote CLI smoke recreated the local database").toBe(false);
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);
    expect(existsSync(join(dataDir, "attachments"))).toBe(false);
    expect(existsSync(join(dataDir, "cache"))).toBe(false);
    expect(sha256(join(quarantine, "emails.db"))).toBe(originalDatabaseHash);
    expect(sha256(join(quarantine, "attachments", "message-smoke", "proof.txt"))).toBe(originalAttachmentHash);
    expect(sha256(join(quarantine, "cache", "proof"))).toBe(originalCacheHash);
  });

  it("refuses any local database selector before invoking the CLI", async () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      EMAILS_MODE: "self_hosted",
      EMAILS_SELF_HOSTED_URL: stub.baseUrl,
      EMAILS_SELF_HOSTED_API_KEY: stub.apiKey,
      EMAILS_SMOKE_CLI: wrapper,
      EMAILS_DB_PATH: "",
    };
    const result = await runSmoke(env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must both be unset");
  });
});
