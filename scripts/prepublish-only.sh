#!/usr/bin/env bash
set -euo pipefail

tmp_home="$(mktemp -d "${TMPDIR:-/tmp}/emails-prepublish.XXXXXX")"
cleanup() {
  case "$tmp_home" in
    "${TMPDIR:-/tmp}"/emails-prepublish.*|/tmp/emails-prepublish.*)
      rm -rf -- "$tmp_home"
      ;;
    *)
      echo "Refusing to remove unexpected temporary HOME: $tmp_home" >&2
      ;;
  esac
}
trap cleanup EXIT

env \
  -u HASNA_EMAILS_API_URL \
  -u HASNA_EMAILS_API_KEY \
  -u HASNA_MAILERY_API_URL \
  -u HASNA_MAILERY_API_KEY \
  -u MAILERY_API_URL \
  -u MAILERY_API_KEY \
  HOME="$tmp_home" \
  HASNA_EMAILS_MODE=local \
  EMAILS_DB_PATH=:memory: \
  bun test

bun run build
bun run no-cloud:pack
