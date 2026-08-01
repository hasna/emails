/**
 * The inbound receiving chain, as one auditable object.
 *
 * A domain receives mail only when the FULL chain exists:
 *
 *   1. MX        — the domain's root MX resolves to `inbound-smtp.<region>.amazonaws.com`
 *   2. SES rule  — an ENABLED receipt rule in the active rule set covers the domain
 *                  with an S3 action into the inbound bucket
 *   3. app row   — the domain is registered in the emails app, so the synced mail
 *                  is owned and routable
 *   4. S3        — (evidence, best-effort) objects actually appear under the
 *                  domain's inbound prefix
 *
 * Any missing link silently bounces or strands mail while the domain still looks
 * "added" — the incident class this module exists to end. Two consumers:
 *
 *   * `emails domain add` calls {@link preflightInboundProvisioning} BEFORE
 *     writing the app row, so a context that cannot complete the chain produces
 *     a refusal instead of a half-provisioned domain;
 *   * `emails domain readiness` calls {@link auditInboundChain} per domain and
 *     reports each link as ok / MISSING / unknown with its remediation — the
 *     drift detector that catches a partial domain proactively.
 *
 * The assessors are PURE and unit-tested; the live fetchers keep the AWS clients
 * behind per-call dynamic imports (the same rule src/lib/aws-inbound.ts follows,
 * and deliberately WITHOUT module-level promise caching, so test-registered SDK
 * mocks always take effect). Nothing here mutates AWS — reads only.
 */

import type { MxAssessment } from "./mx-ownership.js";
import { inspectPublicMx, ownerLabel } from "./mx-ownership.js";

// ─── provisioning preflight ──────────────────────────────────────────────────

export type InboundPreflight =
  | { ok: true; account_id: string | null }
  | { ok: false; code: "no_inbound_bucket" | "aws_credentials_unavailable"; message: string };

export interface PreflightDeps {
  /** Resolve the caller's AWS account id; a throw means "no usable credentials". */
  resolveCallerAccount?: () => Promise<string | undefined>;
}

async function liveCallerAccount(region: string): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region });
  return (await sts.send(new GetCallerIdentityCommand({}))).Account;
}

/**
 * Can the SES receipt rule actually be created from THIS context? Answered
 * BEFORE any row is written, so the caller can refuse instead of registering a
 * domain whose inbound half it cannot complete.
 *
 * A pinned `AWS_ACCOUNT_ID` is accepted without an STS call — the same
 * short-circuit `setupInboundEmail` uses for its bucket-policy condition.
 */
export async function preflightInboundProvisioning(
  input: { bucket?: string; region: string },
  deps: PreflightDeps = {},
): Promise<InboundPreflight> {
  if (!input.bucket) {
    return {
      ok: false,
      code: "no_inbound_bucket",
      message: "no inbound S3 bucket is resolvable — pass --bucket or set EMAILS_INBOUND_S3_BUCKET "
        + "(the inbound_s3_bucket config key), so the SES receipt rule has somewhere to deliver.",
    };
  }
  const pinned = process.env["AWS_ACCOUNT_ID"];
  if (pinned) return { ok: true, account_id: pinned };
  const resolve = deps.resolveCallerAccount ?? (() => liveCallerAccount(input.region));
  try {
    const account = await resolve();
    return { ok: true, account_id: account ?? null };
  } catch (e) {
    return {
      ok: false,
      code: "aws_credentials_unavailable",
      message: `AWS credentials could not be resolved from this context (${e instanceof Error ? e.message : String(e)}), `
        + "so the SES receipt rule cannot be created.",
    };
  }
}

// ─── SES receipt-rule view ───────────────────────────────────────────────────

export interface SesReceiptRuleView {
  name: string;
  enabled: boolean;
  recipients: string[];
  /** Bucket names of the rule's S3 actions (empty = no S3 action). */
  s3_buckets: string[];
  /** S3 delivery targets for prefix-sensitive readiness checks. */
  s3_actions?: Array<{ bucket: string; prefix: string }>;
}

export type ActiveReceiptRules =
  | { ok: true; rule_set: string | null; rules: SesReceiptRuleView[] }
  | { ok: false; message: string };

/**
 * Read the ACTIVE receipt rule set. A failed read is returned as `ok: false`
 * with the error named — never as an empty rule list, which would let the audit
 * report MISSING (or worse, ok) for a question it could not actually ask.
 */
