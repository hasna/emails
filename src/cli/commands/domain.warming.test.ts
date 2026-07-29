// Live end-to-end proof that the six `emails domain warm*` commands actually
// work. Every one of them used to be an unconditional `throw` claiming warming
// "is not available in the self-hosted client; it runs on the self-hosted
// server" — a refusal that fired in EVERY configuration even though the warming
// repository (src/db/warming.ts), the `warming_schedules` table, and the
// /v1/warming routes all existed.
//
// These tests therefore spawn the CLI as a real subprocess (bun src/cli/index.tsx,
// the same entrypoint `bun run dev:cli` and every other live CLI test uses)
// rather than registering the commands in-process: the bug class was "the source
// looks fine, invoking the command refuses", so invoking the command is what gets
// asserted on. No live provider or cloud credential is used — the env is scrubbed
// and the store is a temp SQLite file.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Anything that could point the process at a real endpoint or account.
const SCRUBBED_ENV_KEYS = [
  "EMAILS_MODE", "HASNA_EMAILS_MODE", "EMAILS_DB_PATH", "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL", "EMAILS_SELF_HOSTED_API_KEY", "EMAILS_SESSION_TOKEN",
  "EMAILS_CLIENT_ENV_SECRET", "EMAILS_DATABASE_URL", "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_STORAGE_MODE", "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_MODE", "HASNA_MAILERY_MODE", "MAILERY_STORAGE_MODE", "HASNA_MAILERY_STORAGE_MODE",
  "MAILERY_API_URL", "MAILERY_API_KEY", "HASNA_MAILERY_API_URL", "HASNA_MAILERY_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "RESEND_API_KEY",
] as const;

const tempDirs: string[] = [];

