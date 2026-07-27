#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$root/../.." && pwd)
cd "$root"
dockerfile="$repo/Dockerfile"

if ! grep -Fq 'ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0' "$dockerfile"; then
  echo "self-hosted container must pin the Alpine Bun image digest" >&2
  exit 1
fi

if grep -Eiq '(^|[[:space:]])(apt-get|\bdpkg\b|\bglibc\b|\bperl\b|\bsqlite\b|OPENSSL_VERSION)' "$dockerfile"; then
  echo "self-hosted container contract forbids Debian package tooling and legacy runtime dependencies" >&2
  exit 1
fi

if ! grep -Fxq 'FROM scratch' "$dockerfile"; then
  echo "self-hosted container must end in a scratch runtime" >&2
  exit 1
fi

if grep -Eq '^FROM[[:space:]]+base[[:space:]]+AS[[:space:]]+runtime[[:space:]]*$' "$dockerfile"; then
  echo "self-hosted runtime must not keep a non-scratch intermediate final runtime stage" >&2
  exit 1
fi

if grep -Fq 'locale-archive' "$dockerfile"; then
  echo "self-hosted container may not include locale fallback copy steps" >&2
  exit 1
fi

if grep -Fq '|| true' "$dockerfile"; then
  echo "self-hosted container may not contain permissive fallback copy commands" >&2
  exit 1
fi

if ! grep -Fq 'PATH=/usr/local/bin' "$dockerfile"; then
  echo "self-hosted runtime must include /usr/local/bin on PATH" >&2
  exit 1
fi

if ! grep -Fq 'ln -sf bun /runtime/usr/local/bin/bunx' "$dockerfile"; then
  echo "self-hosted runtime must expose bunx shim" >&2
  exit 1
fi

if ! grep -Fq 'ln -sf bun /runtime/usr/local/bin/node' "$dockerfile"; then
  echo "self-hosted runtime must expose node shim" >&2
  exit 1
fi

expected_scratch_copies='COPY --from=runtime-files /runtime/ /
COPY --chown=1000:1000 --from=build /app/node_modules /app/node_modules
COPY --chown=1000:1000 --from=build /app/package.json /app/package.json
COPY --chown=1000:1000 --from=build /app/src /app/src'
actual_scratch_copies=$(awk '/^FROM scratch$/ { scratch = 1; next } scratch && /^COPY / { print }' "$dockerfile")
if [ "$actual_scratch_copies" != "$expected_scratch_copies" ]; then
  echo "scratch runtime COPY instructions must match the exact runtime and build allowlist" >&2
  exit 1
fi

for image_metadata_contract in \
  'ARG VERSION=dev' \
  'ARG REVISION=unknown' \
  'org.opencontainers.image.source="https://github.com/hasna/emails"' \
  'org.opencontainers.image.version="$VERSION"' \
  'org.opencontainers.image.revision="$REVISION"'; do
  if ! grep -Fq "$image_metadata_contract" "$dockerfile"; then
    echo "missing immutable image metadata contract: $image_metadata_contract" >&2
    exit 1
  fi
done

runtime_files_stage=$(awk '/^FROM base AS runtime-files$/ { runtime = 1 } /^FROM scratch$/ { runtime = 0 } runtime { print }' "$dockerfile")

for scanner_inventory_contract in \
  'cp -a /etc/alpine-release /runtime/etc/alpine-release' \
  'order[1] = "libgcc"' \
  'order[2] = "libstdc++"' \
  'order[3] = "musl"' \
  'expected["libgcc"] = 1' \
  'expected["libstdc++"] = 1' \
  'expected["musl"] = 1' \
  'if (name in records)' \
  'if (!(name in records))' \
  'if (failed) exit 1' \
  'printf "%s\n\n", records[name]' \
  '/lib/apk/db/installed > /runtime/lib/apk/db/installed'; do
  if ! printf '%s\n' "$runtime_files_stage" | grep -Fq "$scanner_inventory_contract"; then
    echo "scratch runtime must preserve its exact Alpine scanner inventory: $scanner_inventory_contract" >&2
    exit 1
  fi
done

if printf '%s\n' "$runtime_files_stage" | grep -Fq 'cp -a /lib/apk/db/installed /runtime/lib/apk/db/installed'; then
  echo "scratch runtime scanner inventory must exclude packages absent from the final image" >&2
  exit 1
fi

for exact_openssl_revision in \
  "'libcrypto3=3.5.7-r0'" \
  "'libssl3=3.5.7-r0'" \
  "apk info --installed 'libcrypto3=3.5.7-r0'" \
  "apk info --installed 'libssl3=3.5.7-r0'"; do
  if ! grep -Fq "$exact_openssl_revision" "$dockerfile"; then
    echo "patched base must install and verify exact OpenSSL revisions: $exact_openssl_revision" >&2
    exit 1
  fi
done

if grep -Fq 'apk info --exists' "$dockerfile"; then
  echo "patched base must not use the unsupported apk info --exists flag" >&2
  exit 1
fi

if grep -Eq 'lib(crypto|ssl)3>=' "$dockerfile"; then
  echo "patched base OpenSSL constraints must be exact, not minimum floors" >&2
  exit 1
fi

for runtime_identity in \
  "/runtime/home/bun/.hasna/emails /runtime/etc" \
  "printf '%s\\n' 'bun:x:1000:1000:Bun:/home/bun:/sbin/nologin' > /runtime/etc/passwd" \
  "printf '%s\\n' 'bun:x:1000:' > /runtime/etc/group" \
  "chmod 0644 /runtime/etc/passwd /runtime/etc/group"; do
  if ! printf '%s\n' "$runtime_files_stage" | grep -Fq "$runtime_identity"; then
    echo "missing required scratch runtime identity contract: $runtime_identity" >&2
    exit 1
  fi
done

if ! grep -Fq 'chmod 1777 /runtime/tmp' "$dockerfile" || ! grep -Fq 'chmod 0700 /runtime/home/bun/.hasna/emails' "$dockerfile"; then
  echo "self-hosted runtime must harden tmp and private state permissions" >&2
  exit 1
fi

if ! grep -Fq 'VOLUME ["/tmp"]' "$dockerfile"; then
  echo "ECS /tmp mount must inherit image permissions through a Dockerfile VOLUME" >&2
  exit 1
fi

if ! grep -Fq 'chown -R 1000:1000 /runtime/home/bun /runtime/home/bun/.hasna/emails /runtime/app /runtime/app/data' "$dockerfile"; then
  echo "self-hosted runtime must chown runtime ownership for bun home and app data" >&2
  exit 1
fi

if ! grep -Fq 'USER 1000:1000' "$dockerfile"; then
  echo "self-hosted container must run as numeric user 1000:1000" >&2
  exit 1
fi

if grep -Eq '"?command"?[[:space:]]*[:=][[:space:]]*\[[[:space:]]*"(bun|run|build|test|x|exec|repl|install|i|add|a|remove|rm|update|outdated|link|unlink|pm|patch|patch-commit|init|create|c|upgrade|audit|why|publish|info|deploy)"' \
  "$root/compute.tf" "$repo/docker-compose.yml" "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  # ENTRYPOINT ["/usr/local/bin/bun"] means each command override is arguments to
  # bun. A first token of "bun" or a Bun subcommand (e.g. "build") makes the image
  # run "bun build src/server/index.ts", which bundles the server for the browser
  # target and crashes on boot ("Browser build cannot import bun:sqlite"). Command
  # overrides must be a runnable src/ entrypoint path, never a Bun subcommand.
  echo "container command overrides must not hijack the Bun image entrypoint with a subcommand (e.g. build)" >&2
  exit 1
fi

if find . -type f \
  ! -path './tests/*' \
  ! -path './.terraform/*' \
  -exec grep -Ein 'hasna[.]xyz|mailery[.]co|MAILERY|HASNA_EMAILS|HASNA_MAILERY|API_KEY_SIGNING_SECRET' {} \; \
  | grep -q .; then
  echo "forbidden hosted-service coupling found" >&2
  exit 1
fi

if grep -En 'name[[:space:]]*=[[:space:]]*"DATABASE_URL"|\["mailery|\["mailery-serve' compute.tf >/dev/null; then
  echo "legacy command or generic secret environment found" >&2
  exit 1
fi

if ! grep -Eq 'name[[:space:]]*=[[:space:]]*"EMAILS_INGEST_PREFIX_DOMAIN_MAP"' compute.tf >/dev/null \
  || ! grep -F 'inbound_prefix_domain_map_json' compute.tf >/dev/null; then
  echo "worker must receive the validated Terraform prefix/domain routing map" >&2
  exit 1
fi
for map_prefix_validation in \
  'length(prefix) > 1' \
  'trimspace(prefix) == prefix' \
  'endswith(prefix, "/")' \
  'can(regex("^[^[:cntrl:]]+/$", prefix))'; do
  grep -F "$map_prefix_validation" variables.tf >/dev/null || {
    echo "inbound_prefix_domain_map must match the worker's canonical prefix contract: $map_prefix_validation" >&2
    exit 1
  }
