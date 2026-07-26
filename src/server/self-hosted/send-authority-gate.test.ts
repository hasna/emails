// Within-tenant privilege escalation via send authority.
//
// A send key decides which of the tenant's from-addresses its holder may send
// as, and `owner_id`/`administrator_id` on an address decides who owns it. Both
// are therefore privilege-GRANTING operations, not ordinary data writes — but
// both were gated on `emails:write` alone, which `scopesForRole` hands to every
// role down to `member`. So a member could:
//
//   - POST /v1/send-keys/mint with a caller-supplied `owner_id` and get a key
//     scoped to ANOTHER owner's addresses (no role check, no check that the
//     caller is that owner), then send as those addresses — minting their way
//     around the only control that stops exactly that; or
//   - PATCH /v1/addresses/{id} with `owner_id` and simply reassign the address.
//
// Both now require a tenant owner/admin, or the wildcard operator scope for
// non-interactive automation. Hermetic: fake query client, no Postgres.

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

function fakeClient(): TypedQueryClient {
  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string): Promise<T[]> {
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      return [] as T[];
    },
    async get<T>(sql: string): Promise<T | null> {
      if (sql.includes("SELECT 1")) return { ok: 1 } as unknown as T;
      return null;
    },
    async one<T>(): Promise<T> {
      return {} as T;
    },
    async execute() {},
  };
  return client;
}

type Role = "owner" | "admin" | "member" | "viewer";

const SESSION_TOKENS: Record<Role, string> = {
  owner: "emss_session_owner",
  admin: "emss_session_admin",
  member: "emss_session_member",
  viewer: "emss_session_viewer",
};

interface Spy {
  minted: unknown[];
  ownershipPatches: unknown[];
  addressUpdates: unknown[];
  resourceWrites: string[];
}

