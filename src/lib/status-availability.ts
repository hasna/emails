/**
 * Honest-unavailable primitives for the system status payload.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `emails status` is the FIRST command an operator or agent runs to decide
 * whether the system is usable. Before this module existed, the self-hosted
 * status payload hardcoded `providers: { total: 0, active: 0, by_type: {} }`,
 * `domains: { total: 0, send_ready: 0, ... }` and `addresses: { total: 0, ... }`
 * while the server held 37 providers, 75 domains and 325 addresses. A zero is
 * type-valid and reads as an authoritative count, so "I did not look" was
 * rendered as "there is nothing there" — the same class of confident-but-false
 * output that once convinced an operator six emails had been delivered when
 * none had left the system.
 *
 * THE CONTRACT
 * ------------
 * Every value field in the status payload is either:
 *   1. populated from a real source (and its block records the provenance in
 *      `availability.source` / `availability.basis`), or
 *   2. `null` AND registered in the payload's top-level `gaps` map with a
 *      machine-readable reason code.
 *
 * `null` — not `0`, not `[]`, not `"unknown"` — is the sentinel:
 *   - `null` changes the JSON type, so arithmetic yields NaN/undefined and a
 *     typed consumer (`number | null`) gets a compile error. It fails LOUD.
 *   - `0` / `[]` are type-valid and silently read as authoritative. That is the
 *     defect.
 *   - a string sentinel ("unknown"/"n/a") forces `number | string` unions and
 *     invites accidental `Number()` coercion back to NaN or 0.
 *   - an availability flag ALONE is not enough: a consumer that does not read
 *     the flag still sees a confident 0. Both signals are required.
 *
 * Reason strings are formatted `<code>:<detail> — <prose>` so a machine matches
 * on the code prefix and a human reads the prose.
 */

/**
 * Closed set of reasons a status field can be unavailable. Keep this small: a
 * new code means a genuinely new kind of gap, not a new phrasing.
 *
 * - `server_route_absent`     the self-hosted API has no route that answers this
 * - `not_modelled_over_v1`    the data is not represented on any `/v1` entity
 * - `source_unreachable`      the source exists but the read failed (HTTP/IO)
 * - `not_applicable`          the field has no meaning in the selected mode
 * - `enumeration_cap_exceeded` a count could only be bounded, not resolved
 */
export const STATUS_UNAVAILABLE_CODES = [
  "server_route_absent",
  "not_modelled_over_v1",
  "source_unreachable",
  "not_applicable",
  "enumeration_cap_exceeded",
] as const;

export type StatusUnavailableCode = (typeof STATUS_UNAVAILABLE_CODES)[number];

/**
 * How a number in the block was obtained.
 * - `server_count`       the server returned an authoritative total
 * - `client_enumeration` the client paged rows and counted them
 * - `local_query`        a local SQLite aggregate
 * - `local_config`       the operator's local config file
 */
export type StatusBasis = "server_count" | "client_enumeration" | "local_query" | "local_config";

export interface StatusAvailability {
  /** false => every value field in this block is null and registered in `gaps`. */
  available: boolean;
  /** `<code>:<detail> — <prose>`, or null when available. */
  reason: string | null;
  /** Provenance, e.g. `self_hosted_api:/v1/providers`, `local_sqlite:addresses`. */
  source: string;
  basis: StatusBasis | null;
  /**
   * false => the numbers in this block are LOWER BOUNDS (the enumeration budget
   * ran out). Renderers must prefix them with `≥`. null when unavailable.
   */
  complete: boolean | null;
}

export function statusAvailable(
  source: string,
  basis: StatusBasis,
  complete = true,
): StatusAvailability {
  return { available: true, reason: null, source, basis, complete };
}

export function statusUnavailable(
  code: StatusUnavailableCode,
  detail: string,
  source: string,
  prose?: string,
): StatusAvailability {
  const reason = prose ? `${code}:${detail} — ${prose}` : `${code}:${detail}`;
  return { available: false, reason, source, basis: null, complete: null };
}

/** Extract the machine-readable code prefix from a reason string. */
export function statusReasonCode(reason: string | null | undefined): StatusUnavailableCode | null {
  if (!reason) return null;
  const code = reason.split(":", 1)[0];
  return (STATUS_UNAVAILABLE_CODES as readonly string[]).includes(code ?? "")
    ? (code as StatusUnavailableCode)
    : null;
}

/**
 * Registry of unavailable fields, keyed by dotted payload path.
 *
 * `mark` returns `null` so a builder reads as a single honest expression:
 *
 *   send_ready: gaps.mark("domains.send_ready", statusUnavailable(...)),
 *
 * which makes it impossible to null a field without recording why.
 */
export class StatusGaps {
  private readonly entries = new Map<string, StatusAvailability>();

  mark(path: string, availability: StatusAvailability): null {
    if (availability.available) {
      throw new Error(`StatusGaps.mark('${path}') requires an unavailable availability record.`);
    }
    this.entries.set(path, availability);
    return null;
  }

  /** Merge a block's relative gap paths under `prefix` (e.g. `domains`). */
  mergePrefixed(prefix: string, gaps: Record<string, StatusAvailability>): void {
    for (const [relative, availability] of Object.entries(gaps)) {
      this.entries.set(`${prefix}.${relative}`, availability);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  paths(): string[] {
    return [...this.entries.keys()].sort();
  }

  toRecord(): Record<string, StatusAvailability> {
    return Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

function isAvailabilityRecord(value: unknown): value is StatusAvailability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["available"] === "boolean"
    && "reason" in candidate
    && "source" in candidate
    && "basis" in candidate
    && "complete" in candidate;
}

export interface StatusAvailabilityScan {
  /** Dotted paths of blocks whose source could not be read at all. */
  unavailableBlocks: string[];
  /** Dotted paths of blocks whose numbers are lower bounds only. */
  incompleteBlocks: string[];
}

/**
 * Walk an assembled payload and collect every block that carries an
 * `availability` record which is unavailable or incomplete. This is a GENERIC
 * walk on purpose: a block added later is picked up without touching this code.
 */
export function scanStatusAvailability(root: unknown): StatusAvailabilityScan {
  const unavailableBlocks: string[] = [];
  const incompleteBlocks: string[] = [];

  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      // Availability records live on blocks, never inside row arrays.
      return;
    }
    const obj = value as Record<string, unknown>;
    const availability = obj["availability"];
    if (isAvailabilityRecord(availability) && path) {
      if (!availability.available) unavailableBlocks.push(path);
      else if (availability.complete === false) incompleteBlocks.push(path);
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key === "availability") continue;
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  visit(root, "", 0);
  return { unavailableBlocks: unavailableBlocks.sort(), incompleteBlocks: incompleteBlocks.sort() };
}

/** Human rendering of a count that may be null or a lower bound. */
export function renderStatusCount(
  value: number | null,
  availability?: StatusAvailability | null,
): string {
  if (value === null) return "unavailable";
  return availability?.complete === false ? `≥${value}` : String(value);
}

/** Human rendering of an unavailable field: never a number, always the reason. */
export function renderStatusUnavailable(availability: StatusAvailability | null | undefined): string {
  return availability?.reason ? `unavailable — ${availability.reason}` : "unavailable";
}
