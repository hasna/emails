// Which AWS identity a SES provider signs with.
//
// 2026-07-25: production sent through the ECS task role of the WRONG AWS
// account (SES sandbox) even though a provider carrying the correct keys had
// been registered. Two defects made that possible and both are pinned here:
//   1. provider credentials were never actually consulted, and
//   2. the old resolver paired `provider.access_key` with the AMBIENT
//      `AWS_SECRET_ACCESS_KEY` when only one half was present, which signs with
//      a mixed identity that belongs to neither source.
import { describe, expect, it } from "bun:test";
import { resolveSesCredentials } from "./ses.js";
import { ProviderConfigError } from "../types/index.js";

const AMBIENT = {
  AWS_ACCESS_KEY_ID: "AKIA-AMBIENT",
  AWS_SECRET_ACCESS_KEY: "ambient-secret",
} as NodeJS.ProcessEnv;

describe("resolveSesCredentials", () => {
  it("uses the provider's own key pair, EXCLUSIVELY, when the row carries one", () => {
    const resolved = resolveSesCredentials(
      { access_key: "AKIA-PROVIDER", secret_key: "provider-secret" },
      AMBIENT,
    );
    expect(resolved.source).toBe("provider");
    expect(resolved.credentials).toEqual({ accessKeyId: "AKIA-PROVIDER", secretAccessKey: "provider-secret" });
    // Nothing from the environment bleeds in.
    expect(JSON.stringify(resolved)).not.toContain("AMBIENT");
    expect(JSON.stringify(resolved)).not.toContain("ambient-secret");
  });

  it("refuses HALF a provider key pair rather than completing it from the environment", () => {
    expect(() => resolveSesCredentials({ access_key: "AKIA-PROVIDER", secret_key: null }, AMBIENT))
      .toThrow(ProviderConfigError);
    expect(() => resolveSesCredentials({ access_key: null, secret_key: "provider-secret" }, AMBIENT))
      .toThrow(/must be supplied together/);
  });

  // Availability guard for rows that predate the both-or-neither rule: before
  // 1.3.0, `provider add --access-key AKIA…` with no secret key sent fine as
  // long as the environment held the matching pair. Refusing THAT is not a
  // safety win, it is an outage — the identity is the same one, named twice.
  it("accepts an access-key-only row when the environment holds the SAME identity's complete pair", () => {
    const resolved = resolveSesCredentials(
      { access_key: "AKIA-AMBIENT", secret_key: null },
      AMBIENT,
    );
    expect(resolved.source).toBe("ambient");
    expect(resolved.credentials).toEqual({
      accessKeyId: "AKIA-AMBIENT",
      secretAccessKey: "ambient-secret",
    });
  });

  it("still refuses an access-key-only row when the ambient pair is a DIFFERENT identity", () => {
    expect(() => resolveSesCredentials({ access_key: "AKIA-OTHER-ACCOUNT", secret_key: null }, AMBIENT))
      .toThrow(/must be supplied together/);
  });

  it("still refuses an access-key-only row when the environment has no secret to match it", () => {
    expect(() => resolveSesCredentials(
      { access_key: "AKIA-AMBIENT", secret_key: null },
      { AWS_ACCESS_KEY_ID: "AKIA-AMBIENT" } as NodeJS.ProcessEnv,
    )).toThrow(ProviderConfigError);
  });

  it("treats whitespace-only credentials as absent", () => {
    const resolved = resolveSesCredentials({ access_key: "   ", secret_key: "  " }, {});
    expect(resolved.source).toBe("chain");
    expect(resolved.credentials).toBeUndefined();
  });

  it("falls back to a COMPLETE ambient key pair when the provider has none", () => {
    const resolved = resolveSesCredentials({ access_key: null, secret_key: null }, AMBIENT);
    expect(resolved.source).toBe("ambient");
    expect(resolved.credentials?.accessKeyId).toBe("AKIA-AMBIENT");
  });

  it("carries an ambient session token when one is present", () => {
    const resolved = resolveSesCredentials(
      { access_key: null, secret_key: null },
      { ...AMBIENT, AWS_SESSION_TOKEN: "st-1" },
    );
    expect(resolved.credentials?.sessionToken).toBe("st-1");
  });

  it("defers to the AWS default chain (IAM role) when nothing explicit exists", () => {
    const resolved = resolveSesCredentials({ access_key: null, secret_key: null }, {});
    expect(resolved.source).toBe("chain");
    expect(resolved.credentials).toBeUndefined();
  });

  it("ignores half an AMBIENT pair rather than signing with a partial identity", () => {
    const resolved = resolveSesCredentials(
      { access_key: null, secret_key: null },
      { AWS_ACCESS_KEY_ID: "AKIA-AMBIENT" } as NodeJS.ProcessEnv,
    );
    expect(resolved.source).toBe("chain");
  });
});