function deps(): { d: SelfHostedServiceDeps; spy: Spy } {
  const client = fakeClient();
  const spy: Spy = { minted: [], ownershipPatches: [], addressUpdates: [], resourceWrites: [] };
  const d: SelfHostedServiceDeps = {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
  };

  // Session credentials for each membership role.
  d.authStore.resolveSession = (async (token: string) => {
    const entry = (Object.entries(SESSION_TOKENS) as Array<[Role, string]>).find(([, value]) => value === token);
    if (!entry) return null;
    return { tenantId: "tenant-a", userId: `user-${entry[0]}`, role: entry[0], globalRole: null };
  }) as typeof d.authStore.resolveSession;

  const address = (patch: Record<string, unknown> = {}) => ({
    id: "addr-1",
    email: "shared@example.com",
    domain: "example.com",
    display_name: null,
    status: "active",
    verified: false,
    daily_quota: null,
    owner_id: null,
    administrator_id: null,
    created_at: "t",
    updated_at: "t",
    ...patch,
  });

  d.store.mintSendKey = (async (input: unknown) => {
    spy.minted.push(input);
    const owner = (input as { owner_id: string }).owner_id;
    return {
      token: "esk_ONE_TIME",
      key: {
        id: "key-1", owner_id: owner, prefix: "esk_ONE", label: null,
        last_used_at: null, revoked_at: null, created_at: "t", updated_at: "t",
      },
    };
  }) as typeof d.store.mintSendKey;

  d.store.updateAddress = (async (_id: string, patch: unknown) => {
    spy.addressUpdates.push(patch);
    return address();
  }) as typeof d.store.updateAddress;

  d.store.applyAddressOwnership = (async (_id: string, patch: unknown) => {
    spy.ownershipPatches.push(patch);
    return address(patch as Record<string, unknown>);
  }) as typeof d.store.applyAddressOwnership;

  // Generic /v1/<resource> CRUD. Any call here means the request reached the
  // store, which for an authority-bearing resource IS the escalation.
  d.store.createResource = (async (spec: { path: string }, body: unknown) => {
    spy.resourceWrites.push(`create ${spec.path} ${JSON.stringify(body)}`);
    return { id: "row-1", ...(body as Record<string, unknown>) };
  }) as typeof d.store.createResource;
  d.store.updateResource = (async (spec: { path: string }, id: string, body: unknown) => {
    spy.resourceWrites.push(`update ${spec.path}/${id} ${JSON.stringify(body)}`);
    return { id, ...(body as Record<string, unknown>) };
  }) as typeof d.store.updateResource;
  d.store.deleteResource = (async (spec: { path: string }, id: string) => {
    spy.resourceWrites.push(`delete ${spec.path}/${id}`);
    return true;
  }) as typeof d.store.deleteResource;
  d.store.listResource = (async () => []) as typeof d.store.listResource;
  d.store.getResource = (async (_spec: unknown, id: string) => ({ id, owner_id: "o1" })) as typeof d.store.getResource;

  return { d, spy };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** A key with the ordinary data-write grant only — NOT the operator wildcard. */
const writeScopedKey = () => mintApiKey({ app: "emails", scopes: ["emails:write"], signingSecret: SIGNING_SECRET }).token;
/** Non-interactive operator automation. */
const operatorKey = () => mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;

describe("POST /v1/send-keys/mint is owner/admin-only", () => {
  test("a member cannot mint a send key for another owner", async () => {
    const { d, spy } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/send-keys/mint", { token: SESSION_TOKENS.member, body: { owner_id: "someone-elses-owner" } }),
    );

    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "operator_required" });
    // The escalation is the minted token, so nothing may reach the store.
    expect(spy.minted).toEqual([]);
  });

  test("a viewer and a write-scoped API key are refused too", async () => {
    const { d, spy } = deps();

    const viewer = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/send-keys/mint", { token: SESSION_TOKENS.viewer, body: { owner_id: "o1" } }),
    );
    // A viewer lacks `emails:write` outright, so it never reaches the role gate.
    expect(viewer?.status).toBe(403);

    const writeKey = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/send-keys/mint", { token: writeScopedKey(), body: { owner_id: "o1" } }),
    );
    expect(writeKey?.status).toBe(403);
    expect(await writeKey!.json()).toMatchObject({ reason: "operator_required" });

    expect(spy.minted).toEqual([]);
  });

  test("the role gate runs before the owner_id shape check, so it cannot be probed", async () => {
    const { d } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/send-keys/mint", { token: SESSION_TOKENS.member, body: {} }),
    );

    // A 400 here would confirm to a member that only the payload was wrong.
    expect(res?.status).toBe(403);
  });

  test("an owner, an admin, and an operator API key still mint", async () => {
    for (const token of [SESSION_TOKENS.owner, SESSION_TOKENS.admin, operatorKey()]) {
      const { d, spy } = deps();
      const res = await handleSelfHostedRequest(
        d,
        req("POST", "/v1/send-keys/mint", { token, body: { owner_id: "o1", label: "ci" } }),
      );

      expect(res?.status).toBe(201);
      expect((await res!.json()).token).toBe("esk_ONE_TIME");
      expect(spy.minted).toEqual([{ owner_id: "o1", label: "ci" }]);
    }
  });
});

describe("PATCH /v1/addresses/{id} ownership reassignment is owner/admin-only", () => {
  test("a member cannot reassign owner_id or administrator_id", async () => {
    for (const body of [{ owner_id: "someone-else" }, { administrator_id: "someone-else" }, { owner_id: null }]) {
      const { d, spy } = deps();

      const res = await handleSelfHostedRequest(
        d,
        req("PATCH", "/v1/addresses/addr-1", { token: SESSION_TOKENS.member, body }),
      );

      expect(res?.status).toBe(403);
      expect(await res!.json()).toMatchObject({ reason: "operator_required" });
      expect(spy.ownershipPatches).toEqual([]);
      // Refused BEFORE any write, so no partial update is left behind.
      expect(spy.addressUpdates).toEqual([]);
    }
  });

  test("a write-scoped API key cannot reassign ownership either", async () => {
    const { d, spy } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("PATCH", "/v1/addresses/addr-1", { token: writeScopedKey(), body: { owner_id: "someone-else" } }),
    );

    expect(res?.status).toBe(403);
    expect(spy.ownershipPatches).toEqual([]);
  });

  test("a member can still patch the ordinary address fields", async () => {
    const { d, spy } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("PATCH", "/v1/addresses/addr-1", { token: SESSION_TOKENS.member, body: { display_name: "Shared", status: "active" } }),
    );

    expect(res?.status).toBe(200);
    expect(spy.addressUpdates).toHaveLength(1);
    expect(spy.ownershipPatches).toEqual([]);
  });

  test("an owner, an admin, and an operator API key still reassign ownership", async () => {
    for (const token of [SESSION_TOKENS.owner, SESSION_TOKENS.admin, operatorKey()]) {
      const { d, spy } = deps();
      const res = await handleSelfHostedRequest(
        d,
        req("PATCH", "/v1/addresses/addr-1", { token, body: { owner_id: "o2" } }),
      );

      expect(res?.status).toBe(200);
      expect((await res!.json()).address.owner_id).toBe("o2");
      expect(spy.ownershipPatches).toEqual([{ owner_id: "o2" }]);
    }
  });
});

