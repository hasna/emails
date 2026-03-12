import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  createAddress,
  getAddress,
  getAddressByEmail,
  listAddresses,
  updateAddress,
  deleteAddress,
  markVerified,
} from "./addresses.js";
import { AddressNotFoundError } from "../types/index.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createAddress", () => {
  it("creates an address with verified=false", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    expect(a.id).toHaveLength(36);
    expect(a.email).toBe("test@example.com");
    expect(a.provider_id).toBe(providerId);
    expect(a.verified).toBe(false);
    expect(a.display_name).toBeNull();
  });

  it("stores display_name when provided", () => {
    const a = createAddress({ provider_id: providerId, email: "no-reply@example.com", display_name: "No Reply" });
    expect(a.display_name).toBe("No Reply");
  });
});

describe("getAddress", () => {
  it("retrieves address by id", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const found = getAddress(a.id);
    expect(found?.id).toBe(a.id);
  });

  it("returns null for unknown id", () => {
    expect(getAddress("nonexistent")).toBeNull();
  });
});

describe("getAddressByEmail", () => {
  it("finds address by provider and email", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const found = getAddressByEmail(providerId, "test@example.com");
    expect(found?.id).toBe(a.id);
  });

  it("returns null for unknown email", () => {
    expect(getAddressByEmail(providerId, "unknown@example.com")).toBeNull();
  });
});

describe("listAddresses", () => {
  it("lists all addresses", () => {
    createAddress({ provider_id: providerId, email: "a@example.com" });
    createAddress({ provider_id: providerId, email: "b@example.com" });
    expect(listAddresses().length).toBe(2);
  });

  it("filters by provider_id", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createAddress({ provider_id: providerId, email: "a@example.com" });
    createAddress({ provider_id: p2.id, email: "b@example.com" });
    expect(listAddresses(providerId).length).toBe(1);
    expect(listAddresses(p2.id).length).toBe(1);
  });
});

describe("updateAddress", () => {
  it("updates display_name", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const updated = updateAddress(a.id, { display_name: "Updated" });
    expect(updated.display_name).toBe("Updated");
  });

  it("updates verified status", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const updated = updateAddress(a.id, { verified: true });
    expect(updated.verified).toBe(true);
  });

  it("throws AddressNotFoundError for unknown id", () => {
    expect(() => updateAddress("nonexistent", { verified: true })).toThrow(AddressNotFoundError);
  });
});

describe("deleteAddress", () => {
  it("deletes an address", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    expect(deleteAddress(a.id)).toBe(true);
    expect(getAddress(a.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteAddress("nonexistent")).toBe(false);
  });
});

describe("markVerified", () => {
  it("marks address as verified", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    expect(a.verified).toBe(false);
    const updated = markVerified(a.id);
    expect(updated.verified).toBe(true);
  });

  it("throws AddressNotFoundError for unknown id", () => {
    expect(() => markVerified("nonexistent")).toThrow(AddressNotFoundError);
  });
});
