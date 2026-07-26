# Deployment cutover

This repository intentionally has no automatic deployment workflow. Merging or
tagging the repository cannot publish a package, push an image, or update AWS.

The fast-uri quarantine is resolved: the eligible security update cleared the full seven-day
managed quarantine window on 2026-07-26 10:42:54.497 Europe/Bucharest and is
pinned in the current package manifest and lockfile. Future third-party dependency changes remain subject to the
managed quarantine process.

Before a future `workflow_dispatch` deployment is introduced, an operator must
provide a Mailery-owned infrastructure manifest and least-privilege role in the
target user's AWS account. The workflow must use `APP=emails`, require an
explicit environment approval, and must not contain a Hasna account ID, bucket,
cluster, database URL, secret path, or default endpoint.

Rename cutover is additive: released Mailery migration ids/checksums and the
old API key remain valid during the rollback window. Apply the Emails bridge,
mint a new key with `emails self-hosted key rotate`, move and verify clients,
then revoke the old key explicitly. Do not delete or rewrite historical
migration-ledger rows.

## Tenant-sealing migration gate (0016)

Before migration 0016, discover and inventory every old API, worker, ingest,
backfill, scheduled, and one-off writer. Drain and stop all of them, then run a
new-code-compatible migrator through 0016 and verify the migration ledger before
starting any service. Start only tenant-aware new-code writers after the ledger
check passes.

For the AWS module, set `enable_automatic_deployment_rollback = false` before
draining writers and keep it false through 0016 and the first tenant-aware API
and worker activation. A failed activation must roll forward; ECS must not be
allowed to restore an unknown previous deployment. After both services complete
a tenant-aware deployment and pass verification, set
`enable_automatic_deployment_rollback = true` in a separate reviewed apply.
Terraform rejects enabling the gate before `migrations_complete`; setting it
true is the operator's explicit acknowledgement that the previous completed API
and worker deployment is tenant-aware and schema-compatible.

After 0016 commits, a pre-tenancy or otherwise unscoped image is not a valid
rollback target. Roll forward to a corrected tenant-aware image, or execute an
operator-reviewed explicit schema recovery plan while every writer remains
stopped.

## Attachment provenance, send recovery, inbox rollups, and repair-ledger gates (0017-0020)

Migration 0017 introduces the immutable attachment-provenance ledger, 0018 adds
durable send-intent recovery state, 0019 adds inbox performance rollups, and
0020 adds the tenant-scoped checkpointed attachment-repair ledger. Migration
0020 is the latest forward-only production cutover. Older binaries reject an
unknown applied ledger row and fail readiness closed. A pre-0020 release is not
a valid restart, scale-out, or rollback target after 0020 commits.

This cutover requires controlled downtime. The old worker and API are both at
zero before the ledger advances; SQS buffers new mail while no worker runs. Only
controlled release one-shots may write during migration and approved attachment
repair. The release worker is started only after migration and repair gates pass,
from an image whose migration set recognizes 0017 through 0020, and its
privacy-safe provenance audit must exit zero before the API is started. Leave
`enable_automatic_deployment_rollback = false` through the observation window.

> **Production hard stop:** this generic Terraform rehearsal is **UNUSABLE for
> the actual live topology**. Never run, copy, or paste any command block below
> against the live environment. The known live cluster and service topology is
> not owned by this Terraform state, so its outputs, task-definition families,
> service resources, and reconciliation plan are not production authority.

Actual live execution requires a separately generated and independently reviewed
AWS CLI plan cloned from the exact live service task definitions. That plan must
preserve and review the live roles, container names, environment, secret
references, networking, logging, health checks, and stop timeouts while changing
only the approved immutable image and deliberately reviewed compatibility fields.
The generic Terraform reconciliation in this document remains unsafe until the
actual live resources have been imported or adopted into authoritative state and
an independently reviewed no-op plan proves complete ownership and zero drift.
This document is never a substitute for that production plan.

### Live plan input contract (non-executable)

The separate live AWS CLI plan must fail closed unless an independently reviewed
`LIVE_TOPOLOGY_MANIFEST` and its `LIVE_TOPOLOGY_SHA256` seal all of the inputs
below. These are operator-supplied values, not defaults or public resource
identifiers:

- `LIVE_API_TASK_FAMILY`, `LIVE_WORKER_TASK_FAMILY`, and
  `LIVE_MIGRATION_TASK_FAMILY` must identify the exact revisioned live task
  definition families cloned for this cutover. The plan must also pin the exact
  service names, container names, roles, secret references, queue, DLQ, bucket,
  prefix, subnets, security groups, log groups, database identity, and ALB
  readiness URL from the live definitions and routing configuration. No live
  account, resource, service, database, bucket, role, or endpoint identifier may
  be hardcoded in the plan.
- `LIVE_RUNTIME_ARCHITECTURE` must equal `X86_64` for the reviewed live
  topology. The image and all three cloned definitions must agree; an ARM image
  or an implicit architecture is a hard failure.
- `RELEASE_VERSION`, `RELEASE_COMMIT`, `SOURCE_ARCHIVE_SHA256`,
  `LIVE_IMAGE_REPOSITORY`, `IMAGE_DIGEST`, and `LIVE_IMAGE_REFERENCE` must
  identify one release. `IMAGE_DIGEST` is only the bare `sha256:` value;
  `LIVE_IMAGE_REFERENCE` must equal `LIVE_IMAGE_REPOSITORY@IMAGE_DIGEST` and is
  the only value passed to task definitions. Recompute the deterministic archive
  SHA-256 from the exact commit, verify the package version at that commit, and
  verify the image's immutable registry digest and OCI revision/version metadata.
- `NO_SES_SMOKE_TASK_ROLE_ARN` must identify a reviewed smoke role that denies
  `ses:SendEmail` and `ses:SendRawEmail`. Read-only smoke must use this role;
  the normal task role is not acceptable merely because the operator promises
  not to send. The smoke task must be cloned from the exact release API
  definition, preserve its network and runtime identity, replace only the task
  role and command required for the read-only checks, and never join the live
  service.

The reviewed live plan must enforce this order:

1. Verify the manifest hash, caller account and region, exact API/worker/migration
   families, roles and container identities, `X86_64`, deterministic archive
   hash, full image reference and OCI metadata, current service definitions,
   queue/DLQ relationship, and database-specific recovery artifact.
2. Disable automatic rollback on both live services before any forward-only
   migration or service stop. Preserve the previous definitions only as
   pre-migration anchors; they are not rollback targets after 0020.
3. Stop the worker first. Prove desired and running counts are zero, its task
   list is empty, and the exact queue has three consecutive zero in-flight
   reads. Require exact zero visible and in-flight messages on the exact DLQ.
4. Stop the API second and prove both services have zero desired/running tasks
   and empty task lists. Capture `FENCE_AT` from PostgreSQL only after this
   zero-writer proof.
5. Take or verify a database-specific snapshot, clone, or restore artifact for
   the Emails database. Whole-instance recovery is forbidden when the database
   service is shared. Run the release migration definition, require migration
   and status exits of zero, valid checksums, `pending: []`, and migrations 0017,
   0018, 0019, and 0020 applied.
6. While both services remain at zero, run attachment repair only as a reviewed
   tenant-scoped, operator-only release maintenance operation. The manifest must use
   exact canonical object keys, trusted recipient evidence, and the complete
   tenant-scoped canary-message set. Run the ledger in its default dry-run mode
   first; record `would_repair`, `retrying`, terminal `unavailable`, entry
   counters, attempts, and checkpoint. Apply only the independently reviewed
   manifest, resume bounded pages to completion, and return the maintenance task
   to zero. The operation must use the configured canonical bucket, must not
   list the bucket, and must not log source keys, recipients, payload bytes, or
   internal errors.
7. Start only the release worker, drain the exact queue to zero visible and
   in-flight messages, keep the exact DLQ at zero, and require
   `inbound-provenance-audit --since "$FENCE_AT"` to exit zero before the API.
8. Start the release API, then run smoke from the one-shot task carrying the
   no-SES role. Verify `/version`, the configured live ALB `/ready` target,
   unauthenticated denial, authenticated tenant-scoped reads, cursor-resumable
   attachment inventory, and an approved attachment hash without logging
   message or attachment content.
9. Treat outbound sending and super-admin bootstrap as separate explicit approval
   actions. Neither belongs in migration, worker drain, read-only
   smoke, or API promotion. Bootstrap approval must name the one-time operator,
   key id, idempotency proof, wrong-key denial, and post-bootstrap revocation.
10. Before retiring any former local runtime state, stop its writers and take a
    fresh, checksummed, restore-tested backup of its database and attachment
    data. Preserve that recovery artifact through the rollback window, then move
    retired state to a recoverable quarantine and prove the old runtime does not
    recreate it. Cutover success is not authority to delete backups.

After 0020 begins, the only application-image recovery target is a
0020-compatible roll-forward. A database-specific restore while every writer is
stopped is a separate, operator-reviewed disaster-recovery path, not an image
rollback. A pre-0020 release is never a recovery target, and automatic rollback
remains disabled until a later reviewed change makes a completed 0020-compatible
deployment the rollback target.

The commands below are only an evidence-producing isolated rehearsal template.
They are never live-production instructions and must fail closed for any
topology identified as live. Run them from `deploy/aws` only against a
disposable, explicitly named rehearsal topology with a reviewed backend and
tfvars. `IMAGE_DIGEST` is the reviewed bare digest; `IMAGE_REFERENCE` is the
full immutable
`IMAGE_REPOSITORY@IMAGE_DIGEST` value passed to Terraform. Before the first
Terraform plan, an operator must provide a reviewed topology manifest and its
separately reviewed SHA-256. The preflight validates the manifest's exact
schema, release inputs, source commit, registry metadata, caller account and
region, Terraform outputs, current ECS service and task-definition identities,
and the queue/DLQ relationship. Any mismatch, AWS failure, or nonzero initial
DLQ aborts.

### 1. Prove topology, stage the release, stop every old writer, then save a database fence

