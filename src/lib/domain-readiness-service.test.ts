import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createProvider } from "../db/providers.js";
import { createDomain, updateDnsStatus } from "../db/domains.js";
import { registerS3Source } from "./s3-sync.js";
import {
  buildDomainLifecycleSummary,
  enableDomainInboundReadiness,
  enableDomainOutboundReadiness,
  listDomainLifecycleSummaries,
} from "./domain-readiness-service.js";

// The readiness service reads providers/domains/provisioning over the /v1 API,
// so it runs against the out-of-process stub. The S3 mail-source registry is
// pure client config (a file under $HOME/.hasna/emails), so a temp HOME isolates
// it per test. stub.applyEnv() supplies the mandatory self-hosted endpoint that
// config resolution requires.
//
// SELF-HOSTED REALITY: the /v1 domain entity is server-owned and minimal — it
// does NOT carry the client-writable lifecycle columns (inbound_status /
// outbound_status). updateDomainReadiness is a no-op over /v1, so the client
// records receive/send enablement as PROVISIONING state (inbound_ready /
// verified) plus config-derived inbound evidence, not as a persisted
// inbound_status="ready" / outbound_status="ready" column. DNS status is
// all-or-nothing (a single `verified` flag), so a domain is either fully
// verified (dkim+spf+dmarc) or fully pending.
let stub: V1Stub;
let tempHome = "";
let previousHome: string | undefined;

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());

beforeEach(async () => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-readiness-service-"));
  process.env["HOME"] = tempHome;
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("domain readiness service", () => {
  it("exposes typed lifecycle summaries and gates self-hosted inbound on live S3 evidence", () => {
    const provider = createProvider({ name: "SES", type: "ses", region: "us-east-1" });
    const created = createDomain(provider.id, "example.com");
    // A self-hosted domain becomes send-ready once its DNS is verified
    // server-side (single all-or-nothing verified flag).
    const domain = updateDnsStatus(created.id, "verified", "verified", "verified");

    const before = buildDomainLifecycleSummary(domain);
    expect(before.provider).toMatchObject({ id: provider.id, name: "SES", type: "ses" });
    expect(before.source_of_truth).toBe("postgres");
    expect(before.readiness.send_ready).toBe(true);
    // No live inbound S3 source yet → not receive-ready and no inbound evidence.
    expect(before.readiness.receive_ready).toBe(false);
    expect(before.readiness.inbound_evidence_ready).toBe(false);
    expect(before.next_actions).toContain("emails domain adopt example.com --provider <provider>");

    // Enabling inbound is refused until a live SES/S3 source is registered.
    expect(() => enableDomainInboundReadiness(domain.id)).toThrow("Inbound self_hosted source is not configured");

    registerS3Source({
      bucket: "emails-inbound",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId: provider.id,
      status: "live",
      liveSyncEnabled: true,
    });

    const enabled = enableDomainInboundReadiness(domain.id);
    // The live S3 source now satisfies the inbound-evidence gate...
    expect(enabled.before.readiness.inbound_evidence_ready).toBe(true);
    expect(enabled.after.readiness.inbound_evidence.live_s3_sources).toBe(1);
    expect(enabled.after.readiness.inbound_evidence_ready).toBe(true);
    // ...and receive-enablement is recorded as provisioning state (the /v1 domain
    // entity has no client-writable inbound_status column).
    expect(enabled.after.provisioning?.provisioning_status).toBe("inbound_ready");

    const summaries = listDomainLifecycleSummaries({ provider_id: provider.id });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: domain.id,
      domain: "example.com",
      source_of_truth: "postgres",
      readiness: { send_ready: true },
    });
    expect(summaries[0]!.provisioning?.provisioning_status).toBe("inbound_ready");
  });

  it("guards outbound readiness unless DKIM and SPF are verified", () => {
    const provider = createProvider({ name: "SES", type: "ses", region: "us-east-1" });
    const created = createDomain(provider.id, "blocked.example.com");

    expect(() => enableDomainOutboundReadiness(created.id)).toThrow("Outbound is not verified");

    const verified = updateDnsStatus(created.id, "verified", "verified", "verified");
    const summary = buildDomainLifecycleSummary(verified);
    expect(summary.readiness.send_ready).toBe(true);

    const enabled = enableDomainOutboundReadiness(created.id);
    // Outbound enablement is recorded as provisioning state; the /v1 domain
    // entity does not carry a client-writable outbound_status column.
    expect(enabled.after.provisioning?.provisioning_status).toBe("verified");
  });
});
