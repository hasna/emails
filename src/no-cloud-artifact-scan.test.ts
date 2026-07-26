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
  // Operator-neutrality rules. A SYNTHETIC account id is used on purpose: the
  // guard must not be the last place a real account id lives in a public repo.
  "vendor aws account id": "arn:aws:iam::314159265358:role/emails-task",
  "vendor hostname": 'var DEFAULT_AUTH_FROM = "noreply@hasna.invalid";',
  "vendor infrastructure name": "// verified in the alumia SES account",
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

  it("detects the vendor defaults that previously shipped in bundles and .d.ts JSDoc", () => {
    // The SHAPE of the literals the published 1.3.0 artifact carried, with a
    // synthetic hostname and account id: a guard must not be the last place a real
    // vendor identifier lives in a public repo. The allowlist default in particular
    // locked every third-party self-hoster out of their own deployment behind a
    // deliberately opaque 403.
    expect(hostedControlPlaneFindings('var DEFAULT_ALLOWED_DOMAINS = "hasna.*";', "dist/server/serve-abc.js"))
      .toContain("vendor hostname");
    expect(hostedControlPlaneFindings('var DEFAULT_AUTH_FROM = "noreply@hasna.invalid";', "dist/cli/serve-abc.js"))
      .toContain("vendor hostname");
    // `tsc --emitDeclarationOnly` PRESERVES JSDoc, so declarations leak comments
    // that Bun strips from the .js bundles.
    expect(hostedControlPlaneFindings(
      "/** From identity — a verified SES address (alumia account). */",
      "dist/server/self-hosted/auth/mailer.d.ts",
    )).toContain("vendor infrastructure name");
    expect(hostedControlPlaneFindings('const environment = "xyz-infra";', "dist/chunk-aws.js"))
      .toContain("vendor infrastructure name");
  });

  it("detects an account id in every form AWS actually writes one", () => {
    const account = "314159265358";
    for (const form of [
      `const account = "${account}";`,
      `arn:aws:sns:us-east-1:${account}:emails-inbound`,
      `emails-${account}-us-east-1-inbound`,
      `arn:aws:iam::${account}:role/emails-${account}-task`,
      `/ecs/emails-${account}/api`,
      `https://sqs.us-east-1.amazonaws.com/${account}/emails-inbound`,
    ]) {
      expect(hostedControlPlaneFindings(form, "dist/chunk-aws.js")).toContain("vendor aws account id");
    }
  });

  it("does not flag UUID fixtures, digests, documented placeholders, or npm authorship", () => {
    // `\b[0-9]{12}\b` would fail here: `-` is a word boundary, so the trailing UUID
    // node reads as a bare 12-digit run. A shape-level redaction pass is what makes
    // the plain digit bounds safe.
    for (const benign of [
      '"00000000-0000-0000-0000-000000000001"',
      '"99999999-9999-9999-9999-999999999999"',
      '"rm000000-1111-2222-3333-444444444444"',
      '"5c0ped00-1111-4111-8111-111100000000"',
      '"sha256:aaaaaaaaaaaa123456789019bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
      '"1234567890123"',
    ]) {
      expect(hostedControlPlaneFindings(`const id = ${benign};`, "dist/chunk.js")).toEqual([]);
    }
    // AWS's own documentation placeholders and the suite's negative fixture.
    expect(hostedControlPlaneFindings(
      'const ids = ["111122223333", "123456789012", "999999999999"];',
      "dist/chunk.js",
    )).toEqual([]);
    // `hasna.<namespace>` identifiers are not hostnames.
    for (const namespace of [
      'const source = "hasna.events";',
      '{"schema": "hasna.service_contract.v1"}',
      'const bundleId = "com.hasna.emails";',
    ]) {
      expect(hostedControlPlaneFindings(namespace, "dist/cli/ui-runtime-bundle.js")).toEqual([]);
    }
    // The npm `author` field is authorship metadata, exempt in package.json and in
    // the copy Bun inlines into bundles that import it for `version`.
    expect(hostedControlPlaneFindings('{"author": "A Maintainer <m@hasna.invalid>"}', "package.json")).toEqual([]);
    expect(hostedControlPlaneFindings('author: "A Maintainer <m@hasna.invalid>",', "dist/server/index.js")).toEqual([]);
    // A key that merely ends in "author" is NOT the npm author field.
    expect(hostedControlPlaneFindings('{"coauthor": "ops@hasna.invalid"}', "dist/chunk.js"))
      .toContain("vendor hostname");
    // The redaction must not swallow content past the field it exempts.
    expect(hostedControlPlaneFindings('{"author": "ok", "from": "ops@hasna.invalid"}', "package.json"))
      .toContain("vendor hostname");
  });

  // ── source surface ──────────────────────────────────────────────────────────
  // The neutrality rules are enforced on the committed tree as well, and the
  // source scan is the surface with real files behind it (`deploy/**`, `.tf`,
  // `.hcl`, `.sh`). Its own assertion is `findings == []`, which stays green over a
  // neutered regex, so the controls below are what actually pin these three rules
  // on that surface. They live in this file because it is one of only two the
  // source scan exempts, so it is the only place these literals may appear.

  it("detects an account id on the source surface, in every form AWS writes one", () => {
    const account = "314159265358";
    for (const form of [
      `account_id = "${account}"`, // Terraform, which is where this leaks
      `arn:aws:sns:us-east-1:${account}:emails-inbound`,
      `emails-${account}-us-east-1-inbound`, // the module's own bucket naming
      `arn:aws:iam::${account}:role/emails-${account}-task`,
      `/ecs/emails-${account}/api`,
    ]) {
      expect(sourceBoundaryFindings(form, "deploy/aws/compute.tf")).toContain("vendor aws account id");
    }
    // Documented placeholders and the suite's negative fixture: allowed BY VALUE,
    // so a real account id can never hide behind a file-level exemption.
    for (const allowed of ["111122223333", "123456789012", "999999999999"]) {
      expect(sourceBoundaryFindings(`account_id = "${allowed}"`, "deploy/aws/compute.tf")).toEqual([]);
    }
    // UUIDs and digests must not trip it. `\b[0-9]{12}\b` would, because `-` is a
    // word boundary; the redaction pass is what makes plain digit bounds safe.
    for (const benign of [
      "00000000-0000-0000-0000-000000000001",
      "99999999-9999-9999-9999-999999999998",
      "rm000000-1111-2222-3333-444444444444", // real fixture shape: non-hex chars
      "5c0ped00-1111-4111-8111-111100000000",
      "registry.example/emails@sha256:aaaaaaaaaaaa123456789012bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "1234567890123", // 13 digits: a millisecond timestamp, not an account id
      "0100019xxxxxxxxx",
      "Bad &#999999999999; entity",
    ]) {
      expect(sourceBoundaryFindings(`const id = "${benign}";`, "src/lib/ids.ts")).toEqual([]);
    }
  });

  it("detects any bare vendor hostname on the source surface, sparing namespace ids", () => {
    // The URL-only `hosted endpoint` rule missed these shapes, which is exactly how
    // a vendor From-identity default and a vendor signup-allowlist default shipped.
    for (const leak of ["noreply@hasna.invalid", "hasna.*", "mail.hasna.example", "HASNA.INVALID"]) {
      expect(sourceBoundaryFindings(`const value = "${leak}";`, "src/server/self-hosted/auth/allowed-email.ts"))
        .toContain("vendor hostname");
    }
    // Not hostnames: the service-contract names, the macOS bundle id, the
    // `@hasna/events` source id, and the local state directory.
    for (const benign of [
      "hasna.contract.json",
      "hasna.service_contract.v1",
      "com.hasna.emails",
      '{ source: input.source ?? "hasna.events" }',
      "~/.hasna/emails",
    ]) {
      expect(sourceBoundaryFindings(benign, "src/lib/paths.ts")).toEqual([]);
    }
  });

  it("detects a private account or environment name on the source surface", () => {
    for (const leak of ["the alumia SES account", "hasna-studio-alumia", "ALUMIA", 'environment = "xyz-infra"']) {
      expect(sourceBoundaryFindings(leak, "deploy/aws/variables.tf")).toContain("vendor infrastructure name");
    }
    // Word-bounded, so unrelated substrings do not trip it.
    for (const benign of ["alumian", "prealumia", "xyz-infrastructure-team"]) {
      expect(sourceBoundaryFindings(benign, "deploy/aws/variables.tf")).toEqual([]);
    }
  });

  it("exempts only the npm author field on the source surface", () => {
    expect(sourceBoundaryFindings('"author": "A Maintainer <maintainer@hasna.invalid>"', "package.json")).toEqual([]);
    // A different key that merely ends in "author" stays in scope.
    expect(sourceBoundaryFindings('"coauthor": "ops@hasna.invalid"', "package.json")).toContain("vendor hostname");
    // The redaction must not swallow content past the field it exempts.
    expect(sourceBoundaryFindings('{"author": "ok", "from": "ops@hasna.invalid"}', "package.json"))
      .toContain("vendor hostname");
  });
});
