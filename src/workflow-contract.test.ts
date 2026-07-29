import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = join(import.meta.dir, "..", ".github", "workflows");
const repositoryRoot = join(import.meta.dir, "..");
const packageProvenanceWorkflowSha256 = "706c636d7b60059f6e8ce52229bfb723c0c9a2c61cb4a462b3d6ead24a46232f";
const unreleasedSectionSha256 = "0bbd40d1dd790d42e965f2ce4dc632d9b1905ce83c971928bdba8e11b3ec751f";
const release132Section = `## 1.3.2 (2026-07-26)

- fail closed on malformed JSON, wrong response envelopes, and missing required
  fields from successful self-hosted API responses before repositories, mailbox
  status/context/sync projections, or the generated SDK can synthesize empty
  rows, lists, or counts.
- share one config-driven wire validator across the synchronous resource store,
  asynchronous inbox data source, and generated \`@hasna/emails/selfhost\` client;
  validation errors identify the endpoint and invalid field without including
  credentials or response-body contents.`;

function readWorkflow(name: string): string {
  return readFileSync(join(workflowDir, name), "utf8");
}

function textSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isCanonicalPackageProvenanceWorkflow(workflow: string): boolean {
  return textSha256(workflow) === packageProvenanceWorkflowSha256;
}

function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) return "";
  const nextHeading = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, nextHeading < 0 ? markdown.length : nextHeading).trimEnd();
}

