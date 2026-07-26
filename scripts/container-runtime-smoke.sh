#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

revision="$(git rev-parse HEAD)"
version="$(jq -er '.version' package.json)"
upstream_image="${BUN_UPSTREAM_IMAGE:-oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0}"
patched_base_image="${CONTAINER_RUNTIME_PATCHED_BASE_IMAGE:-hasna-emails-patched-bun-base:${revision:0:12}}"
image="${CONTAINER_RUNTIME_IMAGE:-hasna-emails-runtime-contract:${revision:0:12}}"
container="hasna-emails-runtime-contract-${revision:0:12}-$$"

if test "${CONTAINER_RUNTIME_PLATFORM+x}" = "x"; then
  case "$CONTAINER_RUNTIME_PLATFORM" in
    linux/arm64 | linux/amd64)
      platform="$CONTAINER_RUNTIME_PLATFORM"
      ;;
    *)
      printf 'unsupported CONTAINER_RUNTIME_PLATFORM: %s (expected linux/arm64 or linux/amd64)\n' \
        "$CONTAINER_RUNTIME_PLATFORM" >&2
      exit 1
      ;;
  esac
else
  docker_server_arch="$(docker info --format '{{.Architecture}}')"
  case "$docker_server_arch" in
    aarch64 | arm64)
      platform="linux/arm64"
      ;;
    x86_64 | amd64)
      platform="linux/amd64"
      ;;
    *)
      printf 'unsupported Docker server architecture: %s\n' "$docker_server_arch" >&2
      exit 1
      ;;
  esac
fi

case "$platform" in
  linux/arm64)
    expected_bun_arch="arm64"
    ;;
  linux/amd64)
    expected_bun_arch="x64"
    ;;
  *)
    printf 'unsupported resolved container platform: %s\n' "$platform" >&2
    exit 1
    ;;
esac

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if test "${CONTAINER_RUNTIME_KEEP_IMAGE:-0}" != "1"; then
    docker image rm -f "$image" "$patched_base_image" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

assert_image_platform() {
  local candidate_image="$1"
  local actual_platform
  actual_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$candidate_image")"
  if test "$actual_platform" != "$platform"; then
    printf 'image platform mismatch for %s: requested %s, got %s\n' \
      "$candidate_image" "$platform" "$actual_platform" >&2
    return 1
  fi
}

docker build --platform "$platform" \
  --target base \
  --tag "$patched_base_image" \
  --build-arg "BUN_IMAGE=$upstream_image" .
assert_image_platform "$patched_base_image"

docker build --platform "$platform" \
  --build-arg "BUN_IMAGE=$upstream_image" \
  --build-arg "VERSION=$version" \
  --build-arg "REVISION=$revision" \
  --tag "$image" .
assert_image_platform "$image"

test "$(docker image inspect --format '{{.Config.User}}' "$image")" = "1000:1000"
test "$(docker image inspect --format '{{.Config.WorkingDir}}' "$image")" = "/app"
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")" = '["/usr/local/bin/bun"]'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$image")" = '["src/server/index.ts"]'
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = "$version"
test "$(docker image inspect --format '{{json (index .Config.Volumes "/tmp")}}' "$image")" = '{}'

docker run --rm --platform "$platform" --read-only \
  --env "CONTAINER_RUNTIME_EXPECTED_BUN_ARCH=$expected_bun_arch" \
  --entrypoint /usr/local/bin/bun "$image" -e '
    import { access, stat, writeFile } from "node:fs/promises";
    import { rootCertificates } from "node:tls";
    const expectedArch = process.env.CONTAINER_RUNTIME_EXPECTED_BUN_ARCH;
    if (expectedArch !== "arm64" && expectedArch !== "x64") {
      throw new Error(`unsupported expected runtime architecture: ${expectedArch ?? "unset"}`);
    }
    if (process.arch !== expectedArch) {
      throw new Error(`runtime architecture mismatch: expected ${expectedArch}, got ${process.arch}`);
    }
    if (process.cwd() !== "/app") throw new Error(`unexpected cwd: ${process.cwd()}`);
    if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
      throw new Error(`unexpected identity: ${process.getuid?.()}:${process.getgid?.()}`);
    }
    for (const path of [
      "/app/src/server/index.ts",
      "/app/src/server/self-hosted/migrate.ts",
      "/app/node_modules",
      "/opt/emails/certs/aws-rds-global-bundle.pem",
    ]) await access(path);
    const tmp = await stat("/tmp");
    if ((tmp.mode & 0o7777) !== 0o1777) throw new Error(`/tmp mode is ${(tmp.mode & 0o7777).toString(8)}`);
    await writeFile("/tmp/runtime-contract", "ok", { mode: 0o600 });
    if (rootCertificates.length < 100) throw new Error("public TLS root store is unavailable");
  '

test "$(docker run --rm --platform "$platform" --read-only "$image" src/cli/index.tsx --version)" = "$version"
docker run --rm --platform "$platform" --read-only "$image" src/server/index.ts --help \
  | grep -F 'ingest-worker' >/dev/null

docker run --detach --platform "$platform" --read-only --name "$container" \
  --tmpfs /app/data:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000 \
  --env EMAILS_MODE=local \
  --env EMAILS_DB_PATH=/app/data/emails.db \
  --env EMAILS_ALLOW_REMOTE=1 \
  --env AWS_EC2_METADATA_DISABLED=true \
  "$image" >/dev/null

# Keep these values in lockstep with the image HEALTHCHECK. The readiness
# budget covers its 20s cold-start period, two 30s health cadences, and two 5s
# probe timeouts. Once the explicit route is ready, reuse that 90s envelope so
# a transient unhealthy result can recover across at least two health cadences.
image_health_interval_seconds=30
image_health_timeout_seconds=5
image_health_start_period_seconds=20
readiness_poll_interval_seconds=1
health_poll_interval_seconds=1
readiness_wait_seconds=$((
  image_health_start_period_seconds
  + (2 * image_health_interval_seconds)
  + (2 * image_health_timeout_seconds)
))
health_wait_seconds="$readiness_wait_seconds"

ready=0
readiness_attempts=$((readiness_wait_seconds / readiness_poll_interval_seconds))
for _ in $(seq 1 "$readiness_attempts"); do
  if docker exec "$container" /usr/local/bin/bun -e '
      const response = await fetch("http://127.0.0.1:8080/api/providers?limit=1");
      if (!response.ok) process.exit(1);
    ' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep "$readiness_poll_interval_seconds"
done

if test "$ready" != "1"; then
  docker exec "$container" /usr/local/bin/bun -e '
    try {
      const response = await fetch("http://127.0.0.1:8080/api/providers?limit=1");
      console.error(`readiness probe status=${response.status}`);
    } catch (error) {
      console.error(`readiness probe error=${error instanceof Error ? error.name : "unknown"}`);
    }
  ' >&2 || true
  docker inspect --format '{{json .State.Health}}' "$container" >&2 || true
  docker logs "$container" >&2 || true
  exit 1
fi

health="starting"
health_attempts=$((health_wait_seconds / health_poll_interval_seconds))
for _ in $(seq 1 "$health_attempts"); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  if test "$health" = "healthy"; then
    break
  fi
  sleep "$health_poll_interval_seconds"
done

if test "$health" != "healthy"; then
  docker inspect --format '{{json .State.Health}}' "$container" >&2 || true
  docker logs "$container" >&2 || true
  exit 1
fi
