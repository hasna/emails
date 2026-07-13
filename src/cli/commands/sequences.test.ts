// Self-hosted-ONLY: the sequences repo routes every read/write to `/v1/sequences`,
// `/v1/sequence-steps`, and `/v1/sequence-enrollments`, so these tests drive the
// REAL command against an out-of-process /v1 stub (see src/test-support/v1-stub.ts).
// No local SQLite exists anymore; enrollments and steps are API-backed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createSequence, enroll } from "../../db/sequences.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerSequenceCommands } from "./sequences.js";

let stub: V1Stub;

async function runSequenceCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  const originalLog = console.log;
  registerSequenceCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  console.log = ((...values: unknown[]) => {
    out.push(values.map(String).join(" "));
  }) as typeof console.log;
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: out.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("sequence list command", () => {
  it("paginates sequences for human and structured output", async () => {
    await stub.seed({
      sequences: [0, 1, 2, 3, 4].map((i) => ({
        id: `seq-${i}`,
        name: `cli-sequence-${i}`,
        description: null,
        status: "active",
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });

    const result = await runSequenceCommand(["sequence", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string }>;

    expect(data.map((sequence) => sequence.name)).toEqual(["cli-sequence-3", "cli-sequence-2"]);
    expect(result.out).toContain("cli-sequence-3");
    expect(result.out).not.toContain("cli-sequence-4");
  });
});

describe("sequence show command", () => {
  it("prints enrollment counts from the API", async () => {
    await stub.seed({
      sequences: [{
        id: "seq-show",
        name: "cli-show-counts",
        description: null,
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
      "sequence-steps": [{
        id: "step-1",
        sequence_id: "seq-show",
        step_number: 1,
        delay_hours: 0,
        template_name: "welcome",
        from_address: null,
        subject_override: null,
        created_at: "2026-01-01T00:00:00.000Z",
      }],
      "sequence-enrollments": [
        { id: "en-1", sequence_id: "seq-show", contact_email: "active-a@example.com", status: "active", current_step: 0, enrolled_at: "2026-01-01T00:00:00.000Z" },
        { id: "en-2", sequence_id: "seq-show", contact_email: "active-b@example.com", status: "active", current_step: 0, enrolled_at: "2026-01-02T00:00:00.000Z" },
        { id: "en-3", sequence_id: "seq-show", contact_email: "cancelled@example.com", status: "cancelled", current_step: 0, enrolled_at: "2026-01-03T00:00:00.000Z" },
        { id: "en-4", sequence_id: "seq-show", contact_email: "completed@example.com", status: "completed", current_step: 1, enrolled_at: "2026-01-04T00:00:00.000Z" },
      ],
    });

    const result = await runSequenceCommand(["sequence", "show", "cli-show-counts"]);

    expect(result.out).toContain("Enrollments: 2 active / 4 total");
  });
});

describe("sequence enrollments command", () => {
  it("lists all enrollments without requiring a sequence name", async () => {
    const sequence = createSequence({ name: "cli-enrollment-all" });
    const other = createSequence({ name: "cli-enrollment-other" });
    enroll({ sequence_id: sequence.id, contact_email: "first@example.com" });
    enroll({ sequence_id: other.id, contact_email: "second@example.com" });

    const result = await runSequenceCommand(["sequence", "enrollments"]);
    const data = result.data as Array<{ contact_email: string }>;

    expect(data.map((enrollment) => enrollment.contact_email).sort()).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
    expect(result.out).toContain("for all sequences");
  });

  it("filters by sequence and status before applying pagination", async () => {
    await stub.seed({
      sequences: [
        { id: "seq-page", name: "cli-enrollment-page", description: null, status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "seq-noise", name: "cli-enrollment-noise", description: null, status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      ],
      "sequence-enrollments": [
        ...[0, 1, 2, 3, 4].map((i) => ({
          id: `en-active-${i}`,
          sequence_id: "seq-page",
          contact_email: `active-${i}@example.com`,
          status: "active",
          current_step: 0,
          enrolled_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        })),
        { id: "en-cancelled", sequence_id: "seq-page", contact_email: "cancelled@example.com", status: "cancelled", current_step: 0, enrolled_at: "2026-01-10T00:00:00.000Z" },
        { id: "en-other", sequence_id: "seq-noise", contact_email: "other@example.com", status: "active", current_step: 0, enrolled_at: "2026-01-06T00:00:00.000Z" },
      ],
    });

    const result = await runSequenceCommand([
      "sequence",
      "enrollments",
      "cli-enrollment-page",
      "--status",
      "active",
      "--limit",
      "2",
      "--offset",
      "1",
    ]);
    const data = result.data as Array<{ contact_email: string; sequence_id: string; status: string }>;

    expect(data.map((enrollment) => enrollment.contact_email)).toEqual([
      "active-3@example.com",
      "active-2@example.com",
    ]);
    expect(data.every((enrollment) => enrollment.sequence_id === "seq-page")).toBe(true);
    expect(data.every((enrollment) => enrollment.status === "active")).toBe(true);
  });
});
