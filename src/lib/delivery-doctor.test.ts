import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  diagnoseInboundDelivery,
  diagnoseInboundDeliveryLive,
  formatDeliveryDoctorReport,
  type DeliveryDoctorCheck,
  type DeliveryDoctorReport,
} from "./delivery-doctor.js";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { AddressRecord, MessageListRecord } from "../store/records.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";

// Inbound delivery diagnosis has ONE implementation, over the store seam. These cases
// exercise the two properties the collapse had to hold on to, both of which the two-arm
// version could not express at all:
//
//   1. A fact the store REFUSED is reported as unknown — a failing check, a null count —
//      and never as a clean bill of health. "No address is configured" and "I could not
//      read the address registry" are opposite diagnoses.
//   2. A fact the seam does not carry (DKIM/SPF/DMARC status) is reported as NOT CHECKED,
//      never as passing.

let db: Database;
let inheritedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  inheritedEnv = { ...process.env };
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(inheritedEnv, key)) delete process.env[key];
  }
  Object.assign(process.env, inheritedEnv);
});

function store(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (test)" });
}

function refusal(): Outcome<never> {
  return { ok: false, code: "capability_unavailable", message: "the test store does not provide this", status: 501 };
}

function named(report: DeliveryDoctorReport, name: string): DeliveryDoctorCheck[] {
  return report.checks.filter((entry) => entry.name === name);
}

