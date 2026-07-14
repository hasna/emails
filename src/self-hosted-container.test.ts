import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dockerfile = readFileSync(resolve(import.meta.dir, "../Dockerfile"), "utf8");
const bundlePath = "/opt/emails/certs/aws-rds-global-bundle.pem";
const bundleSha256 = "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";

describe("self-hosted container TLS contract", () => {
  test("pins a shared Bun base at the Debian OpenSSL security floor", () => {
    expect(dockerfile).toContain(
      "ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
    );
    expect(dockerfile).toContain("ARG OPENSSL_VERSION=3.5.6-1~deb13u2");
    expect(dockerfile).toContain("FROM ${BUN_IMAGE} AS base");
    expect(dockerfile).not.toMatch(/^FROM\s+--platform=/m);
    expect(dockerfile).toContain("FROM base AS dependencies");
    expect(dockerfile).toContain("FROM base AS runtime");
    expect(dockerfile).toContain('"openssl=${OPENSSL_VERSION}"');
    expect(dockerfile).toContain('"libssl3t64=${OPENSSL_VERSION}"');
    expect(dockerfile).toContain('"openssl-provider-legacy=${OPENSSL_VERSION}"');
    expect(dockerfile).toContain("dpkg-query -W openssl libssl3t64 openssl-provider-legacy");
    expect(dockerfile).not.toMatch(/^FROM(?:\s+--platform=\S+)?\s+oven\/bun:(?:1|latest)(?:\s|$)/m);
  });

  test("pins the official RDS trust bundle by content digest", () => {
    expect(dockerfile).toContain(
      `ADD --checksum=sha256:${bundleSha256}`,
    );
    expect(dockerfile).toContain(
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    );
    expect(dockerfile).toContain("--chown=root:root --chmod=0444");
    expect(dockerfile).toContain("chown root:root /opt /opt/emails /opt/emails/certs");
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
