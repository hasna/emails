// The drip-sequence family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/sequences.ts` has collapsed onto the store seam, so the same
// operations now reach `/v1` through the REAL `HttpEmailStore` — which reads the
// service's published contract before any filtered list or write — and reach SQLite
// through the real `SqliteEmailStore`. The fixture is `src/test-support/v1-store-api.ts`:
// a `/v1` service that stores nothing and translates every request onto the same store
// seam, backed by the same in-memory database the SQLite variant reads. Both variants
// answer from ONE dataset, so a client that mis-maps a field fails here instead of being
// handed its own mistake back.
//
// THE CASES SEEDED PAST 500 ROWS ARE THE POINT OF THE COLLAPSE. Both stores clamp a list
// page to 500 rows, and the deleted second arm answered every read out of ONE such page:
// a sequence past the clamp was unfindable by name, steps past it vanished from the
// positions `current_step` indexes, an existing enrollment past it was re-created as a
// duplicate, and the per-status counts stopped at 500. Each of those has a case below,
// with a raw one-page CONTROL proving the clamp is real so the whole-set discipline
// cannot pass vacuously.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  addStep,
  advanceEnrollment,
  countEnrollmentsByStatus,
  createSequence,
  deleteSequence,
  enroll,
  getDueEnrollments,
  getSequence,
  getStepAtIndex,
  listEnrollments,
  listSequences,
  listSteps,
  removeStep,
  unenroll,
  updateSequence,
  type SequenceStore,
} from "./sequences.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { sequenceSubledgerOf } from "../store-sequence-subledger.js";
import type { EmailStore } from "../store/email-store.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * Leave exactly ONE store configured, named through the resolution's OWN exported
 * constants: a stray inherited API setting beside the database path is a hard boot error
 * with deliberately no precedence rule, and it would turn every default-store case into
 * that error.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
}

let db: ReturnType<typeof getDatabase>;
let api: V1StoreApi | null = null;

function service(): V1StoreApi {
  if (api === null) throw new Error("the /v1 fixture was not started");
  return api;
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "sequence row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (sequences test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

// ─── Seeding straight into the shared table ─────────────────────────────────
//
// Neither store lets a caller name a row's id on a create (the API's request schema does
// not declare the column), so a case that needs chosen ids, chosen timestamps, or more
// rows than one page holds writes the table directly. Both variants read this same data.

function seedSequence(row: {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
}): void {
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    "INSERT INTO sequences (id, name, description, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)",
    [row.id, row.name, row.status ?? "active", at, row.updated_at ?? at],
  );
}

