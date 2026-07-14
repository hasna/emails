// Self-hosted-ONLY: the contacts repo routes every read/write to the /v1
// `contacts` API. This exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. DELETED tests (behavior no
// longer in the client):
//   - the incrementSendCount/incrementBounceCount/incrementComplaintCount (and
//     their *Counts batch) counter-mutation + auto-suppress-on-3-bounces tests:
//     send/bounce/complaint counters are now DERIVED SERVER-SIDE from message
//     activity; the client functions are deliberate no-ops. A single test below
//     documents that they neither create nor mutate contacts.
//
// KEEP (real client behavior, all retained): the client-side upsert (list-then-
// create), email lookup + coercion, suppressed filtering + pagination, and the
// suppressed-set membership scan.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  upsertContact,
  getContact,
  listContacts,
  suppressContact,
  unsuppressContact,
  incrementSendCount,
  incrementSendCounts,
  incrementBounceCount,
  incrementBounceCounts,
  incrementComplaintCount,
  incrementComplaintCounts,
  isContactSuppressed,
  getSuppressedEmailSet,
} from "./contacts.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("upsertContact", () => {
  it("creates a new contact", () => {
    const c = upsertContact("alice@example.com");
    expect(c.id).toHaveLength(36);
    expect(c.email).toBe("alice@example.com");
    expect(c.send_count).toBe(0);
    expect(c.bounce_count).toBe(0);
    expect(c.complaint_count).toBe(0);
    expect(c.suppressed).toBe(false);
    expect(c.name).toBeNull();
    expect(c.last_sent_at).toBeNull();
  });

  it("returns existing contact on duplicate", () => {
    const c1 = upsertContact("bob@example.com");
    const c2 = upsertContact("bob@example.com");
    expect(c1.id).toBe(c2.id);
  });
});

describe("getContact", () => {
  it("retrieves contact by email", () => {
    upsertContact("test@example.com");
    const found = getContact("test@example.com");
    expect(found).not.toBeNull();
    expect(found?.email).toBe("test@example.com");
  });

  it("returns null for unknown email", () => {
    expect(getContact("unknown@example.com")).toBeNull();
  });
});

describe("listContacts", () => {
  it("returns empty array when no contacts", () => {
    expect(listContacts()).toEqual([]);
  });

  it("lists all contacts", () => {
    upsertContact("a@example.com");
    upsertContact("b@example.com");
    expect(listContacts().length).toBe(2);
  });

  it("filters by suppressed=true", () => {
    upsertContact("a@example.com");
    suppressContact("b@example.com");
    const suppressed = listContacts({ suppressed: true });
    expect(suppressed.length).toBe(1);
    expect(suppressed[0]!.email).toBe("b@example.com");
  });

  it("filters by suppressed=false", () => {
    upsertContact("a@example.com");
    suppressContact("b@example.com");
    const active = listContacts({ suppressed: false });
    expect(active.length).toBe(1);
    expect(active[0]!.email).toBe("a@example.com");
  });

  it("paginates contacts after applying suppression filters", () => {
    for (let i = 0; i < 5; i++) {
      suppressContact(`suppressed-${i}@example.com`);
    }
    upsertContact("active@example.com");

    const page = listContacts({ suppressed: true, limit: 2, offset: 1 });

    expect(page).toHaveLength(2);
    expect(page.every((contact) => contact.suppressed)).toBe(true);
    expect(page.map((contact) => contact.email)).not.toContain("active@example.com");
  });
});

describe("suppressContact / unsuppressContact", () => {
  it("suppresses a contact", () => {
    upsertContact("test@example.com");
    suppressContact("test@example.com");
    expect(isContactSuppressed("test@example.com")).toBe(true);
  });

  it("unsuppresses a contact", () => {
    suppressContact("test@example.com");
    unsuppressContact("test@example.com");
    expect(isContactSuppressed("test@example.com")).toBe(false);
  });

  it("suppress creates contact if not exists", () => {
    suppressContact("new@example.com");
    const c = getContact("new@example.com");
    expect(c).not.toBeNull();
    expect(c?.suppressed).toBe(true);
  });
});

describe("send/bounce/complaint counters are server-derived (client no-ops)", () => {
  // The old SQLite client mutated these counters locally and auto-suppressed at 3
  // bounces. Over /v1 those counters are derived server-side from message activity;
  // the client functions must not create or mutate any contact.
  it("increment* functions do not create or mutate contacts", () => {
    incrementSendCount("x@example.com");
    incrementSendCounts(["a@example.com", "b@example.com"]);
    incrementBounceCount("x@example.com");
    incrementBounceCounts(["a@example.com", "a@example.com", "a@example.com"]);
    incrementComplaintCount("x@example.com");
    incrementComplaintCounts(["a@example.com"]);
    expect(listContacts()).toEqual([]);
  });

  it("does not change existing contact state", () => {
    const before = upsertContact("existing@example.com");
    incrementSendCount("existing@example.com");
    incrementBounceCount("existing@example.com");
    incrementComplaintCount("existing@example.com");
    const after = getContact("existing@example.com")!;
    expect(after.send_count).toBe(0);
    expect(after.bounce_count).toBe(0);
    expect(after.complaint_count).toBe(0);
    expect(after.suppressed).toBe(false);
    expect(after.id).toBe(before.id);
  });
});

describe("isContactSuppressed", () => {
  it("returns false for unknown email", () => {
    expect(isContactSuppressed("unknown@example.com")).toBe(false);
  });

  it("returns false for non-suppressed contact", () => {
    upsertContact("test@example.com");
    expect(isContactSuppressed("test@example.com")).toBe(false);
  });

  it("returns true for suppressed contact", () => {
    suppressContact("test@example.com");
    expect(isContactSuppressed("test@example.com")).toBe(true);
  });
});

describe("getSuppressedEmailSet", () => {
  it("returns only suppressed emails from the input list", () => {
    upsertContact("active@example.com");
    suppressContact("blocked@example.com");
    suppressContact("also-blocked@example.com");

    const suppressed = getSuppressedEmailSet([
      "active@example.com",
      "blocked@example.com",
      "blocked@example.com",
      "also-blocked@example.com",
      "unknown@example.com",
    ]);

    expect(suppressed).toEqual(new Set(["blocked@example.com", "also-blocked@example.com"]));
  });

  it("returns the suppressed subset from a large input list", () => {
    for (let i = 0; i < 60; i++) {
      if (i % 10 === 0) suppressContact(`user-${i}@example.com`);
    }

    const suppressed = getSuppressedEmailSet(
      Array.from({ length: 60 }, (_, i) => `user-${i}@example.com`),
    );

    expect(suppressed).toEqual(new Set([
      "user-0@example.com",
      "user-10@example.com",
      "user-20@example.com",
      "user-30@example.com",
      "user-40@example.com",
      "user-50@example.com",
    ]));
  });
});
