import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { resolveId } from "./helpers.js";

// Self-hosted-ONLY: resolveId resolves partial ids against the /v1 resource store
// (no local SQLite). Table names still map to /v1 resources via helpers.resolveId.

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

describe("mcp/helpers resolveId (self-hosted /v1)", () => {
  it("returns full id for exact match", async () => {
    const id = "abc11111-1111-1111-1111-111111111111";
    await stub.seed({ providers: [{ id, name: "p1", type: "sandbox" }] });

    expect(resolveId("providers", id)).toBe(id);
  });

  it("throws resource-aware not-found error", () => {
    expect(() => resolveId("providers", "missing")).toThrow(
      "Could not resolve ID 'missing' in resource 'providers'.",
    );
  });

  it("throws ambiguous error with candidate IDs", async () => {
    const id1 = "abc11111-1111-1111-1111-111111111111";
    const id2 = "abc22222-2222-2222-2222-222222222222";
    await stub.seed({
      providers: [
        { id: id1, name: "p1", type: "sandbox" },
        { id: id2, name: "p2", type: "sandbox" },
      ],
    });

    const err = (() => {
      try {
        resolveId("providers", "abc");
      } catch (error) {
        return String((error as Error).message);
      }
      return "";
    })();

    expect(err).toContain("Ambiguous ID 'abc' in resource 'providers'");
    expect(err).toContain(id1);
    expect(err).toContain(id2);
  });
});
