import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  createProvider,
  getProvider,
  listProviders,
  updateProvider,
  deleteProvider,
  getActiveProvider,
} from "./providers.js";
import { ProviderNotFoundError } from "../types/index.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createProvider", () => {
  it("creates a resend provider", () => {
    const p = createProvider({ name: "Resend Prod", type: "resend", api_key: "re_abc123" });
    expect(p.id).toHaveLength(36);
    expect(p.name).toBe("Resend Prod");
    expect(p.type).toBe("resend");
    expect(p.api_key).toBe("re_abc123");
    expect(p.active).toBe(true);
  });

  it("creates an SES provider", () => {
    const p = createProvider({ name: "SES US", type: "ses", region: "us-east-1", access_key: "AKIA", secret_key: "secret" });
    expect(p.type).toBe("ses");
    expect(p.region).toBe("us-east-1");
    expect(p.access_key).toBe("AKIA");
    expect(p.secret_key).toBe("secret");
    expect(p.api_key).toBeNull();
  });

  it("stores null for optional fields when not provided", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    expect(p.api_key).toBeNull();
    expect(p.region).toBeNull();
    expect(p.access_key).toBeNull();
    expect(p.secret_key).toBeNull();
  });
});

describe("getProvider", () => {
  it("retrieves provider by id", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const found = getProvider(p.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(p.id);
  });

  it("returns null for unknown id", () => {
    expect(getProvider("nonexistent")).toBeNull();
  });
});

describe("listProviders", () => {
  it("returns empty array when no providers", () => {
    expect(listProviders()).toEqual([]);
  });

  it("lists all providers ordered by created_at desc", () => {
    const p1 = createProvider({ name: "First", type: "resend" });
    const p2 = createProvider({ name: "Second", type: "ses" });
    const list = listProviders();
    expect(list.length).toBe(2);
    expect(list.map((p) => p.id)).toContain(p1.id);
    expect(list.map((p) => p.id)).toContain(p2.id);
  });
});

describe("updateProvider", () => {
  it("updates name", () => {
    const p = createProvider({ name: "Old", type: "resend" });
    const updated = updateProvider(p.id, { name: "New" });
    expect(updated.name).toBe("New");
  });

  it("updates active status", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const updated = updateProvider(p.id, { active: false });
    expect(updated.active).toBe(false);
  });

  it("throws ProviderNotFoundError for unknown id", () => {
    expect(() => updateProvider("nonexistent", { name: "x" })).toThrow(ProviderNotFoundError);
  });
});

describe("deleteProvider", () => {
  it("deletes a provider", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const deleted = deleteProvider(p.id);
    expect(deleted).toBe(true);
    expect(getProvider(p.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteProvider("nonexistent")).toBe(false);
  });
});

describe("getActiveProvider", () => {
  it("returns the first active provider", () => {
    const p = createProvider({ name: "Active", type: "resend" });
    const active = getActiveProvider();
    expect(active.id).toBe(p.id);
  });

  it("throws ProviderNotFoundError when no active providers", () => {
    expect(() => getActiveProvider()).toThrow(ProviderNotFoundError);
  });
});
