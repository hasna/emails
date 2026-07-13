import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  generateEmailDigest,
  loadEmailDigest,
  resolveEmailDigestWindow,
  formatEmailDigest,
} from "./email-digest.js";

// Digest generation reads the inbound message store + per-message AI agent runs,
// which live on the self-hosted server, so generateEmailDigest is a loud stub.
// loadEmailDigest still works: it reads the latest server-generated digest from
// the /v1 email-digests resource, and only falls through to (server-side)
// generation when no cached digest exists.

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

function digestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "digest-today-1",
    period: "today",
    since: "2026-06-18T00:00:00.000Z",
    until: "2026-06-18T12:00:00.000Z",
    provider: "local",
    model: "local-emails-digest",
    status: "ok",
    message_count: 2,
    summary: "2 inbound messages",
    highlights: ["Important contract"],
    action_items: [],
    important_email_ids: ["email-1"],
    label_counts: { important: 1 },
    error: null,
    started_at: "2026-06-18T12:00:00.000Z",
    completed_at: "2026-06-18T12:00:00.000Z",
    created_at: "2026-06-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("resolveEmailDigestWindow (pure)", () => {
  it("resolves digest windows", () => {
    const at = new Date("2026-06-18T15:30:00.000Z");
    expect(resolveEmailDigestWindow("today", at)).toMatchObject({
      period: "today",
      until: "2026-06-18T15:30:00.000Z",
    });
    expect(resolveEmailDigestWindow("yesterday", at).period).toBe("yesterday");
    expect(resolveEmailDigestWindow("last7", at).period).toBe("last7");
    const month = resolveEmailDigestWindow("month", at);
    expect(month.period).toBe("month");
    expect(new Date(month.since).getTime()).toBeLessThan(new Date(month.until).getTime());
  });
});

describe("generateEmailDigest (self-hosted stub)", () => {
  it("throws because digests are generated on the self-hosted server", async () => {
    await expect(generateEmailDigest({ period: "today" })).rejects.toThrow(
      /generateEmailDigest is not available in the self-hosted client/,
    );
  });
});

describe("loadEmailDigest", () => {
  it("returns the latest server-generated digest from the /v1 email-digests resource", async () => {
    await stub.seed({
      "email-digests": [
        digestRow({ id: "digest-old", completed_at: "2026-06-18T09:00:00.000Z" }),
        digestRow({ id: "digest-new", completed_at: "2026-06-18T12:00:00.000Z" }),
      ],
    });

    const loaded = await loadEmailDigest("today");
    expect(loaded.id).toBe("digest-new");
    expect(loaded.provider).toBe("local");
    expect(loaded.message_count).toBe(2);
    expect(loaded.important_email_ids).toEqual(["email-1"]);
    expect(loaded.label_counts.important).toBe(1);
  });

  it("ignores non-ok digests and digests for other periods", async () => {
    await stub.seed({
      "email-digests": [
        digestRow({ id: "digest-error", status: "error" }),
        digestRow({ id: "digest-month", period: "month" }),
      ],
    });

    await expect(loadEmailDigest("today")).rejects.toThrow(
      /generateEmailDigest is not available in the self-hosted client/,
    );
  });

  it("falls through to (server-side) generation when no cached digest exists", async () => {
    await expect(loadEmailDigest("today")).rejects.toThrow(
      /generateEmailDigest is not available in the self-hosted client/,
    );
  });

  it("bypasses the cache and delegates to generation when fresh is requested", async () => {
    await stub.seed({ "email-digests": [digestRow()] });
    await expect(loadEmailDigest({ period: "today", fresh: true })).rejects.toThrow(
      /generateEmailDigest is not available in the self-hosted client/,
    );
  });
});

describe("formatEmailDigest (pure)", () => {
  it("renders a readable digest", () => {
    const out = formatEmailDigest({
      id: "d1",
      period: "today",
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T12:00:00.000Z",
      provider: "local",
      model: "local-emails-digest",
      status: "ok",
      message_count: 2,
      summary: "2 inbound messages",
      highlights: ["Important contract"],
      action_items: ["Reply to legal"],
      important_email_ids: ["email-1"],
      label_counts: { important: 1 },
      error: null,
      started_at: "2026-06-18T12:00:00.000Z",
      completed_at: "2026-06-18T12:00:00.000Z",
      created_at: "2026-06-18T12:00:00.000Z",
    });
    expect(out).toContain("Today digest");
    expect(out).toContain("2 inbound messages");
    expect(out).toContain("Important contract");
    expect(out).toContain("Reply to legal");
    expect(out).toContain("email-1");
  });
});
