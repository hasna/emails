resource "aws_ses_domain_identity" "this" {
  count = var.email_domain == null ? 0 : 1

  domain = var.email_domain
}

resource "aws_ses_domain_dkim" "this" {
  count = var.email_domain == null ? 0 : 1

  domain = aws_ses_domain_identity.this[0].domain
}

resource "aws_route53_record" "ses_verification" {
  count = var.email_domain != null && var.create_route53_records && var.hosted_zone_id != null ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = "_amazonses.${var.email_domain}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.this[0].verification_token]
}

resource "aws_route53_record" "ses_dkim" {
  count = var.email_domain != null && var.create_route53_records && var.hosted_zone_id != null ? 3 : 0

  zone_id = var.hosted_zone_id
  name    = "${aws_ses_domain_dkim.this[0].dkim_tokens[count.index]}._domainkey.${var.email_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.this[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_ses_receipt_rule_set" "this" {
  count = var.enable_ses_inbound ? 1 : 0

  rule_set_name = "${var.name}-inbound"
}

resource "aws_ses_receipt_rule" "inbound" {
  count = var.enable_ses_inbound ? 1 : 0

  name          = "${var.name}-store-and-notify"
  rule_set_name = aws_ses_receipt_rule_set.this[0].rule_set_name
  recipients    = var.inbound_recipients
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    bucket_name       = aws_s3_bucket.inbound.id
    object_key_prefix = var.inbound_object_prefix
    position          = 1
    topic_arn         = aws_sns_topic.inbound.arn
  }

  depends_on = [
    aws_s3_bucket_policy.inbound,
    aws_s3_bucket_server_side_encryption_configuration.inbound,
    aws_sns_topic_policy.inbound,
    aws_sns_topic_subscription.inbound,
  ]

  lifecycle {
    precondition {
      condition = alltrue([
        for recipient in var.inbound_recipients :
        lower(recipient) == lower(var.email_domain) ||
        endswith(lower(recipient), "@${lower(var.email_domain)}") ||
        endswith(lower(recipient), ".${lower(var.email_domain)}")
      ])
      error_message = "Every inbound_recipient must belong to email_domain."
    }
  }
}

# Intentionally absent: aws_ses_active_receipt_rule_set. Activating a receipt
# rule set is an account-global mail-routing cutover and must be a separate,
# reviewed operator action after DNS, S3, queue, and worker verification.
