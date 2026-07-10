resource "aws_sqs_queue" "inbound_dlq" {
  name                      = "${var.name}-inbound-dlq"
  message_retention_seconds = var.sqs_message_retention_seconds
  kms_master_key_id         = aws_kms_key.this.arn
}

resource "aws_sqs_queue" "inbound" {
  name                       = "${var.name}-inbound"
  message_retention_seconds  = var.sqs_message_retention_seconds
  visibility_timeout_seconds = var.sqs_visibility_timeout_seconds
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.this.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.inbound_dlq.arn
    maxReceiveCount     = var.sqs_max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "inbound_dlq" {
  queue_url = aws_sqs_queue.inbound_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.inbound.arn]
  })
}

resource "aws_sns_topic" "inbound" {
  name              = "${var.name}-inbound"
  kms_master_key_id = aws_kms_key.this.arn
}

data "aws_iam_policy_document" "inbound_topic" {
  dynamic "statement" {
    for_each = var.enable_ses_inbound ? [1] : []
    content {
      sid       = "AllowSESPublishFromOperatorAccount"
      effect    = "Allow"
      actions   = ["sns:Publish"]
      resources = [aws_sns_topic.inbound.arn]

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

resource "aws_sns_topic_policy" "inbound" {
  count = var.enable_ses_inbound ? 1 : 0

  arn    = aws_sns_topic.inbound.arn
  policy = data.aws_iam_policy_document.inbound_topic.json
}

data "aws_iam_policy_document" "inbound_queue" {
  statement {
    sid       = "AllowInboundTopic"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.inbound.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.inbound.arn]
    }


    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "inbound" {
  queue_url = aws_sqs_queue.inbound.id
  policy    = data.aws_iam_policy_document.inbound_queue.json
}

resource "aws_sns_topic_subscription" "inbound" {
  topic_arn            = aws_sns_topic.inbound.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.inbound.arn
  raw_message_delivery = true

  depends_on = [aws_sqs_queue_policy.inbound]
}
