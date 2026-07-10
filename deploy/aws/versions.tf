terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.expected_account_id]

  default_tags {
    tags = merge(var.tags, {
      ManagedBy = "terraform"
      Project   = var.name
    })
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

check "operator_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
    error_message = "The active AWS account does not match expected_account_id. Refusing to plan against an unintended account."
  }
}

check "activation_guard" {
  assert {
    condition = (
      (var.api_desired_count == 0 && var.worker_desired_count == 0) ||
      (var.secrets_ready && var.migrations_complete && var.enable_nat_gateway && var.alarm_notification_topic_arn != null)
    )
    error_message = "Non-zero service counts require secrets_ready=true, migrations_complete=true, enable_nat_gateway=true, and alarm_notification_topic_arn."
  }
}

check "public_endpoint_contract" {
  assert {
    condition = !var.enable_public_endpoint || (
      var.service_domain != null &&
      (var.certificate_arn != null || (var.create_certificate && var.hosted_zone_id != null))
    )
    error_message = "enable_public_endpoint requires service_domain and either certificate_arn or create_certificate=true with hosted_zone_id."
  }
}

check "ses_inbound_contract" {
  assert {
    condition = !var.enable_ses_inbound || (
      var.email_domain != null && length(var.inbound_recipients) > 0
    )
    error_message = "enable_ses_inbound requires email_domain and at least one inbound_recipient."
  }
}
