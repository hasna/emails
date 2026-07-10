import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SelfHostedTransportError, selfHostedStoreFor, isSelfHostedMode, resetSelfHostedConfigCache, resolveSelfHostedConfig } from "./self-hosted-store.js";

const KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_SELF_HOSTED_HTTP_CONNECT_TIMEOUT",
  "EMAILS_SELF_HOSTED_HTTP_TIMEOUT",
];

function clearEnv(): void {
  for (const key of KEYS) delete process.env[key];
  resetSelfHostedConfigCache();
}

describe("Emails self-hosted client resolver", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("unset env uses local mode", () => {
    expect(resolveSelfHostedConfig()).toBeNull();
    expect(isSelfHostedMode()).toBe(false);
    expect(selfHostedStoreFor("domains")).toBeNull();
  });

  test("requires explicit self_hosted mode, URL, and key", () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    expect(() => resolveSelfHostedConfig()).toThrow("EMAILS_SELF_HOSTED_API_KEY");
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    resetSelfHostedConfigCache();
    expect(() => resolveSelfHostedConfig()).toThrow("EMAILS_SELF_HOSTED_URL");
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example";
    resetSelfHostedConfigCache();
    expect(resolveSelfHostedConfig()?.baseUrl).toBe("https://emails.example/v1");
  });

  test("credentials do not imply a mode", () => {
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    expect(() => resolveSelfHostedConfig()).toThrow("without EMAILS_MODE=self_hosted");
  });

  test("rejects removed aliases and non-loopback plaintext HTTP", () => {
    process.env["EMAILS_MODE"] = "cloud";
    expect(() => resolveSelfHostedConfig()).toThrow("aliases were removed");
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://192.0.2.1:8080";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    resetSelfHostedConfigCache();
    expect(() => resolveSelfHostedConfig()).toThrow("must use https");
  });

  test("transport fails fast and never includes the API key", () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:9";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-secret-value";
    process.env["EMAILS_SELF_HOSTED_HTTP_CONNECT_TIMEOUT"] = "1";
    process.env["EMAILS_SELF_HOSTED_HTTP_TIMEOUT"] = "2";
    resetSelfHostedConfigCache();
    const store = selfHostedStoreFor("domains")!;
    let thrown: unknown;
    try {
      store.list({ limit: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SelfHostedTransportError);
    expect(String(thrown)).not.toContain("test-secret-value");
  });
});
