locals {
  inbound_bucket_name = "${var.name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-inbound"
}

resource "aws_s3_bucket" "inbound" {
  bucket        = local.inbound_bucket_name
  force_destroy = false

  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_ownership_controls" "inbound" {
  bucket = aws_s3_bucket.inbound.id

  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket = aws_s3_bucket.inbound.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "inbound" {
  bucket = aws_s3_bucket.inbound.id

  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.this.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id

  rule {
    id     = "retain-mail"
    status = "Enabled"

    filter { prefix = "" }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_object_retention_days
    }

    dynamic "expiration" {
      for_each = var.inbound_object_retention_days == null ? [] : [var.inbound_object_retention_days]
      content { days = expiration.value }
    }
  }

  depends_on = [aws_s3_bucket_versioning.inbound]
}

data "aws_iam_policy_document" "inbound_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.inbound.arn, "${aws_s3_bucket.inbound.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_ses_inbound ? [1] : []
    content {
      sid       = "AllowSESPutsFromOperatorAccount"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.inbound.arn}/${var.inbound_object_prefix}*"]

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
  }
}

resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = data.aws_iam_policy_document.inbound_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.inbound]
}
