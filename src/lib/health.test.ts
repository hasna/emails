import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createDomain } from "../db/domains.js";
import { createAddress } from "../db/addresses.js";
import { updateDnsStatus } from "../db/domains.js";
import { createEvent } from "../db/events.js";
import { checkProviderHealth, checkAllProviders, formatProviderHealth } from "./health.js";
import type { Provider } from "../types/index.js";

let provider: Provider;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  provider = createProvider({ name: "Test Resend", type: "resend", api_key: "re_test_123" });
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("formatProviderHealth", () => {
  it("formats healthy provider", () => {
    const output = formatProviderHealth({
      provider,
      credentialsValid: true,
      domainCount: 2,
      verifiedDomains: 2,
      addressCount: 3,
      verifiedAddresses: 3,
      bounceRate: 1.5,
      status: "healthy",
    });
    expect(output).toContain("Test Resend");
    expect(output).toContain("resend");
    expect(output).toContain("valid");
    expect(output).toContain("2/2 verified");
    expect(output).toContain("3/3 verified");
    expect(output).toContain("1.5%");
  });

  it("formats error provider with credential failure", () => {
    const output = formatProviderHealth({
      provider,
      credentialsValid: false,
      credentialError: "Invalid API key",
      domainCount: 0,
      verifiedDomains: 0,
      addressCount: 0,
      verifiedAddresses: 0,
      bounceRate: 0,
      status: "error",
    });
    expect(output).toContain("invalid");
    expect(output).toContain("Invalid API key");
  });

  it("formats warning provider with high bounce rate", () => {
    const output = formatProviderHealth({
      provider,
      credentialsValid: true,
      domainCount: 1,
      verifiedDomains: 0,
      addressCount: 1,
      verifiedAddresses: 1,
      bounceRate: 8.5,
      status: "warning",
    });
    expect(output).toContain("8.5%");
    expect(output).toContain("0/1 verified");
  });
});

describe("checkProviderHealth", () => {
  it("reports credential error when adapter fails", async () => {
    // Provider with unknown type will throw ProviderConfigError from getAdapter
    const fakeProvider: Provider = {
      ...provider,
      id: "fake-id",
      name: "Broken",
      type: "resend" as any,
      api_key: null, // no API key at all
    };
    // The Resend adapter may or may not throw for null key depending on implementation.
    // Instead, test with a provider whose type we can't construct:
    const badProvider: Provider = {
      ...provider,
      type: "unknown" as any,
    };
    const health = await checkProviderHealth(badProvider);
    expect(health.credentialsValid).toBe(false);
    expect(health.credentialError).toBeDefined();
    expect(health.status).toBe("error");
  });

  it("counts domains and addresses correctly", async () => {
    // Create some domains and addresses
    const d1 = createDomain(provider.id, "example.com");
    const d2 = createDomain(provider.id, "test.com");
    updateDnsStatus(d1.id, "verified", "verified", "verified");

    createAddress({ provider_id: provider.id, email: "a@example.com" });
    createAddress({ provider_id: provider.id, email: "b@example.com" });

    const health = await checkProviderHealth(provider);
    expect(health.domainCount).toBe(2);
    expect(health.verifiedDomains).toBe(1);
    expect(health.addressCount).toBe(2);
    expect(health.verifiedAddresses).toBe(0); // none verified by default
  });

  it("calculates bounce rate from events", async () => {
    const ts = new Date().toISOString();
    // Create 10 delivered and 2 bounced = 2/12 = 16.7% bounce rate
    for (let i = 0; i < 10; i++) {
      createEvent({ provider_id: provider.id, type: "delivered", occurred_at: ts });
    }
    createEvent({ provider_id: provider.id, type: "bounced", occurred_at: ts });
    createEvent({ provider_id: provider.id, type: "bounced", occurred_at: ts });

    const health = await checkProviderHealth(provider);
    expect(health.bounceRate).toBeCloseTo(16.7, 0);
    // bounce rate > 5% means warning (credentials may pass with Resend test key)
    expect(health.bounceRate).toBeGreaterThan(5);
  });
});

describe("checkAllProviders", () => {
  it("returns empty array when no active providers", async () => {
    // Delete the auto-created provider
    const { deleteProvider } = await import("../db/providers.js");
    deleteProvider(provider.id);
    const results = await checkAllProviders();
    expect(results).toEqual([]);
  });

  it("checks all active providers", async () => {
    createProvider({ name: "Second", type: "ses" });
    const results = await checkAllProviders();
    expect(results.length).toBe(2);
    const names = results.map(r => r.provider.name).sort();
    expect(names).toEqual(["Second", "Test Resend"]);
  });
});
