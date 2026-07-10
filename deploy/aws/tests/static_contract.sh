#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

if rg -n -i \
  'hasna[.]xyz|mailery[.]co|HASNA_MAILERY_API_URL|MAILERY_CLOUD_API_URL|MAILERY_API_URL' \
  . \
  --glob '!tests/static_contract.sh'; then
  echo "forbidden hosted-service coupling found" >&2
  exit 1
fi

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

echo "static self-hosting contract: pass"
