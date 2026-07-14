// Unit tests for the @hasna signup/login/invite allowlist (design Addendum A1).

import { describe, expect, test } from "bun:test";
import { buildAllowedEmailPattern, isAllowedSignupEmail } from "./allowed-email.js";

describe("isAllowedSignupEmail (A1 default hasna.*)", () => {
  const cases: Array<[string, boolean]> = [
    ["andrei@hasna.com", true],
    ["andrei@hasna.xyz", true],
    ["noreply@hasna.studio", true],
    ["a.b+tag@hasna.io", true],
    ["USER@HASNA.COM", true], // case-insensitive
    ["user@hasna.co-uk", true], // [a-z0-9-] tld label
    ["user@nothasna.com", false],
    ["user@hasna.com.evil.com", false], // multi-label after hasna. must not match
    ["user@sub.hasna.com", false], // subdomain before hasna is not allowed
    ["user@hasnaxcom", false], // no dot
    ["user@gmail.com", false],
    ["userhasna.com", false], // no @
    ["", false],
    ["user@hasna.", false], // empty tld
    ["@hasna.com", false], // empty local
  ];
  for (const [email, expected] of cases) {
    test(`${email || "(empty)"} -> ${expected}`, () => {
      expect(isAllowedSignupEmail(email)).toBe(expected);
    });
  }

  test("rejects a non-string", () => {
    expect(isAllowedSignupEmail(undefined)).toBe(false);
    expect(isAllowedSignupEmail(null)).toBe(false);
    expect(isAllowedSignupEmail(42)).toBe(false);
  });

  test("no regex-injection through the env override", () => {
    // A metacharacter-laden override must be escaped, not compiled as a pattern.
    const env = { EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS: "hasna.(com|xyz)" } as NodeJS.ProcessEnv;
    // Literal parens are escaped -> only the literal domain "hasna.(com|xyz)" would match.
    expect(isAllowedSignupEmail("user@hasna.com", env)).toBe(false);
    expect(isAllowedSignupEmail("user@hasna.xyz", env)).toBe(false);
  });
});

describe("buildAllowedEmailPattern env override", () => {
  test("widens to additional explicit domains", () => {
    const env = { EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS: "hasna.*, example.com" } as NodeJS.ProcessEnv;
    const re = buildAllowedEmailPattern(env);
    expect(re.test("a@hasna.com")).toBe(true);
    expect(re.test("a@example.com")).toBe(true);
    expect(re.test("a@other.com")).toBe(false);
  });

  test("empty override falls back to the hasna.* default", () => {
    const re = buildAllowedEmailPattern({ EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS: "" } as NodeJS.ProcessEnv);
    expect(re.test("a@hasna.dev")).toBe(true);
    expect(re.test("a@evil.dev")).toBe(false);
  });
});