/** A fresh local-mode CLI environment: temp HOME, temp SQLite, no credentials. */
function localWarmingEnv(): NodeJS.ProcessEnv {
  // mkdtempSync creates the directory 0700, which the SQLite path guard requires.
  const dir = mkdtempSync(join(tmpdir(), "emails-warming-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  const base = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) delete base[key];
  return {
    ...base,
    EMAILS_DB_PATH: join(dir, "emails.db"),
    HOME: homePath,
    NO_COLOR: "1",
  };
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

function runJson<T>(args: string[], env: NodeJS.ProcessEnv): T {
  const result = runCli(["--json", ...args], env);
  expect(result.exitCode, `${args.join(" ")} failed: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

interface CliError { error: { message: string; code: string; fix_commands: string[] } }

function runJsonError(args: string[], env: NodeJS.ProcessEnv): CliError {
  const result = runCli(["--json", ...args], env);
  expect(result.exitCode, `${args.join(" ")} unexpectedly succeeded: ${result.stdout}`).toBe(1);
  return JSON.parse(result.stderr) as CliError;
}

interface WarmingSchedulePayload {
  id: string;
  domain: string;
  provider_id: string | null;
  target_daily_volume: number;
  start_date: string;
  status: "active" | "paused" | "completed";
}

interface WarmStatusPayload {
  schedule: WarmingSchedulePayload;
  current_day: number;
  total_days: number;
  progress_percent: number;
  today_limit: number | null;
  today_sent: number;
}

// The exact refusal these commands used to emit. It was false in BOTH
// directions (local and self-hosted), so no warming surface may reproduce it.
const RETIRED_REFUSALS = [
  "not available in the self-hosted client",
  "it runs on the self-hosted server",
];

function expectNoRetiredRefusal(text: string): void {
  for (const phrase of RETIRED_REFUSALS) expect(text).not.toContain(phrase);
}

/** N days before today's UTC calendar date — the calendar the ramp is anchored on. */
function utcDaysAgo(count: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - count);
  return date.toISOString().slice(0, 10);
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("emails domain warm* (live, temp SQLite)", () => {
  it("drives the whole schedule lifecycle: warm -> status -> list -> pause -> resume -> complete", () => {
    const env = localWarmingEnv();
    // Started 6 days ago so the ramp is mid-flight and the day/limit math is
    // observable rather than always "day 1, limit 50".
    const startDate = utcDaysAgo(6);

    // 1. warm — creates the schedule and reports the plan.
    const created = runJson<WarmStatusPayload & { plan_days: number; final_day: number }>(
      ["domain", "warm", "ramp.example.com", "--target", "5000", "--start-date", startDate],
      env,
    );
    expect(created.schedule).toMatchObject({
      domain: "ramp.example.com",
      target_daily_volume: 5000,
      start_date: startDate,
      status: "active",
      provider_id: null,
    });
    expect(created.schedule.id).toBeTruthy();
    // Exact, in every timezone: the ramp is anchored on the UTC calendar date,
    // the same anchor the self-hosted server enforces the cap with.
    expect(created.current_day).toBe(7);
    expect(created.total_days).toBe(15);
    expect(created.final_day).toBe(15);
    expect(created.progress_percent).toBe(47);
    // Day 7 of a 5000/day ramp: 50 -> 100 -> 200 -> 400.
    expect(created.today_limit).toBe(400);
    expect(created.today_sent).toBe(0);

    // 2. warm-status — reflects the schedule `warm` just created.
    const status = runJson<WarmStatusPayload>(["domain", "warm-status", "ramp.example.com"], env);
    expect(status.schedule).toMatchObject({
      id: created.schedule.id,
      domain: "ramp.example.com",
      status: "active",
      target_daily_volume: 5000,
    });
    expect(status.current_day).toBe(created.current_day);
    expect(status.today_limit).toBe(created.today_limit);

    // 3. warm-list — the schedule shows up, in JSON and in the human table.
    const listed = runJson<WarmingSchedulePayload[]>(["domain", "warm-list"], env);
    expect(listed.map((row) => row.domain)).toEqual(["ramp.example.com"]);

    const table = runCli(["domain", "warm-list"], env);
    expect(table.exitCode, table.stderr).toBe(0);
    expect(table.stdout).toContain("ramp.example.com");
    expect(table.stdout).toContain("active");
    expect(table.stdout).toContain(String(created.today_limit));
    expect(table.stdout).toContain("Showing 1 warming schedule");

    // A second domain proves listing and --status filtering are not single-row luck.
    runJson(["domain", "warm", "second.example.com", "--target", "300"], env);
    const both = runJson<WarmingSchedulePayload[]>(["domain", "warm-list"], env);
    // Newest-first, like every other list command.
    expect(both.map((row) => row.domain)).toEqual(["second.example.com", "ramp.example.com"]);

    // --limit/--offset must survive the collapsed family's dual argument orders
    // (the published surface admits both (status, opts) and (status, store, opts)),
    // so a dropped options argument here would silently return the whole table.
    const firstPage = runJson<WarmingSchedulePayload[]>(["domain", "warm-list", "--limit", "1"], env);
    expect(firstPage.map((row) => row.domain)).toEqual(["second.example.com"]);
    const secondPage = runJson<WarmingSchedulePayload[]>(["domain", "warm-list", "--limit", "1", "--offset", "1"], env);
    expect(secondPage.map((row) => row.domain)).toEqual(["ramp.example.com"]);

    // 4. warm-pause — status transitions and the daily cap disappears.
    const paused = runJson<WarmingSchedulePayload>(["domain", "warm-pause", "ramp.example.com"], env);
    expect(paused).toMatchObject({ domain: "ramp.example.com", status: "paused" });
    const pausedStatus = runJson<WarmStatusPayload>(["domain", "warm-status", "ramp.example.com"], env);
    expect(pausedStatus.schedule.status).toBe("paused");
    // A paused schedule imposes no limit (send.local.ts keys off exactly this).
    expect(pausedStatus.today_limit).toBeNull();

    const pausedOnly = runJson<WarmingSchedulePayload[]>(["domain", "warm-list", "--status", "paused"], env);
    expect(pausedOnly.map((row) => row.domain)).toEqual(["ramp.example.com"]);
    const activeOnly = runJson<WarmingSchedulePayload[]>(["domain", "warm-list", "--status", "active"], env);
    expect(activeOnly.map((row) => row.domain)).toEqual(["second.example.com"]);

    // 5. warm-resume — back to active, and the mid-ramp cap comes back.
    const resumed = runJson<WarmingSchedulePayload>(["domain", "warm-resume", "ramp.example.com"], env);
    expect(resumed).toMatchObject({ domain: "ramp.example.com", status: "active" });
    const resumedStatus = runJson<WarmStatusPayload>(["domain", "warm-status", "ramp.example.com"], env);
    expect(resumedStatus.schedule.status).toBe("active");
    expect(resumedStatus.today_limit).toBe(created.today_limit);

    // 6. warm-complete — graduated; no warming cap applies any more.
    const completed = runJson<WarmingSchedulePayload>(["domain", "warm-complete", "ramp.example.com"], env);
    expect(completed).toMatchObject({ domain: "ramp.example.com", status: "completed" });
    const completedStatus = runJson<WarmStatusPayload>(["domain", "warm-status", "ramp.example.com"], env);
    expect(completedStatus.schedule.status).toBe("completed");
    expect(completedStatus.today_limit).toBeNull();

    // The state survived every separate process: it is in the SQLite file, not memory.
    const finalRows = runJson<WarmingSchedulePayload[]>(["domain", "warm-list"], env);
    expect(finalRows.map((row) => [row.domain, row.status]).sort()).toEqual([
      ["ramp.example.com", "completed"],
      ["second.example.com", "active"],
    ]);

    // 7. warm-delete — the only way to retarget a domain, so `warm` works again after it.
    const deleted = runJson<{ deleted: boolean; schedule: WarmingSchedulePayload }>(
      ["domain", "warm-delete", "ramp.example.com", "--yes"],
      env,
    );
    expect(deleted).toMatchObject({ deleted: true, schedule: { domain: "ramp.example.com" } });
    expect(runJson<WarmingSchedulePayload[]>(["domain", "warm-list"], env).map((row) => row.domain))
      .toEqual(["second.example.com"]);

    const retargeted = runJson<WarmStatusPayload>(
      ["domain", "warm", "ramp.example.com", "--target", "900"],
      env,
    );
    expect(retargeted.schedule).toMatchObject({ target_daily_volume: 900, status: "active" });
    // A brand-new ramp, not the old one resurrected.
    expect(retargeted.schedule.id).not.toBe(created.schedule.id);
    expect(retargeted.current_day).toBe(1);
    expect(retargeted.today_limit).toBe(50);
  }, 180_000);

  it("refuses to silently create a duplicate schedule for the same domain", () => {
    const env = localWarmingEnv();
    runJson(["domain", "warm", "dup.example.com", "--target", "100"], env);

    const failure = runJsonError(["domain", "warm", "dup.example.com", "--target", "999"], env);
    expect(failure.error.message).toContain("already has a warming schedule");
    // Every recovery path it names must exist as a real command.
    expect(failure.error.message).toContain("emails domain warm-status dup.example.com");
    expect(failure.error.message).toContain("emails domain warm-delete dup.example.com");
    expectNoRetiredRefusal(failure.error.message);

    // The original schedule is untouched and there is still exactly one.
    const status = runJson<WarmStatusPayload>(["domain", "warm-status", "dup.example.com"], env);
    expect(status.schedule.target_daily_volume).toBe(100);
    expect(runJson<WarmingSchedulePayload[]>(["domain", "warm-list"], env)).toHaveLength(1);
  }, 90_000);

  it("fails loud (and truthfully) when the domain has no schedule", () => {
    const env = localWarmingEnv();

    for (const command of ["warm-status", "warm-pause", "warm-resume", "warm-complete", "warm-delete"]) {
      const failure = runJsonError(["domain", command, "ghost.example.com"], env);
      expect(failure.error.code).toBe("not_found");
      expect(failure.error.message).toContain("Warming schedule not found for domain: ghost.example.com");
      expect(failure.error.message).toContain("emails domain warm ghost.example.com --target");
      expect(failure.error.fix_commands).toContain("emails domain warm-list --json");
      expectNoRetiredRefusal(failure.error.message);
    }

    // An empty store is a valid answer for a list, not an error.
    const empty = runCli(["--json", "domain", "warm-list"], env);
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual([]);
  }, 90_000);

  it("validates --target, --start-date, and --status instead of storing junk", () => {
    const env = localWarmingEnv();

    const badTarget = runJsonError(["domain", "warm", "bad.example.com", "--target", "not-a-number"], env);
    expect(badTarget.error.message).toContain("Invalid --target");

    const zeroTarget = runJsonError(["domain", "warm", "bad.example.com", "--target", "0"], env);
    expect(zeroTarget.error.message).toContain("Invalid --target");

    const badDate = runJsonError(
      ["domain", "warm", "bad.example.com", "--target", "100", "--start-date", "07/20/2026"],
      env,
    );
    expect(badDate.error.message).toContain("Invalid --start-date");

    const badStatus = runJsonError(["domain", "warm-list", "--status", "warming"], env);
    expect(badStatus.error.message).toContain("Invalid --status");

    // None of the rejected inputs created a row.
    expect(runJson<WarmingSchedulePayload[]>(["domain", "warm-list"], env)).toEqual([]);
  }, 90_000);

  it("advertises the warming commands in --help and never repeats the retired refusal", () => {
    const env = localWarmingEnv();
    const help = runCli(["domain", "--help"], env);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const command of ["warm ", "warm-status", "warm-list", "warm-pause", "warm-resume", "warm-complete", "warm-delete"]) {
      expect(help.stdout).toContain(command);
    }

    // Every warming surface, success or failure, stdout or stderr.
    const invocations = [
      ["domain", "warm", "truth.example.com", "--target", "100"],
      ["domain", "warm-status", "truth.example.com"],
      ["domain", "warm-list"],
      ["domain", "warm-pause", "truth.example.com"],
      ["domain", "warm-resume", "truth.example.com"],
      ["domain", "warm-complete", "truth.example.com"],
      ["domain", "warm-delete", "truth.example.com", "--yes"],
    ];
    for (const args of invocations) {
      const result = runCli(args, env);
      expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      expectNoRetiredRefusal(`${result.stdout}\n${result.stderr}`);
    }
  }, 120_000);
});