```bash
set -euo pipefail

: "${RUNBOOK_MODE:?set RUNBOOK_MODE=isolated-rehearsal only for a disposable rehearsal}"
: "${REHEARSAL_NAME:?set the explicit non-live Terraform name containing rehearsal}"
: "${REHEARSAL_ACCOUNT_ID:?set the reviewed rehearsal AWS account ID}"
: "${REHEARSAL_TOPOLOGY_MANIFEST:?set the path to the reviewed topology manifest}"
: "${REHEARSAL_TOPOLOGY_SHA256:?set the separately reviewed manifest SHA-256}"
: "${SOURCE_CHECKOUT:?set the exact local source checkout}"
: "${RELEASE_VERSION:?set the reviewed release version}"
: "${RELEASE_COMMIT:?set the reviewed release commit}"
: "${SOURCE_ARCHIVE_SHA256:?set the deterministic release archive SHA-256}"
: "${IMAGE_REPOSITORY:?set the immutable image repository without a tag or digest}"
: "${IMAGE_DIGEST:?set the reviewed bare sha256 release image digest}"
: "${IMAGE_REFERENCE:?set the full IMAGE_REPOSITORY@IMAGE_DIGEST reference}"
: "${IMAGE_SECURITY_REPORT:?set the exact-image Trivy JSON report path}"
: "${IMAGE_SECURITY_REPORT_SHA256:?set the reviewed Trivy report SHA-256}"
: "${IMAGE_SBOM:?set the exact-image CycloneDX SBOM path}"
: "${IMAGE_SBOM_SHA256:?set the reviewed CycloneDX SBOM SHA-256}"
: "${TFVARS:?set the reviewed rehearsal tfvars path}"
: "${AWS_REGION:?set the reviewed rehearsal AWS region}"
: "${EMAILS_ALB_URL:?set the exact rehearsal ALB base URL}"
: "${EMAILS_SMOKE_API_KEY:?set a tenant-scoped read-only rehearsal API key}"
: "${BACKUP_SOURCE_SERVICE:?set the libpq service for the source Emails database}"
: "${BACKUP_ADMIN_SERVICE:?set the libpq service allowed to recreate the isolated restore database}"
: "${BACKUP_RESTORE_SERVICE:?set the libpq service for the isolated restore database}"
: "${BACKUP_RESTORE_DATABASE:?set the isolated restore database name}"
: "${BACKUP_FILE:?set the private database-specific backup path}"
: "${BACKUP_RETENTION_DIR:?set the protected backup retention directory}"
: "${BACKUP_RETAIN_UNTIL:?set the reviewed UTC retention deadline}"
: "${REPAIR_MANIFEST_FILE:?set the private reviewed canonical repair manifest path}"
: "${REPAIR_MANIFEST_SHA256:?set the reviewed canonical repair manifest SHA-256}"
: "${REPAIR_MANIFEST_SECRET_ARN:?set the exact secret ARN carrying the canonical manifest}"
: "${REPAIR_TASK_ROLE_ARN:?set the reviewed attachment-read role with explicit SES/ListBucket denies}"
: "${REPAIR_EXECUTION_ROLE_ARN:?set the reviewed execution role for the DB and manifest secrets}"
: "${REPAIR_TASK_FAMILY:?set the unique reviewed attachment repair task family}"
: "${REPAIR_CONTAINER_NAME:?set the attachment repair container name}"
: "${REPAIR_RESULT_FILE:?set a new private path for the aggregate-only apply result}"
: "${NO_SES_SMOKE_TASK_DEFINITION:?set the exact reviewed no-SES smoke task definition}"
: "${NO_SES_SMOKE_TASK_ROLE_ARN:?set the reviewed role that explicitly denies SES send actions}"
: "${NO_SES_SMOKE_CONTAINER_NAME:?set the exact smoke container name}"

printf '%s' "$RELEASE_VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+([+-][0-9A-Za-z.-]+)?$'
printf '%s' "$RELEASE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
printf '%s' "$SOURCE_ARCHIVE_SHA256" | grep -Eq '^[0-9a-f]{64}$'
printf '%s' "$IMAGE_REPOSITORY" | grep -Eq '^[^@[:space:]]+/[^@[:space:]]+$'
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
test "$IMAGE_REFERENCE" = "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"
printf '%s' "$IMAGE_SECURITY_REPORT_SHA256" | grep -Eq '^[0-9a-f]{64}$'
printf '%s' "$IMAGE_SBOM_SHA256" | grep -Eq '^[0-9a-f]{64}$'
test -s "$IMAGE_SECURITY_REPORT"
test -s "$IMAGE_SBOM"
test "$(sha256sum "$IMAGE_SECURITY_REPORT" | awk '{print $1}')" = "$IMAGE_SECURITY_REPORT_SHA256"
test "$(sha256sum "$IMAGE_SBOM" | awk '{print $1}')" = "$IMAGE_SBOM_SHA256"
printf '%s' "$REPAIR_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$'
printf '%s' "$REPAIR_TASK_FAMILY" | grep -Eq '^[A-Za-z0-9_-]{1,255}$'
printf '%s' "$REPAIR_CONTAINER_NAME" | grep -Eq '^[A-Za-z0-9_-]{1,255}$'
test -s "$REPAIR_MANIFEST_FILE"
test "$(wc -c <"$REPAIR_MANIFEST_FILE")" -le 1048576
REPAIR_MANIFEST_JSON="$(jq -ceS '
  select(type == "object")
  | select((keys | sort) == [
      "apply_idempotency_key",
      "dry_run_idempotency_key",
      "entries",
      "purpose",
      "schema_version",
      "tenant_id"
    ])
  | select(.schema_version == 1 and .purpose == "attachment-repair-ledger")
  | select(.tenant_id
      | type == "string"
      and test("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"))
  | select(.dry_run_idempotency_key
      | type == "string" and length >= 1 and length <= 200
      and test("^[!-~]+$"))
  | select(.apply_idempotency_key
      | type == "string" and length >= 1 and length <= 200
      and test("^[!-~]+$"))
  | select(.dry_run_idempotency_key != .apply_idempotency_key)
  | select(.entries | type == "array" and length >= 1 and length <= 200)
  | select(.entries | all(.[];
      type == "object"
      and (keys | sort) == ["canary_message_ids","object_key","recipients"]
      and (.object_key | type == "string" and length > 0)
      and (.recipients | type == "array" and length > 0
        and all(.[]; type == "string" and length > 0))
      and (.canary_message_ids | type == "array" and length > 0
        and all(.[]; type == "string" and length > 0))))
' "$REPAIR_MANIFEST_FILE")"
test "$(printf '%s' "$REPAIR_MANIFEST_JSON" | sha256sum | awk '{print $1}')" = \
  "$REPAIR_MANIFEST_SHA256"

SOURCE_HEAD="$(git -C "$SOURCE_CHECKOUT" rev-parse --verify 'HEAD^{commit}')"
test "$SOURCE_HEAD" = "$RELEASE_COMMIT"
SOURCE_PACKAGE_JSON="$(git -C "$SOURCE_CHECKOUT" show "$RELEASE_COMMIT:package.json")"
jq -e --arg release_version "$RELEASE_VERSION" \
  '.name == "@hasna/emails" and .version == $release_version' \
  <<<"$SOURCE_PACKAGE_JSON" >/dev/null
ACTUAL_SOURCE_ARCHIVE_SHA256="$(git -C "$SOURCE_CHECKOUT" archive --format=zip "$RELEASE_COMMIT" \
  | sha256sum | awk '{print $1}')"
test "$ACTUAL_SOURCE_ARCHIVE_SHA256" = "$SOURCE_ARCHIVE_SHA256"

case "$REHEARSAL_TOPOLOGY_SHA256" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) printf '%s\n' "invalid rehearsal topology SHA-256" >&2; exit 64 ;;
esac
ACTUAL_TOPOLOGY_SHA256="$(sha256sum -- "$REHEARSAL_TOPOLOGY_MANIFEST" | awk '{print $1}')"
test "$ACTUAL_TOPOLOGY_SHA256" = "$REHEARSAL_TOPOLOGY_SHA256"

EXPECTED_TOPOLOGY_KEYS='["account_id","api_container_name","api_execution_role_arn","api_service","api_task_definition","api_task_role_arn","cluster","dlq_arn","dlq_url","environment","image_digest","image_reference","image_repository","live","migration_container_name","migration_execution_role_arn","migration_task_definition","migration_task_role_arn","private_subnet_ids","purpose","queue_arn","queue_url","region","release_commit","release_version","runtime_architecture","schema_version","source_archive_sha256","task_security_group_id","worker_container_name","worker_execution_role_arn","worker_service","worker_task_definition","worker_task_role_arn"]'
TOPOLOGY_JSON="$(jq -ceS --argjson expected_keys "$EXPECTED_TOPOLOGY_KEYS" \
  --arg release_version "$RELEASE_VERSION" --arg release_commit "$RELEASE_COMMIT" \
  --arg source_archive_sha256 "$SOURCE_ARCHIVE_SHA256" \
  --arg image_repository "$IMAGE_REPOSITORY" --arg image_digest "$IMAGE_DIGEST" \
  --arg image_reference "$IMAGE_REFERENCE" '
  select(type == "object")
  | select((keys | sort) == $expected_keys)
  | select(.schema_version == 1 and .purpose == "isolated-rehearsal")
  | select(.environment == "rehearsal" and .live == false)
  | select(.release_version == $release_version and .release_commit == $release_commit)
  | select(.source_archive_sha256 == $source_archive_sha256)
  | select(.image_repository == $image_repository and .image_digest == $image_digest)
  | select(.image_reference == $image_reference)
  | select(.runtime_architecture == "X86_64")
  | select(.account_id | type == "string" and test("^[0-9]{12}$"))
  | select(.region | type == "string" and test("^[a-z]{2}(-[a-z]+)+-[0-9]+$"))
  | select(all([
      .cluster, .api_service, .worker_service,
      .api_task_definition, .worker_task_definition, .migration_task_definition,
      .api_container_name, .worker_container_name, .migration_container_name,
      .api_task_role_arn, .worker_task_role_arn, .migration_task_role_arn,
      .api_execution_role_arn, .worker_execution_role_arn, .migration_execution_role_arn,
      .queue_url, .queue_arn, .dlq_url, .dlq_arn, .task_security_group_id
    ][]; type == "string" and length > 0))
  | select(.private_subnet_ids | type == "array" and length > 0)
  | select(.private_subnet_ids | all(.[]; type == "string" and startswith("subnet-")))
  | select(.private_subnet_ids | (unique | length) == length)
' "$REHEARSAL_TOPOLOGY_MANIFEST")"

MANIFEST_ACCOUNT_ID="$(jq -r '.account_id' <<<"$TOPOLOGY_JSON")"
MANIFEST_REGION="$(jq -r '.region' <<<"$TOPOLOGY_JSON")"
MANIFEST_ENVIRONMENT="$(jq -r '.environment' <<<"$TOPOLOGY_JSON")"
MANIFEST_LIVE="$(jq -r '.live' <<<"$TOPOLOGY_JSON")"
MANIFEST_CLUSTER="$(jq -r '.cluster' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_SERVICE="$(jq -r '.api_service' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_SERVICE="$(jq -r '.worker_service' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_TASK_DEFINITION="$(jq -r '.api_task_definition' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_TASK_DEFINITION="$(jq -r '.worker_task_definition' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_TASK_DEFINITION="$(jq -r '.migration_task_definition' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_CONTAINER_NAME="$(jq -r '.api_container_name' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_CONTAINER_NAME="$(jq -r '.worker_container_name' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_CONTAINER_NAME="$(jq -r '.migration_container_name' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_TASK_ROLE_ARN="$(jq -r '.api_task_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_TASK_ROLE_ARN="$(jq -r '.worker_task_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_TASK_ROLE_ARN="$(jq -r '.migration_task_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_API_EXECUTION_ROLE_ARN="$(jq -r '.api_execution_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_WORKER_EXECUTION_ROLE_ARN="$(jq -r '.worker_execution_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_MIGRATION_EXECUTION_ROLE_ARN="$(jq -r '.migration_execution_role_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_QUEUE_URL="$(jq -r '.queue_url' <<<"$TOPOLOGY_JSON")"
MANIFEST_QUEUE_ARN="$(jq -r '.queue_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_DLQ_URL="$(jq -r '.dlq_url' <<<"$TOPOLOGY_JSON")"
MANIFEST_DLQ_ARN="$(jq -r '.dlq_arn' <<<"$TOPOLOGY_JSON")"
MANIFEST_SUBNETS="$(jq -cS '.private_subnet_ids | sort' <<<"$TOPOLOGY_JSON")"
MANIFEST_TASK_SG="$(jq -r '.task_security_group_id' <<<"$TOPOLOGY_JSON")"

test -n "$IMAGE_REFERENCE"
test -n "$TFVARS"
test -n "$AWS_REGION"

CLUSTER="$(terraform output -raw ecs_cluster_name)"
API_SERVICE="$(terraform output -raw api_service_name)"
WORKER_SERVICE="$(terraform output -raw worker_service_name)"
QUEUE_URL="$(terraform output -raw inbound_queue_url)"
DLQ_URL="$(terraform output -raw inbound_dlq_url)"
SUBNETS="$(terraform output -json private_subnet_ids | jq -r 'join(",")')"
TASK_SG="$(terraform output -raw ecs_task_security_group_id)"
NETWORK="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$TASK_SG],assignPublicIp=DISABLED}"
INITIAL_API_DEF="$(terraform output -raw api_task_definition_arn)"
INITIAL_WORKER_DEF="$(terraform output -raw worker_task_definition_arn)"
INITIAL_MIGRATION_DEF="$(terraform output -raw migration_task_definition_arn)"
TF_ACCOUNT_ID="$(terraform output -raw operator_account_id)"
TF_SUBNETS="$(terraform output -json private_subnet_ids | jq -cS 'sort')"

require_isolated_rehearsal() {
  if test "$RUNBOOK_MODE" != "isolated-rehearsal"; then
    printf '%s\n' "hard stop: RUNBOOK_MODE is not isolated-rehearsal" >&2
    return 64
  fi
  case "$REHEARSAL_NAME" in
    *rehearsal*) ;;
    *) printf '%s\n' "hard stop: REHEARSAL_NAME must contain rehearsal" >&2; return 64 ;;
  esac
  if test "$REHEARSAL_NAME" != "$MANIFEST_CLUSTER" ||
    test "$CLUSTER" != "$REHEARSAL_NAME" ||
    test "$API_SERVICE" != "${REHEARSAL_NAME}-api" ||
    test "$WORKER_SERVICE" != "${REHEARSAL_NAME}-worker"; then
    printf '%s\n' "hard stop: topology is not the exact generic rehearsal topology" >&2
    return 64
  fi
  if test "$MANIFEST_ENVIRONMENT" != "rehearsal" || test "$MANIFEST_LIVE" != "false"; then
    printf '%s\n' "hard stop: manifest is not sealed as a non-live rehearsal" >&2
    return 64
  fi
  if test "$REHEARSAL_ACCOUNT_ID" != "$MANIFEST_ACCOUNT_ID" ||
    test "$TF_ACCOUNT_ID" != "$MANIFEST_ACCOUNT_ID"; then
    printf '%s\n' "hard stop: rehearsal account identity mismatch" >&2
    return 64
  fi
}

rehearsal_terraform() {
  require_isolated_rehearsal
  command terraform "$@"
}

rehearsal_aws() {
  require_isolated_rehearsal
  command aws "$@"
}

require_isolated_rehearsal
test "$AWS_REGION" = "$MANIFEST_REGION"
test "$(aws sts get-caller-identity --query Account --output text)" = "$MANIFEST_ACCOUNT_ID"
test "$API_SERVICE" = "$MANIFEST_API_SERVICE"
test "$WORKER_SERVICE" = "$MANIFEST_WORKER_SERVICE"
test "$INITIAL_API_DEF" = "$MANIFEST_API_TASK_DEFINITION"
test "$INITIAL_WORKER_DEF" = "$MANIFEST_WORKER_TASK_DEFINITION"
test "$INITIAL_MIGRATION_DEF" = "$MANIFEST_MIGRATION_TASK_DEFINITION"
test "$QUEUE_URL" = "$MANIFEST_QUEUE_URL"
test "$DLQ_URL" = "$MANIFEST_DLQ_URL"
test "$TF_SUBNETS" = "$MANIFEST_SUBNETS"
test "$TASK_SG" = "$MANIFEST_TASK_SG"

SERVICE_PREFLIGHT_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
jq -e --arg api_service "$MANIFEST_API_SERVICE" \
  --arg worker_service "$MANIFEST_WORKER_SERVICE" \
  --arg api_definition "$MANIFEST_API_TASK_DEFINITION" \
  --arg worker_definition "$MANIFEST_WORKER_TASK_DEFINITION" '
  (.failures | length) == 0
  and (.services | length) == 2
  and any(.services[]; .serviceName == $api_service and .taskDefinition == $api_definition)
  and any(.services[]; .serviceName == $worker_service and .taskDefinition == $worker_definition)
' <<<"$SERVICE_PREFLIGHT_JSON" >/dev/null

API_TASK_PREFLIGHT_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MANIFEST_API_TASK_DEFINITION" --output json)"
WORKER_TASK_PREFLIGHT_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MANIFEST_WORKER_TASK_DEFINITION" --output json)"
MIGRATION_TASK_PREFLIGHT_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MANIFEST_MIGRATION_TASK_DEFINITION" --output json)"

assert_task_identity() {
  task_json="$1"
  definition="$2"
  task_role="$3"
  execution_role="$4"
  container_name="$5"
  jq -e --arg definition "$definition" --arg task_role "$task_role" \
    --arg execution_role "$execution_role" --arg container_name "$container_name" '
    (.taskDefinition.taskDefinitionArn == $definition)
    and (.taskDefinition.taskRoleArn == $task_role)
    and (.taskDefinition.executionRoleArn == $execution_role)
    and (.taskDefinition.containerDefinitions | length == 1)
    and (.taskDefinition.containerDefinitions[0].name == $container_name)
  ' <<<"$task_json" >/dev/null
}

assert_task_identity "$API_TASK_PREFLIGHT_JSON" "$MANIFEST_API_TASK_DEFINITION" \
  "$MANIFEST_API_TASK_ROLE_ARN" "$MANIFEST_API_EXECUTION_ROLE_ARN" "$MANIFEST_API_CONTAINER_NAME"
assert_task_identity "$WORKER_TASK_PREFLIGHT_JSON" "$MANIFEST_WORKER_TASK_DEFINITION" \
  "$MANIFEST_WORKER_TASK_ROLE_ARN" "$MANIFEST_WORKER_EXECUTION_ROLE_ARN" "$MANIFEST_WORKER_CONTAINER_NAME"
assert_task_identity "$MIGRATION_TASK_PREFLIGHT_JSON" "$MANIFEST_MIGRATION_TASK_DEFINITION" \
  "$MANIFEST_MIGRATION_TASK_ROLE_ARN" "$MANIFEST_MIGRATION_EXECUTION_ROLE_ARN" \
  "$MANIFEST_MIGRATION_CONTAINER_NAME"

IMAGE_REGISTRY="${IMAGE_REPOSITORY%%/*}"
ECR_REPOSITORY_NAME="${IMAGE_REPOSITORY#*/}"
test "$ECR_REPOSITORY_NAME" != "$IMAGE_REPOSITORY"
case "$IMAGE_REGISTRY" in
  "${MANIFEST_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"|\
  "${MANIFEST_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com.cn") ;;
  *) printf '%s\n' "image repository is not in the reviewed account and region" >&2; exit 64 ;;
esac

IMAGE_DETAILS_JSON="$(rehearsal_aws ecr describe-images --region "$AWS_REGION" \
  --registry-id "$MANIFEST_ACCOUNT_ID" --repository-name "$ECR_REPOSITORY_NAME" \
  --image-ids "imageDigest=$IMAGE_DIGEST" --output json)"
jq -e --arg image_digest "$IMAGE_DIGEST" '
  (.imageDetails | length == 1)
  and (.imageDetails[0].imageDigest == $image_digest)
' <<<"$IMAGE_DETAILS_JSON" >/dev/null

# ECR Basic Scanning does not support scratch images, and its legacy summary
# fields are not authoritative here. Require a pinned independent scanner report
# and SBOM generated from the exact immutable registry reference instead.
jq -e --arg image_reference "$IMAGE_REFERENCE" '
  (.ArtifactName == $image_reference)
  and (.Metadata | type == "object")
  and (.Metadata.RepoDigests | type == "array" and index($image_reference) != null)
  and (.Results | type == "array")
  and (([.Results[]? | select(.Class == "os-pkgs") | .Packages[]?] | length) > 0)
  and (([.Results[]? | select(.Class == "lang-pkgs") | .Packages[]?] | length) > 0)
  and (([
    .Results[]?.Vulnerabilities[]?
    | select(.Severity == "CRITICAL" or .Severity == "HIGH")
  ] | length) == 0)
' "$IMAGE_SECURITY_REPORT" >/dev/null
jq -e --arg image_reference "$IMAGE_REFERENCE" '
  (.bomFormat == "CycloneDX")
  and (.specVersion | type == "string")
  and (.components | type == "array" and length > 0)
  and (([
    .metadata.component.properties[]?
    | select(.name == "aquasecurity:trivy:RepoDigest" and .value == $image_reference)
  ] | length) == 1)
' "$IMAGE_SBOM" >/dev/null

IMAGE_MANIFEST_JSON="$(rehearsal_aws ecr batch-get-image --region "$AWS_REGION" \
  --registry-id "$MANIFEST_ACCOUNT_ID" --repository-name "$ECR_REPOSITORY_NAME" \
  --image-ids "imageDigest=$IMAGE_DIGEST" \
  --accepted-media-types application/vnd.oci.image.manifest.v1+json \
    application/vnd.docker.distribution.manifest.v2+json \
  --query 'images[0].imageManifest' --output text)"
IMAGE_CONFIG_DIGEST="$(jq -er '.config.digest | select(test("^sha256:[0-9a-f]{64}$"))' \
  <<<"$IMAGE_MANIFEST_JSON")"
IMAGE_CONFIG_URL="$(rehearsal_aws ecr get-download-url-for-layer --region "$AWS_REGION" \
  --registry-id "$MANIFEST_ACCOUNT_ID" --repository-name "$ECR_REPOSITORY_NAME" \
  --layer-digest "$IMAGE_CONFIG_DIGEST" --query downloadUrl --output text)"
IMAGE_CONFIG_JSON="$(curl --fail --silent --show-error "$IMAGE_CONFIG_URL")"
jq -e --arg release_commit "$RELEASE_COMMIT" --arg release_version "$RELEASE_VERSION" '
  (.architecture == "amd64")
  and (.os == "linux")
  and (.config.Labels["org.opencontainers.image.revision"] == $release_commit)
  and (.config.Labels["org.opencontainers.image.version"] == $release_version)
' <<<"$IMAGE_CONFIG_JSON" >/dev/null

INITIAL_QUEUE_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn RedrivePolicy ApproximateNumberOfMessages \
    ApproximateNumberOfMessagesNotVisible VisibilityTimeout --output json)"
INITIAL_DLQ_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$DLQ_URL" \
  --attribute-names QueueArn ApproximateNumberOfMessages \
    ApproximateNumberOfMessagesNotVisible --output json)"
QUEUE_ARN="$(jq -er '.Attributes.QueueArn' <<<"$INITIAL_QUEUE_COUNTS")"
DLQ_ARN="$(jq -er '.Attributes.QueueArn' <<<"$INITIAL_DLQ_COUNTS")"
test "$QUEUE_ARN" = "$MANIFEST_QUEUE_ARN"
test "$DLQ_ARN" = "$MANIFEST_DLQ_ARN"
jq -e --arg dlq_arn "$DLQ_ARN" \
  '.Attributes.RedrivePolicy | fromjson | .deadLetterTargetArn == $dlq_arn' \
  <<<"$INITIAL_QUEUE_COUNTS" >/dev/null
INITIAL_DLQ_VISIBLE="$(jq -er '.Attributes.ApproximateNumberOfMessages | tonumber' <<<"$INITIAL_DLQ_COUNTS")"
INITIAL_DLQ_IN_FLIGHT="$(jq -er '.Attributes.ApproximateNumberOfMessagesNotVisible | tonumber' <<<"$INITIAL_DLQ_COUNTS")"
test "$INITIAL_DLQ_VISIBLE" = "0"
test "$INITIAL_DLQ_IN_FLIGHT" = "0"
printf '%s\n' "$INITIAL_QUEUE_COUNTS" "$INITIAL_DLQ_COUNTS"

ORIGINAL_WORKER_COUNT="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --query 'services[0].desiredCount' --output text)"
ORIGINAL_API_COUNT="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].desiredCount' --output text)"
WORKER_MIN="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text)"
WORKER_MAX="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --query 'services[0].deploymentConfiguration.maximumPercent' --output text)"
API_MIN="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text)"
API_MAX="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].deploymentConfiguration.maximumPercent' --output text)"
test "$ORIGINAL_WORKER_COUNT" -gt 0
test "$ORIGINAL_API_COUNT" -gt 0

aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'

# Register only reviewed release definitions. Neither service may be updated by
# this targeted plan, and all desired counts remain unchanged at this point.
rehearsal_terraform plan -var-file="$TFVARS" -var="container_image=$IMAGE_REFERENCE" \
  -var="container_architecture=X86_64" \
  -var="enable_automatic_deployment_rollback=false" \
  -target=aws_ecs_task_definition.migration \
  -target=aws_ecs_task_definition.worker \
  -target=aws_ecs_task_definition.api \
  -out=0020-definitions.tfplan
terraform show 0020-definitions.tfplan
rehearsal_terraform apply 0020-definitions.tfplan

MIGRATION_DEF="$(terraform output -raw migration_task_definition_arn)"
WORKER_DEF="$(terraform output -raw worker_task_definition_arn)"
API_DEF="$(terraform output -raw api_task_definition_arn)"

STAGED_MIGRATION_TASK_JSON="$(rehearsal_aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$MIGRATION_DEF" --output json)"
STAGED_WORKER_TASK_JSON="$(rehearsal_aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$WORKER_DEF" --output json)"
STAGED_API_TASK_JSON="$(rehearsal_aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$API_DEF" --output json)"

assert_staged_task_definition() {
  task_json="$1"
  definition="$2"
  task_role="$3"
  execution_role="$4"
  container_name="$5"
  jq -e --arg definition "$definition" --arg task_role "$task_role" \
    --arg execution_role "$execution_role" --arg container_name "$container_name" \
    --arg image_reference "$IMAGE_REFERENCE" '
    (.taskDefinition.taskDefinitionArn == $definition)
    and (.taskDefinition.taskRoleArn == $task_role)
    and (.taskDefinition.executionRoleArn == $execution_role)
    and (.taskDefinition.runtimePlatform.cpuArchitecture == "X86_64")
    and (.taskDefinition.runtimePlatform.operatingSystemFamily == "LINUX")
    and (.taskDefinition.containerDefinitions | length == 1)
    and (.taskDefinition.containerDefinitions[0].name == $container_name)
    and (.taskDefinition.containerDefinitions[0].image == $image_reference)
  ' <<<"$task_json" >/dev/null
}

assert_staged_task_definition "$STAGED_MIGRATION_TASK_JSON" "$MIGRATION_DEF" \
  "$MANIFEST_MIGRATION_TASK_ROLE_ARN" "$MANIFEST_MIGRATION_EXECUTION_ROLE_ARN" \
  "$MANIFEST_MIGRATION_CONTAINER_NAME"
assert_staged_task_definition "$STAGED_WORKER_TASK_JSON" "$WORKER_DEF" \
  "$MANIFEST_WORKER_TASK_ROLE_ARN" "$MANIFEST_WORKER_EXECUTION_ROLE_ARN" \
  "$MANIFEST_WORKER_CONTAINER_NAME"
assert_staged_task_definition "$STAGED_API_TASK_JSON" "$API_DEF" \
  "$MANIFEST_API_TASK_ROLE_ARN" "$MANIFEST_API_EXECUTION_ROLE_ARN" \
  "$MANIFEST_API_CONTAINER_NAME"

ROLLBACK_DISABLE_WORKER_JSON="$(rehearsal_aws ecs update-service --region "$AWS_REGION" \
  --cluster "$CLUSTER" --service "$WORKER_SERVICE" \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=false},minimumHealthyPercent=$WORKER_MIN,maximumPercent=$WORKER_MAX" \
  --output json)"
ROLLBACK_DISABLE_API_JSON="$(rehearsal_aws ecs update-service --region "$AWS_REGION" \
  --cluster "$CLUSTER" --service "$API_SERVICE" \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=false},minimumHealthyPercent=$API_MIN,maximumPercent=$API_MAX" \
  --output json)"
jq -e '.service.deploymentConfiguration.deploymentCircuitBreaker.rollback == false' \
  <<<"$ROLLBACK_DISABLE_WORKER_JSON" >/dev/null
jq -e '.service.deploymentConfiguration.deploymentCircuitBreaker.rollback == false' \
  <<<"$ROLLBACK_DISABLE_API_JSON" >/dev/null
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE"

ROLLBACK_DISABLED_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
jq -e --arg worker "$WORKER_SERVICE" --arg api "$API_SERVICE" '
  (.failures | length) == 0
  and (.services | length == 2)
  and all(.services[];
    (.serviceName == $worker or .serviceName == $api)
    and .deploymentConfiguration.deploymentCircuitBreaker.rollback == false)
' <<<"$ROLLBACK_DISABLED_JSON" >/dev/null

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$WORKER_SERVICE" --desired-count 0
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE"

WORKER_ZERO_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" --output json)"
jq -e --arg service "$WORKER_SERVICE" '
  (.failures | length) == 0
  and (.services | length) == 1
  and (.services[0].serviceName == $service)
  and (.services[0].desiredCount == 0)
  and (.services[0].runningCount == 0)
  and (.services[0].deploymentConfiguration.deploymentCircuitBreaker.rollback == false)
' <<<"$WORKER_ZERO_JSON" >/dev/null
WORKER_ZERO_TASK_COUNT="$(aws ecs list-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service-name "$WORKER_SERVICE" --query 'length(taskArns)' --output text)"
test "$WORKER_ZERO_TASK_COUNT" = "0"

# SQS counts are approximate. Require three consecutive bounded reads with no
# in-flight message before stopping the API or accepting the worker as drained.
QUEUE_IN_FLIGHT_STABLE_READS=0
for attempt in $(seq 1 12); do
  CURRENT_QUEUE_IN_FLIGHT="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.ApproximateNumberOfMessagesNotVisible' --output text)"
  if test "$CURRENT_QUEUE_IN_FLIGHT" = "0"; then
    QUEUE_IN_FLIGHT_STABLE_READS=$((QUEUE_IN_FLIGHT_STABLE_READS + 1))
  else
    QUEUE_IN_FLIGHT_STABLE_READS=0
  fi
  test "$QUEUE_IN_FLIGHT_STABLE_READS" -ge 3 && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
test "$QUEUE_IN_FLIGHT_STABLE_READS" -ge 3

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$API_SERVICE" --desired-count 0
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE"

SERVICE_ZERO_JSON="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
jq -e --arg worker "$WORKER_SERVICE" --arg api "$API_SERVICE" '
  (.failures | length) == 0
  and (.services | length) == 2
  and all(.services[];
    (.serviceName == $worker or .serviceName == $api)
    and .desiredCount == 0
    and .runningCount == 0
    and .deploymentConfiguration.deploymentCircuitBreaker.rollback == false)
' <<<"$SERVICE_ZERO_JSON" >/dev/null
WORKER_ZERO_TASK_COUNT_AFTER_API="$(aws ecs list-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service-name "$WORKER_SERVICE" --query 'length(taskArns)' --output text)"
API_ZERO_TASK_COUNT="$(aws ecs list-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service-name "$API_SERVICE" --query 'length(taskArns)' --output text)"
test "$WORKER_ZERO_TASK_COUNT_AFTER_API" = "0"
test "$API_ZERO_TASK_COUNT" = "0"

# Capture the PostgreSQL wall-clock cutoff only after machine-readable service,
# task-list, and queue checks prove every old writer is gone. PostgreSQL fixes a
# row's created_at default at transaction start, so a pre-fence old transaction
# could otherwise commit after the cutoff while remaining outside the audit.
# This exact release one-shot does not query migration 0017 through 0020 tables and
# is safe before the ledger advances.
FENCE_OVERRIDES='{"containerOverrides":[{"name":"worker","command":["src/server/index.ts","inbound-provenance-fence"]}]}'
FENCE_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$WORKER_DEF" \
  --network-configuration "$NETWORK" --count 1 --overrides "$FENCE_OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$FENCE_TASK"
FENCE_EXIT="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$FENCE_TASK" \
  --query 'tasks[0].containers[?name==`worker`].exitCode | [0]' --output text)"
test "$FENCE_EXIT" = "0"
FENCE_TASK_ID="${FENCE_TASK##*/}"
FENCE_JSON=""
for attempt in $(seq 1 12); do
  FENCE_LOG_EVENTS="$(aws logs get-log-events --region "$AWS_REGION" \
    --log-group-name "/ecs/${CLUSTER}/worker" --log-stream-name "worker/worker/${FENCE_TASK_ID}" \
    --start-from-head --output json)"
  FENCE_JSON="$(jq -cer '[.events[].message | fromjson? | select((keys | sort) == ["fence_at"])]
    | select(length == 1) | .[0]' <<<"$FENCE_LOG_EVENTS" 2>/dev/null || true)"
  test -n "$FENCE_JSON" && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
FENCE_AT="$(jq -er '.fence_at | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))' <<<"$FENCE_JSON")"
printf '%s\n' "$FENCE_JSON"
```

