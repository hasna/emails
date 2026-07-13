import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createProvider } from "../db/providers.js";
import { listSandboxEmails } from "../db/sandbox.js";
import { SandboxAdapter } from "./sandbox.js";

// SandboxAdapter.sendEmail and .getStats route through src/db/sandbox.ts, which
// persists to the `sandbox-emails` /v1 resource; the remaining adapter methods
// are pure no-ops. Everything is exercised against the out-of-process /v1 stub.
let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

function makeSandboxProvider() {
  return createProvider({ name: "Sandbox Test", type: "sandbox" });
}

describe("SandboxAdapter.sendEmail", () => {
  it("stores the email over /v1 and returns its id", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);

    const id = await adapter.sendEmail({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Test subject",
      text: "Hello world",
    });

    expect(id).toHaveLength(36);

    const stored = listSandboxEmails(provider.id, 10);
    expect(stored.length).toBe(1);
    expect(stored[0]!.id).toBe(id);
    expect(stored[0]!.subject).toBe("Test subject");
    expect(stored[0]!.from_address).toBe("from@example.com");
    expect(stored[0]!.to_addresses).toEqual(["to@example.com"]);
    expect(stored[0]!.text_body).toBe("Hello world");
    expect(stored[0]!.html).toBeNull();
  });

  it("handles array to/cc/bcc", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);

    await adapter.sendEmail({
      from: "from@example.com",
      to: ["a@example.com", "b@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Multi recipients",
      html: "<p>Hello</p>",
    });

    const stored = listSandboxEmails(provider.id, 10);
    expect(stored[0]!.to_addresses).toEqual(["a@example.com", "b@example.com"]);
    expect(stored[0]!.cc_addresses).toEqual(["cc@example.com"]);
    expect(stored[0]!.bcc_addresses).toEqual(["bcc@example.com"]);
    expect(stored[0]!.html).toBe("<p>Hello</p>");
  });

  it("handles reply_to field", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);

    await adapter.sendEmail({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Reply test",
      text: "hello",
      reply_to: "reply@example.com",
    });

    const stored = listSandboxEmails(provider.id, 10);
    expect(stored[0]!.reply_to).toBe("reply@example.com");
  });
});

describe("SandboxAdapter.getStats", () => {
  it("returns stats based on stored email count", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);

    await adapter.sendEmail({ from: "a@a.com", to: "b@b.com", subject: "S1", text: "t" });
    await adapter.sendEmail({ from: "a@a.com", to: "b@b.com", subject: "S2", text: "t" });

    const stats = await adapter.getStats();
    expect(stats.provider_id).toBe(provider.id);
    expect(stats.sent).toBe(2);
    expect(stats.delivered).toBe(2);
    expect(stats.bounced).toBe(0);
    expect(stats.complained).toBe(0);
    expect(stats.delivery_rate).toBe(100);
    expect(stats.bounce_rate).toBe(0);
    expect(stats.period).toBe("all");
  });

  it("returns zero stats when no emails", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);

    const stats = await adapter.getStats();
    expect(stats.sent).toBe(0);
    expect(stats.delivered).toBe(0);
  });
});

describe("SandboxAdapter no-op methods", () => {
  it("listDomains returns empty array", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    expect(await adapter.listDomains()).toEqual([]);
  });

  it("getDnsRecords returns empty array", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    expect(await adapter.getDnsRecords("example.com")).toEqual([]);
  });

  it("verifyDomain returns pending statuses", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    const result = await adapter.verifyDomain("example.com");
    expect(result.dkim).toBe("pending");
    expect(result.spf).toBe("pending");
    expect(result.dmarc).toBe("pending");
  });

  it("addDomain is a no-op", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    await expect(adapter.addDomain("example.com")).resolves.toBeUndefined();
  });

  it("listAddresses returns empty array", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    expect(await adapter.listAddresses()).toEqual([]);
  });

  it("addAddress is a no-op", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    await expect(adapter.addAddress("test@example.com")).resolves.toBeUndefined();
  });

  it("verifyAddress always returns true", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    expect(await adapter.verifyAddress("test@example.com")).toBe(true);
  });

  it("pullEvents returns empty array", async () => {
    const provider = makeSandboxProvider();
    const adapter = new SandboxAdapter(provider);
    expect(await adapter.pullEvents()).toEqual([]);
  });
});
