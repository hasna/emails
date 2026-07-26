import { describe, expect, it } from "bun:test";
import {
  boundaryPatternTable,
  hostedControlPlaneFindings,
  isSkippableBinary,
  isSourceAllowed,
  requiredPackedEntries,
  sourceBoundaryFindings,
} from "../scripts/no-cloud-scan-lib.mjs";

// A positive control for EVERY label in the shared table. Pinning label NAMES and
// scopes cannot catch a weakened REGEX: before these existed, editing
// `/@hasna\/cloud\b/` to `/@hasna\/cloudXX\b/` reopened the dependency hole with the
// whole suite green. Each fixture must be minimal and must not be neutralised by
// stripExactCompatibilityBridges (so no LEGACY_HOSTED_ENV_KEYS block, no paired
// migration ids). This file is exempt from the source scan precisely so it can hold
// these literals.
const positiveFixtures: Record<string, string> = {
  "hosted package": 'import { push } from "@hasna/cloud";',
  "typo-squat package name": '"@hasnaxyz/emails": "1.0.0"',
  "hosted endpoint": 'fetch("https://api.mailery.co/health")',
  "hosted billing route": 'router.post("/v1/billing", handler)',
  "hosted data field": "const row = { credit_balance: 0 };",
  "hosted triage surface": 'router.post("/api/triage", handler)',
  "removed mode in configuration": "EMAILS_MODE=cloud",
  "cloud ai provider client": 'import { groq } from "@ai-sdk/groq";',
  "private deployment marker": "arn:aws:iam::789877399345:role/deploy",
  "retired inbound bucket prefix": 'const bucket = "hasna-emails-prod-inbound-1";',
  "hosted camel-case identifier": "const client = new CloudProviderClient();",
  "legacy hosted environment": 'const url = process.env["MAILERY_CLOUD_API_URL"];',
  "hosted implementation vocabulary": "// tracked per saas tenant",
};

describe("shared boundary pattern table", () => {
  it("has a positive control for every label, on both surfaces", () => {
    expect(Object.keys(positiveFixtures).sort()).toEqual(boundaryPatternTable.map((entry) => entry.label).sort());
    for (const entry of boundaryPatternTable) {
      const fixture = positiveFixtures[entry.label] as string;
      expect(hostedControlPlaneFindings(fixture, "dist/chunk-fixture.js")).toContain(entry.label);
      // Same fixture through the source engine. `src/fixture.ts` is not on any
      // `sourceAllowlist`, so a per-file allowance cannot mask a broken pattern.
      expect(sourceBoundaryFindings(fixture, "src/fixture.ts")).toContain(entry.label);
    }
  });

  it("applies a source allowance only inside its declared paths, and never to the artifact", () => {
    const allowed = boundaryPatternTable.filter((entry) => entry.sourceAllowance !== undefined);
    expect(allowed.length).toBeGreaterThan(0);
    for (const entry of allowed) {
      const fixture = positiveFixtures[entry.label] as string;
      // Inside the allowance: source is silent, the packed artifact never is.
      const inside = entry.label === "legacy hosted environment" ? "src/lib/whatever.test.ts" : "CHANGELOG.md";
      expect(isSourceAllowed(entry, inside)).toBe(true);
      expect(sourceBoundaryFindings(fixture, inside)).not.toContain(entry.label);
      expect(hostedControlPlaneFindings(fixture, inside)).toContain(entry.label);
      // Outside it — i.e. product code — source still fires.
      for (const outside of ["src/lib/hosted.ts", "src/server/index.ts", "Dockerfile"]) {
        expect(isSourceAllowed(entry, outside)).toBe(false);
        expect(sourceBoundaryFindings(fixture, outside)).toContain(entry.label);
      }
    }
    // Patterns with no allowance fire everywhere on both surfaces.
    for (const entry of boundaryPatternTable.filter((candidate) => candidate.sourceAllowance === undefined)) {
      const fixture = positiveFixtures[entry.label] as string;
      expect(sourceBoundaryFindings(fixture, "src/lib/anything.test.ts")).toContain(entry.label);
      expect(sourceBoundaryFindings(fixture, "CHANGELOG.md")).toContain(entry.label);
    }
  });
});

