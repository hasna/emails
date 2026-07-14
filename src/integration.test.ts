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
import { getLocalStats } from "./lib/stats.js";
import { getAnalytics } from "./lib/analytics.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
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
    const captured = listSandboxEmails();
    expect(captured.length).toBe(1);
    expect(captured[0]!.subject).toBe("Integration test");
    expect(captured[0]!.from_address).toBe("hello@example.com");
  });

  it("clears sandbox emails", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    const adapter = new SandboxAdapter(provider);
    await adapter.sendEmail({ from: "a@b.com", to: "c@d.com", subject: "Test", text: "x" });
    expect(listSandboxEmails().length).toBeGreaterThan(0);
    clearSandboxEmails();
    expect(listSandboxEmails().length).toBe(0);
  });
});

describe("outbound sending is server-side", () => {
  it("sendWithFailover, getLocalStats, and getAnalytics fail loud in the client", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    await expect(
      sendWithFailover(provider.id, { from: "a@example.com", to: "b@test.com", subject: "x", text: "y" }),
    ).rejects.toThrow(/not available in the self-hosted client/);
    expect(() => getLocalStats(provider.id, "30d")).toThrow(/self-hosted server/);
    expect(() => getAnalytics(provider.id, "30d")).toThrow(/self-hosted server/);
  });
});

describe("contacts + suppression flow (via /v1)", () => {
  it("suppresses a contact and reports suppression state", () => {
    upsertContact("person@test.com");
    expect(isContactSuppressed("person@test.com")).toBe(false);
    suppressContact("person@test.com");
    expect(isContactSuppressed("person@test.com")).toBe(true);
  });
});

describe("template rendering", () => {
  it("renders a template with variables and round-trips through /v1", () => {
    createTemplate({ name: "welcome", subject_template: "Hello {{name}}!", html_template: "<p>Hi {{name}}</p>" });
    expect(getTemplate("welcome")?.subject_template).toBe("Hello {{name}}!");
    expect(renderTemplate("Hello {{name}}!", { name: "Alice" })).toBe("Hello Alice!");
  });
});

describe("sequence enrollment flow (via /v1)", () => {
  it("enrolls a contact, advances through steps, and completes", () => {
    createTemplate({ name: "step1", subject_template: "Step 1", text_template: "Content 1" });
    createTemplate({ name: "step2", subject_template: "Step 2", text_template: "Content 2" });
    const seq = createSequence({ name: "test-seq" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 0, template_name: "step1" });
    addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 24, template_name: "step2" });

    const enrollment = enroll({ sequence_id: seq.id, contact_email: "user@test.com" });
    expect(enrollment.status).toBe("active");
    expect(enrollment.current_step).toBe(0);

    const advanced = advanceEnrollment(enrollment.id);
    expect(advanced?.current_step).toBe(1);
    expect(advanced?.status).toBe("active");

    const completed = advanceEnrollment(enrollment.id);
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
