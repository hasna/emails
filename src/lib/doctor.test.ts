import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiagnostics, formatDiagnostics } from "./doctor.js";
import type { DoctorCheck } from "./doctor.js";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";

// This client is self-hosted-ONLY: runDiagnostics no longer opens a local SQLite
// database or counts providers/domains/addresses/contacts/templates (those live
// behind the operator's /v1 API and its own /health + /ready probes). It only
// validates the self-hosted client configuration and returns the Mode,
// Self-hosted API, and Local SQLite checks. The previous local-resource
// diagnostics validated removed behavior and are gone.

let previousHome: string | undefined;
let tempHome: string | undefined;

const MODE_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

function configureSelfHosted(): void {
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:3900";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
  resetSelfHostedConfigCache();
}

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-doctor-test-home-"));
  process.env["HOME"] = tempHome;
  for (const key of MODE_ENV_KEYS) delete process.env[key];
  resetSelfHostedConfigCache();
});

afterEach(() => {
  for (const key of MODE_ENV_KEYS) delete process.env[key];
  resetSelfHostedConfigCache();
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  previousHome = undefined;
});

describe("runDiagnostics", () => {
  it("throws loudly when the self-hosted client is not configured", async () => {
    await expect(runDiagnostics()).rejects.toThrow(/self-hosted|not configured/i);
  });

  it("returns self-hosted operator guidance without creating a local database", async () => {
    configureSelfHosted();

    const checks = await runDiagnostics();

    expect(checks.find((c) => c.name === "Mode")).toMatchObject({
      status: "pass",
      message: "Self-hosted mode (self_hosted)",
    });
    const api = checks.find((c) => c.name === "Self-hosted API");
    expect(api?.status).toBe("pass");
    expect(api?.message).toContain("/health");
    const sqlite = checks.find((c) => c.name === "Local SQLite");
    expect(sqlite?.status).toBe("warn");
    expect(sqlite?.message).toContain("must not open or create a local emails.db");
    expect(existsSync(join(tempHome!, ".hasna", "emails", "emails.db"))).toBe(false);
  });

  it("retains the liveProviderChecks option for compatibility without opening local state", async () => {
    configureSelfHosted();

    const checks = await runDiagnostics({ liveProviderChecks: true });

    expect(checks.map((c) => c.name)).toEqual(["Mode", "Self-hosted API", "Local SQLite"]);
    expect(existsSync(join(tempHome!, ".hasna", "emails", "emails.db"))).toBe(false);
  });
});

describe("formatDiagnostics", () => {
  it("formats checks with pass/warn/fail icons", () => {
    const checks: DoctorCheck[] = [
      { name: "Database", status: "pass", message: "OK" },
      { name: "Config", status: "warn", message: "Missing" },
      { name: "Creds", status: "fail", message: "Invalid" },
    ];
    const out = formatDiagnostics(checks);
    expect(out).toContain("Database");
    expect(out).toContain("OK");
    expect(out).toContain("Config");
    expect(out).toContain("Missing");
    expect(out).toContain("Creds");
    expect(out).toContain("Invalid");
    expect(out).toContain("Summary");
    expect(out).toContain("1 passed");
    expect(out).toContain("1 warnings");
    expect(out).toContain("1 failed");
  });

  it("formats all-pass summary without warnings/failures", () => {
    const checks: DoctorCheck[] = [
      { name: "A", status: "pass", message: "Good" },
      { name: "B", status: "pass", message: "Great" },
    ];
    const out = formatDiagnostics(checks);
    expect(out).toContain("2 passed");
    expect(out).not.toContain("warnings");
    expect(out).not.toContain("failed");
  });

  it("contains diagnostics header", () => {
    const out = formatDiagnostics([]);
    expect(out).toContain("Email System Diagnostics");
    expect(out).toContain("Summary");
  });
});
