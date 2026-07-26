import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { normalizeEmailsMode } from "./lib/mode.js";
import {
  BOUNDARY_SCOPES,
  boundaryPatternTable,
  isSkippableBinary,
  isSourceAllowed,
  sourceBoundaryFindings,
  sourceBoundaryPatterns,
} from "../scripts/no-cloud-scan-lib.mjs";

const root = join(import.meta.dir, "..");

// `git ls-files` IS the set of committed surfaces — the only set that can ship.
// A hand-maintained roots/extensions allowlist is what made this guard vacuous:
// four of its roots did not exist, and a new top-level file or a new extension was
// silently uncovered. Deriving the set means a rename, a new directory and a new
// file type are all covered with no edit here, and nothing can be quietly dropped.
function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter((path) => path.length > 0);
}

// The ONLY files exempt from the source scan, and why. This test file is
// deliberately NOT exempt: the ban list lives in scripts/no-cloud-scan-lib.mjs, so
// the guard is scanned by the guard. Per-pattern, per-file allowances live in that
// table as `sourceAllowlist` — a whole-file exemption here is the blunt instrument
// and "keeps the exemption list minimal and live" pins it to exactly these two.
const excluded = new Map([
  [
    "scripts/no-cloud-scan-lib.mjs",
    "single definition site of the ban list; it necessarily contains every pattern literal",
  ],
  [
    "src/no-cloud-artifact-scan.test.ts",
    "positive-detection fixtures that prove every pattern still fires, plus the bundle-chunk poison cases",
  ],
]);

// 571 files are tracked today. A floor far above the vacuous case (an unresolved
// file set is 0, and every assertion below holds trivially over it) makes "the scan
// stopped resolving files" a loud failure instead of a green run over nothing.
const MINIMUM_TRACKED_FILES = 400;

function scannedPaths(): string[] {
  return trackedFiles()
    .filter((path) => !excluded.has(path))
    .filter((path) => !isSkippableBinary(path, readFileSync(join(root, path))));
}

const legacyHostedEnvKeys = [
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
];

