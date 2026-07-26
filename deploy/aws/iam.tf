data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

locals {
  # An ECS `secrets[].valueFrom` may address a single JSON key inside a secret
  # (`arn:...:secret:name-suffix:JSON_KEY:version-stage:version-id`), but that
  # form is NOT a valid IAM resource ARN. Keep only the first seven
  # colon-separated segments, which is the bare secret ARN, and de-duplicate:
  # both credentials usually live in the same secret.
  #
  # `compact` rather than a null-check on ONE of the two variables: a
  # half-configured module must reach the both-or-neither precondition on
  # aws_ecs_task_definition.api and fail with that message. Dereferencing the
  # other variable here instead threw `split(":", null)` first — and only in one
  # of the two orders, so the guard silently did not exist for
  # `ses_access_key_id_secret_arn` set alone.
  ses_secret_iam_arns = distinct([
    for arn in compact([
      var.ses_access_key_id_secret_arn,
      var.ses_secret_access_key_secret_arn,
    ]) : join(":", slice(split(":", arn), 0, 7))
  ])

  # Only needed when the SES credential secrets use a customer-managed key. The
  # AWS-managed aws/secretsmanager key grants decryption through the secret
  # itself, so the common case stays empty.
  ses_credentials_kms_key_arns = var.ses_credentials_kms_key_arn == null ? [] : [
    var.ses_credentials_kms_key_arn,
  ]

  execution_secret_arns = {
    # Only the API execution role may read the SES credentials. Giving them to
    # the worker would let an SES-scoped principal replace its task role, which
    # has no SQS or inbound-bucket access.
    api = concat([
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.api_signing_key.arn,
    ], local.ses_secret_iam_arns)
    worker    = [aws_secretsmanager_secret.database_url.arn]
    migration = [aws_secretsmanager_secret.migration_database_url.arn]
  }

  execution_kms_key_arns = {
    api       = concat([aws_kms_key.this.arn], local.ses_credentials_kms_key_arns)
    worker    = [aws_kms_key.this.arn]
    migration = [aws_kms_key.this.arn]
  }
}

resource "aws_iam_role" "execution" {
  for_each = local.execution_secret_arns

  name_prefix        = "${var.name}-${each.key}-execution-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each = local.execution_secret_arns

  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  for_each = local.execution_secret_arns

  statement {
    sid       = "ReadRuntimeSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value
  }

  statement {
    sid       = "DecryptRuntimeSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = local.execution_kms_key_arns[each.key]
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution_secret_arns

  name_prefix = "runtime-secrets-"
  role        = aws_iam_role.execution[each.key].id
  policy      = data.aws_iam_policy_document.execution[each.key].json
}

resource "aws_iam_role" "api" {
  name_prefix        = "${var.name}-api-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api" {
  dynamic "statement" {
    for_each = var.send_provider == "ses" && var.email_domain != null ? [var.email_domain] : []
    content {
      sid       = "SendThroughVerifiedIdentity"
      effect    = "Allow"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = ["arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${statement.value}"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      sid    = "EcsExecDataChannel"
      effect = "Allow"
      actions = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  count = var.email_domain != null || var.enable_execute_command ? 1 : 0

  name_prefix = "runtime-"
  role        = aws_iam_role.api.id
  policy      = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role" "worker" {
  name_prefix        = "${var.name}-worker-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker" {
  dynamic "statement" {
    for_each = var.enable_ses_inbound ? [1] : []
    content {
      sid       = "ReadInboundBucket"
      effect    = "Allow"
      actions   = ["s3:ListBucket"]
      resources = [aws_s3_bucket.inbound.arn]
    }
  }

  dynamic "statement" {
    for_each = var.enable_ses_inbound ? [1] : []
    content {
      sid       = "ReadInboundObjects"
      effect    = "Allow"
      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.inbound.arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_ses_inbound ? [1] : []
    content {
      sid    = "ConsumeInboundQueue"
      effect = "Allow"
      actions = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
      ]
      resources = [aws_sqs_queue.inbound.arn]
    }
  }

  dynamic "statement" {
    for_each = var.enable_ses_inbound ? [1] : []
    content {
      sid       = "DecryptInboundData"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [aws_kms_key.this.arn]
    }
  }

  dynamic "statement" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      sid    = "EcsExecDataChannel"
      effect = "Allow"
      actions = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "worker" {
  count = var.enable_ses_inbound || var.enable_execute_command ? 1 : 0

  name_prefix = "runtime-"
  role        = aws_iam_role.worker.id
  policy      = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role" "migration" {
  name_prefix        = "${var.name}-migration-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
