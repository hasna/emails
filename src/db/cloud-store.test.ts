import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CloudTransportError, cloudStoreFor, isCloudMode, resetCloudConfigCache, resolveCloudConfig } from "./cloud-store.js";

const KEYS = [
  "HASNA_MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "MAILERY_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_MODE",
  "HASNA_MAILERY_API_URL",
  "MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "MAILERY_API_KEY",
];

function clearEnv(): void {
  for (const k of KEYS) delete process.env[k];
  resetCloudConfigCache();
}

describe("mailery cloud-store resolver (client flip)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("unset env => local (null)", () => {
    expect(resolveCloudConfig()).toBeNull();
    expect(isCloudMode()).toBe(false);
    expect(cloudStoreFor("domains")).toBeNull();
  });

  test("mode=local => local even with url+key", () => {
    process.env.HASNA_MAILERY_STORAGE_MODE = "local";
    process.env.HASNA_MAILERY_API_URL = "https://mailery.hasna.xyz";
    process.env.HASNA_MAILERY_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    expect(resolveCloudConfig()).toBeNull();
  });

  test("url + key with NO mode env => inferred cloud (fleet client-flip)", () => {
    process.env.HASNA_MAILERY_API_URL = "https://mailery.hasna.xyz";
    process.env.HASNA_MAILERY_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    const cfg = resolveCloudConfig();
    expect(cfg!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
    expect(isCloudMode()).toBe(true);
    expect(cloudStoreFor("domains")!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
  });

  test("mode=self_hosted + url + key => cloud-http with /v1 base", () => {
    process.env.HASNA_MAILERY_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MAILERY_API_URL = "https://mailery.hasna.xyz";
    process.env.HASNA_MAILERY_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    const cfg = resolveCloudConfig();
    expect(cfg!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
    expect(cloudStoreFor("domains")!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
    expect(cloudStoreFor("domains")!.resource).toBe("domains");
  });

  test("mode=cloud but NO api url/key => local (legacy fall-through, no throw)", () => {
    process.env.HASNA_MAILERY_STORAGE_MODE = "self_hosted";
    process.env.HASNA_EMAILS_MODE = "self_hosted";
    resetCloudConfigCache();
    expect(resolveCloudConfig()).toBeNull();
    expect(isCloudMode()).toBe(false);
  });

  test("partial config: url set but no key => throws (fail-closed)", () => {
    process.env.HASNA_MAILERY_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MAILERY_API_URL = "https://mailery.hasna.xyz";
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API key/);
  });

  test("cloud requested but no url => throws", () => {
    process.env.MAILERY_MODE = "cloud";
    process.env.HASNA_MAILERY_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API URL/);
  });

  test("transport fails fast and LOUD (never hangs, never empty) when unreachable", () => {
    // Blackhole address (TEST-NET-1, RFC 5737) — connect never completes. With a
    // 1s bounded connect timeout the list() call must THROW a CloudTransportError
    // quickly, not hang until an external wall nor return an empty list.
    process.env.HASNA_MAILERY_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MAILERY_API_URL = "http://192.0.2.1:9";
    process.env.HASNA_MAILERY_API_KEY = "hasna_test_key";
    process.env.HASNA_MAILERY_HTTP_CONNECT_TIMEOUT = "1";
    process.env.HASNA_MAILERY_HTTP_TIMEOUT = "2";
    resetCloudConfigCache();
    const store = cloudStoreFor("domains")!;
    const started = Date.now();
    let thrown: unknown;
    try {
      store.list({ limit: 10 });
    } catch (error) {
      thrown = error;
    }
    delete process.env.HASNA_MAILERY_HTTP_CONNECT_TIMEOUT;
    delete process.env.HASNA_MAILERY_HTTP_TIMEOUT;
    expect(thrown).toBeInstanceOf(CloudTransportError);
    // Well under any external 2-minute wall.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test("resolver never exposes the key value", () => {
    process.env.HASNA_MAILERY_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MAILERY_API_URL = "https://mailery.hasna.xyz";
    process.env.HASNA_MAILERY_API_KEY = "hasna_super_secret_value";
    resetCloudConfigCache();
    const store = cloudStoreFor("domains");
    expect(JSON.stringify({ baseUrl: store!.baseUrl, resource: store!.resource })).not.toContain(
      "hasna_super_secret_value",
    );
  });
});
