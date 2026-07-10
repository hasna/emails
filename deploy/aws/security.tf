data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid    = "CloudWatchLogsEncryption"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${var.name}/*"]
    }
  }

  statement {
    sid    = "SESInboundEncryption"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:receipt-rule-set/${var.name}-inbound:receipt-rule/${var.name}-store-and-notify"]
    }
  }

  statement {
    sid       = "SNSQueueEncryption"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${var.name}-inbound"]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "Emails self-hosted data encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json

  tags = { Name = var.name }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name}/database-url"
  description             = "Operator-populated least-privilege PostgreSQL URL for Emails tasks"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30

  lifecycle { prevent_destroy = true }
}

resource "aws_secretsmanager_secret" "migration_database_url" {
  name                    = "${var.name}/migration-database-url"
  description             = "Operator-populated schema-owner PostgreSQL URL used only by one-shot migration tasks"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30

  lifecycle { prevent_destroy = true }
}

resource "aws_secretsmanager_secret" "api_signing_key" {
  name                    = "${var.name}/api-signing-key"
  description             = "Operator-populated high-entropy API signing key for Emails"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30

  lifecycle { prevent_destroy = true }
}

# Deliberately no aws_secretsmanager_secret_version resources. Generating or
# accepting secret values in Terraform would copy plaintext into state.
