// Unit contract for the honest-unavailable primitives and the human renderer.
//
// The rule these tests pin down: a null NEVER renders as a number and never as an
// empty count. `emails status` used to print "0/0 active provider credential(s)"
// for an inventory it had not read, and an operator acted on that number.

import { describe, expect, it } from "bun:test";
import {
  renderStatusCount,
  renderStatusUnavailable,
  scanStatusAvailability,
  statusGapClass,
  statusAvailable,
  statusReasonCode,
  statusUnavailable,
  StatusGaps,
  STATUS_UNAVAILABLE_CODES,
} from "./status-availability.js";
import { formatEmailSystemStatus, formatStatusDataGaps } from "./agent-context.js";
import type { EmailSystemStatus } from "./status-types.js";

describe("status availability primitives", () => {
  it("formats a reason as <code>:<detail> — <prose> and exposes the code", () => {
    const availability = statusUnavailable("server_route_absent", "/v1/senders", "self_hosted_api", "why");
    expect(availability.available).toBe(false);
    expect(availability.reason).toBe("server_route_absent:/v1/senders — why");
    expect(statusReasonCode(availability.reason)).toBe("server_route_absent");
    expect(statusReasonCode("nonsense:detail")).toBeNull();
    expect(statusReasonCode(null)).toBeNull();
  });

  it("keeps the reason-code set closed", () => {
    expect([...STATUS_UNAVAILABLE_CODES]).toEqual([
      "server_route_absent",
      "not_modelled_over_v1",
      "source_unreachable",
      "not_applicable",
      "enumeration_cap_exceeded",
      "enumeration_unstable",
    ]);
  });

  it("refuses to record a gap for an AVAILABLE field", () => {
    const gaps = new StatusGaps();
    expect(() => gaps.mark("providers.total", statusAvailable("src", "local_query")))
      .toThrow(/requires an unavailable availability record/);
  });

  it("returns null from mark so a field cannot be nulled without a reason", () => {
    const gaps = new StatusGaps();
    const value = gaps.mark("domains.send_ready", statusUnavailable("not_modelled_over_v1", "dns", "src"));
    expect(value).toBeNull();
    expect(gaps.paths()).toEqual(["domains.send_ready"]);
    expect(gaps.toRecord()["domains.send_ready"]?.available).toBe(false);
  });

  it("finds unavailable and incomplete blocks anywhere in the payload", () => {
    const scan = scanStatusAvailability({
      providers: { availability: statusAvailable("s", "local_query"), total: 1 },
      domains: { availability: statusUnavailable("source_unreachable", "HTTP 503", "s"), total: null },
      inbox: {
        inbound_buckets: { availability: statusAvailable("s", "client_enumeration", false), total: 500 },
      },
    });
    expect(scan.unavailableBlocks).toEqual(["domains"]);
    expect(scan.incompleteBlocks).toEqual(["inbox.inbound_buckets"]);
    // The scan also hands back each block's record so a caller can CLASSIFY the
    // gap instead of assuming every gap means the same thing.
    expect(statusGapClass(scan.availabilityByPath["domains"]?.reason)).toBe("failure");
    expect(statusGapClass(scan.availabilityByPath["inbox.inbound_buckets"]?.reason)).toBeNull();
  });

  it("renders an unmeasured count as 'unavailable' and a bounded count with ≥", () => {
    expect(renderStatusCount(null)).toBe("unavailable");
    expect(renderStatusCount(0)).toBe("0");
    expect(renderStatusCount(500, statusAvailable("s", "client_enumeration", false))).toBe("≥500");
    expect(renderStatusCount(500, statusAvailable("s", "client_enumeration", true))).toBe("500");
    expect(renderStatusUnavailable(statusUnavailable("not_applicable", "x", "s"))).toBe("unavailable — not_applicable:x");
    expect(renderStatusUnavailable(null)).toBe("unavailable");
  });
});

