import { describe, expect, it } from "bun:test";
import {
  formatDeliveryDoctorReport,
  type DeliveryDoctorReport,
} from "./delivery-doctor.js";
import {
  diagnoseInboundDelivery,
  diagnoseInboundDeliveryLive,
} from "./delivery-doctor.remote.js";

// Inbound delivery diagnosis inspects local delivery infrastructure (the inbound
// message store, provisioning/readiness state, S3 ingestion sources, the realtime
// queue). In the self-hosted client all of that lives on the operator's server,
// so both entrypoints are loud stubs. The pure report formatter still runs.
describe("diagnoseInboundDelivery (self-hosted stub)", () => {
  it("throws because inbound delivery diagnostics run on the self-hosted server", () => {
    expect(() => diagnoseInboundDelivery("ops@example.com")).toThrow(
      /diagnoseInboundDelivery is not available in the self-hosted client/,
    );
  });
});

describe("diagnoseInboundDeliveryLive (self-hosted stub)", () => {
  it("throws because inbound delivery diagnostics run on the self-hosted server", async () => {
    await expect(diagnoseInboundDeliveryLive("ops@example.com")).rejects.toThrow(
      /diagnoseInboundDeliveryLive is not available in the self-hosted client/,
    );
  });
});

describe("formatDeliveryDoctorReport", () => {
  it("renders checks and fix commands", () => {
    const report: DeliveryDoctorReport = {
      address: "ops@example.com",
      domain: "example.com",
      alias_target: null,
      recent_local_messages: 2,
      latest_received_at: "2026-01-02T10:00:00.000Z",
      checks: [
        { name: "Configured address", status: "pass", message: "found" },
        { name: "Public MX", status: "warn", message: "Google Workspace", fix_command: "emails forwarding explain ops@example.com" },
      ],
      cli_equivalent: "emails doctor delivery ops@example.com",
    };
    const out = formatDeliveryDoctorReport(report);
    expect(out).toContain("Delivery diagnosis: ops@example.com");
    expect(out).toContain("[ok] Configured address");
    expect(out).toContain("[warn] Public MX");
    expect(out).toContain("fix: emails forwarding explain ops@example.com");
  });
});
