import { describe, expect, it } from "bun:test";
import type { PoolQueryClient, TypedQueryClient } from "../../../storage-kit/index.js";
import { hashPassword } from "./password.js";
import {
  ASSIGNABLE_ROLES,
  AuthStore,
  EmailTakenError,
  LastOwnerError,
  ROLES,
  SlugTakenError,
  isRole,
  slugify,
  toPublicTenant,
  toPublicUser,
  type MembershipRow,
  type TenantRow,
  type UserEmailIdentity,
  type UserRow,
} from "./store.js";

interface QueryCall {
  method: "query" | "many" | "get" | "one" | "execute";
  sql: string;
  params: readonly unknown[];
}

type Handler = (sql: string, params: readonly unknown[]) => unknown | Promise<unknown>;

interface ClientHandlers {
  query?: Handler;
  many?: Handler;
  get?: Handler;
  one?: Handler;
  execute?: Handler;
  transaction?: (fn: (client: TypedQueryClient) => Promise<unknown>, client: TypedQueryClient) => Promise<unknown>;
}

function fakeClient(handlers: ClientHandlers = {}): { client: PoolQueryClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  let base: TypedQueryClient;
  const invoke = async <T>(method: QueryCall["method"], sql: string, params: readonly unknown[] = []): Promise<T> => {
    calls.push({ method, sql, params });
    const handler = handlers[method];
    if (handler) return await handler(sql, params) as T;
    if (method === "query") return { rows: [], rowCount: 0 } as T;
    if (method === "many") return [] as T;
    if (method === "get") return null as T;
    if (method === "execute") return undefined as T;
    throw new Error(`Unexpected one(): ${sql}`);
  };
  base = {
    query: (sql, params) => invoke("query", sql, params),
    many: (sql, params) => invoke("many", sql, params),
    get: (sql, params) => invoke("get", sql, params),
    one: (sql, params) => invoke("one", sql, params),
    execute: (sql, params) => invoke("execute", sql, params),
  };
  const client = {
    ...base,
    pool: {} as PoolQueryClient["pool"],
    transaction: async <T>(fn: (tx: TypedQueryClient) => Promise<T>): Promise<T> => {
      if (handlers.transaction) return await handlers.transaction(fn as (client: TypedQueryClient) => Promise<unknown>, base) as T;
      return fn(base);
    },
    async close() {},
  };
  return { client, calls };
}

