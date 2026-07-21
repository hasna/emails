import { describe, expect, it } from "bun:test";
import { applyMaileryEnvCompat, legacyEnvNameFor } from "./env-compat.js";
import { resolveEmailsMode } from "./mode.js";

function env(entries: Record<string, string>): NodeJS.ProcessEnv {
  return { ...entries } as NodeJS.ProcessEnv;
}

describe("applyMaileryEnvCompat — MAILERY_* dual-read", () => {
  it("bridges a MAILERY_ var onto its EMAILS_ alias", () => {
    const e = env({ MAILERY_DB_PATH: "/tmp/x.db" });
    applyMaileryEnvCompat(e);
    expect(e["EMAILS_DB_PATH"]).toBe("/tmp/x.db");
    expect(e["MAILERY_DB_PATH"]).toBe("/tmp/x.db"); // additive, not deleted
  });

  it("bridges the HASNA_MAILERY_ prefix onto HASNA_EMAILS_", () => {
    const e = env({ HASNA_MAILERY_MODE: "self_hosted" });
    applyMaileryEnvCompat(e);
    expect(e["HASNA_EMAILS_MODE"]).toBe("self_hosted");
  });

  it("prefers the new MAILERY_ value over an existing EMAILS_ value", () => {
    const e = env({ MAILERY_MODE: "self_hosted", EMAILS_MODE: "local" });
    applyMaileryEnvCompat(e);
    expect(e["EMAILS_MODE"]).toBe("self_hosted");
  });

  it("leaves an EMAILS_-only environment untouched (fallback)", () => {
    const e = env({ EMAILS_MODE: "local" });
    applyMaileryEnvCompat(e);
    expect(e["EMAILS_MODE"]).toBe("local");
    expect(e["MAILERY_MODE"]).toBeUndefined();
  });

  it("does NOT bridge hosted control-plane credential/endpoint vars", () => {
    // These must stay under their MAILERY_ name so the no-cloud guards keep
    // rejecting them (never mirrored onto an EMAILS_ alias the code would read).
    for (const key of [
      "MAILERY_API_URL",
      "MAILERY_API_KEY",
      "MAILERY_CLOUD_API_URL",
      "MAILERY_CLOUD_TOKEN",
      "HASNA_MAILERY_API_URL",
      "HASNA_MAILERY_API_KEY",
      "HASNA_MAILERY_ENV_FILE",
    ]) {
      expect(legacyEnvNameFor(key)).toBeNull();
    }
  });

  it("does NOT bridge removed storage-mode or HASNA_ self-hosted vars", () => {
    for (const key of [
      "MAILERY_STORAGE_MODE",
      "HASNA_MAILERY_STORAGE_MODE",
      "HASNA_MAILERY_DATABASE_URL",
      "HASNA_MAILERY_API_SIGNING_KEY",
    ]) {
      expect(legacyEnvNameFor(key)).toBeNull();
    }
  });

  it("does not touch unrelated env keys", () => {
    const e = env({ PATH: "/usr/bin", HOME: "/home/x" });
    applyMaileryEnvCompat(e);
    expect(Object.keys(e).sort()).toEqual(["HOME", "PATH"]);
  });

  it("is idempotent", () => {
    const e = env({ MAILERY_DATABASE_URL: "postgres://x/y" });
    applyMaileryEnvCompat(e);
    applyMaileryEnvCompat(e);
    expect(e["EMAILS_DATABASE_URL"]).toBe("postgres://x/y");
  });

  it("makes MAILERY_MODE=local resolve through the mode resolver after bridging", () => {
    const e = env({ MAILERY_MODE: "local" });
    applyMaileryEnvCompat(e);
    expect(resolveEmailsMode(e)).toMatchObject({ mode: "local" });
  });
});
