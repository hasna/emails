// Every MCP tool whose `assert*Allowed()` mode guard was deleted, driven END TO END
// against a real `/v1` service.
//
// TWO FIXTURES, and which one a block uses is a property of the CLIENT it exercises. Most of
// this file drives the out-of-process stub (src/test-support/v1-stub.ts). The ALIAS block does
// not: that family has collapsed onto the store seam and now reaches `/v1` through the real
// `HttpEmailStore`, which validates every filter and every write column against the service's
// published contract — something the stub serves only on request and then does not honour for
// filtered reads. That block uses src/test-support/v1-store-api.ts instead, and its own
// docblock says why. The discipline below is unchanged for both.
//
// WHY THIS FILE EXISTS. Each of these tools already had three of the four pieces it
// needed in self_hosted mode: a `/v1` route in src/server/self-hosted/resources.ts, a
// client that could reach it (an HTTP arm module at the time, the store seam now), and
// a CLI twin that performs the SAME operation over the SAME route and succeeds. The fourth piece — the guard —
// refused before any of it ran. Deleting the guard was the entire fix, so the proof
// has to be the tool doing real work against a real server, not the absence of a
// refusal string: an assertion that merely checked `isError` is false would also pass
// against a tool that silently fell back to local SQLite.
//
// Each test therefore pins the tool to SERVER state in one of two directions, never
// to a tool-to-tool round-trip (which a self-consistent local store would also
// satisfy):
//   - writes  read the resulting row back OFF THE STUB via `stub.list(...)`;
//   - reads   are given rows seeded STRAIGHT onto the stub, carrying values no tool
//             in the test ever wrote, so the data can only have come off the wire.
// On unmodified main every one of these tests fails with a refusal.
//
// NOT HERE, deliberately: `get_dns_records` and `verify_domain` keep their guard.
// They call a provider ADAPTER rather than a repository; with a real `/v1/providers`
// row of type `ses` the adapter would resolve credentials from the CLIENT's ambient
// AWS environment, because the server schema has no credential columns. That
// credential fallback is the whole reason and it stands on its own — neither tool
// has a `/v1` route, so this is not a guard in front of a working one.
//
// The CLI twins are NOT symmetric with it, and this comment used to claim they were:
// `emails domain verify` refuses, but `emails domain dns` RUNS in both
// configurations — it is a read, and its no-provider arm needs no credentials at
// all. So the refusal does NOT "match a command that also cannot run"; it matches
// a surface whose ambient environment is not the operator's shell.
// src/mcp/domain-address-self-hosted.test.ts pins the guard itself.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { API_BASE_URL_SETTING, API_CREDENTIAL_SETTINGS, DATABASE_PATH_SETTINGS } from "../store-resolution.js";
import { buildServer } from "./server.js";
import { runDomainTool } from "./tools/domains-impl.js";

const NOW = "2026-07-20T00:00:00.000Z";

const SEED = {
  domains: [
    { id: "domain-1", domain: "acme.example", status: "ready", provider: "ses", verified: true, created_at: NOW, updated_at: NOW },
  ],
  addresses: [
    { id: "address-1", email: "ops@acme.example", domain: "acme.example", display_name: "Ops", status: "active", verified: true, daily_quota: null, created_at: NOW, updated_at: NOW },
  ],
  groups: [
    { id: "group-1", name: "beta-testers", description: null, created_at: NOW, updated_at: NOW },
  ],
  sequences: [
    { id: "sequence-1", name: "onboarding", description: null, status: "active", created_at: NOW, updated_at: NOW },
  ],
};

let stub: V1Stub;

async function callTool(name: string, args: Record<string, unknown>) {
  const server = buildServer() as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
  };
  return await server._registeredTools[name]!.handler(args);
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

/** Assert success and return the parsed payload, surfacing the error text on failure. */
function ok<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
  expect(text(result)).not.toContain("self_hosted API-only mode");
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result) || "{}") as T;
}