function addressRow(email: string, id: string): AddressRecord {
  return {
    id,
    email,
    domain: email.slice(email.indexOf("@") + 1),
    display_name: null,
    status: "active",
    verified: false,
    daily_quota: null,
    provisioning_status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function inboundListRow(recipient: string, id: string): MessageListRecord {
  return {
    id,
    direction: "inbound",
    from_addr: "sender@elsewhere.test",
    to_addrs: [recipient],
    cc_addrs: [],
    subject: "filler",
    status: "received",
    provider_message_id: null,
    message_id: null,
    in_reply_to: null,
    received_at: "2026-01-01T00:00:00.000Z",
    is_read: false,
    is_starred: false,
    labels: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    snippet: null,
    attachment_count: 0,
  };
}

/**
 * A store whose address registry NEVER reports a short page, so the scan can never prove
 * it reached the end. `withMatch` decides whether the first page holds the address the
 * diagnosis is about.
 */
function endlessRegistry(withMatch: boolean): EmailStore {
  const base = store();
  return {
    ...base,
    addresses: {
      ...base.addresses,
      listAddresses: async (opts) => {
        const offset = opts?.offset ?? 0;
        const page = Array.from({ length: 500 }, (_, index) =>
          addressRow(`user-${offset + index}@example.com`, `address-${offset + index}`),
        );
        if (withMatch && offset === 0) page[0] = addressRow("ops@example.com", "address-ops");
        return { ok: true, value: page };
      },
    },
  };
}

async function seedProvider(subject: EmailStore): Promise<string> {
  const created = await subject.providers.create({ name: "delivery-doctor-test", type: "sandbox" });
  if (!created.ok) throw new Error("provider seed refused");
  return String(created.value["id"]);
}

async function seedAddress(subject: EmailStore, email: string, provisioning: string): Promise<string> {
  const providerId = await seedProvider(subject);
  const domain = email.slice(email.indexOf("@") + 1);
  const registered = await subject.domains.createDomain({ domain, provider: providerId });
  if (!registered.ok) throw new Error("domain seed refused");
  const created = await subject.addresses.createAddress({ email });
  if (!created.ok) throw new Error("address seed refused");
  const provisioned = await subject.provisioning.applyAddressProvisioning(created.value.id, {
    provisioning_status: provisioning,
  });
  if (!provisioned.ok) throw new Error("address provisioning seed refused");
  return created.value.id;
}

describe("diagnoseInboundDelivery over the store seam", () => {
  it("reads the address, its provisioning and its owner from the configured store", async () => {
    const subject = store();
    const owner = await subject.owners.create({ type: "human", name: "Ops Team" });
    if (!owner.ok) throw new Error("owner seed refused");
    const addressId = await seedAddress(subject, "ops@example.com", "ready");
    const owned = await subject.addressLifecycle.applyAddressOwnership(addressId, {
      owner_id: String(owner.value["id"]),
    });
    expect(owned.ok).toBe(true);

    const report = await diagnoseInboundDelivery("Ops@Example.com", { store: subject });

    expect(report.address).toBe("ops@example.com");
    expect(report.domain).toBe("example.com");
    expect(report.store).toBe("SQLite in-memory (test)");
    expect(named(report, "Configured address")[0]?.status).toBe("pass");
    expect(named(report, "Address receive readiness")[0]?.status).toBe("pass");
    expect(named(report, "Ownership")[0]).toEqual({
      name: "Ownership",
      status: "pass",
      message: "Owned by Ops Team.",
      fix_command: undefined,
    });
  });

  it("resolves an alias through the store when no exact address is registered", async () => {
    const subject = store();
    const created = await subject.aliases.create({
      domain: "example.com",
      local_part: "hello",
      target_address: "ops@example.com",
    });
    expect(created.ok).toBe(true);

    const report = await diagnoseInboundDelivery("hello@example.com", { store: subject });

    expect(report.alias_target).toBe("ops@example.com");
    expect(named(report, "Alias")[0]?.status).toBe("pass");
  });

  it("counts inbound mail addressed to exactly this recipient, not to a longer address that contains it", async () => {
    const subject = store();
    await seedAddress(subject, "ops@example.com", "ready");
    for (const recipient of ["ops@example.com", "devops@example.com", "ops@example.com"]) {
      const created = await subject.messages.createMessage({
        from_addr: "sender@elsewhere.test",
        to_addrs: [recipient],
        direction: "inbound",
        subject: `mail for ${recipient}`,
        received_at: "2026-01-02T10:00:00.000Z",
      });
      if (!created.ok) throw new Error("message seed refused");
    }

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    // Two, not three: `devops@example.com` contains the address as a substring and the
    // store's `to` filter is a substring match, so the exact match happens here.
    expect(report.recent_local_messages).toBe(2);
    expect(report.latest_received_at).toBe("2026-01-02T10:00:00.000Z");
    expect(named(report, "Recent local mail")[0]?.status).toBe("pass");
  });

  it("matches a display-name recipient the way the recipient index does", async () => {
    const subject = store();
    const created = await subject.messages.createMessage({
      from_addr: "sender@elsewhere.test",
      to_addrs: ["Ops Team <OPS@example.com>"],
      direction: "inbound",
      received_at: "2026-01-03T10:00:00.000Z",
    });
    if (!created.ok) throw new Error("message seed refused");

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    expect(report.recent_local_messages).toBe(1);
  });

  it("never reports send DNS as healthy, because the store does not carry it", async () => {
    const subject = store();
    await seedAddress(subject, "ops@example.com", "ready");

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    const send = named(report, "Domain send readiness");
    expect(send).toHaveLength(1);
    expect(send[0]?.status).toBe("warn");
    expect(send[0]?.message).toContain("Send DNS was not checked");
    expect(send[0]?.fix_command).toBe("emails domain verify example.com");
    // A diagnosis that could not look must never say the thing it did not look at is
    // fine. `pass` is the one status this check may never carry.
    expect(report.checks.some((entry) => entry.name === "Domain send readiness" && entry.status === "pass")).toBe(false);
  });

  it("names the receive-readiness evidence it could not weigh, in the passing case too", async () => {
    const subject = store();
    await seedAddress(subject, "ops@example.com", "ready");

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    const receive = named(report, "Domain receive readiness");
    expect(receive).toHaveLength(1);
    expect(receive[0]?.status).toBe("pass");
    // A pass here is a narrower claim than "this domain can receive": the inbound
    // lifecycle status and live-source evidence assessDomainReadiness() also weighs are
    // not on the seam. The message has to say so, or the narrow claim reads as the broad
    // one.
    expect(receive[0]?.message).toContain("were not weighed");
    expect(receive[0]?.message).toContain("1 ready address(es)");
  });

  it("builds its own store from the storage configuration when the caller hands in none", async () => {
    // No `store` option: the resolution in src/store-resolution.ts decides, and
    // EMAILS_DB_PATH is what this test set. The report names the store it read.
    const report = await diagnoseInboundDelivery("ops@example.com");

    expect(report.store).toContain("SQLite at");
    expect(named(report, "Address format")[0]?.status).toBe("pass");
  });
});

describe("diagnoseInboundDelivery refusals", () => {
  it("fails the configured-address check when the registry read is refused, instead of reporting no address", async () => {
    const base = store();
    const subject: EmailStore = {
      ...base,
      addresses: { ...base.addresses, listAddresses: async () => refusal() },
    };

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    const configured = named(report, "Configured address");
    expect(configured).toHaveLength(1);
    expect(configured[0]?.status).toBe("fail");
    expect(configured[0]?.message).toContain("Could not determine whether ops@example.com is configured");
    expect(configured[0]?.message).toContain("capability_unavailable");
    // The wrong answer this guards against, spelled out: the warn that means "there is
    // no such address" must not be what a refused read produces.
    expect(configured[0]?.message).not.toContain("No exact address or alias configured");
  });

  it("reports an uncountable recent-mail read as unknown rather than as zero", async () => {
    const base = store();
    const subject: EmailStore = {
      ...base,
      messages: { ...base.messages, listMessages: async () => refusal() },
    };

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    expect(report.recent_local_messages).toBeNull();
    const recent = named(report, "Recent local mail");
    expect(recent[0]?.status).toBe("fail");
    expect(recent[0]?.message).toContain("could not be counted");
    // Zero would have been indistinguishable from "no mail has ever arrived", which is
    // the diagnosis this store never gave.
    expect(report.recent_local_messages).not.toBe(0);
  });

  it("fails the ownership check when the owner row cannot be read, instead of reporting no owner", async () => {
    const base = store();
    const owner = await base.owners.create({ type: "human", name: "Ops Team" });
    if (!owner.ok) throw new Error("owner seed refused");
    const addressId = await seedAddress(base, "ops@example.com", "ready");
    const owned = await base.addressLifecycle.applyAddressOwnership(addressId, {
      owner_id: String(owner.value["id"]),
    });
    expect(owned.ok).toBe(true);
    const subject: EmailStore = { ...base, owners: { ...base.owners, get: async () => refusal() } };

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    const ownership = named(report, "Ownership");
    expect(ownership[0]?.status).toBe("fail");
    expect(ownership[0]?.message).toContain("the store refused to read it");
    expect(ownership[0]?.message).not.toContain("No owner/admin assigned");
  });

  it("fails the domain check when the domain read is refused, instead of reporting the domain unconfigured", async () => {
    const base = store();
    const subject: EmailStore = {
      ...base,
      domains: { ...base.domains, getDomainByName: async () => refusal() },
    };

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    const domain = named(report, "Domain");
    expect(domain[0]?.status).toBe("fail");
    expect(domain[0]?.message).toContain("Could not determine whether example.com is configured");
    expect(domain[0]?.message).not.toContain("is not configured in this installation's store");
  });

  it("fails the alias check when alias resolution is refused", async () => {
    const base = store();
    const subject: EmailStore = { ...base, aliases: { ...base.aliases, list: async () => refusal() } };

    const report = await diagnoseInboundDelivery("hello@example.com", { store: subject });

    expect(report.alias_target).toBeNull();
    const alias = named(report, "Alias");
    expect(alias[0]?.status).toBe("fail");
    expect(alias[0]?.message).toContain("Alias resolution was refused by the store");
  });

  it("refuses to conclude an address is absent when the registry scan is truncated", async () => {
    const subject = endlessRegistry(false);

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    expect(named(report, "Address registry")[0]?.status).toBe("fail");
    expect(named(report, "Address registry")[0]?.message).toContain("larger than the 20000 rows");
    const configured = named(report, "Configured address");
    expect(configured[0]?.status).toBe("fail");
    expect(configured[0]?.message).toContain("Could not determine whether ops@example.com is configured");
  });

  it("reports an unbounded inbound scan that never found the recipient as unknown, not as no mail", async () => {
    const base = store();
    // Every page is full, carries a `next_cursor`, and holds only a LONGER address that
    // contains the one asked about — which the store's substring `to` filter matches. A
    // single-page read would have reported zero, i.e. "no mail has arrived".
    const subject: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        listMessages: async () => ({
          ok: true,
          value: {
            items: Array.from({ length: 500 }, (_, index) => inboundListRow(`devops@example.com`, `message-${index}`)),
            next_cursor: "more",
          },
        }),
      },
    };

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    expect(report.recent_local_messages).toBeNull();
    const recent = named(report, "Recent local mail");
    expect(recent[0]?.status).toBe("fail");
    expect(recent[0]?.message).toContain("reached its 2500-row bound");
    expect(recent[0]?.message).not.toContain("No messages found");
  });

  it("still reports a truncated registry scan when it did find the address", async () => {
    // The hole this closes: a scan that stopped early can have found one address and
    // missed a second, and its receive-ready counts feed the domain check. Reporting the
    // truncation only when nothing matched would let an incomplete scan read as complete
    // on every other line.
    const subject = endlessRegistry(true);

    const report = await diagnoseInboundDelivery("ops@example.com", { store: subject });

    expect(named(report, "Configured address")[0]?.status).toBe("pass");
    const scan = named(report, "Address registry");
    expect(scan).toHaveLength(1);
    expect(scan[0]?.status).toBe("fail");
    expect(scan[0]?.message).toContain("Address and domain readiness below may be incomplete");
  });
});