function hasCanonicalRelease132Boundary(changelog: string): boolean {
  const unreleasedHeading = "## [Unreleased]";
  const release132Heading = "## 1.3.2 (2026-07-26)";
  const release131Heading = "## 1.3.1 (2026-07-26)";
  const unreleasedIndex = changelog.indexOf(`${unreleasedHeading}\n`);
  const release132Index = changelog.indexOf(`${release132Heading}\n`);
  const release131Index = changelog.indexOf(`${release131Heading}\n`);

  return (
    unreleasedIndex >= 0 &&
    release132Index > unreleasedIndex &&
    release131Index > release132Index &&
    changelog.match(/^## \[Unreleased\]$/gm)?.length === 1 &&
    changelog.match(/^## 1\.3\.2 \(2026-07-26\)$/gm)?.length === 1 &&
    textSha256(markdownSection(changelog, unreleasedHeading)) === unreleasedSectionSha256 &&
    markdownSection(changelog, release132Heading) === release132Section
  );
}

function singleQuotedReadonly(workflow: string, name: string): string {
  const matches = [...workflow.matchAll(new RegExp(`readonly ${name}='([^']*)'`, "g"))];
  expect(matches, `${name} must be declared exactly once`).toHaveLength(1);
  return matches[0]?.[1] ?? "";
}

describe("repository workflow safety", () => {
  it("allows only product CI, credential-free Terraform validation, and package provenance", () => {
    const files = existsSync(workflowDir)
      ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort()
      : [];
    expect(files).toEqual(["ci.yml", "package-provenance.yml", "terraform-aws-validate.yml"]);

    const validationText = ["ci.yml", "terraform-aws-validate.yml"].map(readWorkflow).join("\n");
    expect(validationText).not.toMatch(
      /configure-aws-credentials|aws-actions\/amazon-ecr|amazon-ecr-login|ecs update-service|aws configure|role-to-assume|id-token:\s*write/i,
    );
    expect(validationText).not.toMatch(/^\s*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*:/m);
    expect(validationText).not.toMatch(/\b(?:terraform|tofu)\s+(?:apply|destroy)\b/i);
    expect(validationText).not.toMatch(/\b(?:npm|bun|pnpm|yarn)\s+publish\b/i);
  });

  it("keeps both product CI jobs on the reviewed Bun toolchain", () => {
    const ci = readWorkflow("ci.yml");
    expect(ci.match(/bun-version:\s*1\.3\.14/g)).toHaveLength(2);
    expect(ci).not.toContain("bun-version: 1.3.13");
    expect(ci).toContain("PATH=/usr/bin:/bin ./deploy/aws/tests/static_contract.sh");
  });

  it("scans the locally patched Bun base without weakening either vulnerability gate", () => {
    const ci = readWorkflow("ci.yml");
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

    const workflow = readWorkflow("package-provenance.yml");
    expect(textSha256(workflow)).toBe(packageProvenanceWorkflowSha256);
    const tarballUrl = "https://registry.npmjs.org/@hasna/emails/-/emails-1.3.2.tgz";
    const sourceRepository = "https://github.com/hasna/emails";
    const sourceMergeCommit = "fe61a466a28115f33efda1ecc7632dbc7c6525c7";
    const reviewedHeadCommit = "4330ff214f53a41de681d595d188861bb3d36e13";
    const ciRunId = "30212897836";
    const ciRunUrl = `https://github.com/hasna/emails/actions/runs/${ciRunId}`;
    const sha256 = "8f5e166e73ae7aebeb49a5eeae6dd199d0be63a9931a35981373e67b9ccfe431";
    const npmShasum = "87c933255f5e95e7db8bf30bb606e07c1132f01e";
    const npmIntegrity =
      "sha512-nGwS4AoZH2NwTV8Xoop2XupAubyq4bHuawYZX5itCjVwa/3U4hE6t+tBdnKZ9p72/BuUxmAL4iLEZ79eWlkCHg==";
    const predicateType = "https://github.com/hasna/emails/attestations/npm-release-evidence/v1";
    const attestAction = "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6";

    const triggerStart = workflow.indexOf('"on":');
    const jobsStart = workflow.indexOf("jobs:");
    expect(triggerStart).toBeGreaterThanOrEqual(0);
    expect(jobsStart).toBeGreaterThan(triggerStart);
    expect(workflow.slice(triggerStart, jobsStart)).toBe('"on":\n  workflow_dispatch:\n\n');
    expect(workflow).not.toMatch(/^\s+inputs\s*:/m);

    const jobIds = [...workflow.slice(jobsStart + "jobs:\n".length).matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map(
      (match) => match[1],
    );
    expect(jobIds).toEqual(["attest-published-package"]);
    expect(workflow.match(/if: github\.repository == 'hasna\/emails' && github\.ref == 'refs\/heads\/main'/g))
      .toHaveLength(1);
    expect(workflow).toContain("    runs-on: ubuntu-24.04");
    expect(workflow).toContain("    timeout-minutes: 10");

    const permissions = workflow.match(/^    permissions:\n((?:^      [a-z-]+: [a-z]+\n)+)/m)?.[1] ?? "";
    expect(workflow.match(/^    permissions:/gm)).toHaveLength(1);
    expect(permissions.trim().split("\n").map((line) => line.trim())).toEqual([
      "actions: read",
      "contents: read",
      "id-token: write",
      "attestations: write",
    ]);

    expect([...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1])).toEqual([
      "Verify source and CI evidence",
      "Download and verify published tarball",
      "Create release evidence predicate",
      "Attest downloaded npm tarball",
    ]);
    const uses = [...workflow.matchAll(/^\s+uses:\s*(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
    expect(uses).toEqual([attestAction]);
    expect(workflow).not.toMatch(/actions\/checkout|secrets(?:\.|\[)/i);
    expect([...workflow.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1])).toEqual([
      "github.token",
    ]);
    expect(workflow.match(/^\s+GH_TOKEN:\s+\$\{\{ github\.token \}\}$/gm)).toHaveLength(1);

    expect(singleQuotedReadonly(workflow, "repository")).toBe("hasna/emails");
    expect(singleQuotedReadonly(workflow, "source_merge_commit")).toBe(sourceMergeCommit);
    expect(singleQuotedReadonly(workflow, "ci_run_id")).toBe(ciRunId);
    expect(workflow.match(/^\s+gh api\s*\\$/gm)).toHaveLength(2);
    expect(workflow.match(/^\s+jq --exit-status/gm)).toHaveLength(3);
    for (const liveVerificationContract of [
      "command -v gh >/dev/null",
      "command -v jq >/dev/null",
      'verification_dir="$(mktemp -d)"',
      "readonly verification_dir",
      "trap cleanup_verification EXIT",
      '"/repos/${repository}/commits/${source_merge_commit}"',
      '"/repos/${repository}/actions/runs/${ci_run_id}"',
      ".sha == $source_merge_commit",
      ".id == $ci_run_id",
      ".repository.full_name == $repository",
      ".head_repository.full_name == $repository",
      ".head_sha == $source_merge_commit",
      '.status == "completed"',
      '.conclusion == "success"',
      '.event == "push"',
      '.head_branch == "main"',
      '.path == ".github/workflows/ci.yml"',
    ]) {
      expect(workflow, `live source/CI verification is missing ${liveVerificationContract}`).toContain(
        liveVerificationContract,
      );
    }
    expect(workflow).not.toContain('readonly verification_dir="$(mktemp -d)"');

    expect(singleQuotedReadonly(workflow, "artifact_dir")).toBe("attestation-input");
    expect(singleQuotedReadonly(workflow, "tarball_url")).toBe(tarballUrl);
    expect(singleQuotedReadonly(workflow, "expected_sha256")).toBe(sha256);
    expect(singleQuotedReadonly(workflow, "expected_shasum")).toBe(npmShasum);
    expect(singleQuotedReadonly(workflow, "expected_integrity")).toBe(npmIntegrity);
    expect(singleQuotedReadonly(workflow, "predicate")).toBe("attestation-input/npm-release-evidence.json");

    const predicateMatch = workflow.match(/cat >"\$predicate" <<'JSON'\n([\s\S]*?)\n          JSON/);
    expect(predicateMatch, "the custom predicate heredoc must exist").not.toBeNull();
    const predicateJson = (predicateMatch?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^          /, ""))
      .join("\n");
    expect(JSON.parse(predicateJson)).toEqual({
      schemaVersion: 1,
      kind: "npm-release-evidence",
      package: {
        ecosystem: "npm",
        name: "@hasna/emails",
        version: "1.3.2",
        tarballUrl,
        sha256,
        npmShasum,
        npmIntegrity,
      },
      sourceEvidence: {
        repository: sourceRepository,
        sourceMergeCommit,
        reviewedHeadCommit,
      },
      mainCiEvidence: {
        runId: ciRunId,
        url: ciRunUrl,
        workflow: ".github/workflows/ci.yml",
        event: "push",
        branch: "main",
        headSha: sourceMergeCommit,
        conclusion: "success",
      },
      attestationScope: {
        evidenceType: "post-publication-association",
        subjectOrigin: "downloaded-from-npm-registry",
        subjectBuiltByThisWorkflow: false,
        subjectPublishedByThisWorkflow: false,
        statement:
          "This workflow downloaded and digest-verified the npm tarball bytes, then attested the recorded release evidence. It did not build or publish the package.",
      },
    });

    const requiredPredicateChecks = [
      '.schemaVersion == 1',
      '.kind == "npm-release-evidence"',
      '.package.name == "@hasna/emails"',
      '.package.version == "1.3.2"',
      `.package.tarballUrl == "${tarballUrl}"`,
      `.package.sha256 == "${sha256}"`,
      `.package.npmShasum == "${npmShasum}"`,
      `.package.npmIntegrity == "${npmIntegrity}"`,
      `.sourceEvidence.repository == "${sourceRepository}"`,
      `.sourceEvidence.sourceMergeCommit == "${sourceMergeCommit}"`,
      `.sourceEvidence.reviewedHeadCommit == "${reviewedHeadCommit}"`,
      `.mainCiEvidence.runId == "${ciRunId}"`,
      `.mainCiEvidence.url == "${ciRunUrl}"`,
      '.mainCiEvidence.workflow == ".github/workflows/ci.yml"',
      '.mainCiEvidence.event == "push"',
      '.mainCiEvidence.branch == "main"',
      `.mainCiEvidence.headSha == "${sourceMergeCommit}"`,
      '.mainCiEvidence.conclusion == "success"',
      '.attestationScope.evidenceType == "post-publication-association"',
      '.attestationScope.subjectOrigin == "downloaded-from-npm-registry"',
      '.attestationScope.subjectBuiltByThisWorkflow == false',
      '.attestationScope.subjectPublishedByThisWorkflow == false',
    ];
    for (const check of requiredPredicateChecks) expect(workflow).toContain(check);

    expect(workflow).toContain(`          subject-path: attestation-input/emails-1.3.2.tgz`);
    expect(workflow).toContain(`          predicate-type: ${predicateType}`);
    expect(workflow).toContain("          predicate-path: attestation-input/npm-release-evidence.json");
    expect(workflow).toContain("          push-to-registry: false");
    expect(workflow).toContain("          create-storage-record: false");
    expect(workflow).not.toMatch(/push-to-registry:\s*true|create-storage-record:\s*true/i);

    expect(workflow.match(/\bcurl\b/g)).toHaveLength(1);
    for (const marker of [
      "curl --disable",
      "--fail",
      "--silent",
      "--show-error",
      "--proto '=https'",
      "--proto-redir '=https'",
      "--tlsv1.2",
      "--connect-timeout 30",
      "--max-time 300",
      '--output "$artifact"',
      '"$tarball_url"',
    ]) {
      expect(workflow).toContain(marker);
    }
    expect([...new Set([...workflow.matchAll(/https:\/\/[^"'\s]+/g)].map((match) => match[0]))].sort()).toEqual(
      [ciRunUrl, predicateType, sourceRepository, tarballUrl].sort(),
    );
  });

  it("fails closed on every package provenance workflow change", () => {
    const workflow = readWorkflow("package-provenance.yml");
    expect(isCanonicalPackageProvenanceWorkflow(workflow)).toBe(true);

    const adversarialFixtures = [
      {
        name: "npx npm publish alias",
        workflow: workflow.replace(
          "          umask 077\n",
          '          umask 077\n          npx --yes npm@latest publish "$artifact"\n',
        ),
      },
      {
        name: "publish hidden behind a shell alias",
        workflow: workflow.replace(
          "          umask 077\n",
          "          umask 077\n          alias release='npm publish'\n          release\n",
        ),
      },
      {
        name: "deploy hidden behind a repository script",
        workflow: workflow.replace(
          "          set -euo pipefail\n\n          readonly predicate=",
          "          set -euo pipefail\n          bun run deploy\n\n          readonly predicate=",
        ),
      },
      {
        name: "added executable run step",
        workflow: workflow.replace(
          "      - name: Attest downloaded npm tarball\n",
          "      - name: Unexpected executable action\n        shell: bash\n        run: echo unexpected\n\n      - name: Attest downloaded npm tarball\n",
        ),
      },
      {
        name: "added executable uses step",
        workflow: workflow.replace(
          "      - name: Attest downloaded npm tarball\n",
          "      - name: Unexpected external action\n        uses: example/action@0123456789abcdef0123456789abcdef01234567\n\n      - name: Attest downloaded npm tarball\n",
        ),
      },
      {
        name: "trigger drift",
        workflow: workflow.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n"),
      },
      {
        name: "permission drift",
        workflow: workflow.replace("      contents: read\n", "      contents: write\n"),
      },
      {
        name: "action pin drift",
        workflow: workflow.replace(
          "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
          "actions/attest@0123456789abcdef0123456789abcdef01234567",
        ),
      },
      {
        name: "source commit existence check bypassed",
        workflow: workflow.replace("            '.sha == $source_merge_commit' \\\n", "            'true' \\\n"),
      },
      {
        name: "CI success check bypassed",
        workflow: workflow.replace(
          '              .status == "completed" and\n              .conclusion == "success" and\n',
          "              true and\n",
        ),
      },
      {
        name: "CI repository association check bypassed",
        workflow: workflow.replace(
          "              .repository.full_name == $repository and\n              .head_repository.full_name == $repository and\n",
          "              true and\n",
        ),
      },
      {
        name: "Actions read permission removed",
        workflow: workflow.replace("      actions: read\n", ""),
      },
      {
        name: "token source changed to secrets context",
        workflow: workflow.replace("${{ github.token }}", "${{ secrets.GITHUB_TOKEN }}"),
      },
      {
        name: "token-bearing shell tracing enabled",
        workflow: workflow.replace(
          "          set -euo pipefail\n          umask 077\n\n          readonly repository=",
          "          set -euxo pipefail\n          umask 077\n\n          readonly repository=",
        ),
      },
    ];

    for (const fixture of adversarialFixtures) {
      expect(fixture.workflow, `${fixture.name} fixture must change the workflow`).not.toBe(workflow);
      expect(isCanonicalPackageProvenanceWorkflow(fixture.workflow), fixture.name).toBe(false);
    }
  });

  it("keeps 1.3.2 at the exact changelog boundary with only its two release bullets", () => {
    const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8");
    expect(hasCanonicalRelease132Boundary(changelog)).toBe(true);

    const adversarialFixtures = [
      {
        name: "unreleased entry drifted under 1.3.2",
        changelog: changelog.replace(
          "## 1.3.2 (2026-07-26)\n\n",
          "## 1.3.2 (2026-07-26)\n\n- unrelated unreleased entry\n",
        ),
      },
      {
        name: "third release bullet added",
        changelog: changelog.replace(
          "  credentials or response-body contents.\n",
          "  credentials or response-body contents.\n- unrelated third release bullet.\n",
        ),
      },
      {
        name: "release boundary moved into Unreleased",
        changelog: changelog
          .replace(`${release132Section}\n\n`, "")
          .replace(
            "## [Unreleased]\n\n",
            `## [Unreleased]\n\n${release132Section}\n\n`,
          ),
      },
    ];

    for (const fixture of adversarialFixtures) {
      expect(fixture.changelog, `${fixture.name} fixture must change the changelog`).not.toBe(changelog);
      expect(hasCanonicalRelease132Boundary(fixture.changelog), fixture.name).toBe(false);
    }
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
      "NPM_PACKAGE",
      "NPM_REGISTRY",
      'test "$NPM_REGISTRY" = "https://registry.npmjs.org"',
      "HOSTED_CI_WORKFLOWS=(ci.yml terraform-aws-validate.yml)",
      'test "${#HOSTED_CI_WORKFLOWS[@]}" -eq 2',
      'test "${HOSTED_CI_WORKFLOWS[0]}" = "ci.yml"',
      'test "${HOSTED_CI_WORKFLOWS[1]}" = "terraform-aws-validate.yml"',
      'for HOSTED_CI_WORKFLOW in "${HOSTED_CI_WORKFLOWS[@]}"; do',
      'SOURCE_ORIGIN_URL="$(git -C "$SOURCE_CHECKOUT" remote get-url origin)"',
      '"https://github.com/hasna/emails.git"|"git@github.com:hasna/emails.git"',
      'git -C "$SOURCE_CHECKOUT" fetch --quiet --no-tags origin main',
      'git -C "$SOURCE_CHECKOUT" merge-base --is-ancestor "$RELEASE_COMMIT" "$ORIGIN_MAIN_COMMIT"',
      ".merge_commit_sha == $release_commit",
      'actions/workflows/$HOSTED_CI_WORKFLOW/runs?head_sha=$RELEASE_COMMIT',
      ".head_sha == $release_commit",
      '.head_branch == "main"',
      '.conclusion == "success"',
      "MATCHED_HOSTED_CI_RUN_JSON",
      ".updated_at",
      "LATEST_HOSTED_CI_UPDATED_EPOCH",
      'RELEASE_WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/emails-release-worktree.XXXXXXXX")"',
      'NPM_PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/emails-release-pack.XXXXXXXX")"',
      "cleanup_release_preflight()",
      'git -C "$SOURCE_CHECKOUT" worktree remove --force "$RELEASE_WORKTREE"',
      'rm -rf -- "$RELEASE_WORKTREE_PARENT"',
      'rm -rf -- "$NPM_PACK_DIR"',
      'git -C "$SOURCE_CHECKOUT" worktree add --detach "$RELEASE_WORKTREE" "$RELEASE_COMMIT"',
      'RELEASE_WORKTREE_COMMIT="$(git -C "$RELEASE_WORKTREE" rev-parse --verify \'HEAD^{commit}\')"',
      'test "$RELEASE_WORKTREE_COMMIT" = "$RELEASE_COMMIT"',
      'RELEASE_HOME="$RELEASE_WORKTREE_PARENT/home"',
      'RELEASE_XDG_CONFIG_HOME="$RELEASE_WORKTREE_PARENT/xdg-config"',
      'RELEASE_XDG_CACHE_HOME="$RELEASE_WORKTREE_PARENT/xdg-cache"',
      'mkdir -p -- "$RELEASE_HOME" "$RELEASE_XDG_CONFIG_HOME" "$RELEASE_XDG_CACHE_HOME"',
      'git -C "$RELEASE_WORKTREE" status --porcelain=v1 --untracked-files=all',
      'HOME="$RELEASE_HOME"',
      'XDG_CONFIG_HOME="$RELEASE_XDG_CONFIG_HOME"',
      'XDG_CACHE_HOME="$RELEASE_XDG_CACHE_HOME"',
      'bun install --frozen-lockfile --ignore-scripts',
      'test ! -e "$RELEASE_HOME/.hasna/emails"',
      'npm view "$NPM_PACKAGE@$RELEASE_VERSION" --json --registry "$NPM_REGISTRY"',
      "EXPECTED_NPM_TARBALL_URL",
      ".dist.integrity",
      'test("^sha512-[A-Za-z0-9+/]+={0,2}$")',
      ".dist.tarball == $tarball_url",
      'npm pack --json --pack-destination "$NPM_PACK_DIR" --registry "$NPM_REGISTRY" "$RELEASE_WORKTREE"',
      "NPM_PACK_OUTPUT_FILE",
      "NPM_PACK_JSON_START_LINE",
      'tail -n +"$NPM_PACK_JSON_START_LINE"',
      ".integrity == $registry_integrity",
      'test -f "$NPM_PACK_PATH"',
      'npm view "$NPM_PACKAGE" time --json --registry "$NPM_REGISTRY"',
      "NPM_PUBLISHED_AT",
      "NPM_PUBLISHED_EPOCH",
      'test "$NPM_PUBLISHED_EPOCH" -gt "$LATEST_HOSTED_CI_UPDATED_EPOCH"',
      "AWS deployment is prohibited",
      "Manual publishing and AWS deployment remain separate, manual, PR-first actions.",
    ]) {
      expect(preflight, `${runbook} release preflight is missing ${marker}`).toContain(marker);
    }

    expect(preflight).not.toMatch(
      /NPM_PROVENANCE_PREDICATE_TYPE|NPM_ATTESTATIONS|resolvedDependencies|base64 --decode|:\s*"\$\{HOSTED_CI_WORKFLOW:|\.gitHead|completed_at/,
    );
    expect(preflight.match(/--ignore-scripts/g)).toHaveLength(1);
    expect(preflight).not.toMatch(/npm pack[^\n]*--ignore-scripts|--ignore-scripts[^\n]*npm pack/);
    expect(preflight).not.toContain(
      'npm pack --json --pack-destination "$NPM_PACK_DIR" --registry "$NPM_REGISTRY" "$SOURCE_CHECKOUT"',
    );
    expect(
      preflight.match(
        /git -C "\$RELEASE_WORKTREE" status --porcelain=v1 --untracked-files=all/g,
      ),
    ).toHaveLength(3);
    for (const npmCommand of preflight.split("\n").filter((line) => /\bnpm (?:view|pack)\b/.test(line))) {
      expect(npmCommand).toContain('--registry "$NPM_REGISTRY"');
    }
    expect(text, `${runbook} must not treat checkout or branch HEAD as release authority`).not.toContain(
      "SOURCE_HEAD=",
    );
  });
});
