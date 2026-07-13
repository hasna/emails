import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import type { DoctorCheck } from "../../lib/doctor.js";
import { handleApiRequest } from "../api-routes.js";

const ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
] as const;

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

let tempHome: string | undefined;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function call(path: string): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3900${path}`);
  const url = new URL(req.url);
  const response = await handleApiRequest(req, url, url.pathname, req.method);
  if (!response) throw new Error(`No route handled ${req.method} ${path}`);
  return response;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  tempHome = mkdtempSync(join(tmpdir(), "emails-api-doctor-self-hosted-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:3900";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
  resetSelfHostedConfigCache();
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  resetSelfHostedConfigCache();
  restoreEnv();
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe("/api/doctor self_hosted diagnostics", () => {
  it("returns API/operator guidance without creating a local emails DB", async () => {
    const response = await call("/api/doctor?live=true");
    expect(response.status).toBe(200);
    const checks = await response.json() as DoctorCheck[];

    expect(checks.find((c) => c.name === "Self-hosted API")?.message).toContain("/ready");
    expect(checks.find((c) => c.name === "Local SQLite")?.message).toContain("Skipped by design");
    expect(existsSync(join(tempHome!, ".hasna", "emails", "emails.db"))).toBe(false);
  });
});