The worker must first show desired/running zero, an empty service task list, and
three consecutive zero in-flight SQS reads. Only then may the API stop. Both
services must subsequently pass the same machine-readable desired/running-zero
and empty-task-list checks before the release one-shot captures `FENCE_AT`. Record
the service JSON, task counts, queue/DLQ counts, and PostgreSQL-derived cutoff.

### 1a. Create, checksum, restore-test, and retain the database-specific backup

Both services and all one-shot writers remain at zero. The libpq service files
referenced below must be mode 0600 or stricter and must not be printed.

```bash
set -euo pipefail
umask 077

printf '%s' "$BACKUP_RETAIN_UNTIL" |
  grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
test "$(date -u -d "$BACKUP_RETAIN_UNTIL" +%s)" -gt "$(date -u +%s)"
test ! -e "$BACKUP_FILE"
for service_name in \
  "$BACKUP_SOURCE_SERVICE" \
  "$BACKUP_ADMIN_SERVICE" \
  "$BACKUP_RESTORE_SERVICE"; do
  printf '%s' "$service_name" | grep -Eq '^[A-Za-z0-9_.-]+$'
done
printf '%s' "$BACKUP_RESTORE_DATABASE" | grep -Eq '^[A-Za-z0-9_.-]+$'

pg_dump --format=custom --no-owner --no-privileges \
  --dbname="service=$BACKUP_SOURCE_SERVICE" --file="$BACKUP_FILE"
BACKUP_SHA256_FILE="${BACKUP_FILE}.sha256"
sha256sum -- "$BACKUP_FILE" >"$BACKUP_SHA256_FILE"
sha256sum --check -- "$BACKUP_SHA256_FILE"

dropdb --if-exists --maintenance-db="service=$BACKUP_ADMIN_SERVICE" \
  -- "$BACKUP_RESTORE_DATABASE"
createdb --maintenance-db="service=$BACKUP_ADMIN_SERVICE" \
  -- "$BACKUP_RESTORE_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="service=$BACKUP_RESTORE_SERVICE" "$BACKUP_FILE"

SOURCE_LEDGER_SHA256="$(
  psql "service=$BACKUP_SOURCE_SERVICE" -XAt \
    -c 'SELECT migration_id || chr(9) || checksum FROM schema_migrations ORDER BY migration_id' |
    sha256sum | awk '{print $1}'
)"
RESTORE_LEDGER_SHA256="$(
  psql "service=$BACKUP_RESTORE_SERVICE" -XAt \
    -c 'SELECT migration_id || chr(9) || checksum FROM schema_migrations ORDER BY migration_id' |
    sha256sum | awk '{print $1}'
)"
test "$SOURCE_LEDGER_SHA256" = "$RESTORE_LEDGER_SHA256"

install -d -m 0700 -- "$BACKUP_RETENTION_DIR"
RETAINED_BACKUP="$BACKUP_RETENTION_DIR/$(basename "$BACKUP_FILE")"
RETAINED_SHA256_FILE="$BACKUP_RETENTION_DIR/$(basename "$BACKUP_SHA256_FILE")"
test ! -e "$RETAINED_BACKUP"
test ! -e "$RETAINED_SHA256_FILE"
install -m 0600 -- "$BACKUP_FILE" "$RETAINED_BACKUP"
(cd "$BACKUP_RETENTION_DIR" &&
  sha256sum -- "$(basename "$RETAINED_BACKUP")" >"$(basename "$RETAINED_SHA256_FILE")")
chmod 0600 -- "$RETAINED_SHA256_FILE"
printf '%s\n' "$BACKUP_RETAIN_UNTIL" >"$BACKUP_RETENTION_DIR/retain-until"
chmod 0600 -- "$BACKUP_RETENTION_DIR/retain-until"
(cd "$BACKUP_RETENTION_DIR" &&
  sha256sum --check -- "$(basename "$RETAINED_SHA256_FILE")")
```

