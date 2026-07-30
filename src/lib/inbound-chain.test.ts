// The inbound receiving chain has FOUR links — MX → SES receipt rule → app
// registration → S3 delivery — and a domain receives mail only when all of them
// exist. The incident class under test: `emails domain add` used to write the app
// row alone, so a domain looked "added" while SES 550-bounced every message for
// it (survivalpatriots.com). This suite covers the library half of the durable
// fix: the provisioning preflight that lets `domain add` refuse BEFORE writing a
// row it cannot complete, and the per-link audit behind `emails domain readiness`.
//
// Everything here runs against INJECTED dependencies — no module mocks, no
// network, no AWS. The live fetchers are exercised through the CLI suite
// (src/cli/commands/domain.inbound-provisioning.test.ts) against the shared SDK
// mocks.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  assessAppRegistrationLink,
  assessMxLink,
  assessS3EvidenceLink,
  assessSesRuleLink,
  auditInboundChain,
  preflightInboundProvisioning,
  type ActiveReceiptRules,
} from "./inbound-chain.js";
import { classifyMxRecords, type MxAssessment } from "./mx-ownership.js";

const REGION = "us-east-1";
const BUCKET = "emails-inbound-scratch";

function rules(overrides: Partial<Extract<ActiveReceiptRules, { ok: true }>> = {}): ActiveReceiptRules {
  return {
    ok: true,
    rule_set: "emails-inbound",
    rules: [{
      name: "inbound-covered-example-com",
      enabled: true,
      recipients: ["covered.example.com"],
      s3_buckets: [BUCKET],
    }],
    ...overrides,
  };
}

const sesMx: MxAssessment = classifyMxRecords(
  [{ exchange: `inbound-smtp.${REGION}.amazonaws.com`, priority: 10 }],
  "covered.example.com",
);

// ─── preflight: refuse-before-write, never a silent app-only row ─────────────

