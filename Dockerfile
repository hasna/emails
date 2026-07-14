# syntax=docker/dockerfile:1.7

# Reproducible Emails self-hosted runtime. No deployment or account defaults are
# embedded in the image; the operator supplies Postgres, auth, and provider config.
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
ARG OPENSSL_VERSION=3.5.6-1~deb13u2

FROM ${BUN_IMAGE} AS base
ARG OPENSSL_VERSION
# Apply Debian's fixed OpenSSL source package in one shared base so dependency
# and runtime stages cannot drift. Exact pins and the assertion fail closed when
# a mirror is stale or provides an incomplete security update.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      "openssl=${OPENSSL_VERSION}" \
      "libssl3t64=${OPENSSL_VERSION}" \
      "openssl-provider-legacy=${OPENSSL_VERSION}" \
    && dpkg-query -W openssl libssl3t64 openssl-provider-legacy \
      | awk -v expected="${OPENSSL_VERSION}" '$2 != expected { exit 1 } END { if (NR != 3) exit 1 }' \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    EMAILS_MODE=self_hosted \
    EMAILS_DATABASE_CA_FILE=/opt/emails/certs/aws-rds-global-bundle.pem \
    NODE_EXTRA_CA_CERTS=/opt/emails/certs/aws-rds-global-bundle.pem \
    HOST=0.0.0.0 \
    PORT=8080

RUN mkdir -p /opt/emails/certs \
    && chown root:root /opt /opt/emails /opt/emails/certs \
    && chmod 0755 /opt /opt/emails /opt/emails/certs

# Official Amazon RDS global trust bundle, content-pinned for reproducible and
# fail-closed image builds. To rotate it, review the new AWS bundle and update
# this checksum together with the TLS/container contract tests.
ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
    --chown=root:root --chmod=0444 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /opt/emails/certs/aws-rds-global-bundle.pem

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8080/ready');process.exit(r.ok?0:1)"]

CMD ["bun", "src/server/index.ts"]
