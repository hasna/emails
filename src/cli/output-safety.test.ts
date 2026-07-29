import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";

let stub: V1Stub;
const tempDirs: string[] = [];

const MODE_ENV_KEYS = [
  "EMAILS_CLIENT_ENV_SECRET",
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_SESSION_TOKEN",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
] as const;

function isolatedEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-cli-output-safety-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true });
  const env = { ...process.env };
  for (const key of MODE_ENV_KEYS) delete env[key];
  return {
    ...env,
    HOME: homePath,
    NO_COLOR: "1",
  };
}

function selfHostedEnv(): NodeJS.ProcessEnv {
  return {
    ...isolatedEnv(),
    EMAILS_MODE: "self_hosted",
    EMAILS_SELF_HOSTED_URL: stub.baseUrl,
    EMAILS_SELF_HOSTED_API_KEY: stub.apiKey,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function largeDomains(): Array<Record<string, unknown>> {
  return Array.from({ length: 1000 }, (_, index) => {
    const serial = String(index).padStart(4, "0");
    return {
      id: `slow-pipe-${serial}-${"i".repeat(72)}`,
      domain: `${serial}.${"d".repeat(180)}.example`,
      provider_id: "self_hosted",
      verified: false,
      dkim_status: "pending",
      spf_status: "pending",
      dmarc_status: "pending",
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z",
    };
  });
}

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI JSON output safety", () => {
  it("fully drains a large JSON document to a slow pipe identically to a regular file", async () => {
    await stub.seed({ domains: largeDomains() });
    const env = selfHostedEnv();
    const outputDir = mkdtempSync(join(tmpdir(), "emails-cli-output-files-"));
    tempDirs.push(outputDir);
    const regularPath = join(outputDir, "regular.json");
    const slowPath = join(outputDir, "slow.json");
    const args = "--json domains list --limit 1000";

    const regular = spawnSync("bash", ["-lc", `bun src/cli/index.tsx ${args} > "$REGULAR_OUT"`], {
      cwd: process.cwd(),
      env: { ...env, REGULAR_OUT: regularPath },
      encoding: "utf8",
    });
    expect(regular.status, regular.stderr).toBe(0);
    expect(regular.stderr).toBe("");

    const slowConsumer = [
      "const reader = Bun.stdin.stream().getReader();",
      "const writer = Bun.file(process.env.SLOW_OUT).writer();",
      "while (true) {",
      "  const { done, value } = await reader.read();",
      "  if (done) break;",
      "  writer.write(value);",
      "  await Bun.sleep(2);",
      "}",
      "await writer.end();",
    ].join(" ");
    const slow = spawnSync(
      "bash",
      ["-lc", `set -o pipefail; bun src/cli/index.tsx ${args} | bun -e "$SLOW_CONSUMER"`],
      {
        cwd: process.cwd(),
        env: { ...env, SLOW_OUT: slowPath, SLOW_CONSUMER: slowConsumer },
        encoding: "utf8",
      },
    );
    expect(slow.status, slow.stderr).toBe(0);
    expect(slow.stderr).toBe("");

    const regularJson = readFileSync(regularPath, "utf8");
    const slowJson = readFileSync(slowPath, "utf8");
    expect(slowJson).toBe(regularJson);
    const parsed = JSON.parse(slowJson) as { items: Array<Record<string, unknown>>; limit: number; truncated: boolean };
    expect(parsed.items).toHaveLength(1000);
    expect(parsed).toMatchObject({ limit: 1000, truncated: true });
  }, 30_000);

  it("exits nonzero without a Bun stack when the JSON pipe closes early", async () => {
    await stub.seed({ domains: largeDomains() });
    const result = spawnSync(
      "bash",
      ["-lc", "set -o pipefail; bun src/cli/index.tsx --json domains list --limit 1000 | head -c 1 >/dev/null"],
      {
        cwd: process.cwd(),
        env: selfHostedEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("output_closed");
    expect(parsed.error.message).toContain("closed before the JSON document was fully written");
    expect(result.stderr).not.toContain("\n      at ");
    expect(result.stderr).not.toContain("Bun v");
  }, 20_000);
});

describe("CLI self-hosted bootstrap failures", () => {
  it("returns one structured JSON error and creates no local SQLite state for missing or invalid configuration", () => {
    const cases = [
      {
        name: "missing",
        env: { EMAILS_MODE: "self_hosted" },
        message: "self-hosted client is not configured",
      },
      {
        name: "invalid",
        env: {
          EMAILS_MODE: "self_hosted",
          EMAILS_SELF_HOSTED_URL: "ftp://emails.example.invalid",
          EMAILS_SELF_HOSTED_API_KEY: "not-a-real-key",
        },
        message: "API URL must use http or https",
      },
    ] as const;

    for (const testCase of cases) {
      const env = isolatedEnv();
      const dbDir = join(env.HOME!, "sqlite");
      const dbPath = join(dbDir, `${testCase.name}.db`);
      const result = runCli(
        ["--json", "inbox", "list"],
        {
          ...env,
          ...testCase.env,
          EMAILS_DB_PATH: dbPath,
          HASNA_EMAILS_DB_PATH: dbPath,
        },
      );

      expect(result.exitCode, `${testCase.name}: ${text(result.stderr)}`).toBe(1);
      expect(text(result.stdout)).toBe("");
      const stderr = text(result.stderr);
      const parsed = JSON.parse(stderr) as { error: { code: string; message: string } };
      expect(parsed.error.message).toContain(testCase.message);
      expect(stderr).not.toContain("\n      at ");
      expect(stderr).not.toContain("Bun v");
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      expect(existsSync(dbDir)).toBe(false);
    }
  }, 20_000);
});