beforeAll(async () => {
  stub = await startV1Stub({ seed: structuredClone(SEED) });
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

/**
 * THE ALIAS TOOLS DO NOT USE THE STUB ANY MORE, and the reason is a property of the fixture
 * rather than of the tools.
 *
 * `src/db/aliases.ts` has collapsed onto the store seam, so these five tools now reach `/v1`
 * through the REAL `HttpEmailStore`. That store reads `GET /v1/openapi.json` before any
 * filtered list and before any write — the published contract is its only source of truth for
 * which columns a resource accepts and which query parameters its list route filters on — and
 * this fixture serves that document only on request. Worse, when it does serve it, its generic
 * list handler still IGNORES equality filters and answers with the UNFILTERED list, which the
 * collapsed module correctly treats as a FAULT (a superset presented as a filtered result is a
 * wrong answer, not a value). The fixture's own documentation says exactly this and points at
 * `src/test-support/v1-store-api.ts` for filtered or paged store-seam work.
 *
 * So this block drives a `/v1` service that translates HTTP into the same store seam. It stores
 * nothing of its own, and the assertions keep this file's discipline unchanged: writes are read
 * back off the SERVER's table, and reads are given rows seeded STRAIGHT into that table carrying
 * values no tool here ever wrote — so the data can only have come off the wire. What changes is
 * which `/v1` implementation answers, not what is proved.
 *
 * The environment is pointed at that service INSIDE this block, after the file-wide
 * `stub.applyEnv()` has run, and put back by the file-wide `clearEnv()`. Exactly one store stays
 * configured throughout: the database path is opened first and then removed from the
 * environment, because a path AND an API together are a hard boot error with no precedence rule.
 */
describe("MCP alias tools in self_hosted mode (twins of `emails alias …`)", () => {
  let db: Database;
  let api: V1StoreApi;

  /** Alias rows as the SERVER holds them, read without going through any tool. */
  async function serverAliases(): Promise<Array<Record<string, unknown>>> {
    const listed = await createSqliteEmailStore({ database: db }).aliases.list({ limit: 500 });
    if (!listed.ok) throw new Error(`could not read the server's aliases: ${listed.message}`);
    return listed.value;
  }

  function seedServerAlias(id: string, domain: string, localPart: string, target: string): void {
    db.run(
      "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at)"
        + " VALUES (?, ?, ?, ?, 0, ?, ?)",
      [id, domain, localPart, target, NOW, NOW],
    );
  }

  beforeEach(() => {
    // The database is opened while its path is the only configured store, and the path is then
    // removed — the handle stays open inside the service below, so the tools see exactly one
    // configured store (the API) and still read one dataset.
    for (const setting of [API_BASE_URL_SETTING, ...API_CREDENTIAL_SETTINGS]) delete process.env[setting];
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    db = getDatabase();
    // The migration seeds a protected global catch-all with an EMPTY target. It is deleted here
    // so each case starts from a table holding only what it puts there; the seam-level suite
    // (src/db/aliases.test.ts) is where that row's presence is pinned.
    db.run("DELETE FROM aliases");
    api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "mcp alias fixture" }) });
    for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
    process.env[API_BASE_URL_SETTING] = api.baseUrl;
    process.env[API_CREDENTIAL_SETTINGS[1] as string] = api.apiKey;
  });

  afterEach(() => {
    api.stop();
    closeDatabase();
  });

  it("add_alias writes the routing row through /v1/aliases", async () => {
    const alias = ok<{ domain: string; local_part: string; target_address: string }>(
      await runDomainTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" }),
    );

    expect(alias).toMatchObject({ domain: "acme.example", local_part: "hello", target_address: "ops@acme.example" });
    expect(await serverAliases()).toMatchObject([
      { domain: "acme.example", local_part: "hello", target_address: "ops@acme.example" },
    ]);
  });

  it("add_catch_all writes the domain catch-all through /v1/aliases", async () => {
    ok(await runDomainTool("add_catch_all", { domain: "acme.example", target: "ops@acme.example" }));

    expect(await serverAliases()).toMatchObject([{ domain: "acme.example", local_part: "*" }]);
  });

  it("list_aliases returns rows that only ever existed ON THE SERVER", async () => {
    // Seeded straight into the server's table rather than written through a tool, so this
    // proves the SERVER -> tool direction. A tool→tool round-trip would also pass against a
    // self-consistent local store; this cannot.
    seedServerAlias("alias-seeded-1", "acme.example", "sales", "ops@acme.example");
    seedServerAlias("alias-seeded-2", "acme.example", "hello", "ops@acme.example");

    const aliases = ok<Array<{ id: string; local_part: string }>>(await runDomainTool("list_aliases", { domain: "acme.example" }));

    expect(aliases.map((a) => a.local_part)).toEqual(["hello", "sales"]);
    expect(aliases.map((a) => a.id).sort()).toEqual(["alias-seeded-1", "alias-seeded-2"]);
  });

  it("resolve_alias resolves against a routing table only the SERVER holds", async () => {
    seedServerAlias("alias-seeded-1", "acme.example", "hello", "seeded-target@acme.example");

    // The target is a value no tool in this test ever wrote, so it can only have come off the
    // wire.
    expect(ok(await runDomainTool("resolve_alias", { recipient: "hello@acme.example" })))
      .toEqual({ recipient: "hello@acme.example", target: "seeded-target@acme.example" });
    // A recipient with no alias resolves to null rather than erroring.
    expect(ok(await runDomainTool("resolve_alias", { recipient: "nobody@acme.example" })))
      .toEqual({ recipient: "nobody@acme.example", target: null });
  });

  it("remove_alias deletes the row from /v1/aliases", async () => {
    const created = ok<{ id: string }>(await runDomainTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" }));

    const removed = await runDomainTool("remove_alias", { alias_id: created.id });

    expect(removed.isError).toBeFalsy();
    expect(text(removed)).toContain("hello@acme.example");
    expect(await serverAliases()).toEqual([]);
  });
});

