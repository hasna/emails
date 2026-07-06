export type MaileryDeploymentMode = "local" | "self-hosted" | "cloud";
export type ProviderMode = "mock" | "fixture" | "sandbox" | "read_only_live" | "live_mutating";
export type SideEffectClass = "none" | "read_only" | "external_notification" | "dns_or_domain_change";

export interface MaileryRootBoundary {
  repo: "open-mailery" | "open-emails" | "legacy-open-mailery";
  packageName: string;
  role: "canonical" | "compatibility" | "excluded-stale-duplicate";
  automationAllowed: boolean;
  notes: string[];
}

export interface MaileryModeBoundary {
  mode: MaileryDeploymentMode;
  sourceOfTruth: string;
  authModel: string;
  providerCredentialModel: string;
  sideEffectGate: string;
}

export interface MaileryProviderOperationGate {
  operation: string;
  providerModes: ProviderMode[];
  sideEffectClass: SideEffectClass;
  requiredEvidence: string[];
  approvalRequired: boolean;
  noSideEffectSmoke: string;
}

export const MAILERY_ROOT_BOUNDARIES: MaileryRootBoundary[] = [
  {
    repo: "open-mailery",
    packageName: "@hasna/mailery",
    role: "canonical",
    automationAllowed: true,
    notes: ["Primary OSS root for new work, package builds, and release validation."],
  },
  {
    repo: "open-emails",
    packageName: "@hasna/mailery",
    role: "compatibility",
    automationAllowed: false,
    notes: ["Compatibility checkout/name during rename; do not route new automation here unless explicitly assigned."],
  },
  {
    repo: "legacy-open-mailery",
    packageName: "@hasna/mailery",
    role: "excluded-stale-duplicate",
    automationAllowed: false,
    notes: ["Older duplicate under /home/hasna/Workspace is excluded from new implementation tasks."],
  },
];

export const MAILERY_MODE_BOUNDARIES: MaileryModeBoundary[] = [
  {
    mode: "local",
    sourceOfTruth: "local SQLite/files",
    authModel: "local operator plus optional scoped send keys for delegated send actions",
    providerCredentialModel: "local provider credentials or sandbox provider rows",
    sideEffectGate: "real sends require outbound-ready domain state; sandbox sends stay local",
  },
  {
    mode: "self-hosted",
    sourceOfTruth: "Hasna-owned AWS RDS/S3/provider state",
    authModel: "Hasna internal operator/admin/API key in the owning AWS deployment",
    providerCredentialModel: "credential references or leases owned by the Hasna self-hosted deployment",
    sideEffectGate: "Postgres/S3/SES readiness and per-domain evidence before inbound/outbound is marked ready",
  },
  {
    mode: "cloud",
    sourceOfTruth: "Mailery Cloud API and hosted control plane",
    authModel: "cloud account/API key plus hosted tenant/billing checks",
    providerCredentialModel: "hosted credential references; OSS local provider send path is disabled",
    sideEffectGate: "cloud API must enforce tenant readiness, billing/credits, consent, and provider approval",
  },
];

export const MAILERY_PROVIDER_OPERATION_GATES: MaileryProviderOperationGate[] = [
  {
    operation: "send_email",
    providerModes: ["fixture", "sandbox", "live_mutating"],
    sideEffectClass: "external_notification",
    requiredEvidence: [
      "provider capability allows send_email",
      "from domain ownership_status=verified",
      "from domain outbound_status=ready",
      "DKIM verified",
      "SPF verified",
      "scoped send key or trusted local operator context",
      "sandbox/no-send smoke before live mutation",
    ],
    approvalRequired: true,
    noSideEffectSmoke: "mailery send --dry-run prints [NOT SENT] and does not call provider adapters or write a sent ledger row.",
  },
  {
    operation: "domain_readiness_check",
    providerModes: ["fixture", "sandbox", "read_only_live"],
    sideEffectClass: "read_only",
    requiredEvidence: [
      "DNS/domain readiness command reports missing requirements",
      "no MX/domain purchase/provider registration flags are set",
    ],
    approvalRequired: false,
    noSideEffectSmoke: "mailery domains status/check reports DNS and lifecycle state without writing DNS, buying domains, or enabling outbound.",
  },
  {
    operation: "domain_dns_or_mx_change",
    providerModes: ["sandbox", "live_mutating"],
    sideEffectClass: "dns_or_domain_change",
    requiredEvidence: [
      "dry-run DNS plan",
      "ownership proof",
      "explicit operator consent for MX migration",
      "rollback or disable instructions",
    ],
    approvalRequired: true,
    noSideEffectSmoke: "mailery provision domain --dry-run emits a plan and preserves existing MX unless --force-mx-switch is explicitly supplied.",
  },
  {
    operation: "provider_webhook_receive",
    providerModes: ["fixture", "sandbox", "read_only_live"],
    sideEffectClass: "read_only",
    requiredEvidence: [
      "signature fixture",
      "timestamp freshness check",
      "replay id rejection",
      "payload parsed into delivery event without secret output",
    ],
    approvalRequired: false,
    noSideEffectSmoke: "signed webhook fixture stores at most local delivery status evidence and rejects replayed event ids.",
  },
];

export function maileryProviderSafetyMatrix() {
  return {
    roots: MAILERY_ROOT_BOUNDARIES,
    modes: MAILERY_MODE_BOUNDARIES,
    operations: MAILERY_PROVIDER_OPERATION_GATES,
  };
}

export function requireMaileryLiveMutationEvidence(operation: string, evidence: Iterable<string>): void {
  const gate = MAILERY_PROVIDER_OPERATION_GATES.find((entry) => entry.operation === operation);
  if (!gate) throw new Error(`Unknown Mailery provider operation: ${operation}`);
  if (!gate.providerModes.includes("live_mutating")) return;

  const present = new Set(evidence);
  const missing = gate.requiredEvidence.filter((item) => !present.has(item));
  if (gate.approvalRequired && !present.has("operator approval")) missing.push("operator approval");
  if (missing.length > 0) {
    throw new Error(`Live Mailery provider mutation '${operation}' is blocked. Missing evidence: ${[...new Set(missing)].join("; ")}`);
  }
}
