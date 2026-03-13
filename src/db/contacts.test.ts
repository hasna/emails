import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  upsertContact,
  getContact,
  listContacts,
  suppressContact,
  unsuppressContact,
  incrementSendCount,
  incrementBounceCount,
  incrementComplaintCount,
  isContactSuppressed,
} from "./contacts.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
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

describe("incrementSendCount", () => {
  it("increments send count", () => {
    upsertContact("test@example.com");
    incrementSendCount("test@example.com");
    incrementSendCount("test@example.com");
    const c = getContact("test@example.com");
    expect(c?.send_count).toBe(2);
    expect(c?.last_sent_at).not.toBeNull();
  });

  it("creates contact if not exists", () => {
    incrementSendCount("new@example.com");
    const c = getContact("new@example.com");
    expect(c).not.toBeNull();
    expect(c?.send_count).toBe(1);
  });
});

describe("incrementBounceCount", () => {
  it("increments bounce count", () => {
    upsertContact("test@example.com");
    incrementBounceCount("test@example.com");
    const c = getContact("test@example.com");
    expect(c?.bounce_count).toBe(1);
  });

  it("auto-suppresses on 3 bounces", () => {
    upsertContact("bouncy@example.com");
    incrementBounceCount("bouncy@example.com");
    expect(isContactSuppressed("bouncy@example.com")).toBe(false);
    incrementBounceCount("bouncy@example.com");
    expect(isContactSuppressed("bouncy@example.com")).toBe(false);
    incrementBounceCount("bouncy@example.com");
    expect(isContactSuppressed("bouncy@example.com")).toBe(true);
  });

  it("creates contact if not exists", () => {
    incrementBounceCount("new@example.com");
    const c = getContact("new@example.com");
    expect(c).not.toBeNull();
    expect(c?.bounce_count).toBe(1);
  });
});

describe("incrementComplaintCount", () => {
  it("increments complaint count", () => {
    upsertContact("test@example.com");
    incrementComplaintCount("test@example.com");
    incrementComplaintCount("test@example.com");
    const c = getContact("test@example.com");
    expect(c?.complaint_count).toBe(2);
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
