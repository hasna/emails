// The shared store conformance suite, run by `HttpEmailStore` over real HTTP against
// the REAL `/v1` service, backed by real Postgres.
//
// WHY THIS FILE IS THE POINT OF THE PHASE. `src/store-http.test.ts` runs the same 62
// cases against `src/test-support/v1-store-api.ts` — a translation-layer fixture that
// re-implements the route contract. That run is worth having (it catches a client that
// mis-maps a field, because every row it serves comes out of a real store), but it can
// only ever prove the client agrees with a second implementation of the server. A
// fixture's DIVERGENCES are exactly what its green result does not cover, and the
// headline finding of the previous phase was one: the fixture accepted an outbound
// `POST /v1/messages` that the service answered 409 to, so four cases were green against
// the fixture and would have been red against `/v1`.
//
// So this suite points the client at `handleSelfHostedRequest` itself — the same router
// the shipped `emails-serve` binary dispatches on — over a loopback HTTP server, with a
// tenant-bound API key and a Postgres schema built from the service's own migrations.
// "Conformance passes" then means the thing worth claiming.
//
// IT CANNOT PASS VACUOUSLY, and that is asserted rather than assumed:
//   * the case count is pinned, and both halves of the pass/refuse split must be
//     non-empty — an all-refused run would mean the store did nothing;
//   * `assertUniformCaseCoverage` requires every declared case to have EXECUTED;
//   * two neuterings replace one method each with the plausible wrong answer it would
//     otherwise be free to return, and the corresponding case must go RED against this
//     same live service. Without them a green run here would prove only that nothing
//     threw. One breaks a read and one breaks a WRITE (reports success, changes
//     nothing), because a suite that only caught broken reads would miss the whole
//     "accepted and dropped" class.
//
// A FRESH TENANT PER SUITE RUN. Not hygiene theatre: the attachment-inventory case pages
// the tenant's whole inventory one row at a time and gives up after 200 pages, so three
// suite runs sharing a tenant would accumulate their way into a false failure. A new
// tenant per run also means every read below is answered through the tenant filter,
// which is a property worth exercising rather than working around.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { CONFORMANCE_CASES, assertUniformCaseCoverage, conformanceFailures, runConformanceSuite } from "../../store/conformance.js";
import type { ConformanceReport } from "../../store/conformance.js";
import type { EmailStore } from "../../store/email-store.js";
import { HTTP_STORE_CAPABILITIES, createHttpEmailStore } from "../../store-http/index.js";
import { STUB_KEY_STORE, testAuthDeps } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { EmailsSelfHostedStore } from "./store.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";

// Unique per process so a tenant slug cannot collide with a previous run against a
// persistent database.
const RUN = crypto.randomUUID().slice(0, 8);

const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

/**
 * The flag the Postgres job sets to say "this suite MUST run here".
 *
 * Without it the whole file is `describe.skipIf(!pgClient)` and a green job proves
 * nothing: rename the connection variable, drop the step, or break the service container,
 * and the flagship evidence for this phase silently stops being checked while CI stays
 * green. That is the exact failure mode this repository has already shipped twice — a
 * pack guard that certified an empty tarball, ban patterns that matched nothing. So the
 * job asserts its own presence, and the assertion lives OUTSIDE the skip.
 *
 * It is a dedicated flag rather than `CI`, because the hermetic suite also runs under CI
 * and deliberately scrubs the connection string; keying on `CI` would make that job red.
 */
const REQUIRE_POSTGRES = process.env["EMAILS_REQUIRE_POSTGRES_TESTS"] === "1";

// Every case is several HTTP round trips against Postgres, and the file runs the suite
// three times.
const SUITE_TIMEOUT_MS = 300_000;

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

/**
 * The service's own deps, assembled the way the Postgres integration suites assemble
 * them — with one difference that is deliberate: the sender THROWS. Nothing this suite
 * drives may transmit, and a stub that quietly succeeded would let a future change start
 * sending from a store operation with every assertion still green.
 */