done
for map_domain_validation in \
  'domain == lower(trimspace(domain))' \
  'can(regex("^(?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:[.](?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$", domain))'; do
  grep -F "$map_domain_validation" variables.tf >/dev/null || {
    echo "inbound_prefix_domain_map must map canonical lowercase domains: $map_domain_validation" >&2
    exit 1
  }
done

if ! grep -F 'for prefix_index, prefix in sort(keys(var.inbound_prefix_domain_map))' variables.tf >/dev/null \
  || ! grep -F 'for other_index, other_prefix in sort(keys(var.inbound_prefix_domain_map))' variables.tf >/dev/null \
  || ! grep -F 'prefix_index == other_index || !startswith(prefix, other_prefix)' variables.tf >/dev/null \
  || grep -F 'for index, prefix in sort(keys(var.inbound_prefix_domain_map))' variables.tf >/dev/null \
  || grep -F 'index == 0 || !startswith(prefix, sort(keys(var.inbound_prefix_domain_map))[index - 1])' variables.tf >/dev/null; then
  echo "inbound_prefix_domain_map must validate non-overlapping canonical prefixes with pairwise predicates" >&2
  exit 1
fi

if ! printf '%s\n' 'a/' 'a/b/' 'a/c/' | awk '
  BEGIN {
    n = split("a/,a/b/,a/c/", map, ",");
    overlap = 0;
  }
  {
    prefixes[NR] = $1
  }
  END {
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= n; j++) {
        if (i == j) {
          continue
        }
        if (substr(prefixes[j], 1, length(prefixes[i])) == prefixes[i]) {
          overlap = 1
        }
      }
    }
    if (!overlap) {
      exit 1
    }
  }
' >/dev/null; then
  echo "non-adjacent overlap counterexample (a/, a/b/, a/c/) must exist as a true overlap case" >&2
  exit 1
fi

worker_statement_is_gated() {
  awk -v wanted_sid="$1" '
    function brace_delta(value, copy, opens, closes) {
      copy = value
      opens = gsub(/\{/, "", copy)
      copy = value
      closes = gsub(/\}/, "", copy)
      return opens - closes
    }

    /^[[:space:]]*dynamic[[:space:]]+"statement"[[:space:]]*\{/ {
      in_statement = 1
      depth = 0
      gated = 0
      matched_sid = 0
    }

    in_statement {
      if ($0 ~ /^[[:space:]]*for_each[[:space:]]*=[[:space:]]*var[.]enable_ses_inbound/) {
        gated = 1
      }
      sid_pattern = "sid[[:space:]]*=[[:space:]]*\"" wanted_sid "\""
      if ($0 ~ sid_pattern) {
        matched_sid = 1
      }
      depth += brace_delta($0)
      if (depth == 0) {
        if (gated && matched_sid) {
          found = 1
        }
        in_statement = 0
      }
    }

    END { exit found ? 0 : 1 }
  ' iam.tf
}

for sid in ReadInboundBucket ReadInboundObjects ConsumeInboundQueue DecryptInboundData; do
  if ! worker_statement_is_gated "$sid"; then
    echo "worker permission $sid is not gated by enable_ses_inbound" >&2
    exit 1
  fi
done

if find . -type f \
  ! -path './tests/*' \
  ! -path './examples/*' \
  ! -path './.terraform/*' \
  -exec grep -En 'arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}' {} \; \
  | grep -q .; then
  echo "concrete AWS account ARN found outside test/example fixtures" >&2
  exit 1
fi

if find . -type f -name '*.tf' \
  -exec grep -En 'resource[[:space:]]+"aws_ses_active_receipt_rule_set"' {} \; \
  | grep -q .; then
  echo "Terraform must not activate the account-global SES receipt rule set" >&2
  exit 1
fi

if find . -type f -name '*.tf' \
  -exec grep -En 'resource[[:space:]]+"aws_secretsmanager_secret_version"' {} \; \
  | grep -q .; then
  echo "Terraform must not place secret values in state" >&2
  exit 1
fi

if grep -En '^[[:space:]]+(ingress|egress)[[:space:]]*\{' network.tf >/dev/null; then
  echo "inline security-group rules are forbidden; use standalone rule resources" >&2
  exit 1
fi

rollback_assignments="$(grep -Fc 'rollback = var.enable_automatic_deployment_rollback' compute.tf || true)"
if [ "$rollback_assignments" != "2" ]; then
  echo "API and worker rollback must both use the explicit automatic-rollback gate" >&2
  exit 1
fi

for cutover_output in \
  'output "api_service_name"' \
  'output "worker_service_name"' \
  'output "api_task_definition_arn"' \
  'output "worker_task_definition_arn"'; do
  grep -Fq "$cutover_output" outputs.tf || {
    echo "safe 0017 cutover output missing: $cutover_output" >&2
    exit 1
  }
done

rollback_migration_guards="$(grep -Fc '!var.enable_automatic_deployment_rollback || var.migrations_complete' compute.tf || true)"
if [ "$rollback_migration_guards" != "2" ]; then
  echo "API and worker must both reject automatic rollback before migrations_complete" >&2
  exit 1
fi

if ! awk '
  /^variable "enable_automatic_deployment_rollback" \{/ { in_variable = 1; depth = 0; safe_default = 0 }
  in_variable {
    depth += gsub(/\{/, "{") - gsub(/\}/, "}")
    if ($0 ~ /^[[:space:]]*default[[:space:]]*=[[:space:]]*false[[:space:]]*$/) safe_default = 1
    if (depth == 0) exit safe_default ? 0 : 1
  }
  END { if (!in_variable) exit 1 }
' variables.tf; then
  echo "automatic deployment rollback must default to false for the sealed cutover" >&2
  exit 1
fi

if grep -En 'http://' outputs.tf >/dev/null; then
  echo "client endpoint outputs must be HTTPS-only" >&2
  exit 1
fi

if find . -type f -name '*.tf' \
  -exec grep -En '^check[[:space:]]+"' {} \; \
  | grep -q .; then
  echo "nonblocking Terraform check blocks are forbidden for safety contracts" >&2
  exit 1
fi

workflow_dir="$repo/.github/workflows"
workflow="$workflow_dir/terraform-aws-validate.yml"
product_workflow="$workflow_dir/ci.yml"
provenance_workflow="$workflow_dir/package-provenance.yml"
changelog="$repo/CHANGELOG.md"
test -f "$workflow" || { echo "CI-safe Terraform workflow missing" >&2; exit 1; }
test -f "$product_workflow" || { echo "product CI workflow missing" >&2; exit 1; }
test -f "$provenance_workflow" || { echo "package provenance workflow missing" >&2; exit 1; }
test -f "$changelog" || { echo "changelog missing" >&2; exit 1; }

expected_workflows='ci.yml
package-provenance.yml
terraform-aws-validate.yml'
actual_workflows="$(
  find "$workflow_dir" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) \
    | sed 's#^.*/##' \
    | sort
)"
if [ "$actual_workflows" != "$expected_workflows" ]; then
  echo "only ci.yml, package-provenance.yml, and terraform-aws-validate.yml are allowed" >&2
  exit 1
fi

expected_provenance_sha256='706c636d7b60059f6e8ce52229bfb723c0c9a2c61cb4a462b3d6ead24a46232f'
actual_provenance_sha256="$(sha256sum "$provenance_workflow" | awk '{ print $1 }')"
if [ "$actual_provenance_sha256" != "$expected_provenance_sha256" ]; then
  echo "package provenance workflow must match the exact reviewed manual attestation artifact" >&2
  exit 1
fi

grep -Fq '".github/workflows/**"' "$workflow" || {
  echo "workflow changes must trigger the static legacy-workflow guard" >&2
  exit 1
}

grep -Fq 'terraform providers lock -platform=darwin_arm64 -platform=linux_amd64' "$workflow" || {
  echo "Terraform CI must verify both development and hosted-runner provider checksums" >&2
  exit 1
}

if grep -En 'id-token:[[:space:]]*write|configure-aws-credentials|amazon-ecr-login|role-to-assume|aws configure' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "validation workflows must not request AWS credentials or OIDC" >&2
  exit 1
fi

if grep -En '^[[:space:]]*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[[:space:]]*:' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "workflows must not provide AWS credential environment values" >&2
  exit 1
fi

if grep -En '(^|[^[:alnum:]_])(terraform|tofu)[[:space:]]+(apply|destroy)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_])(npm|bun|pnpm|yarn)[[:space:]]+publish([^[:alnum:]_-]|$)|ecs[[:space:]]+update-service' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "validation workflows must not apply, destroy, publish, or deploy" >&2
  exit 1
fi

for allowed_workflow in "$workflow" "$product_workflow" "$provenance_workflow"; do
  uses_count="$(grep -Ec 'uses:' "$allowed_workflow" || true)"
  pinned_uses_count="$(grep -Ec 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}([[:space:]]+#.*)?$' "$allowed_workflow" || true)"
  if [ "$uses_count" != "$pinned_uses_count" ]; then
    echo "every workflow action must be pinned to an immutable commit SHA" >&2
    exit 1
  fi
done

