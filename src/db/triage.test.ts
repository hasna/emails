// Self-hosted-ONLY: the triage repo routes every read/write to the /v1 `triage`
// resource. Exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Notable changes:
//   - There is no local `emails`/`inbound_emails` table to seed a foreign key
//     against; saveTriage simply POSTs a triage row keyed by email_id /
//     inbound_email_id, so the old seedEmail/seedInbound helpers are gone.
//   - getUntriaged is a server-side cross-table scan with no /v1 equivalent, so
//     the three positive getUntriaged tests are replaced by a single fail-loud
//     assertion (the only behavior the client still owns).
//   - the listTriagedSummaries SQL-projection assertion inspected local SQL that
//     no longer exists; the meaningful part (draft_reply omitted from the
//     summary shape) is retained functionally below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  saveTriage,
  getTriage,
  getTriageById,
  listTriaged,
  listTriagedSummaries,
  getUntriaged,
  deleteTriage,
  deleteTriageByEmail,
  getTriageStats,
  clearTriage,
} from "./triage.js";
import type { SaveTriageInput } from "./triage.js";

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

describe("saveTriage", () => {
  it("saves triage for a sent email", () => {
    const result = saveTriage({ email_id: "e1", label: "action-required", priority: 1, summary: "Needs response" });
    expect(result.id).toHaveLength(36);
    expect(result.email_id).toBe("e1");
    expect(result.label).toBe("action-required");
    expect(result.priority).toBe(1);
    expect(result.summary).toBe("Needs response");
  });

  it("saves triage for an inbound email", () => {
    const result = saveTriage({ inbound_email_id: "i1", label: "fyi", priority: 3, sentiment: "neutral" });
    expect(result.inbound_email_id).toBe("i1");
    expect(result.label).toBe("fyi");
    expect(result.sentiment).toBe("neutral");
  });

  it("upserts — replaces existing triage for same email", () => {
    saveTriage({ email_id: "e2", label: "fyi", priority: 4 });
    const updated = saveTriage({ email_id: "e2", label: "urgent", priority: 1 });
    expect(updated.label).toBe("urgent");
    expect(updated.priority).toBe(1);
    expect(listTriaged().length).toBe(1);
  });

  it("throws without email_id or inbound_email_id", () => {
    expect(() => saveTriage({ label: "fyi", priority: 3 } as SaveTriageInput)).toThrow(
      "Either email_id or inbound_email_id must be provided",
    );
  });

  it("stores confidence and model", () => {
    const result = saveTriage({ email_id: "e3", label: "spam", priority: 5, confidence: 0.95, model: "llama-4-scout" });
    expect(result.confidence).toBe(0.95);
    expect(result.model).toBe("llama-4-scout");
  });

  it("stores draft_reply", () => {
    const result = saveTriage({ email_id: "e4", label: "action-required", priority: 1, draft_reply: "Thanks for your email..." });
    expect(result.draft_reply).toBe("Thanks for your email...");
  });
});

describe("getTriage", () => {
  it("gets triage by sent email id", () => {
    saveTriage({ email_id: "e5", label: "newsletter", priority: 4 });
    const result = getTriage("e5", "sent");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("newsletter");
  });

  it("gets triage by inbound email id", () => {
    saveTriage({ inbound_email_id: "i2", label: "urgent", priority: 1 });
    const result = getTriage("i2", "inbound");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("urgent");
  });

  it("returns null for untriaged email", () => {
    expect(getTriage("nonexistent")).toBeNull();
  });
});

