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
    // Only these two patterns may exempt any source path at all.
    expect(allowed.map((entry) => entry.label)).toEqual([
      "legacy hosted environment",
      "hosted implementation vocabulary",
    ]);
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

    const exactBridge = [
      "env \\",
      "  -u MAILERY_CLOUD_API_URL \\",
      "  -u HASNA_MAILERY_API_URL \\",
      "  true",
    ].join("\n");
    for (const path of [".github/workflows/ci.yml", "scripts/run-hermetic-tests.sh"]) {
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
    expect(sourceBoundaryFindings(exactBridge, "scripts/arbitrary.sh")).toEqual([
      "legacy hosted environment",
      "hosted implementation vocabulary",
    ]);
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
