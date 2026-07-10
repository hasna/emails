import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = join(import.meta.dir, "..", ".github", "workflows");

describe("repository workflow safety", () => {
  it("allows only product CI and credential-free Terraform validation", () => {
    const files = existsSync(workflowDir)
      ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort()
      : [];
    const text = files.map((name) => readFileSync(join(workflowDir, name), "utf8")).join("\n");
    expect(files).toEqual(["ci.yml", "terraform-aws-validate.yml"]);
    expect(text).not.toMatch(
      /configure-aws-credentials|aws-actions\/amazon-ecr|amazon-ecr-login|ecs update-service|aws configure|role-to-assume|id-token:\s*write/i,
    );
    expect(text).not.toMatch(/^\s*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*:/m);
    expect(text).not.toMatch(/\b(?:terraform|tofu)\s+(?:apply|destroy)\b/i);
    expect(text).not.toMatch(/\b(?:npm|bun|pnpm|yarn)\s+publish\b/i);
  });
});