provenance_trigger="$(
  awk '
    /^"on":[[:space:]]*$/ { capture = 1 }
    capture { print }
    capture && /^jobs:[[:space:]]*$/ { exit }
  ' "$provenance_workflow"
)"
expected_provenance_trigger='"on":
  workflow_dispatch:

jobs:'
if [ "$(grep -Fxc '"on":' "$provenance_workflow" || true)" != "1" ] \
  || [ "$(grep -Fxc 'jobs:' "$provenance_workflow" || true)" != "1" ] \
  || [ "$provenance_trigger" != "$expected_provenance_trigger" ]; then
  echo "package provenance must be manual workflow_dispatch only" >&2
  exit 1
fi

provenance_job_ids="$(
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; next }
    in_jobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      job_id = $0
      sub(/^  /, "", job_id)
      sub(/:[[:space:]]*$/, "", job_id)
      print job_id
    }
  ' "$provenance_workflow"
)"
if [ "$provenance_job_ids" != "attest-published-package" ]; then
  echo "package provenance must contain only the guarded attestation job" >&2
  exit 1
fi

provenance_guard="    if: github.repository == 'hasna/emails' && github.ref == 'refs/heads/main'"
if [ "$(grep -Fxc "$provenance_guard" "$provenance_workflow" || true)" != "1" ]; then
  echo "package provenance must have the exact hasna/emails main-branch guard" >&2
  exit 1
fi

if [ "$(grep -Ec '^[[:space:]]*permissions:[[:space:]]*$' "$provenance_workflow" || true)" != "1" ]; then
  echo "package provenance must declare exactly one permissions block" >&2
  exit 1
fi
provenance_permissions="$(
  awk '
    /^    permissions:[[:space:]]*$/ { capture = 1; next }
    capture && /^      [a-z-]+:[[:space:]]*[a-z]+[[:space:]]*$/ { print; next }
    capture { exit }
  ' "$provenance_workflow"
)"
expected_provenance_permissions='      actions: read
      contents: read
      id-token: write
      attestations: write'
if [ "$provenance_permissions" != "$expected_provenance_permissions" ]; then
  echo "package provenance permissions must be limited to actions/contents read and attestation identity writes" >&2
  exit 1
fi

expected_provenance_steps='Verify source and CI evidence
Download and verify published tarball
Create release evidence predicate
Attest downloaded npm tarball'
actual_provenance_steps="$(
  sed -n 's/^      - name: //p' "$provenance_workflow"
)"
if [ "$actual_provenance_steps" != "$expected_provenance_steps" ]; then
  echo "package provenance must contain only the exact reviewed verification and attestation steps" >&2
  exit 1
fi

if [ "$(grep -Ec '^[[:space:]]+uses:' "$provenance_workflow" || true)" != "1" ] \
  || [ "$(grep -Fxc '        uses: actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4.2.0' "$provenance_workflow" || true)" != "1" ]; then
  echo "package provenance must use only the exact actions/attest v4.2.0 commit" >&2
  exit 1
fi

if [ "$(grep -Fxc '          GH_TOKEN: ${{ github.token }}' "$provenance_workflow" || true)" != "1" ] \
  || [ "$(grep -Eoc '\$\{\{[^}]+\}\}' "$provenance_workflow" || true)" != "1" ] \
  || grep -Ein 'secrets([.]|\[)|set[[:space:]]+-x|printenv|(^|[[:space:]])env([[:space:]]|$)' \
    "$provenance_workflow" >/dev/null; then
  echo "package provenance must expose only github.token to gh without printing token-bearing environment" >&2
  exit 1
fi

for provenance_live_verification_contract in \
  "readonly repository='hasna/emails'" \
  "readonly source_merge_commit='fe61a466a28115f33efda1ecc7632dbc7c6525c7'" \
  "readonly ci_run_id='30212897836'" \
  'command -v gh >/dev/null' \
  'command -v jq >/dev/null' \
  'verification_dir="$(mktemp -d)"' \
  'readonly verification_dir' \
  'trap cleanup_verification EXIT' \
  '"/repos/${repository}/commits/${source_merge_commit}"' \
  '"/repos/${repository}/actions/runs/${ci_run_id}"' \
  '.sha == $source_merge_commit' \
  '.id == $ci_run_id' \
  '.repository.full_name == $repository' \
  '.head_repository.full_name == $repository' \
  '.head_sha == $source_merge_commit' \
  '.status == "completed"' \
  '.conclusion == "success"' \
  '.event == "push"' \
  '.head_branch == "main"' \
  '.path == ".github/workflows/ci.yml"'; do
  grep -Fq -- "$provenance_live_verification_contract" "$provenance_workflow" || {
    echo "package provenance live source/CI verification missing: $provenance_live_verification_contract" >&2
    exit 1
  }
done
if grep -Fq 'readonly verification_dir="$(mktemp -d)"' "$provenance_workflow"; then
  echo "package provenance must preserve temporary-directory assignment failures" >&2
  exit 1
fi
if [ "$(grep -Ec '^[[:space:]]*gh api[[:space:]]*\\$' "$provenance_workflow" || true)" != "2" ] \
  || [ "$(grep -Ec '^[[:space:]]*jq --exit-status' "$provenance_workflow" || true)" != "3" ]; then
  echo "package provenance must perform exactly two GitHub API reads and three jq validations" >&2
  exit 1
fi

for provenance_download_contract in \
  "readonly tarball_url='https://registry.npmjs.org/@hasna/emails/-/emails-1.3.2.tgz'" \
  'curl --disable' \
  '--fail' \
  "--proto '=https'" \
  "--proto-redir '=https'" \
  '--tlsv1.2' \
  '--output "$artifact"' \
  '"$tarball_url"'; do
  grep -Fq -- "$provenance_download_contract" "$provenance_workflow" || {
    echo "package provenance TLS registry download contract missing: $provenance_download_contract" >&2
    exit 1
  }
done
if [ "$(grep -Ec '^[[:space:]]*curl([[:space:]]|$)' "$provenance_workflow" || true)" != "1" ] \
  || grep -En -- 'http://|--request|--data|--form|--upload-file|--user|--header|(^|[[:space:]])-[[:alpha:]]*k[[:alpha:]]*([[:space:]]|\\|$)|(^|[[:space:]])--insecure([[:space:]]|\\|$)' \
    "$provenance_workflow" >/dev/null; then
  echo "package provenance must perform one read-only TLS registry download" >&2
  exit 1
fi

for provenance_integrity_contract in \
  "readonly expected_sha256='8f5e166e73ae7aebeb49a5eeae6dd199d0be63a9931a35981373e67b9ccfe431'" \
  "readonly expected_shasum='87c933255f5e95e7db8bf30bb606e07c1132f01e'" \
  "readonly expected_integrity='sha512-nGwS4AoZH2NwTV8Xoop2XupAubyq4bHuawYZX5itCjVwa/3U4hE6t+tBdnKZ9p72/BuUxmAL4iLEZ79eWlkCHg=='" \
  'sha256sum --check --strict' \
  'sha1sum --check --strict' \
  'actual_integrity="sha512-$(openssl dgst -sha512 -binary "$artifact" | openssl base64 -A)"' \
  'if [[ "$actual_integrity" != "$expected_integrity" ]]; then'; do
  grep -Fq -- "$provenance_integrity_contract" "$provenance_workflow" || {
    echo "package provenance npm digest verification missing: $provenance_integrity_contract" >&2
    exit 1
  }
done

for provenance_predicate_contract in \
  "readonly predicate='attestation-input/npm-release-evidence.json'" \
  'cat >"$predicate" <<'\''JSON'\''' \
  '"kind": "npm-release-evidence"' \
  '"subjectBuiltByThisWorkflow": false' \
  '"subjectPublishedByThisWorkflow": false' \
  'jq --exit-status' \
  'subject-path: attestation-input/emails-1.3.2.tgz' \
  'predicate-type: https://github.com/hasna/emails/attestations/npm-release-evidence/v1' \
  'predicate-path: attestation-input/npm-release-evidence.json' \
  'push-to-registry: false' \
  'create-storage-record: false'; do
  grep -Fq -- "$provenance_predicate_contract" "$provenance_workflow" || {
    echo "package provenance custom predicate contract missing: $provenance_predicate_contract" >&2
    exit 1
  }
done

# This is the SECOND copy of the changelog boundary contract; `src/workflow-contract.test.ts`
# holds the first. Both must be moved in the same commit, and both pin the same digests —
# `changelog_section` below extracts byte-identically to that file's `markdownSection`.
changelog_section() {
  awk -v heading="$1" '
    $0 == heading { capture = 1 }
    capture && /^## / && $0 != heading { exit }
    capture { print }
  ' "$changelog"
}
changelog_section_sha256() {
  printf '%s' "$(changelog_section "$1")" | sha256sum | awk '{ print $1 }'
}
# Frozen deliberately: `3cbd39c` reassigned ~36 already-released 1.3.2 entries to
# `[Unreleased]` 44 minutes after 1.3.2 published, and the previous digests pinned that wrong
# boundary. The 1.3.2 section is now frozen whole (47 lines, byte-identical to what `fe61a46`
# published) rather than as the two bullets it had been narrowed to, and 1.4.0 is frozen too so
# the same reassignment cannot happen to the next release.
expected_unreleased_sha256='1da42e1a6a94b4180d823a144c4da54b6e03cff194335ac64be15f4de53c33f4'
expected_release_140_sha256='4f038ad87a35a70bbdc8501549b359010511c2c0efaa2f55d162c2e359b45531'
expected_release_132_sha256='719b031270908506ac34b273a232384c81fbfaa00e3ecf9e6e4e3508fb8e6421'
expected_release_132_opening='## 1.3.2 (2026-07-26)

