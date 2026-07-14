// In-process sliding-window rate limiter for the auth endpoints (WI-2c).
//
// Design ref: docs/design/multi-tenancy-auth.md §8. The self-hosted service is a
// single `Bun.serve` process, so an in-memory counter is sufficient (a note in
// the design: swap for a DB/Redis counter if ever horizontally scaled). This is a
// CHEAP pre-filter in front of the expensive argon2id verify (mitigates L3, the
// CPU/memory DoS amplifier), plus generic signup/forgot throttling. Durable
// per-ACCOUNT lockout lives on `users.failed_login_count`/`locked_until` (see
// AuthStore) — this module only rate-limits by (route, ip) and (route, email).
//
// Pure/stateful module (a Map of timestamps) — unit-tested with an injected clock.

export interface RateLimitRule {
  /** Max events allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  ok: boolean;
  /** Seconds until the caller may retry (only meaningful when !ok). */
  retryAfterSeconds: number;
}

/** Default rules per logical route (design §8: login 5/15min, signup 3/hour). */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitRule> = {
  login: { limit: 5, windowMs: 15 * 60_000 },
  signup: { limit: 3, windowMs: 60 * 60_000 },
  forgot: { limit: 3, windowMs: 60 * 60_000 },
  "verify-resend": { limit: 3, windowMs: 60 * 60_000 },
  reset: { limit: 5, windowMs: 60 * 60_000 },
  invite: { limit: 20, windowMs: 60 * 60_000 },
};

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly rules: Record<string, RateLimitRule>;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(options: { rules?: Record<string, RateLimitRule>; now?: () => number } = {}) {
    this.rules = { ...DEFAULT_RATE_LIMITS, ...(options.rules ?? {}) };
    this.now = options.now ?? Date.now;
  }

  /**
   * Record one attempt for `route` against `key` (e.g. an ip or an email) and
   * decide whether it is permitted. Sliding window: prunes timestamps older than
   * the window, rejects when the count would exceed the limit. An unknown route
   * (no rule) always passes.
   */
  check(route: string, key: string): RateLimitDecision {
    const rule = this.rules[route];
    if (!rule) return { ok: true, retryAfterSeconds: 0 };
    const now = this.now();
    this.maybeSweep(now);
    const bucketKey = `${route}::${key}`;
    const windowStart = now - rule.windowMs;
    const timestamps = (this.hits.get(bucketKey) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= rule.limit) {
      const oldest = timestamps[0]!;
      const retryAfterMs = oldest + rule.windowMs - now;
      this.hits.set(bucketKey, timestamps);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    timestamps.push(now);
    this.hits.set(bucketKey, timestamps);
    return { ok: true, retryAfterSeconds: 0 };
  }

  /**
   * Check MULTIPLE keys (ip AND email) for one route in a single call; the request
   * is denied if ANY dimension is over the limit. Records an attempt on every
   * dimension so both counters advance together.
   */
  checkAll(route: string, keys: Array<string | null | undefined>): RateLimitDecision {
    let worst: RateLimitDecision = { ok: true, retryAfterSeconds: 0 };
    for (const key of keys) {
      if (!key) continue;
      const d = this.check(route, key);
      if (!d.ok && d.retryAfterSeconds > worst.retryAfterSeconds) worst = d;
      if (!d.ok) worst = { ok: false, retryAfterSeconds: Math.max(worst.retryAfterSeconds, d.retryAfterSeconds) };
    }
    return worst;
  }

  /** Forget all recorded attempts for a route+key (e.g. after a successful login). */
  reset(route: string, key: string): void {
    this.hits.delete(`${route}::${key}`);
  }

  /** Periodically drop fully-expired buckets so the Map cannot grow unbounded. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const maxWindow = Math.max(...Object.values(this.rules).map((r) => r.windowMs));
    const cutoff = now - maxWindow;
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
