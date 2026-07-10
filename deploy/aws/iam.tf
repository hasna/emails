data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

locals {
  execution_secret_arns = {
    api = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.api_signing_key.arn,
    ]
    worker    = [aws_secretsmanager_secret.database_url.arn]
    migration = [aws_secretsmanager_secret.migration_database_url.arn]
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
    resources = [aws_kms_key.this.arn]
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
  statement {
    sid       = "ListMailObjects"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.inbound.arn, aws_s3_bucket.attachments.arn]
  }

  statement {
    sid       = "ReadInboundObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.inbound.arn}/*"]
  }

  statement {
    sid       = "ManageAttachmentObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/*"]
  }

  statement {
    sid       = "UseDataKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
  }

  dynamic "statement" {
    for_each = var.email_domain == null ? [] : [var.email_domain]
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
  name_prefix = "runtime-"
  role        = aws_iam_role.api.id
  policy      = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role" "worker" {
  name_prefix        = "${var.name}-worker-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "ReadInboundBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.inbound.arn]
  }

  statement {
    sid       = "ReadInboundObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.inbound.arn}/*"]
  }

  statement {
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

  statement {
    sid       = "DecryptInboundData"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
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
  name_prefix = "runtime-"
  role        = aws_iam_role.worker.id
  policy      = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role" "migration" {
  name_prefix        = "${var.name}-migration-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
