#!/usr/bin/env bash
set -euo pipefail
export BASH_ENV=/dev/null
unset CONTAINER_RUNTIME_PLATFORM
unset FAKE_DOCKER_FORCED_PATCHED_ARCH
unset FAKE_DOCKER_FORCED_FINAL_ARCH

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/container-runtime-smoke.sh"
test_root="$(mktemp -d)"

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"

case "${1:-}" in
  info)
    if test "$#" -ne 3 || test "${2:-}" != "--format" || test "${3:-}" != '{{.Architecture}}'; then
      printf 'unexpected docker info command: %s\n' "$*" >&2
      exit 2
    fi
    printf '%s\n' "$FAKE_DOCKER_SERVER_ARCH"
    ;;
  build)
    platform=""
    image=""
    shift
    while test "$#" -gt 0; do
      case "$1" in
        --platform)
          platform="${2:-}"
          shift 2
          ;;
        --tag)
          image="${2:-}"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    image_arch="${platform#linux/}"
    if test "$image" = "$FAKE_DOCKER_PATCHED_IMAGE" && test -n "${FAKE_DOCKER_FORCED_PATCHED_ARCH:-}"; then
      image_arch="$FAKE_DOCKER_FORCED_PATCHED_ARCH"
    fi
    if test "$image" = "$FAKE_DOCKER_FINAL_IMAGE" && test -n "${FAKE_DOCKER_FORCED_FINAL_ARCH:-}"; then
      image_arch="$FAKE_DOCKER_FORCED_FINAL_ARCH"
    fi
    printf '%s %s\n' "$image" "$image_arch" >>"$FAKE_DOCKER_STATE"
    ;;
  image)
    case "${2:-}" in
      inspect)
        format="${4:-}"
        image="${5:-}"
        image_arch="$(awk -v image="$image" '$1 == image { arch = $2 } END { print arch }' "$FAKE_DOCKER_STATE")"
        test -n "$image_arch"
        case "$format" in
          '{{.Os}}/{{.Architecture}}')
            printf 'linux/%s\n' "$image_arch"
            ;;
          '{{.Architecture}}')
            printf '%s\n' "$image_arch"
            ;;
          '{{.Config.User}}')
            printf '1000:1000\n'
            ;;
          '{{.Config.WorkingDir}}')
            printf '/app\n'
            ;;
          '{{json .Config.Entrypoint}}')
            printf '["/usr/local/bin/bun"]\n'
            ;;
          '{{json .Config.Cmd}}')
            printf '["src/server/index.ts"]\n'
            ;;
          '{{index .Config.Labels "org.opencontainers.image.revision"}}')
            printf '%s\n' "$FAKE_DOCKER_REVISION"
            ;;
          '{{index .Config.Labels "org.opencontainers.image.version"}}')
            printf '%s\n' "$FAKE_DOCKER_VERSION"
            ;;
          '{{json (index .Config.Volumes "/tmp")}}')
            printf '{}\n'
            ;;
          *)
            printf 'unexpected image inspect format: %s\n' "$format" >&2
            exit 2
            ;;
        esac
        ;;
      rm)
        ;;
      *)
        printf 'unexpected docker image command: %s\n' "$*" >&2
        exit 2
        ;;
    esac
    ;;
  run)
    case " $* " in
      *' src/cli/index.tsx --version '*)
        printf '%s\n' "$FAKE_DOCKER_VERSION"
        ;;
      *' src/server/index.ts --help '*)
        printf 'ingest-worker\n'
        ;;
      *' --detach '*)
        printf 'fake-container-id\n'
        ;;
    esac
    ;;
  exec)
    ;;
  inspect)
    printf 'healthy\n'
    ;;
  logs | rm)
    ;;
  *)
    printf 'unexpected docker command: %s\n' "$*" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$fake_bin/docker"

revision="$(git -C "$repo_root" rev-parse HEAD)"
version="$(jq -er '.version' "$repo_root/package.json")"

