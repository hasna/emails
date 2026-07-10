locals {
  lb_log_bucket_name = "${var.name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-lb-logs"
}

resource "aws_s3_bucket" "lb_logs" {
  count = local.any_endpoint_enabled ? 1 : 0

  bucket        = local.lb_log_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "lb_logs" {
  count = local.any_endpoint_enabled ? 1 : 0

  bucket = aws_s3_bucket.lb_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lb_logs" {
  count = local.any_endpoint_enabled ? 1 : 0

  bucket = aws_s3_bucket.lb_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "lb_logs" {
  count = local.any_endpoint_enabled ? 1 : 0

  bucket = aws_s3_bucket.lb_logs[0].id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter { prefix = "" }

    expiration { days = var.load_balancer_log_retention_days }
  }
}

data "aws_iam_policy_document" "lb_logs" {
  count = local.any_endpoint_enabled ? 1 : 0

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.lb_logs[0].arn, "${aws_s3_bucket.lb_logs[0].arn}/*"]

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

  statement {
    sid       = "AllowLoadBalancerLogDelivery"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.lb_logs[0].arn}/*/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:loadbalancer/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "lb_logs" {
  count = local.any_endpoint_enabled ? 1 : 0

  bucket = aws_s3_bucket.lb_logs[0].id
  policy = data.aws_iam_policy_document.lb_logs[0].json

  depends_on = [aws_s3_bucket_public_access_block.lb_logs]
}
