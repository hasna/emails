import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dockerfile = readFileSync(resolve(import.meta.dir, "../Dockerfile"), "utf8");
const bundlePath = "/opt/emails/certs/aws-rds-global-bundle.pem";
const bundleSha256 = "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";

describe("self-hosted container TLS contract", () => {
  test("pins the official RDS trust bundle by content digest", () => {
    expect(dockerfile).toContain(
      `ADD --checksum=sha256:${bundleSha256}`,
    );
    expect(dockerfile).toContain(
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    );
    expect(dockerfile).toContain("--chown=bun:bun --chmod=0444");
  });

  test("configures the product runtime to use the bundled trust roots", () => {
    expect(dockerfile).toContain(`EMAILS_DATABASE_CA_FILE=${bundlePath}`);
    expect(dockerfile).toContain(`NODE_EXTRA_CA_CERTS=${bundlePath}`);
  });

  test("never disables certificate verification", () => {
    expect(dockerfile).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(dockerfile).not.toContain("rejectUnauthorized: false");
  });
});