- fail closed on malformed JSON, wrong response envelopes, and missing required
  fields from successful self-hosted API responses before repositories, mailbox
  status/context/sync projections, or the generated SDK can synthesize empty
  rows, lists, or counts.
- share one config-driven wire validator across the synchronous resource store,
  asynchronous inbox data source, and generated `@hasna/emails/selfhost` client;
  validation errors identify the endpoint and invalid field without including
  credentials or response-body contents.'
release_132_section="$(changelog_section '## 1.3.2 (2026-07-26)')"
release_132_opening="$(printf '%s\n' "$release_132_section" | head -n 10)"
actual_unreleased_sha256="$(changelog_section_sha256 '## [Unreleased]')"
actual_release_140_sha256="$(changelog_section_sha256 '## 1.4.0 (2026-07-27)')"
actual_release_132_sha256="$(changelog_section_sha256 '## 1.3.2 (2026-07-26)')"
unreleased_line="$(grep -Fn '## [Unreleased]' "$changelog" | cut -d: -f1)"
release_140_line="$(grep -Fn '## 1.4.0 (2026-07-27)' "$changelog" | cut -d: -f1)"
release_132_line="$(grep -Fn '## 1.3.2 (2026-07-26)' "$changelog" | cut -d: -f1)"
release_131_line="$(grep -Fn '## 1.3.1 (2026-07-26)' "$changelog" | cut -d: -f1)"
if [ "$(grep -Fxc '## [Unreleased]' "$changelog" || true)" != "1" ] \
  || [ "$(grep -Fxc '## 1.4.0 (2026-07-27)' "$changelog" || true)" != "1" ] \
  || [ "$(grep -Fxc '## 1.3.2 (2026-07-26)' "$changelog" || true)" != "1" ] \
  || [ -z "$unreleased_line" ] \
  || [ -z "$release_140_line" ] \
  || [ -z "$release_132_line" ] \
  || [ -z "$release_131_line" ] \
  || [ "$unreleased_line" -ge "$release_140_line" ] \
  || [ "$release_140_line" -ge "$release_132_line" ] \
  || [ "$release_132_line" -ge "$release_131_line" ] \
  || [ "$actual_unreleased_sha256" != "$expected_unreleased_sha256" ] \
  || [ "$actual_release_140_sha256" != "$expected_release_140_sha256" ] \
  || [ "$actual_release_132_sha256" != "$expected_release_132_sha256" ] \
  || [ "$release_132_opening" != "$expected_release_132_opening" ]; then
  echo "each published changelog section must match its frozen digest, in Unreleased/1.4.0/1.3.2/1.3.1 order" >&2
  exit 1
fi

for runbook in "$repo/docs/DEPLOYMENT_CUTOVER.md" "$root/README.md"; do
  for phrase in \
    "migration 0016" \
    "every old API, worker, ingest" \
    "Drain and stop all of them" \
    "new-code-compatible migrator" \
    "Start only tenant-aware new-code writers" \
    "pre-tenancy" \
    "unscoped image" \
    "Roll forward" \
    "enable_automatic_deployment_rollback = false" \
    "enable_automatic_deployment_rollback = true"; do
    grep -Fiq "$phrase" "$runbook" || {
      echo "tenant-sealing migration contract missing '$phrase' from $runbook" >&2
      exit 1
    }
  done
done

cutover_text="$(tr '\n' ' ' < "$repo/docs/DEPLOYMENT_CUTOVER.md")"
for release_input_runbook in \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" \
  "$root/README.md"; do
  if grep -En '(^|[^[:digit:]])[[:digit:]]+[.][[:digit:]]+[.][[:digit:]]+([^[:digit:]]|$)|IMAGE_[[:digit:]]+' \
    "$release_input_runbook" >/dev/null; then
    echo "0020 runbooks must use release inputs instead of stale hardcoded release literals" >&2
    exit 1
  fi
done

for release_order_runbook in "$repo/docs/DEPLOYMENT_CUTOVER.md"; do
  for release_order_marker in \
    "## Fail-closed release-order preflight" \
    "RELEASE_PR_NUMBER" \
    "NPM_PACKAGE" \
    "NPM_REGISTRY" \
    'test "$NPM_REGISTRY" = "https://registry.npmjs.org"' \
    "HOSTED_CI_WORKFLOWS=(ci.yml terraform-aws-validate.yml)" \
    'test "${#HOSTED_CI_WORKFLOWS[@]}" -eq 2' \
    'test "${HOSTED_CI_WORKFLOWS[0]}" = "ci.yml"' \
    'test "${HOSTED_CI_WORKFLOWS[1]}" = "terraform-aws-validate.yml"' \
    'for HOSTED_CI_WORKFLOW in "${HOSTED_CI_WORKFLOWS[@]}"; do' \
    'SOURCE_ORIGIN_URL="$(git -C "$SOURCE_CHECKOUT" remote get-url origin)"' \
    '"https://github.com/hasna/emails.git"|"git@github.com:hasna/emails.git"' \
    'git -C "$SOURCE_CHECKOUT" fetch --quiet --no-tags origin main' \
    'git -C "$SOURCE_CHECKOUT" merge-base --is-ancestor "$RELEASE_COMMIT" "$ORIGIN_MAIN_COMMIT"' \
    '.merge_commit_sha == $release_commit' \
    'actions/workflows/$HOSTED_CI_WORKFLOW/runs?head_sha=$RELEASE_COMMIT' \
    '.head_sha == $release_commit' \
    '.head_branch == "main"' \
    '.conclusion == "success"' \
    "MATCHED_HOSTED_CI_RUN_JSON" \
    ".updated_at" \
    "LATEST_HOSTED_CI_UPDATED_EPOCH" \
    'RELEASE_WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/emails-release-worktree.XXXXXXXX")"' \
    'NPM_PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/emails-release-pack.XXXXXXXX")"' \
    "cleanup_release_preflight()" \
    'git -C "$SOURCE_CHECKOUT" worktree remove --force "$RELEASE_WORKTREE"' \
    'rm -rf -- "$RELEASE_WORKTREE_PARENT"' \
    'rm -rf -- "$NPM_PACK_DIR"' \
    'git -C "$SOURCE_CHECKOUT" worktree add --detach "$RELEASE_WORKTREE" "$RELEASE_COMMIT"' \
    'RELEASE_WORKTREE_COMMIT="$(git -C "$RELEASE_WORKTREE" rev-parse --verify '"'"'HEAD^{commit}'"'"')"' \
    'test "$RELEASE_WORKTREE_COMMIT" = "$RELEASE_COMMIT"' \
    'RELEASE_HOME="$RELEASE_WORKTREE_PARENT/home"' \
    'RELEASE_XDG_CONFIG_HOME="$RELEASE_WORKTREE_PARENT/xdg-config"' \
    'RELEASE_XDG_CACHE_HOME="$RELEASE_WORKTREE_PARENT/xdg-cache"' \
    'mkdir -p -- "$RELEASE_HOME" "$RELEASE_XDG_CONFIG_HOME" "$RELEASE_XDG_CACHE_HOME"' \
    'git -C "$RELEASE_WORKTREE" status --porcelain=v1 --untracked-files=all' \
    'HOME="$RELEASE_HOME"' \
    'XDG_CONFIG_HOME="$RELEASE_XDG_CONFIG_HOME"' \
    'XDG_CACHE_HOME="$RELEASE_XDG_CACHE_HOME"' \
    'bun install --frozen-lockfile --ignore-scripts' \
    'test ! -e "$RELEASE_HOME/.hasna/emails"' \
    'npm view "$NPM_PACKAGE@$RELEASE_VERSION" --json --registry "$NPM_REGISTRY"' \
    "EXPECTED_NPM_TARBALL_URL" \
    ".dist.integrity" \
    'test("^sha512-[A-Za-z0-9+/]+={0,2}$")' \
    '.dist.tarball == $tarball_url' \
    'npm pack --json --pack-destination "$NPM_PACK_DIR" --registry "$NPM_REGISTRY" "$RELEASE_WORKTREE"' \
    "NPM_PACK_OUTPUT_FILE" \
    "NPM_PACK_JSON_START_LINE" \
    'tail -n +"$NPM_PACK_JSON_START_LINE"' \
    '.integrity == $registry_integrity' \
    'test -f "$NPM_PACK_PATH"' \
    'npm view "$NPM_PACKAGE" time --json --registry "$NPM_REGISTRY"' \
    "NPM_PUBLISHED_AT" \
    "NPM_PUBLISHED_EPOCH" \
    'test "$NPM_PUBLISHED_EPOCH" -gt "$LATEST_HOSTED_CI_UPDATED_EPOCH"' \
    "AWS deployment is prohibited" \
    "Manual publishing and AWS deployment remain separate, manual, PR-first actions."; do
    grep -Fq "$release_order_marker" "$release_order_runbook" || {
      echo "release-order contract missing '$release_order_marker' from $release_order_runbook" >&2
      exit 1
    }
  done

  if grep -Eq 'NPM_PROVENANCE_PREDICATE_TYPE|NPM_ATTESTATIONS|resolvedDependencies|base64 --decode|:[[:space:]]*"\$\{HOSTED_CI_WORKFLOW:|[.]gitHead|completed_at' \
    "$release_order_runbook"; then
    echo "release-order contract must use registry artifact integrity, not unavailable publish provenance" >&2
    exit 1
  fi

  if test "$(grep -Fo -- '--ignore-scripts' "$release_order_runbook" | wc -l)" -ne 1; then
    echo "release-order contract must ignore scripts only during the isolated Bun install" >&2
    exit 1
  fi

  if grep -E 'npm pack.*--ignore-scripts|--ignore-scripts.*npm pack' \
    "$release_order_runbook" >/dev/null; then
    echo "release-order npm pack must keep prepack and build lifecycle scripts enabled" >&2
    exit 1
  fi

  if grep -Fq 'npm pack --json --pack-destination "$NPM_PACK_DIR" --registry "$NPM_REGISTRY" "$SOURCE_CHECKOUT"' \
    "$release_order_runbook"; then
    echo "release-order package integrity must come from the detached release worktree" >&2
    exit 1
  fi

  if test "$(grep -Fc 'git -C "$RELEASE_WORKTREE" status --porcelain=v1 --untracked-files=all' \
    "$release_order_runbook")" != "3"; then
    echo "release-order detached worktree must be clean before install, after install, and after pack" >&2
    exit 1
  fi

  if grep -E 'npm[[:space:]]+(view|pack)([[:space:]]|$)' "$release_order_runbook" \
    | grep -Fv -- '--registry "$NPM_REGISTRY"' >/dev/null; then
    echo "release-order npm checks must pin the canonical public registry" >&2
    exit 1
  fi

  if grep -Fq 'SOURCE_HEAD=' "$release_order_runbook"; then
    echo "release-order contract must not use checkout or branch HEAD as release authority" >&2
    exit 1
  fi

  release_order_preflight_line="$(
    grep -nF '## Fail-closed release-order preflight' "$release_order_runbook" | head -1 | cut -d: -f1
  )"
  release_order_deploy_line="$(
    grep -nE '## Manual AWS deployment|rehearsal_terraform apply|rehearsal_aws ecs (run-task|update-service)' \
      "$release_order_runbook" | head -1 | cut -d: -f1
  )"
  test -n "$release_order_preflight_line" && test -n "$release_order_deploy_line" \
    && test "$release_order_preflight_line" -lt "$release_order_deploy_line" || {
      echo "release-order preflight must precede every AWS deployment boundary in $release_order_runbook" >&2
      exit 1
    }