// ---- the generic CRUD matcher must not reach around the bespoke gates --------

describe("the generic /v1 resource matcher cannot reach around the send-authority gates", () => {
  // `send-keys` and `address-ownership-events` are ALSO registered generic
  // resources, and the generic matcher gates writes on `emails:write` alone. So
  // role-gating only `POST /v1/send-keys/mint` and `PATCH /v1/addresses/{id}`
  // would be decorative: a member just uses `/v1/send-keys/{id}` instead.
  //
  // `evaluateOutboundPolicy` reads `send_keys.owner_id` LIVE at send time, so
  // repointing an existing key at another owner is the same escalation as minting
  // one. `{"revoked_at": null}` resurrects a revoked key, and a generic DELETE
  // destroys another owner's key.
  test("a member cannot repoint, resurrect, create, or destroy a send key generically", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["PATCH", "/v1/send-keys/key-1", { owner_id: "victim-owner" }],
      ["PUT", "/v1/send-keys/key-1", { owner_id: "victim-owner" }],
      ["PATCH", "/v1/send-keys/key-1", { revoked_at: null }],
      ["POST", "/v1/send-keys", { owner_id: "victim-owner" }],
      ["DELETE", "/v1/send-keys/key-1", undefined],
    ];

    for (const [method, path, body] of cases) {
      const { d, spy } = deps();
      const res = await handleSelfHostedRequest(d, req(method, path, { token: SESSION_TOKENS.member, ...(body === undefined ? {} : { body }) }));

      expect(res?.status).toBe(403);
      expect(await res!.json()).toMatchObject({ reason: "operator_required" });
      expect(spy.resourceWrites).toEqual([]);
    }
  });

  test("a write-scoped API key is refused generically too", async () => {
    const { d, spy } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("PATCH", "/v1/send-keys/key-1", { token: writeScopedKey(), body: { owner_id: "victim-owner" } }),
    );

    expect(res?.status).toBe(403);
    expect(spy.resourceWrites).toEqual([]);
  });

  test("a member cannot forge rows in the address-ownership audit trail", async () => {
    const { d, spy } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/address-ownership-events", {
        token: SESSION_TOKENS.member,
        body: { id: "evt-1", address_id: "addr-1", action: "transfer", owner_id: "attacker", actor: "someone-else" },
      }),
    );

    // The trail is the record OF the operation the gate protects; a member who
    // cannot reassign ownership must not be able to write "reassigned by X".
    expect(res?.status).toBe(403);
    expect(spy.resourceWrites).toEqual([]);
  });

  test("a member can still read send keys and the audit trail", async () => {
    const { d } = deps();

    for (const path of ["/v1/send-keys", "/v1/send-keys/key-1", "/v1/address-ownership-events"]) {
      const res = await handleSelfHostedRequest(d, req("GET", path, { token: SESSION_TOKENS.member }));
      expect(res?.status).toBe(200);
    }
  });

  test("an owner and an operator API key still write both resources generically", async () => {
    for (const token of [SESSION_TOKENS.owner, operatorKey()]) {
      const { d, spy } = deps();

      const patched = await handleSelfHostedRequest(d, req("PATCH", "/v1/send-keys/key-1", { token, body: { label: "renamed" } }));
      expect(patched?.status).toBe(200);

      const evented = await handleSelfHostedRequest(d, req("POST", "/v1/address-ownership-events", { token, body: { id: "evt-1", action: "transfer" } }));
      expect(evented?.status).toBe(201);

      expect(spy.resourceWrites).toHaveLength(2);
    }
  });

  test("an ordinary resource is untouched by the flag and stays plain emails:write", async () => {
    const { d, spy } = deps();

    const res = await handleSelfHostedRequest(
      d,
      req("PATCH", "/v1/contacts/c1", { token: SESSION_TOKENS.member, body: { name: "Renamed" } }),
    );

    expect(res?.status).toBe(200);
    expect(spy.resourceWrites).toEqual(['update contacts/c1 {"name":"Renamed"}']);
  });
});
