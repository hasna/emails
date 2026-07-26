import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const dockerfile = readFileSync(resolve(import.meta.dir, "../Dockerfile"), "utf8");
const runtimeSmoke = readFileSync(
  resolve(import.meta.dir, "../scripts/container-runtime-smoke.sh"),
  "utf8",
);
const healthcheckCommand = dockerfile.match(
  /HEALTHCHECK[^\n]*\\\n\s*CMD (\[[^\n]+\])/,
)?.[1];
if (!healthcheckCommand) throw new Error("Dockerfile HEALTHCHECK command is missing");
const healthcheckScript = (JSON.parse(healthcheckCommand) as string[])[2];
if (!healthcheckScript) throw new Error("Dockerfile HEALTHCHECK script is missing");
const ecsCompute = readFileSync(
  resolve(import.meta.dir, "../deploy/aws/compute.tf"),
  "utf8",
);
const awsVariables = readFileSync(
  resolve(import.meta.dir, "../deploy/aws/variables.tf"),
  "utf8",
);
const compose = readFileSync(
  resolve(import.meta.dir, "../docker-compose.yml"),
  "utf8",
);
const cutoverRunbook = readFileSync(
  resolve(import.meta.dir, "../docs/DEPLOYMENT_CUTOVER.md"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
);
const bunLockText = readFileSync(resolve(import.meta.dir, "../bun.lock"), "utf8");
const bunLockRootName = bunLockText.match(
  /"workspaces":\s*\{\s*"":\s*\{\s*"name":\s*"([^"]+)"/,
)?.[1];
const bundlePath = "/opt/emails/certs/aws-rds-global-bundle.pem";
const bundleSha256 = "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";
const baseStage = dockerfile.slice(
  dockerfile.indexOf("FROM ${BUN_IMAGE} AS base"),
  dockerfile.indexOf("FROM base AS dependencies"),
);
const runtimeFilesStage = dockerfile.slice(
  dockerfile.indexOf("FROM base AS runtime-files"),
  dockerfile.indexOf("FROM scratch"),
);
const scratchStage = dockerfile.slice(dockerfile.indexOf("FROM scratch"));

describe("self-hosted container TLS contract", () => {
  test("pins a pinned Bun base with minimal Alpine stages", () => {
    expect(dockerfile).toContain(
      "ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0",
    );
    expect(dockerfile).not.toContain("ARG OPENSSL_VERSION=");
    expect(dockerfile).toContain("FROM ${BUN_IMAGE} AS base");
    expect(dockerfile).not.toMatch(/^FROM\s+--platform=/m);
    expect(dockerfile).toContain("FROM base AS dependencies");
    expect(dockerfile).toContain("FROM scratch");
    expect(dockerfile).not.toMatch(/apt-get/);
    expect(dockerfile).not.toMatch(/\bdpkg\b/);
    expect(dockerfile).not.toMatch(/glibc/);
    expect(dockerfile).not.toMatch(/\bperl\b/);
    expect(dockerfile).not.toMatch(/\bsqlite\b/);
    expect(dockerfile).not.toMatch(/"openssl=\$\{OPENSSL_VERSION\}"/);
    expect(dockerfile).not.toMatch(/"libssl3t64=\$\{OPENSSL_VERSION\}"/);
    expect(dockerfile).not.toMatch(/"openssl-provider-legacy=\$\{OPENSSL_VERSION\}"/);
    expect(dockerfile).not.toMatch(/^FROM(?:\s+--platform=\S+)?\s+oven\/bun:(?:1|latest)(?:\s|$)/m);
    expect(runtimeFilesStage).toContain("cp -a /etc/alpine-release /runtime/etc/alpine-release");
  });

  test("applies and verifies exact reproducible OpenSSL security revisions in the shared base", () => {
    expect(baseStage).toContain("apk add --no-cache --upgrade");
    expect(baseStage).toContain("'libcrypto3=3.5.7-r0'");
    expect(baseStage).toContain("'libssl3=3.5.7-r0'");
    expect(baseStage).toContain("apk info --installed 'libcrypto3=3.5.7-r0'");
    expect(baseStage).toContain("apk info --installed 'libssl3=3.5.7-r0'");
    expect(baseStage).not.toContain("apk info --exists");
    expect(baseStage).not.toContain("libcrypto3>=");
    expect(baseStage).not.toContain("libssl3>=");
    expect(baseStage).not.toMatch(/\bapk upgrade\b/);
    expect(baseStage).not.toContain("rm -rf /var/cache/apk");
  });

  test("publishes scanner inventory for exactly the OS libraries copied into scratch", () => {
    expect(runtimeFilesStage).not.toContain(
      "cp -a /lib/apk/db/installed /runtime/lib/apk/db/installed",
    );
    expect(runtimeFilesStage).toContain('order[1] = "libgcc"');
    expect(runtimeFilesStage).toContain('order[2] = "libstdc++"');
    expect(runtimeFilesStage).toContain('order[3] = "musl"');
    expect(runtimeFilesStage).toContain('expected["libgcc"] = 1');
    expect(runtimeFilesStage).toContain('expected["libstdc++"] = 1');
    expect(runtimeFilesStage).toContain('expected["musl"] = 1');
    expect(runtimeFilesStage).toContain("if (name in records)");
    expect(runtimeFilesStage).toContain("if (!(name in records))");
    expect(runtimeFilesStage).toContain("if (failed) exit 1");
    expect(runtimeFilesStage).toContain('printf "%s\\n\\n", records[name]');
    expect(runtimeFilesStage).toContain(
      "/lib/apk/db/installed > /runtime/lib/apk/db/installed",
    );
    expect(runtimeFilesStage).not.toMatch(/expected\["(?:libcrypto3|libssl3)"\]/);
  });

  test("builds, retains, and cleans a separately tagged patched base target", () => {
    expect(runtimeSmoke).toContain(
      'patched_base_image="${CONTAINER_RUNTIME_PATCHED_BASE_IMAGE:-hasna-emails-patched-bun-base:${revision:0:12}}"',
    );
    expect(runtimeSmoke).toMatch(
      /docker build --platform linux\/amd64 \\\n+\s+--target base \\\n+\s+--tag "\$patched_base_image" \\\n+\s+--build-arg "BUN_IMAGE=\$upstream_image" \./,
    );
    expect(runtimeSmoke).toContain(
      'docker image rm -f "$image" "$patched_base_image" >/dev/null 2>&1 || true',
    );
    expect(runtimeSmoke.indexOf('--tag "$patched_base_image"')).toBeLessThan(
      runtimeSmoke.indexOf('--tag "$image"'),
    );
  });

  test("pins the official RDS trust bundle by content digest", () => {
    expect(dockerfile).toContain(
      `ADD --checksum=sha256:${bundleSha256}`,
    );
    expect(dockerfile).toContain(
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    );
    expect(dockerfile).toContain("--chown=root:root --chmod=0444");
  });

  test("locks runtime copy semantics and ownership", () => {
    expect(scratchStage).toContain("ARG VERSION=dev");
    expect(scratchStage).toContain("ARG REVISION=unknown");
    expect(scratchStage).toContain('org.opencontainers.image.source="https://github.com/hasna/emails"');
    expect(scratchStage).toContain('org.opencontainers.image.version="$VERSION"');
    expect(scratchStage).toContain('org.opencontainers.image.revision="$REVISION"');
    expect(scratchStage.match(/^COPY .+$/gm)).toEqual([
      "COPY --from=runtime-files /runtime/ /",
      "COPY --chown=1000:1000 --from=build /app/node_modules /app/node_modules",
      "COPY --chown=1000:1000 --from=build /app/package.json /app/package.json",
      "COPY --chown=1000:1000 --from=build /app/src /app/src",
    ]);
    expect(scratchStage).not.toContain("/app/node_modules ./node_modules");
    expect(scratchStage).not.toContain("/app/src ./src");
  });

  test("enforces exact runtime permissions and runtime user", () => {
    expect(runtimeFilesStage).toContain("/runtime/home/bun/.hasna/emails /runtime/etc");
    expect(runtimeFilesStage).toContain("printf '%s\\n' 'bun:x:1000:1000:Bun:/home/bun:/sbin/nologin' > /runtime/etc/passwd");
    expect(runtimeFilesStage).toContain("printf '%s\\n' 'bun:x:1000:' > /runtime/etc/group");
    expect(runtimeFilesStage).toContain("chmod 0644 /runtime/etc/passwd /runtime/etc/group");
    expect(dockerfile).toContain("chmod 1777 /runtime/tmp");
    expect(dockerfile).toContain('VOLUME ["/tmp"]');
    expect(dockerfile).toContain("chmod 0700 /runtime/home/bun/.hasna/emails");
    expect(dockerfile).toContain(
      "chown -R 1000:1000 /runtime/home/bun /runtime/home/bun/.hasna/emails /runtime/app /runtime/app/data",
    );
    expect(dockerfile).toContain("USER 1000:1000");
  });

  test("exports explicit PATH and bun runtime shims", () => {
    expect(dockerfile).toContain("PATH=/usr/local/bin");
    expect(dockerfile).toContain("ln -sf bun /runtime/usr/local/bin/bunx");
    expect(dockerfile).toContain("ln -sf bun /runtime/usr/local/bin/node");
  });

  test("removes permissive runtime fallback/copy behavior", () => {
    expect(dockerfile).not.toContain("locale-archive");
    expect(dockerfile).not.toContain("|| true");
  });

  test("keeps container entrypoint/cmd direct and healthcheck portable", () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(dockerfile).toContain("CMD [\"src/server/index.ts\"]");
    expect(dockerfile).toContain("process.env.PORT");
  });

  test("uses a bounded SQLite-backed probe for every accepted local mode spelling", async () => {
    expect(runtimeSmoke).toContain("--env EMAILS_MODE=local");
    expect(runtimeSmoke).toContain(
      'fetch("http://127.0.0.1:8080/api/providers?limit=1")',
    );
    expect(runtimeSmoke).not.toContain(
      'fetch("http://127.0.0.1:8080/ready")',
    );
    expect(healthcheckScript).toContain("?.trim().toLowerCase()");

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<void>;
    const selectedUrl = async (mode?: string) => {
      let url: string | undefined;
      let exitCode: number | undefined;
      const env = mode === undefined ? { PORT: "8123" } : { EMAILS_MODE: mode, PORT: "8123" };
      await new AsyncFunction("process", "fetch", healthcheckScript)(
        { env, exit: (code: number) => { exitCode = code; } },
        async (input: string) => {
          url = input;
          return { ok: true };
        },
      );
      expect(exitCode).toBe(0);
      return url;
    };

    for (const mode of ["local", "LOCAL", "  LOCAL  ", "LoCaL"]) {
      expect(await selectedUrl(mode)).toBe("http://127.0.0.1:8123/api/providers?limit=1");
    }
    for (const mode of [undefined, "self_hosted", " SELF_HOSTED "]) {
      expect(await selectedUrl(mode)).toBe("http://127.0.0.1:8123/ready");
    }
  });

  test("runs readiness inside the existing non-root service container", () => {
    const readinessLoop = runtimeSmoke.slice(
      runtimeSmoke.indexOf('for _ in $(seq 1 "$readiness_attempts"); do'),
      runtimeSmoke.indexOf('if test "$ready" != "1"; then'),
    );

    expect(readinessLoop).toContain(
      'if docker exec "$container" /usr/local/bin/bun -e \'',
    );
    expect(readinessLoop).not.toContain("docker run");
    expect(readinessLoop).not.toContain('--network "container:$container"');
  });

  test("mounts a private writable SQLite directory for the read-only local runtime", () => {
    const serviceRunStart = runtimeSmoke.indexOf("docker run --detach");
    const serviceRun = runtimeSmoke.slice(
      serviceRunStart,
      runtimeSmoke.indexOf('"$image" >/dev/null', serviceRunStart),
    );

    expect(serviceRun).toContain("--read-only");
    expect(serviceRun).toContain(
      "--tmpfs /app/data:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000",
    );
    expect(serviceRun).toContain("--env EMAILS_DB_PATH=/app/data/emails.db");
    expect(runtimeSmoke).not.toContain("/tmp/emails.db");
  });

  test("allows the readiness probe to outlive the image cold-start health cadence", () => {
    const healthConfig = dockerfile.match(
      /HEALTHCHECK --interval=(\d+)s --timeout=(\d+)s --start-period=(\d+)s/,
    );
    if (!healthConfig) throw new Error("Dockerfile health timing is missing");

    const healthIntervalSeconds = Number(healthConfig[1]);
    const healthTimeoutSeconds = Number(healthConfig[2]);
    const healthStartPeriodSeconds = Number(healthConfig[3]);
    const smokeTiming = Object.fromEntries(
      [...runtimeSmoke.matchAll(
        /^(image_health_(?:interval|timeout|start_period)_seconds)=(\d+)$/gm,
      )].map((match) => [match[1], Number(match[2])]),
    );

    expect(smokeTiming).toEqual({
      image_health_interval_seconds: healthIntervalSeconds,
      image_health_timeout_seconds: healthTimeoutSeconds,
      image_health_start_period_seconds: healthStartPeriodSeconds,
    });
    expect(runtimeSmoke).toMatch(
      /readiness_wait_seconds=\$\(\(\s*image_health_start_period_seconds\s*\+ \(2 \* image_health_interval_seconds\)\s*\+ \(2 \* image_health_timeout_seconds\)\s*\)\)/,
    );
    expect(runtimeSmoke).toContain('health_wait_seconds="$readiness_wait_seconds"');

    const readinessBudgetSeconds = healthStartPeriodSeconds
      + (2 * healthIntervalSeconds)
      + (2 * healthTimeoutSeconds);
    const healthBudgetSeconds = readinessBudgetSeconds;

    expect(readinessBudgetSeconds).toBe(90);
    expect(healthBudgetSeconds).toBe(90);
    expect(readinessBudgetSeconds).toBeGreaterThanOrEqual(
      healthStartPeriodSeconds + healthIntervalSeconds,
    );
    expect(healthBudgetSeconds).toBeGreaterThan(healthIntervalSeconds);
    expect(runtimeSmoke).toContain(
      "readiness_attempts=$((readiness_wait_seconds / readiness_poll_interval_seconds))",
    );
    expect(runtimeSmoke).toContain(
      "health_attempts=$((health_wait_seconds / health_poll_interval_seconds))",
    );
    expect(runtimeSmoke).not.toMatch(
      /if test "\$health" = "unhealthy"; then\s*break\s*fi/,
    );
    expect(runtimeSmoke).toContain('if test "$health" != "healthy"; then');
  });

  test("keeps ECS commands compatible with the Bun image entrypoint", () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(ecsCompute).toContain('command                = ["src/server/index.ts"]');
    expect(ecsCompute).toContain(
      'command                = ["src/server/index.ts", "ingest-worker"]',
    );
    expect(ecsCompute).toContain(
      'command                = ["src/cli/index.tsx", "db", "migrate"]',
    );
    expect(ecsCompute).not.toMatch(/^\s*command\s*=\s*\["bun",/m);
  });

  test("never lets a container command hijack the Bun image entrypoint into a subcommand", () => {
    // With ENTRYPOINT ["/usr/local/bin/bun"], every container command override is
    // *arguments to bun*. If the effective first argument is a Bun subcommand
    // (e.g. "build") or a duplicated "bun", the image silently stops running the
    // server and instead invokes that subcommand. Both `bun build
    // src/server/index.ts` and `bun bun src/server/index.ts` bundle the entrypoint
    // for the default *browser* target, which pulls in bun:sqlite
    // (src/db/database.ts), pg, and @hasna/events and aborts on boot with
    // "Browser build cannot import ...". The runnable entrypoints all live under
    // src/, so require every command override's first token to be a src/ path.
    const reservedBunTokens = new Set([
      "bun", "run", "build", "test", "x", "exec", "repl",
      "install", "i", "add", "a", "remove", "rm", "update", "outdated",
      "link", "unlink", "pm", "patch", "patch-commit", "init", "create", "c",
      "upgrade", "audit", "why", "publish", "info", "deploy",
    ]);

    const commandFirstTokens: Array<{ source: string; token: string }> = [];

    // Dockerfile main CMD. The HEALTHCHECK CMD is indented, so ^CMD skips it.
    const dockerfileCmd = dockerfile.match(/^CMD\s*(\[[^\n]+\])/m)?.[1];
    if (!dockerfileCmd) throw new Error("Dockerfile CMD is missing");
    commandFirstTokens.push({
      source: "Dockerfile CMD",
      token: (JSON.parse(dockerfileCmd) as string[])[0] ?? "",
    });

    // ECS task definitions, Compose services, and the cutover run-task overrides.
    // Skip Docker/ECS health checks, whose command array starts with CMD/CMD-SHELL.
    for (const [source, text] of [
      ["deploy/aws/compute.tf", ecsCompute],
      ["docker-compose.yml", compose],
      ["docs/DEPLOYMENT_CUTOVER.md", cutoverRunbook],
    ] as const) {
      for (const match of text.matchAll(/(?:"command"|command)\s*[:=]\s*\[\s*"([^"]+)"/g)) {
        const token = match[1] ?? "";
        if (token === "CMD" || token === "CMD-SHELL") continue;
        commandFirstTokens.push({ source, token });
      }
    }

    // Sanity: we actually parsed the known overrides (Dockerfile + 3 ECS + 2
    // Compose + 3 cutover), so the guard cannot silently pass on a parse miss.
    expect(commandFirstTokens.length).toBeGreaterThanOrEqual(9);

    const isHijack = (token: string) => reservedBunTokens.has(token) || !token.startsWith("src/");
    const hijacks = commandFirstTokens.filter(({ token }) => isHijack(token));
    expect(hijacks).toEqual([]);

    // Prove the guard is not vacuous: it must flag the exact tokens that
    // reproduced the production boot crash and accept the real entrypoints.
    expect(isHijack("build")).toBeTrue();
    expect(isHijack("bun")).toBeTrue();
    expect(isHijack("run")).toBeTrue();
    expect(isHijack("src/server/index.ts")).toBeFalse();
    expect(isHijack("src/cli/index.tsx")).toBeFalse();
  });

  test("keeps Compose and cutover overrides compatible with the Bun image entrypoint", () => {
    expect(compose).toContain('command: ["src/server/index.ts"]');
    expect(compose).toContain(
      'command: ["src/cli/index.tsx", "db", "migrate"]',
    );
    expect(cutoverRunbook).toContain(
      '"command":["src/server/index.ts","inbound-provenance-fence"]',
    );
    expect(cutoverRunbook).toContain(
      'command:["src/cli/index.tsx","--json","db","status"]',
    );
    expect(cutoverRunbook).toContain(
      'command:["src/server/index.ts","inbound-provenance-audit","--since",$since]',
    );
    for (const source of [compose, cutoverRunbook]) {
      expect(source).not.toMatch(
        /(?:"command"|command)\s*:\s*\[\s*"bun"/,
      );
    }
  });

  test("pins cutover recovery to the forward-only migration 0020 boundary", () => {
    expect(cutoverRunbook).toContain(
      "## Attachment provenance, send recovery, inbox rollups, and repair-ledger gates (0017-0020)",
    );
    expect(cutoverRunbook).toMatch(
      /Migration\s+0020 is the latest forward-only production cutover\./,
    );
    expect(cutoverRunbook).toMatch(
      /A pre-0020 release is not\s+a valid restart, scale-out, or rollback target after 0020 commits\./,
    );
    expect(cutoverRunbook).toMatch(
      /Leave\s+`enable_automatic_deployment_rollback = false` through the observation window\./,
    );
    expect(cutoverRunbook).toContain(
      '((keys | sort) == ["alreadyApplied","applied","pending"])',
    );
    expect(cutoverRunbook).toContain(
      'and (.applied | type == "array" and length == 0)',
    );
    expect(cutoverRunbook).toContain(
      'and (.pending | type == "array" and length == 0)',
    );
    expect(cutoverRunbook).toContain(
      'and (.alreadyApplied | type == "array" and all(.[]; type == "string"))',
    );
    for (const migrationId of [
      "0017_inbound_message_source_provenance",
      "0018_send_intent_recovery",
      "0019_inbox_perf_rollups",
      "0020_attachment_repair_ledger",
    ]) {
      expect(cutoverRunbook).toContain(
        `.alreadyApplied | index("${migrationId}") != null`,
      );
    }
    expect(cutoverRunbook).toMatch(
      /`emails db status --json` emits that object only after `MigrationLedger` validates\s+every stored `schema_migrations` checksum;/,
    );
    expect(cutoverRunbook).toMatch(
      /Both service desired counts must remain zero\..*The maintenance path must be the only database writer,/s,
    );
    expect(cutoverRunbook).toMatch(
      /The manifest must use\s+exact canonical object keys, trusted recipient evidence, and the complete\s+tenant-scoped canary-message set\./,
    );
    expect(cutoverRunbook).toMatch(
      /create the exact-canary manifest\s+without `apply`, record a completed dry-run summary, then create the separately\s+approved `apply: true` run and resume bounded pages until `pending == 0`\./,
    );
    expect(cutoverRunbook).toContain(
      "`repaired + would_repair + unavailable + pending == inventory_total`",
    );
    expect(cutoverRunbook).toMatch(
      /and the\s+equivalent `entry_\*` invariant\./,
    );
    expect(cutoverRunbook).toMatch(
      /It must perform exact-key `GetObject` calls\s+only: no bucket listing, payload logging, source-key logging, recipient logging,\s+or caller-supplied bucket is permitted\./,
    );
    expect(cutoverRunbook).toMatch(
      /`NO_SES_SMOKE_TASK_ROLE_ARN` must identify a reviewed smoke role that denies\s+`ses:SendEmail` and `ses:SendRawEmail`\./,
    );
    expect(cutoverRunbook).toMatch(
      /These shell-local rehearsal curls do not satisfy the production no-SES-role\s+gate;/,
    );
    expect(cutoverRunbook).toMatch(
      /Before retiring any former local runtime state, stop its writers and take a\s+fresh, checksummed, restore-tested backup of its database and attachment\s+data\./,
    );
    expect(cutoverRunbook).toContain(
      "Cutover success is not authority to delete backups.",
    );
    for (const executableGate of [
      'test "$REPAIR_PENDING" = "0"',
      'test "$REPAIR_ENTRY_PENDING" = "0"',
      'test "$REPAIR_ACCOUNTED" = "$REPAIR_INVENTORY_TOTAL"',
      'test "$REPAIR_ENTRY_ACCOUNTED" = "$REPAIR_ENTRY_TOTAL"',
      'all(.[]; type == "number" and . >= 0 and floor == .)',
      'pg_dump --format=custom',
      'sha256sum --check --',
      'pg_restore --exit-on-error',
      'BACKUP_RETAIN_UNTIL',
      'RETAINED_SHA256_FILE',
      'test ! -e "$RETAINED_BACKUP"',
      'test "$NO_SES_SMOKE_TASK_ROLE" = "$NO_SES_SMOKE_TASK_ROLE_ARN"',
      'test "$NO_SES_SMOKE_EXIT" = "0"',
      '((keys | sort) == ["candidate_messages","cutoff","gaps","invalid_provenance","missing_provenance","status","tenants_scanned","valid_provenance"])',
      '--arg cutoff "$FENCE_AT"',
      "curl_config_escape",
    ]) {
      expect(cutoverRunbook).toContain(executableGate);
    }
    expect(cutoverRunbook).toMatch(
      /curl_config_escape\(\)[\s\S]*case "\$value" in[\s\S]*\$'\\n'[\s\S]*\$'\\r'/,
    );
    expect(cutoverRunbook).not.toContain(
      "printf 'header = \"x-api-key: %s\"",
    );
    expect(cutoverRunbook).toMatch(
      /After 0020 begins, the only application-image recovery target is a\s+0020-compatible roll-forward\./,
    );
    expect(cutoverRunbook).toContain(
      "Use only a corrected 0020-compatible image",
    );
    expect(cutoverRunbook).toMatch(
      /Production hard stop:\*\* this generic Terraform rehearsal is \*\*UNUSABLE for\s+> the actual live topology\*\*\./,
    );
    expect(cutoverRunbook).toMatch(
      /The commands below are only an evidence-producing isolated rehearsal template\.\s+They are never live-production instructions and must fail closed for any\s+topology identified as live\./,
    );
    expect(cutoverRunbook).toContain(
      'select(.schema_version == 1 and .purpose == "isolated-rehearsal")',
    );
    expect(cutoverRunbook).toContain(
      'select(.environment == "rehearsal" and .live == false)',
    );
    expect(cutoverRunbook).toMatch(
      /Never remove or\s+rewrite the 0017,\s+0018, 0019, or 0020 ledger row\./,
    );
    expect(cutoverRunbook).not.toContain(
      "Use only a corrected 0017-compatible image",
    );
    expect(cutoverRunbook).not.toContain(
      "Use only a corrected 0018-compatible image",
    );
  });

  test("keeps the ECS health check executable without a shell", () => {
    expect(dockerfile).toContain("FROM scratch");
    expect(ecsCompute).not.toContain('command     = ["CMD-SHELL"');
    expect(ecsCompute).toContain(
      'command     = ["CMD", "/usr/local/bin/bun", "-e",',
    );
    expect(ecsCompute).toContain("/ready");
  });

  test("passes the deployment-owned inbound prefix mapping to the ingest worker", () => {
    expect(ecsCompute).toMatch(/name\s*=\s*"EMAILS_INGEST_PREFIX_DOMAIN_MAP"/);
    expect(ecsCompute).toMatch(
      /name\s*=\s*"EMAILS_INGEST_PREFIX_DOMAIN_MAP"[\s\S]*?value\s*=\s*local\.inbound_prefix_domain_map_json/,
    );
    expect(ecsCompute).toMatch(
      /inbound_prefix_domain_map\s*=\s*\([\s\S]*length\(local\.inbound_prefix_domain_map_override\)\s*>\s*0[\s\S]*\?\s*local\.inbound_prefix_domain_map_override[\s\S]*:\s*local\.inbound_prefix_domain_map_legacy[\s\S]*\)/,
    );
    expect(ecsCompute).toContain("inbound_prefix_domain_map_override");
    expect(ecsCompute).toContain("inbound_prefix_domain_map_legacy");
    expect(awsVariables).toMatch(
      /for prefix_index, prefix in sort\(keys\(var\.inbound_prefix_domain_map\)\)[\s\S]*?for other_index, other_prefix in sort\(keys\(var\.inbound_prefix_domain_map\)\)[\s\S]*?prefix_index == other_index \|\| !startswith\(prefix, other_prefix\)/,
    );
    expect(awsVariables).not.toMatch(
      /for index, prefix in sort\(keys\(var\.inbound_prefix_domain_map\)\)[\s\S]*index == 0 \|\| !startswith\(prefix, sort\(keys\(var\.inbound_prefix_domain_map\)\)\[index - 1\]\)/,
    );
    expect(awsVariables).toContain('endswith(var.inbound_object_prefix, "/")');
    expect(awsVariables).toContain(
      'trimspace(var.inbound_object_prefix) == var.inbound_object_prefix',
    );
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

describe("self-hosted container install contract", () => {
  function hasSafePostinstallCopy(candidate: string): boolean {
    const postinstall = packageJson.scripts?.postinstall;
    if (typeof postinstall !== "string") return false;

    const scriptMatch = postinstall.match(/(?:^|\s)\.\/(scripts\/[^\s'"`]+)(?:\s|$)/);
    if (!scriptMatch) return false;
    const postinstallScript = scriptMatch[1];

    const dependenciesStart = candidate.search(/^FROM\s+\S+\s+AS\s+dependencies\s*$/m);
    const buildStart = candidate.search(/^FROM\s+\S+\s+AS\s+build\s*$/m);
    if (dependenciesStart < 0 || buildStart <= dependenciesStart) return false;

    const stageLines = candidate
      .slice(dependenciesStart, buildStart)
      .split("\n")
      .map((line) => line.trim());
    const installIndex = stageLines.indexOf("RUN bun install --production --frozen-lockfile");
    const copyIndex = stageLines.indexOf(`COPY ${postinstallScript} ./${postinstallScript}`);
    if (installIndex < 0 || copyIndex < 0 || copyIndex >= installIndex) return false;

    const workdirIndex = stageLines.findLastIndex(
      (line, index) => index < copyIndex && line.startsWith("WORKDIR "),
    );
    return stageLines[workdirIndex] === "WORKDIR /app";
  }

  test("copies the package postinstall script before the frozen production install", () => {
    expect(hasSafePostinstallCopy(dockerfile)).toBeTrue();
  });

  test("keeps lockfile and packed manifest identities on the canonical Emails package and bins", () => {
    expect(packageJson.name).toBe("@hasna/emails");
    expect(bunLockRootName).toBe("@hasna/emails");
    expect(packageJson.scripts?.["pack:identity"]).toContain("packed manifest");
    expect(packageJson.scripts?.prepack).toContain("bun run pack:identity");
    expect(packageJson.scripts?.prepublishOnly).toContain("bun run pack:identity");

    const destination = mkdtempSync(resolve(tmpdir(), "emails-pack-identity-"));
    try {
      const packedName = execFileSync("bun", [
        "pm",
        "pack",
        "--ignore-scripts",
        "--destination",
        destination,
        "--quiet",
      ], {
        cwd: resolve(import.meta.dir, ".."),
        encoding: "utf8",
      }).trim().split(/\r?\n/).at(-1);
      expect(packedName).toBeTruthy();
      if (!packedName) throw new Error("bun pm pack did not return a tarball name");
      const packedTarball = resolve(destination, packedName);
      const packed = JSON.parse(execFileSync(
        "tar",
        ["-xOf", packedTarball, "package/package.json"],
        { encoding: "utf8" },
      ));
      expect(packed.name).toBe("@hasna/emails");
      expect(packed.bin).toEqual({
        emails: "dist/cli/index.js",
        "emails-mcp": "dist/mcp/index.js",
        "emails-serve": "dist/server/index.js",
      });
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  test("rejects external-stage and wrong-stage copy bypasses", () => {
    const safeCopy = "COPY scripts/ensure-private-data-dir.mjs ./scripts/ensure-private-data-dir.mjs";
    expect(
      hasSafePostinstallCopy(
        dockerfile.replace(safeCopy, `COPY --from=base ${safeCopy.slice("COPY ".length)}`),
      ),
    ).toBeFalse();
    expect(
      hasSafePostinstallCopy(
        dockerfile
          .replace(`${safeCopy}\nRUN bun install`, "RUN bun install")
          .replace("FROM base AS build\nWORKDIR /app", `FROM base AS build\nWORKDIR /app\n${safeCopy}`),
      ),
    ).toBeFalse();
  });
});
