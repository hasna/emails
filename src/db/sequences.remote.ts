import { now, uuid } from "./runtime.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, cnum, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const SEQUENCE_RESOURCE = "sequences";
const STEP_RESOURCE = "sequence-steps";
const ENROLLMENT_RESOURCE = "sequence-enrollments";

export type SequenceStatus = "active" | "paused" | "archived";
export type EnrollmentStatus = "active" | "completed" | "cancelled";

export interface Sequence {
  id: string;
  name: string;
  description: string | null;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_number: number;
  delay_hours: number;
  template_name: string;
  from_address: string | null;
  subject_override: string | null;
  created_at: string;
}

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  contact_email: string;
  provider_id: string | null;
  current_step: number;
  status: EnrollmentStatus;
  enrolled_at: string;
  next_send_at: string | null;
  completed_at: string | null;
}

export interface ListSequenceOptions {
  limit?: number;
  offset?: number;
}

export interface ListEnrollmentOptions {
  sequence_id?: string;
  status?: EnrollmentStatus;
  limit?: number;
  offset?: number;
}

export interface ListDueEnrollmentOptions {
  limit?: number;
}

export interface EnrollmentStatusCounts {
  active: number;
  completed: number;
  cancelled: number;
  total: number;
}

function apiToSequence(e: Record<string, unknown>): Sequence {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    name: cstr(e["name"]),
    description: cstrOrNull(e["description"]),
    status: (cstr(e["status"]) || "active") as SequenceStatus,
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function apiToStep(e: Record<string, unknown>): SequenceStep {
  return {
    id: cstr(e["id"]),
    sequence_id: cstr(e["sequence_id"]),
    step_number: cnum(e["step_number"]),
    delay_hours: cnum(e["delay_hours"]),
    template_name: cstr(e["template_name"]),
    from_address: cstrOrNull(e["from_address"]),
    subject_override: cstrOrNull(e["subject_override"]),
    created_at: ciso(e["created_at"]),
  };
}

function apiToEnrollment(e: Record<string, unknown>): SequenceEnrollment {
  return {
    id: cstr(e["id"]),
    sequence_id: cstr(e["sequence_id"]),
    contact_email: cstr(e["contact_email"]),
    provider_id: cstrOrNull(e["provider_id"]),
    current_step: cnum(e["current_step"]),
    status: (cstr(e["status"]) || "active") as EnrollmentStatus,
    enrolled_at: ciso(e["enrolled_at"]),
    next_send_at: cstrOrNull(e["next_send_at"]),
    completed_at: cstrOrNull(e["completed_at"]),
  };
}

// ─── SEQUENCES ────────────────────────────────────────────────────────────────

export function createSequence(input: { name: string; description?: string }): Sequence {
  return apiToSequence(selfHostedResource(SEQUENCE_RESOURCE).create({
    name: input.name,
    description: input.description || null,
    status: "active",
  }));
}

export function getSequence(nameOrId: string): Sequence | null {
  const store = selfHostedResource(SEQUENCE_RESOURCE);
  const direct = store.get(nameOrId);
  if (direct) return apiToSequence(direct);
  return store.list({ limit: 1000 }).map(apiToSequence).find((sequence) => sequence.name === nameOrId) ?? null;
}

export function listSequences(opts?: ListSequenceOptions): Sequence[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  const rows = selfHostedResource(SEQUENCE_RESOURCE).list(query).map(apiToSequence);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function updateSequence(
  id: string,
  updates: Partial<Pick<Sequence, "name" | "description" | "status">>,
): Sequence {
  return apiToSequence(selfHostedResource(SEQUENCE_RESOURCE).update(id, updates));
}

export function deleteSequence(id: string): boolean {
  return selfHostedResource(SEQUENCE_RESOURCE).del(id);
}

// ─── STEPS ────────────────────────────────────────────────────────────────────

export function addStep(
  input: {
    sequence_id: string;
    step_number: number;
    delay_hours: number;
    template_name: string;
    from_address?: string;
    subject_override?: string;
  },
): SequenceStep {
  const id = uuid();
  const timestamp = now();
  return apiToStep(selfHostedResource(STEP_RESOURCE).create({
    id,
    sequence_id: input.sequence_id,
    step_number: input.step_number,
    delay_hours: input.delay_hours,
    template_name: input.template_name,
    from_address: input.from_address || null,
    subject_override: input.subject_override || null,
    created_at: timestamp,
  }));
}

export function listSteps(sequence_id: string): SequenceStep[] {
  return selfHostedResource(STEP_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToStep)
    .filter((s) => s.sequence_id === sequence_id)
    .sort((a, b) => a.step_number - b.step_number);
}

export function getStepAtIndex(sequence_id: string, index: number): SequenceStep | null {
  return listSteps(sequence_id)[safeOffset(index)] ?? null;
}

export function removeStep(id: string): boolean {
  return selfHostedResource(STEP_RESOURCE).del(id);
}

// ─── ENROLLMENTS ──────────────────────────────────────────────────────────────

export function enroll(
  input: { sequence_id: string; contact_email: string; provider_id?: string },
): SequenceEnrollment {
  const store = selfHostedResource(ENROLLMENT_RESOURCE);

  // Idempotent: return existing enrollment if already enrolled.
  const existing = store
    .list({ limit: 1000 })
    .map(apiToEnrollment)
    .find((e) => e.sequence_id === input.sequence_id && e.contact_email === input.contact_email);
  if (existing) return existing;

  const id = uuid();
  const timestamp = now();

  // Compute next_send_at based on the first step's delay_hours.
  const firstStep = listSteps(input.sequence_id)[0];
  const nextSendAt = firstStep
    ? new Date(Date.now() + firstStep.delay_hours * 3600 * 1000).toISOString()
    : null;

  return apiToEnrollment(store.create({
    id,
    sequence_id: input.sequence_id,
    contact_email: input.contact_email,
    provider_id: input.provider_id || null,
    current_step: 0,
    status: "active",
    enrolled_at: timestamp,
    next_send_at: nextSendAt,
    completed_at: null,
  }));
}

export function unenroll(sequence_id: string, contact_email: string): boolean {
  const store = selfHostedResource(ENROLLMENT_RESOURCE);
  const existing = store
    .list({ limit: 1000 })
    .map(apiToEnrollment)
    .find((e) => e.sequence_id === sequence_id && e.contact_email === contact_email && e.status === "active");
  if (!existing) return false;
  store.update(existing.id, { status: "cancelled" });
  return true;
}

export function listEnrollments(opts?: ListEnrollmentOptions): SequenceEnrollment[] {
  let rows = selfHostedResource(ENROLLMENT_RESOURCE).list({ limit: 1000 }).map(apiToEnrollment);
  if (opts?.sequence_id) rows = rows.filter((e) => e.sequence_id === opts.sequence_id);
  if (opts?.status) rows = rows.filter((e) => e.status === opts.status);
  rows.sort((a, b) => (b.enrolled_at ?? "").localeCompare(a.enrolled_at ?? ""));
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return limit === null ? rows : rows.slice(offset, offset + limit);
}

export function countEnrollmentsByStatus(sequenceId: string): EnrollmentStatusCounts {
  const rows = selfHostedResource(ENROLLMENT_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToEnrollment)
    .filter((e) => e.sequence_id === sequenceId);
  const counts: EnrollmentStatusCounts = { active: 0, completed: 0, cancelled: 0, total: rows.length };
  for (const e of rows) {
    if (e.status === "active") counts.active++;
    else if (e.status === "completed") counts.completed++;
    else if (e.status === "cancelled") counts.cancelled++;
  }
  return counts;
}

export function getDueEnrollments(opts?: ListDueEnrollmentOptions): SequenceEnrollment[] {
  const currentTime = now();
  const limit = safeOptionalLimit(opts?.limit);
  const rows = selfHostedResource(ENROLLMENT_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToEnrollment)
    .filter((e) => e.status === "active" && e.next_send_at !== null && e.next_send_at <= currentTime)
    .sort((a, b) => (a.next_send_at ?? "").localeCompare(b.next_send_at ?? "") || a.id.localeCompare(b.id));
  return limit === null ? rows : rows.slice(0, limit);
}

export function advanceEnrollment(enrollment_id: string): SequenceEnrollment | null {
  const store = selfHostedResource(ENROLLMENT_RESOURCE);
  const record = store.get(enrollment_id);
  if (!record) return null;
  const enrollment = apiToEnrollment(record);

  // current_step is a 0-based index into the sorted steps array.
  const nextIndex = enrollment.current_step + 1;
  const nextStep = getStepAtIndex(enrollment.sequence_id, nextIndex);

  if (!nextStep) {
    // No more steps — mark as completed.
    store.update(enrollment_id, {
      status: "completed",
      completed_at: now(),
      next_send_at: null,
      current_step: nextIndex,
    });
  } else {
    const nextSendAt = new Date(Date.now() + nextStep.delay_hours * 3600 * 1000).toISOString();
    store.update(enrollment_id, { current_step: nextIndex, next_send_at: nextSendAt });
  }

  const updated = store.get(enrollment_id);
  return updated ? apiToEnrollment(updated) : null;
}