describe("MCP address-lifecycle tools in self_hosted mode (twins of `emails address …`)", () => {
  async function storedAddress(): Promise<Record<string, unknown> | undefined> {
    return (await stub.list("addresses")).find((row) => row["id"] === "address-1");
  }

  it("suspend_address and activate_address PATCH the status server-side", async () => {
    ok(await runDomainTool("suspend_address", { address_id: "address-1" }));
    expect(await storedAddress()).toMatchObject({ status: "suspended" });

    ok(await runDomainTool("activate_address", { address_id: "address-1" }));
    expect(await storedAddress()).toMatchObject({ status: "active" });
  });

  it("set_address_quota writes and clears the quota server-side", async () => {
    ok(await runDomainTool("set_address_quota", { address_id: "address-1", per_day: 25 }));
    expect(await storedAddress()).toMatchObject({ daily_quota: 25 });

    ok(await runDomainTool("set_address_quota", { address_id: "address-1", per_day: null }));
    expect((await storedAddress())?.["daily_quota"] ?? null).toBeNull();
  });

  it("remove_address deletes the row from /v1/addresses", async () => {
    const removed = await runDomainTool("remove_address", { address_id: "address-1" });

    expect(removed.isError).toBeFalsy();
    expect(text(removed)).toContain("ops@acme.example");
    expect(await stub.list("addresses")).toEqual([]);
  });

  it("suggest_address excludes local-parts already taken ON THE SERVER", async () => {
    // The assertion has to name an address the candidate list actually offers.
    // `suggestAddressLocalParts` has a FIXED candidate list (hello, hi, contact,
    // support, team, admin, inbox, mail, ...) and returns FULL addresses, so
    // asserting `not.toContain("ops")` — the seeded address — could never fail: "ops"
    // is not a candidate and is not the shape of an element. `hello@` is both.
    const baseline = ok<{ suggestions: string[] }>(await runDomainTool("suggest_address", { domain: "acme.example" }));
    expect(baseline.suggestions).toContain("hello@acme.example");

    // Take `hello@` on the SERVER, through a tool, then re-ask.
    ok(await runDomainTool("add_address", { provider_id: "prov-1", email: "hello@acme.example" }));
    expect((await stub.list("addresses")).map((r) => r["email"])).toContain("hello@acme.example");

    const suggested = ok<{ domain: string; suggestions: string[]; cli_equivalent: string }>(
      await runDomainTool("suggest_address", { domain: "acme.example" }),
    );

    expect(suggested.domain).toBe("acme.example");
    // THE discriminating assertion: the suggestion list changed because the SERVER
    // row changed. A tool reading a local store, or ignoring the response, fails here.
    expect(suggested.suggestions).not.toContain("hello@acme.example");
    expect(suggested.suggestions).not.toEqual(baseline.suggestions);
    expect(suggested.suggestions).toContain("hi@acme.example");
    expect(suggested.cli_equivalent).toBe("emails address suggest --domain acme.example --json");
  });
});