export async function fetchActiveReceiptRules(region: string): Promise<ActiveReceiptRules> {
  try {
    const { SESClient, DescribeActiveReceiptRuleSetCommand } = await import("@aws-sdk/client-ses");
    const ses = new SESClient({ region });
    const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    const rules = (active.Rules ?? []).map((rule) => {
      const s3Actions = (rule.Actions ?? []).flatMap((action) => {
        const s3 = action.S3Action;
        if (!s3 || typeof s3.BucketName !== "string") return [];
        return [{ bucket: s3.BucketName, prefix: s3.ObjectKeyPrefix ?? "" }];
      });
      return {
        name: rule.Name ?? "",
        enabled: rule.Enabled === true,
        recipients: (rule.Recipients ?? []).map((recipient) => recipient.trim().toLowerCase()),
        s3_buckets: s3Actions.map((action) => action.bucket),
        s3_actions: s3Actions,
      };
    });
    return { ok: true, rule_set: active.Metadata?.Name ?? null, rules };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Best-effort: how many objects sit under the domain's inbound prefix (0..1 sampled). */
async function liveCountPrefixObjects(bucket: string, prefix: string, region: string): Promise<number> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
  return listed.KeyCount ?? listed.Contents?.length ?? 0;
}

// ─── the audit report ────────────────────────────────────────────────────────

export type ChainLinkStatus = "ok" | "missing" | "unknown";
export type ChainLinkName = "mx" | "ses_receipt_rule" | "app_registration" | "s3_delivery_evidence";

export interface ChainLink {
  link: ChainLinkName;
  /**
   * `ok` only when the link is POSITIVELY verified; `missing` only when it is
   * positively absent; `unknown` when the question could not be answered (a
   * failed AWS/DNS read, or evidence that is only a lower bound). An audit that
   * cannot see never claims ok — and never claims missing either.
   */
  status: ChainLinkStatus;
  detail: string;
  remediation: string | null;
}

export interface InboundChainReport {
  domain: string;
  /** True when at least one link is positively MISSING — the half-provisioned shape. */
  drift: boolean;
  /** True only when MX, the SES rule, and the app registration are all positively ok. */
  receiving_ready: boolean;
  links: ChainLink[];
}

export function assessMxLink(assessment: MxAssessment, region: string): ChainLink {
  const publish = `publish in DNS:  MX  ${assessment.domain ?? "<domain>"}  10 inbound-smtp.${region}.amazonaws.com`;
  if (assessment.owner === "aws-ses") {
    return { link: "mx", status: "ok", detail: assessment.summary, remediation: null };
  }
  if (assessment.owner === "unknown" && assessment.records.length === 0) {
    // Resolution itself failed: the truthful answer is "could not check".
    return { link: "mx", status: "unknown", detail: assessment.summary, remediation: "re-run when DNS resolution is available" };
  }
  if (assessment.records.length === 0) {
    return { link: "mx", status: "missing", detail: "no root MX records are published", remediation: publish };
  }
  return {
    link: "mx",
    status: "missing",
    detail: `root MX belongs to ${ownerLabel(assessment.owner)} (${assessment.summary})`,
    remediation: `${publish} — or keep the domain send-only on purpose if ${ownerLabel(assessment.owner)} should stay the mailbox`,
  };
}

export function assessSesRuleLink(rules: ActiveReceiptRules, domain: string, bucket: string | undefined): ChainLink {
  const setup = `emails aws setup-inbound --domain ${domain}${bucket ? ` --bucket ${bucket}` : ""} (or re-run 'emails domain add ${domain}')`;
  const wantedPrefix = `inbound/${domain}/`;
  if (!rules.ok) {
    return {
      link: "ses_receipt_rule",
      status: "unknown",
      detail: `SES receipt rules could not be read: ${rules.message}`,
      remediation: "verify AWS credentials/region for this context, then re-run",
    };
  }
  if (!rules.rule_set) {
    return { link: "ses_receipt_rule", status: "missing", detail: "no SES receipt rule set is active", remediation: setup };
  }
  const wanted = domain.trim().toLowerCase();
  const covering = rules.rules.filter((rule) => rule.recipients.length === 0 || rule.recipients.includes(wanted));
  if (covering.length === 0) {
    return {
      link: "ses_receipt_rule",
      status: "missing",
      detail: `no receipt rule in active set '${rules.rule_set}' covers ${domain}`,
      remediation: setup,
    };
  }
  const enabled = covering.filter((rule) => rule.enabled);
  if (enabled.length === 0) {
    return {
      link: "ses_receipt_rule",
      status: "missing",
      detail: `rule '${covering[0]!.name}' covers ${domain} but is disabled`,
      remediation: setup,
    };
  }
  const withS3 = enabled.filter((rule) => rule.s3_buckets.length > 0);
  if (withS3.length === 0) {
    return {
      link: "ses_receipt_rule",
      status: "missing",
      detail: `rule '${enabled[0]!.name}' covers ${domain} but has no S3 action`,
      remediation: setup,
    };
  }
  if (bucket) {
    const bucketMatches = withS3.filter((rule) => rule.s3_buckets.includes(bucket));
    const delivering = bucketMatches.find((rule) => {
      if (!rule.s3_actions) return true;
      return rule.s3_actions.some((action) => action.bucket === bucket && action.prefix === wantedPrefix);
    });
    if (!delivering) {
      const wrongPrefix = bucketMatches
        .flatMap((rule) => rule.s3_actions ?? [])
        .find((action) => action.bucket === bucket);
      const elsewhere = [...new Set(withS3.flatMap((rule) => rule.s3_buckets))].join(", ");
      return {
        link: "ses_receipt_rule",
        status: "missing",
        detail: wrongPrefix
          ? `rule '${bucketMatches[0]!.name}' delivers to s3://${bucket}/${wrongPrefix.prefix}, not s3://${bucket}/${wantedPrefix} — mail lands where the registered source does not read it`
          : `rule '${withS3[0]!.name}' delivers to ${elsewhere}, not the configured inbound bucket ${bucket} — mail lands where nothing reads it`,
        remediation: setup,
      };
    }
    return {
      link: "ses_receipt_rule",
      status: "ok",
      detail: `rule '${delivering.name}' in set '${rules.rule_set}' delivers to s3://${bucket}/${wantedPrefix}`,
      remediation: null,
    };
  }
  return {
    link: "ses_receipt_rule",
    status: "ok",
    detail: `rule '${withS3[0]!.name}' in set '${rules.rule_set}' delivers to s3://${withS3[0]!.s3_buckets[0]}`,
    remediation: null,
  };
}

export function assessAppRegistrationLink(domain: string, registered: boolean): ChainLink {
  if (registered) {
    return { link: "app_registration", status: "ok", detail: "the domain is registered in the emails app", remediation: null };
  }
  return {
    link: "app_registration",
    status: "missing",
    detail: "the domain is not registered in the emails app — synced mail would be unowned",
    remediation: `emails domain add ${domain} --provider <id>`,
  };
}

export type S3Evidence = { ok: true; objects: number } | { ok: false; message: string };

export function assessS3EvidenceLink(domain: string, bucket: string | undefined, observed: S3Evidence | null): ChainLink {
  const prefix = `inbound/${domain}/`;
  if (!bucket || observed === null) {
    return {
      link: "s3_delivery_evidence",
      status: "unknown",
      detail: "no inbound bucket is resolvable, so delivery evidence was not checked",
      remediation: null,
    };
  }
  if (!observed.ok) {
    return {
      link: "s3_delivery_evidence",
      status: "unknown",
      detail: `s3://${bucket}/${prefix} could not be listed: ${observed.message}`,
      remediation: null,
    };
  }
  if (observed.objects > 0) {
    return {
      link: "s3_delivery_evidence",
      status: "ok",
      detail: `objects present under s3://${bucket}/${prefix}`,
      remediation: null,
    };
  }
  return {
    link: "s3_delivery_evidence",
    status: "unknown",
    detail: `no objects under s3://${bucket}/${prefix} yet — a lower bound: the domain may simply not have received mail since provisioning`,
    remediation: null,
  };
}

export interface InboundChainDeps {
  inspectMx?: (domain: string) => Promise<MxAssessment>;
  fetchRules?: (region: string) => Promise<ActiveReceiptRules>;
  countPrefixObjects?: (bucket: string, prefix: string, region: string) => Promise<number>;
}

/**
 * Audit every link of one domain's inbound chain. Reads only; every link that
 * cannot be answered is reported `unknown` with the reason — never a fabricated
 * ok, and never a fabricated MISSING.
 */
export async function auditInboundChain(
  input: { domain: string; region: string; bucket?: string; appRegistered: boolean },
  deps: InboundChainDeps = {},
): Promise<InboundChainReport> {
  const inspectMx = deps.inspectMx ?? inspectPublicMx;
  const fetchRules = deps.fetchRules ?? fetchActiveReceiptRules;
  const countObjects = deps.countPrefixObjects ?? liveCountPrefixObjects;

  const [mxAssessment, rules] = await Promise.all([
    inspectMx(input.domain),
    fetchRules(input.region),
  ]);

  let evidence: S3Evidence | null = null;
  if (input.bucket) {
    try {
      evidence = { ok: true, objects: await countObjects(input.bucket, `inbound/${input.domain}/`, input.region) };
    } catch (e) {
      evidence = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  const links: ChainLink[] = [
    assessMxLink(mxAssessment, input.region),
    assessSesRuleLink(rules, input.domain, input.bucket),
    assessAppRegistrationLink(input.domain, input.appRegistered),
    assessS3EvidenceLink(input.domain, input.bucket, evidence),
  ];

  const required = links.filter((link) => link.link !== "s3_delivery_evidence");
  return {
    domain: input.domain,
    drift: links.some((link) => link.status === "missing"),
    receiving_ready: required.every((link) => link.status === "ok"),
    links,
  };
}