function nullPayload(): EmailSystemStatus {
  const unreachable = statusUnavailable("source_unreachable", "GET /v1/providers -> HTTP 503", "self_hosted_api:/v1/providers");
  const notModelled = statusUnavailable("not_modelled_over_v1", "domain_dns_evidence", "self_hosted_api:/v1/domains");
  const absent = statusUnavailable("server_route_absent", "/v1/senders", "self_hosted_api:/v1/addresses");
  const capped = statusAvailable("self_hosted_api:/v1/addresses", "client_enumeration", false);
  return {
    generated_at: "2026-07-01T00:00:00.000Z",
    mode: { current: "self_hosted", label: "Self-hosted", source: { kind: "env", name: "EMAILS_MODE", value: "self_hosted" }, warning: null },
    degraded: true,
    limited: true,
    unavailable: ["addresses.usable_from", "domains.send_ready", "providers.total"],
    // providers.total is a live read failure; the other two are structural.
    failures: ["providers.total"],
    limitations: ["addresses.usable_from", "domains.send_ready"],
    incomplete: ["addresses"],
    gaps: {
      "providers.total": unreachable,
      "domains.send_ready": notModelled,
      "addresses.usable_from": absent,
    },
    database: { availability: statusUnavailable("not_applicable", "local_database_absent_in_self_hosted", "self_hosted_api"), data_dir: null },
    providers: { availability: unreachable, total: null, active: null, by_type: null },
    domains: {
      availability: statusAvailable("self_hosted_api:/v1/domains", "client_enumeration"),
      total: 3, verified: 2, send_ready: null, receive_ready: null,
      usable: [], usable_limit: 25, usable_truncated: false,
    },
    addresses: {
      availability: capped,
      total: 500, active: 500, verified: 6, owned: 2, ready_to_receive: 1,
      usable_from: null, usable_from_limit: 25, usable_from_truncated: false,
    },
    inbox: {
      total: 0, unread: 0, latest_received_at: null,
      inbound_buckets: { availability: statusUnavailable("not_applicable", "server_owned_ingestion", "self_hosted_api"), items: null, total: null },
      realtime: { availability: statusUnavailable("not_modelled_over_v1", "realtime_queue_state", "self_hosted_api"), queue_configured: null, queue_url: null, last_poll_at: null, last_error: null },
    },
    mailboxes: { counts: { inbox: 0, unread: 0, sent: 0, archived: 0, spam: 0, trash: 0, starred: 0 }, folders: [] },
    sources: {
      availability: statusAvailable("self_hosted_mail_view", "client_enumeration"),
      total: 1, active: null, legacy: null, orphaned: null,
      items: [], limit: 50, truncated: false,
      configured: { availability: unreachable, total: null, by_status: null, latest_last_synced_at: null },
    },
    provisioning: { availability: statusAvailable("self_hosted_api", "client_enumeration"), domains_pending: 0, domains_failed: 0, addresses_pending: 0, addresses_failed: 0 },
    next_actions: [{ command: "emails provider list --json", reason: "providers could not be read." }],
    cli_equivalents: {},
  };
}

describe("formatEmailSystemStatus with a null-heavy payload (G5)", () => {
  const rendered = formatEmailSystemStatus(nullPayload());

  it("never renders a null as a number", () => {
    expect(rendered).toContain("Capabilities: unavailable — source_unreachable:GET /v1/providers -> HTTP 503");
    expect(rendered).not.toMatch(/\b0\/0\b/);
    expect(rendered).toContain("send-ready unavailable");
    expect(rendered).toContain("receive-ready unavailable");
    expect(rendered).toContain("usable sender(s) unavailable");
    expect(rendered).toContain("classification unavailable");
    expect(rendered).toContain("realtime unavailable");
  });

  it("prefixes a lower-bound count with ≥", () => {
    expect(rendered).toContain("≥500 active");
    expect(rendered).toContain("≥500 total");
  });

  it("lists every unavailable path with its reason, split by what it means", () => {
    const status = nullPayload();
    const gapLines = formatStatusDataGaps(status).join("\n");
    // A read failure is not filed next to a permanent limitation: one is an
    // incident, the other is the shape of the deployment.
    expect(gapLines).toContain("Read failures (1)");
    expect(gapLines).toContain("providers.total — source_unreachable:GET /v1/providers -> HTTP 503");
    expect(gapLines).toContain("Data gaps (2)");
    for (const path of status.unavailable) expect(gapLines).toContain(path);
    expect(gapLines).toContain("server_route_absent:/v1/senders");
    expect(gapLines).toContain("Lower bounds (1)");
    expect(rendered).toContain("Read failures (1)");
  });

  it("prints nothing only when there is genuinely nothing to report", () => {
    const status = nullPayload();
    // `degraded: false` alone must NOT silence the section: a healthy deployment
    // still has nulls, and hiding their reasons is the original defect one level up.
    status.degraded = false;
    expect(formatStatusDataGaps(status)).not.toEqual([]);

    status.unavailable = [];
    status.failures = [];
    status.limitations = [];
    status.incomplete = [];
    expect(formatStatusDataGaps(status)).toEqual([]);
  });
});
