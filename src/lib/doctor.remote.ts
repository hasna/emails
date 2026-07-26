import { resolveEmailsMode } from "./mode.js";
import type { DoctorCheck } from "./diagnostics-format.js";
import type { EmailsModeResolution } from "./mode.js";

export { formatDiagnostics } from "./diagnostics-format.js";
export type { DoctorCheck } from "./diagnostics-format.js";

export interface DiagnosticsOptions {
  liveProviderChecks?: boolean;
}

// The client is self-hosted-ONLY here: diagnostics never open a local SQLite
// database. What they MUST do is actually contact the operator service.
//
// This module used to report `name: "Self-hosted API", status: "pass"` purely
// because the local client config PARSED — without ever making a request. It is
// reachable from the MCP tool surface and the SDK, so an agent asking "is the
// email system healthy?" got a green light that proved nothing about the server:
// the same fabrication class as `emails status` reporting zero providers.
// `/health` and `/ready` exist on the deployed service, so they are probed now,
// and a config that merely parses is reported as a WARN that says so.

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonField(json: unknown, key: string): string | null {
  if (!json || typeof json !== "object") return null;
  const value = (json as Record<string, unknown>)[key];
  return value == null ? null : String(value);
}

async function probeChecks(): Promise<DoctorCheck[]> {
  const { selfHostedProbe } = await import("../db/self-hosted-store.js");

  const health = ((): DoctorCheck => {
    try {
      const result = selfHostedProbe("/health");
      if (result.status === 200) {
        const version = jsonField(result.json, "version");
        return {
          name: "Self-hosted API /health",
          status: "pass",
          message: `GET /health -> 200${version ? ` (server version ${version})` : ""}.`,
        };
      }
      return {
        name: "Self-hosted API /health",
        status: "fail",
        message: `GET /health -> HTTP ${result.status}. The operator service is not answering its health probe.`,
      };
    } catch (error) {
      return {
        name: "Self-hosted API /health",
        status: "fail",
        message: `GET /health could not be performed: ${detailOf(error)}`,
      };
    }
  })();

  const ready = ((): DoctorCheck => {
    try {
      const result = selfHostedProbe("/ready");
      if (result.status === 200) {
        return { name: "Self-hosted API /ready", status: "pass", message: "GET /ready -> 200 (ready)." };
      }
      const pending = jsonField(result.json, "pendingMigrations");
      return {
        name: "Self-hosted API /ready",
        status: "fail",
        message: `GET /ready -> HTTP ${result.status} (${jsonField(result.json, "status") ?? "not_ready"})`
          + `${pending ? `; pending migrations: ${pending}` : ""}.`,
      };
    } catch (error) {
      return {
        name: "Self-hosted API /ready",
        status: "fail",
        message: `GET /ready could not be performed: ${detailOf(error)}`,
      };
    }
  })();

  return [health, ready];
}

async function selfHostedDiagnostics(mode: EmailsModeResolution): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [{
    name: "Mode",
    status: "pass",
    message: `${mode.label} mode (${mode.mode})`,
  }];

  try {
    const { resolveSelfHostedConfig } = await import("../db/self-hosted-store.js");
    resolveSelfHostedConfig();
    checks.push({
      name: "Self-hosted client configuration",
      // A parsed config is NOT evidence the service works. It is only evidence
      // that this client knows where to look.
      status: "warn",
      message: "Client configuration is present (URL + credential resolved). Not a health signal on its own — see the /health and /ready probes below.",
    });
  } catch (error) {
    checks.push({
      name: "Self-hosted client configuration",
      status: "fail",
      message: `Self-hosted API client configuration is not usable: ${detailOf(error)}. `
        + "Set EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY (or EMAILS_CLIENT_ENV_SECRET).",
    });
  }

  // Always probe. probeChecks() reports the real outcome of each request,
  // including "could not be performed" when configuration resolution fails —
  // never a pass inferred from configuration alone.
  checks.push(...await probeChecks());

  checks.push({
    name: "Local SQLite",
    status: "warn",
    message: "Skipped by design: self_hosted is API-only and must not open or create a local emails.db for diagnostics.",
  });

  return checks;
}

/**
 * `_opts` (liveProviderChecks) is retained for signature compatibility; local
 * provider credentials do not exist in this mode — the server signs and sends.
 */
export async function runDiagnostics(_opts: DiagnosticsOptions = {}): Promise<DoctorCheck[]> {
  const mode = resolveEmailsMode();
  return selfHostedDiagnostics(mode);
}
