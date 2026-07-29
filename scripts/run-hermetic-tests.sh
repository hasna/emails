#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-shared}"
case "$mode" in
  shared|isolated) ;;
  *)
    echo "usage: $0 [shared|isolated]" >&2
    exit 2
    ;;
esac

mapfile -d '' -t test_files < <(
  find . \
    \( -path './.git' -o -path './node_modules' -o -path './dist' \) -prune -o \
    -type f \( \
      -name '*.test.js' -o -name '*.test.jsx' -o -name '*.test.ts' -o -name '*.test.tsx' -o \
      -name '*_test.js' -o -name '*_test.jsx' -o -name '*_test.ts' -o -name '*_test.tsx' -o \
      -name '*.spec.js' -o -name '*.spec.jsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' -o \
      -name '*_spec.js' -o -name '*_spec.jsx' -o -name '*_spec.ts' -o -name '*_spec.tsx' \
    \) -print0 |
    sort -z
)

if (("${#test_files[@]}" == 0)); then
  echo "No test files discovered" >&2
  exit 1
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

run_scrubbed() {
  local test_home="$1"
  shift
  env \
    -u MAILERY_MODE -u HASNA_MAILERY_MODE \
    -u MAILERY_STORAGE_MODE -u HASNA_MAILERY_STORAGE_MODE \
    -u EMAILS_STORAGE_MODE -u HASNA_EMAILS_STORAGE_MODE \
    -u MAILERY_API_URL -u MAILERY_API_KEY \
    -u HASNA_MAILERY_API_URL -u HASNA_MAILERY_API_KEY \
    -u HASNA_MAILERY_API_SIGNING_KEY -u HASNA_MAILERY_DATABASE_URL \
    -u MAILERY_CLOUD_API_URL -u MAILERY_CLOUD_TOKEN \
    -u HASNA_MAILERY_ENV_FILE -u HASNA_EMAILS_MODE \
    -u HASNA_EMAILS_DB_PATH -u HASNA_EMAILS_DATABASE_URL \
    -u EMAILS_SELF_HOSTED_URL -u EMAILS_SELF_HOSTED_API_KEY \
    -u EMAILS_SELF_HOSTED_HTTP_CONNECT_TIMEOUT \
    -u EMAILS_SELF_HOSTED_HTTP_TIMEOUT \
    -u EMAILS_SELF_HOSTED_HTTP_MAX_RESPONSE_BYTES \
    -u EMAILS_CLIENT_ENV_SECRET -u EMAILS_SESSION_TOKEN \
    -u EMAILS_PROVIDER_SECRETS_KEY -u EMAILS_PROVIDER_SECRETS_KEY_FILE \
    -u EMAILS_PROVIDER_SECRETS_KEY_PATH \
    -u EMAILS_IDP_TOKEN -u EMAILS_IDP_JWKS_URL \
    -u EMAILS_IDP_JWKS_CACHE_SECONDS \
    -u DATABASE_URL -u EMAILS_DATABASE_URL -u EMAILS_TEST_DATABASE_URL \
    -u EMAILS_DATABASE_CA_FILE -u EMAILS_API_SIGNING_KEY \
    -u EMAILS_POSTGRES_URL -u EMAILS_TEST_POSTGRES_URL \
    -u EMAILS_PG_POOL_MAX -u EMAILS_SEND_LEASE_SECONDS \
    -u EMAILS_SEND_PROVIDER \
    -u EMAILS_SES_ACCESS_KEY_ID -u EMAILS_SES_SECRET_ACCESS_KEY \
    -u EMAILS_SES_CONFIGURATION_SET -u EMAILS_SES_INBOUND_WEBHOOK_SECRET \
    -u EMAILS_SNS_TOPIC_ARN -u EMAILS_SNS_TOPIC_ARNS \
    -u EMAILS_AWS_ACCOUNT_ID -u EMAILS_AWS_ACCOUNT_IDS \
    -u EMAILS_INBOUND_S3_BUCKET -u EMAILS_INBOUND_WEBHOOK_SECRET \
    -u EMAILS_REQUIRE_SES_INBOUND_SECRET \
    -u EMAILS_INGEST_QUEUE_URL -u EMAILS_INGEST_S3_BUCKET \
    -u EMAILS_INGEST_S3_PREFIX -u EMAILS_INGEST_PREFIX_DOMAIN_MAP \
    -u EMAILS_INGEST_BACKFILL_LIMIT -u EMAILS_INGEST_BACKFILL_RECIPIENTS \
    -u EMAILS_ATTACHMENT_REPAIR_MANIFEST -u EMAILS_IMAGE_REVISION \
    -u EMAILS_MCP_HTTP_TOKEN -u EMAILS_MCP_ALLOWED_HOSTS \
    -u EMAILS_MCP_ALLOWED_ORIGINS -u MCP_HTTP_PORT \
    -u EMAILS_ALLOW_REMOTE -u EMAILS_DASHBOARD_ALLOWED_ORIGINS \
    -u HOST -u PORT -u USERPROFILE \
    -u EMAILS_PUBLIC_BASE_URL -u EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS \
    -u EMAILS_AUTH_FROM -u EMAILS_AUTH_PRODUCT_NAME \
    -u EMAILS_AUTH_VERIFY_URL_BASE -u EMAILS_AUTH_RESET_URL_BASE \
    -u EMAILS_AUTH_INVITE_URL_BASE \
    -u EMAILS_PRIMARY_SUPER_ADMIN_EMAIL \
    -u EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID \
    -u EMAILS_EMAIL_VERIFY_TTL_HOURS -u EMAILS_INVITE_TTL_HOURS \
    -u EMAILS_RESET_TTL_MINUTES -u EMAILS_SESSION_IDLE_TTL_DAYS \
    -u EMAILS_SESSION_ABSOLUTE_TTL_DAYS -u EMAILS_TRUSTED_PROXY_HOPS \
    -u EMAILS_JSON_OUTPUT \
    -u EMAILS_TUI_THEME -u EMAILS_TUI_CLIPBOARD_COMMAND \
    -u EMAILS_TUI_CLIPBOARD_COMMAND_TIMEOUT_MS \
    -u EMAILS_TUI_CLIPBOARD_DRY_RUN -u EMAILS_TUI_CLIPBOARD_HOST \
    -u EMAILS_TUI_CLIPBOARD_SSH_HOSTS \
    -u EMAILS_TUI_CLIPBOARD_SSH_TIMEOUT -u EMAILS_TUI_CLIPBOARD_OSC52 \
    -u OTUI_USE_ALTERNATE_SCREEN \
    -u V1_STUB_ALLOWED_EMAIL_DOMAIN -u V1_STUB_API_KEY \
    -u V1_STUB_LIST_ORDER -u V1_STUB_RESOURCE_DEFAULTS \
    -u V1_STUB_RESOURCE_SPECS -u V1_STUB_SEED \
    -u FORCE_COLOR -u ECS_CONTAINER_METADATA_URI_V4 \
    -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY \
    -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID \
    -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    -u AWS_PROFILE -u AWS_DEFAULT_PROFILE -u AWS_ACCOUNT_ID \
    -u AWS_REGION -u AWS_DEFAULT_REGION -u AWS_SHARED_CREDENTIALS_FILE \
    -u AWS_CONFIG_FILE -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
    -u AWS_ROLE_SESSION_NAME -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
    -u AWS_CONTAINER_CREDENTIALS_FULL_URI -u AWS_CONTAINER_AUTHORIZATION_TOKEN \
    -u EMAILS_AWS_REGION -u EMAILS_SES_AWS_PROFILE \
    -u RESEND_API_KEY -u RESEND_WEBHOOK_SECRET \
    AWS_EC2_METADATA_DISABLED=true \
    NO_COLOR=1 \
    PATH="$PATH" \
    HOME="$test_home" \
    EMAILS_MODE=local \
    EMAILS_DB_PATH=:memory: \
    "$@"
}

printf 'Discovered %d test files\n' "${#test_files[@]}"

if [[ "$mode" == "isolated" ]]; then
  for test_file in "${test_files[@]}"; do
    test_home="$(mktemp -d "$tmp_root/file.XXXXXX")"
    printf '\n=== %s ===\n' "$test_file"
    run_scrubbed "$test_home" bun test --max-concurrency 1 "$test_file"
  done
  exit 0
fi

shared_home="$(mktemp -d "$tmp_root/shared.XXXXXX")"
shared_output="$tmp_root/shared-output.log"
set +e
run_scrubbed "$shared_home" bun test --max-concurrency 1 2>&1 | tee "$shared_output"
test_status="${PIPESTATUS[0]}"
set -e

if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi

reported_files="$(
  sed -nE 's/^Ran [0-9]+ tests across ([0-9]+) files\..*$/\1/p' "$shared_output" |
    tail -n 1
)"
if [[ -z "$reported_files" ]]; then
  echo "Bun did not report the number of executed test files" >&2
  exit 1
fi
if [[ "$reported_files" -ne "${#test_files[@]}" ]]; then
  echo "Test discovery mismatch: repository=${#test_files[@]} bun=${reported_files}" >&2
  exit 1
fi