function seedStep(row: {
  id: string;
  sequence_id: string;
  step_number: number;
  delay_hours?: number;
  template_name?: string;
  created_at?: string;
}): void {
  db.run(
    `INSERT INTO sequence_steps (id, sequence_id, step_number, delay_hours, template_name, from_address, subject_override, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      row.id,
      row.sequence_id,
      row.step_number,
      row.delay_hours ?? 24,
      row.template_name ?? `template-${row.id}`,
      row.created_at ?? "2026-01-01T00:00:00.000Z",
    ],
  );
}

function seedEnrollment(row: {
  id: string;
  sequence_id: string;
  contact_email: string;
  status?: string;
  enrolled_at?: string;
  next_send_at?: string | null;
  current_step?: number;
}): void {
  db.run(
    `INSERT INTO sequence_enrollments (id, sequence_id, contact_email, provider_id, current_step, status, enrolled_at, next_send_at, completed_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    [
      row.id,
      row.sequence_id,
      row.contact_email,
      row.current_step ?? 0,
      row.status ?? "active",
      row.enrolled_at ?? "2026-01-01T00:00:00.000Z",
      row.next_send_at ?? null,
    ],
  );
}

// The seeded enrollment-status CHECK only admits the three declared values, and one case
// below needs a value OUTSIDE them — reachable in production through an API store, whose
// schema carries no such CHECK. Writing it here means dropping the constraint the way a
// divergent server would simply not have it.
function seedEnrollmentStatusOutsideTheSet(id: string, sequence_id: string): void {
  db.run("PRAGMA ignore_check_constraints = ON");
  seedEnrollment({ id, sequence_id, contact_email: `${id}@example.com`, status: "bogus" });
  db.run("PRAGMA ignore_check_constraints = OFF");
}

const pad = (value: number): string => String(value).padStart(3, "0");

describe.each(STORE_VARIANTS)("sequences CRUD (%s)", (_label, variant) => {
  it("creates, reads back by id and by name, updates, and deletes", async () => {
    const store = variant();
    const seq = await createSequence({ name: "welcome", description: "New user flow" }, store);
    expect(seq.id).toHaveLength(36);
    expect(seq.name).toBe("welcome");
    expect(seq.description).toBe("New user flow");
    expect(seq.status).toBe("active");
    expect(seq.created_at).toBeTruthy();
    expect(seq.updated_at).toBeTruthy();

    expect((await getSequence(seq.id, store))?.id).toBe(seq.id);
    expect((await getSequence("welcome", store))?.id).toBe(seq.id);
    expect(await getSequence("nonexistent", store)).toBeNull();

    const paused = await updateSequence(seq.id, { status: "paused" }, store);
    expect(paused.status).toBe("paused");
    const renamed = await updateSequence(seq.id, { name: "onboarding", description: "desc" }, store);
    expect(renamed.name).toBe("onboarding");
    expect(renamed.description).toBe("desc");
    await expect(updateSequence("no-such-id", { status: "archived" }, store)).rejects.toThrow("Sequence not found");

    expect(await deleteSequence(seq.id, store)).toBe(true);
    expect(await deleteSequence(seq.id, store)).toBe(false);
    expect(await getSequence(seq.id, store)).toBeNull();
  });

  it("creates a sequence with no description as null", async () => {
    const seq = await createSequence({ name: "bare" }, variant());
    expect(seq.description).toBeNull();
  });

  it("lists newest first and windows AFTER ordering the whole set", async () => {
    for (let i = 0; i < 5; i++) {
      seedSequence({ id: `seq-${i}`, name: `page-${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    const page = await listSequences({ limit: 2, offset: 1 }, variant());
    expect(page.map((seq) => seq.name)).toEqual(["page-3", "page-2"]);
  });

  it("orders sequences sharing a created_at instant identically on both stores", async () => {
    // No tiebreaker was the old arms' shape; with rows written in a tight loop the tie
    // is reachable, and the id tiebreaker is what makes the window reproducible.
    seedSequence({ id: "seq-b", name: "tie-b", created_at: "2026-01-01T00:00:00.000Z" });
    seedSequence({ id: "seq-a", name: "tie-a", created_at: "2026-01-01T00:00:00.000Z" });
    seedSequence({ id: "seq-c", name: "tie-c", created_at: "2026-01-01T00:00:00.000Z" });
    const rows = await listSequences(undefined, variant());
    expect(rows.map((seq) => seq.id)).toEqual(["seq-c", "seq-b", "seq-a"]);
  });
});

describe("sequence name resolution past one clamped page", () => {
  it("finds a sequence the deleted one-page scan could not, and the clamp is real", async () => {
    // 520 sequences; the target sorts BELOW the first 500 of the store's newest-first
    // order because its created_at is the oldest.
    for (let i = 0; i < 520; i++) {
      seedSequence({ id: `seq-${pad(i)}`, name: `bulk-${pad(i)}`, created_at: `2026-02-01T00:00:${pad(i)}Z` });
    }
    seedSequence({ id: "seq-target", name: "needle", created_at: "2026-01-01T00:00:00.000Z" });

    const store = httpStore();
    // CONTROL: one page really cannot see the whole table — without this the whole-set
    // claim below could pass over a fixture that never clamped anything.
    const onePage = await store.sequences.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    expect((await getSequence("needle", store))?.id).toBe("seq-target");
  });
});

describe.each(STORE_VARIANTS)("sequence steps (%s)", (_label, variant) => {
  it("adds a step and reads it back with optional fields intact", async () => {
    const store = variant();
    const seq = await createSequence({ name: "step-seq" }, store);
    const step = await addStep(
      {
        sequence_id: seq.id,
        step_number: 1,
        delay_hours: 48,
        template_name: "followup",
        from_address: "hello@example.com",
        subject_override: "Custom subject",
      },
      store,
    );
    expect(step.id).toHaveLength(36);
    expect(step.sequence_id).toBe(seq.id);
    expect(step.step_number).toBe(1);
    expect(step.delay_hours).toBe(48);
    expect(step.template_name).toBe("followup");
    expect(step.from_address).toBe("hello@example.com");
    expect(step.subject_override).toBe("Custom subject");
    expect(step.created_at).toBeTruthy();

    const bare = await addStep(
      { sequence_id: seq.id, step_number: 2, delay_hours: 24, template_name: "t2" },
      store,
    );
    expect(bare.from_address).toBeNull();
    expect(bare.subject_override).toBeNull();
  });

  it("lists steps in position order regardless of insertion order, and indexes into it", async () => {
    const store = variant();
    const seq = await createSequence({ name: "ordered-steps" }, store);
    await addStep({ sequence_id: seq.id, step_number: 20, delay_hours: 48, template_name: "t20" }, store);
    await addStep({ sequence_id: seq.id, step_number: 10, delay_hours: 24, template_name: "t10" }, store);
    const steps = await listSteps(seq.id, store);
    expect(steps.map((step) => step.template_name)).toEqual(["t10", "t20"]);

    expect((await getStepAtIndex(seq.id, 0, store))?.template_name).toBe("t10");
    expect((await getStepAtIndex(seq.id, 1, store))?.template_name).toBe("t20");
    expect(await getStepAtIndex(seq.id, 2, store)).toBeNull();
    expect(await listSteps("unknown", store)).toHaveLength(0);
  });

  it("removes a step by full id and answers false for an unknown one", async () => {
    const store = variant();
    const seq = await createSequence({ name: "rm-step" }, store);
    const step = await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" }, store);
    expect(await removeStep(step.id, store)).toBe(true);
    expect(await listSteps(seq.id, store)).toHaveLength(0);
    expect(await removeStep("nonexistent", store)).toBe(false);
  });
});

describe("step position over a server-shaped table", () => {
  it("keeps step position TOTAL when two steps share a step_number, identically on both stores", async () => {
    // Reachable through an API store only: the SERVICE enforces no uniqueness on
    // (sequence_id, step_number) — its migrations even default the number — while the
    // local schema forbids the state. So the backing table is rebuilt here in the
    // server's shape, constraint absent, exactly the dataset a divergent server serves.
    // `current_step` indexes this order, so both variants must agree on it exactly:
    // step_number, then created_at, then id.
    db.run("ALTER TABLE sequence_steps RENAME TO sequence_steps_constrained");
    db.run(
      `CREATE TABLE sequence_steps (
        id TEXT PRIMARY KEY,
        sequence_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        delay_hours INTEGER NOT NULL DEFAULT 24,
        template_name TEXT NOT NULL,
        from_address TEXT,
        subject_override TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    seedSequence({ id: "seq-dup", name: "dup-steps" });
    seedStep({ id: "step-b", sequence_id: "seq-dup", step_number: 1, created_at: "2026-01-02T00:00:00.000Z" });
    seedStep({ id: "step-a", sequence_id: "seq-dup", step_number: 1, created_at: "2026-01-01T00:00:00.000Z" });
    seedStep({ id: "step-c", sequence_id: "seq-dup", step_number: 2 });
    for (const [, variant] of STORE_VARIANTS) {
      const steps = await listSteps("seq-dup", variant());
      expect(steps.map((step) => step.id)).toEqual(["step-a", "step-b", "step-c"]);
    }
  });

  it("resolves a duplicated name to the NEWEST sequence, deterministically", async () => {
    // Also server-reachable only: the local schema declares the name UNIQUE, the
    // service does not, so the divergent dataset needs the server-shaped table.
    db.run("ALTER TABLE sequences RENAME TO sequences_constrained");
    db.run(
      `CREATE TABLE sequences (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    // The OLD sequence was touched most recently, so the SQLite store's own generic
    // order (updated_at first) serves it FIRST — a first-match resolution over the
    // store's order picks the wrong twin, which a mutation run proved this case must
    // be able to see. "Newest" here means created_at, on both stores, deliberately.
    seedSequence({ id: "seq-old", name: "twin", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z" });
    seedSequence({ id: "seq-new", name: "twin", created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" });
    for (const [, variant] of STORE_VARIANTS) {
      expect((await getSequence("twin", variant()))?.id).toBe("seq-new");
    }
  });
});

describe("steps past one clamped page", () => {
  it("returns every step of a large sequence, in order, with the last position addressable", async () => {
    seedSequence({ id: "seq-big", name: "big" });
    for (let i = 0; i < 520; i++) {
      seedStep({
        id: `step-${pad(i)}`,
        sequence_id: "seq-big",
        step_number: i + 1,
        created_at: `2026-01-01T00:00:${pad(i)}Z`,
      });
    }
    const store = httpStore();
    const steps = await listSteps("seq-big", store);
    expect(steps).toHaveLength(520);
    expect(steps[0]?.step_number).toBe(1);
    expect(steps[519]?.step_number).toBe(520);
    // The position an enrollment 519 steps in would ask for — the deleted arm's one-page
    // read had already lost it.
    expect((await getStepAtIndex("seq-big", 519, store))?.step_number).toBe(520);
  });
});

describe.each(STORE_VARIANTS)("enrollments (%s)", (_label, variant) => {
  it("enrolls with next_send_at from the first step's delay, and null with no steps", async () => {
    const store = variant();
    const seq = await createSequence({ name: "delay-seq" }, store);
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 72, template_name: "t1" }, store);
    const enrolled = await enroll({ sequence_id: seq.id, contact_email: "carol@example.com" }, store);
    expect(enrolled.id).toHaveLength(36);
    expect(enrolled.current_step).toBe(0);
    expect(enrolled.status).toBe("active");
    const nextSend = new Date(enrolled.next_send_at as string).getTime();
    expect(nextSend).toBeGreaterThan(Date.now() + 71 * 3600 * 1000);
    expect(nextSend).toBeLessThan(Date.now() + 73 * 3600 * 1000);

    const bare = await createSequence({ name: "no-steps-seq" }, store);
    const unscheduled = await enroll({ sequence_id: bare.id, contact_email: "dave@example.com" }, store);
    expect(unscheduled.next_send_at).toBeNull();
  });

  it("schedules the FIRST step's delay, not another step's", async () => {
    const store = variant();
    const seq = await createSequence({ name: "first-delay-seq" }, store);
    await addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 500, template_name: "late" }, store);
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 1, template_name: "early" }, store);
    const enrolled = await enroll({ sequence_id: seq.id, contact_email: "first@example.com" }, store);
    const nextSend = new Date(enrolled.next_send_at as string).getTime();
    // Position 1 (step_number 1, 1h), even though the 500h step was inserted first.
    expect(nextSend).toBeLessThan(Date.now() + 2 * 3600 * 1000);
  });

  it("is idempotent for a (sequence, contact) pair in ANY status", async () => {
    const store = variant();
    const seq = await createSequence({ name: "idem-seq" }, store);
    const first = await enroll({ sequence_id: seq.id, contact_email: "bob@example.com" }, store);
    const again = await enroll({ sequence_id: seq.id, contact_email: "bob@example.com" }, store);
    expect(again.id).toBe(first.id);
    // Cancelled is still enrolled for idempotency purposes — the rule both arms shared.
    await unenroll(seq.id, "bob@example.com", store);
    const cancelled = await enroll({ sequence_id: seq.id, contact_email: "bob@example.com" }, store);
    expect(cancelled.id).toBe(first.id);
    expect(cancelled.status).toBe("cancelled");
    expect(await listEnrollments({ sequence_id: seq.id }, store)).toHaveLength(1);
  });

  it("cancels only an active enrollment and answers false otherwise", async () => {
    const store = variant();
    const seq = await createSequence({ name: "unenroll-seq" }, store);
    await enroll({ sequence_id: seq.id, contact_email: "eve@example.com" }, store);
    expect(await unenroll(seq.id, "eve@example.com", store)).toBe(true);
    expect((await listEnrollments({ sequence_id: seq.id }, store))[0]?.status).toBe("cancelled");
    // Already cancelled: no active enrollment remains, so this is false.
    expect(await unenroll(seq.id, "eve@example.com", store)).toBe(false);
    expect(await unenroll(seq.id, "nobody@example.com", store)).toBe(false);
  });

  it("filters by sequence and status BEFORE windowing, newest first", async () => {
    seedSequence({ id: "seq-1", name: "filter-1" });
    seedSequence({ id: "seq-2", name: "filter-2" });
    for (let i = 0; i < 5; i++) {
      seedEnrollment({
        id: `active-${i}`,
        sequence_id: "seq-1",
        contact_email: `active-${i}@example.com`,
        enrolled_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    seedEnrollment({ id: "cancelled-1", sequence_id: "seq-1", contact_email: "cancelled@example.com", status: "cancelled", enrolled_at: "2026-01-10T00:00:00.000Z" });
    seedEnrollment({ id: "other-1", sequence_id: "seq-2", contact_email: "other@example.com", enrolled_at: "2026-01-11T00:00:00.000Z" });

    const store = variant();
    const page = await listEnrollments({ sequence_id: "seq-1", status: "active", limit: 2, offset: 1 }, store);
    expect(page.map((enrollment) => enrollment.contact_email)).toEqual([
      "active-3@example.com",
      "active-2@example.com",
    ]);
    expect(await listEnrollments(undefined, store)).toHaveLength(7);
    expect(await listEnrollments({ status: "cancelled" }, store)).toHaveLength(1);
  });

  it("faults on a status outside the set only when the row would be PRESENTED", async () => {
    seedSequence({ id: "seq-odd", name: "odd-status" });
    seedEnrollment({ id: "en-ok", sequence_id: "seq-odd", contact_email: "fine@example.com" });
    seedEnrollmentStatusOutsideTheSet("en-odd", "seq-odd");

    const store = variant();
    // A filter that EXCLUDES the row compares raw text and does not fault.
    const active = await listEnrollments({ sequence_id: "seq-odd", status: "active" }, store);
    expect(active.map((enrollment) => enrollment.id)).toEqual(["en-ok"]);
    // Presenting it names the row and the value instead of casting it into the type.
    await expect(listEnrollments({ sequence_id: "seq-odd" }, store)).rejects.toThrow(/en-odd.*"bogus"|"bogus".*en-odd/);
    // The counts keep it in `total` — the row is real — without inventing a bucket.
    expect(await countEnrollmentsByStatus("seq-odd", store)).toEqual({
      active: 1,
      completed: 0,
      cancelled: 0,
      total: 2,
    });
  });
});

describe("enrollments past one clamped page", () => {
  it("keeps enroll idempotent, counts exact, and due reads whole — and the clamp is real", async () => {
    seedSequence({ id: "seq-mass", name: "mass" });
    for (let i = 0; i < 520; i++) {
      seedEnrollment({
        id: `en-${pad(i)}`,
        sequence_id: "seq-mass",
        contact_email: `contact-${pad(i)}@example.com`,
        // Newest-first store orders put the LOW indices past the first page.
        enrolled_at: `2026-01-01T00:00:${pad(i)}Z`,
        status: i < 10 ? "cancelled" : "active",
        next_send_at: i < 20 ? null : `2000-01-01T00:00:${pad(i)}Z`,
      });
    }
    const store = httpStore();
    const subledger = sequenceSubledgerOf(store);
    if (subledger === null) throw new Error("the HTTP store lost its sub-ledger");
    // CONTROL: one 1000-row request really answers 500 of 520.
    const onePage = await subledger.sequenceEnrollments.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    // `contact-000` sorts LAST by enrolled_at DESC — exactly the row a one-page
    // idempotency check missed, and the deleted arm then enrolled the contact twice.
    const existing = await enroll({ sequence_id: "seq-mass", contact_email: "contact-000@example.com" }, store);
    expect(existing.id).toBe("en-000");
    expect(await countEnrollmentsByStatus("seq-mass", store)).toEqual({
      active: 510,
      completed: 0,
      cancelled: 10,
      total: 520,
    });

    // Due reads sort the WHOLE eligible set before taking the limit: the earliest due
    // rows are the ones a first-page read would never see.
    const due = await getDueEnrollments({ limit: 3 }, store);
    expect(due.map((enrollment) => enrollment.id)).toEqual(["en-020", "en-021", "en-022"]);
  });
});

describe.each(STORE_VARIANTS)("due enrollments and advancement (%s)", (_label, variant) => {
  it("returns only active enrollments due now, earliest first", async () => {
    seedSequence({ id: "seq-due", name: "due" });
    seedEnrollment({ id: "due-past", sequence_id: "seq-due", contact_email: "past@example.com", next_send_at: "2000-01-01T00:00:00.000Z" });
    seedEnrollment({ id: "due-future", sequence_id: "seq-due", contact_email: "future@example.com", next_send_at: "2099-01-01T00:00:00.000Z" });
    seedEnrollment({ id: "due-null", sequence_id: "seq-due", contact_email: "null@example.com", next_send_at: null });
    seedEnrollment({ id: "due-cancelled", sequence_id: "seq-due", contact_email: "gone@example.com", status: "cancelled", next_send_at: "2000-01-01T00:00:00.000Z" });

    const due = await getDueEnrollments(undefined, variant());
    expect(due.map((enrollment) => enrollment.id)).toEqual(["due-past"]);
  });

  it("advances through the sorted positions and completes past the last step", async () => {
    const store = variant();
    const seq = await createSequence({ name: "advance-seq" }, store);
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" }, store);
    await addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 48, template_name: "t2" }, store);
    const enrolled = await enroll({ sequence_id: seq.id, contact_email: "frank@example.com" }, store);

    const advanced = await advanceEnrollment(enrolled.id, store);
    expect(advanced?.current_step).toBe(1);
    expect(advanced?.status).toBe("active");
    expect(advanced?.next_send_at).not.toBeNull();

    const completed = await advanceEnrollment(enrolled.id, store);
    expect(completed?.status).toBe("completed");
    expect(completed?.completed_at).not.toBeNull();
    expect(completed?.next_send_at).toBeNull();

    expect(await advanceEnrollment("no-such-enrollment", store)).toBeNull();
  });
});

describe("the injectable and the sub-ledger boundary", () => {
  it("accepts a bare Database handle and scopes every table to it", async () => {
    const seq = await createSequence({ name: "handle-seq" }, db);
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 1, template_name: "t1" }, db);
    const enrolled = await enroll({ sequence_id: seq.id, contact_email: "handle@example.com" }, db);
    expect((await listSteps(seq.id, db)).map((step) => step.template_name)).toEqual(["t1"]);
    expect((await listEnrollments({ sequence_id: seq.id }, db))[0]?.id).toBe(enrolled.id);
    // The rows really are in THAT database.
    expect((db.query("SELECT COUNT(*) AS n FROM sequence_steps").get() as { n: number }).n).toBe(1);
  });

  it("resolves the configured store when no store is passed", async () => {
    // Only the database path is configured (see configureExactlyOneStore), so the
    // default resolution binds to the same process-wide connection `db` is.
    const seq = await createSequence({ name: "default-store" });
    expect((db.query("SELECT name FROM sequences WHERE id = ?").get(seq.id) as { name: string }).name)
      .toBe("default-store");
  });

  it("refuses an argument that is neither store shape, naming both", async () => {
    await expect(listSequences(undefined, {} as unknown as SequenceStore)).rejects.toThrow(
      /EmailStore or a bun:sqlite Database/,
    );
  });

  it("refuses sub-ledger operations by name on a store that carries none", async () => {
    // A seam-only store: every declared repository, none of the extension. The
    // sequences table still works; the sub-ledger refuses rather than fabricating.
    const bare = { ...sqliteStore() } as unknown as Record<string, unknown>;
    delete bare["sequenceSteps"];
    delete bare["sequenceEnrollments"];
    const store = bare as unknown as EmailStore;
    expect((await listSequences(undefined, store)).length).toBe(0);
    await expect(listSteps("any", store)).rejects.toThrow(/sequence sub-ledger/);
    await expect(enroll({ sequence_id: "any", contact_email: "x@example.com" }, store)).rejects.toThrow(
      /sequence sub-ledger/,
    );
  });
});

describe("defences a well-behaved fixture cannot exercise", () => {
  // Both real stores honour equality filters and advance their pages, so the two
  // defences below are only observable against a store that does not — and a mutation
  // run showed that removing either one survived every case driven through the honest
  // fixtures. Each wrapper here misbehaves in exactly one way.

  it("re-checks the pushed-down sequence filter rather than trusting the store", async () => {
    seedSequence({ id: "seq-mine", name: "mine" });
    seedSequence({ id: "seq-theirs", name: "theirs" });
    seedStep({ id: "step-mine", sequence_id: "seq-mine", step_number: 1 });
    seedStep({ id: "step-theirs", sequence_id: "seq-theirs", step_number: 1 });
    const real = sqliteStore();
    const subledger = sequenceSubledgerOf(real);
    if (subledger === null) throw new Error("the SQLite store lost its sub-ledger");
    // Ignores `filters` entirely and answers with the unfiltered list — the exact
    // behaviour of a route that silently drops a query parameter.
    const filterIgnoring = {
      ...real,
      sequenceSteps: {
        ...subledger.sequenceSteps,
        list: (opts?: { limit?: number; offset?: number }) =>
          subledger.sequenceSteps.list({ ...(opts?.limit === undefined ? {} : { limit: opts.limit }), ...(opts?.offset === undefined ? {} : { offset: opts.offset }) }),
      },
    } as unknown as EmailStore;
    const steps = await listSteps("seq-mine", filterIgnoring);
    expect(steps.map((step) => step.id)).toEqual(["step-mine"]);
  });

  it("re-checks the pushed-down enrollment filters rather than trusting the store", async () => {
    seedSequence({ id: "seq-a", name: "a" });
    seedSequence({ id: "seq-b", name: "b" });
    seedEnrollment({ id: "en-a-active", sequence_id: "seq-a", contact_email: "aa@example.com" });
    seedEnrollment({ id: "en-a-cancelled", sequence_id: "seq-a", contact_email: "ac@example.com", status: "cancelled" });
    seedEnrollment({ id: "en-b-active", sequence_id: "seq-b", contact_email: "ba@example.com" });
    const real = sqliteStore();
    const subledger = sequenceSubledgerOf(real);
    if (subledger === null) throw new Error("the SQLite store lost its sub-ledger");
    const filterIgnoring = {
      ...real,
      sequenceEnrollments: {
        ...subledger.sequenceEnrollments,
        list: (opts?: { limit?: number; offset?: number }) =>
          subledger.sequenceEnrollments.list({ ...(opts?.limit === undefined ? {} : { limit: opts.limit }), ...(opts?.offset === undefined ? {} : { offset: opts.offset }) }),
      },
    } as unknown as EmailStore;
    const page = await listEnrollments({ sequence_id: "seq-a", status: "active" }, filterIgnoring);
    expect(page.map((enrollment) => enrollment.id)).toEqual(["en-a-active"]);
    expect(await countEnrollmentsByStatus("seq-a", filterIgnoring)).toEqual({
      active: 1,
      completed: 0,
      cancelled: 1,
      total: 2,
    });
  });

  it("refuses a read whose pages never advance instead of presenting the loop as the table", async () => {
    seedSequence({ id: "seq-stuck", name: "stuck" });
    // TWO rows, so a window pinned to the first page can never legitimately reach the
    // empty page that means "end of table" — the anchored re-read comes back holding
    // rows that are not the anchor, which is the proof the window moved.
    seedStep({ id: "step-stuck-a", sequence_id: "seq-stuck", step_number: 1 });
    seedStep({ id: "step-stuck-b", sequence_id: "seq-stuck", step_number: 2 });
    const real = sqliteStore();
    const subledger = sequenceSubledgerOf(real);
    if (subledger === null) throw new Error("the SQLite store lost its sub-ledger");
    // Serves page one for every offset — a store whose window cannot move. An
    // enumeration that cannot notice this reports the same rows forever as the table.
    const stuck = {
      ...real,
      sequenceSteps: {
        ...subledger.sequenceSteps,
        list: (opts?: { limit?: number; offset?: number }) =>
          subledger.sequenceSteps.list({ ...(opts ?? {}), offset: 0 }),
      },
    } as unknown as EmailStore;
    await expect(listSteps("seq-stuck", stuck)).rejects.toThrow(/LOWER BOUND/);
  });
});

describe("cascade on the local store", () => {
  it("deleting a sequence removes its steps and enrollments through the schema's own keys", async () => {
    const store = sqliteStore();
    const seq = await createSequence({ name: "cascade" }, store);
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 1, template_name: "t1" }, store);
    await enroll({ sequence_id: seq.id, contact_email: "cascade@example.com" }, store);
    expect(await deleteSequence(seq.id, store)).toBe(true);
    expect((db.query("SELECT COUNT(*) AS n FROM sequence_steps").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM sequence_enrollments").get() as { n: number }).n).toBe(0);
  });
});
