/**
 * Integration smoke — exercises the self-hosted-ONLY flow end to end against the
 * /v1 API (via the out-of-process stub). It covers the pieces that still run
 * client-side (sandbox capture, contacts/templates/sequences CRUD, pure warming
 * math) and asserts that the operations that moved server-side (provider-adapter
 * sends, delivery stats/analytics) fail loud. The previous local-SQLite raw-SQL
 * flow, header-based reply linking, and bounce auto-suppression validated removed
 * behavior and are gone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "./test-support/v1-stub.js";
import { createProvider, getProvider } from "./db/providers.js";
import { createDomain, getDomainByName } from "./db/domains.js";
import { createAddress } from "./db/addresses.js";
import { SandboxAdapter } from "./providers/sandbox.js";
import { listSandboxEmails, clearSandboxEmails } from "./db/sandbox.js";
import { upsertContact, isContactSuppressed, suppressContact } from "./db/contacts.js";
import { createTemplate, getTemplate, renderTemplate } from "./db/templates.js";
import { createSequence, addStep, enroll, advanceEnrollment } from "./db/sequences.js";
import { getTodayLimit, generateWarmingPlan } from "./lib/warming.js";
import { storeInboundEmail } from "./db/inbound.js";
import { sendWithFailover } from "./lib/send.js";
import { getAnalytics } from "./lib/analytics.js";

let stub: V1Stub;

beforeAll(async () => {
  // `openapi: true` is REQUIRED by the sandbox block below and CHANGES the analytics block,
  // and adversarial review is the reason both halves of that sentence are here.
  //
  // Why it is required: `src/db/sandbox.ts` has collapsed onto the store seam, so its capture
  // write goes through the REAL `HttpEmailStore`, which reads the service's published contract
  // before any write — that document is its only source of truth for which columns a resource
  // accepts, and a write naming an undeclared one is accepted and silently DROPPED by the
  // generic route. A missing contract is deliberately a fault there, which is what this block
  // hit.
  //
  // What else it changes: `getAnalytics` pushes an equality filter on the event type, and the
  // HTTP store refuses a filter the contract does not declare. Without the document that
  // refusal was a fault and the delivery-event read came back UNANSWERED; with it the filter
  // is accepted and the read answers. The analytics block below now pins that explicitly
  // rather than leaving it to depend on the fixture's events table happening to be empty.
  //
  // What it does NOT fix: the fixture's generic list still IGNORES equality filters and
  // answers with the unfiltered list. The sandbox reads here are all UNFILTERED so they cannot
  // meet it; a filtered or paged store-seam read belongs on
  // `src/test-support/v1-store-api.ts`, which is where `src/db/sandbox.test.ts` and
  // `src/providers/sandbox.test.ts` now run.
  stub = await startV1Stub({ openapi: true });
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("sandbox capture flow (via /v1)", () => {
  it("creates sandbox provider, sends email, captures in the sandbox store", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    expect(provider.type).toBe("sandbox");

    const adapter = new SandboxAdapter(provider);
    const msgId = await adapter.sendEmail({
      from: "hello@example.com",
      to: "user@test.com",
      subject: "Integration test",
      text: "Hello from integration test",
    });

    expect(msgId).toBeTruthy();
    const captured = await listSandboxEmails();
    expect(captured.length).toBe(1);
    expect(captured[0]!.subject).toBe("Integration test");
    expect(captured[0]!.from_address).toBe("hello@example.com");
  });

  it("clears sandbox emails", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    const adapter = new SandboxAdapter(provider);
    await adapter.sendEmail({ from: "a@b.com", to: "c@d.com", subject: "Test", text: "x" });
    expect((await listSandboxEmails()).length).toBeGreaterThan(0);
    expect(await clearSandboxEmails()).toBe(1);
    expect(await listSandboxEmails()).toHaveLength(0);
  });
});

describe("outbound sending is server-side", () => {
  // `getLocalStats` USED TO BE ASSERTED HERE and no longer is, because the behaviour it
  // asserted is deliberately gone: the delivery-statistics family has collapsed to one
  // implementation that reads whichever store the operator configured (src/lib/stats.ts),
  // so there is no client half left to fail loud. It is not untested — the equivalent
  // coverage moved to src/lib/stats.test.ts, which runs the same measurements against BOTH
  // stores, including one over real HTTP, and asserts the refusals it does still make.
  it("sendWithFailover fails loud in the client", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    await expect(
      sendWithFailover(provider.id, { from: "a@example.com", to: "b@test.com", subject: "x", text: "y" }),
    ).rejects.toThrow(/not available in the self-hosted client/);
  });
});

describe("analytics", () => {
  // ANALYTICS IS NO LONGER SERVER-ONLY, and that is the point of the collapse: it used to
  // throw here unconditionally because its second arm was a stub, so an operator reading
  // an installation through the API got no dashboard at all. It now reads the SAME store
  // this test's environment configures, over the seam.
  it("answers through the configured API store rather than refusing", async () => {
    const data = await getAnalytics(undefined, "30d");
    expect(data.sent_read.answered).toBe(true);
    // Nothing has been sent through this store, and the read reached the end of the rows,
    // so an empty list here is a genuine total rather than an unread table.
    expect(data.sent_read.exact, data.sent_read.reason ?? "").toBe(true);
    expect(data.dailyVolume).toEqual([]);
    // Pinned because it MOVED with `openapi: true` above and would otherwise be invisible: the
    // delivery-event read is filtered on the event type, and the HTTP store can only accept a
    // filter the published contract declares. Before the document was served this came back
    // unanswered; a future change that stops serving it would silently flip this back, and an
    // unanswered read here is not the same fact as an empty one.
    expect(data.events_read.answered, data.events_read.reason ?? "").toBe(true);
  });

  it("still refuses a provider-scoped report, because the seam cannot scope messages", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    await expect(getAnalytics(provider.id, "30d")).rejects.toThrow(/cannot be produced from the store seam/);
  });
});

describe("contacts + suppression flow (via /v1)", () => {
  it("suppresses a contact and reports suppression state", async () => {
    // The collapsed contacts family is async and resolves the API store from storage
    // configuration — the same environment the stub applies for every case here.
    await upsertContact("person@test.com");
    expect(await isContactSuppressed("person@test.com")).toBe(false);
    await suppressContact("person@test.com");
    expect(await isContactSuppressed("person@test.com")).toBe(true);
  });
});

describe("template rendering", () => {
  it("renders a template with variables and round-trips through /v1", async () => {
    // The collapsed templates family is async and resolves the API store from the
    // storage settings the stub's env installs; every call here is awaited.
    await createTemplate({ name: "welcome", subject_template: "Hello {{name}}!", html_template: "<p>Hi {{name}}</p>" });
    expect((await getTemplate("welcome"))?.subject_template).toBe("Hello {{name}}!");
    expect(renderTemplate("Hello {{name}}!", { name: "Alice" })).toBe("Hello Alice!");
  });
});

describe("sequence enrollment flow (via /v1)", () => {
  it("enrolls a contact, advances through steps, and completes", async () => {
    // The collapsed sequences family is async and resolves the API store from the
    // storage settings the stub's env installs; every call here is awaited.
    await createTemplate({ name: "step1", subject_template: "Step 1", text_template: "Content 1" });
    await createTemplate({ name: "step2", subject_template: "Step 2", text_template: "Content 2" });
    const seq = await createSequence({ name: "test-seq" });
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 0, template_name: "step1" });
    await addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 24, template_name: "step2" });

    const enrollment = await enroll({ sequence_id: seq.id, contact_email: "user@test.com" });
    expect(enrollment.status).toBe("active");
    expect(enrollment.current_step).toBe(0);

    const advanced = await advanceEnrollment(enrollment.id);
    expect(advanced?.current_step).toBe(1);
    expect(advanced?.status).toBe("active");

    const completed = await advanceEnrollment(enrollment.id);
    expect(completed?.status).toBe("completed");
  });
});

describe("warming schedule math (pure)", () => {
  it("generates a plan and returns today's limit on day 1", () => {
    const today = new Date().toISOString().slice(0, 10);
    const plan = generateWarmingPlan(10000);
    expect(plan[0]!.day).toBe(1);
    expect(plan[0]!.limit).toBe(50);
    expect(plan[plan.length - 1]!.limit).toBe(10000);

    const schedule = {
      id: "w1", domain: "example.com", provider_id: null,
      target_daily_volume: 10000, start_date: today,
      status: "active" as const, created_at: today, updated_at: today,
    };
    expect(getTodayLimit(schedule)).toBe(50);
  });
});

describe("provider/domain/address + inbound round-trip (via /v1)", () => {
  it("persists setup entities and stores an inbound message", () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    const domain = createDomain(provider.id, "example.com");
    const address = createAddress({ provider_id: provider.id, email: "hello@example.com" });

    expect(getProvider(provider.id)?.name).toBe("dev");
    expect(getDomainByName(provider.id, domain.domain)?.id).toBe(domain.id);

    const inbound = storeInboundEmail({
      provider_id: provider.id,
      message_id: "<workflow-inbound@example.net>",
      from_address: "user@example.net",
      to_addresses: [address.email],
      cc_addresses: [],
      subject: "Re: Workflow smoke",
      text_body: "thanks",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 20,
      received_at: new Date().toISOString(),
    });

    expect(inbound.id).toBeTruthy();
    expect(inbound.subject).toBe("Re: Workflow smoke");
  });
});