const exactCompatibilityBridges = new Map([
  [
    ".github/workflows/ci.yml",
    [
      "      - name: Test in isolated local mode",
      "        run: |",
      '          tmp_home="$(mktemp -d)"',
      "          trap 'rm -rf \"$tmp_home\"' EXIT",
      "          env -u MAILERY_MODE -u HASNA_MAILERY_MODE \\",
      "            -u MAILERY_STORAGE_MODE -u HASNA_MAILERY_STORAGE_MODE \\",
      "            -u EMAILS_STORAGE_MODE -u HASNA_EMAILS_STORAGE_MODE \\",
      "            -u MAILERY_API_URL -u MAILERY_API_KEY \\",
      "            -u HASNA_MAILERY_API_URL -u HASNA_MAILERY_API_KEY \\",
      "            -u MAILERY_CLOUD_API_URL -u MAILERY_CLOUD_TOKEN \\",
      "            -u HASNA_MAILERY_ENV_FILE -u HASNA_EMAILS_MODE \\",
      "            -u EMAILS_SELF_HOSTED_URL -u EMAILS_SELF_HOSTED_API_KEY \\",
      "            -u EMAILS_CLIENT_ENV_SECRET -u EMAILS_SESSION_TOKEN \\",
      "            -u DATABASE_URL -u EMAILS_DATABASE_URL -u EMAILS_TEST_DATABASE_URL \\",
      "            -u EMAILS_POSTGRES_URL -u EMAILS_TEST_POSTGRES_URL \\",
      "            -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY \\",
      "            -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID \\",
      "            -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \\",
      "            -u AWS_PROFILE -u AWS_DEFAULT_PROFILE -u AWS_ACCOUNT_ID \\",
      "            -u AWS_REGION -u AWS_DEFAULT_REGION -u AWS_SHARED_CREDENTIALS_FILE \\",
      "            -u AWS_CONFIG_FILE -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \\",
      "            -u AWS_ROLE_SESSION_NAME -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \\",
      "            -u AWS_CONTAINER_CREDENTIALS_FULL_URI -u AWS_CONTAINER_AUTHORIZATION_TOKEN \\",
      "            -u EMAILS_AWS_REGION -u EMAILS_SES_AWS_PROFILE \\",
      "            -u RESEND_API_KEY -u RESEND_WEBHOOK_SECRET \\",
      "            AWS_EC2_METADATA_DISABLED=true \\",
      '            HOME="$tmp_home" EMAILS_MODE=local EMAILS_DB_PATH=:memory: \\',
      "            bash -euo pipefail <<'BASH'",
    ].join("\n") + "\n",
  ],
  [
    "scripts/run-hermetic-tests.sh",
    [
      "run_scrubbed() {",
      '  local test_home="$1"',
      "  shift",
      "  env \\",
      "    -u MAILERY_MODE -u HASNA_MAILERY_MODE \\",
      "    -u MAILERY_STORAGE_MODE -u HASNA_MAILERY_STORAGE_MODE \\",
      "    -u EMAILS_STORAGE_MODE -u HASNA_EMAILS_STORAGE_MODE \\",
      "    -u MAILERY_API_URL -u MAILERY_API_KEY \\",
      "    -u HASNA_MAILERY_API_URL -u HASNA_MAILERY_API_KEY \\",
      "    -u MAILERY_CLOUD_API_URL -u MAILERY_CLOUD_TOKEN \\",
      "    -u HASNA_MAILERY_ENV_FILE -u HASNA_EMAILS_MODE \\",
      "    -u EMAILS_SELF_HOSTED_URL -u EMAILS_SELF_HOSTED_API_KEY \\",
      "    -u EMAILS_CLIENT_ENV_SECRET -u EMAILS_SESSION_TOKEN \\",
      "    -u DATABASE_URL -u EMAILS_DATABASE_URL -u EMAILS_TEST_DATABASE_URL \\",
      "    -u EMAILS_POSTGRES_URL -u EMAILS_TEST_POSTGRES_URL \\",
      "    -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY \\",
      "    -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID \\",
      "    -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \\",
      "    -u AWS_PROFILE -u AWS_DEFAULT_PROFILE -u AWS_ACCOUNT_ID \\",
      "    -u AWS_REGION -u AWS_DEFAULT_REGION -u AWS_SHARED_CREDENTIALS_FILE \\",
      "    -u AWS_CONFIG_FILE -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \\",
      "    -u AWS_ROLE_SESSION_NAME -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \\",
      "    -u AWS_CONTAINER_CREDENTIALS_FULL_URI -u AWS_CONTAINER_AUTHORIZATION_TOKEN \\",
      "    -u EMAILS_AWS_REGION -u EMAILS_SES_AWS_PROFILE \\",
      "    -u RESEND_API_KEY -u RESEND_WEBHOOK_SECRET \\",
      "    AWS_EC2_METADATA_DISABLED=true \\",
      "    NO_COLOR=1 \\",
      '    HOME="$test_home" \\',
      "    EMAILS_MODE=local \\",
      "    EMAILS_DB_PATH=:memory: \\",
      '    "$@"',
    ].join("\n") + "\n",
  ],
]);

function expectedLegacyFindings(key: string): string[] {
  return key.includes("CLOUD")
    ? ["legacy hosted environment", "hosted implementation vocabulary"]
    : ["legacy hosted environment"];
}

const hostedServiceModel = ["S", "aaS"].join("");
const hostedFleetTerm = ["fl", "eet"].join("");
const exactHistoricalChangelogBridge = [
  `- rebuild the product as local-first and operator-owned AWS self-hosting, with no Hasna ${hostedServiceModel} control plane.`,
  "- add durable idempotent self-hosted sends, authenticated attachment retrieval, mailbox mutations, signed replay-safe webhooks, and explicit compatibility for previously issued API keys.",
  "- harden deployment with separate migration/runtime database roles, readiness health checks, immutable container/action pins, and explicit local/self-hosted mode validation.",
].join("\n") + "\n";

