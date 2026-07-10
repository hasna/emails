import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Emails storage utility ownership", () => {
  it("lives in a product-owned path without a generated vendor manifest", () => {
    const root = join(import.meta.dir, "..", "..");
    expect(existsSync(join(root, "src", "generated", "storage-kit"))).toBe(false);
    expect(existsSync(join(import.meta.dir, ".storage-kit-manifest.json"))).toBe(false);
    expect(readFileSync(join(import.meta.dir, "README.md"), "utf8")).toContain("product-owned fork");
  });
});