The successful restore and exact migration-ledger hash equality are mandatory.
The retained backup, checksum, and `retain-until` marker remain protected until
the reviewed deadline; this procedure contains no deletion step.

### 2. Migrate and verify ledger 0020

The three reviewed release definitions are already staged, every old task is
machine-proven absent, the stable queue in-flight gate passed, and only then was
the database-clock fence recorded. Automatic rollback stays disabled.

```bash
set -euo pipefail

MIGRATION_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$MIGRATION_DEF" \
  --network-configuration "$NETWORK" --count 1 \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$MIGRATION_TASK"
MIGRATION_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --tasks "$MIGRATION_TASK" --output json)"
MIGRATION_EXIT="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $container) | .exitCode' <<<"$MIGRATION_TASK_JSON")"
test "$MIGRATION_EXIT" = "0"

STATUS_OVERRIDES="$(jq -cn --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" \
  '{containerOverrides:[{name:$container,command:["src/cli/index.tsx","--json","db","status"]}]}')"
STATUS_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$MIGRATION_DEF" \
  --network-configuration "$NETWORK" --count 1 \
  --overrides "$STATUS_OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$STATUS_TASK"
STATUS_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --tasks "$STATUS_TASK" --output json)"
STATUS_EXIT="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $container) | .exitCode' <<<"$STATUS_TASK_JSON")"
test "$STATUS_EXIT" = "0"

MIGRATION_LOG_GROUP="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-group"]
' <<<"$STAGED_MIGRATION_TASK_JSON")"
MIGRATION_LOG_STREAM_PREFIX="$(jq -er --arg container "$MANIFEST_MIGRATION_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-stream-prefix"]
' <<<"$STAGED_MIGRATION_TASK_JSON")"
STATUS_TASK_ID="${STATUS_TASK##*/}"
STATUS_LOG_STREAM="${MIGRATION_LOG_STREAM_PREFIX}/${MANIFEST_MIGRATION_CONTAINER_NAME}/${STATUS_TASK_ID}"
STATUS_JSON=""
for attempt in $(seq 1 12); do
  STATUS_LOG_EVENTS="$(aws logs get-log-events --region "$AWS_REGION" \
    --log-group-name "$MIGRATION_LOG_GROUP" --log-stream-name "$STATUS_LOG_STREAM" \
    --start-from-head --output json)"
  STATUS_JSON="$(jq -cer '
    [.events[].message | fromjson?
      | select((keys | sort) == ["alreadyApplied","applied","pending"])]
    | select(length == 1) | .[0]
  ' <<<"$STATUS_LOG_EVENTS" 2>/dev/null || true)"
  test -n "$STATUS_JSON" && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
jq -e '
  ((keys | sort) == ["alreadyApplied","applied","pending"])
  and (.applied | type == "array" and length == 0)
  and (.pending | type == "array" and length == 0)
  and (.alreadyApplied | type == "array" and all(.[]; type == "string"))
  and (.alreadyApplied | index("0017_inbound_message_source_provenance") != null)
  and (.alreadyApplied | index("0018_send_intent_recovery") != null)
  and (.alreadyApplied | index("0019_inbox_perf_rollups") != null)
  and (.alreadyApplied | index("0020_attachment_repair_ledger") != null)
' <<<"$STATUS_JSON" >/dev/null
printf '%s\n' "$STATUS_JSON"
```

