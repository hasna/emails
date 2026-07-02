import type { Domain } from "../types/index.js";
import type { DomainProvisioning } from "../db/provisioning.js";

export type DomainReadinessState =
  | "ready_to_send_and_receive"
  | "ready_to_send"
  | "ready_to_receive"
  | "needs_dns"
  | "broken";

export interface DomainReadiness {
  state: DomainReadinessState;
  send_ready: boolean;
  receive_ready: boolean;
  ready_addresses: number;
  issues: string[];
  fix_commands: string[];
}

export interface DomainReadinessSignals {
  ready_addresses?: number;
}

function ok(status: string | null | undefined): boolean {
  return status === "verified";
}

function bad(status: string | null | undefined): boolean {
  return status === "failed";
}

export function assessDomainReadiness(
  domain: Pick<Domain, "domain" | "dkim_status" | "spf_status" | "dmarc_status">,
  provisioning?: DomainProvisioning | null,
  signals: DomainReadinessSignals = {},
): DomainReadiness {
  const issues: string[] = [];
  const fix_commands: string[] = [];
  const readyAddresses = signals.ready_addresses ?? 0;

  if (!ok(domain.dkim_status)) issues.push(`DKIM ${domain.dkim_status}`);
  if (!ok(domain.spf_status)) issues.push(`SPF ${domain.spf_status}`);
  if (!ok(domain.dmarc_status)) issues.push(`DMARC ${domain.dmarc_status}`);
  if (bad(domain.dkim_status) || bad(domain.spf_status) || provisioning?.last_error) {
    if (provisioning?.last_error) issues.push(provisioning.last_error);
    fix_commands.push(`mailery domain check ${domain.domain}`);
    fix_commands.push(`mailery domain setup-cloudflare ${domain.domain}`);
    return { state: "broken", send_ready: false, receive_ready: readyAddresses > 0, ready_addresses: readyAddresses, issues, fix_commands };
  }

  const sendReady = ok(domain.dkim_status) && ok(domain.spf_status);
  const receiveReady = readyAddresses > 0 || provisioning?.provisioning_status === "ready" || provisioning?.provisioning_status === "inbound_ready";

  if (!sendReady) {
    fix_commands.push(`mailery domain dns ${domain.domain}`);
    fix_commands.push(`mailery domain verify ${domain.domain}`);
  }
  if (!receiveReady) {
    fix_commands.push(`mailery domain check ${domain.domain}`);
    fix_commands.push(`mailery provision domain ${domain.domain} --provider <provider> --dry-run`);
  }

  let state: DomainReadinessState;
  if (sendReady && receiveReady) state = "ready_to_send_and_receive";
  else if (sendReady) state = "ready_to_send";
  else if (receiveReady) state = "ready_to_receive";
  else state = "needs_dns";

  return { state, send_ready: sendReady, receive_ready: receiveReady, ready_addresses: readyAddresses, issues, fix_commands };
}

export function formatDomainReadinessState(state: DomainReadinessState): string {
  return state.replace(/_/g, " ");
}
