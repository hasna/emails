resource "aws_acm_certificate" "api" {
  count = var.enable_public_endpoint && var.create_certificate ? 1 : 0

  domain_name       = var.service_domain
  validation_method = "DNS"

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = var.enable_public_endpoint && var.create_certificate && var.hosted_zone_id != null ? {
    for option in aws_acm_certificate.api[0].domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  allow_overwrite = true
  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "api" {
  count = var.enable_public_endpoint && var.create_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_lb" "api" {
  count = var.enable_public_endpoint ? 1 : 0

  name                       = substr(var.name, 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb[0].id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = var.alb_deletion_protection
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.lb_logs[0].id
    prefix  = "public"
    enabled = true
  }

  depends_on = [aws_internet_gateway.this, aws_s3_bucket_policy.lb_logs]
}

resource "aws_lb_target_group" "api" {
  count = var.enable_public_endpoint ? 1 : 0

  name        = substr("${var.name}-api", 0, 32)
  port        = local.api_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  count = var.enable_public_endpoint ? 1 : 0

  load_balancer_arn = aws_lb.api[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }

  lifecycle {
    precondition {
      condition     = local.certificate_is_operator_owned
      error_message = "HTTPS requires a validated ACM certificate from this operator account and region."
    }
  }
}

resource "aws_route53_record" "api" {
  count = var.enable_public_endpoint && var.create_route53_records && var.hosted_zone_id != null ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = var.service_domain
  type    = "A"

  alias {
    name                   = aws_lb.api[0].dns_name
    zone_id                = aws_lb.api[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_wafv2_web_acl" "public" {
  count = var.enable_public_endpoint ? 1 : 0

  name  = "${var.name}-public"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.public_rate_limit_per_5_minutes
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-public-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-public"
    sampled_requests_enabled   = false
  }
}

resource "aws_wafv2_web_acl_association" "public" {
  count = var.enable_public_endpoint ? 1 : 0

  resource_arn = aws_lb.api[0].arn
  web_acl_arn  = aws_wafv2_web_acl.public[0].arn
}

resource "aws_lb" "private" {
  count = var.enable_private_endpoint ? 1 : 0

  name                       = substr("${var.name}-private", 0, 32)
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.private_alb[0].id]
  subnets                    = aws_subnet.private[*].id
  enable_deletion_protection = var.alb_deletion_protection
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.lb_logs[0].id
    prefix  = "private"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.lb_logs]
}

resource "aws_lb_target_group" "private" {
  count = var.enable_private_endpoint ? 1 : 0

  name        = substr("${var.name}-private", 0, 32)
  port        = local.api_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "private_https" {
  count = var.enable_private_endpoint ? 1 : 0

  load_balancer_arn = aws_lb.private[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.private_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.private[0].arn
  }

  lifecycle {
    precondition {
      condition     = local.private_certificate_is_operator_owned
      error_message = "Private HTTPS requires an ACM certificate from this operator account and region."
    }
  }
}

resource "aws_route53_record" "private_api" {
  count = var.enable_private_endpoint && var.create_private_route53_record ? 1 : 0

  zone_id = var.private_hosted_zone_id
  name    = var.private_service_domain
  type    = "A"

  alias {
    name                   = aws_lb.private[0].dns_name
    zone_id                = aws_lb.private[0].zone_id
    evaluate_target_health = true
  }
}
