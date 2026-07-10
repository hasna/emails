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
  });
});
