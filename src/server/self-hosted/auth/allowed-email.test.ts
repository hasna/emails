// Unit tests for the signup/login/invite email allowlist (design Addendum A1).
//
// The module ships NO default allowlist: unconfigured is a loud failure naming
// EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS, never a permissive or vendor-specific
// fallback. Every positive case therefore configures the allowlist explicitly.

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_EMAIL_DOMAINS_ENV,
  assertAllowedEmailDomainsConfigured,
  buildAllowedEmailPattern,
  isAllowedSignupEmail,
} from "./allowed-email.js";

/** An env with the allowlist configured to the given globs. */
function envWith(domains: string): NodeJS.ProcessEnv {
  return { [ALLOWED_EMAIL_DOMAINS_ENV]: domains } as NodeJS.ProcessEnv;
}

describe("the allowlist is required — no default domain ships", () => {
  const unset = {} as NodeJS.ProcessEnv;

  test("buildAllowedEmailPattern throws and names the variable when unset", () => {
    expect(() => buildAllowedEmailPattern(unset)).toThrow(ALLOWED_EMAIL_DOMAINS_ENV);
  });

  test("an empty or separator-only value is treated as unset, not as permit-all", () => {
    for (const value of ["", "   ", " , ,\t"]) {
      expect(() => buildAllowedEmailPattern(envWith(value))).toThrow(ALLOWED_EMAIL_DOMAINS_ENV);
    }
  });

  test("isAllowedSignupEmail fails closed loudly rather than allowing anything", () => {
    expect(() => isAllowedSignupEmail("someone@example.com", unset)).toThrow(
      ALLOWED_EMAIL_DOMAINS_ENV,
    );
    // Crucially: it never silently returns true for an arbitrary address.
    expect(() => isAllowedSignupEmail("attacker@evil.test", unset)).toThrow();
  });

  test("the boot assertion throws when unset and passes once configured", () => {
    expect(() => assertAllowedEmailDomainsConfigured(unset)).toThrow(ALLOWED_EMAIL_DOMAINS_ENV);
    expect(() => assertAllowedEmailDomainsConfigured(envWith("example.com"))).not.toThrow();
  });

  test("the error explains what to set, not just that something is missing", () => {
    let message = "";
    try {
      buildAllowedEmailPattern(unset);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(ALLOWED_EMAIL_DOMAINS_ENV);
    expect(message).toContain("required");
    expect(message).toContain("no default");
  });
});

describe("a malformed allowlist is rejected, not silently compiled into deny-all", () => {
  // Non-emptiness alone is not enough. Each of these compiles to a regex that
  // matches NO address, so every real signup and login would be refused by the same
  // deliberately opaque 403 this change exists to eliminate — with the operator's
  // typo as the cause instead of a vendor default.
  const malformed = [
    "example_corp.com", // underscore is not a DNS character
    ".com", // empty first label
    "example.", // empty last label
    "example..com", // empty middle label
    "'example.com'", // quoted (a shell/compose quoting mistake)
    "user@example.com", // a full address rather than a domain
    "https://example.com", // a URL
    "-", // punctuation only
    "example", // a single label
    "*", // a single label: would allow root@localhost
    "example .com", // stray space splits into an invalid "example"
  ];
  for (const value of malformed) {
    test(`rejects ${JSON.stringify(value)} and names it`, () => {
      expect(() => buildAllowedEmailPattern(envWith(value))).toThrow(ALLOWED_EMAIL_DOMAINS_ENV);
      let message = "";
      try {
        buildAllowedEmailPattern(envWith(value));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // The operator has to be told WHICH entry is wrong.
      expect(message).toContain("not a domain glob");
    });
  }

  test("one bad entry rejects the whole list rather than quietly dropping it", () => {
    expect(() => buildAllowedEmailPattern(envWith("example.com, bad_entry"))).toThrow("bad_entry");
  });

  test("legitimate shapes still pass", () => {
    for (const value of ["example.com", "example.*", "partner.example.net", "example.co-uk", "*.*", "EXAMPLE.COM"]) {
      expect(() => buildAllowedEmailPattern(envWith(value))).not.toThrow();
    }
  });
});

describe("isAllowedSignupEmail against a configured wildcard allowlist", () => {
  const env = envWith("example.*");
  const cases: Array<[string, boolean]> = [
    ["andrei@example.com", true],
    ["andrei@example.org", true],
    ["noreply@example.net", true],
    ["a.b+tag@example.io", true],
    ["USER@EXAMPLE.COM", true], // case-insensitive
    ["user@example.co-uk", true], // [a-z0-9-] tld label
    ["user@notexample.com", false],
    ["user@example.com.evil.com", false], // multi-label after example. must not match
    ["user@sub.example.com", false], // subdomain before example is not allowed
    ["user@examplexcom", false], // no dot
    ["user@gmail.com", false],
    ["userexample.com", false], // no @
    ["", false],
    ["user@example.", false], // empty tld
    ["@example.com", false], // empty local
  ];
  for (const [email, expected] of cases) {
    test(`${email || "(empty)"} -> ${expected}`, () => {
      expect(isAllowedSignupEmail(email, env)).toBe(expected);
    });
  }

  test("rejects a non-string", () => {
    expect(isAllowedSignupEmail(undefined, env)).toBe(false);
    expect(isAllowedSignupEmail(null, env)).toBe(false);
    expect(isAllowedSignupEmail(42, env)).toBe(false);
  });

  test("no regex-injection through the configured value", () => {
    // Defence in depth. First line: shape validation refuses a metacharacter-laden
    // entry outright and names it, so it never reaches the compiler.
    for (const injection of ["example.(com|org)", "example.com|evil.com", "example.co(m)", "^example.com$"]) {
      expect(() => buildAllowedEmailPattern(envWith(injection))).toThrow("not a domain glob");
    }
    // Second line: `globToDomainSource` still escapes what survives validation, so a
    // dot is a dot and never a wildcard.
    const re = buildAllowedEmailPattern(envWith("example.com"));
    expect(re.test("user@example.com")).toBe(true);
    expect(re.test("user@exampleXcom")).toBe(false);
  });
});

describe("buildAllowedEmailPattern", () => {
  test("accepts several explicit domains", () => {
    const re = buildAllowedEmailPattern(envWith("example.com, partner.example.net"));
    expect(re.test("a@example.com")).toBe(true);
    expect(re.test("a@partner.example.net")).toBe(true);
    expect(re.test("a@other.com")).toBe(false);
  });

  test("a wildcard glob spans exactly one label", () => {
    const re = buildAllowedEmailPattern(envWith("example.*"));
    expect(re.test("a@example.dev")).toBe(true);
    expect(re.test("a@evil.dev")).toBe(false);
    expect(re.test("a@example.dev.evil.dev")).toBe(false);
  });

  test("space- and comma-separated values are both accepted", () => {
    const re = buildAllowedEmailPattern(envWith("example.com example.org,example.net"));
    for (const domain of ["example.com", "example.org", "example.net"]) {
      expect(re.test(`a@${domain}`)).toBe(true);
    }
  });
});
