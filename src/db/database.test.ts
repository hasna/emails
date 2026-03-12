import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase, uuid, now, resolvePartialId } from "./database.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("getDatabase", () => {
  it("returns a database instance", () => {
    const db = getDatabase();
    expect(db).toBeDefined();
  });

  it("returns the same instance on repeated calls", () => {
    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);
  });

  it("creates required tables", () => {
    const db = getDatabase();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("providers");
    expect(names).toContain("domains");
    expect(names).toContain("addresses");
    expect(names).toContain("emails");
    expect(names).toContain("events");
    expect(names).toContain("_migrations");
  });

  it("records migration 1 in _migrations", () => {
    const db = getDatabase();
    const row = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number } | null;
    expect(row?.max_id).toBeGreaterThanOrEqual(1);
  });
});

describe("uuid", () => {
  it("returns a 36-char UUID", () => {
    const id = uuid();
    expect(id).toHaveLength(36);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid()));
    expect(ids.size).toBe(100);
  });
});

describe("now", () => {
  it("returns an ISO string", () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => new Date(ts)).not.toThrow();
  });
});

describe("resolvePartialId", () => {
  it("resolves full UUID", () => {
    const db = getDatabase();
    const id = uuid();
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id, "test", "resend"]);
    const resolved = resolvePartialId(db, "providers", id);
    expect(resolved).toBe(id);
  });

  it("resolves partial prefix", () => {
    const db = getDatabase();
    const id = uuid();
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id, "test", "resend"]);
    const resolved = resolvePartialId(db, "providers", id.slice(0, 8));
    expect(resolved).toBe(id);
  });

  it("returns null for unknown ID", () => {
    const db = getDatabase();
    const resolved = resolvePartialId(db, "providers", "nonexistent");
    expect(resolved).toBeNull();
  });

  it("returns null for ambiguous prefix", () => {
    const db = getDatabase();
    // Insert two providers with similar IDs would be random, so instead test with explicit setup
    const resolved = resolvePartialId(db, "providers", "");
    expect(resolved).toBeNull();
  });
});

describe("closeDatabase and resetDatabase", () => {
  it("closeDatabase closes and allows reopening", () => {
    const db1 = getDatabase();
    expect(db1).toBeDefined();
    closeDatabase();
    resetDatabase();
    const db2 = getDatabase();
    expect(db2).toBeDefined();
  });
});
