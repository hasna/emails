locals {
  azs               = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)
  nat_gateway_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : var.availability_zone_count) : 0

  api_port = 8080

  certificate_arn = var.certificate_arn != null ? var.certificate_arn : try(aws_acm_certificate_validation.api[0].certificate_arn, null)

  alarm_actions = var.alarm_notification_topic_arn == null ? [] : [var.alarm_notification_topic_arn]

  alarm_topic_is_operator_owned = var.alarm_notification_topic_arn != null && startswith(
    var.alarm_notification_topic_arn,
    "arn:${data.aws_partition.current.partition}:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:"
  )

  certificate_is_operator_owned = local.certificate_arn != null && startswith(
    local.certificate_arn,
    "arn:${data.aws_partition.current.partition}:acm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:certificate/"
  )
}
