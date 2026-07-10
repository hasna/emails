mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111122223333"
      arn        = "arn:aws:iam::111122223333:user/terraform-test"
      user_id    = "terraform-test"
    }
  }

  override_data {
    target = data.aws_partition.current
    values = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["us-east-1a", "us-east-1b", "us-east-1c"]
    }
  }

  override_data {
    target = data.aws_iam_policy_document.rds_monitoring_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.ecs_tasks_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.execution["api"]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.execution["worker"]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.execution["migration"]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.api
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.worker
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.kms
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.inbound_bucket
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.attachment_bucket
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.inbound_topic
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.inbound_queue
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "random" {}

run "dormant_by_default" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 0
    error_message = "The API must be dormant by default."
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 0
    error_message = "The inbound worker must be dormant by default."
  }

  assert {
    condition     = length(aws_ses_receipt_rule.inbound) == 0
    error_message = "SES inbound resources must be opt-in."
  }

  assert {
    condition     = length(aws_lb.api) == 0
    error_message = "The public endpoint must be opt-in."
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 0
    error_message = "A dormant deployment must not create billable NAT gateways."
  }
}

run "activation_is_blocked_without_readiness" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    expected_account_id = "111122223333"
    container_image     = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_desired_count   = 1
  }

  expect_failures = [
    check.activation_guard,
    aws_ecs_service.api,
  ]
}

run "ready_activation_is_allowed" {
  command = plan

  variables {
    aws_region                   = "us-east-1"
    expected_account_id          = "111122223333"
    container_image              = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_desired_count            = 2
    worker_desired_count         = 1
    secrets_ready                = true
    migrations_complete          = true
    enable_nat_gateway           = true
    alarm_notification_topic_arn = "arn:aws:sns:us-east-1:111122223333:operator-alerts"
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 2
    error_message = "A fully acknowledged deployment should permit the requested API count."
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 1
    error_message = "A fully acknowledged deployment should permit the requested worker count."
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 2
    error_message = "The default production activation should provide one NAT gateway per AZ."
  }
}

run "optional_public_and_ses_resources" {
  command = plan

  variables {
    aws_region             = "us-east-1"
    expected_account_id    = "111122223333"
    container_image        = "registry.example/emails@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_public_endpoint = true
    service_domain         = "emails.example.com"
    certificate_arn        = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000"
    email_domain           = "example.com"
    enable_ses_inbound     = true
    inbound_recipients     = ["example.com"]
  }

  assert {
    condition     = length(aws_lb.api) == 1
    error_message = "Public exposure should create exactly one ALB only when explicitly enabled."
  }

  assert {
    condition     = length(aws_ses_receipt_rule.inbound) == 1
    error_message = "SES inbound should create exactly one dormant receipt rule only when explicitly enabled."
  }
}