run_case() {
  local case_name="$1"
  local server_arch="$2"
  local expected_platform="$3"
  local override="${4:-}"
  local log="$test_root/$case_name.log"
  local state="$test_root/$case_name.state"
  local stdout="$test_root/$case_name.stdout"
  local stderr="$test_root/$case_name.stderr"
  local patched_image="test-patched:$case_name"
  local final_image="test-final:$case_name"
  local -a environment=(
    "PATH=$fake_bin:$PATH"
    "FAKE_DOCKER_LOG=$log"
    "FAKE_DOCKER_STATE=$state"
    "FAKE_DOCKER_SERVER_ARCH=$server_arch"
    "FAKE_DOCKER_PATCHED_IMAGE=$patched_image"
    "FAKE_DOCKER_FINAL_IMAGE=$final_image"
    "FAKE_DOCKER_REVISION=$revision"
    "FAKE_DOCKER_VERSION=$version"
    "CONTAINER_RUNTIME_PATCHED_BASE_IMAGE=$patched_image"
    "CONTAINER_RUNTIME_IMAGE=$final_image"
  )

  : >"$log"
  : >"$state"
  if test -n "$override"; then
    environment+=("CONTAINER_RUNTIME_PLATFORM=$override")
  fi

  if ! env "${environment[@]}" "$script" >"$stdout" 2>"$stderr"; then
    printf '%s script execution failed:\n' "$case_name" >&2
    cat "$stderr" >&2
    return 1
  fi

  test "$(grep -c '^build ' "$log")" = "2"
  test "$(grep -c '^run ' "$log")" = "4"
  if grep -E '^(build|run) ' "$log" | grep -Fv -- "--platform $expected_platform" >/dev/null; then
    printf '%s did not propagate %s to every build and run:\n' "$case_name" "$expected_platform" >&2
    cat "$log" >&2
    return 1
  fi
  test "$(grep -c "^image inspect --format {{.Os}}/{{.Architecture}} test-patched:$case_name$" "$log")" = "1"
  test "$(grep -c "^image inspect --format {{.Os}}/{{.Architecture}} test-final:$case_name$" "$log")" = "1"
}

run_case default-aarch64 aarch64 linux/arm64
run_case default-arm64 arm64 linux/arm64
run_case default-x86_64 x86_64 linux/amd64
run_case default-amd64 amd64 linux/amd64
run_case override-arm64 amd64 linux/arm64 linux/arm64
run_case override-amd64 aarch64 linux/amd64 linux/amd64

invalid_log="$test_root/invalid.log"
invalid_state="$test_root/invalid.state"
invalid_stderr="$test_root/invalid.stderr"
: >"$invalid_log"
: >"$invalid_state"
if env \
  "PATH=$fake_bin:$PATH" \
  "FAKE_DOCKER_LOG=$invalid_log" \
  "FAKE_DOCKER_STATE=$invalid_state" \
  "FAKE_DOCKER_SERVER_ARCH=aarch64" \
  "CONTAINER_RUNTIME_PLATFORM=linux/s390x" \
  "$script" >"$test_root/invalid.stdout" 2>"$invalid_stderr"; then
  printf 'unsupported platform override unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'unsupported CONTAINER_RUNTIME_PLATFORM: linux/s390x' "$invalid_stderr" >/dev/null
test ! -s "$invalid_log"

empty_override_log="$test_root/empty-override.log"
empty_override_state="$test_root/empty-override.state"
empty_override_stderr="$test_root/empty-override.stderr"
: >"$empty_override_log"
: >"$empty_override_state"
if env \
  "PATH=$fake_bin:$PATH" \
  "FAKE_DOCKER_LOG=$empty_override_log" \
  "FAKE_DOCKER_STATE=$empty_override_state" \
  "FAKE_DOCKER_SERVER_ARCH=aarch64" \
  "CONTAINER_RUNTIME_PLATFORM=" \
  "$script" >"$test_root/empty-override.stdout" 2>"$empty_override_stderr"; then
  printf 'empty platform override unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'unsupported CONTAINER_RUNTIME_PLATFORM: ' "$empty_override_stderr" >/dev/null
