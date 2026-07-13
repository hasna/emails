// Self-hosted-ONLY: the /v1 message model has NO thread_id column (the operator's
// serve rolls conversations by normalized subject). Threading WRITES
// (setEmailThreading / setInboundThreadId) are graceful no-ops; threading READS
// map what /v1 exposes (message_id / in_reply_to / References header) and
// getThreadMessages always returns []. Exercises the REAL curl transport against
// an out-of-process /v1 stub — see src/test-support/v1-stub.ts.
//
// Migrated from the deleted local-SQLite pattern (db.run INSERT INTO emails, a
// local thread_id, uuid from database.js). Two former expectations no longer hold
// and are updated accordingly:
//   - thread_id is always null (no /v1 thread_id column); setEmailThreading is a
//     no-op, so the old "sets and reads threading fields" now seeds the row and
//     reads the server-exposed fields instead.
//   - getThreadMessages("t1") always returns [] (subject-derived server-side),
//     replacing "returns sent ordered by time".

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  setEmailThreading,
  getEmailThreading,
  getEmailByMessageId,
  getThreadMessages,
  resolveThreadForInbound,
} from "./threads.js";

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

describe("threads db", () => {
  it("reads server-exposed threading fields (thread_id always null)", async () => {
    await stub.seed({
      messages: [
        {
          id: "msg-1",
          direction: "outbound",
          from_addr: "a@x.com",
          to_addrs: [],
          subject: "Hi",
          status: "sent",
          message_id: "<root@x.com>",
          in_reply_to: "<parent@x.com>",
          headers: { References: "<a@x.com> <b@x.com>" },
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Writes are graceful no-ops (server-derived threading; no local field to set).
    expect(() => setEmailThreading("msg-1", { message_id: "<ignored@x.com>", thread_id: "t1" })).not.toThrow();

    const t = getEmailThreading("msg-1")!;
    expect(t.message_id).toBe("<root@x.com>");
    expect(t.thread_id).toBeNull();
    expect(t.in_reply_to).toBe("<parent@x.com>");
    expect(t.references).toEqual(["<a@x.com>", "<b@x.com>"]);
  });

  it("returns null threading for an unknown id", () => {
    expect(getEmailThreading("nope")).toBeNull();
  });

  it("finds a sent email by message id (bare or bracketed)", async () => {
    await stub.seed({
      messages: [
        {
          id: "msg-2",
          direction: "outbound",
          from_addr: "a@x.com",
          to_addrs: [],
          subject: "Hi",
          status: "sent",
          message_id: "<root@x.com>",
          headers: {},
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(getEmailByMessageId("<root@x.com>")!.id).toBe("msg-2");
    expect(getEmailByMessageId("root@x.com")!.id).toBe("msg-2");
    expect(getEmailByMessageId("<absent@x.com>")).toBeNull();
  });

  it("getThreadMessages always returns [] (server derives threads by subject)", () => {
    expect(getThreadMessages("t1")).toEqual([]);
  });
});

describe("getEmailByMessageId — SES rewrites Message-ID to <provider_message_id@email.amazonses.com>", () => {
  it("matches the local-part against provider_message_id", async () => {
    await stub.seed({
      messages: [
        {
          id: "ses-1",
          direction: "outbound",
          provider_message_id: "0100abc-xyz-000000",
          from_addr: "a@x.com",
          to_addrs: [],
          subject: "S",
          status: "sent",
          message_id: "<ours@x.com>",
          headers: {},
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // SES-rewritten id as seen on the received copy.
    const r = getEmailByMessageId("<0100abc-xyz-000000@email.amazonses.com>");
    expect(r?.id).toBe("ses-1");
    expect(r?.thread_id).toBeNull();
    expect(r?.message_id).toBe("<ours@x.com>");
  });
});

describe("resolveThreadForInbound", () => {
  it("links an inbound reply to a known parent via In-Reply-To (thread_id is the new id)", async () => {
    await stub.seed({
      messages: [
        {
          id: "parent-1",
          direction: "outbound",
          from_addr: "a@x.com",
          to_addrs: [],
          subject: "Original",
          status: "sent",
          message_id: "<parent@x.com>",
          headers: {},
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const resolved = resolveThreadForInbound({ "In-Reply-To": "<parent@x.com>" }, "new-thread-id");
    expect(resolved.parent_email_id).toBe("parent-1");
    expect(resolved.thread_id).toBe("new-thread-id");
  });

  it("falls back to the new thread id when no parent is referenced", () => {
    const resolved = resolveThreadForInbound({ "In-Reply-To": "<unknown@x.com>" }, "fresh-id");
    expect(resolved.parent_email_id).toBeNull();
    expect(resolved.thread_id).toBe("fresh-id");
  });
});
