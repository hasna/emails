import { describe, expect, it } from "bun:test";
import { hostedControlPlaneFindings } from "../scripts/no-cloud-scan-lib.mjs";

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