Both tasks must exit zero, and the exact status task's exact CloudWatch stream
must contain one object with only the source-defined `applied`, `alreadyApplied`,
and `pending` fields. The machine gate requires `pending: []`, no dry-run
applications, `0017_inbound_message_source_provenance` in `alreadyApplied`, and
`0018_send_intent_recovery`, `0019_inbox_perf_rollups`, and
`0020_attachment_repair_ledger` in `alreadyApplied`.
`emails db status --json` emits that object only after `MigrationLedger` validates
every stored `schema_migrations` checksum; checksum drift exits before JSON and
therefore cannot satisfy this gate. Do not restart or scale any pre-0020 release
task after this point.

### 3. Complete approved attachment repair with service writers stopped

Both service desired counts must remain zero. Both services must also remain at
running zero. There is no empty,
`required: false`, or local-result waiver: this repair cutover requires the
non-empty, exact-canary canonical manifest already hashed in preflight. Its raw
secret value is never printed or placed in an ECS command override. The
image-bundled `attachment-repair-ledger` command reads that secret, uses only
the deployment-owned canonical inbound bucket, creates or resumes the
tenant-scoped ledger, processes at most 25 entries per page and eight pages per
task, and emits one aggregate-only JSON object. It never lists the bucket and
never emits an object key, recipient, canary id, payload, database URL, secret,
or internal error. The maintenance path must be the only database writer,
and every task and both services must return to zero before worker activation.
Operators must create the exact-canary manifest without `apply`, record a completed dry-run summary, then create the separately
approved `apply: true` run and resume bounded pages until `pending == 0`.
The aggregate promotion gate requires `repaired + would_repair + unavailable + pending == inventory_total` and the
equivalent `entry_*` invariant.
Replays with the same canonical manifest and the same phase key must be treated as
resume-safe and must return the same durable tenant run; they must not create a
duplicate attachment-repair run.
It must perform exact-key `GetObject` calls only: no bucket listing, payload logging, source-key logging, recipient logging,
or caller-supplied bucket is permitted.

Durable repair-ledger ceilings are hard:
`active runs = 2`, `ledger runs = 100`, and `ledger entries = 20,000` (tenant scope).
There is no dependency edit or dependency-path command in this repo for pruning those
completed rows. If a ceiling is reached, escalate to operator approval and source
scope change; do not bypass quota checks or invent cleanup.

The one-shot task is operator-only infrastructure, not an API route. Clone it
from the exact reviewed release API task definition, replace the runtime role
with the reviewed no-SES/no-ListBucket repair role, replace the execution role
with one allowed to inject only the exact application DB and manifest secrets,
remove API ports and health checks, add the canonical bucket copied from the
reviewed release worker definition, and preserve the API definition's image,
CPU, memory, network mode, X86_64 runtime, read-only filesystem, `/tmp` mount,
logging, and image revision. The default command is intentionally incomplete;
only the exact `run-task` overrides below can supply a phase and reviewed
provenance. Inside Fargate, the command independently reads
`ECS_CONTAINER_METADATA_URI_V4` and fails unless the live task ARN, derived task
definition ARN, container image digest, and OCI image revision equal those
reviewed inputs.

