import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createDomain, getDomain } from "./domains.js";
import { createAddress } from "./addresses.js";
import {
  setDomainProvisioning,
  getDomainProvisioning,
  setAddressProvisioning,
  getAddressProvisioning,
  recordProvisioningEvent,
  listProvisioningEvents,
  claimDueDomains,
  claimDueAddresses,
} from "./provisioning.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "ses" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("migration 19 — provisioning columns", () => {
  it("domains have provisioning defaults (dns_provider=cloudflare, status=none)", () => {
    const d = createDomain(providerId, "example.com");
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("none");
    expect(p.dns_provider).toBe("cloudflare");
    expect(p.nameservers).toEqual([]);
    expect(p.cf_zone_id).toBeNull();
    expect(p.next_check_at).toBeNull();
  });

  it("addresses have provisioning defaults", () => {
    const a = createAddress({ provider_id: providerId, email: "andrew@example.com" });
    const p = getAddressProvisioning(a.id)!;
    expect(p.provisioning_status).toBe("none");
    expect(p.receive_strategy).toBeNull();
    expect(p.domain_id).toBeNull();
  });

  it("provisioning_events table exists and is empty", () => {
    const db = getDatabase();
    const row = db.query("SELECT COUNT(*) as n FROM provisioning_events").get() as { n: number };
    expect(row.n).toBe(0);
  });
});

describe("setDomainProvisioning / getDomainProvisioning", () => {
  it("updates and reads back provisioning fields", () => {
    const d = createDomain(providerId, "example.com");
    setDomainProvisioning(d.id, {
      provisioning_status: "verifying",
      purchase_provider: "route53",
      send_provider: "ses",
      cf_zone_id: "zone123",
      registrar: "route53",
      nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
      mail_from_domain: "mail.example.com",
      next_check_at: "2026-06-02T00:00:00.000Z",
    });
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("verifying");
    expect(p.purchase_provider).toBe("route53");
    expect(p.send_provider).toBe("ses");
    expect(p.cf_zone_id).toBe("zone123");
    expect(p.nameservers).toEqual(["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
    expect(p.mail_from_domain).toBe("mail.example.com");
    // dns_provider stays cloudflare even when not set
    expect(p.dns_provider).toBe("cloudflare");
  });

  it("records last_error and clears it", () => {
    const d = createDomain(providerId, "example.com");
    setDomainProvisioning(d.id, { last_error: "boom" });
    expect(getDomainProvisioning(d.id)!.last_error).toBe("boom");
    setDomainProvisioning(d.id, { last_error: null });
    expect(getDomainProvisioning(d.id)!.last_error).toBeNull();
  });
});

describe("setAddressProvisioning / getAddressProvisioning", () => {
  it("updates and reads back address provisioning fields", () => {
    const dom = createDomain(providerId, "example.com");
    const a = createAddress({ provider_id: providerId, email: "andrew@example.com" });
    setAddressProvisioning(a.id, {
      domain_id: dom.id,
      receive_strategy: "ses-s3",
      forward_to: "me@gmail.com",
      routing_rule_id: "rule1",
      provisioning_status: "validating",
      next_check_at: "2026-06-02T00:00:00.000Z",
    });
    const p = getAddressProvisioning(a.id)!;
    expect(p.domain_id).toBe(dom.id);
    expect(p.receive_strategy).toBe("ses-s3");
    expect(p.forward_to).toBe("me@gmail.com");
    expect(p.routing_rule_id).toBe("rule1");
    expect(p.provisioning_status).toBe("validating");
  });
});

describe("provisioning_events audit", () => {
  it("records and lists events in order", () => {
    const d = createDomain(providerId, "example.com");
    recordProvisioningEvent("domain", d.id, "requested", "purchasing", { provider: "route53" });
    recordProvisioningEvent("domain", d.id, "purchasing", "registered", {});
    const events = listProvisioningEvents("domain", d.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.to_state).toBe("purchasing");
    expect(events[0]!.detail.provider).toBe("route53");
    expect(events[1]!.from_state).toBe("purchasing");
    expect(events[1]!.to_state).toBe("registered");
  });
});

describe("claimDueDomains / claimDueAddresses (daemon queue)", () => {
  it("returns only non-terminal entities whose next_check_at <= now", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2999-01-01T00:00:00.000Z";

    const due = createDomain(providerId, "due.com");
    setDomainProvisioning(due.id, { provisioning_status: "verifying", next_check_at: past });

    const notYet = createDomain(providerId, "notyet.com");
    setDomainProvisioning(notYet.id, { provisioning_status: "verifying", next_check_at: future });

    const done = createDomain(providerId, "done.com");
    setDomainProvisioning(done.id, { provisioning_status: "ready", next_check_at: past });

    const none = createDomain(providerId, "none.com"); // status 'none', never scheduled
    void none;

    const claimed = claimDueDomains("2026-06-02T00:00:00.000Z");
    const names = claimed.map((d) => getDomain(d.id)!.domain);
    expect(names).toContain("due.com");
    expect(names).not.toContain("notyet.com");
    expect(names).not.toContain("done.com");
    expect(names).not.toContain("none.com");
  });

  it("claimDueAddresses respects next_check_at and terminal status", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const a = createAddress({ provider_id: providerId, email: "due@example.com" });
    setAddressProvisioning(a.id, { provisioning_status: "validating", next_check_at: past });
    const b = createAddress({ provider_id: providerId, email: "ready@example.com" });
    setAddressProvisioning(b.id, { provisioning_status: "ready", next_check_at: past });

    const claimed = claimDueAddresses("2026-06-02T00:00:00.000Z");
    const ids = claimed.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});
