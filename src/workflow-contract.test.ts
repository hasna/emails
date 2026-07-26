import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = join(import.meta.dir, "..", ".github", "workflows");
const repositoryRoot = join(import.meta.dir, "..");

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

  it("keeps both product CI jobs on the reviewed Bun toolchain", () => {
    const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
    expect(ci.match(/bun-version:\s*1\.3\.14/g)).toHaveLength(2);
    expect(ci).not.toContain("bun-version: 1.3.13");
  });

  it("scans the locally patched Bun base without weakening either vulnerability gate", () => {
    const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
    expect(ci).toContain(
      "BUN_UPSTREAM_IMAGE: oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0",
    );
    expect(ci).toContain(
      "CONTAINER_RUNTIME_PATCHED_BASE_IMAGE: hasna-emails-patched-bun-base:ci",
    );
    expect(ci.match(/image-ref: \$\{\{ env\.CONTAINER_RUNTIME_PATCHED_BASE_IMAGE \}\}/g)).toHaveLength(2);
    expect(ci).not.toContain("image-ref: ${{ env.BUN_UPSTREAM_IMAGE }}");
    expect(ci).toContain("trivy-patched-bun-base-report.json");
    expect(ci).toContain(
      'and (([.Results[]? | select(.Class == "os-pkgs") | .Packages[]? | .Name] | unique | sort) == ["libgcc", "libstdc++", "musl"])',
    );
    expect(ci).toContain(
      'and (([.Results[]? | select(.Class == "lang-pkgs") | .Packages[]?] | length) > 0)',
    );
    expect(
      ci.match(/and \(\(\[\.Results\[\]\? \| select\(\.Class == "os-pkgs"\) \| \.Packages\[\]\?\] \| length\) > 0\)/g),
    ).toHaveLength(1);
    expect(ci.match(/severity: CRITICAL,HIGH/g)).toHaveLength(2);
    expect(ci.match(/ignore-unfixed: "false"/g)).toHaveLength(4);
    expect(ci).not.toMatch(/ignorefile|skip-files|skip-dirs|trivyignores|vex/i);
    expect(ci).toContain(
      "docker image rm -f hasna-emails-runtime-contract:ci hasna-emails-patched-bun-base:ci || true",
    );
  });

  it("requires the exact merged and published commit before any AWS deployment", () => {
    const runbook = "docs/DEPLOYMENT_CUTOVER.md";
    const text = readFileSync(join(repositoryRoot, runbook), "utf8");
    const preflightStart = text.indexOf("## Fail-closed release-order preflight");
    const deploymentStart = text.search(
      /rehearsal_terraform apply|rehearsal_aws ecs (?:run-task|update-service)/,
    );

    expect(preflightStart, `${runbook} must define the release-order preflight`).toBeGreaterThanOrEqual(0);
    expect(deploymentStart, `${runbook} must identify the deployment boundary`).toBeGreaterThan(preflightStart);

    const preflight = text.slice(preflightStart, deploymentStart);
    for (const marker of [
      "RELEASE_PR_NUMBER",
      "HOSTED_CI_WORKFLOW",
      "NPM_PACKAGE",
      'git -C "$SOURCE_CHECKOUT" fetch --quiet --no-tags origin main',
      'git -C "$SOURCE_CHECKOUT" merge-base --is-ancestor "$RELEASE_COMMIT" "$ORIGIN_MAIN_COMMIT"',
      ".merge_commit_sha == $release_commit",
      'actions/workflows/$HOSTED_CI_WORKFLOW/runs?head_sha=$RELEASE_COMMIT',
      ".head_sha == $release_commit",
      '.conclusion == "success"',
      'npm view "$NPM_PACKAGE@$RELEASE_VERSION" --json',
      ".gitHead == $release_commit",
      "EXPECTED_NPM_TARBALL_URL",
      ".dist.integrity",
      'test("^sha512-[A-Za-z0-9+/]+={0,2}$")',
      ".dist.tarball == $tarball_url",
      'npm pack --ignore-scripts --json --pack-destination "$NPM_PACK_DIR"',
      ".integrity == $registry_integrity",
      'test -f "$NPM_PACK_PATH"',
      "AWS deployment is prohibited",
      "Manual publishing and AWS deployment remain separate, manual, PR-first actions.",
    ]) {
      expect(preflight, `${runbook} release preflight is missing ${marker}`).toContain(marker);
    }

    expect(preflight).not.toMatch(
      /NPM_PROVENANCE_PREDICATE_TYPE|NPM_ATTESTATIONS|resolvedDependencies|base64 --decode/,
    );
    expect(text, `${runbook} must not treat checkout or branch HEAD as release authority`).not.toContain(
      "SOURCE_HEAD=",
    );
  });
});
