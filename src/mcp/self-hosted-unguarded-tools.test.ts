// Every MCP tool whose `assert*Allowed()` mode guard was deleted, driven END TO END
// against the out-of-process /v1 stub (src/test-support/v1-stub.ts).
//
// WHY THIS FILE EXISTS. Each of these tools already had three of the four pieces it
// needed in self_hosted mode: a `/v1` route in src/server/self-hosted/resources.ts, a
// complete HTTP client arm in src/db/*.remote.ts, and a CLI twin that performs the
// SAME operation over the SAME route and succeeds. The fourth piece — the guard —
// refused before any of it ran. Deleting the guard was the entire fix, so the proof
// has to be the tool doing real work against a real server, not the absence of a
// refusal string: an assertion that merely checked `isError` is false would also pass
// against a tool that silently fell back to local SQLite.
//
// Every assertion below therefore reads the resulting ROW BACK OFF THE STUB. On
// unmodified main every one of these tests fails with "disabled in self_hosted
// API-only mode".
//
// NOT HERE, deliberately: `get_dns_records` and `verify_domain` keep their guard.
// They call a provider ADAPTER rather than a repository, their credentials do not
// exist in the `/v1/providers` row, and their CLI twins (`emails domain dns`,
// `emails domain verify`) are `serverOnly(...)` — there is no working route behind
// that refusal to unblock. src/mcp/domain-address-self-hosted.test.ts still pins it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
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

describe("MCP alias tools in self_hosted mode (twins of `emails alias …`)", () => {
  it("add_alias writes the routing row through /v1/aliases", async () => {
    const alias = ok<{ domain: string; local_part: string; target_address: string }>(
      await runDomainTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" }),
    );

    expect(alias).toMatchObject({ domain: "acme.example", local_part: "hello", target_address: "ops@acme.example" });
    expect(await stub.list("aliases")).toMatchObject([
      { domain: "acme.example", local_part: "hello", target_address: "ops@acme.example" },
    ]);
  });

  it("add_catch_all writes the domain catch-all through /v1/aliases", async () => {
    ok(await runDomainTool("add_catch_all", { domain: "acme.example", target: "ops@acme.example" }));

    expect(await stub.list("aliases")).toMatchObject([{ domain: "acme.example", local_part: "*" }]);
  });

  it("list_aliases reads the rows the server holds", async () => {
    await runDomainTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" });
    await runDomainTool("add_alias", { alias: "sales@acme.example", target: "ops@acme.example" });

    const aliases = ok<Array<{ local_part: string }>>(await runDomainTool("list_aliases", { domain: "acme.example" }));

    expect(aliases.map((a) => a.local_part)).toEqual(["hello", "sales"]);
  });

  it("resolve_alias resolves a recipient through the server's routing table", async () => {
    await runDomainTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" });

    expect(ok(await runDomainTool("resolve_alias", { recipient: "hello@acme.example" })))
      .toEqual({ recipient: "hello@acme.example", target: "ops@acme.example" });
    // A recipient with no alias resolves to null rather than erroring.
    expect(ok(await runDomainTool("resolve_alias", { recipient: "nobody@acme.example" })))
      .toEqual({ recipient: "nobody@acme.example", target: null });
  });

  it("remove_alias deletes the row from /v1/aliases", async () => {
    const created = ok<{ id: string }>(await runDomainTool("add_alias", { alias: "hello@acme.example", target: "ops@acme.example" }));

    const removed = await runDomainTool("remove_alias", { alias_id: created.id });

    expect(removed.isError).toBeFalsy();
    expect(text(removed)).toContain("hello@acme.example");
    expect(await stub.list("aliases")).toEqual([]);
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

  it("suggest_address suggests local-parts not already taken on the server", async () => {
    const suggested = ok<{ domain: string; suggestions: string[]; cli_equivalent: string }>(
      await runDomainTool("suggest_address", { domain: "acme.example" }),
    );

    expect(suggested.domain).toBe("acme.example");
    expect(suggested.suggestions.length).toBeGreaterThan(0);
    // `ops@acme.example` is seeded on the stub, so a suggestion list computed from
    // server state cannot offer it back.
    expect(suggested.suggestions).not.toContain("ops");
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

  it("get_group_member returns one member including its vars", async () => {
    await callTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example", vars: { plan: "pro" } });

    const member = ok<{ email: string; vars: Record<string, string> }>(
      await callTool("get_group_member", { group_name: "beta-testers", email: "ada@acme.example" }),
    );

    expect(member).toMatchObject({ email: "ada@acme.example", vars: { plan: "pro" } });
  });

  it("remove_group_member deletes the membership from /v1/group-members", async () => {
    await callTool("add_group_member", { group_name: "beta-testers", email: "ada@acme.example" });

    const removed = await callTool("remove_group_member", { group_name: "beta-testers", email: "ada@acme.example" });

    expect(removed.isError).toBeFalsy();
    expect(await stub.list("group-members")).toEqual([]);
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

  it("list_enrollments reads enrollments back from the server", async () => {
    await callTool("enroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" });
    await callTool("enroll_contact", { sequence_id: "onboarding", contact_email: "grace@acme.example" });

    const { items: enrollments } = ok<{ items: Array<{ contact_email: string }> }>(
      await callTool("list_enrollments", { sequence_id: "onboarding" }),
    );

    expect(enrollments.map((e) => e.contact_email).sort()).toEqual(["ada@acme.example", "grace@acme.example"]);
  });

  it("unenroll_contact cancels the enrollment server-side", async () => {
    await callTool("enroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" });

    const result = await callTool("unenroll_contact", { sequence_id: "onboarding", contact_email: "ada@acme.example" });

    expect(ok<{ result: string }>(result).result).toBe("Contact unenrolled");
    expect(await stub.list("sequence-enrollments")).toMatchObject([{ status: "cancelled" }]);
  });
});