describe("MCP remove_domain in self_hosted mode (twin of `emails domain remove`)", () => {
  it("deletes the domain row from /v1/domains", async () => {
    const removed = await runDomainTool("remove_domain", { domain_id: "domain-1" });

    expect(removed.isError).toBeFalsy();
    expect(text(removed)).toContain("acme.example");
    expect(await stub.list("domains")).toEqual([]);
  });
});

describe("MCP group-member tools in self_hosted mode (twins of `emails group …`)", () => {
  it("add_group_member writes the membership through /v1/group-members", async () => {
    const member = ok<{ email: string; name: string | null; vars: Record<string, string> }>(
      await callTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example", name: "Ada", vars: { plan: "pro" } }),
    );

    expect(member).toMatchObject({ email: "ada@acme.example", name: "Ada", vars: { plan: "pro" } });
    expect(await stub.list("group-members")).toMatchObject([{ group_id: "group-1", email: "ada@acme.example" }]);
  });

  it("list_group_members reads members back without per-member vars", async () => {
    await callTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example" });
    await callTool("add_group_member", { group_name: "beta-testers", email: "grace@acme.example" });

    // installMcpToolContracts wraps a bare array as `{ items, cli_equivalent }`.
    const { items: members, cli_equivalent } = ok<{ items: Array<{ email: string }>; cli_equivalent: string }>(
      await callTool("list_group_members", { group_name: "beta-testers" }),
    );

    expect(members.map((m) => m.email)).toEqual(["ada@acme.example", "grace@acme.example"]);
    expect(members[0]).not.toHaveProperty("vars");
    expect(cli_equivalent).toBe("emails group members beta-testers --json");
  });

  it("get_group_member returns one member, with vars, from a SERVER-seeded row", async () => {
    await stub.seed({
      ...structuredClone(SEED),
      "group-members": [
        { id: "member-seeded-1", group_id: "group-1", email: "ada@acme.example", name: "Seeded Ada", vars: JSON.stringify({ plan: "seeded-pro" }), added_at: NOW, created_at: NOW, updated_at: NOW },
      ],
    });

    const member = ok<{ email: string; name: string; vars: Record<string, string> }>(
      await callTool("get_group_member", { group_name: "beta-testers", email: "ada@acme.example" }),
    );

    // `Seeded Ada` / `seeded-pro` were never written by a tool in this test.
    expect(member).toMatchObject({ email: "ada@acme.example", name: "Seeded Ada", vars: { plan: "seeded-pro" } });
  });

  it("remove_group_member deletes the membership from /v1/group-members", async () => {
    await callTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example" });

    const removed = await callTool("remove_group_member", { group_name: "beta-testers", email: "ada@acme.example" });

    expect(removed.isError).toBeFalsy();
    expect(await stub.list("group-members")).toEqual([]);
  });
});