function serviceDeps(): SelfHostedServiceDeps {
  return {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: {
      provider: "ses",
      send: async () => {
        throw new Error("no store operation may reach the provider");
      },
    },
    migrations: emailsSelfHostedMigrations(),
    version: "store-conformance",
    // The auth deps the data routes do not exercise but the service requires. The rate
    // limiter is keyed on the AUTH route names only, so the several hundred data requests
    // this suite makes from 127.0.0.1 never consult it.
    ...testAuthDeps(pgClient!, SIGNING_SECRET),
    keyStore: STUB_KEY_STORE,
  } as SelfHostedServiceDeps;
}

/**
 * A tenant plus an OPERATOR api key bound to it.
 *
 * `emails:*` rather than `emails:write`, and the difference is load-bearing: three
 * routes the store writes through are gated on tenant-operator authority
 * (`POST /v1/send-keys/mint`, `PATCH /v1/send-keys/{id}` and `PATCH /v1/addresses/{id}`
 * when the body carries ownership fields). A plain `emails:write` key answers 403 on all
 * three, so two ungated conformance cases would fail — which is the second divergence the
 * fixture's header records, and the reason this run supplies a credential the fixture
 * cannot model.
 */
async function makeTenant(slug: string): Promise<string> {
  const tenant = await pgClient!.one<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [
    slug,
    slug,
  ]);
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [minted.kid, tenant.id]);
  return minted.token;
}

async function liveStore(slug: string): Promise<EmailStore> {
  return createHttpEmailStore({ baseUrl, credential: await makeTenant(slug) });
}

function totals(report: ConformanceReport): { passed: number; refused: number; failed: number } {
  const results = report.flatMap((implementation) => implementation.results);
  return {
    passed: results.filter((result) => result.status === "passed").length,
    refused: results.filter((result) => result.status === "refused").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

// A COLD `migrate()` measured at ~6s on a loaded machine against bun's DEFAULT 5s hook
// timeout, which made the file impossible to run on its own even though CI (where an
// earlier suite has already migrated) sees ~3ms. The timeout is stated rather than
// inherited.
const BEFORE_ALL_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  if (!pgClient) return;
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
  const deps = serviceDeps();
  // The service over real HTTP. `serve.ts` is not reused because its boot path refuses a
  // superuser connection (the RLS guard) and builds a live provider adapter; this
  // replicates the two behaviours of its request handler that matter — the socket
  // address it passes through, and turning an unclaimed path into a 404.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request: Request, bunServer): Promise<Response> {
      const response = await handleSelfHostedRequest(deps, request, {
        socketAddress: bunServer.requestIP(request)?.address ?? null,
      });
      return (
        response ??
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      );
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
}, BEFORE_ALL_TIMEOUT_MS);

afterAll(async () => {
  server?.stop(true);
  await pgClient?.close();
});

// OUTSIDE THE SKIP, on purpose — this is the one assertion that cannot be silenced by the
// condition that silences everything else in this file.
describe("this suite is actually reachable where it is supposed to run", () => {
  it("has a database when the job says it must", () => {
    if (!REQUIRE_POSTGRES) {
      // Locally and in the hermetic job the connection string is deliberately absent, and
      // skipping is correct. Assert the pair is consistent rather than nothing.
      expect(pgClient === null || databaseUrl !== undefined).toBe(true);
      return;
    }
    expect(
      databaseUrl,
      "EMAILS_REQUIRE_POSTGRES_TESTS=1 but EMAILS_TEST_POSTGRES_URL is unset, so the whole " +
        "real-service conformance run would have skipped and the job would still be green",
    ).toBeTruthy();
    expect(pgClient).not.toBeNull();
  });
});

