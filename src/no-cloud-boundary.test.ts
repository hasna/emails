import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { normalizeEmailsMode } from "./lib/mode.js";
import {
  ARTIFACT_SCOPE,
  boundaryPatternTable,
  SOURCE_SCOPE,
  sourceBoundaryFindings,
  sourceBoundaryPatterns,
} from "../scripts/no-cloud-scan-lib.mjs";

const root = join(import.meta.dir, "..");

// Every committed surface that can carry a hosted-control-plane marker. A root
// that is renamed, moved, or emptied must make this suite FAIL rather than
// silently scan nothing — see "resolves every configured root" below.
const roots = [
  ".github",
  "AGENTS.md",
  "CHANGELOG.md",
  "Dockerfile",
  "README.md",
  "bun.lock",
  "dashboard",
  "deploy",
  "docker",
  "docker-compose.yml",
  "docs",
  "hasna.contract.json",
  "package.json",
  "scripts",
  "src",
] as const;

const textExtensions = new Set([
  ".css",
  ".example",
  ".hcl",
  ".html",
  ".js",
  ".json",
  ".lock",
  ".md",
  ".mjs",
  ".sh",
  ".tf",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

// The ONLY files exempt from the source scan, and why. This test file is
// deliberately NOT exempt: the ban list now lives in scripts/no-cloud-scan-lib.mjs,
// so the guard is scanned by the guard. "keeps the exemption list minimal and
// live" fails if this map grows or goes stale.
const excluded = new Map([
  [
    "scripts/no-cloud-scan-lib.mjs",
    "single definition site of the ban list; it necessarily contains every pattern literal",
  ],
  [
    "src/no-cloud-artifact-scan.test.ts",
    "poisoned fixtures that prove the scanner detects markers inside packed bundle chunks",
  ],
]);

// The scan currently reads ~563 files. A floor far above the vacuous case (an
// unresolved root set reads 0 files and every assertion below holds trivially)
// turns "the roots stopped resolving" into a loud failure.
const MINIMUM_SCANNED_FILES = 400;

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return textExtensions.has(extname(path)) || path.endsWith("Dockerfile") ? [path] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => (entry === "node_modules" || entry === "dist" ? [] : files(join(path, entry))));
}

function filesForRoot(entry: string): string[] {
  return files(join(root, entry)).filter((path) => !excluded.has(relative(root, path)));
}

function scannedFiles(): string[] {
  return roots.flatMap((entry) => filesForRoot(entry));
}

function scannedPaths(): string[] {
  return scannedFiles().map((path) => relative(root, path));
}

describe("no hosted control plane", () => {
  it("resolves every configured root to at least one scanned file", () => {
    expect(roots.filter((entry) => !existsSync(join(root, entry)))).toEqual([]);
    expect(roots.filter((entry) => filesForRoot(entry).length === 0)).toEqual([]);
  });

  it("scans a non-vacuous number of files", () => {
    const scanned = new Set(scannedPaths());
    expect(scanned.size).toBeGreaterThan(MINIMUM_SCANNED_FILES);
    // Spot-check the roots and extensions most likely to be lost to a filter regression.
    const markers = [
      "src/lib/mode.ts",
      "deploy/aws/compute.tf",
      "deploy/aws/examples/backend.hcl.example",
      "docker/postgres-init/001-runtime-role.sh",
      "scripts/no-cloud-artifact-scan.mjs",
      "bun.lock",
      "CHANGELOG.md",
    ];
    expect(markers.filter((marker) => !scanned.has(marker))).toEqual([]);
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
    // Anything not enforced on both surfaces must carry a written exemption reason.
    const oneSided = boundaryPatternTable
      .filter((entry) => entry.scopes.length !== 2)
      .map((entry) => ({
        label: entry.label,
        scopes: entry.scopes,
        exempted: Object.keys(entry.exemptions ?? {}).sort(),
      }));
    expect(oneSided).toEqual([
      { label: "legacy hosted environment", scopes: [ARTIFACT_SCOPE], exempted: [SOURCE_SCOPE] },
      { label: "hosted implementation vocabulary", scopes: [ARTIFACT_SCOPE], exempted: [SOURCE_SCOPE] },
    ]);
    expect(sourceBoundaryPatterns.length).toBe(boundaryPatternTable.length - oneSided.length);
    // Nothing is source-only: every source pattern is also enforced on the artifact.
    for (const entry of boundaryPatternTable) expect(entry.scopes).toContain(ARTIFACT_SCOPE);
  });

  it("enforces the full source ban list", () => {
    // Guard the guard: an accidental deletion from the shared table must fail here
    // instead of quietly making the scan below weaker.
    expect(sourceBoundaryPatterns.map((entry) => entry.label).sort()).toEqual([
      "cloud ai provider client",
      "hosted billing route",
      "hosted camel-case identifier",
      "hosted data field",
      "hosted endpoint",
      "hosted package",
      "hosted triage surface",
      "private deployment marker",
      "removed mode in configuration",
      "retired inbound bucket prefix",
      "typo-squat package name",
    ]);
  });

  it("contains no banned hosted-control-plane marker in any scanned file", () => {
    const findings = scannedFiles()
      .flatMap((path) => {
        const rel = relative(root, path);
        return sourceBoundaryFindings(readFileSync(path, "utf8"), rel).map((label) => `${rel}: ${label}`);
      })
      .sort();
    expect(findings).toEqual([]);
  });

  it("uses the canonical public package name and documents the remote-bind guard", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("EMAILS_ALLOW_REMOTE=1");
    expect(readme).toContain("@hasna/emails");
    // The typo-squat variants are banned tree-wide by the shared list above, which
    // now also covers bun.lock — the lockfile is a scanned root.
    expect(pkg.name).toBe("@hasna/emails");
  });

  it("ships exactly local and self_hosted without hosted aliases", () => {
    expect(normalizeEmailsMode("local")).toBe("local");
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow();
    }
  });

  it("has no SaaS client, command, export, package bin, or fleet env loader", () => {
    expect(existsSync(join(root, "src/cli/commands/cloud.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/mailery-cloud-client.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/load-cloud-env.ts"))).toBe(false);
    expect(existsSync(join(root, "src/cli/commands/triage.ts"))).toBe(false);
    expect(existsSync(join(root, "src/mcp/tools/triage.ts"))).toBe(false);
    expect((pkg.exports as Record<string, unknown>)["./cloud"]).toBeUndefined();
    expect(Object.keys(pkg.bin)).toEqual(["emails", "emails-mcp", "emails-serve"]);
    // The `mailery*` bins belong to the separate cloud CLI and must stay free here.
    expect(Object.keys(pkg.bin).some((name) => name.toLowerCase().includes("mailery"))).toBe(false);
  });
});
