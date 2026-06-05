import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { listAddresses } from "../db/addresses.js";
import { listDomains } from "../db/domains.js";
import { listInboundEmails } from "../db/inbound.js";
import { resolveAlias } from "../db/aliases.js";
import { getAddressProvisioning, getDomainProvisioning } from "../db/provisioning.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { getEmailSystemStatus } from "./agent-context.js";
import { getAddressOwnershipDetail } from "./address-ownership.js";

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

function check(status: DeliveryDoctorCheck["status"], name: string, message: string, fix_command?: string): DeliveryDoctorCheck {
  return { name, status, message, fix_command };
}

export function diagnoseInboundDelivery(address: string, db: Database = getDatabase()): DeliveryDoctorReport {
  const normalized = address.trim().toLowerCase();
  const domain = normalized.includes("@") ? normalized.split("@")[1] ?? null : null;
  const checks: DeliveryDoctorCheck[] = [];
  const exactAddresses = listAddresses(undefined, db).filter((candidate) => candidate.email.toLowerCase() === normalized);
  const domainRows = domain ? listDomains(undefined, db).filter((candidate) => candidate.domain.toLowerCase() === domain) : [];
  const aliasTarget = normalized.includes("@") ? resolveAlias(normalized, db) : null;
  const recent = listInboundEmails({ recipients: [normalized], limit: 10 }, db);
  const status = getEmailSystemStatus(db);

  if (!normalized.includes("@")) {
    checks.push(check("fail", "Address format", "Expected a full email address.", undefined));
  } else {
    checks.push(check("pass", "Address format", "Address parses as local-part@domain."));
  }

  if (exactAddresses.length > 0) {
    for (const exact of exactAddresses) {
      const ownership = getAddressOwnershipDetail(exact.id, db);
      const provisioning = getAddressProvisioning(exact.id, db);
      checks.push(check("pass", "Configured address", `${exact.email} is configured on provider ${exact.provider_id.slice(0, 8)}.`));
      checks.push(provisioning?.provisioning_status === "ready"
        ? check("pass", "Address receive readiness", "Address provisioning is ready.")
        : check("warn", "Address receive readiness", `Address provisioning is ${provisioning?.provisioning_status ?? "unknown"}.`, `emails address provision ${normalized} --provider ${exact.provider_id} --wait`));
      checks.push(ownership.ownership
        ? check("pass", "Ownership", `Owned by ${ownership.address.owner?.name ?? ownership.ownership.owner_id}.`)
        : check("warn", "Ownership", "No owner/admin assigned.", `emails address set-owner ${exact.id} --owner <owner>`));
      if (ownership.history[0]) {
        const event = ownership.history[0];
        checks.push(check("pass", "Ownership audit", `Last ${event.action} at ${event.created_at}${event.actor ? ` by ${event.actor}` : ""}.`));
      }
    }
  } else if (aliasTarget) {
    checks.push(check("pass", "Alias", `${normalized} resolves to ${aliasTarget}.`));
  } else {
    checks.push(check("warn", "Configured address", "No exact address or alias configured locally.", domain ? `emails address provision ${normalized} --provider <provider>` : undefined));
  }

  if (domainRows.length > 0) {
    for (const d of domainRows) {
      const readyAddresses = listAddresses(undefined, db).filter((candidate) => {
        const provisioning = getAddressProvisioning(candidate.id, db);
        return provisioning?.domain_id === d.id && provisioning.provisioning_status === "ready";
      }).length;
      const readiness = assessDomainReadiness(d, getDomainProvisioning(d.id, db), { ready_addresses: readyAddresses });
      checks.push(readiness.receive_ready
        ? check("pass", "Domain receive readiness", `${d.domain} is receive-ready (${readiness.state}).`)
        : check("warn", "Domain receive readiness", `${d.domain} is not receive-ready (${readiness.state}).`, readiness.fix_commands[0]));
      checks.push(readiness.send_ready
        ? check("pass", "Domain send readiness", `${d.domain} is send-ready.`)
        : check("warn", "Domain send readiness", `${d.domain} send DNS is incomplete.`, `emails domain verify ${d.domain}`));
    }
  } else if (domain) {
    checks.push(check("warn", "Domain", `${domain} is not configured locally.`, `emails domain adopt ${domain} --provider <provider>`));
  }

  if (status.inbox.inbound_buckets.length > 0 || status.providers.gmail.length > 0) {
    checks.push(check("pass", "Inbound sources", `${status.inbox.inbound_buckets.length} S3 bucket(s), ${status.providers.gmail.length} Gmail provider(s) configured.`));
  } else {
    checks.push(check("fail", "Inbound sources", "No S3 inbound bucket or Gmail provider configured.", "emails inbox sync-status"));
  }

  if (status.inbox.realtime.queue_configured) {
    checks.push(check("pass", "Realtime", "Realtime queue is configured."));
  } else {
    checks.push(check("warn", "Realtime", "Realtime queue is not configured; manual refresh/sync is required.", domain ? `emails inbox setup-realtime ${domain}` : undefined));
  }

  if (recent.length > 0) {
    checks.push(check("pass", "Recent local mail", `${recent.length} local message(s) found for ${normalized}.`));
  } else {
    checks.push(check("warn", "Recent local mail", "No local messages found for this address.", `emails inbox wait ${normalized} --timeout 120`));
  }

  return {
    address: normalized,
    domain,
    alias_target: aliasTarget,
    recent_local_messages: recent.length,
    latest_received_at: recent[0]?.received_at ?? null,
    checks,
    cli_equivalent: `emails doctor delivery ${normalized} --json`,
  };
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
