// REGRESSION GUARD for the fabricated self-hosted status payload.
//
// The bug: src/lib/agent-context.ts hardcoded
//   providers  { total: 0, active: 0, by_type: {} }
//   domains    { total: 0, send_ready: 0, receive_ready: 0, usable: [] }
//   addresses  { total: 0, active: 0, verified: 0, owned: 0, ready_to_receive: 0, usable_from: [] }
//   provisioning { four zeros }
// while the operator's server held 37 providers, 75 domains and 325 addresses.
// `emails status` printed "0/0 active provider credential(s)" in the same session
// in which `emails provider list` printed a live SES provider.
//
// These tests seed the /v1 stub with KNOWN rows and assert EXACT counts, so any
// reintroduction of a constant fails here. G2 additionally asserts the payload is
// not structurally identical to the old zeroed template, and cross-checks the
// status counts against the repository listings the CLI itself prints — i.e. the
// exact live contradiction becomes a failing test.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { getEmailSystemStatus, formatEmailSystemStatus } from "./agent-context.js";
import { listProviderSummaries } from "../db/providers.js";
import { listDomains } from "../db/domains.js";
import { listAddresses } from "../db/addresses.js";

const NOW = "2026-07-01T00:00:00.000Z";

// 2 providers (1 inactive, types ses + sandbox)
const PROVIDERS = [
  { id: "prov-ses", name: "SES production", type: "ses", region: "us-east-1", active: true, created_at: NOW, updated_at: NOW },
  { id: "prov-box", name: "Sandbox", type: "sandbox", region: null, active: false, created_at: NOW, updated_at: NOW },
];

// 3 domains (2 verified, 1 with provisioning_status 'failed')
const DOMAINS = [
  { id: "dom-1", domain: "alpha.example", provider: "prov-ses", verified: true, provisioning_status: "ready", last_error: null, next_check_at: null, created_at: NOW, updated_at: NOW },
  { id: "dom-2", domain: "beta.example", provider: "prov-ses", verified: true, provisioning_status: "dns_pending", last_error: null, next_check_at: NOW, created_at: NOW, updated_at: NOW },
  { id: "dom-3", domain: "gamma.example", provider: "prov-box", verified: false, provisioning_status: "failed", last_error: "cloudflare zone missing", next_check_at: null, created_at: NOW, updated_at: NOW },
];

// 4 addresses: 1 suspended, 2 verified, 1 owned, 1 provisioning_status 'ready'
const ADDRESSES = [
  { id: "addr-1", email: "ops@alpha.example", domain: "alpha.example", domain_id: "dom-1", status: "active", verified: true, owner_id: "owner-1", provisioning_status: "ready", created_at: NOW, updated_at: NOW },
  { id: "addr-2", email: "hi@alpha.example", domain: "alpha.example", domain_id: "dom-1", status: "active", verified: true, owner_id: null, provisioning_status: "pending", created_at: NOW, updated_at: NOW },
  { id: "addr-3", email: "old@beta.example", domain: "beta.example", domain_id: "dom-2", status: "suspended", verified: false, owner_id: null, provisioning_status: "none", created_at: NOW, updated_at: NOW },
  { id: "addr-4", email: "bad@gamma.example", domain: "gamma.example", domain_id: "dom-3", status: "active", verified: false, owner_id: null, provisioning_status: "failed", created_at: NOW, updated_at: NOW },
];

const SOURCES = [
  { id: "src-1", mailbox_id: "mb-1", provider_id: "prov-ses", type: "ses-s3", name: "primary", status: "active", last_synced_at: "2026-07-01T09:00:00.000Z", created_at: NOW, updated_at: NOW },
  { id: "src-2", mailbox_id: "mb-1", provider_id: "prov-ses", type: "ses-s3", name: "secondary", status: "paused", last_synced_at: null, created_at: NOW, updated_at: NOW },
];

/** The payload the pre-fix code produced. Used verbatim by G2. */
function zeroedTemplate() {
  return {
    providers: { total: 0, active: 0, by_type: {} },
    domains: { total: 0, send_ready: 0, receive_ready: 0, usable: [] },
    addresses: { total: 0, active: 0, verified: 0, owned: 0, ready_to_receive: 0, usable_from: [] },
    provisioning: { domains_pending: 0, domains_failed: 0, addresses_pending: 0, addresses_failed: 0 },
    next_actions: [],
  };
}

let stub: V1Stub;
beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
  await stub.seed({ providers: PROVIDERS, domains: DOMAINS, addresses: ADDRESSES, sources: SOURCES });
});
afterEach(() => stub.clearEnv());

