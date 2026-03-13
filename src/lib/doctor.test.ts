import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress } from "../db/addresses.js";
import { createTemplate } from "../db/templates.js";
import { suppressContact, upsertContact } from "../db/contacts.js";
import { runDiagnostics, formatDiagnostics } from "./doctor.js";
import type { DoctorCheck } from "./doctor.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("runDiagnostics", () => {
  it("reports database accessible", async () => {
    const checks = await runDiagnostics();
    const dbCheck = checks.find((c) => c.name === "Database");
    expect(dbCheck).toBeDefined();
    expect(dbCheck!.status).toBe("pass");
    expect(dbCheck!.message).toContain("accessible");
  });

  it("warns when no providers configured", async () => {
    const checks = await runDiagnostics();
    const provCheck = checks.find((c) => c.name === "Providers");
    expect(provCheck).toBeDefined();
    expect(provCheck!.status).toBe("warn");
    expect(provCheck!.message).toContain("No providers");
  });

  it("passes when providers exist", async () => {
    createProvider({ name: "Test", type: "resend", api_key: "re_test" });
    const checks = await runDiagnostics();
    const provCheck = checks.find((c) => c.name === "Providers");
    expect(provCheck!.status).toBe("pass");
    expect(provCheck!.message).toContain("1 provider(s)");
  });

  it("checks domain verification status", async () => {
    const p = createProvider({ name: "Test", type: "resend" });
    createDomain(p.id, "example.com");
    createDomain(p.id, "test.com");

    const checks = await runDiagnostics();
    const domCheck = checks.find((c) => c.name === "Domains");
    expect(domCheck).toBeDefined();
    expect(domCheck!.message).toContain("0/2 domains verified");
    expect(domCheck!.status).toBe("warn");
  });

  it("passes when all domains verified", async () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const d1 = createDomain(p.id, "example.com");
    updateDnsStatus(d1.id, "verified", "verified", "verified");

    const checks = await runDiagnostics();
    const domCheck = checks.find((c) => c.name === "Domains");
    expect(domCheck!.status).toBe("pass");
    expect(domCheck!.message).toContain("1/1 domains verified");
  });

  it("counts addresses", async () => {
    const p = createProvider({ name: "Test", type: "resend" });
    createAddress({ provider_id: p.id, email: "a@test.com" });
    createAddress({ provider_id: p.id, email: "b@test.com" });

    const checks = await runDiagnostics();
    const addrCheck = checks.find((c) => c.name === "Addresses");
    expect(addrCheck).toBeDefined();
    expect(addrCheck!.message).toContain("2 sender address(es)");
  });

  it("warns on suppressed contacts", async () => {
    upsertContact("a@test.com");
    suppressContact("b@test.com");

    const checks = await runDiagnostics();
    const contactCheck = checks.find((c) => c.name === "Contacts");
    expect(contactCheck).toBeDefined();
    expect(contactCheck!.status).toBe("warn");
    expect(contactCheck!.message).toContain("1 suppressed");
  });

  it("passes contacts when none suppressed", async () => {
    upsertContact("a@test.com");

    const checks = await runDiagnostics();
    const contactCheck = checks.find((c) => c.name === "Contacts");
    expect(contactCheck!.status).toBe("pass");
    expect(contactCheck!.message).toContain("0 suppressed");
  });

  it("counts templates", async () => {
    createTemplate({ name: "welcome", subject_template: "Welcome!", text_template: "Hi" });

    const checks = await runDiagnostics();
    const tmplCheck = checks.find((c) => c.name === "Templates");
    expect(tmplCheck).toBeDefined();
    expect(tmplCheck!.message).toContain("1 template(s)");
  });

  it("includes provider health checks for active providers", async () => {
    createProvider({ name: "MyResend", type: "resend", api_key: "re_test" });
    const checks = await runDiagnostics();
    const provHealthCheck = checks.find((c) => c.name.startsWith("Provider: MyResend"));
    expect(provHealthCheck).toBeDefined();
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