describe("MCP list_replies in self_hosted mode (twin of `emails replies <id>`)", () => {
  // This one refused UNCONDITIONALLY, in every mode, claiming "inbound reply tracking
  // runs on the self-hosted server" and that no API-backed implementation existed.
  // Both halves were false — `src/db/inbound.ts` routes `listReplySummaries` to
  // `inbound.remote.ts`, which serves it from `/v1/messages`, and `emails replies`
  // has always run there. It is a worse defect than the mode-conditional guards,
  // which at least told the truth in local mode.
  const SENT = { id: "msg-sent-1", direction: "outbound", message_id: "<root@acme.example>", from_addr: "ops@acme.example", to_addrs: ["ada@acme.example"], subject: "Question", body_text: "?", created_at: NOW, updated_at: NOW, received_at: NOW };
  const REPLY = { id: "msg-reply-1", direction: "inbound", message_id: "<reply@acme.example>", in_reply_to: "<root@acme.example>", from_addr: "ada@acme.example", to_addrs: ["ops@acme.example"], subject: "Re: Question", body_text: "the answer", created_at: NOW, updated_at: NOW, received_at: NOW };

  it("returns the reply the SERVER holds instead of refusing", async () => {
    await stub.seed({ ...structuredClone(SEED), messages: [{ ...SENT }, { ...REPLY }] });

    const result = await callTool("list_replies", { email_id: "msg-sent-1" });

    expect(text(result)).not.toContain("not available in the self-hosted client");
    const payload = ok<{ replies: Array<{ id: string; subject: string }>; total: number; cli_equivalent: string }>(result);
    expect(payload.replies.map((r) => r.id)).toEqual(["msg-reply-1"]);
    expect(payload.replies[0]?.subject).toBe("Re: Question");
    expect(payload.total).toBe(1);
    // The advertised command is the CLI twin that already worked.
    expect(payload.cli_equivalent).toBe("emails replies msg-sent-1 --json");
  });

  it("returns an empty list for a message with no replies, not an error", async () => {
    await stub.seed({ ...structuredClone(SEED), messages: [{ ...SENT }] });

    const payload = ok<{ replies: unknown[]; total: number }>(await callTool("list_replies", { email_id: "msg-sent-1" }));

    expect(payload.replies).toEqual([]);
    expect(payload.total).toBe(0);
  });
});

describe("MCP sequence step/enrollment tools in self_hosted mode (twins of `emails sequence …`)", () => {
  it("add_sequence_step writes the step through /v1/sequence-steps", async () => {
    const step = ok<{ sequence_id: string; step_number: number; template_name: string }>(
      await callTool("add_sequence_step", { sequence_id: "onboarding", step_number: 1, delay_hours: 24, template_name: "welcome" }),
    );

    expect(step).toMatchObject({ sequence_id: "sequence-1", step_number: 1, template_name: "welcome" });
    expect(await stub.list("sequence-steps")).toMatchObject([
      { sequence_id: "sequence-1", step_number: 1, delay_hours: 24, template_name: "welcome" },
    ]);
  });

  it("enroll_contact writes the enrollment through /v1/sequence-enrollments", async () => {
    const enrollment = ok<{ sequence_id: string; contact_email: string; status: string }>(
      await callTool("enroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" }),
    );

    expect(enrollment).toMatchObject({ sequence_id: "sequence-1", contact_email: "ada@acme.example", status: "active" });
    expect(await stub.list("sequence-enrollments")).toMatchObject([
      { sequence_id: "sequence-1", contact_email: "ada@acme.example", status: "active" },
    ]);
  });

  it("list_enrollments reads SERVER-seeded enrollments, filtered by sequence", async () => {
    await stub.seed({
      ...structuredClone(SEED),
      "sequence-enrollments": [
        { id: "enroll-seeded-1", sequence_id: "sequence-1", contact_email: "ada@acme.example", provider_id: null, current_step: 3, status: "active", enrolled_at: NOW, next_send_at: null, completed_at: null, created_at: NOW, updated_at: NOW },
        // A different sequence, to prove the filter is applied rather than ignored.
        { id: "enroll-seeded-2", sequence_id: "sequence-other", contact_email: "grace@acme.example", provider_id: null, current_step: 0, status: "active", enrolled_at: NOW, next_send_at: null, completed_at: null, created_at: NOW, updated_at: NOW },
      ],
    });

    const { items: enrollments } = ok<{ items: Array<{ id: string; contact_email: string; current_step: number }> }>(
      await callTool("list_enrollments", { sequence_id: "onboarding" }),
    );

    expect(enrollments.map((e) => e.id)).toEqual(["enroll-seeded-1"]);
    // `current_step: 3` is a server-only value; `enroll` always creates step 0.
    expect(enrollments[0]).toMatchObject({ contact_email: "ada@acme.example", current_step: 3 });
  });

  it("unenroll_contact cancels the enrollment server-side", async () => {
    await callTool("enroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" });

    const result = await callTool("unenroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" });

    expect(ok<{ result: string }>(result).result).toBe("Contact unenrolled");
    expect(await stub.list("sequence-enrollments")).toMatchObject([{ status: "cancelled" }]);
  });
});
