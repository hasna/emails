# Reproducible Emails self-hosted runtime. No deployment or account defaults are
# embedded in the image; the operator supplies Postgres, auth, and provider config.
FROM oven/bun:1.3.13-debian AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.3.13-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    EMAILS_MODE=self_hosted \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8080/health');process.exit(r.ok?0:1)"]

CMD ["bun", "src/server/index.ts"]
