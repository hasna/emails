// Unit tests for the in-process sliding-window auth rate limiter (WI-2c, L3).

import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  test("allows up to the limit, then denies within the window", () => {
    let now = 1_000_000;
    const rl = new RateLimiter({ rules: { login: { limit: 3, windowMs: 1000 } }, now: () => now });
    expect(rl.check("login", "ip1").ok).toBe(true);
    expect(rl.check("login", "ip1").ok).toBe(true);
    expect(rl.check("login", "ip1").ok).toBe(true);
    const denied = rl.check("login", "ip1");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("the window slides — attempts age out", () => {
    let now = 0;
    const rl = new RateLimiter({ rules: { login: { limit: 2, windowMs: 1000 } }, now: () => now });
    expect(rl.check("login", "k").ok).toBe(true);
    expect(rl.check("login", "k").ok).toBe(true);
    expect(rl.check("login", "k").ok).toBe(false);
    now += 1001; // both prior attempts age out
    expect(rl.check("login", "k").ok).toBe(true);
  });

  test("keys are independent (ip vs email dimensions)", () => {
    let now = 0;
    const rl = new RateLimiter({ rules: { login: { limit: 1, windowMs: 1000 } }, now: () => now });
    expect(rl.check("login", "ipA").ok).toBe(true);
    expect(rl.check("login", "ipA").ok).toBe(false);
    expect(rl.check("login", "ipB").ok).toBe(true);
  });

  test("checkAll denies if ANY dimension is over the limit and records both", () => {
    let now = 0;
    const rl = new RateLimiter({ rules: { login: { limit: 1, windowMs: 1000 } }, now: () => now });
    expect(rl.checkAll("login", ["ip", "user@hasna.com"]).ok).toBe(true);
    // both dimensions now at their limit -> next call denied
    expect(rl.checkAll("login", ["ip", "user@hasna.com"]).ok).toBe(false);
  });

  test("unknown route is always allowed", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 100; i++) expect(rl.check("no-such-route", "k").ok).toBe(true);
  });

  test("reset clears a key's attempts (post-successful-login)", () => {
    let now = 0;
    const rl = new RateLimiter({ rules: { login: { limit: 1, windowMs: 10_000 } }, now: () => now });
    expect(rl.check("login", "k").ok).toBe(true);
    expect(rl.check("login", "k").ok).toBe(false);
    rl.reset("login", "k");
    expect(rl.check("login", "k").ok).toBe(true);
  });
});
