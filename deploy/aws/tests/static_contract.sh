#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$root/../.." && pwd)
cd "$root"

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
test -f "$workflow" || { echo "CI-safe Terraform workflow missing" >&2; exit 1; }
test -f "$product_workflow" || { echo "product CI workflow missing" >&2; exit 1; }

workflow_count="$(find "$workflow_dir" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | wc -l | tr -d '[:space:]')"
if [ "$workflow_count" != "2" ]; then
  echo "only ci.yml and terraform-aws-validate.yml are allowed" >&2
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
  echo "workflows must not request AWS credentials or OIDC" >&2
  exit 1
fi

if grep -En '^[[:space:]]*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[[:space:]]*:' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "workflows must not provide AWS credential environment values" >&2
  exit 1
fi

if grep -En '(^|[^[:alnum:]_])(terraform|tofu)[[:space:]]+(apply|destroy)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_])(npm|bun|pnpm|yarn)[[:space:]]+publish([^[:alnum:]_-]|$)|ecs[[:space:]]+update-service' \
  "$workflow" "$product_workflow" >/dev/null; then
  echo "workflows must not apply, destroy, publish, or deploy" >&2
  exit 1
fi

for allowed_workflow in "$workflow" "$product_workflow"; do
  uses_count="$(grep -Ec 'uses:' "$allowed_workflow" || true)"
  pinned_uses_count="$(grep -Ec 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}([[:space:]]+#.*)?$' "$allowed_workflow" || true)"
  if [ "$uses_count" != "$pinned_uses_count" ]; then
    echo "every workflow action must be pinned to an immutable commit SHA" >&2
    exit 1
  fi
done

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

echo "static self-hosting contract: pass"