```bash
set -euo pipefail

REPAIR_DATABASE_SECRET_ARN="$(jq -er --arg container "$MANIFEST_API_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[]
  | select(.name == $container)
  | [.secrets[] | select(.name == "EMAILS_DATABASE_URL") | .valueFrom]
  | select(length == 1) | .[0]
' <<<"$STAGED_API_TASK_JSON")"
REPAIR_CANONICAL_BUCKET="$(jq -er --arg container "$MANIFEST_WORKER_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[]
  | select(.name == $container)
  | [.environment[]
      | select(.name == "EMAILS_INGEST_S3_BUCKET")
      | .value]
  | select(length == 1 and .[0] != "") | .[0]
' <<<"$STAGED_WORKER_TASK_JSON")"

REPAIR_ROLE_DENIALS="$(aws iam simulate-principal-policy \
  --policy-source-arn "$REPAIR_TASK_ROLE_ARN" \
  --action-names ses:SendEmail ses:SendRawEmail s3:ListBucket --output json)"
jq -e '
  (.EvaluationResults | length == 3)
  and all(.EvaluationResults[]; .EvalDecision == "explicitDeny")
' <<<"$REPAIR_ROLE_DENIALS" >/dev/null

REPAIR_SECRET_READS="$(aws iam simulate-principal-policy \
  --policy-source-arn "$REPAIR_EXECUTION_ROLE_ARN" \
  --action-names secretsmanager:GetSecretValue \
  --resource-arns "$REPAIR_DATABASE_SECRET_ARN" "$REPAIR_MANIFEST_SECRET_ARN" \
  --output json)"
jq -e '
  (.EvaluationResults | length == 2)
  and all(.EvaluationResults[]; .EvalDecision == "allowed")
' <<<"$REPAIR_SECRET_READS" >/dev/null

REPAIR_TASK_INPUT="$(jq -ce \
  --arg family "$REPAIR_TASK_FAMILY" \
  --arg api_container "$MANIFEST_API_CONTAINER_NAME" \
  --arg repair_container "$REPAIR_CONTAINER_NAME" \
  --arg task_role "$REPAIR_TASK_ROLE_ARN" \
  --arg execution_role "$REPAIR_EXECUTION_ROLE_ARN" \
  --arg database_secret "$REPAIR_DATABASE_SECRET_ARN" \
  --arg manifest_secret "$REPAIR_MANIFEST_SECRET_ARN" \
  --arg canonical_bucket "$REPAIR_CANONICAL_BUCKET" \
  --arg revision "$RELEASE_COMMIT" '
  .taskDefinition
  | del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy,
      .deregisteredAt
    )
  | .family = $family
  | .taskRoleArn = $task_role
  | .executionRoleArn = $execution_role
  | .containerDefinitions = [
      .containerDefinitions[]
      | select(.name == $api_container)
      | .name = $repair_container
      | .command = ["src/server/index.ts","attachment-repair-ledger"]
      | .environment = (
          [.environment[]?
            | select(.name != "EMAILS_INGEST_S3_BUCKET"
              and .name != "EMAILS_IMAGE_REVISION")]
          + [{
              name:"EMAILS_INGEST_S3_BUCKET",
              value:$canonical_bucket
            },{
              name:"EMAILS_IMAGE_REVISION",
              value:$revision
            }]
        )
      | .secrets = [
          {name:"EMAILS_DATABASE_URL",valueFrom:$database_secret},
          {name:"EMAILS_ATTACHMENT_REPAIR_MANIFEST",valueFrom:$manifest_secret}
        ]
      | del(.portMappings, .healthCheck)
    ]
' <<<"$STAGED_API_TASK_JSON")"

REPAIR_TASK_DEFINITION_JSON="$(rehearsal_aws ecs register-task-definition \
  --region "$AWS_REGION" --cli-input-json "$REPAIR_TASK_INPUT" --output json)"
REPAIR_TASK_DEFINITION_ARN="$(jq -er '.taskDefinition.taskDefinitionArn' \
  <<<"$REPAIR_TASK_DEFINITION_JSON")"

jq -e \
  --arg family "$REPAIR_TASK_FAMILY" \
  --arg container "$REPAIR_CONTAINER_NAME" \
  --arg image "$IMAGE_REFERENCE" \
  --arg task_role "$REPAIR_TASK_ROLE_ARN" \
  --arg execution_role "$REPAIR_EXECUTION_ROLE_ARN" \
  --arg database_secret "$REPAIR_DATABASE_SECRET_ARN" \
  --arg manifest_secret "$REPAIR_MANIFEST_SECRET_ARN" \
  --arg canonical_bucket "$REPAIR_CANONICAL_BUCKET" \
  --arg revision "$RELEASE_COMMIT" \
  --argjson api "$STAGED_API_TASK_JSON" '
  .taskDefinition.family == $family
  and .taskDefinition.taskRoleArn == $task_role
  and .taskDefinition.executionRoleArn == $execution_role
  and .taskDefinition.networkMode == $api.taskDefinition.networkMode
  and .taskDefinition.cpu == $api.taskDefinition.cpu
  and .taskDefinition.memory == $api.taskDefinition.memory
  and .taskDefinition.runtimePlatform.cpuArchitecture == "X86_64"
  and .taskDefinition.runtimePlatform == $api.taskDefinition.runtimePlatform
  and .taskDefinition.requiresCompatibilities == $api.taskDefinition.requiresCompatibilities
  and (.taskDefinition.containerDefinitions | length) == 1
  and (.taskDefinition.containerDefinitions[0] as $repair
    | $repair.name == $container
    and $repair.image == $image
    and $repair.command == ["src/server/index.ts","attachment-repair-ledger"]
    and $repair.readonlyRootFilesystem == true
    and ($repair.portMappings | length) == 0
    and ($repair | has("healthCheck") | not)
    and ([$repair.environment[]
      | select(.name == "EMAILS_INGEST_S3_BUCKET" and .value == $canonical_bucket)]
      | length) == 1
    and ([$repair.environment[]
      | select(.name == "EMAILS_IMAGE_REVISION" and .value == $revision)]
      | length) == 1
    and ([$repair.secrets[] | {name,valueFrom}] | sort_by(.name)) == ([
      {name:"EMAILS_DATABASE_URL",valueFrom:$database_secret},
      {name:"EMAILS_ATTACHMENT_REPAIR_MANIFEST",valueFrom:$manifest_secret}
    ] | sort_by(.name)))
' <<<"$REPAIR_TASK_DEFINITION_JSON" >/dev/null

REPAIR_LOG_GROUP="$(jq -er --arg container "$REPAIR_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[]
  | select(.name == $container)
  | .logConfiguration.options["awslogs-group"]
' <<<"$REPAIR_TASK_DEFINITION_JSON")"
REPAIR_LOG_PREFIX="$(jq -er --arg container "$REPAIR_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[]
  | select(.name == $container)
  | .logConfiguration.options["awslogs-stream-prefix"]
' <<<"$REPAIR_TASK_DEFINITION_JSON")"

run_repair_task() {
  phase=$1
  expected_run_id=$2
  dry_run_id=$3
  dry_run_result_sha256=$4

  command_json="$(jq -cn \
    --arg phase "$phase" \
    --arg manifest_sha "$REPAIR_MANIFEST_SHA256" \
    --arg definition "$REPAIR_TASK_DEFINITION_ARN" \
    --arg digest "$IMAGE_DIGEST" \
    --arg revision "$RELEASE_COMMIT" \
    --arg container "$REPAIR_CONTAINER_NAME" \
    --arg expected_run_id "$expected_run_id" \
    --arg dry_run_id "$dry_run_id" \
    --arg dry_run_result_sha256 "$dry_run_result_sha256" '
    [
      "src/server/index.ts",
      "attachment-repair-ledger",
      "--phase",$phase,
      "--manifest-sha256",$manifest_sha,
      "--page-limit","25",
      "--max-pages","8",
      "--task-definition-arn",$definition,
      "--image-digest",$digest,
      "--image-revision",$revision,
      "--container-name",$container
    ]
    + if $expected_run_id == "" then []
      else ["--expected-run-id",$expected_run_id] end
    + if $phase == "apply" then [
        "--dry-run-id",$dry_run_id,
        "--dry-run-result-sha256",$dry_run_result_sha256
      ] else [] end
  ')"
  overrides="$(jq -cn --arg container "$REPAIR_CONTAINER_NAME" \
    --argjson command "$command_json" \
    '{containerOverrides:[{name:$container,command:$command}]}')"

  LAST_REPAIR_TASK_ARN="$(rehearsal_aws ecs run-task \
    --region "$AWS_REGION" \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$REPAIR_TASK_DEFINITION_ARN" \
    --network-configuration "$NETWORK" \
    --count 1 \
    --overrides "$overrides" \
    --query 'tasks[0].taskArn' \
    --output text)"
  test "$LAST_REPAIR_TASK_ARN" != "None"
  aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" \
    --tasks "$LAST_REPAIR_TASK_ARN"
  LAST_REPAIR_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" \
    --cluster "$CLUSTER" --tasks "$LAST_REPAIR_TASK_ARN" --output json)"
  test "$(jq -er '.tasks[0].taskArn' <<<"$LAST_REPAIR_TASK_JSON")" = \
    "$LAST_REPAIR_TASK_ARN"
  test "$(jq -er '.tasks[0].taskDefinitionArn' <<<"$LAST_REPAIR_TASK_JSON")" = \
    "$REPAIR_TASK_DEFINITION_ARN"
  LAST_REPAIR_EXIT="$(jq -er --arg container "$REPAIR_CONTAINER_NAME" '
    .tasks[0].containers[]
    | select(.name == $container)
    | .exitCode
  ' <<<"$LAST_REPAIR_TASK_JSON")"
  test "$(jq -er --arg container "$REPAIR_CONTAINER_NAME" '
    .tasks[0].containers[]
    | select(.name == $container)
    | .imageDigest
  ' <<<"$LAST_REPAIR_TASK_JSON")" = "$IMAGE_DIGEST"

  REPAIR_RUNNING_TASK_COUNT="$(aws ecs list-tasks --region "$AWS_REGION" \
    --cluster "$CLUSTER" --family "$REPAIR_TASK_FAMILY" \
    --desired-status RUNNING --query 'length(taskArns)' --output text)"
  test "$REPAIR_RUNNING_TASK_COUNT" = "0"
  REPAIR_SERVICES_ZERO_JSON="$(aws ecs describe-services --region "$AWS_REGION" \
    --cluster "$CLUSTER" --services "$WORKER_SERVICE" "$API_SERVICE" --output json)"
  jq -e '
    (.failures | length) == 0
    and (.services | length) == 2
    and all(.services[]; .desiredCount == 0 and .runningCount == 0)
  ' <<<"$REPAIR_SERVICES_ZERO_JSON" >/dev/null

  repair_task_id="${LAST_REPAIR_TASK_ARN##*/}"
  repair_log_stream="${REPAIR_LOG_PREFIX}/${REPAIR_CONTAINER_NAME}/${repair_task_id}"
  LAST_REPAIR_REPORT=""
  for log_attempt in $(seq 1 12); do
    repair_log_events="$(aws logs get-log-events --region "$AWS_REGION" \
      --log-group-name "$REPAIR_LOG_GROUP" \
      --log-stream-name "$repair_log_stream" \
      --start-from-head --output json)"
    LAST_REPAIR_REPORT="$(jq -cer '
      [.events[].message | fromjson?
        | select(type == "object")
        | select(.status == "pass" or .status == "fail")
        | select(.failure_code == null
          or (.failure_code | type == "string"))]
      | select(length == 1) | .[0]
    ' <<<"$repair_log_events" 2>/dev/null || true)"
    test -n "$LAST_REPAIR_REPORT" && break
    test "$log_attempt" -lt 12 || exit 1
    sleep 5
  done
  jq -e \
    --arg phase "$phase" \
    --arg task_arn "$LAST_REPAIR_TASK_ARN" \
    --arg definition "$REPAIR_TASK_DEFINITION_ARN" \
    --arg container "$REPAIR_CONTAINER_NAME" \
    --arg digest "$IMAGE_DIGEST" \
    --arg revision "$RELEASE_COMMIT" \
    --arg manifest_sha "$REPAIR_MANIFEST_SHA256" '
    if (keys | sort) == ["failure_code","status"] then
      .status == "fail" and (.failure_code | type == "string")
    else
      (keys | sort) == [
        "container_name","failure_code","image_digest","image_revision",
        "manifest_sha256","phase","repair","result_sha256","run_id",
        "schema_version","status","task_arn","task_definition_arn"
      ]
      and .schema_version == 1
      and .phase == $phase
      and .task_arn == $task_arn
      and .task_definition_arn == $definition
      and .container_name == $container
      and .image_digest == $digest
      and .image_revision == $revision
      and .manifest_sha256 == $manifest_sha
      and (.run_id
        | type == "string"
        and test("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"))
      and (.result_sha256
        | type == "string"
        and test("^[0-9a-f]{64}$"))
    end
  ' <<<"$LAST_REPAIR_REPORT" >/dev/null
  if jq -e 'has("repair")' <<<"$LAST_REPAIR_REPORT" >/dev/null; then
    reported_repair_json="$(jq -ceS '.repair' <<<"$LAST_REPAIR_REPORT")"
    reported_result_sha256="$(printf '%s' "$reported_repair_json" |
      sha256sum | awk '{print $1}')"
    test "$reported_result_sha256" = \
      "$(jq -er '.result_sha256' <<<"$LAST_REPAIR_REPORT")"
  fi
}

DRY_RUN_ID=""
DRY_RUN_RESULT_SHA256=""
EXPECTED_DRY_RUN_ID=""
for repair_attempt in $(seq 1 24); do
  run_repair_task "dry-run" "$EXPECTED_DRY_RUN_ID" "" ""
  if test "$LAST_REPAIR_EXIT" = "0"; then
    jq -e '
      .status == "pass"
      and .failure_code == null
      and .phase == "dry-run"
      and .repair.apply == false
      and .repair.status == "completed"
      and .repair.unavailable == 0
      and .repair.operator_action == 0
      and .repair.entry_unavailable == 0
      and .repair.entry_operator_action == 0
      and .repair.pending == 0
      and .repair.retrying == 0
      and .repair.entry_pending == 0
      and .repair.entry_retrying == 0
    ' <<<"$LAST_REPAIR_REPORT" >/dev/null
    DRY_RUN_ID="$(jq -er '.run_id' <<<"$LAST_REPAIR_REPORT")"
    DRY_RUN_RESULT_SHA256="$(jq -er '.result_sha256' <<<"$LAST_REPAIR_REPORT")"
    break
  fi
  test "$LAST_REPAIR_EXIT" = "75"
  jq -e '.status == "fail" and .failure_code == "incomplete"' \
    <<<"$LAST_REPAIR_REPORT" >/dev/null
  EXPECTED_DRY_RUN_ID="$(jq -er '.run_id' <<<"$LAST_REPAIR_REPORT")"
  test "$repair_attempt" -lt 24
  sleep 5
done
test -n "$DRY_RUN_ID"
test -n "$DRY_RUN_RESULT_SHA256"

APPLY_RUN_ID=""
EXPECTED_APPLY_RUN_ID=""
for repair_attempt in $(seq 1 24); do
  run_repair_task \
    "apply" \
    "$EXPECTED_APPLY_RUN_ID" \
    "$DRY_RUN_ID" \
    "$DRY_RUN_RESULT_SHA256"
  if test "$LAST_REPAIR_EXIT" = "0"; then
    jq -e '
      .status == "pass"
      and .failure_code == null
      and .phase == "apply"
    ' <<<"$LAST_REPAIR_REPORT" >/dev/null
    APPLY_RUN_ID="$(jq -er '.run_id' <<<"$LAST_REPAIR_REPORT")"
    break
  fi
  test "$LAST_REPAIR_EXIT" = "75"
  jq -e '.status == "fail" and .failure_code == "incomplete"' \
    <<<"$LAST_REPAIR_REPORT" >/dev/null
  EXPECTED_APPLY_RUN_ID="$(jq -er '.run_id' <<<"$LAST_REPAIR_REPORT")"
  test "$repair_attempt" -lt 24
  sleep 5
done
test -n "$APPLY_RUN_ID"

jq -e '
  [
    .repair.repaired,
    .repair.would_repair,
    .repair.unavailable,
    .repair.operator_action,
    .repair.pending,
    .repair.retrying,
    .repair.entry_repaired,
    .repair.entry_would_repair,
    .repair.entry_unavailable,
    .repair.entry_operator_action,
    .repair.entry_pending,
    .repair.entry_retrying,
    .repair.inventory_total,
    .repair.entry_total,
    .repair.checkpoint
  ] | all(.[]; type == "number" and . >= 0 and floor == .)
' <<<"$LAST_REPAIR_REPORT" >/dev/null
REPAIR_REPAIRED="$(jq -er '.repair.repaired' <<<"$LAST_REPAIR_REPORT")"
REPAIR_WOULD_REPAIR="$(jq -er '.repair.would_repair' <<<"$LAST_REPAIR_REPORT")"
REPAIR_UNAVAILABLE="$(jq -er '.repair.unavailable' <<<"$LAST_REPAIR_REPORT")"
REPAIR_OPERATOR_ACTION="$(jq -er '.repair.operator_action' <<<"$LAST_REPAIR_REPORT")"
REPAIR_PENDING="$(jq -er '.repair.pending' <<<"$LAST_REPAIR_REPORT")"
REPAIR_RETRYING="$(jq -er '.repair.retrying' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_REPAIRED="$(jq -er '.repair.entry_repaired' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_WOULD_REPAIR="$(jq -er '.repair.entry_would_repair' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_UNAVAILABLE="$(jq -er '.repair.entry_unavailable' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_OPERATOR_ACTION="$(jq -er '.repair.entry_operator_action' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_PENDING="$(jq -er '.repair.entry_pending' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_RETRYING="$(jq -er '.repair.entry_retrying' <<<"$LAST_REPAIR_REPORT")"
REPAIR_INVENTORY_TOTAL="$(jq -er '.repair.inventory_total' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ENTRY_TOTAL="$(jq -er '.repair.entry_total' <<<"$LAST_REPAIR_REPORT")"
REPAIR_CHECKPOINT="$(jq -er '.repair.checkpoint' <<<"$LAST_REPAIR_REPORT")"
REPAIR_ACCOUNTED="$((REPAIR_REPAIRED + REPAIR_WOULD_REPAIR + REPAIR_UNAVAILABLE + REPAIR_PENDING))"
REPAIR_ENTRY_ACCOUNTED="$((REPAIR_ENTRY_REPAIRED + REPAIR_ENTRY_WOULD_REPAIR + REPAIR_ENTRY_UNAVAILABLE + REPAIR_ENTRY_PENDING))"
test "$REPAIR_UNAVAILABLE" = "0"
test "$REPAIR_OPERATOR_ACTION" = "0"
test "$REPAIR_PENDING" = "0"
test "$REPAIR_RETRYING" = "0"
test "$REPAIR_ENTRY_UNAVAILABLE" = "0"
test "$REPAIR_ENTRY_OPERATOR_ACTION" = "0"
test "$REPAIR_ENTRY_PENDING" = "0"
test "$REPAIR_ENTRY_RETRYING" = "0"
test "$REPAIR_WOULD_REPAIR" = "0"
test "$REPAIR_ENTRY_WOULD_REPAIR" = "0"
test "$REPAIR_ACCOUNTED" = "$REPAIR_INVENTORY_TOTAL"
test "$REPAIR_ENTRY_ACCOUNTED" = "$REPAIR_ENTRY_TOTAL"
test "$REPAIR_REPAIRED" = "$REPAIR_INVENTORY_TOTAL"
test "$REPAIR_ENTRY_REPAIRED" = "$REPAIR_ENTRY_TOTAL"
test "$REPAIR_CHECKPOINT" = "$REPAIR_ENTRY_TOTAL"

umask 077
test ! -e "$REPAIR_RESULT_FILE"
test ! -L "$REPAIR_RESULT_FILE"
set -C
printf '%s\n' "$LAST_REPAIR_REPORT" >"$REPAIR_RESULT_FILE"
set +C
REPAIR_RESULT_FILE_SHA256="$(sha256sum -- "$REPAIR_RESULT_FILE" |
  awk '{print $1}')"
"$SOURCE_CHECKOUT/deploy/aws/verify_attachment_repair_result.sh" \
  "$REPAIR_RESULT_FILE" \
  "$REPAIR_RESULT_FILE_SHA256" \
  "$LAST_REPAIR_TASK_ARN" \
  "$REPAIR_TASK_DEFINITION_ARN" \
  "$REPAIR_CONTAINER_NAME" \
  "$IMAGE_DIGEST" \
  "$RELEASE_COMMIT" \
  "$REPAIR_MANIFEST_SHA256" \
  "$APPLY_RUN_ID"

FINAL_REPAIR_TASK_COUNT="$(aws ecs list-tasks --region "$AWS_REGION" \
  --cluster "$CLUSTER" --family "$REPAIR_TASK_FAMILY" \
  --desired-status RUNNING --query 'length(taskArns)' --output text)"
test "$FINAL_REPAIR_TASK_COUNT" = "0"
```