done

for release_input in \
  "@hasna/emails" \
  "RELEASE_VERSION" \
  "RELEASE_COMMIT" \
  "SOURCE_ARCHIVE_SHA256" \
  "IMAGE_REPOSITORY" \
  "IMAGE_DIGEST" \
  "IMAGE_REFERENCE"; do
  grep -Fq "$release_input" "$root/README.md" || {
    echo "AWS README must bind the 0020 cutover to verified immutable release input $release_input" >&2
    exit 1
  }
done

for source_contract in \
  'applied: string[]' \
  'alreadyApplied: string[]' \
  'pending: string[]' \
  'const ledger = new MigrationLedger(client, migrations)' \
  'const result = await ledger.migrate({ dryRun: opts.dryRun === true })'; do
  grep -Fq "$source_contract" "$repo/src/server/self-hosted/migrate.ts" || {
    echo "db status source contract missing '$source_contract'" >&2
    exit 1
  }
done
grep -Fq 'Migration checksum mismatch' "$repo/src/storage-kit/migrations.ts" || {
  echo "db status must fail before JSON output when an applied checksum is invalid" >&2
  exit 1
}

for phrase in \
  "migration 0017" \
  "SOURCE_CHECKOUT" \
  "RELEASE_VERSION" \
  "RELEASE_COMMIT" \
  "SOURCE_ARCHIVE_SHA256" \
  "IMAGE_REPOSITORY" \
  "IMAGE_DIGEST" \
  "IMAGE_REFERENCE" \
  'test "$IMAGE_REFERENCE" = "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"' \
  'git -C "$SOURCE_CHECKOUT" archive --format=zip "$RELEASE_COMMIT"' \
  'git -C "$SOURCE_CHECKOUT" show "$RELEASE_COMMIT:package.json"' \
  'org.opencontainers.image.revision' \
  'org.opencontainers.image.version' \
  "controlled downtime" \
  "old worker and API are both at zero" \
  "SQS buffers" \
  "FENCE_AT" \
  "inbound-provenance-fence" \
  "INITIAL_DLQ_VISIBLE" \
  "INITIAL_DLQ_IN_FLIGHT" \
  "DLQ_STABLE_READS" \
  "FENCE_LOG_EVENTS" \
  "STATUS_LOG_EVENTS" \
  "STATUS_LOG_STREAM" \
  'select((keys | sort) == ["fence_at"])' \
  'select((keys | sort) == ["alreadyApplied","applied","pending"])' \
  '(.pending | type == "array" and length == 0)' \
  '(.alreadyApplied | index("0017_inbound_message_source_provenance") != null)' \
  'test "$FENCE_EXIT" = "0"' \
  'test "$MIGRATION_EXIT" = "0"' \
  'test "$STATUS_EXIT" = "0"' \
  'test "$AUDIT_EXIT" = "0"' \
  'test "$INITIAL_DLQ_VISIBLE" = "0"' \
  'test "$INITIAL_DLQ_IN_FLIGHT" = "0"' \
  'test "$FINAL_DLQ_VISIBLE" = "0"' \
  'test "$FINAL_DLQ_IN_FLIGHT" = "0"' \
  "verify ledger 0020" \
  "inbound-provenance-audit" \
  "only the release worker" \
  "before the API" \
  "compatible roll-forward" \
  "pre-0020 release"; do
  printf '%s\n' "$cutover_text" | grep -Fiq "$phrase" || {
    echo "0020 forward-only cutover contract missing '$phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

for phrase in \
  "UNUSABLE for" \
  "actual live topology" \
  "Never run, copy, or paste" \
  "separately generated and independently reviewed AWS CLI plan" \
  "cloned from the exact live service task definitions" \
  "LIVE_TOPOLOGY_MANIFEST" \
  "LIVE_TOPOLOGY_SHA256" \
  "LIVE_API_TASK_FAMILY" \
  "LIVE_WORKER_TASK_FAMILY" \
  "LIVE_MIGRATION_TASK_FAMILY" \
  "LIVE_RUNTIME_ARCHITECTURE" \
  "LIVE_IMAGE_REPOSITORY" \
  "LIVE_IMAGE_REFERENCE" \
  "MANIFEST_API_CONTAINER_NAME" \
  "MANIFEST_WORKER_CONTAINER_NAME" \
  "MANIFEST_MIGRATION_CONTAINER_NAME" \
  "MANIFEST_API_TASK_ROLE_ARN" \
  "MANIFEST_WORKER_TASK_ROLE_ARN" \
  "MANIFEST_MIGRATION_TASK_ROLE_ARN" \
  "MANIFEST_API_EXECUTION_ROLE_ARN" \
  "MANIFEST_WORKER_EXECUTION_ROLE_ARN" \
  "MANIFEST_MIGRATION_EXECUTION_ROLE_ARN" \
  "X86_64" \
  "database-specific" \
  "NO_SES_SMOKE_TASK_ROLE_ARN" \
  "outbound sending" \
  "bootstrap" \
  "separate explicit approval" \
  "imported or adopted" \
  "no-op plan" \
  "RUNBOOK_MODE" \
  "isolated-rehearsal" \
  "REHEARSAL_NAME" \
  "REHEARSAL_ACCOUNT_ID" \
  "REHEARSAL_TOPOLOGY_MANIFEST" \
  "REHEARSAL_TOPOLOGY_SHA256" \
  "reviewed topology manifest" \
  "exact schema" \
  '.environment == "rehearsal"' \
  '.live == false' \
  "require_isolated_rehearsal" \
  "rehearsal_terraform" \
  "rehearsal_aws"; do
  printf '%s\n' "$cutover_text" | grep -Fiq "$phrase" || {
    echo "0017 live-topology safety contract missing '$phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

plan_count="$(grep -Fc 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md")"
image_plan_count="$(grep -Fc -- '-var="container_image=$IMAGE_REFERENCE"' "$repo/docs/DEPLOYMENT_CUTOVER.md")"
architecture_plan_count="$(grep -Fc -- '-var="container_architecture=X86_64"' "$repo/docs/DEPLOYMENT_CUTOVER.md")"
if test "$plan_count" -eq 0 || test "$image_plan_count" != "$plan_count" || \
  test "$architecture_plan_count" != "$plan_count"; then
  echo "every Terraform plan must use the full immutable image reference and X86_64" >&2
  exit 1
fi
if grep -Fq -- '-var="container_image=$IMAGE_DIGEST"' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "a bare digest must never be passed as Terraform container_image" >&2
  exit 1
fi
for staged_assertion in \
  'assert_staged_task_definition "$STAGED_MIGRATION_TASK_JSON" "$MIGRATION_DEF"' \
  'assert_staged_task_definition "$STAGED_WORKER_TASK_JSON" "$WORKER_DEF"' \
  'assert_staged_task_definition "$STAGED_API_TASK_JSON" "$API_DEF"'; do
  test "$(grep -Fc "$staged_assertion" "$repo/docs/DEPLOYMENT_CUTOVER.md")" = "1" || {
    echo "each staged migration, worker, and API definition needs one exact metadata assertion" >&2
    exit 1
  }
done

if ! awk '
  /^```bash[[:space:]]*$/ { in_bash = 1; need_strict_mode = 1; next }
  /^```[[:space:]]*$/ && in_bash { in_bash = 0; need_strict_mode = 0; next }
  in_bash && need_strict_mode && /^[[:space:]]*$/ { next }
  in_bash && need_strict_mode {
    if ($0 != "set -euo pipefail") exit 1
    need_strict_mode = 0
  }
  END { if (need_strict_mode) exit 1 }
' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "every executable Bash block must start with set -euo pipefail" >&2
  exit 1
fi

if grep -En '^[[:space:]]*(terraform[[:space:]]+(plan|apply)|aws[[:space:]]+ecs[[:space:]]+(run-task|update-service))([[:space:]]|$)' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" >/dev/null; then
  echo "0017 runbook contains an unguarded copy/paste-capable Terraform or ECS mutation" >&2
  exit 1
fi

for guarded_command in \
  'rehearsal_terraform plan' \
  'rehearsal_terraform apply' \
  'rehearsal_aws ecs run-task' \
  'rehearsal_aws ecs update-service'; do
  grep -Fq "$guarded_command" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0017 rehearsal wrapper missing '$guarded_command' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

guard_line="$(grep -nF 'require_isolated_rehearsal() {' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
manifest_hash_line="$(grep -nF 'sha256sum -- "$REHEARSAL_TOPOLOGY_MANIFEST"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
manifest_schema_line="$(grep -nF '(keys | sort) == $expected_keys' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
source_package_line="$(grep -nF 'git -C "$SOURCE_CHECKOUT" show "$RELEASE_COMMIT:package.json"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
source_archive_line="$(grep -nF 'git -C "$SOURCE_CHECKOUT" archive --format=zip "$RELEASE_COMMIT"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
service_preflight_line="$(grep -nF 'SERVICE_PREFLIGHT_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_details_line="$(grep -nF 'IMAGE_DETAILS_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_report_gate_line="$(grep -nF '.ArtifactName == $image_reference' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_report_digest_line="$(grep -nF '.Metadata.RepoDigests | type == "array" and index($image_reference) != null' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_severity_gate_line="$(grep -nF 'select(.Severity == "CRITICAL" or .Severity == "HIGH")' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_sbom_gate_line="$(grep -nF '.bomFormat == "CycloneDX"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_sbom_digest_line="$(grep -nF 'aquasecurity:trivy:RepoDigest' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_config_line="$(grep -nF 'IMAGE_CONFIG_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
image_metadata_gate_line="$(grep -nF '.config.Labels["org.opencontainers.image.revision"] == $release_commit' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
queue_identity_line="$(grep -nF 'deadLetterTargetArn == $dlq_arn' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
initial_dlq_zero_line="$(grep -nF 'test "$INITIAL_DLQ_VISIBLE" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
first_plan_line="$(grep -nF 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
first_mutation_line="$(grep -nE 'rehearsal_(terraform (plan|apply)|aws ecs (run-task|update-service))' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
for safety_line in \
  "$guard_line" \
  "$manifest_hash_line" \
  "$manifest_schema_line" \
  "$source_package_line" \
  "$source_archive_line" \
  "$service_preflight_line" \
  "$image_details_line" \
  "$image_report_gate_line" \
  "$image_report_digest_line" \
  "$image_severity_gate_line" \
  "$image_sbom_gate_line" \
  "$image_sbom_digest_line" \
  "$image_config_line" \
  "$image_metadata_gate_line" \
  "$queue_identity_line" \
  "$initial_dlq_zero_line"; do
  test -n "$safety_line" || {
    echo "0017 reviewed-topology preflight is incomplete" >&2
    exit 1
  }
  test "$safety_line" -lt "$first_plan_line" && test "$safety_line" -lt "$first_mutation_line" || {
    echo "0017 reviewed-topology preflight must complete before every executable planning or mutation path" >&2
    exit 1
  }
done

if ! grep -Fq './scripts/container-runtime-smoke.sh' "$repo/.github/workflows/ci.yml"; then
  echo "CI must build and exercise the scratch runtime image" >&2
  exit 1
fi

for scanner_contract in \
  'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25' \
  'BUN_UPSTREAM_IMAGE: oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0' \
  'CONTAINER_RUNTIME_PATCHED_BASE_IMAGE: hasna-emails-patched-bun-base:ci' \
  'format: json' \
  'format: cyclonedx' \
  'list-all-pkgs: "true"' \
  '.Metadata.OS.Family == "alpine"' \
  'select(.Class == "os-pkgs") | .Packages[]?' \
  'select(.Class == "os-pkgs") | .Packages[]? | .Name] | unique | sort) == ["libgcc", "libstdc++", "musl"]' \
  'select(.Class == "lang-pkgs") | .Packages[]?' \
  'trivy-patched-bun-base-report.json' \
  'image-ref: ${{ env.CONTAINER_RUNTIME_PATCHED_BASE_IMAGE }}' \
  'severity: CRITICAL,HIGH' \
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'; do
  if ! grep -Fq "$scanner_contract" "$repo/.github/workflows/ci.yml"; then
    echo "missing pinned scanner/SBOM evidence contract: $scanner_contract" >&2
    exit 1
  fi
done

for exact_image_evidence in \
  'IMAGE_SECURITY_REPORT' \
  'IMAGE_SECURITY_REPORT_SHA256' \
  'IMAGE_SBOM' \
  'IMAGE_SBOM_SHA256'; do
  if ! grep -Fq "$exact_image_evidence" "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
    echo "cutover must require exact-image scanner and SBOM evidence: $exact_image_evidence" >&2
    exit 1
  fi
done

if ! grep -Fq 'test "$FINAL_DLQ_VISIBLE" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" || \
  ! grep -Fq 'test "$FINAL_DLQ_IN_FLIGHT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 final DLQ gate must require exactly zero visible and in-flight messages" >&2
  exit 1
fi

if grep -Fq -- '-le "$INITIAL_DLQ_' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 DLQ gate must not accept a nonzero baseline" >&2
  exit 1
fi

if grep -Fq 'FENCE_AT="$(date ' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0017 fence must come from PostgreSQL, never the operator host clock" >&2
  exit 1
fi

stage_line="$(grep -nF 'terraform apply 0020-definitions.tfplan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
staged_assert_line="$(grep -nF 'assert_staged_task_definition "$STAGED_MIGRATION_TASK_JSON"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
rollback_worker_disable_line="$(grep -nF 'ROLLBACK_DISABLE_WORKER_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
rollback_api_disable_line="$(grep -nF 'ROLLBACK_DISABLE_API_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
rollback_verified_line="$(grep -nF 'ROLLBACK_DISABLED_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
fence_line="$(grep -nF 'inbound-provenance-fence' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
worker_stop_line="$(grep -nF -- '--service "$WORKER_SERVICE" --desired-count 0' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_zero_line="$(grep -nF 'WORKER_ZERO_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_tasks_zero_line="$(grep -nF 'test "$WORKER_ZERO_TASK_COUNT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
queue_stable_zero_line="$(grep -nF 'test "$QUEUE_IN_FLIGHT_STABLE_READS" -ge 3' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
api_stop_line="$(grep -nF -- '--service "$API_SERVICE" --desired-count 0' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
services_zero_line="$(grep -nF 'SERVICE_ZERO_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_tasks_recheck_line="$(grep -nF 'test "$WORKER_ZERO_TASK_COUNT_AFTER_API" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
api_tasks_zero_line="$(grep -nF 'test "$API_ZERO_TASK_COUNT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
for ordered_line in \
  "$stage_line" \
  "$staged_assert_line" \
  "$rollback_worker_disable_line" \
  "$rollback_api_disable_line" \
  "$rollback_verified_line" \
  "$worker_stop_line" \
  "$worker_zero_line" \
  "$worker_tasks_zero_line" \
  "$queue_stable_zero_line" \
  "$api_stop_line" \
  "$services_zero_line" \
  "$worker_tasks_recheck_line" \
  "$api_tasks_zero_line" \
  "$fence_line"; do
  test -n "$ordered_line" || {
    echo "0020 cutover is missing a machine-readable zero-writer gate" >&2
    exit 1
  }
done
test "$stage_line" -lt "$staged_assert_line" \
  && test "$staged_assert_line" -lt "$rollback_worker_disable_line" \
  && test "$rollback_worker_disable_line" -lt "$rollback_api_disable_line" \
  && test "$rollback_api_disable_line" -lt "$rollback_verified_line" \
  && test "$rollback_verified_line" -lt "$worker_stop_line" \
  && test "$worker_stop_line" -lt "$worker_zero_line" \
  && test "$worker_zero_line" -lt "$worker_tasks_zero_line" \
  && test "$worker_tasks_zero_line" -lt "$queue_stable_zero_line" \
  && test "$queue_stable_zero_line" -lt "$api_stop_line" \
  && test "$api_stop_line" -lt "$services_zero_line" \
  && test "$services_zero_line" -lt "$worker_tasks_recheck_line" \
  && test "$worker_tasks_recheck_line" -lt "$api_tasks_zero_line" \
  && test "$api_tasks_zero_line" -lt "$fence_line" || {
  echo "0020 cutover must stage the release, prove the worker/queue/API zero, then capture the DB fence" >&2
  exit 1
}

migration_task_line="$(grep -nF 'MIGRATION_TASK=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
migration_exit_line="$(grep -nF 'test "$MIGRATION_EXIT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_task_line="$(grep -nF 'STATUS_TASK=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_exit_line="$(grep -nF 'test "$STATUS_EXIT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_json_line="$(grep -nF 'STATUS_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
status_gate_line="$(grep -nF 'index("0017_inbound_message_source_provenance") != null' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
worker_start_line="$(grep -nF -- '--desired-count "$ORIGINAL_WORKER_COUNT"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
audit_exit_line="$(grep -nF 'test "$AUDIT_EXIT" = "0"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
api_start_line="$(grep -nF -- '--desired-count "$ORIGINAL_API_COUNT"' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
version_json_line="$(grep -nF 'VERSION_JSON=' "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
version_gate_line="$(grep -nF '.version == $release_version' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
reconcile_plan_line="$(grep -nF 'rehearsal_terraform plan' "$repo/docs/DEPLOYMENT_CUTOVER.md" | tail -1 | cut -d: -f1)"
for ordered_line in \
  "$migration_task_line" \
  "$migration_exit_line" \
  "$status_task_line" \
  "$status_exit_line" \
  "$status_json_line" \
  "$status_gate_line" \
  "$worker_start_line" \
  "$audit_exit_line" \
  "$api_start_line" \
  "$version_json_line" \
  "$version_gate_line" \
  "$reconcile_plan_line"; do
  test -n "$ordered_line" || {
    echo "0020 cutover is missing a migration, status, worker, audit, or API gate" >&2
    exit 1
  }
done
test "$fence_line" -lt "$migration_task_line" \
  && test "$migration_task_line" -lt "$migration_exit_line" \
  && test "$migration_exit_line" -lt "$status_task_line" \
  && test "$status_task_line" -lt "$status_exit_line" \
  && test "$status_exit_line" -lt "$status_json_line" \
  && test "$status_json_line" -lt "$status_gate_line" \
  && test "$status_gate_line" -lt "$worker_start_line" \
  && test "$worker_start_line" -lt "$audit_exit_line" \
  && test "$audit_exit_line" -lt "$api_start_line" \
  && test "$api_start_line" -lt "$version_json_line" \
  && test "$version_json_line" -lt "$version_gate_line" \
  && test "$version_gate_line" -lt "$reconcile_plan_line" || {
  echo "0020 cutover must run migration, status, release worker, audit, then API in order" >&2
  exit 1
}

for zero_assertion in \
  '(.services[0].desiredCount == 0)' \
  '(.services[0].runningCount == 0)' \
  'and .desiredCount == 0' \
  'and .runningCount == 0' \
  "--query 'length(taskArns)'" \
  'test "$CURRENT_QUEUE_IN_FLIGHT" = "0"'; do
  grep -Fq -- "$zero_assertion" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0020 cutover missing machine assertion '$zero_assertion'" >&2
    exit 1
  }
done

for command_phrase in \
  "aws ecs run-task" \
  "aws ecs wait tasks-stopped" \
  "aws ecs describe-tasks" \
  "--desired-count 0" \
  "deploymentCircuitBreaker={enable=true,rollback=false}" \
  "deploymentConfiguration.deploymentCircuitBreaker.rollback" \
  "assert_staged_task_definition" \
  '(.taskDefinition.runtimePlatform.cpuArchitecture == "X86_64")' \
  '(.taskDefinition.containerDefinitions[0].image == $image_reference)' \
  '(.taskDefinition.taskRoleArn == $task_role)' \
  '(.taskDefinition.executionRoleArn == $execution_role)' \
  '--desired-count "$ORIGINAL_WORKER_COUNT"' \
  '--desired-count "$ORIGINAL_API_COUNT"' \
  "get-queue-attributes" \
  "inbound-provenance-audit" \
  '--arg since "$FENCE_AT"' \
  '"inbound-provenance-audit","--since",$since' \
  "schema_migrations" \
  "VERSION_JSON" \
  '(.version == $release_version)' \
  "/ready"; do
  grep -Fiq -- "$command_phrase" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "0020 cutover rehearsal missing '$command_phrase' from docs/DEPLOYMENT_CUTOVER.md" >&2
    exit 1
  }
done

if grep -Eiq 'keep (the )?(existing|old|pre-0020).*(task|worker|API).*(running|live).*(migration|replacement)|old task stays running' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "0020 cutover must not overlap migration or replacement with incompatible tasks" >&2
  exit 1
fi

maintenance_source="$repo/src/server/self-hosted/attachment-repair-maintenance.ts"
for maintenance_contract in \
  'EMAILS_ATTACHMENT_REPAIR_MANIFEST' \
  'EMAILS_IMAGE_REVISION' \
  'ECS_CONTAINER_METADATA_URI_V4' \
  'attachment-repair-ledger' \
  'MAX_ATTACHMENT_REPAIR_PAGE_ITEMS' \
  'processCanonicalS3AttachmentRepairPage' \
  'createOrGetAttachmentRepairRun' \
  'dryRunResultSha256' \
  'expectedTaskDefinitionArn' \
  'expectedImageDigest' \
  'expectedImageRevision' \
  'operator_action' \
  'entry_operator_action' \
  'invariant_failure' \
  'process.exitCode'; do
  grep -Fq "$maintenance_contract" "$maintenance_source" || {
    echo "image-bundled attachment repair maintenance contract is missing $maintenance_contract" >&2
    exit 1
  }
done
if grep -Eiq '@aws-sdk/client-ses|ses:SendEmail|ses:SendRawEmail|ListObjects|ListObjectsV2' \
  "$maintenance_source"; then
  echo "attachment repair maintenance command must not send mail or list the bucket" >&2
  exit 1
fi
grep -Fq 'args[0] === "attachment-repair-ledger"' "$repo/src/server/index.ts" || {
  echo "self-hosted image entrypoint must expose attachment-repair-ledger" >&2
  exit 1
}

for repair_runbook_contract in \
  'attachment-repair-ledger' \
  'REPAIR_MANIFEST_SECRET_ARN' \
  'REPAIR_MANIFEST_SHA256' \
  'REPAIR_TASK_ROLE_ARN' \
  'REPAIR_EXECUTION_ROLE_ARN' \
  'REPAIR_TASK_DEFINITION_ARN' \
  'REPAIR_RESULT_FILE_SHA256' \
  'test ! -L "$REPAIR_RESULT_FILE"' \
  'rehearsal_aws ecs register-task-definition' \
  'LAST_REPAIR_TASK_ARN="$(rehearsal_aws ecs run-task' \
  'aws ecs wait tasks-stopped' \
  'aws ecs describe-tasks' \
  'ECS_CONTAINER_METADATA_URI_V4' \
  'imageDigest' \
  'RELEASE_COMMIT' \
  'DRY_RUN_RESULT_SHA256' \
  '"--expected-run-id",$expected_run_id' \
  'test "$LAST_REPAIR_EXIT" = "75"' \
  'aws logs get-log-events' \
  'FINAL_REPAIR_TASK_COUNT' \
  'verify_attachment_repair_result.sh' \
  'There is no empty' \
  'there is no waiver'; do
  grep -Fiq "$repair_runbook_contract" "$repo/docs/DEPLOYMENT_CUTOVER.md" || {
    echo "attachment repair cutover contract missing '$repair_runbook_contract'" >&2
    exit 1
  }
done
if grep -Eiq 'required[[:space:]]*==[[:space:]]*false|repair[[:space:]]*==[[:space:]]*null|empty repair requirement' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "attachment repair promotion must not retain an implicit empty-result waiver" >&2
  exit 1
fi
if grep -Fq 'aws logs filter-log-events' "$repo/docs/DEPLOYMENT_CUTOVER.md"; then
  echo "attachment repair evidence must come from the exact task log stream, not broad log filtering" >&2
  exit 1
fi

repair_definition_line="$(grep -nF 'REPAIR_TASK_DEFINITION_JSON="$(rehearsal_aws ecs register-task-definition' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
repair_task_line="$(grep -nF 'LAST_REPAIR_TASK_ARN="$(rehearsal_aws ecs run-task' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
repair_result_gate_line="$(grep -nF '"$SOURCE_CHECKOUT/deploy/aws/verify_attachment_repair_result.sh"' \
  "$repo/docs/DEPLOYMENT_CUTOVER.md" | head -1 | cut -d: -f1)"
test -n "$repair_definition_line" \
  && test -n "$repair_task_line" \
  && test -n "$repair_result_gate_line" \
  && test "$status_gate_line" -lt "$repair_definition_line" \
  && test "$repair_definition_line" -lt "$repair_task_line" \
  && test "$repair_task_line" -lt "$repair_result_gate_line" \
  && test "$repair_result_gate_line" -lt "$worker_start_line" || {
  echo "attachment repair must run after ledger verification and pass before the worker starts" >&2
  exit 1
}

repair_result_gate="$root/verify_attachment_repair_result.sh"
if [ ! -x "$repair_result_gate" ]; then
  echo "attachment repair promotion gate must be an executable deployment contract" >&2
  exit 1
fi
for zero_gate in \
  '.repair.unavailable == 0' \
  '.repair.operator_action == 0' \
  '.repair.entry_unavailable == 0' \
  '.repair.entry_operator_action == 0' \
  '.repair.pending == 0' \
  '.repair.retrying == 0' \
  '.repair.entry_pending == 0' \
  '.repair.entry_retrying == 0'; do
  grep -Fq "$zero_gate" "$repair_result_gate" || {
    echo "attachment repair verifier is missing zero gate $zero_gate" >&2
    exit 1
  }
done

repair_fixture_dir=$(mktemp -d)
trap 'rm -rf -- "$repair_fixture_dir"' EXIT HUP INT TERM
repair_task_arn="arn:aws:ecs:eu-central-1:123456789012:task/rehearsal/44444444444444444444444444444444"
repair_definition_arn="arn:aws:ecs:eu-central-1:123456789012:task-definition/rehearsal-api-attachment-repair:7"
repair_container="attachment-repair"
repair_image_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
repair_image_revision="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
repair_run_id="33333333-3333-4333-8333-333333333333"

repair_success="$root/tests/fixtures/attachment-repair-runtime-success.json"
[ -f "$repair_success" ] && [ ! -L "$repair_success" ] || {
  echo "attachment repair runtime success fixture is missing or unsafe" >&2
  exit 1
}
repair_manifest_sha="$(jq -er '.manifest_sha256' "$repair_success")"
repair_success_sha="$(sha256sum -- "$repair_success" | awk '{print $1}')"
"$repair_result_gate" \
  "$repair_success" "$repair_success_sha" \
  "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
  "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
  "$repair_run_id"

repair_gate_must_fail() {
  if "$repair_result_gate" "$@" >/dev/null 2>&1; then
    echo "attachment repair promotion gate accepted a negative fixture" >&2
    exit 1
  fi
}

repair_tamper_must_fail() {
  fixture_name=$1
  jq_filter=$2
  tampered="$repair_fixture_dir/tampered-$fixture_name.json"
  fixture="$repair_fixture_dir/$fixture_name.json"
  jq -cS "$jq_filter" "$repair_success" >"$tampered"
  tampered_repair="$(jq -cS '.repair' "$tampered")"
  tampered_result_sha="$(printf '%s' "$tampered_repair" | sha256sum | awk '{print $1}')"
  jq -cS --arg result_sha "$tampered_result_sha" \
    '.result_sha256 = $result_sha' "$tampered" >"$fixture"
  fixture_sha="$(sha256sum -- "$fixture" | awk '{print $1}')"
  repair_gate_must_fail \
    "$fixture" "$fixture_sha" \
    "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
    "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
    "$repair_run_id"
}

repair_gate_must_fail \
  "$repair_success" "$repair_success_sha" \
  "${repair_task_arn}fabricated" "$repair_definition_arn" "$repair_container" \
  "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
  "$repair_run_id"

for required_budget_field in \
  byte_budget bytes_consumed time_budget_ms deadline_at; do
  repair_tamper_must_fail \
    "missing-$required_budget_field" \
    "del(.repair.$required_budget_field)"
done

for malformed_budget_field in \
  byte_budget bytes_consumed time_budget_ms; do
  repair_tamper_must_fail \
    "malformed-$malformed_budget_field" \
    ".repair.$malformed_budget_field = \"1\""
done

repair_tamper_must_fail "malformed-deadline-at" \
  '.repair.deadline_at = "not-a-timestamp"'
repair_tamper_must_fail "impossible-calendar-date" \
  '(.repair.created_at, .repair.updated_at, .repair.completed_at, .repair.deadline_at) |= sub("2026-07-24"; "2026-02-31")'
repair_tamper_must_fail "negative-bytes-consumed" \
  '.repair.bytes_consumed = -1'
repair_tamper_must_fail "zero-byte-budget" \
  '.repair.byte_budget = 0'
repair_tamper_must_fail "zero-time-budget" \
  '.repair.time_budget_ms = 0'
repair_tamper_must_fail "unsafe-byte-budget" \
  '.repair.byte_budget = 9007199254740992'
repair_tamper_must_fail "unsafe-time-budget" \
  '.repair.time_budget_ms = 9007199254740992'
repair_tamper_must_fail "byte-budget-exceeded" \
  '.repair.bytes_consumed = (.repair.byte_budget + 1)'
repair_tamper_must_fail "deadline-budget-inconsistent" \
  '.repair.deadline_at = "2026-07-24T11:00:00.001Z"'
repair_tamper_must_fail "completed-after-deadline" \
  '.repair.completed_at = "2026-07-24T11:00:00.001Z"'
repair_tamper_must_fail "updated-before-created" \
  '.repair.updated_at = "2026-07-24T09:59:59.999Z"'
repair_tamper_must_fail "fabricated-extra-key" \
  '.repair.fabricated = 0'

for nonzero_field in \
  unavailable operator_action entry_unavailable entry_operator_action \
  pending retrying entry_pending entry_retrying; do
  fixture="$repair_fixture_dir/nonzero-$nonzero_field.json"
  tampered_repair="$(jq -cS --arg field "$nonzero_field" \
    '.repair[$field] = 1 | .repair' "$repair_success")"
  tampered_result_sha="$(printf '%s' "$tampered_repair" | sha256sum | awk '{print $1}')"
  jq -cS --arg field "$nonzero_field" --arg result_sha "$tampered_result_sha" \
    '.repair[$field] = 1 | .result_sha256 = $result_sha' \
    "$repair_success" >"$fixture"
  fixture_sha="$(sha256sum -- "$fixture" | awk '{print $1}')"
  repair_gate_must_fail \
    "$fixture" "$fixture_sha" \
    "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
    "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
    "$repair_run_id"
done

numeric_fixture="$repair_fixture_dir/string-zero.json"
numeric_repair="$(jq -cS '.repair.unavailable = "0" | .repair' "$repair_success")"
numeric_result_sha="$(printf '%s' "$numeric_repair" | sha256sum | awk '{print $1}')"
jq -cS --arg result_sha "$numeric_result_sha" \
  '.repair.unavailable = "0" | .result_sha256 = $result_sha' \
  "$repair_success" >"$numeric_fixture"
numeric_fixture_sha="$(sha256sum -- "$numeric_fixture" | awk '{print $1}')"
repair_gate_must_fail \
  "$numeric_fixture" "$numeric_fixture_sha" \
  "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
  "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
  "$repair_run_id"

provenance_fixture="$repair_fixture_dir/fabricated-provenance.json"
jq -cS '.task_arn = "arn:aws:ecs:eu-central-1:123456789012:task/rehearsal/fabricated"' \
  "$repair_success" >"$provenance_fixture"
provenance_fixture_sha="$(sha256sum -- "$provenance_fixture" | awk '{print $1}')"
repair_gate_must_fail \
  "$provenance_fixture" "$provenance_fixture_sha" \
  "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
  "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
  "$repair_run_id"

hash_fixture="$repair_fixture_dir/bad-result-hash.json"
jq -cS '.result_sha256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"' \
  "$repair_success" >"$hash_fixture"
hash_fixture_sha="$(sha256sum -- "$hash_fixture" | awk '{print $1}')"
repair_gate_must_fail \
  "$hash_fixture" "$hash_fixture_sha" \
  "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
  "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
  "$repair_run_id"

repair_gate_must_fail \
  "$repair_success" "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" \
  "$repair_task_arn" "$repair_definition_arn" "$repair_container" \
  "$repair_image_digest" "$repair_image_revision" "$repair_manifest_sha" \
  "$repair_run_id"

echo "static self-hosting contract: pass"
