import { resolveEmailsMode } from "./mode.js";
import type { DoctorCheck } from "./diagnostics-format.js";
import type { EmailsModeResolution } from "./mode.js";

export { formatDiagnostics } from "./diagnostics-format.js";
export type { DoctorCheck } from "./diagnostics-format.js";

export interface DiagnosticsOptions {
  liveProviderChecks?: boolean;
}

async function selfHostedDiagnostics(mode: EmailsModeResolution): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [{
    name: "Mode",
    status: "pass",
    message: `${mode.label} mode (${mode.mode})`,
  }];

  try {
    const { resolveSelfHostedConfig } = await import("../db/self-hosted-store.js");
    const config = resolveSelfHostedConfig();
    checks.push({
      name: "Self-hosted API",
      status: config ? "pass" : "fail",
      message: config
        ? "Self-hosted client configuration is present. Local SQLite diagnostics are disabled in self_hosted API-only mode; probe the operator service with GET /health and GET /ready."
        : "Self-hosted mode is selected, but the self-hosted API client configuration is incomplete. Set EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY, then use the operator service /health and /ready probes.",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "Self-hosted API",
      status: "fail",
      message: `Self-hosted API client configuration is not usable: ${detail}`,
    });
  }

  checks.push({
    name: "Local SQLite",
    status: "warn",
    message: "Skipped by design: self_hosted is API-only and must not open or create a local emails.db for diagnostics.",
  });

  return checks;
}

// The client is self-hosted-ONLY: diagnostics never open a local SQLite database.
// The local resources (providers, domains, addresses, contacts, templates) and
// delivery health live behind the operator's `/v1` API and its own /health and
// /ready probes, so `runDiagnostics` only validates the self-hosted client
// configuration. `_opts` (liveProviderChecks) is retained for signature
// compatibility but no longer opens local state.
export async function runDiagnostics(_opts: DiagnosticsOptions = {}): Promise<DoctorCheck[]> {
  const mode = resolveEmailsMode();
  return selfHostedDiagnostics(mode);
}
