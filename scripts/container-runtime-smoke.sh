#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

revision="$(git rev-parse HEAD)"
version="$(jq -er '.version' package.json)"
image="${CONTAINER_RUNTIME_IMAGE:-hasna-emails-runtime-contract:${revision:0:12}}"
container="hasna-emails-runtime-contract-${revision:0:12}-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if test "${CONTAINER_RUNTIME_KEEP_IMAGE:-0}" != "1"; then
    docker image rm -f "$image" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker build --platform linux/amd64 \
  --build-arg "VERSION=$version" \
  --build-arg "REVISION=$revision" \
  --tag "$image" .

test "$(docker image inspect --format '{{.Architecture}}' "$image")" = "amd64"
test "$(docker image inspect --format '{{.Config.User}}' "$image")" = "1000:1000"
test "$(docker image inspect --format '{{.Config.WorkingDir}}' "$image")" = "/app"
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")" = '["/usr/local/bin/bun"]'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$image")" = '["src/server/index.ts"]'
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = "$version"
test "$(docker image inspect --format '{{json (index .Config.Volumes "/tmp")}}' "$image")" = '{}'

docker run --rm --platform linux/amd64 --read-only \
  --entrypoint /usr/local/bin/bun "$image" -e '
    import { access, stat, writeFile } from "node:fs/promises";
    import { rootCertificates } from "node:tls";
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

test "$(docker run --rm --platform linux/amd64 --read-only "$image" src/cli/index.tsx --version)" = "$version"
docker run --rm --platform linux/amd64 --read-only "$image" src/server/index.ts --help \
  | grep -F 'ingest-worker' >/dev/null

docker run --detach --platform linux/amd64 --read-only --name "$container" \
  --env EMAILS_MODE=local \
  --env EMAILS_DB_PATH=/tmp/emails.db \
  --env AWS_EC2_METADATA_DISABLED=true \
  "$image" >/dev/null

ready=0
for _ in $(seq 1 30); do
  if docker run --rm --platform linux/amd64 --network "container:$container" \
    --entrypoint /usr/local/bin/bun "$image" -e '
      const response = await fetch("http://127.0.0.1:8080/ready");
      if (!response.ok) process.exit(1);
    ' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if test "$ready" != "1"; then
  docker logs "$container" >&2 || true
  exit 1
fi

health="starting"
for _ in $(seq 1 45); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  if test "$health" = "healthy"; then
    break
  fi
  if test "$health" = "unhealthy"; then
    break
  fi
  sleep 2
done

if test "$health" != "healthy"; then
  docker inspect --format '{{json .State.Health}}' "$container" >&2 || true
  docker logs "$container" >&2 || true
  exit 1
fi