describe("self-hosted status reports REAL server inventory (G1)", () => {
  it("counts providers from /v1/providers", async () => {
    const status = await getEmailSystemStatus();

    expect(status.providers.total).toBe(2);
    expect(status.providers.active).toBe(1);
    expect(status.providers.by_type).toEqual({ ses: 1 });
    expect(status.providers.availability).toMatchObject({
      available: true,
      source: "self_hosted_api:/v1/providers",
      basis: "client_enumeration",
      complete: true,
    });
  });

  it("counts domains from /v1/domains and reports the real `verified` column", async () => {
    const status = await getEmailSystemStatus();

    expect(status.domains.total).toBe(3);
    expect(status.domains.verified).toBe(2);
    expect(status.domains.usable).toHaveLength(3);
    const failed = (status.domains.usable ?? []).find((row) => row.domain === "gamma.example");
    expect(failed).toMatchObject({
      provisioning_status: "failed",
      last_error: "cloudflare zone missing",
      provider_name: "Sandbox",
    });
    expect(failed?.issues).toContain("cloudflare zone missing");
    // ready_addresses is REAL: derived from address rows whose domain_id matches
    // and whose provisioning_status is 'ready'.
    const alpha = (status.domains.usable ?? []).find((row) => row.domain === "alpha.example");
    expect(alpha?.ready_addresses).toBe(1);
  });

  it("counts addresses from /v1/addresses across every real column", async () => {
    const status = await getEmailSystemStatus();

    expect(status.addresses.total).toBe(4);
    expect(status.addresses.active).toBe(3);
    expect(status.addresses.verified).toBe(2);
    expect(status.addresses.owned).toBe(1);
    expect(status.addresses.ready_to_receive).toBe(1);
  });

  it("counts provisioning state from the real domain/address columns", async () => {
    const status = await getEmailSystemStatus();

    expect(status.provisioning.domains_failed).toBe(1);
    expect(status.provisioning.domains_pending).toBe(1); // dns_pending
    expect(status.provisioning.addresses_failed).toBe(1);
    expect(status.provisioning.addresses_pending).toBe(1); // pending
  });

  it("publishes the server's configured ingestion sources from /v1/sources", async () => {
    const status = await getEmailSystemStatus();

    expect(status.sources.configured.total).toBe(2);
    expect(status.sources.configured.by_status).toEqual({ active: 1, paused: 1 });
    expect(status.sources.configured.latest_last_synced_at).toBe("2026-07-01T09:00:00.000Z");
  });

  it("derives next_actions from the real numbers and never leaves them silently empty", async () => {
    const status = await getEmailSystemStatus();

    expect(status.next_actions.length).toBeGreaterThan(0);
    // A provisioning failure IS visible, so it must be proposed — with a command
    // that actually runs in this mode (`emails provision status` refuses here).
    expect(status.next_actions.some((action) => action.reason.includes("Provisioning failed"))).toBe(true);
    for (const action of status.next_actions) {
      expect(action.command).not.toBe("emails provision status");
      expect(action.command).not.toBe("emails doctor --json");
      expect(action.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("anti-fabrication invariants (G2)", () => {
  it("is not structurally the zeroed template when the server has data", async () => {
    const status = await getEmailSystemStatus();

    const template = zeroedTemplate();
    expect(status.providers).not.toMatchObject(template.providers);
    expect(status.domains).not.toMatchObject(template.domains);
    expect(status.addresses).not.toMatchObject(template.addresses);
    expect(status.provisioning).not.toMatchObject(template.provisioning);
    expect(status.next_actions).not.toEqual(template.next_actions);
  });

  it("never reports 0 for a resource the server answered with rows", async () => {
    const status = await getEmailSystemStatus();

    const seeded: Array<[string, number, number | null]> = [
      ["providers.total", PROVIDERS.length, status.providers.total],
      ["domains.total", DOMAINS.length, status.domains.total],
      ["addresses.total", ADDRESSES.length, status.addresses.total],
      ["sources.configured.total", SOURCES.length, status.sources.configured.total],
    ];
    for (const [path, seededCount, reported] of seeded) {
      expect(seededCount, `${path}: fixture must be non-empty`).toBeGreaterThan(0);
      expect(reported, `${path} must not be 0 while the server returned rows`).not.toBe(0);
      expect(reported, `${path} must be measured, not null`).toBe(seededCount);
    }
  });

  it("agrees with the repository listings the CLI itself prints", async () => {
    // This is the live contradiction, as a test: `emails status` said 0 providers
    // and 0 domains while `emails provider list` / `emails domain list` printed
    // real rows in the same session.
    const status = await getEmailSystemStatus();

    expect(status.providers.total).toBe(listProviderSummaries().length);
    expect(status.domains.total).toBe(listDomains().length);
    expect(status.addresses.total).toBe(listAddresses().length);
  });

  it("does not render a zero for any count it did not measure", async () => {
    const status = await getEmailSystemStatus();
    const rendered = formatEmailSystemStatus(status);

    expect(rendered).toContain("Capabilities: 1/2 active provider credential(s)");
    expect(rendered).not.toContain("0/0 active provider credential(s)");
    expect(rendered).toContain("Domains:   3 total, 2 verified");
    expect(rendered).toContain("send-ready unavailable");
    // The gap section is mandatory whenever anything is unavailable.
    expect(rendered).toContain("Data gaps");
    expect(rendered).toContain("addresses.usable_from — server_route_absent:/v1/senders");
  });
});

describe("honest-unavailable contract (G3)", () => {
  it("marks permanently-missing fields with stable machine codes on a healthy server", async () => {
    const status = await getEmailSystemStatus();

    // A healthy server is NOT degraded: every structurally-absent field is a
    // published LIMITATION, not a fault. `degraded` has to stay usable as a gate
    // (`jq -e '.degraded == false'`), and a flag that is true on every healthy
    // deployment carries no information at all.
    expect(status.degraded).toBe(false);
    expect(status.failures).toEqual([]);
    expect(status.incomplete).toEqual([]);
    expect(status.limited).toBe(true);
    expect(status.limitations.length).toBeGreaterThan(0);
    // Every unavailable path is accounted for as exactly one of the two kinds.
    expect([...status.limitations, ...status.failures].sort()).toEqual(status.unavailable);

    expect(status.domains.send_ready).toBeNull();
    expect(status.domains.receive_ready).toBeNull();
    expect(status.addresses.usable_from).toBeNull();
    expect(status.inbox.inbound_buckets.items).toBeNull();
    expect(status.inbox.inbound_buckets.total).toBeNull();
    expect(status.sources.legacy).toBeNull();
    expect(status.sources.orphaned).toBeNull();

    expect(status.gaps["domains.send_ready"]?.reason).toMatch(/^not_modelled_over_v1:domain_dns_evidence/);
    expect(status.gaps["addresses.usable_from"]?.reason).toMatch(/^server_route_absent:\/v1\/senders/);
    expect(status.gaps["inbox.inbound_buckets.items"]?.reason).toMatch(/^not_applicable:server_owned_ingestion/);
    expect(status.gaps["sources.legacy"]?.reason).toMatch(/^not_modelled_over_v1:source_classification/);

    for (const path of ["domains.send_ready", "addresses.usable_from", "inbox.inbound_buckets.items"]) {
      expect(status.unavailable).toContain(path);
      expect(status.limitations).toContain(path);
    }
  });

  it("still prints the data-gap section when the payload is healthy but limited", async () => {
    // The gap section must be driven by the GAPS, not by `degraded`: a healthy
    // deployment has nulls, and hiding their reasons behind a green summary would
    // reproduce the original defect at one remove.
    const status = await getEmailSystemStatus();
    const rendered = formatEmailSystemStatus(status);

    expect(status.degraded).toBe(false);
    expect(rendered).toContain("Data gaps");
    expect(rendered).toContain("addresses.usable_from — server_route_absent:/v1/senders");
    expect(rendered).not.toContain("Read failures");
  });

  it("degrades and bounds the count when the server's paging window shifts", async () => {
    // Production /v1/sources: 3899 rows, ORDER BY status,type,created_at (not a
    // total order), so limit/offset paging returned 426 duplicates and skipped 426
    // rows. The client de-duplicated and published 3473 as `complete: true`.
    // A shifting window must now produce an explicit LOWER BOUND.
    const many = Array.from({ length: 1200 }, (_, index) => ({
      id: `src-${String(index).padStart(5, "0")}`,
      type: "ses-s3",
      name: `source-${index}`,
      status: "active",
      last_synced_at: null,
      created_at: NOW,
      updated_at: NOW,
    }));
    await stub.seed({ providers: PROVIDERS, domains: DOMAINS, addresses: ADDRESSES, sources: many });
    await stub.setListOrderInstability(7, ["sources"]);

    const status = await getEmailSystemStatus();

    expect(status.sources.configured.availability.available).toBe(true);
    expect(status.sources.configured.availability.complete).toBe(false);
    expect(status.sources.configured.availability.reason).toMatch(/^enumeration_unstable:/);
    expect(status.sources.configured.total).not.toBeNull();
    expect(status.sources.configured.total!).toBeLessThan(many.length);
    expect(status.incomplete).toContain("sources.configured");
    expect(status.degraded).toBe(true);

    const rendered = formatEmailSystemStatus(status);
    expect(rendered).toContain(`Configured sources: ≥${status.sources.configured.total}`);
    expect(rendered).toContain("Lower bounds");
  });

  it("nulls the per-domain ready-address count when the ADDRESS window shifts", async () => {
    // The per-domain count is an aggregate over the address inventory, but it is
    // published inside the DOMAINS block — whose own enumeration is complete. So
    // an incomplete address read used to surface here as an exact-looking number
    // with no `≥` and no gap entry, and any domain whose address rows fell in the
    // skipped window rendered a confident `0`.
    const many = Array.from({ length: 1200 }, (_, index) => ({
      id: `addr-${String(index).padStart(5, "0")}`,
      email: `user${index}@alpha.example`,
      domain: "alpha.example",
      domain_id: "dom-1",
      status: "active",
      verified: false,
      owner_id: null,
      provisioning_status: "ready",
      created_at: NOW,
      updated_at: NOW,
    }));
    await stub.seed({ providers: PROVIDERS, domains: DOMAINS, addresses: many, sources: SOURCES });
    await stub.setListOrderInstability(7, ["addresses"]);

    const status = await getEmailSystemStatus();

    // Precondition: the address read is a lower bound, the domain read is not.
    expect(status.addresses.availability.complete).toBe(false);
    expect(status.addresses.availability.reason).toMatch(/^enumeration_unstable:/);
    expect(status.incomplete).toContain("addresses");
    expect(status.domains.availability.complete).toBe(true);
    expect(status.degraded).toBe(true);

    // Every sampled domain reports null, never a number the client never measured.
    const usable = status.domains.usable ?? [];
    expect(usable.length).toBeGreaterThan(0);
    for (const row of usable) {
      expect(row.ready_addresses, `${row.domain} must not publish an unmeasured count`).toBeNull();
    }
    // alpha.example owns all 1200 ready rows; beta/gamma own none. Without the
    // gate the first publishes an undercount and the other two publish the same
    // confident `0` a genuinely empty domain would — indistinguishable.
    const alpha = usable.find((row) => row.domain === "alpha.example");
    expect(alpha?.ready_addresses).toBeNull();

    // ...and the null carries the address block's own reason, not a silence.
    expect(status.gaps["domains.usable[].ready_addresses"]?.reason).toMatch(/^enumeration_unstable:/);
    expect(status.unavailable).toContain("domains.usable[].ready_addresses");
    expect(formatEmailSystemStatus(status)).toContain("domains.usable[].ready_addresses");
  });

  it("still publishes the per-domain ready-address count when the address read is complete", async () => {
    // The gate must be driven by completeness, not by "addresses are big": a
    // stable enumeration still yields a real, exact per-domain number.
    const status = await getEmailSystemStatus();

    expect(status.addresses.availability.complete).toBe(true);
    const alpha = (status.domains.usable ?? []).find((row) => row.domain === "alpha.example");
    expect(alpha?.ready_addresses).toBe(1);
    expect(status.gaps["domains.usable[].ready_addresses"]).toBeUndefined();
  });

  it("reports null (never 0) and a source_unreachable reason when the API cannot be read", async () => {
    // Point the client at a port nothing listens on: the reads MUST fail loudly
    // in the payload rather than degrade to zeros.
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:1";
    const { resetSelfHostedConfigCache } = await import("../db/self-hosted-store.js");
    const { resetMailDataSource } = await import("./mail-data-source.js");
    resetSelfHostedConfigCache();
    resetMailDataSource();

    let status: Awaited<ReturnType<typeof getEmailSystemStatus>> | null = null;
    try {
      status = await getEmailSystemStatus();
    } catch {
      // The mail-data-source read may throw first; the facts layer is asserted
      // directly below in that case.
    }

    if (status === null) {
      const { collectStatusFacts } = await import("./status-facts.remote.js");
      const facts = collectStatusFacts({
        mailboxSources: [],
        domainLimit: 25,
        usableFromLimit: 25,
        sourceLimit: 50,
      });
      expect(facts.providers.total).toBeNull();
      expect(facts.providers.total).not.toBe(0);
      expect(facts.providers.availability.available).toBe(false);
      expect(facts.providers.availability.reason).toMatch(/^source_unreachable:/);
      expect(facts.gaps["providers.total"]?.reason).toMatch(/^source_unreachable:/);
      return;
    }

    expect(status.providers.total).toBeNull();
    expect(status.providers.availability.reason).toMatch(/^source_unreachable:/);
    expect(status.degraded).toBe(true);
    expect(status.unavailable).toContain("providers.total");
    const rendered = formatEmailSystemStatus(status);
    expect(rendered).toContain("unavailable");
    expect(rendered).not.toMatch(/\b0\/0\b/);
  });
});
