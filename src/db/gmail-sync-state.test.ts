import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, uuid } from "./database.js";
import {
  clearGmailSyncState,
  getGmailSyncState,
  listGmailSyncStatesByProviderIds,
  setGmailSyncState,
  updateLastSynced,
} from "./gmail-sync-state.js";

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail Legacy', 'gmail', 0)`, [providerId]);
  return { db, providerId };
}

beforeEach(() => {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("legacy Gmail sync state", () => {
  it("returns null before any state is set", () => {
    const { providerId } = setupDb();
    expect(getGmailSyncState(providerId)).toBeNull();
  });

  it("creates and updates state without wiping existing non-null cursor fields", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, {
      last_synced_at: "2026-03-20T10:00:00.000Z",
      last_message_id: "msg-abc",
    }, db);
    setGmailSyncState(providerId, { history_id: "99999" }, db);

    const state = getGmailSyncState(providerId, db);
    expect(state).toMatchObject({
      provider_id: providerId,
      last_synced_at: "2026-03-20T10:00:00.000Z",
      last_message_id: "msg-abc",
      history_id: "99999",
    });
  });

  it("can read multiple provider states by id", () => {
    const { db, providerId } = setupDb();
    const secondId = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Other Legacy', 'gmail', 0)`, [secondId]);
    setGmailSyncState(providerId, { last_message_id: "first" }, db);
    setGmailSyncState(secondId, { last_message_id: "second" }, db);

    const states = listGmailSyncStatesByProviderIds([providerId, secondId], db);
    expect(states.get(providerId)?.last_message_id).toBe("first");
    expect(states.get(secondId)?.last_message_id).toBe("second");
  });

  it("updates last synced and clears pagination cursor", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { next_page_token: "stale-token", history_id: "h-42" }, db);
    const before = Date.now();
    const state = updateLastSynced(providerId, "last-msg-id", db);
    const after = Date.now();

    expect(new Date(state.last_synced_at!).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(state.last_synced_at!).getTime()).toBeLessThanOrEqual(after);
    expect(state.last_message_id).toBe("last-msg-id");
    expect(state.history_id).toBe("h-42");
    expect(state.next_page_token).toBeNull();
  });

  it("deletes state records", () => {
    const { db, providerId } = setupDb();
    updateLastSynced(providerId, undefined, db);
    expect(clearGmailSyncState(providerId, db)).toBe(true);
    expect(getGmailSyncState(providerId, db)).toBeNull();
  });
});