describe("no hosted control plane", () => {
  it("scans every committed file, and a non-vacuous number of them", () => {
    const tracked = trackedFiles();
    const scanned = scannedPaths();
    expect(tracked.length).toBeGreaterThan(MINIMUM_TRACKED_FILES);
    // Nothing is dropped except the two declared exemptions: this repo commits no
    // binary payloads, so the binary skip must currently remove zero files.
    expect(tracked.length - scanned.length).toBe(excluded.size);
    // Every scanned path must resolve — a stale index would otherwise read nothing.
    expect(scanned.filter((path) => !existsSync(join(root, path)))).toEqual([]);
    // Every committed file TYPE must be represented, derived from the tree rather
    // than pinned to filenames, so a rename cannot shrink coverage and a legitimate
    // `compute.tf` -> `ecs.tf` refactor does not fail the boundary guard. A new file
    // type is covered automatically; a type disappearing entirely fails here.
    const kindOf = (path: string) => extname(path).toLowerCase() || "(extensionless)";
    const scannedKinds = new Set(scanned.map(kindOf));
    expect([...new Set(tracked.map(kindOf))].filter((kind) => !scannedKinds.has(kind))).toEqual([]);
    for (const kind of [".ts", ".tsx", ".tf", ".hcl", ".sh", ".mjs", ".md", ".yml", ".json", ".toml", ".lock", ".example", ".html", "(extensionless)"]) {
      expect(scannedKinds).toContain(kind);
    }
  });

  it("keeps the exemption list minimal and live", () => {
    expect([...excluded.keys()].sort()).toEqual([
      "scripts/no-cloud-scan-lib.mjs",
      "src/no-cloud-artifact-scan.test.ts",
    ]);
    for (const path of excluded.keys()) expect(existsSync(join(root, path))).toBe(true);
    // The guard must not be exempt from itself.
    expect(excluded.has("src/no-cloud-boundary.test.ts")).toBe(false);
    expect(new Set(scannedPaths()).has("src/no-cloud-boundary.test.ts")).toBe(true);
  });

  it("shares one ban list with the packed-artifact scanner", () => {
    // Both guards read scripts/no-cloud-scan-lib.mjs, so the lists cannot drift.
    // Every pattern is enforced on BOTH surfaces; nothing is exempted wholesale.
    expect(boundaryPatternTable.length).toBe(16);
    expect(sourceBoundaryPatterns.length).toBe(boundaryPatternTable.length);
    for (const entry of boundaryPatternTable) {
      // Order-independent, and correct if a third surface is ever added.
      expect(BOUNDARY_SCOPES.filter((scope: string) => !entry.scopes.includes(scope))).toEqual([]);
      expect(entry.exemptions ?? {}).toEqual({});
    }
    expect(sourceBoundaryPatterns.map((entry) => entry.label).sort()).toEqual([
      "cloud ai provider client",
      "hosted billing route",
      "hosted camel-case identifier",
      "hosted data field",
      "hosted endpoint",
      "hosted implementation vocabulary",
      "hosted package",
      "hosted triage surface",
      "legacy hosted environment",
      "private deployment marker",
      "removed mode in configuration",
      "retired inbound bucket prefix",
      "typo-squat package name",
      // Operator-neutrality rules. They are in the SHARED table on purpose: an
      // account id or an operator hostname leaks through Terraform, shell and
      // container config just as easily as through TypeScript, and the source scan
      // derives its file set from `git ls-files`, so `deploy/**`, `.tf`, `.hcl` and
      // `.sh` are all covered with no second roots list to keep in step.
      "vendor aws account id",
      "vendor hostname",
      "vendor infrastructure name",
    ]);
  });

  it("keeps every source allowance narrow, justified, and live", () => {
    const allowed = boundaryPatternTable.filter((entry) => entry.sourceAllowance !== undefined);
    // Only retired environment-name rejection fixtures may use a path allowance.
    // Hosted implementation vocabulary is normalized content-exactly instead.
    expect(allowed.map((entry) => entry.label)).toEqual(["legacy hosted environment"]);
    const scanned = scannedPaths();
    for (const entry of allowed) {
      expect((entry.sourceAllowance.reason as string).length).toBeGreaterThan(40);
      for (const matcher of entry.sourceAllowance.paths as RegExp[]) {
        // A DEAD matcher must fail: if nothing it covers actually trips the pattern
        // any more, the allowance has to go rather than pre-authorise a future leak.
        const covered = scanned.filter((path) => matcher.test(path));
        expect(covered.length).toBeGreaterThan(0);
        const tripping = covered.filter((path) => entry.pattern.test(readFileSync(join(root, path), "latin1")));
        expect(tripping.length).toBeGreaterThan(0);
      }
      // Product code is never allowed — the whole point of a path allowance is that
      // it does not cover the code that ships. (`isSourceAllowed` is also asserted
      // against these paths at import time.)
      for (const productPath of ["src/index.ts", "src/server/index.ts", "src/lib/mode.ts", "package.json", "Dockerfile"]) {
        expect(isSourceAllowed(entry, productPath)).toBe(false);
      }
    }
    // Allowances cover a small minority of the tree; everything else is enforced.
    const allowedCount = scanned.filter((path) => allowed.some((entry) => isSourceAllowed(entry, path))).length;
    expect(allowedCount * 2).toBeLessThan(scanned.length);

    for (const [path, exactBridge] of exactCompatibilityBridges) {
      expect(sourceBoundaryFindings(exactBridge, path)).toEqual([]);
      expect(sourceBoundaryFindings("echo MAILERY_CLOUD_API_URL", path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);
      expect(sourceBoundaryFindings("env MAILERY_CLOUD_API_URL=value true", path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);
      expect(sourceBoundaryFindings("printf '%s' 'env -u MAILERY_CLOUD_API_URL'", path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);
    }
  });

  it("allows only the location- and syntax-exact legacy env-unset bridges", () => {
    const arbitraryBridge = [
      "env \\",
      "  -u MAILERY_API_URL -u MAILERY_API_KEY \\",
      "  -u HASNA_MAILERY_API_URL -u HASNA_MAILERY_API_KEY \\",
      "  -u MAILERY_CLOUD_API_URL -u MAILERY_CLOUD_TOKEN \\",
      "  true",
    ].join("\n");

    for (const [path, exactBridge] of exactCompatibilityBridges) {
      expect(sourceBoundaryFindings(exactBridge, path)).toEqual([]);

      // Reviewer bypass 1: a second unrelated env command on an allowed path.
      expect(sourceBoundaryFindings(`${exactBridge}\n${arbitraryBridge}`, path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);
      expect(sourceBoundaryFindings(`${exactBridge}\n${exactBridge}`, path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);

      // Reviewer bypass 2: env options appearing after option parsing has ended.
      expect(sourceBoundaryFindings("env bash -c true -u MAILERY_CLOUD_API_URL ignored", path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);

      // The same command text is not a bridge at an arbitrary location.
      expect(sourceBoundaryFindings(arbitraryBridge, path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);

      // Reordering or injecting even a valid env option invalidates the bridge.
      const reordered = exactBridge.replace(
        /(\s+-u HASNA_MAILERY_API_URL -u HASNA_MAILERY_API_KEY \\\n)(\s+-u MAILERY_CLOUD_API_URL -u MAILERY_CLOUD_TOKEN \\\n)/,
        "$2$1",
      );
      expect(sourceBoundaryFindings(reordered, path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);
      const injected = exactBridge.replace(
        /(\s+-u MAILERY_CLOUD_API_URL -u MAILERY_CLOUD_TOKEN \\\n)/,
        "    -u UNRELATED_ENVIRONMENT_VARIABLE \\\n$1",
      );
      expect(sourceBoundaryFindings(injected, path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);
      const changedUtility =
        path === ".github/workflows/ci.yml"
          ? exactBridge.replace("            bash -euo pipefail <<'BASH'\n", "            bash -c true\n")
          : exactBridge.replace('    "$@"\n', "    bash -c true\n");
      expect(sourceBoundaryFindings(changedUtility, path)).toEqual([
        "legacy hosted environment",
        "hosted implementation vocabulary",
      ]);

      // Every retired key remains banned anywhere outside the one exact bridge.
      for (const key of legacyHostedEnvKeys) {
        expect(sourceBoundaryFindings(`${exactBridge}\necho ${key}`, path)).toEqual(expectedLegacyFindings(key));
      }
    }

    expect(sourceBoundaryFindings(exactCompatibilityBridges.get(".github/workflows/ci.yml")!, "scripts/arbitrary.sh")).toEqual([
      "legacy hosted environment",
      "hosted implementation vocabulary",
    ]);
  });

  it("allows hosted vocabulary only in the exact historical CHANGELOG retirement note", () => {
    const hostedVocabulary = boundaryPatternTable.find((entry) => entry.label === "hosted implementation vocabulary")!;
    expect(isSourceAllowed(hostedVocabulary, "CHANGELOG.md")).toBe(false);

    for (const path of [
      "CHANGELOG.md",
      "deploy/aws/README.md",
      "deploy/aws/backend.tf",
      "docs/design/multi-tenancy-auth.md",
    ]) {
      expect(sourceBoundaryFindings(readFileSync(join(root, path), "utf8"), path)).toEqual([]);
      expect(sourceBoundaryFindings(`- launch the ${hostedServiceModel} ${hostedFleetTerm} control plane.\n`, path)).toEqual([
        "hosted implementation vocabulary",
      ]);
    }
    expect(sourceBoundaryFindings(`const model = "${hostedServiceModel}";\n`, "src/arbitrary.test.ts")).toEqual([
      "hosted implementation vocabulary",
    ]);
    expect(sourceBoundaryFindings(exactHistoricalChangelogBridge, "CHANGELOG.md")).toEqual([]);

    // The historical sentence is allowed only with its exact neighboring release
    // notes; the same prose at an arbitrary location remains a finding.
    const historicalSentence =
      `- rebuild the product as local-first and operator-owned AWS self-hosting, with no Hasna ${hostedServiceModel} control plane.\n`;
    expect(sourceBoundaryFindings(historicalSentence, "CHANGELOG.md")).toEqual(["hosted implementation vocabulary"]);
    expect(sourceBoundaryFindings(exactHistoricalChangelogBridge, "HISTORY.md")).toEqual(["hosted implementation vocabulary"]);

    // A duplicate bridge or any new hosted vocabulary in CHANGELOG is rejected.
    expect(sourceBoundaryFindings(`${exactHistoricalChangelogBridge}\n${exactHistoricalChangelogBridge}`, "CHANGELOG.md")).toEqual([
      "hosted implementation vocabulary",
    ]);
    expect(
      sourceBoundaryFindings(
        `${exactHistoricalChangelogBridge}\n- launch the ${hostedServiceModel} ${hostedFleetTerm} control plane.\n`,
        "CHANGELOG.md",
      ),
    ).toEqual(["hosted implementation vocabulary"]);

    // Rewording the historical note into a current hosted claim invalidates the
    // bridge instead of inheriting an allowance from its neighbors.
    const poisonedHistory = exactHistoricalChangelogBridge.replace(
      `with no Hasna ${hostedServiceModel} control plane.`,
      `with a Hasna ${hostedServiceModel} control plane.`,
    );
    expect(sourceBoundaryFindings(poisonedHistory, "CHANGELOG.md")).toEqual(["hosted implementation vocabulary"]);

    // Historical release notes may still describe the separate hosted product in
    // ordinary language; only the active hosted-implementation tokens are guarded.
    const legitimateVersionedHistory =
      "## [0.6.117] - 2026-07-09\n" +
      "- chore: free the mailery bins for the separate cloud CLI; its cloud API-key app id is unchanged.\n";
    expect(sourceBoundaryFindings(legitimateVersionedHistory, "CHANGELOG.md")).toEqual([]);
  });

  it("contains no banned hosted-control-plane marker in any scanned file", () => {
    const findings = scannedPaths()
      .flatMap((path) => {
        const content = readFileSync(join(root, path), "latin1");
        return sourceBoundaryFindings(content, path).map((label) => `${path}: ${label}`);
      })
      .sort();
    expect(findings).toEqual([]);
  });

  it("uses the canonical public package name and documents the remote-bind guard", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("EMAILS_ALLOW_REMOTE=1");
    expect(readme).toContain("@hasna/emails");
    expect(pkg.name).toBe("@hasna/emails");
    // bun.lock carried a stale typo-squat workspace name for releases, invisible
    // because the lockfile was not scanned. `bun install`, `--force` and
    // `--frozen-lockfile` all leave that field alone, so nothing in the toolchain
    // catches the drift. Compare it to the manifest rather than to one spelling:
    // the `typo-squat package name` pattern only covers the spellings it enumerates.
    // (bun.lock is JSONC, so it is matched rather than JSON.parse'd.)
    const lock = readFileSync(join(root, "bun.lock"), "utf8");
    const lockName = /"workspaces"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/.exec(lock)?.[1];
    expect(lockName).toBe(pkg.name);
  });

  it("ships exactly local and self_hosted without hosted aliases", () => {
    expect(normalizeEmailsMode("local")).toBe("local");
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow();
    }
  });

  it("has no hosted client, command, export, package bin, or environment loader", () => {
    expect(existsSync(join(root, "src/cli/commands/cloud.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/mailery-cloud-client.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/load-cloud-env.ts"))).toBe(false);
    expect(existsSync(join(root, "src/cli/commands/triage.ts"))).toBe(false);
    expect(existsSync(join(root, "src/mcp/tools/triage.ts"))).toBe(false);
    expect((pkg.exports as Record<string, unknown>)["./cloud"]).toBeUndefined();
    expect(Object.keys(pkg.bin)).toEqual(["emails", "emails-mcp", "emails-serve"]);
    // The `mailery*` bins belong to the separate hosted CLI (@hasnatools/mailery)
    // and must stay free here.
    expect(Object.keys(pkg.bin).some((name) => name.toLowerCase().includes("mailery"))).toBe(false);
  });
});
