// Self-hosted-ONLY: the aliases repo routes every read/write to the /v1
// `aliases` API. This exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Unlike the old local store,
// nothing auto-seeds a protected global catch-all — the global "*" catch-all only
// exists after setGlobalCatchAll()/ensureDefaultCatchAll() is called, so tests
// create it explicitly where the assertions depend on it.
//
// Client-side behaviors that STILL live in the repo and are retained here:
//   - upsert on duplicate (domain, local_part) (list-then-update, not a SQLite
//     UNIQUE constraint),
//   - the protected-catch-all delete refusal (removeAlias checks `protected`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createAlias, createCatchAll, removeAlias, getAlias,
  listAliases, resolveAlias, CATCH_ALL,
  setGlobalCatchAll, ensureDefaultCatchAll, listAliasesByTargets,
} from "./aliases.js";

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

describe("aliases", () => {
  it("creates an alias and resolves it to its target", () => {
    const a = createAlias("hello@acme.com", "ops@acme.com");
    expect(a.domain).toBe("acme.com");
    expect(a.local_part).toBe("hello");
    expect(a.target_address).toBe("ops@acme.com");
    expect(resolveAlias("hello@acme.com")).toBe("ops@acme.com");
  });

  it("is case-insensitive on the recipient", () => {
    createAlias("Hello@Acme.com", "ops@acme.com");
    expect(resolveAlias("HELLO@ACME.COM")).toBe("ops@acme.com");
  });

  it("returns null when nothing matches", () => {
    expect(resolveAlias("nobody@acme.com")).toBeNull();
  });

  it("rejects an alias without a local part", () => {
    expect(() => createAlias("acme.com", "ops@acme.com")).toThrow();
  });

  it("upserts on duplicate (domain, local_part)", () => {
    createAlias("hello@acme.com", "a@acme.com");
    createAlias("hello@acme.com", "b@acme.com");
    expect(resolveAlias("hello@acme.com")).toBe("b@acme.com");
    expect(listAliases("acme.com")).toHaveLength(1);
  });
});

describe("catch-all", () => {
  it("routes any unmatched recipient on the domain", () => {
    createCatchAll("acme.com", "inbox@acme.com");
    expect(resolveAlias("whatever@acme.com")).toBe("inbox@acme.com");
    expect(resolveAlias("random123@acme.com")).toBe("inbox@acme.com");
  });

  it("a specific alias wins over the catch-all", () => {
    createCatchAll("acme.com", "inbox@acme.com");
    createAlias("sales@acme.com", "sales-team@acme.com");
    expect(resolveAlias("sales@acme.com")).toBe("sales-team@acme.com");
    expect(resolveAlias("other@acme.com")).toBe("inbox@acme.com");
  });

  it("catch-all only affects its own domain", () => {
    createCatchAll("acme.com", "inbox@acme.com");
    expect(resolveAlias("x@other.com")).toBeNull();
  });

  it("catch-all uses the sentinel local_part", () => {
    const c = createCatchAll("acme.com", "inbox@acme.com");
    expect(c.local_part).toBe(CATCH_ALL);
  });
});

describe("list / remove", () => {
  it("lists all and per-domain, and removes by id", () => {
    const a = createAlias("a@x.com", "t@x.com");
    createCatchAll("y.com", "t@y.com");
    // No global catch-all is auto-seeded in the self-hosted model.
    expect(listAliases()).toHaveLength(2);
    expect(listAliases("x.com")).toHaveLength(1);
    expect(removeAlias(a.id)).toBe(true);
    expect(getAlias(a.id)).toBeNull();
    expect(resolveAlias("a@x.com")).toBeNull();
  });

  it("paginates all aliases after applying stable list order", () => {
    ensureDefaultCatchAll();
    createAlias("b@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    // Order: global "*" first, then by domain, then local-part; offset 1 skips "*".
    const page = listAliases(undefined, { limit: 2, offset: 1 });

    expect(page.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  it("paginates domain aliases after sorting by local part", () => {
    createAlias("c@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("b@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const page = listAliases("x.com", { limit: 2, offset: 1 });

    expect(page.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "b@x.com",
      "c@x.com",
    ]);
  });

  it("lists aliases by target addresses without scanning unrelated targets in callers", () => {
    createAlias("support@x.com", "ops@x.com");
    createCatchAll("y.com", "ops@x.com");
    createAlias("sales@x.com", "sales@x.com");

    expect(listAliasesByTargets(["OPS@x.com", "ops@x.com"]).map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "support@x.com",
      "*@y.com",
    ]);
    expect(listAliasesByTargets([])).toEqual([]);
  });
});

describe("global catch-all (protected, all domains)", () => {
  it("resolves any domain when no specific/domain match", () => {
    setGlobalCatchAll("inbox@hq.com");
    expect(resolveAlias("anything@whatever.com")).toBe("inbox@hq.com");
    expect(resolveAlias("x@another.org")).toBe("inbox@hq.com");
  });

  it("precedence: specific > domain catch-all > global", () => {
    setGlobalCatchAll("global@hq.com");
    createCatchAll("acme.com", "acme-inbox@hq.com");
    createAlias("ceo@acme.com", "ceo@hq.com");
    expect(resolveAlias("ceo@acme.com")).toBe("ceo@hq.com");        // specific
    expect(resolveAlias("random@acme.com")).toBe("acme-inbox@hq.com"); // domain catch-all
    expect(resolveAlias("x@other.com")).toBe("global@hq.com");       // global
  });

  it("the protected global catch-all cannot be deleted", () => {
    const g = setGlobalCatchAll("inbox@hq.com");
    expect(g.protected).toBe(true);
    expect(() => removeAlias(g.id)).toThrow(/protected/i);
  });

  it("ensureDefaultCatchAll is idempotent and protected", () => {
    const a = ensureDefaultCatchAll();
    const b = ensureDefaultCatchAll();
    expect(a.id).toBe(b.id);
    expect(a.protected).toBe(true);
    expect(listAliases().filter((x) => x.domain === "*")).toHaveLength(1);
  });
});
