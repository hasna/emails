import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CloudTransportError, cloudStoreFor, isCloudMode, resetCloudConfigCache, resolveCloudConfig } from "./cloud-store.js";

const HASNA_MAILERY_AUTH_ENV = ["HASNA", "MAILERY", "API", "KEY"].join("_");
const MAILERY_AUTH_ENV = ["MAILERY", "API", "KEY"].join("_");
const KEYS = [
  "HASNA_MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "MAILERY_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_MODE",
  "HASNA_MAILERY_API_URL",
  "MAILERY_API_URL",
  HASNA_MAILERY_AUTH_ENV,
  MAILERY_AUTH_ENV,
];

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

function clearEnv(): void {
  for (const k of KEYS) delete process.env[k];
  resetCloudConfigCache();
}

describe("emails self_hosted store resolver (client flip)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("unset env => local (null)", () => {
    expect(resolveCloudConfig()).toBeNull();
    expect(isCloudMode()).toBe(false);
    expect(cloudStoreFor("domains")).toBeNull();
  });

  test("mode=local => local even with url+key", () => {
    setEnv("HASNA_MAILERY_STORAGE_MODE", "local");
    setEnv("HASNA_MAILERY_API_URL", "https://mailery.hasna.xyz");
    setEnv(HASNA_MAILERY_AUTH_ENV, "hasna_test_key");
    resetCloudConfigCache();
    expect(resolveCloudConfig()).toBeNull();
  });

  test("url + key with NO mode env => inferred self_hosted (fleet client-flip)", () => {
    setEnv("HASNA_MAILERY_API_URL", "https://mailery.hasna.xyz");
    setEnv(HASNA_MAILERY_AUTH_ENV, "hasna_test_key");
    resetCloudConfigCache();
    const cfg = resolveCloudConfig();
    expect(cfg!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
    expect(isCloudMode()).toBe(true);
    expect(cloudStoreFor("domains")!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
  });

  test("mode=self_hosted + url + key => self-hosted http with /v1 base", () => {
    setEnv("HASNA_MAILERY_STORAGE_MODE", "self_hosted");
    setEnv("HASNA_MAILERY_API_URL", "https://mailery.hasna.xyz");
    setEnv(HASNA_MAILERY_AUTH_ENV, "hasna_test_key");
    resetCloudConfigCache();
    const cfg = resolveCloudConfig();
    expect(cfg!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
    expect(cloudStoreFor("domains")!.baseUrl).toBe("https://mailery.hasna.xyz/v1");
    expect(cloudStoreFor("domains")!.resource).toBe("domains");
  });

  test("mode=self_hosted but NO api url/key => throws (fail-closed)", () => {
    setEnv("HASNA_MAILERY_STORAGE_MODE", "self_hosted");
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API URL/);
  });

  test("removed cloud mode is rejected", () => {
    setEnv("HASNA_MAILERY_STORAGE_MODE", "cloud");
    setEnv("HASNA_MAILERY_API_URL", "https://mailery.hasna.xyz");
    setEnv(HASNA_MAILERY_AUTH_ENV, "hasna_test_key");
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/removed from Hasna OSS/);
  });

  test("partial config: url set but no key => throws (fail-closed)", () => {
    setEnv("HASNA_MAILERY_STORAGE_MODE", "self_hosted");
    setEnv("HASNA_MAILERY_API_URL", "https://mailery.hasna.xyz");
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API key/);
  });

  test("self_hosted requested but no url => throws", () => {
    setEnv("MAILERY_MODE", "self_hosted");
    setEnv(HASNA_MAILERY_AUTH_ENV, "hasna_test_key");
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API URL/);
  });

  test("transport fails fast and LOUD (never hangs, never empty) when unreachable", () => {
    // Blackhole address (TEST-NET-1, RFC 5737) — connect never completes. With a
    // 1s bounded connect timeout the list() call must THROW a CloudTransportError
    // quickly, not hang until an external wall nor return an empty list.
    setEnv("HASNA_MAILERY_STORAGE_MODE", "self_hosted");
    setEnv("HASNA_MAILERY_API_URL", "http://192.0.2.1:9");
    setEnv(HASNA_MAILERY_AUTH_ENV, "hasna_test_key");
    setEnv("HASNA_MAILERY_HTTP_CONNECT_TIMEOUT", "1");
    setEnv("HASNA_MAILERY_HTTP_TIMEOUT", "2");
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
    setEnv("HASNA_MAILERY_STORAGE_MODE", "self_hosted");
    setEnv("HASNA_MAILERY_API_URL", "https://mailery.hasna.xyz");
    const hiddenValue = "hasna_opaque_value";
    setEnv(HASNA_MAILERY_AUTH_ENV, hiddenValue);
    resetCloudConfigCache();
    const store = cloudStoreFor("domains");
    expect(JSON.stringify({ baseUrl: store!.baseUrl, resource: store!.resource })).not.toContain(
      hiddenValue,
    );
  });
});