Exit `75` is the only resumable nonzero outcome and means the bounded task
stopped with checkpointed pending work. Every resume supplies the exact prior
run id; an idempotency mismatch, task/image/manifest mismatch, config failure,
invariant failure, unavailable entry, operator-action entry, or any other
nonzero exit is a hard stop. The apply result is accepted only from the exact
CloudWatch stream for the exact stopped task. Its inner result hash and outer
file hash are recomputed, and
`verify_attachment_repair_result.sh` binds them to the live task ARN, task
definition ARN, container name, image digest, image revision, manifest hash,
and run id. It also requires integer counters and exact zero for `unavailable`,
`operator_action`, `entry_unavailable`, `entry_operator_action`, `pending`,
`retrying`, `entry_pending`, and `entry_retrying`; there is no waiver.

### 4. Start only the release worker, drain the buffer, and audit

The worker service starts from zero with the exact reviewed `WORKER_DEF`, so an
old and new worker never overlap. The API remains at zero.

```bash
set -euo pipefail

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$WORKER_SERVICE" --task-definition "$WORKER_DEF" \
  --desired-count "$ORIGINAL_WORKER_COUNT"
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE"
aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$WORKER_SERVICE" \
  --query 'services[0].{desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'

for attempt in $(seq 1 80); do
  QUEUE_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output json)"
  VISIBLE="$(jq -r '.Attributes.ApproximateNumberOfMessages' <<<"$QUEUE_COUNTS")"
  IN_FLIGHT="$(jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible' <<<"$QUEUE_COUNTS")"
  test "$VISIBLE" = "0" && test "$IN_FLIGHT" = "0" && break
  test "$attempt" -lt 80 || exit 1
  sleep 15
done

AUDIT_OVERRIDES="$(jq -cn --arg since "$FENCE_AT" \
  '{containerOverrides:[{name:"worker",command:["src/server/index.ts","inbound-provenance-audit","--since",$since]}]}')"
AUDIT_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$WORKER_DEF" \
  --network-configuration "$NETWORK" --count 1 --overrides "$AUDIT_OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$AUDIT_TASK"
AUDIT_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" \
  --tasks "$AUDIT_TASK" --output json)"
AUDIT_EXIT="$(jq -er --arg container "$MANIFEST_WORKER_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $container) | .exitCode' <<<"$AUDIT_TASK_JSON")"
test "$AUDIT_EXIT" = "0"
test "$(jq -er '.tasks[0].taskDefinitionArn' <<<"$AUDIT_TASK_JSON")" = "$WORKER_DEF"

AUDIT_LOG_GROUP="$(jq -er --arg container "$MANIFEST_WORKER_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-group"]
' <<<"$STAGED_WORKER_TASK_JSON")"
AUDIT_LOG_STREAM_PREFIX="$(jq -er --arg container "$MANIFEST_WORKER_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-stream-prefix"]
' <<<"$STAGED_WORKER_TASK_JSON")"
AUDIT_TASK_ID="${AUDIT_TASK##*/}"
AUDIT_LOG_STREAM="${AUDIT_LOG_STREAM_PREFIX}/${MANIFEST_WORKER_CONTAINER_NAME}/${AUDIT_TASK_ID}"
AUDIT_JSON=""
for attempt in $(seq 1 12); do
  AUDIT_LOG_EVENTS="$(aws logs get-log-events --region "$AWS_REGION" \
    --log-group-name "$AUDIT_LOG_GROUP" --log-stream-name "$AUDIT_LOG_STREAM" \
    --start-from-head --output json)"
  AUDIT_JSON="$(jq -cer '
    [.events[].message | fromjson?
      | select((keys | sort) == ["candidate_messages","cutoff","gaps","invalid_provenance","missing_provenance","status","tenants_scanned","valid_provenance"])]
    | select(length == 1) | .[0]
  ' <<<"$AUDIT_LOG_EVENTS" 2>/dev/null || true)"
  test -n "$AUDIT_JSON" && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
jq -e --arg cutoff "$FENCE_AT" '
  .status == "pass"
  and .cutoff == $cutoff
  and .gaps == 0
  and .missing_provenance == 0
  and .invalid_provenance == 0
  and .tenants_scanned > 0
  and .candidate_messages == .valid_provenance
' <<<"$AUDIT_JSON" >/dev/null
printf '%s\n' "$AUDIT_JSON"

# SQS metrics are approximate, so require three identical bounded final reads.
# Both DLQ dimensions must remain exactly zero; any DLQ item is a no-go.
DLQ_STABLE_READS=0
LAST_DLQ_COUNTS=""
for attempt in $(seq 1 12); do
  CURRENT_DLQ_COUNTS="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$DLQ_URL" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output json)"
  FINAL_DLQ_VISIBLE="$(jq -er '.Attributes.ApproximateNumberOfMessages | tonumber' <<<"$CURRENT_DLQ_COUNTS")"
  FINAL_DLQ_IN_FLIGHT="$(jq -er '.Attributes.ApproximateNumberOfMessagesNotVisible | tonumber' <<<"$CURRENT_DLQ_COUNTS")"
  CURRENT_DLQ_PAIR="${FINAL_DLQ_VISIBLE}:${FINAL_DLQ_IN_FLIGHT}"
  if test "$CURRENT_DLQ_PAIR" = "$LAST_DLQ_COUNTS"; then
    DLQ_STABLE_READS=$((DLQ_STABLE_READS + 1))
  else
    DLQ_STABLE_READS=1
    LAST_DLQ_COUNTS="$CURRENT_DLQ_PAIR"
  fi
  test "$DLQ_STABLE_READS" -ge 3 && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
test "$DLQ_STABLE_READS" -ge 3
test "$FINAL_DLQ_VISIBLE" = "0"
test "$FINAL_DLQ_IN_FLIGHT" = "0"
printf '%s\n' "$CURRENT_DLQ_COUNTS"
```

