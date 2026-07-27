import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderConfigError } from "../types/index.js";
import { getAdapter, providerDnsPublishing } from "./index.js";
import type { Provider, ProviderType } from "../types/index.js";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: "provider-1",
    name: "Provider",
    type: "sandbox",
    active: true,
    ...overrides,
  } as Provider;
}

describe("getAdapter", () => {
  it("keeps constructor-level validation without importing provider SDK modules", () => {
    expect(() => getAdapter(provider({ type: "resend", api_key: null }))).toThrow(ProviderConfigError);
    expect(() => getAdapter(provider({ type: "imap" as Provider["type"] }))).toThrow("Unknown provider type: imap");
  });

  it("preserves optional SES-only MAIL FROM support on the lazy adapter", () => {
    expect(typeof getAdapter(provider({ type: "ses" })).setMailFrom).toBe("function");
    expect(getAdapter(provider({ type: "resend", api_key: "re_test" })).setMailFrom).toBeUndefined();
    expect(getAdapter(provider({ type: "sandbox" })).setMailFrom).toBeUndefined();
  });

  it("uses dynamic provider adapter imports so CLI startup does not load provider SDKs", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']\.\/(resend|ses|sandbox)\.js["'];/m);
    expect(source).toContain('import("./resend.js")');
    expect(source).toContain('import("./ses.js")');
    expect(source).toContain('import("./sandbox.js")');
  });
});

describe("providerDnsPublishing", () => {
  it("says sandbox publishes nothing, and says why", () => {
    // SandboxAdapter.getDnsRecords returns [] unconditionally. That is the
    // complete answer, not a failed lookup, and this is where that fact is
    // declared — the assertion on a NON-EMPTY reason is what stops the message
    // regressing to the bare "No DNS records found." it replaced.
    const support = providerDnsPublishing(provider({ type: "sandbox" }));
    expect(support.publishes).toBe(false);
    if (support.publishes) throw new Error("expected sandbox to be non-publishing");
    expect(support.reason.length).toBeGreaterThan(20);
    expect(support.reason).toContain("sandbox");
    expect(support.instead).toBeTruthy();
    expect(support.instead!.length).toBeGreaterThan(20);
  });

  it("says the real senders do publish", () => {
    // Both hand mail to DNS-authenticated infrastructure, so an empty record list
    // from either is a result about the domain and must not be explained away.
    expect(providerDnsPublishing(provider({ type: "ses" })).publishes).toBe(true);
    expect(providerDnsPublishing(provider({ type: "resend", api_key: "re_test" })).publishes).toBe(true);
  });

  it("covers every provider type, so a new one cannot inherit a wrong default", () => {
    // The point of the throw: silently defaulting to "publishes" would print DNS
    // advice for a provider that has none, which is the defect in the other
    // direction. The list is derived from the ProviderType union via a mapping
    // the compiler checks, so adding a member fails to typecheck here first.
    const allTypes: Record<ProviderType, true> = { resend: true, ses: true, sandbox: true };
    for (const type of Object.keys(allTypes) as ProviderType[]) {
      expect(() => providerDnsPublishing(provider({ type, api_key: "re_test" }))).not.toThrow();
    }
    expect(() => providerDnsPublishing(provider({ type: "imap" as ProviderType }))).toThrow(ProviderConfigError);
    expect(() => providerDnsPublishing(provider({ type: "imap" as ProviderType })))
      .toThrow(/providerDnsPublishing/);
  });
});