const NOW = new Date("2026-07-29T12:00:00.000Z");

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-1",
    email: "user@example.com",
    password_hash: "$argon2id$placeholder",
    name: "User",
    status: "active",
    email_verified_at: "2026-01-01T00:00:00.000Z",
    global_role: "user",
    is_primary_super_admin: false,
    failed_login_count: 0,
    locked_until: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function tenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: "tenant-1",
    slug: "example-org",
    name: "Example Org",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function membership(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: "membership-1",
    user_id: "user-1",
    tenant_id: "tenant-1",
    role: "owner",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("auth store public helpers", () => {
  it("recognizes only supported roles", () => {
    expect(ROLES).toEqual(["owner", "admin", "member", "viewer"]);
    expect(ASSIGNABLE_ROLES).toEqual(ROLES);
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    expect(isRole("super_admin")).toBe(false);
    expect(isRole(null)).toBe(false);
  });

  it("projects public rows without password data and supplies legacy defaults", () => {
    const row = user({ global_role: undefined as never, is_primary_super_admin: undefined as never });
    const projected = toPublicUser(row);

    expect(projected).toEqual({
      id: "user-1",
      email: "user@example.com",
      name: "User",
      status: "active",
      email_verified: true,
      global_role: "user",
      is_primary_super_admin: false,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect("password_hash" in projected).toBe(false);
    expect(toPublicUser(user({ email_verified_at: null })).email_verified).toBe(false);
    expect(toPublicTenant(tenant())).toEqual({ id: "tenant-1", slug: "example-org", name: "Example Org", status: "active" });
  });

  it("normalizes and bounds slugs, with a non-empty fallback", () => {
    expect(slugify("  An Example__Org!!  ")).toBe("an-example-org");
    expect(slugify(`a${"b".repeat(80)}`)).toHaveLength(48);
    expect(slugify("---")).toMatch(/^org-[0-9a-f]{8}$/);
  });

  it("exposes stable typed error names and messages", () => {
    expect(new LastOwnerError()).toMatchObject({ name: "LastOwnerError", message: expect.stringContaining("at least one") });
    expect(new SlugTakenError("taken")).toMatchObject({ name: "SlugTakenError", slug: "taken", message: expect.stringContaining("taken") });
    expect(new EmailTakenError()).toMatchObject({ name: "EmailTakenError", message: expect.stringContaining("already exists") });
  });
});

describe("credential and session resolution", () => {
  it("fails closed for missing API-key and IdP mappings and maps a live IdP principal", async () => {
    const { client } = fakeClient({
      get(sql, params) {
        if (sql.includes("api_key_tenants")) return params[0] === "known-kid" ? { tenant_id: "tenant-1" } : null;
        if (sql.includes("idp_principal_tenants")) {
          return params[0] === "known-sub"
            ? { sub: "known-sub", tenant_id: "tenant-1", idp_tid: "idp-tenant", principal_type: "user", revoked_at: null }
            : null;
        }
        return null;
      },
    });
    const store = new AuthStore(client);

    expect(await store.getApiKeyTenant("missing")).toBeNull();
    expect(await store.getApiKeyTenant("known-kid")).toBe("tenant-1");
    expect(await store.getIdpPrincipalTenant("missing")).toBeNull();
    expect(await store.getIdpPrincipalTenant("known-sub")).toEqual({
      sub: "known-sub",
      tenantId: "tenant-1",
      idpTid: "idp-tenant",
      principalType: "user",
      revokedAt: null,
    });
  });

  it("upserts default IdP fields and reports whether revocation changed a row", async () => {
    const { client, calls } = fakeClient({ query: (_sql, params) => ({ rows: [], rowCount: params[0] === "live" ? 1 : 0 }) });
    const store = new AuthStore(client);

    await store.upsertIdpPrincipalTenant({ sub: "subject", tenantId: "tenant-1" });
    expect(calls[0]?.params).toEqual(["subject", "tenant-1", null, "service", null, null]);
    expect(await store.revokeIdpPrincipalTenant("live")).toBe(true);
    expect(await store.revokeIdpPrincipalTenant("missing")).toBe(false);
  });

  it("returns null without sliding an invalid session and caps a live idle slide at absolute expiry", async () => {
    const missing = fakeClient();
    expect(await new AuthStore(missing.client, { now: () => NOW }).resolveSession("bad-token")).toBeNull();
    expect(missing.calls.some((call) => call.method === "execute")).toBe(false);

    const live = fakeClient({
      get: () => ({
        session_id: "session-1",
        user_id: "user-1",
        tenant_id: "tenant-1",
        role: "admin",
        global_role: null,
        absolute_expires_at: "2026-07-30T00:00:00.000Z",
      }),
    });
    const context = await new AuthStore(live.client, {
      now: () => NOW,
      env: { EMAILS_SESSION_IDLE_TTL_DAYS: "14" },
    }).resolveSession("live-token");

    expect(context).toEqual({ sessionId: "session-1", userId: "user-1", tenantId: "tenant-1", role: "admin", globalRole: "user" });
    const slide = live.calls.find((call) => call.method === "execute" && call.sql.includes("UPDATE sessions SET expires_at"));
    expect(slide?.params).toEqual(["session-1", "2026-07-30T00:00:00.000Z"]);
  });
});

describe("users, passwords, and lockout", () => {
  it("verifies a real password, rejects a wrong password, and refuses inactive users", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");
    let current = user({ password_hash: passwordHash });
    const { client } = fakeClient({ get: () => current });
    const store = new AuthStore(client);

    expect((await store.verifyLogin(" user@example.com ", "correct horse battery staple"))?.id).toBe("user-1");
    expect(await store.verifyLogin("user@example.com", "wrong password")).toBeNull();
    current = user({ password_hash: passwordHash, status: "suspended" });
    expect(await store.verifyLogin("user@example.com", "correct horse battery staple")).toBeNull();
  }, 20_000);

  it("computes lock state against the injected clock", async () => {
    const store = new AuthStore(fakeClient().client, { now: () => NOW });
    expect(await store.isLocked(user({ locked_until: null }))).toBe(false);
    expect(await store.isLocked(user({ locked_until: "2026-07-29T12:00:01.000Z" }))).toBe(true);
    expect(await store.isLocked(user({ locked_until: "2026-07-29T11:59:59.000Z" }))).toBe(false);
  });

  it("ignores a vanished user, starts lockout on strike five, and caps it at one hour", async () => {
    let current: UserRow | null = null;
    const { client, calls } = fakeClient({ get: () => current });
    const store = new AuthStore(client, { now: () => NOW });

    await store.recordFailedLogin("missing");
    expect(calls.some((call) => call.method === "execute")).toBe(false);
    current = user({ failed_login_count: 4 });
    await store.recordFailedLogin("user-1");
    current = user({ failed_login_count: 20 });
    await store.recordFailedLogin("user-1");
    const updates = calls.filter((call) => call.method === "execute");
    expect(updates[0]?.params).toEqual(["user-1", 5, "2026-07-29T12:05:00.000Z"]);
    expect(updates[1]?.params).toEqual(["user-1", 21, "2026-07-29T13:00:00.000Z"]);

    await store.clearFailedLogins("user-1");
    await store.setPasswordHash("user-1", "new-hash");
    expect(calls.some((call) => call.sql.includes("failed_login_count = 0"))).toBe(true);
    expect(calls.at(-1)?.params).toEqual(["user-1", "new-hash"]);
  });
});

describe("tenant and membership guards", () => {
  it("creates an owner tenant with trimmed input and rejects an existing email", async () => {
    const created = fakeClient({
      get(sql) {
        if (sql.includes("FROM tenants WHERE slug")) return null;
        if (sql.includes("FROM users WHERE email")) return null;
        return null;
      },
      one(sql) {
        if (sql.includes("INSERT INTO tenants")) return tenant();
        if (sql.includes("INSERT INTO users")) return user({ email_verified_at: null });
        if (sql.includes("INSERT INTO memberships")) return membership();
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });
    const result = await new AuthStore(created.client).createTenantWithOwner({
      email: " owner@example.com ",
      passwordHash: "hash",
      tenantName: " Example Org ",
    });
    expect(result).toMatchObject({ tenant: { id: "tenant-1" }, user: { id: "user-1" }, membership: { role: "owner" } });
    expect(created.calls.find((call) => call.sql.includes("INSERT INTO users"))?.params).toEqual(["owner@example.com", "hash", null]);

    const duplicate = fakeClient({
      get(sql) {
        return sql.includes("FROM users WHERE email") ? { id: "already-there" } : null;
      },
    });
    await expect(new AuthStore(duplicate.client).createTenantWithOwner({
      email: "owner@example.com",
      passwordHash: "hash",
      tenantName: "Example Org",
    })).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("retries colliding slugs and throws after the bounded fifth collision", async () => {
    let checks = 0;
    const retry = fakeClient({
      get(sql) {
        if (sql.includes("FROM tenants WHERE slug")) return checks++ === 0 ? { id: "taken" } : null;
        return null;
      },
      one(sql, params) {
        if (sql.includes("INSERT INTO tenants")) return tenant({ slug: String(params[0]) });
        return membership();
      },
    });
    const result = await new AuthStore(retry.client).createTenantForUser("user-1", "Example Org");
    expect(result.tenant.slug).toMatch(/^example-org-[0-9a-f]{8}$/);

    const exhausted = fakeClient({ get: () => ({ id: "taken" }) });
    await expect(new AuthStore(exhausted.client).createTenantForUser("user-1", "Example Org")).rejects.toBeInstanceOf(SlugTakenError);
    expect(exhausted.calls.filter((call) => call.method === "get")).toHaveLength(5);
  });

  it("returns the current tenant for an empty patch and refuses a duplicate slug", async () => {
    const current = fakeClient({ get: () => tenant() });
    expect(await new AuthStore(current.client).updateTenant("tenant-1", {})).toEqual(tenant());

    const duplicate = fakeClient({ get: () => ({ id: "other-tenant" }) });
    await expect(new AuthStore(duplicate.client).updateTenant("tenant-1", { slug: "Taken Slug" })).rejects.toMatchObject({
      name: "SlugTakenError",
      slug: "taken-slug",
    });
  });

  it("refuses demoting or removing the last owner and performs revocations when another owner remains", async () => {
    const lastOwner = fakeClient({
      get(sql) {
        if (sql.includes("count(*)")) return { n: 1 };
        return membership();
      },
    });
    const guarded = new AuthStore(lastOwner.client);
    await expect(guarded.changeMembershipRole("membership-1", "admin")).rejects.toBeInstanceOf(LastOwnerError);
    await expect(guarded.removeMembership("membership-1")).rejects.toBeInstanceOf(LastOwnerError);

    const removable = fakeClient({
      get(sql) {
        if (sql.includes("count(*)")) return { n: 2 };
        if (sql.includes("UPDATE memberships")) return membership({ role: "admin" });
        return membership();
      },
    });
    const store = new AuthStore(removable.client);
    expect(await store.changeMembershipRole("membership-1", "admin")).toMatchObject({ role: "admin" });
    expect(await store.removeMembership("membership-1")).toEqual({ removed: true });
    expect(removable.calls.some((call) => call.sql.includes("UPDATE api_keys SET revoked_at"))).toBe(true);
    expect(removable.calls.some((call) => call.sql.includes("UPDATE sessions SET revoked_at"))).toBe(true);
  });

  it("returns null/false for missing memberships and counts missing owners as zero", async () => {
    const { client } = fakeClient();
    const store = new AuthStore(client);
    expect(await store.changeMembershipRole("missing", "viewer")).toBeNull();
    expect(await store.removeMembership("missing")).toEqual({ removed: false });
    expect(await store.countActiveOwners("tenant-1")).toBe(0);
  });
});

describe("session and token lifecycle", () => {
  it("mints configured session expiries, sanitizes invalid IPs, and hashes logout tokens", async () => {
    const { client, calls } = fakeClient({ one: () => ({ id: "session-1" }) });
    const store = new AuthStore(client, {
      now: () => NOW,
      env: { EMAILS_SESSION_IDLE_TTL_DAYS: "2", EMAILS_SESSION_ABSOLUTE_TTL_DAYS: "10" },
    });

    const created = await store.createSession("user-1", "tenant-1", { userAgent: "test", ip: "not an ip" });
    expect(created).toMatchObject({
      sessionId: "session-1",
      expiresAt: "2026-07-31T12:00:00.000Z",
      absoluteExpiresAt: "2026-08-08T12:00:00.000Z",
    });
    expect(created.token.length).toBeGreaterThan(20);
    expect(calls[0]?.params.at(-1)).toBeNull();

    await store.revokeSession("session-1");
    await store.revokeSessionByToken("plaintext-token");
    await store.revokeAllUserSessions("user-1");
    const tokenRevoke = calls.find((call) => call.sql.includes("WHERE token_hash"));
    expect(tokenRevoke?.params[0]).not.toBe("plaintext-token");
    expect(String(tokenRevoke?.params[0])).toHaveLength(64);
  });

  it("mints verification/reset/invite tokens with configured expiries and never stores plaintext", async () => {
    let ids = 0;
    const { client, calls } = fakeClient({ one: () => ({ id: `token-${++ids}` }) });
    const store = new AuthStore(client, {
      now: () => NOW,
      env: {
        EMAILS_EMAIL_VERIFY_TTL_HOURS: "2",
        EMAILS_RESET_TTL_MINUTES: "30",
        EMAILS_INVITE_TTL_HOURS: "4",
      },
    });

    const verify = await store.createEmailVerification("user-1", " verify@example.com ");
    const reset = await store.createPasswordReset("user-1");
    const invite = await store.createInvitation({ tenantId: "tenant-1", email: " invite@example.com ", role: "viewer", invitedBy: null });
    expect(verify.expiresAt).toBe("2026-07-29T14:00:00.000Z");
    expect(reset.expiresAt).toBe("2026-07-29T12:30:00.000Z");
    expect(invite.expiresAt).toBe("2026-07-29T16:00:00.000Z");
    for (const minted of [verify, reset, invite]) {
      expect(minted.token.length).toBeGreaterThan(20);
      expect(calls.some((call) => call.params.includes(minted.token))).toBe(false);
    }
    expect(calls.some((call) => call.params.includes("verify@example.com"))).toBe(true);
    expect(calls.some((call) => call.params.includes("invite@example.com"))).toBe(true);
  });

  it("does not compute a reset hash for an invalid token and revokes sessions after a valid reset", async () => {
    let valid = false;
    let hashes = 0;
    const { client, calls } = fakeClient({ get: () => valid ? { user_id: "user-1" } : null });
    const store = new AuthStore(client, { now: () => NOW });
    expect(await store.consumePasswordReset("bad", async () => { hashes += 1; return "hash"; })).toBe(false);
    expect(hashes).toBe(0);
    valid = true;
    expect(await store.consumePasswordReset("good", async () => { hashes += 1; return "new-hash"; })).toBe(true);
    expect(hashes).toBe(1);
    expect(calls.some((call) => call.sql.includes("UPDATE users SET password_hash"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE sessions SET revoked_at"))).toBe(true);
  });

  it("consumes verification once and refuses missing or unverified primary identities", async () => {
    let verificationExists = false;
    const verifiedUser = user();
    const verification = fakeClient({
      get(sql) {
        if (sql.includes("email_verification_tokens")) return verificationExists ? { id: "verify-1", user_id: "user-1", email: "user@example.com" } : null;
        if (sql.includes("UPDATE users")) return verifiedUser;
        return null;
      },
    });
    const store = new AuthStore(verification.client, { now: () => NOW });
    expect(await store.consumeEmailVerification("missing")).toBeNull();
    verificationExists = true;
    expect(await store.consumeEmailVerification("valid")).toEqual(verifiedUser);

    const unverifiedIdentity: UserEmailIdentity = {
      id: "identity-1", user_id: "user-1", email: "other@example.com", is_primary: false,
      verified_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    const identityClient = fakeClient({ get: () => unverifiedIdentity });
    expect(await new AuthStore(identityClient.client).makePrimaryEmailIdentity("user-1", "identity-1")).toBeNull();
    expect(identityClient.calls.some((call) => call.method === "execute")).toBe(false);
  });

  it("returns invitation refusal reasons and accepts an existing user without requiring a password", async () => {
    let invite: { id: string; tenant_id: string; email: string; role: "viewer" } | null = null;
    const existing = user();
    const { client, calls } = fakeClient({
      get(sql) {
        if (sql.includes("FROM invitations")) return invite;
        if (sql.includes("FROM users")) return existing;
        return null;
      },
    });
    const store = new AuthStore(client, { now: () => NOW });
    expect(await store.acceptInvitation({ token: "bad" })).toEqual({ error: "invalid" });
    invite = { id: "invite-1", tenant_id: "tenant-1", email: "user@example.com", role: "viewer" };
    expect(await store.acceptInvitation({ token: "good" })).toEqual({ user: existing, tenantId: "tenant-1", role: "viewer" });
    expect(calls.some((call) => call.sql.includes("INSERT INTO memberships"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE invitations SET accepted_at"))).toBe(true);

    const newUser = fakeClient({
      get(sql) {
        if (sql.includes("FROM invitations")) return invite;
        return null;
      },
    });
    expect(await new AuthStore(newUser.client, { now: () => NOW }).acceptInvitation({ token: "good" })).toEqual({ error: "needs_password" });
  });
});
