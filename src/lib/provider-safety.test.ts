import { describe, expect, it } from "bun:test";
import {
  maileryProviderSafetyMatrix,
  MAILERY_MODE_BOUNDARIES,
  MAILERY_PROVIDER_OPERATION_GATES,
  MAILERY_ROOT_BOUNDARIES,
  requireMaileryLiveMutationEvidence,
} from "./provider-safety.js";

describe("Mailery provider/live-mode safety matrix", () => {
  it("declares the canonical root and excludes compatibility/stale duplicate roots from automation", () => {
    expect(MAILERY_ROOT_BOUNDARIES).toEqual([
      expect.objectContaining({ repo: "open-mailery", packageName: "@hasna/mailery", role: "canonical", automationAllowed: true }),
      expect.objectContaining({ repo: "open-emails", packageName: "@hasna/mailery", role: "compatibility", automationAllowed: false }),
      expect.objectContaining({ repo: "legacy-open-mailery", role: "excluded-stale-duplicate", automationAllowed: false }),
    ]);
  });

  it("uses canonical deployment modes and does not expose remote or hybrid as deployment modes", () => {
    expect(MAILERY_MODE_BOUNDARIES.map((entry) => entry.mode)).toEqual(["local", "self-hosted", "cloud"]);
    expect(JSON.stringify(maileryProviderSafetyMatrix())).not.toContain("\"remote\"");
    expect(JSON.stringify(maileryProviderSafetyMatrix())).not.toContain("\"hybrid\"");
  });

  it("requires no-send, no-domain-change, and signed webhook smoke evidence", () => {
    const operations = new Map(MAILERY_PROVIDER_OPERATION_GATES.map((entry) => [entry.operation, entry]));
    expect(operations.get("send_email")?.noSideEffectSmoke).toContain("[NOT SENT]");
    expect(operations.get("domain_dns_or_mx_change")?.noSideEffectSmoke).toContain("--dry-run");
    expect(operations.get("domain_dns_or_mx_change")?.requiredEvidence).toContain("explicit operator consent for MX migration");
    expect(operations.get("provider_webhook_receive")?.requiredEvidence).toContain("replay id rejection");
  });

  it("blocks live provider mutations until approval and required evidence are present", () => {
    expect(() => requireMaileryLiveMutationEvidence("send_email", [
      "provider capability allows send_email",
      "from domain ownership_status=verified",
    ])).toThrow(/Missing evidence/);

    expect(() => requireMaileryLiveMutationEvidence("send_email", [
      "provider capability allows send_email",
      "from domain ownership_status=verified",
      "from domain outbound_status=ready",
      "DKIM verified",
      "SPF verified",
      "scoped send key or trusted local operator context",
      "sandbox/no-send smoke before live mutation",
      "operator approval",
    ])).not.toThrow();
  });
});