test ! -s "$empty_override_log"

unsupported_arch_log="$test_root/unsupported-arch.log"
unsupported_arch_state="$test_root/unsupported-arch.state"
unsupported_arch_stderr="$test_root/unsupported-arch.stderr"
: >"$unsupported_arch_log"
: >"$unsupported_arch_state"
if env \
  "PATH=$fake_bin:$PATH" \
  "FAKE_DOCKER_LOG=$unsupported_arch_log" \
  "FAKE_DOCKER_STATE=$unsupported_arch_state" \
  "FAKE_DOCKER_SERVER_ARCH=ppc64le" \
  "$script" >"$test_root/unsupported-arch.stdout" 2>"$unsupported_arch_stderr"; then
  printf 'unsupported Docker server architecture unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'unsupported Docker server architecture: ppc64le' "$unsupported_arch_stderr" >/dev/null
test "$(cat "$unsupported_arch_log")" = "info --format {{.Architecture}}"

mismatch_log="$test_root/mismatch.log"
mismatch_state="$test_root/mismatch.state"
mismatch_stderr="$test_root/mismatch.stderr"
: >"$mismatch_log"
: >"$mismatch_state"
if env \
  "PATH=$fake_bin:$PATH" \
  "FAKE_DOCKER_LOG=$mismatch_log" \
  "FAKE_DOCKER_STATE=$mismatch_state" \
  "FAKE_DOCKER_SERVER_ARCH=aarch64" \
  "FAKE_DOCKER_PATCHED_IMAGE=test-patched:mismatch" \
  "FAKE_DOCKER_FINAL_IMAGE=test-final:mismatch" \
  "FAKE_DOCKER_FORCED_PATCHED_ARCH=amd64" \
  "FAKE_DOCKER_REVISION=$revision" \
  "FAKE_DOCKER_VERSION=$version" \
  "CONTAINER_RUNTIME_PATCHED_BASE_IMAGE=test-patched:mismatch" \
  "CONTAINER_RUNTIME_IMAGE=test-final:mismatch" \
  "$script" >"$test_root/mismatch.stdout" 2>"$mismatch_stderr"; then
  printf 'patched-base architecture mismatch unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'image platform mismatch for test-patched:mismatch: requested linux/arm64, got linux/amd64' "$mismatch_stderr" >/dev/null

final_mismatch_log="$test_root/final-mismatch.log"
final_mismatch_state="$test_root/final-mismatch.state"
final_mismatch_stderr="$test_root/final-mismatch.stderr"
: >"$final_mismatch_log"
: >"$final_mismatch_state"
if env \
  "PATH=$fake_bin:$PATH" \
  "FAKE_DOCKER_LOG=$final_mismatch_log" \
  "FAKE_DOCKER_STATE=$final_mismatch_state" \
  "FAKE_DOCKER_SERVER_ARCH=aarch64" \
  "FAKE_DOCKER_PATCHED_IMAGE=test-patched:final-mismatch" \
  "FAKE_DOCKER_FINAL_IMAGE=test-final:final-mismatch" \
  "FAKE_DOCKER_FORCED_FINAL_ARCH=amd64" \
  "FAKE_DOCKER_REVISION=$revision" \
  "FAKE_DOCKER_VERSION=$version" \
  "CONTAINER_RUNTIME_PATCHED_BASE_IMAGE=test-patched:final-mismatch" \
  "CONTAINER_RUNTIME_IMAGE=test-final:final-mismatch" \
  "$script" >"$test_root/final-mismatch.stdout" 2>"$final_mismatch_stderr"; then
  printf 'final-image architecture mismatch unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'image platform mismatch for test-final:final-mismatch: requested linux/arm64, got linux/amd64' \
  "$final_mismatch_stderr" >/dev/null

printf 'container runtime smoke platform tests passed\n'