describe("getTriageById", () => {
  it("gets triage by its own id", () => {
    const saved = saveTriage({ email_id: "e6", label: "fyi", priority: 3 });
    const result = getTriageById(saved.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(saved.id);
  });
});

describe("listTriaged", () => {
  it("lists all triaged emails", () => {
    saveTriage({ email_id: "e7", label: "fyi", priority: 3 });
    saveTriage({ email_id: "e8", label: "urgent", priority: 1 });
    expect(listTriaged().length).toBe(2);
  });

  it("filters by label", () => {
    saveTriage({ email_id: "e9", label: "fyi", priority: 3 });
    saveTriage({ email_id: "e10", label: "urgent", priority: 1 });
    const list = listTriaged({ label: "urgent" });
    expect(list.length).toBe(1);
    expect(list[0]!.label).toBe("urgent");
  });

  it("filters by priority", () => {
    saveTriage({ email_id: "e11", label: "fyi", priority: 3 });
    saveTriage({ email_id: "e12", label: "fyi", priority: 5 });
    const list = listTriaged({ priority: 5 });
    expect(list.length).toBe(1);
    expect(list[0]!.priority).toBe(5);
  });

  it("filters by sentiment", () => {
    saveTriage({ email_id: "e13", label: "fyi", priority: 3, sentiment: "positive" });
    saveTriage({ email_id: "e14", label: "fyi", priority: 3, sentiment: "negative" });
    const list = listTriaged({ sentiment: "positive" });
    expect(list.length).toBe(1);
    expect(list[0]!.sentiment).toBe("positive");
  });

  it("respects limit and offset", () => {
    for (let i = 0; i < 5; i++) saveTriage({ email_id: `lim-${i}`, label: "fyi", priority: 3 });
    expect(listTriaged({ limit: 2, offset: 0 }).length).toBe(2);
    expect(listTriaged({ limit: 2, offset: 2 }).length).toBe(2);
  });

  it("clamps bad limit and offset values", () => {
    for (let i = 0; i < 5; i++) saveTriage({ email_id: `clamp-${i}`, label: "fyi", priority: 3 });

    expect(listTriaged({ limit: 0 }).length).toBe(1);
    expect(listTriaged({ limit: -10 }).length).toBe(1);
    expect(listTriaged({ limit: Number.NaN }).length).toBe(5);
    expect(listTriaged({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(5);
  });

  it("lists summaries without projecting draft replies", () => {
    saveTriage({
      email_id: "summary-heavy",
      label: "action-required",
      priority: 1,
      summary: "needs review",
      draft_reply: "large draft ".repeat(1000),
    });

    const [summary] = listTriagedSummaries({ limit: 1 });

    expect(summary).toBeDefined();
    expect(summary?.summary).toBe("needs review");
    expect("draft_reply" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large draft");
  });
});

describe("getUntriaged", () => {
  // Selecting emails NOT yet triaged is a server-side join against the sent /
  // inbound message tables; there is no client-side /v1 equivalent, so the
  // client fails loud. (Old positive-path tests relied on the deleted local
  // cross-table scan and are dropped.)
  it("fails loud in the self-hosted client", () => {
    expect(() => getUntriaged("sent", 50)).toThrow(/not available in the self-hosted client/);
    expect(() => getUntriaged("inbound", 50)).toThrow(/not available in the self-hosted client/);
  });
});

describe("deleteTriage", () => {
  it("deletes triage by id", () => {
    const saved = saveTriage({ email_id: "d1", label: "spam", priority: 5 });
    expect(deleteTriage(saved.id)).toBe(true);
    expect(getTriageById(saved.id)).toBeNull();
  });

  it("returns false for nonexistent id", () => {
    expect(deleteTriage("nonexistent")).toBe(false);
  });
});

describe("deleteTriageByEmail", () => {
  it("deletes triage by email id", () => {
    saveTriage({ email_id: "de1", label: "fyi", priority: 3 });
    expect(deleteTriageByEmail("de1", "sent")).toBe(true);
    expect(getTriage("de1")).toBeNull();
  });

  it("deletes triage by inbound email id", () => {
    saveTriage({ inbound_email_id: "di1", label: "fyi", priority: 3 });
    expect(deleteTriageByEmail("di1", "inbound")).toBe(true);
    expect(getTriage("di1", "inbound")).toBeNull();
  });
});

describe("getTriageStats", () => {
  it("returns stats with counts and averages", () => {
    saveTriage({ email_id: "s1", label: "urgent", priority: 1, sentiment: "negative", confidence: 0.9 });
    saveTriage({ email_id: "s2", label: "fyi", priority: 3, sentiment: "neutral", confidence: 0.8 });
    saveTriage({ email_id: "s3", label: "fyi", priority: 5, sentiment: "positive", confidence: 0.7 });

    const stats = getTriageStats();
    expect(stats.total).toBe(3);
    expect(stats.by_label["fyi"]).toBe(2);
    expect(stats.by_label["urgent"]).toBe(1);
    expect(stats.by_priority[1]).toBe(1);
    expect(stats.by_priority[3]).toBe(1);
    expect(stats.by_priority[5]).toBe(1);
    expect(stats.by_sentiment["positive"]).toBe(1);
    expect(stats.avg_priority).toBe(3);
    expect(stats.avg_confidence).toBeCloseTo(0.8, 1);
  });

  it("returns zeros for empty table", () => {
    const stats = getTriageStats();
    expect(stats.total).toBe(0);
    expect(stats.avg_priority).toBe(0);
  });
});

describe("clearTriage", () => {
  it("clears all triage results", () => {
    saveTriage({ email_id: "c1", label: "fyi", priority: 3 });
    saveTriage({ email_id: "c2", label: "urgent", priority: 1 });
    expect(clearTriage()).toBe(2);
    expect(listTriaged().length).toBe(0);
  });
});