describe("diagnoseInboundDeliveryLive", () => {
  it("adds the public MX finding to the store-derived report", async () => {
    const subject = store();
    await seedAddress(subject, "ops@example.com", "ready");

    const report = await diagnoseInboundDeliveryLive("ops@example.com", {
      store: subject,
      inspectMx: async () => ({
        domain: "example.com",
        owner: "aws-ses" as const,
        records: [{ priority: 10, exchange: "inbound-smtp.us-east-1.amazonaws.com" }],
        summary: "Root MX is owned by Amazon SES",
      }),
    });

    const mx = named(report, "Public MX");
    expect(mx[0]?.status).toBe("pass");
    expect(mx[0]?.message).toContain("inbound-smtp.us-east-1.amazonaws.com");
    // Still the same report the non-live entrypoint produced, not a second one.
    expect(report.store).toBe("SQLite in-memory (test)");
  });
});

describe("formatDeliveryDoctorReport", () => {
  it("renders checks, fix commands and the store the diagnosis read", () => {
    const report: DeliveryDoctorReport = {
      address: "ops@example.com",
      domain: "example.com",
      alias_target: null,
      recent_local_messages: 2,
      latest_received_at: "2026-01-02T10:00:00.000Z",
      store: "SQLite at /tmp/emails.db",
      checks: [
        { name: "Configured address", status: "pass", message: "found" },
        { name: "Public MX", status: "warn", message: "Google Workspace", fix_command: "emails forwarding explain ops@example.com" },
      ],
      cli_equivalent: "emails doctor delivery ops@example.com",
    };
    const out = formatDeliveryDoctorReport(report);
    expect(out).toContain("Delivery diagnosis: ops@example.com");
    expect(out).toContain("Store:    SQLite at /tmp/emails.db");
    expect(out).toContain("Recent:   2, latest 2026-01-02T10:00:00.000Z");
    expect(out).toContain("[ok] Configured address");
    expect(out).toContain("[warn] Public MX");
    expect(out).toContain("fix: emails forwarding explain ops@example.com");
  });

  it("prints an uncounted recent-mail total as unknown rather than as zero", () => {
    const report: DeliveryDoctorReport = {
      address: "ops@example.com",
      domain: "example.com",
      alias_target: null,
      recent_local_messages: null,
      latest_received_at: null,
      store: "Emails API at https://mail.example.com",
      checks: [],
      cli_equivalent: "emails doctor delivery ops@example.com",
    };
    const out = formatDeliveryDoctorReport(report);
    expect(out).toContain("Recent:   (not counted)");
    expect(out).not.toContain("Recent:   0");
  });
});

describe("the delivery-doctor family has one implementation", () => {
  it("has no implementation arms left beside the module", () => {
    // Structural, and it is the change itself: the two arms differed by WHO RAN the
    // diagnosis rather than by what it means, and one of them threw for both
    // entrypoints while carrying a byte-for-byte copy of the report formatter.
    const dir = import.meta.dir;
    expect(existsSync(join(dir, "delivery-doctor.ts"))).toBe(true);
    expect(existsSync(join(dir, "delivery-doctor.local.ts"))).toBe(false);
    expect(existsSync(join(dir, "delivery-doctor.remote.ts"))).toBe(false);
  });
});
