#!/bin/sh
set -eu

if [ "$#" -ne 9 ]; then
  echo "usage: verify_attachment_repair_result.sh RESULT_FILE RESULT_FILE_SHA256 TASK_ARN TASK_DEFINITION_ARN CONTAINER_NAME IMAGE_DIGEST IMAGE_REVISION MANIFEST_SHA256 RUN_ID" >&2
  exit 64
fi

result_file=$1
expected_file_sha256=$2
expected_task_arn=$3
expected_task_definition_arn=$4
expected_container_name=$5
expected_image_digest=$6
expected_image_revision=$7
expected_manifest_sha256=$8
expected_run_id=$9

fail() {
  echo "attachment repair result verification failed" >&2
  exit 1
}

[ -f "$result_file" ] && [ ! -L "$result_file" ] || fail
[ "$(wc -c <"$result_file")" -le 65536 ] || fail

case "$expected_file_sha256" in
  *[!0-9a-f]*|"") fail ;;
esac
[ "${#expected_file_sha256}" -eq 64 ] || fail
[ "$(sha256sum -- "$result_file" | awk '{print $1}')" = "$expected_file_sha256" ] ||
  fail

printf '%s' "$expected_task_arn" |
  grep -Eq '^arn:(aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task/[^/]+/[0-9a-f-]+$' ||
  fail
printf '%s' "$expected_task_definition_arn" |
  grep -Eq '^arn:(aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$' ||
  fail
printf '%s' "$expected_container_name" |
  grep -Eq '^[A-Za-z0-9_-]{1,255}$' ||
  fail
printf '%s' "$expected_image_digest" |
  grep -Eq '^sha256:[0-9a-f]{64}$' ||
  fail
printf '%s' "$expected_image_revision" |
  grep -Eq '^[0-9a-f]{40}$' ||
  fail
printf '%s' "$expected_manifest_sha256" |
  grep -Eq '^[0-9a-f]{64}$' ||
  fail
printf '%s' "$expected_run_id" |
  grep -Eiq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' ||
  fail

jq -eS \
  --arg task_arn "$expected_task_arn" \
  --arg task_definition_arn "$expected_task_definition_arn" \
  --arg container_name "$expected_container_name" \
  --arg image_digest "$expected_image_digest" \
  --arg image_revision "$expected_image_revision" \
  --arg manifest_sha256 "$expected_manifest_sha256" \
  --arg run_id "$expected_run_id" '
  def safe_nonnegative_integer:
    type == "number"
    and . >= 0
    and . <= 9007199254740991
    and floor == .;
  def safe_positive_integer:
    safe_nonnegative_integer and . > 0;
  def utc_millis:
    capture(
      "^(?<base>[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])\\.(?<millis>[0-9]{3})Z$"
    ) as $parts
    | ($parts.base + "Z" | fromdateiso8601) as $seconds
    | select(
        ($seconds | strftime("%Y-%m-%dT%H:%M:%SZ"))
        == ($parts.base + "Z")
      )
    | ($seconds * 1000 + ($parts.millis | tonumber));
  select(type == "object")
  | select((keys | sort) == [
      "container_name",
      "failure_code",
      "image_digest",
      "image_revision",
      "manifest_sha256",
      "phase",
      "repair",
      "result_sha256",
      "run_id",
      "schema_version",
      "status",
      "task_arn",
      "task_definition_arn"
    ])
  | select(.schema_version == 1)
  | select(.status == "pass" and .failure_code == null and .phase == "apply")
  | select(.task_arn == $task_arn)
  | select(.task_definition_arn == $task_definition_arn)
  | select(.container_name == $container_name)
  | select(.image_digest == $image_digest)
  | select(.image_revision == $image_revision)
  | select(.manifest_sha256 == $manifest_sha256)
  | select(.run_id == $run_id)
  | select(.result_sha256 | type == "string" and test("^[0-9a-f]{64}$"))
  | select(.repair | type == "object")
  | select((.repair | keys | sort) == [
      "apply",
      "attempts",
      "byte_budget",
      "bytes_consumed",
      "checkpoint",
      "completed_at",
      "created_at",
      "deadline_at",
      "entry_operator_action",
      "entry_pending",
      "entry_repaired",
      "entry_retrying",
      "entry_total",
      "entry_unavailable",
      "entry_would_repair",
      "id",
      "inventory_total",
      "operator_action",
      "pending",
      "repaired",
      "retrying",
      "status",
      "time_budget_ms",
      "unavailable",
      "updated_at",
      "would_repair"
    ])
  | select(.repair.id == $run_id)
  | select(.repair.apply == true and .repair.status == "completed")
  | select([
      .repair.attempts,
      .repair.checkpoint,
      .repair.entry_operator_action,
      .repair.entry_pending,
      .repair.entry_repaired,
      .repair.entry_retrying,
      .repair.entry_total,
      .repair.entry_unavailable,
      .repair.entry_would_repair,
      .repair.inventory_total,
      .repair.operator_action,
      .repair.pending,
      .repair.repaired,
      .repair.retrying,
      .repair.unavailable,
      .repair.would_repair
    ] | all(.[]; safe_nonnegative_integer))
  | select(.repair.byte_budget | safe_positive_integer)
  | select(.repair.bytes_consumed | safe_nonnegative_integer)
  | select(.repair.time_budget_ms | safe_positive_integer)
  | select(.repair.bytes_consumed <= .repair.byte_budget)
  | (.repair.created_at | utc_millis) as $created_at
  | (.repair.updated_at | utc_millis) as $updated_at
  | (.repair.completed_at | utc_millis) as $completed_at
  | (.repair.deadline_at | utc_millis) as $deadline_at
  | select($created_at <= $updated_at)
  | select($updated_at <= $completed_at)
  | select($completed_at <= $deadline_at)
  | select($deadline_at - $created_at == .repair.time_budget_ms)
  | select(.repair.entry_total > 0)
  | select(.repair.inventory_total > 0)
  | select(.repair.checkpoint <= .repair.entry_total)
  | select(.repair.operator_action <= .repair.unavailable)
  | select(.repair.entry_operator_action <= .repair.entry_unavailable)
  | select(.repair.retrying <= .repair.pending)
  | select(.repair.entry_retrying <= .repair.entry_pending)
  | select(.repair.unavailable == 0)
  | select(.repair.operator_action == 0)
  | select(.repair.entry_unavailable == 0)
  | select(.repair.entry_operator_action == 0)
  | select(.repair.pending == 0)
  | select(.repair.retrying == 0)
  | select(.repair.entry_pending == 0)
  | select(.repair.entry_retrying == 0)
  | select(.repair.would_repair == 0)
  | select(.repair.entry_would_repair == 0)
  | select(.repair.repaired == .repair.inventory_total)
  | select(.repair.entry_repaired == .repair.entry_total)
  | select(.repair.checkpoint == .repair.entry_total)
  | select(
      .repair.repaired
      + .repair.would_repair
      + .repair.unavailable
      + .repair.pending
      == .repair.inventory_total
    )
  | select(
      .repair.entry_repaired
      + .repair.entry_would_repair
      + .repair.entry_unavailable
      + .repair.entry_pending
      == .repair.entry_total
    )
  ' "$result_file" >/dev/null || fail

repair_json=$(jq -ceS '.repair' "$result_file") || fail
actual_result_sha256=$(printf '%s' "$repair_json" | sha256sum | awk '{print $1}')
stored_result_sha256=$(jq -er '.result_sha256' "$result_file") || fail
[ "$actual_result_sha256" = "$stored_result_sha256" ] || fail
