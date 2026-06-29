import type { Database } from "../db/database.js";
import {
  parseContract,
  SCHEMA_IDS,
  type ProjectPanel,
  type ProjectPanelInput,
} from "@hasna/contracts";
import { listInboundEmailSummaries, type InboundEmailSummary } from "../db/inbound.js";
import { getEmailSystemStatus } from "./agent-context.js";

export interface MaileryProjectPanelOptions {
  limit?: number;
  db?: Database;
}

const SOURCE_PACKAGE = "@hasna/mailery";

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(limit ?? 20)));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "mailery";
}

function emailTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function projectResource(projectId: string, projectName: string) {
  return {
    kind: "project" as const,
    id: projectId,
    name: projectName,
    uri: `project://${projectId}`,
    externalId: projectId,
    sourcePackage: SOURCE_PACKAGE,
  };
}

function inboundEmailResource(email: InboundEmailSummary) {
  return {
    kind: "email" as const,
    id: email.id,
    name: email.subject || "(no subject)",
    uri: `mailery://inbound/${email.id}`,
    externalId: email.id,
    sourcePackage: SOURCE_PACKAGE,
    tags: [
      email.is_read ? "read" : "unread",
      email.is_sent ? "sent" : "inbound",
      ...(email.attachments.length > 0 ? ["attachments"] : []),
    ],
  };
}

function emailSummary(email: InboundEmailSummary): string {
  const from = email.from_address || "unknown sender";
  const attachments = email.attachments.length > 0 ? ` · ${email.attachments.length} attachment${email.attachments.length === 1 ? "" : "s"}` : "";
  return `${from}${attachments}`;
}

function loadRecentInbound(limit: number, db?: Database): InboundEmailSummary[] {
  const unread = listInboundEmailSummaries({ unread: true, limit }, db);
  if (unread.length > 0) return unread;
  return listInboundEmailSummaries({ limit }, db);
}

export function createMaileryProjectPanel(projectRef: string, options: MaileryProjectPanelOptions = {}): ProjectPanel {
  const limit = clampLimit(options.limit);
  const generatedAt = new Date().toISOString();
  const projectId = slugify(projectRef);
  const status = getEmailSystemStatus(options.db);
  const recentInbound = loadRecentInbound(limit, options.db);
  const provisioningFailures = status.provisioning.domains_failed + status.provisioning.addresses_failed;
  const hasMaileryState = status.providers.total > 0 || status.domains.total > 0 || status.addresses.total > 0 || status.inbox.total > 0;

  const draft: ProjectPanelInput = {
    schema: SCHEMA_IDS.projectPanel,
    id: `mailery_panel_${projectId}`,
    createdAt: generatedAt,
    projectId,
    provider: {
      kind: "mailery",
      id: `mailery_${projectId}`,
      name: "Mailery",
      sourcePackage: SOURCE_PACKAGE,
      externalId: projectId,
    },
    kind: "mailery",
    title: "Mailery",
    summary: hasMaileryState
      ? `${status.inbox.unread} unread inbound email${status.inbox.unread === 1 ? "" : "s"} across ${status.providers.active}/${status.providers.total} active provider${status.providers.total === 1 ? "" : "s"}.`
      : "No Mailery providers, domains, addresses, or inbound emails are configured yet.",
    state: hasMaileryState ? "ready" : "empty",
    generatedAt,
    freshness: status.inbox.latest_received_at ? "fresh" : "unknown",
    metrics: [
      { id: "providers_total", label: "Providers", value: status.providers.total, status: status.providers.total > 0 ? "good" : "unknown" },
      { id: "providers_active", label: "Active providers", value: status.providers.active, status: status.providers.active > 0 ? "good" : "warning" },
      { id: "domains_send_ready", label: "Send-ready domains", value: status.domains.send_ready, status: status.domains.send_ready > 0 ? "good" : "unknown" },
      { id: "domains_receive_ready", label: "Receive-ready domains", value: status.domains.receive_ready, status: status.domains.receive_ready > 0 ? "good" : "unknown" },
      { id: "addresses_verified", label: "Verified addresses", value: status.addresses.verified, status: status.addresses.verified > 0 ? "good" : "unknown" },
      { id: "addresses_ready_to_receive", label: "Receive-ready addresses", value: status.addresses.ready_to_receive, status: status.addresses.ready_to_receive > 0 ? "good" : "unknown" },
      { id: "inbox_total", label: "Inbound emails", value: status.inbox.total, status: status.inbox.total > 0 ? "good" : "unknown" },
      { id: "inbox_unread", label: "Unread inbound", value: status.inbox.unread, status: status.inbox.unread > 0 ? "warning" : "good" },
      { id: "provisioning_failures", label: "Provisioning failures", value: provisioningFailures, status: provisioningFailures > 0 ? "critical" : "good" },
    ],
    items: recentInbound.map((email) => ({
      id: email.id,
      title: email.subject || "(no subject)",
      summary: emailSummary(email),
      status: email.is_read ? "read" : "unread",
      priority: email.is_read ? "low" : "medium",
      timestamp: emailTimestamp(email.received_at),
      resourceRefs: [inboundEmailResource(email)],
      metadata: {
        provider_id: email.provider_id,
        message_id: email.message_id,
        thread_id: email.thread_id,
        from_address: email.from_address,
        to_count: email.to_addresses.length,
        cc_count: email.cc_addresses.length,
        attachment_count: email.attachments.length,
      },
    })),
    actions: [
      { kind: "action", id: "mailery:status", name: "Show Mailery status", sourcePackage: SOURCE_PACKAGE, externalId: "status" },
      { kind: "action", id: "mailery:inbox", name: "List inbox", sourcePackage: SOURCE_PACKAGE, externalId: "inbox" },
    ],
    resourceRefs: [
      projectResource(projectId, projectRef),
      ...status.providers.gmail.slice(0, limit).map((provider) => ({
        kind: "integration" as const,
        id: provider.id,
        name: provider.name,
        uri: `mailery://providers/${provider.id}`,
        externalId: provider.id,
        sourcePackage: SOURCE_PACKAGE,
        tags: ["gmail"],
      })),
    ],
    renderFragment: {
      renderer: "json_render",
      title: "Mailery",
      spec: {
        component: "project.mailery.summary",
        metrics: ["providers_active", "inbox_unread", "domains_send_ready", "addresses_ready_to_receive", "provisioning_failures"],
        itemLimit: limit,
      },
    },
    warnings: [
      "Mailery does not yet persist a project-to-email mapping; this panel summarizes the current Mailery workspace.",
    ],
  };

  return parseContract(SCHEMA_IDS.projectPanel, draft);
}