Run `inbound-provenance-audit` from the exact worker definition, not the
migration definition: only the worker carries the deployment-owned canonical
S3 bucket setting. The command performs read-only all-tenant queries under RLS,
prints aggregate counts only, and exits nonzero for a missing or invalid binding.
Any nonzero exit, nonzero DLQ count, worker error, wrong task definition, or unresolved
cutoff-window row is a no-go: keep the API at zero, reconcile the affected raw
objects only through the reviewed release's canonical S3 replay, and rerun the
audit.
Never patch message or provenance rows manually.

### 5. Start the release API and reconcile Terraform

```bash
set -euo pipefail

rehearsal_aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" \
  --service "$API_SERVICE" --task-definition "$API_DEF" \
  --desired-count "$ORIGINAL_API_COUNT"
aws ecs wait services-stable --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE"
aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" \
  --services "$API_SERVICE" \
  --query 'services[0].{desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'
VERSION_JSON="$(curl --fail --silent --show-error "$EMAILS_ALB_URL/version")"
jq -e --arg release_version "$RELEASE_VERSION" '
  ((keys | sort) == ["mode","name","status","version"])
  and (.status == "ok")
  and (.name == "emails")
  and (.mode == "self_hosted")
  and (.version == $release_version)
' <<<"$VERSION_JSON" >/dev/null
READY_JSON="$(curl --fail --silent --show-error "$EMAILS_ALB_URL/ready")"
UNAUTH_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "$EMAILS_ALB_URL/v1/attachments?limit=1")"
test "$UNAUTH_STATUS" = "401"

curl_config_escape() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) printf '%s\n' "curl config values cannot contain newlines" >&2; return 64 ;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}
SMOKE_HEADER="$(curl_config_escape "x-api-key: $EMAILS_SMOKE_API_KEY")"
SMOKE_URL="$(curl_config_escape "$EMAILS_ALB_URL/v1/attachments?limit=1")"
AUTH_ATTACHMENTS_JSON="$(
  printf 'header = "%s"\nurl = "%s"\nsilent\nshow-error\nfail\n' \
    "$SMOKE_HEADER" "$SMOKE_URL" |
    curl --config -
)"
jq -e '
  ((keys | sort) == ["items","next_cursor"])
  and (.items | type == "array")
  and (.next_cursor == null or (.next_cursor | type == "string"))
  and ([.. | objects | has("content_base64")] | any | not)
' <<<"$AUTH_ATTACHMENTS_JSON" >/dev/null
printf '%s\n' "$VERSION_JSON" "$READY_JSON"

NO_SES_SMOKE_DEF_JSON="$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$NO_SES_SMOKE_TASK_DEFINITION" --output json)"
NO_SES_SMOKE_TASK_ROLE="$(jq -er '.taskDefinition.taskRoleArn' <<<"$NO_SES_SMOKE_DEF_JSON")"
test "$NO_SES_SMOKE_TASK_ROLE" = "$NO_SES_SMOKE_TASK_ROLE_ARN"
jq -e --arg image "$IMAGE_REFERENCE" \
  --arg container "$NO_SES_SMOKE_CONTAINER_NAME" \
  --arg execution_role "$MANIFEST_API_EXECUTION_ROLE_ARN" '
  .taskDefinition.executionRoleArn == $execution_role
  and .taskDefinition.networkMode == "awsvpc"
  and .taskDefinition.runtimePlatform.cpuArchitecture == "X86_64"
  and ([.taskDefinition.containerDefinitions[]
    | select(.name == $container)
    | select(.image == $image)
    | select(.command == ["src/cli/index.tsx","--json","inbox","attachments","--limit","1"])]
    | length) == 1
' <<<"$NO_SES_SMOKE_DEF_JSON" >/dev/null
NO_SES_SIMULATION="$(aws iam simulate-principal-policy \
  --policy-source-arn "$NO_SES_SMOKE_TASK_ROLE_ARN" \
  --action-names ses:SendEmail ses:SendRawEmail --output json)"
jq -e '.EvaluationResults | length == 2
  and all(.[]; .EvalDecision == "explicitDeny")' <<<"$NO_SES_SIMULATION" >/dev/null

NO_SES_SMOKE_TASK="$(rehearsal_aws ecs run-task --region "$AWS_REGION" \
  --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$NO_SES_SMOKE_TASK_DEFINITION" \
  --network-configuration "$NETWORK" --count 1 \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$CLUSTER" \
  --tasks "$NO_SES_SMOKE_TASK"
NO_SES_SMOKE_TASK_JSON="$(aws ecs describe-tasks --region "$AWS_REGION" \
  --cluster "$CLUSTER" --tasks "$NO_SES_SMOKE_TASK" --output json)"
test "$(jq -er '.tasks[0].taskDefinitionArn' <<<"$NO_SES_SMOKE_TASK_JSON")" = \
  "$(jq -er '.taskDefinition.taskDefinitionArn' <<<"$NO_SES_SMOKE_DEF_JSON")"
NO_SES_SMOKE_EXIT="$(jq -er --arg container "$NO_SES_SMOKE_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $container) | .exitCode' \
  <<<"$NO_SES_SMOKE_TASK_JSON")"
test "$NO_SES_SMOKE_EXIT" = "0"

NO_SES_LOG_GROUP="$(jq -er --arg container "$NO_SES_SMOKE_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-group"]
' <<<"$NO_SES_SMOKE_DEF_JSON")"
NO_SES_LOG_PREFIX="$(jq -er --arg container "$NO_SES_SMOKE_CONTAINER_NAME" '
  .taskDefinition.containerDefinitions[] | select(.name == $container)
  | .logConfiguration.options["awslogs-stream-prefix"]
' <<<"$NO_SES_SMOKE_DEF_JSON")"
NO_SES_SMOKE_TASK_ID="${NO_SES_SMOKE_TASK##*/}"
NO_SES_LOG_STREAM="${NO_SES_LOG_PREFIX}/${NO_SES_SMOKE_CONTAINER_NAME}/${NO_SES_SMOKE_TASK_ID}"
NO_SES_SMOKE_JSON=""
for attempt in $(seq 1 12); do
  NO_SES_LOG_EVENTS="$(aws logs get-log-events --region "$AWS_REGION" \
    --log-group-name "$NO_SES_LOG_GROUP" --log-stream-name "$NO_SES_LOG_STREAM" \
    --start-from-head --output json)"
  NO_SES_SMOKE_JSON="$(jq -cer '
    [.events[].message | fromjson?
      | select((keys | sort) == ["items","next_cursor"])
      | select(.items | type == "array")
      | select(.next_cursor == null or (.next_cursor | type == "string"))
      | select([.. | objects | has("content_base64")] | any | not)]
    | select(length == 1) | .[0]
  ' <<<"$NO_SES_LOG_EVENTS" 2>/dev/null || true)"
  test -n "$NO_SES_SMOKE_JSON" && break
  test "$attempt" -lt 12 || exit 1
  sleep 5
done
printf '%s\n' "$NO_SES_SMOKE_JSON"

rehearsal_terraform plan -var-file="$TFVARS" -var="container_image=$IMAGE_REFERENCE" \
  -var="container_architecture=X86_64" \
  -var="worker_desired_count=$ORIGINAL_WORKER_COUNT" \
  -var="api_desired_count=$ORIGINAL_API_COUNT" \
  -var="enable_automatic_deployment_rollback=false" -out=0020-reconcile.tfplan
terraform show 0020-reconcile.tfplan
rehearsal_terraform apply 0020-reconcile.tfplan
```

The final un-targeted plan must contain no unexpected service, queue, schema, or
network change. Record the image digest, all task ARNs/definitions and exit
codes, queue/DLQ snapshots, `FENCE_AT`, aggregate audit JSON, `/version`,
the ALB `/ready` response, unauthenticated denial, the authenticated
tenant-scoped attachment-inventory smoke result, and CloudWatch locations.
These shell-local rehearsal curls do not satisfy the production no-SES-role
gate; the live plan must execute equivalent checks from the reviewed one-shot
smoke task described above.

Rollback after ledger 0020 is always a compatible roll-forward. A failed API
activation leaves the API at zero while the reviewed release worker continues
to protect the queue, or both services may be returned to zero for
investigation. Use only a corrected 0020-compatible image, repeat the
definition, ledger, worker, audit, and API gates, and reconcile Terraform. A
pre-0020 release is never a rollback image. Never remove or rewrite the 0017,
0018, 0019, or 0020 ledger row.
