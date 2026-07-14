// Self-hosted-ONLY: agent SETTINGS (keyed on agent_key) are seeded server-side and
// read/updated over /v1/email-agents/<agent_key>; the per-inbound RUN ledger is a
// separate uuid-keyed resource at /v1/email-agent-runs. Exercised against the
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Notes on DELETED coverage:
//   - The former "creates default managed agent settings" test asserted that the
//     LOCAL DB seeded three settings rows; settings are now server-seeded, so the
//     equivalent client behavior (read + map + sort the seeded rows) is kept here.
//   - The former "lists pending inbound emails based on missing run ledger rows"
//     test drove listPendingInboundEmailsForAgent, a LOCAL SQL join over
//     inbound_emails and the run ledger. That scan is server-owned; the client now
//     fails loud (covered below).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  ensureEmailAgentSettings,
  getEmailAgentRun,
  listEmailAgentRuns,
  listPendingInboundEmailsForAgent,
  saveEmailAgentRun,
  updateEmailAgentSetting,
} from "./email-agents.js";

// Settings rows are seeded server-side. The store keys them by agent_key, so each
// seeded row's `id` MUST equal its agent_key (get/update route to /v1/<res>/<id>).
function seededAgentSettings() {
  return ["categorizer", "labeler", "fraud"].map((key) => ({
    id: key,
    agent_key: key,
    enabled: false,
    always_on: false,
    provider: "external",
    model: null,
    apply_labels: key !== "categorizer",
    use_network_tools: key === "fraud",
    config_json: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }));
}

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub({ seed: { "email-agents": seededAgentSettings() } });
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("email agent persistence", () => {
  it("reads the server-seeded managed agent settings", () => {
    const settings = ensureEmailAgentSettings();

    expect(settings.map((setting) => setting.agent_key).sort()).toEqual(["categorizer", "fraud", "labeler"]);
    expect(settings.every((setting) => setting.provider === "external")).toBe(true);
    expect(settings.every((setting) => !setting.enabled)).toBe(true);
  });

  it("updates enabled and always-on settings", () => {
    const setting = updateEmailAgentSetting("labeler", {
      enabled: true,
      always_on: true,
      model: "external-summary",
      use_network_tools: false,
    });

    expect(setting.enabled).toBe(true);
    expect(setting.always_on).toBe(true);
    expect(setting.model).toBe("external-summary");
    expect(setting.use_network_tools).toBe(false);
  });

  it("upserts one latest run per agent and inbound email", () => {
    const inboundEmailId = "inbound-agent-1";
    saveEmailAgentRun({
      agent_key: "fraud",
      inbound_email_id: inboundEmailId,
      provider: "external",
      model: "first",
      status: "error",
      error: "temporary",
    });
    const second = saveEmailAgentRun({
      agent_key: "fraud",
      inbound_email_id: inboundEmailId,
      provider: "external",
      model: "second",
      status: "ok",
      labels: ["review-risk"],
      risk_score: 42,
    });

    expect(second.model).toBe("second");
    expect(second.status).toBe("ok");
    expect(getEmailAgentRun("fraud", inboundEmailId)?.risk_score).toBe(42);
    expect(listEmailAgentRuns({ agent_key: "fraud" })).toHaveLength(1);
  });

  it("fails loud for the server-owned pending-inbound scan", () => {
    // DELETED (server-owned): listPendingInboundEmailsForAgent was a LOCAL SQL join
    // over inbound_emails and the run ledger; that scan now runs on the server.
    expect(() => listPendingInboundEmailsForAgent("categorizer", 10)).toThrow(
      /not available in the self-hosted client/i,
    );
  });
});