describe.skipIf(!pgClient)("HttpEmailStore conformance against the real /v1 service", () => {
  it(
    "executes every case and answers each one with behaviour or the typed refusal",
    async () => {
      const report = await runConformanceSuite([await liveStore(`store-conformance-${RUN}`)], CONFORMANCE_CASES);
      expect(conformanceFailures(report)).toEqual([]);
      expect(() => assertUniformCaseCoverage(report, CONFORMANCE_CASES)).not.toThrow();

      // THE NUMBERS, pinned exactly rather than as inequalities. 55 / 8 / 0 is the claim
      // this phase makes about the real service; the previous phase measured 36 / 8 / 4
      // against it, and the four failures were the outbound writes that had no route.
      // The 54th pass is `resources/boolean-equality-filter-round-trip` (OPE105-00241):
      // the SQLite arm mismatched boolean equality filters and was fixed at the store,
      // so both arms now conform — the case proves parity, it does not paper over it.
      // The 55th is `messages/search-treats-like-metacharacters-as-literal-text`: both
      // stores passed a caller's search term to SQL LIKE unescaped, so `_` and `%` were
      // wildcards rather than literals. It requires `keysetPagination`, which this store
      // declares true, so it is counted as a pass and never as a refusal.
      const counted = totals(report);
      expect(CONFORMANCE_CASES.length).toBe(63);
      expect(counted).toEqual({ passed: 55, refused: 8, failed: 0 });
      // The 8 refusals are exactly the cases whose capability this store declares false —
      // never one it claims to support.
      const refusedCapabilities = new Set<string>();
      for (const result of report[0]?.results ?? []) {
        if (result.status !== "refused") continue;
        const declared = CONFORMANCE_CASES.find((testCase) => testCase.id === result.caseId);
        expect(declared?.requires, `${result.caseId} was refused without naming a capability`).not.toBeNull();
        const capability = declared?.requires;
        if (capability) {
          expect(HTTP_STORE_CAPABILITIES[capability]).toBe(false);
          refusedCapabilities.add(capability);
        }
      }
      expect([...refusedCapabilities].sort()).toEqual(["attachmentRepair", "outboundPolicy", "sendIntentLedger"]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "records an outbound message through the record route while the import route still refuses one",
    async () => {
      // The gap this phase closed, exercised against the SERVICE rather than the fixture,
      // and with the guard checked in the same breath. A change that had lifted the 409
      // instead of adding a route would pass the conformance run above and fail here.
      const store = await liveStore(`store-conformance-outbound-${RUN}`);
      const recorded = await store.messages.createMessage({
        direction: "outbound",
        from_addr: `sender-${RUN}@example.test`,
        to_addrs: [`recipient-${RUN}@example.test`],
        subject: "recorded against the real service",
        status: "queued",
      });
      expect(recorded.ok, `createMessage: ${JSON.stringify(recorded)}`).toBe(true);
      if (!recorded.ok) return;
      expect(recorded.value.direction).toBe("outbound");
      // ...and it is really in the tenant's mailbox, not merely echoed back.
      const read = await store.messages.getMessage(recorded.value.id);
      expect(read.ok && read.value?.subject).toBe("recorded against the real service");
      // Nothing was transmitted: the deps' sender throws, so a send would have surfaced
      // as a 500 rather than as the 201 above.

      const token = await makeTenant(`store-conformance-guard-${RUN}`);
      const refused = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `s-${RUN}@example.test`, to: [`r-${RUN}@example.test`], direction: "outbound" }),
      });
      expect(refused.status, "POST /v1/messages must keep refusing an outbound write").toBe(409);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "records twice with an empty source_id instead of answering 500 the second time",
    async () => {
      // The unique-index trap, against real Postgres, because it is the one place it can
      // actually fire: an empty `source_id` stored verbatim satisfies `WHERE source_id IS
      // NOT NULL`, so the SECOND identical write violated the partial unique index and the
      // caller got `{"error":"internal error"}`. A fake query client cannot show this.
      const store = await liveStore(`store-conformance-blank-fence-${RUN}`);
      const write = () =>
        store.messages.createMessage({
          direction: "outbound",
          from_addr: `blank-${RUN}@example.test`,
          to_addrs: [`recipient-${RUN}@example.test`],
          subject: "no fence at all",
          source_id: "",
        });
      const first = await write();
      expect(first.ok, `first write: ${JSON.stringify(first)}`).toBe(true);
      const second = await write();
      expect(second.ok, `second write: ${JSON.stringify(second)}`).toBe(true);
      if (!first.ok || !second.ok) return;
      // Two distinct rows, because an empty fence is no fence — not one row and not a fault.
      expect(second.value.id).not.toBe(first.value.id);
      expect(first.value.source_id).toBeNull();
      expect(second.value.source_id).toBeNull();
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "leaves local state alone when an import is replayed",
    async () => {
      // The divergence the fixture hid in the other direction. The fixture's SQLite store
      // already wrote only the columns an upsert body carried; the Postgres store assigned
      // the WHOLE insert set from EXCLUDED, so a replay reset the read flag, the star and
      // the labels from the insert defaults. The conformance case covers it, and it is
      // asserted separately here because it is the one behaviour a reader of the numbers
      // above would not know had been fixed.
      const store = await liveStore(`store-conformance-replay-${RUN}`);
      const sourceId = `upstream-${RUN}`;
      const first = await store.messages.upsertMessage({
        direction: "inbound",
        from_addr: `replay-${RUN}@example.test`,
        to_addrs: [`inbox-${RUN}@example.test`],
        subject: "first import",
        received_at: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
        source_id: sourceId,
      });
      expect(first.ok && first.value.inserted).toBe(true);
      if (!first.ok) return;
      const id = first.value.record.id;
      const importedAt = first.value.record.received_at;
      await store.messages.updateMessageStatus(id, { is_read: true, is_starred: true });
      await store.inbound.addInboundLabel(id, `kept-${RUN}`);

      const replay = await store.messages.upsertMessage({
        direction: "inbound",
        from_addr: `replay-${RUN}@example.test`,
        to_addrs: [`inbox-${RUN}@example.test`],
        subject: "second import",
        source_id: sourceId,
      });
      expect(replay.ok && replay.value.inserted, "a replay must update, not insert").toBe(false);

      const read = await store.messages.getMessage(id);
      expect(read.ok).toBe(true);
      if (!read.ok || read.value === null) return;
      // What the replay DID say wins...
      expect(read.value.subject).toBe("second import");
      // ...and everything it did not mention survives.
      expect(read.value.is_read, "a replay must not reset the read flag").toBe(true);
      expect(read.value.is_starred, "a replay must not reset the star").toBe(true);
      expect(read.value.labels).toContain(`kept-${RUN}`);
      expect(read.value.received_at, "a replay must not re-sort the message to now").toBe(importedAt);
    },
    SUITE_TIMEOUT_MS,
  );
});

