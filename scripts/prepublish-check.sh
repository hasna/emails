#!/usr/bin/env bash
set -euo pipefail

tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
tmp_home="$(mktemp -d "$tmp_root/emails-prepublish.XXXXXX")"
mailery_auth_env="$(printf '%s_%s_%s' MAILERY API KEY)"
hasna_mailery_auth_env="$(printf '%s_%s_%s_%s' HASNA MAILERY API KEY)"

cleanup() {
  local status=$?
  if [[ -n "${tmp_home:-}" && -d "$tmp_home" && "$tmp_home" == "$tmp_root"/emails-prepublish.* ]]; then
    rm -rf -- "$tmp_home"
  else
    echo "Refusing to remove unsafe tmp_home: ${tmp_home:-<unset>}" >&2
    return 1
  fi
  return "$status"
}
trap cleanup EXIT

env \
  -u HASNA_MAILERY_API_URL \
  -u "$hasna_mailery_auth_env" \
  -u MAILERY_API_URL \
  -u "$mailery_auth_env" \
  "$(printf '%s=%s' HOME "$tmp_home")" \
  "$(printf '%s=%s' MAILERY_MODE local)" \
  "$(printf '%s=%s' HASNA_EMAILS_MODE local)" \
  "$(printf '%s=%s' HASNA_MAILERY_STORAGE_MODE local)" \
  "$(printf '%s=%s' EMAILS_DB_PATH :memory:)" \
  bun test

bun run build
bun run no-cloud:pack
