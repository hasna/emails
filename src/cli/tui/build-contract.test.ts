import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

describe("emails ui build contract", () => {
  it("bundles React with the OpenTUI React reconciler in the CLI build", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: { build: string };
    };
    const cliBuild = pkg.scripts.build.split("&&")[0] ?? "";

    expect(cliBuild).not.toContain("--external @opentui/react");
    expect(cliBuild).not.toContain("--external react");
    expect(cliBuild).toContain("--external @opentui/core");
  });
});