// ---- the proof that a green live run is not a vacuous one ---------------------

interface Neutering {
  label: string;
  caseId: string;
  detail: string;
  break(subject: EmailStore): EmailStore;
}

const NEUTERINGS: Neutering[] = [
  {
    label: "a flag write silently does nothing while reads keep working",
    caseId: "inbound/starred-flag-round-trip",
    detail: "the star is persisted",
    break(subject: EmailStore): EmailStore {
      // THE MORE IMPORTANT OF THE TWO. Every read-breaking control would be caught by a
      // suite that only compared values; this one reports success and changes nothing,
      // which for an HTTP client is the likeliest bug there is — a request that was never
      // sent and a request whose body lost a field both come back 200.
      return {
        ...subject,
        inbound: {
          ...subject.inbound,
          async setInboundStarred(id: string) {
            return subject.messages.getMessage(id);
          },
        },
      };
    },
  },
  {
    label: "messageCounts returns zeros",
    caseId: "messages/counts-follow-the-writes",
    detail: "total count",
    break(subject: EmailStore): EmailStore {
      return {
        ...subject,
        messages: {
          ...subject.messages,
          async messageCounts() {
            return {
              ok: true,
              value: {
                inbox: 0,
                unread: 0,
                starred: 0,
                sent: 0,
                archived: 0,
                spam: 0,
                trash: 0,
                total: 0,
                latest_received_at: null,
              },
            };
          },
        },
      };
    },
  },
];

describe.skipIf(!pgClient)("the conformance suite can fail against the real service", () => {
  for (const [index, neutering] of NEUTERINGS.entries()) {
    it(
      `goes red when ${neutering.label}`,
      async () => {
        const broken = neutering.break(await liveStore(`store-conformance-neuter-${index}-${RUN}`));
        const report = await runConformanceSuite([broken], CONFORMANCE_CASES);
        const failures = conformanceFailures(report);
        const named = failures.filter((entry) => entry.startsWith(`api/${neutering.caseId}:`));
        expect(named.length, `${neutering.caseId} did not fail; failures were ${JSON.stringify(failures)}`).toBe(1);
        expect(named[0]).toContain(neutering.detail);
        // It failed by RUNNING, not by being skipped.
        expect(() => assertUniformCaseCoverage(report, CONFORMANCE_CASES)).not.toThrow();
        expect(totals(report).failed).toBeGreaterThan(0);
      },
      SUITE_TIMEOUT_MS,
    );
  }
});
