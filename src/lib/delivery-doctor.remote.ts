import type { MxAssessment } from "./mx-ownership.js";

export interface DeliveryDoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix_command?: string;
}

export interface DeliveryDoctorReport {
  address: string;
  domain: string | null;
  alias_target: string | null;
  recent_local_messages: number;
  latest_received_at: string | null;
  checks: DeliveryDoctorCheck[];
  cli_equivalent: string;
}

export interface LiveDeliveryDoctorOptions {
  inspectMx?: (domain: string) => Promise<MxAssessment>;
}

// Inbound delivery diagnosis inspects LOCAL delivery infrastructure — the local
// inbound message store (recent mail), local provisioning/readiness state, the
// configured S3 ingestion sources, and the realtime queue. In the self-hosted
// client all of that lives on the operator's server, so these diagnostics run
// server-side. The stubs preserve their signatures/return type and fail loud.
export function diagnoseInboundDelivery(_address: string): DeliveryDoctorReport {
  throw new Error(
    "diagnoseInboundDelivery is not available in the self-hosted client; inbound delivery diagnostics run on the self-hosted server.",
  );
}

export async function diagnoseInboundDeliveryLive(
  _address: string,
  _opts: LiveDeliveryDoctorOptions = {},
): Promise<DeliveryDoctorReport> {
  throw new Error(
    "diagnoseInboundDeliveryLive is not available in the self-hosted client; inbound delivery diagnostics run on the self-hosted server.",
  );
}

export function formatDeliveryDoctorReport(report: DeliveryDoctorReport): string {
  const lines = [`Delivery diagnosis: ${report.address}`];
  lines.push(`  Domain:   ${report.domain ?? "(none)"}`);
  lines.push(`  Alias:    ${report.alias_target ?? "(none)"}`);
  lines.push(`  Recent:   ${report.recent_local_messages}${report.latest_received_at ? `, latest ${report.latest_received_at}` : ""}`);
  lines.push("");
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "fail";
    lines.push(`  [${mark}] ${c.name}: ${c.message}`);
    if (c.fix_command) lines.push(`        fix: ${c.fix_command}`);
  }
  return lines.join("\n");
}
