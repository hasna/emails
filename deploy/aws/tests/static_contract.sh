#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$root/../.." && pwd)
cd "$root"

if rg -n -i \
  'hasna[.]xyz|mailery[.]co|MAILERY|HASNA_EMAILS|HASNA_MAILERY|API_KEY_SIGNING_SECRET' \
  . \
  --glob '!tests/**'; then
  echo "forbidden hosted-service coupling found" >&2
  exit 1
fi

if rg -n 'name[[:space:]]*=[[:space:]]*"DATABASE_URL"|\["mailery|\["mailery-serve' compute.tf; then
  echo "legacy command or generic secret environment found" >&2
  exit 1
fi

for sid in ReadInboundBucket ReadInboundObjects ConsumeInboundQueue DecryptInboundData; do
  if ! rg -U -q "dynamic \"statement\" \\{[[:space:]]*for_each = var[.]enable_ses_inbound[^}]*sid[[:space:]]*=[[:space:]]*\"$sid\"" iam.tf; then
    echo "worker permission $sid is not gated by enable_ses_inbound" >&2
    exit 1
  fi
done

if rg -n \
  'arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}' \
  . \
  --glob '!tests/**' \
  --glob '!examples/**'; then
  echo "concrete AWS account ARN found outside test/example fixtures" >&2
  exit 1
fi

if rg -n 'resource[[:space:]]+"aws_ses_active_receipt_rule_set"' .; then
  echo "Terraform must not activate the account-global SES receipt rule set" >&2
  exit 1
fi

if rg -n 'resource[[:space:]]+"aws_secretsmanager_secret_version"' .; then
  echo "Terraform must not place secret values in state" >&2
  exit 1
fi

if rg -n '^[[:space:]]+(ingress|egress)[[:space:]]*\{' network.tf; then
  echo "inline security-group rules are forbidden; use standalone rule resources" >&2
  exit 1
fi

if rg -n 'http://' outputs.tf; then
  echo "client endpoint outputs must be HTTPS-only" >&2
  exit 1
fi

if rg -n '^check[[:space:]]+"' . --glob '*.tf'; then
  echo "nonblocking Terraform check blocks are forbidden for safety contracts" >&2
  exit 1
fi

workflow="$repo/.github/workflows/terraform-aws-validate.yml"
test -f "$workflow" || { echo "CI-safe Terraform workflow missing" >&2; exit 1; }

rg -F -q '".github/workflows/**"' "$workflow" || {
  echo "workflow changes must trigger the static legacy-workflow guard" >&2
  exit 1
}

if rg -n 'id-token:|configure-aws-credentials|AWS_ACCOUNT_ID|role-to-assume' "$workflow"; then
  echo "validation workflow must not request AWS credentials or OIDC" >&2
  exit 1
fi

uses_count="$(rg -c 'uses:' "$workflow")"
pinned_uses_count="$(rg -c 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}([[:space:]]+#.*)?$' "$workflow")"
if [ "$uses_count" != "$pinned_uses_count" ]; then
  echo "every workflow action must be pinned to an immutable commit SHA" >&2
  exit 1
fi

test ! -e "$repo/.github/workflows/deploy.yml" || {
  echo "legacy fleet deployment workflow must be removed" >&2
  exit 1
}

echo "static self-hosting contract: pass"