describe("packed artifact preconditions", () => {
  it("derives every manifest path, through globs, negations and nested conditions", () => {
    expect(requiredPackedEntries({ files: ["dist", "LICENSE"], bin: { a: "dist/a.js" } })).toEqual([
      "LICENSE",
      "dist",
      "dist/a.js",
    ]);
    // A glob must contribute its static prefix, not nothing.
    expect(requiredPackedEntries({ files: ["dist/**/*.js"] })).toEqual(["dist"]);
    // npm negations are exclusions, not required paths.
    expect(requiredPackedEntries({ files: ["dist", "!dist/internal.js"] })).toEqual(["dist"]);
    // Export conditions nest arbitrarily deep.
    expect(requiredPackedEntries({ exports: { ".": { node: { types: "./dist/i.d.ts", import: "./dist/i.js" } } } })).toEqual([
      "dist/i.d.ts",
      "dist/i.js",
    ]);
    // A manifest that promises nothing must derive nothing, so the caller's
    // "no dist payload" check fires instead of certifying an arbitrary tarball.
    expect(requiredPackedEntries({})).toEqual([]);
    expect(requiredPackedEntries({ files: ["*"] })).toEqual([]);
  });

  it("skips a file only when its extension AND its bytes are binary", () => {
    expect(isSkippableBinary("dist/g.wasm", Buffer.from([0, 0x61, 0x73, 0x6d]))).toBe(true);
    // A plaintext payload hiding behind a binary extension is still scanned.
    expect(isSkippableBinary("dist/hosted.br", Buffer.from('fetch("https://api.mailery.co")'))).toBe(false);
    // A bundle chunk with a stray NUL is still scanned — skipping on content alone
    // let one NUL byte hide every marker in a file.
    expect(isSkippableBinary("dist/chunk.js", Buffer.from([0x61, 0, 0x62]))).toBe(false);
  });
});

describe("packed hosted-control-plane scanner", () => {
  it("allows only the exact legacy rejection list", () => {
    const compatibility = `const LEGACY_HOSTED_ENV_KEYS = [\n  "MAILERY_CLOUD_API_URL",\n  "MAILERY_CLOUD_TOKEN"\n];`;
    expect(hostedControlPlaneFindings(compatibility, "dist/chunk-mode.js")).toEqual([]);
  });

  it("detects uppercase sentinels in active code even in a mode bundle chunk", () => {
    const poisoned = `const LEGACY_HOSTED_ENV_KEYS = ["MAILERY_CLOUD_API_URL"];\nconst endpoint = process.env["MAILERY_CLOUD_API_URL"];`;
    expect(hostedControlPlaneFindings(poisoned, "dist/chunk-mode.js")).toContain("legacy hosted environment");
  });

  it("detects hosted markers in arbitrary split chunks", () => {
    expect(hostedControlPlaneFindings("const x = 'CLOUD_SESSION_TOKEN'", "dist/chunk-ABC.js")).not.toEqual([]);
    expect(hostedControlPlaneFindings("fetch('https://api.mailery.co')", "dist/chunk-XYZ.js")).not.toEqual([]);
    expect(hostedControlPlaneFindings("hasna-emails-prod-inbound-123456789012", "dist/chunk-BUCKET.js"))
      .toContain("retired inbound bucket prefix");
    expect(hostedControlPlaneFindings("resolveCloudflareAuth()", "dist/chunk-DNS.js"))
      .not.toContain("hosted camel-case identifier");
  });

  it("does not let migration ids exempt active identifiers in the same bundle chunk", () => {
    const poisoned = `
      const released = "0005_mailery_selfhosted_resources";
      const bridge = "0006_emails_rename_bridge";
      CREATE TABLE IF NOT EXISTS cloud_providers;
      const cloud_providers = fetchCloudProviders();
    `;
    const findings = hostedControlPlaneFindings(poisoned, "dist/chunk-migrations.js");
    expect(findings).toContain("hosted implementation vocabulary");
    expect(findings).toContain("hosted camel-case identifier");
  });
});