describe("preflightInboundProvisioning", () => {
  let savedAccountId: string | undefined;
  beforeEach(() => {
    savedAccountId = process.env["AWS_ACCOUNT_ID"];
    delete process.env["AWS_ACCOUNT_ID"];
  });
  afterEach(() => {
    if (savedAccountId === undefined) delete process.env["AWS_ACCOUNT_ID"];
    else process.env["AWS_ACCOUNT_ID"] = savedAccountId;
  });

  it("refuses when no inbound bucket is resolvable, naming both ways to provide one", async () => {
    const result = await preflightInboundProvisioning({ bucket: undefined, region: REGION });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no_inbound_bucket");
    expect(result.message).toContain("--bucket");
    expect(result.message).toContain("EMAILS_INBOUND_S3_BUCKET");
  });

  it("refuses when AWS credentials cannot be resolved, naming the failure", async () => {
    const result = await preflightInboundProvisioning(
      { bucket: BUCKET, region: REGION },
      { resolveCallerAccount: async () => { throw new Error("Could not load credentials from any providers"); } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("aws_credentials_unavailable");
    expect(result.message).toContain("Could not load credentials");
  });

  it("passes when the caller account resolves", async () => {
    const result = await preflightInboundProvisioning(
      { bucket: BUCKET, region: REGION },
      { resolveCallerAccount: async () => "111122223333" },
    );
    expect(result).toEqual({ ok: true, account_id: "111122223333" });
  });

  it("accepts a pinned AWS_ACCOUNT_ID without calling the resolver (same short-circuit the SES setup uses)", async () => {
    process.env["AWS_ACCOUNT_ID"] = "123456789012";
    const result = await preflightInboundProvisioning(
      { bucket: BUCKET, region: REGION },
      { resolveCallerAccount: async () => { throw new Error("must not be called"); } },
    );
    expect(result).toEqual({ ok: true, account_id: "123456789012" });
  });
});

// ─── per-link assessors: honest ok / MISSING / unknown, never fabricated ─────

describe("assessSesRuleLink", () => {
  it("reports ok when an enabled rule covers the domain and delivers to the inbound bucket", () => {
    const link = assessSesRuleLink(rules(), "covered.example.com", BUCKET);
    expect(link.status).toBe("ok");
    expect(link.detail).toContain("inbound-covered-example-com");
    expect(link.detail).toContain(BUCKET);
  });

  it("reports MISSING with the setup command when no rule covers the domain", () => {
    const link = assessSesRuleLink(rules(), "forgotten.example.com", BUCKET);
    expect(link.status).toBe("missing");
    expect(link.detail).toContain("forgotten.example.com");
    expect(link.remediation).toContain("emails aws setup-inbound --domain forgotten.example.com");
  });

  it("reports MISSING when the only covering rule is disabled", () => {
    const link = assessSesRuleLink(rules({
      rules: [{ name: "inbound-covered-example-com", enabled: false, recipients: ["covered.example.com"], s3_buckets: [BUCKET] }],
    }), "covered.example.com", BUCKET);
    expect(link.status).toBe("missing");
    expect(link.detail).toContain("disabled");
  });

  it("reports MISSING when the covering rule has no S3 action at all", () => {
    const link = assessSesRuleLink(rules({
      rules: [{ name: "inbound-covered-example-com", enabled: true, recipients: ["covered.example.com"], s3_buckets: [] }],
    }), "covered.example.com", BUCKET);
    expect(link.status).toBe("missing");
    expect(link.detail).toContain("S3");
  });

  it("reports MISSING and names the actual bucket when the rule delivers somewhere else", () => {
    const link = assessSesRuleLink(rules({
      rules: [{ name: "inbound-covered-example-com", enabled: true, recipients: ["covered.example.com"], s3_buckets: ["some-other-bucket"] }],
    }), "covered.example.com", BUCKET);
    expect(link.status).toBe("missing");
    expect(link.detail).toContain("some-other-bucket");
  });

  it("treats a rule with no recipients as covering every domain", () => {
    const link = assessSesRuleLink(rules({
      rules: [{ name: "catch-everything", enabled: true, recipients: [], s3_buckets: [BUCKET] }],
    }), "anything.example.com", BUCKET);
    expect(link.status).toBe("ok");
  });

  it("reports MISSING when no receipt rule set is active", () => {
    const link = assessSesRuleLink(rules({ rule_set: null, rules: [] }), "covered.example.com", BUCKET);
    expect(link.status).toBe("missing");
  });

  it("NEVER fabricates ok when SES could not be read — unknown, with the error named", () => {
    const link = assessSesRuleLink({ ok: false, message: "rules unreadable from here" }, "covered.example.com", BUCKET);
    expect(link.status).toBe("unknown");
    expect(link.detail).toContain("rules unreadable from here");
  });
});

describe("assessMxLink", () => {
  it("reports ok when root MX points at SES inbound", () => {
    expect(assessMxLink(sesMx, REGION).status).toBe("ok");
  });

  it("reports MISSING with the exact record to publish when no MX exists", () => {
    const link = assessMxLink(classifyMxRecords([], "bare.example.com"), REGION);
    expect(link.status).toBe("missing");
    expect(link.remediation).toContain(`10 inbound-smtp.${REGION}.amazonaws.com`);
  });

  it("reports MISSING and names the current owner when MX belongs to another provider", () => {
    const link = assessMxLink(classifyMxRecords([{ exchange: "aspmx.l.google.com", priority: 1 }], "gsuite.example.com"), REGION);
    expect(link.status).toBe("missing");
    expect(link.detail).toContain("Google Workspace");
  });

  it("reports unknown — not ok, not missing — when DNS resolution itself failed", () => {
    const unresolved: MxAssessment = {
      domain: "dark.example.com",
      owner: "unknown",
      records: [],
      summary: "Could not resolve root MX records: servers unreachable",
      protects_existing_inbound: true,
    };
    expect(assessMxLink(unresolved, REGION).status).toBe("unknown");
  });
});

describe("assessS3EvidenceLink", () => {
  it("reports ok when objects exist under the domain prefix", () => {
    const link = assessS3EvidenceLink("covered.example.com", BUCKET, { ok: true, objects: 1 });
    expect(link.status).toBe("ok");
  });

  it("reports an honest lower bound — unknown, never ok — when no objects are observed", () => {
    const link = assessS3EvidenceLink("covered.example.com", BUCKET, { ok: true, objects: 0 });
    expect(link.status).toBe("unknown");
    expect(link.detail.toLowerCase()).toContain("lower bound");
  });

  it("reports unknown when the bucket cannot be listed", () => {
    const link = assessS3EvidenceLink("covered.example.com", BUCKET, { ok: false, message: "denied" });
    expect(link.status).toBe("unknown");
    expect(link.detail).toContain("denied");
  });

  it("reports unknown when no bucket is resolvable at all", () => {
    expect(assessS3EvidenceLink("covered.example.com", undefined, null).status).toBe("unknown");
  });
});

describe("assessAppRegistrationLink", () => {
  it("reports ok when the app row exists and MISSING with the add command when it does not", () => {
    expect(assessAppRegistrationLink("covered.example.com", true).status).toBe("ok");
    const missing = assessAppRegistrationLink("ghost.example.com", false);
    expect(missing.status).toBe("missing");
    expect(missing.remediation).toContain("emails domain add ghost.example.com");
  });
});

// ─── the composed audit: the drift detector itself ───────────────────────────

describe("auditInboundChain", () => {
  it("detects a MISSING-SES-RULE domain: app row present, MX live, no receipt rule — the incident shape", async () => {
    const report = await auditInboundChain(
      { domain: "covered.example.com", region: REGION, bucket: BUCKET, appRegistered: true },
      {
        inspectMx: async () => sesMx,
        fetchRules: async () => rules({ rules: [] }),
        countPrefixObjects: async () => 0,
      },
    );
    expect(report.drift).toBe(true);
    expect(report.receiving_ready).toBe(false);
    const ses = report.links.find((link) => link.link === "ses_receipt_rule");
    expect(ses?.status).toBe("missing");
    expect(ses?.remediation).toContain("setup-inbound");
    expect(report.links.find((link) => link.link === "app_registration")?.status).toBe("ok");
    expect(report.links.find((link) => link.link === "mx")?.status).toBe("ok");
  });

  it("reports a fully-provisioned domain as ready with no drift", async () => {
    const report = await auditInboundChain(
      { domain: "covered.example.com", region: REGION, bucket: BUCKET, appRegistered: true },
      {
        inspectMx: async () => sesMx,
        fetchRules: async () => rules(),
        countPrefixObjects: async () => 3,
      },
    );
    expect(report.drift).toBe(false);
    expect(report.receiving_ready).toBe(true);
    expect(report.links).toHaveLength(4);
    expect(report.links.every((link) => link.link === "s3_delivery_evidence" || link.status === "ok")).toBe(true);
  });

  it("does not let an unknown link masquerade as ready", async () => {
    const report = await auditInboundChain(
      { domain: "covered.example.com", region: REGION, bucket: BUCKET, appRegistered: true },
      {
        inspectMx: async () => sesMx,
        fetchRules: async () => ({ ok: false, message: "rules unreadable" }),
        countPrefixObjects: async () => 0,
      },
    );
    expect(report.receiving_ready).toBe(false);
    // Unknown is not drift — nothing is PROVEN broken — but it is not readiness either.
    expect(report.drift).toBe(false);
    expect(report.links.find((link) => link.link === "ses_receipt_rule")?.status).toBe("unknown");
  });
});
