import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = join(import.meta.dir, "..", ".github", "workflows");

describe("repository workflow safety", () => {
  it("cannot deploy, publish, or touch AWS on merge", () => {
    const files = existsSync(workflowDir)
      ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))
      : [];
    const text = files.map((name) => readFileSync(join(workflowDir, name), "utf8")).join("\n");
    expect(files).toEqual(["ci.yml"]);
    expect(text).not.toMatch(/aws-actions|amazon-ecr|ecs update-service|npm publish|bun publish/i);
  });
});
