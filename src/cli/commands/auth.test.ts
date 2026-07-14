// Self-hosted-ONLY: `emails auth …` and `emails keys …` are plain /v1 HTTP calls.
// These tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts, extended with /v1/auth/*, /v1/me, /v1/keys).
//
// Coverage: signup → unverified (no token persisted, verification email issued),
// login refused until verified, verify-email, login success persists a session
// token that authenticates whoami, the @hasna.<tld> restriction (403), the
// needs_tenant → switch-tenant flow, logout, bootstrap, and tenant-scoped keys.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { registerAuthCommands } from "./auth.js";

let stub: V1Stub;

async function runAuth(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAuthCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

// handleError() calls console.error + process.exit(1). Capture both.
async function runAuthExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runAuth(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

function clearSessionEnv(): void {
  delete process.env["EMAILS_SESSION_TOKEN"];
  resetSelfHostedConfigCache();
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  clearSessionEnv();
});
afterEach(() => {
  clearSessionEnv();
  stub.clearEnv();
});

async function signupAndVerify(email: string, password: string, org: string, slug: string): Promise<void> {
  await runAuth(["auth", "signup", "--email", email, "--password", password, "--tenant-name", org, "--tenant-slug", slug]);
  const token = await stub.verifyToken(email);
  if (!token) throw new Error("expected a verification token");
  await runAuth(["auth", "verify-email", token]);
  clearSessionEnv();
}

describe("auth CLI — self-hosted /v1", () => {
  it("signup creates an unverified account, issues a verify token, persists no session", async () => {
    const { data } = await runAuth([
      "auth", "signup",
      "--email", "alice@hasna.com", "--password", "s3cret-pw",
      "--tenant-name", "Acme", "--tenant-slug", "acme",
    ]);
    expect((data as { verification_required?: boolean }).verification_required).toBe(true);
    expect(process.env["EMAILS_SESSION_TOKEN"]).toBeUndefined();
    // A verification token exists to complete the flow.
    expect(await stub.verifyToken("alice@hasna.com")).toBeTruthy();
  });

  it("signup rejects a non-@hasna address with a clear 403 message", async () => {
    const result = await runAuthExpectingExit([
      "auth", "signup",
      "--email", "mallory@gmail.com", "--password", "pw",
      "--tenant-name", "Evil", "--tenant-slug", "evil",
    ]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("@hasna.");
  });

  it("login is refused until the email is verified", async () => {
    await runAuth([
      "auth", "signup",
      "--email", "bob@hasna.com", "--password", "pw-bob",
      "--tenant-name", "Bobco", "--tenant-slug", "bobco",
    ]);
    clearSessionEnv();
    const result = await runAuthExpectingExit(["auth", "login", "--email", "bob@hasna.com", "--password", "pw-bob"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr.toLowerCase()).toContain("verif");
    expect(process.env["EMAILS_SESSION_TOKEN"]).toBeUndefined();
  });

  it("verify-email then login persists a session token that authenticates whoami", async () => {
    await runAuth([
      "auth", "signup",
      "--email", "carol@hasna.com", "--password", "pw-carol",
      "--tenant-name", "Carol Co", "--tenant-slug", "carolco",
    ]);
    const token = await stub.verifyToken("carol@hasna.com");
    expect(token).toBeTruthy();
    const verify = await runAuth(["auth", "verify-email", token!]);
    expect((verify.data as { verified?: boolean }).verified).toBe(true);
    clearSessionEnv();

    const login = await runAuth(["auth", "login", "--email", "carol@hasna.com", "--password", "pw-carol"]);
    const loginData = login.data as { logged_in?: boolean; role?: string; tenant?: { slug?: string } };
    expect(loginData.logged_in).toBe(true);
    expect(loginData.role).toBe("owner");
    expect(loginData.tenant?.slug).toBe("carolco");
    // A session token is now set (process-scoped: no vault pointer in tests).
    const sessionToken = process.env["EMAILS_SESSION_TOKEN"];
    expect(sessionToken?.startsWith("emss_")).toBe(true);
    // The formatted output must never contain the raw token.
    expect(login.out).not.toContain(sessionToken!);

    const who = await runAuth(["auth", "whoami"]);
    const id = who.data as { principalType?: string; user?: { email?: string }; tenant?: { slug?: string }; role?: string };
    expect(id.principalType).toBe("user");
    expect(id.user?.email).toBe("carol@hasna.com");
    expect(id.tenant?.slug).toBe("carolco");
    expect(id.role).toBe("owner");
  });

  it("login with a wrong password fails with a generic message", async () => {
    await signupAndVerify("dave@hasna.com", "right-pw", "Daveco", "daveco");
    const result = await runAuthExpectingExit(["auth", "login", "--email", "dave@hasna.com", "--password", "wrong-pw"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("Invalid email or password");
  });

  it("login prompts for a tenant when the user belongs to several (non-interactive → clear error)", async () => {
    await stub.seedUser({
      email: "multi@hasna.com",
      password: "pw-multi",
      verified: true,
      tenants: [
        { slug: "one", name: "Org One", role: "owner" },
        { slug: "two", name: "Org Two", role: "admin" },
      ],
    });
    const result = await runAuthExpectingExit(["auth", "login", "--email", "multi@hasna.com", "--password", "pw-multi"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("--tenant");
    expect(result.stderr).toContain("one");
    expect(result.stderr).toContain("two");
  });

  it("login --tenant selects the org directly for a multi-tenant user", async () => {
    await stub.seedUser({
      email: "multi2@hasna.com",
      password: "pw",
      verified: true,
      tenants: [
        { slug: "alpha", name: "Alpha", role: "owner" },
        { slug: "beta", name: "Beta", role: "member" },
      ],
    });
    const login = await runAuth(["auth", "login", "--email", "multi2@hasna.com", "--password", "pw", "--tenant", "beta"]);
    const data = login.data as { logged_in?: boolean; tenant?: { slug?: string }; role?: string };
    expect(data.logged_in).toBe(true);
    expect(data.tenant?.slug).toBe("beta");
    expect(data.role).toBe("member");
  });

  it("switch-tenant mints a new session for another org the user belongs to", async () => {
    await stub.seedUser({
      email: "switch@hasna.com",
      password: "pw",
      verified: true,
      tenants: [
        { slug: "home", name: "Home", role: "owner" },
        { slug: "work", name: "Work", role: "admin" },
      ],
    });
    await runAuth(["auth", "login", "--email", "switch@hasna.com", "--password", "pw", "--tenant", "home"]);
    const before = process.env["EMAILS_SESSION_TOKEN"];
    const switched = await runAuth(["auth", "switch-tenant", "work"]);
    expect((switched.data as { switched?: boolean }).switched).toBe(true);
    const after = process.env["EMAILS_SESSION_TOKEN"];
    expect(after?.startsWith("emss_")).toBe(true);
    expect(after).not.toBe(before);
    const who = await runAuth(["auth", "whoami"]);
    expect((who.data as { tenant?: { slug?: string }; role?: string }).tenant?.slug).toBe("work");
    expect((who.data as { role?: string }).role).toBe("admin");
  });

  it("switch-tenant to a non-member org is refused", async () => {
    await signupAndVerify("solo@hasna.com", "pw", "Solo", "solo");
    await runAuth(["auth", "login", "--email", "solo@hasna.com", "--password", "pw"]);
    const result = await runAuthExpectingExit(["auth", "switch-tenant", "nope"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("nope");
  });

  it("logout clears the stored session token", async () => {
    await signupAndVerify("gone@hasna.com", "pw", "Goneco", "goneco");
    await runAuth(["auth", "login", "--email", "gone@hasna.com", "--password", "pw"]);
    expect(process.env["EMAILS_SESSION_TOKEN"]).toBeTruthy();
    const out = await runAuth(["auth", "logout"]);
    expect((out.data as { logged_out?: boolean }).logged_out).toBe(true);
    expect(process.env["EMAILS_SESSION_TOKEN"]).toBeUndefined();
  });

  it("verify-email --resend issues a fresh token without erroring", async () => {
    await runAuth([
      "auth", "signup",
      "--email", "resend@hasna.com", "--password", "pw",
      "--tenant-name", "Resendco", "--tenant-slug", "resendco",
    ]);
    clearSessionEnv();
    const out = await runAuth(["auth", "verify-email", "--resend", "--email", "resend@hasna.com"]);
    expect((out.data as { resent?: boolean }).resent).toBe(true);
    expect(await stub.verifyToken("resend@hasna.com")).toBeTruthy();
  });

  it("verify-email with a bad token fails clearly", async () => {
    const result = await runAuthExpectingExit(["auth", "verify-email", "emiv_not_a_real_token"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr.toLowerCase()).toContain("invalid");
  });

  it("bootstrap uses the operator API key to create the first owner", async () => {
    const out = await runAuth(["auth", "bootstrap", "--email", "operator@hasna.com", "--password", "pw-op"]);
    expect((out.data as { bootstrapped?: boolean }).bootstrapped).toBe(true);
    // A second bootstrap is refused (owner already exists).
    const again = await runAuthExpectingExit(["auth", "bootstrap", "--email", "other@hasna.com", "--password", "pw"]);
    expect(again.error).toBe("process.exit:1");
    expect(again.stderr.toLowerCase()).toContain("owner");
  });

  it("whoami with only the operator API key reports the api-key principal / default tenant", async () => {
    const who = await runAuth(["whoami"]);
    const id = who.data as { principalType?: string; tenant?: { slug?: string } };
    expect(id.principalType).toBe("apikey");
    expect(id.tenant?.slug).toBe("default");
  });
});

describe("keys CLI — tenant-scoped /v1/keys", () => {
  it("an operator with only the API key can create, list, and revoke keys (default tenant)", async () => {
    const created = await runAuth(["keys", "create", "--scope", "emails:*"]);
    const createdData = created.data as { token?: string; kid?: string };
    expect(createdData.kid).toBeTruthy();
    expect(createdData.token).toBeTruthy();
    // The token is shown in formatted output but the create data carries it too;
    // JSON redaction (not exercised here) masks it. The token itself is a real value.
    expect(created.out).toContain(createdData.token!);

    const listed = await runAuth(["keys", "list"]);
    const keys = listed.data as Array<{ kid: string }>;
    expect(keys.map((k) => k.kid)).toContain(createdData.kid);

    const revoked = await runAuth(["keys", "revoke", createdData.kid!]);
    expect((revoked.data as { revoked?: boolean }).revoked).toBe(true);
  });

  it("keys are scoped to the active tenant of a user session", async () => {
    await stub.seedUser({
      email: "keys@hasna.com",
      password: "pw",
      verified: true,
      tenants: [{ slug: "keysorg", name: "Keys Org", role: "owner" }],
    });
    await runAuth(["auth", "login", "--email", "keys@hasna.com", "--password", "pw", "--tenant", "keysorg"]);
    await runAuth(["keys", "create", "--scope", "emails:read"]);
    const listed = await runAuth(["keys", "list"]);
    expect((listed.data as unknown[]).length).toBe(1);

    // The operator API key sees a DIFFERENT (default) tenant → none of the above.
    clearSessionEnv();
    const asOperator = await runAuth(["keys", "list"]);
    expect((asOperator.data as unknown[]).length).toBe(0);
  });
});
