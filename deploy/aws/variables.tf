variable "aws_region" {
  description = "AWS region owned by the operator. Choose a region that supports SES receiving when inbound mail is enabled."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name."
  }
}

variable "expected_account_id" {
  description = "The operator-owned AWS account ID. Provider calls are refused in every other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must contain exactly 12 digits."
  }
}

variable "name" {
  description = "Lowercase deployment name used as a resource prefix."
  type        = string
  default     = "emails"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.name))
    error_message = "name must be 3-24 lowercase letters, digits, or hyphens and must start with a letter."
  }
}

variable "tags" {
  description = "Additional tags applied to supported resources."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR for the dedicated Emails VPC."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR."
  }
}

variable "availability_zone_count" {
  description = "Number of availability zones. Two is the minimum supported value."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "availability_zone_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway to reduce cost. False creates one per AZ for production availability."
  type        = bool
  default     = false
}

variable "enable_nat_gateway" {
  description = "Create NAT egress for private tasks. False avoids dormant NAT cost; it must be true before starting tasks."
  type        = bool
  default     = false
}

variable "container_image" {
  description = "Operator-built Emails image pinned by sha256 digest. Tags and mutable registry defaults are rejected."
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]]+@sha256:[0-9a-f]{64}$", var.container_image))
    error_message = "container_image must be an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "container_architecture" {
  description = "CPU architecture matching the operator-built image."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.container_architecture)
    error_message = "container_architecture must be ARM64 or X86_64."
  }
}

variable "send_provider" {
  description = "Outbound provider used by the AWS deployment. This module supports operator-owned SES only."
  type        = string
  default     = "ses"

  validation {
    condition     = var.send_provider == "ses"
    error_message = "send_provider must be ses for this AWS deployment."
  }
}

variable "primary_super_admin_email" {
  description = "Optional exact email pinned for the one-time primary super-admin bootstrap. Set together with primary_super_admin_bootstrap_kid; no user is hardcoded by this OSS module."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.primary_super_admin_email == null || (
      var.primary_super_admin_email == lower(trimspace(var.primary_super_admin_email)) &&
      can(regex("^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$", var.primary_super_admin_email))
    )
    error_message = "primary_super_admin_email must be null or a trimmed lowercase email address."
  }
}

variable "primary_super_admin_bootstrap_kid" {
  description = "Optional non-secret API-key identifier authorized for the one-time primary super-admin bootstrap. Set together with primary_super_admin_email; never place the API token here."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.primary_super_admin_bootstrap_kid == null || (
      var.primary_super_admin_bootstrap_kid == trimspace(var.primary_super_admin_bootstrap_kid) &&
      length(var.primary_super_admin_bootstrap_kid) >= 1 &&
      length(var.primary_super_admin_bootstrap_kid) <= 256 &&
      !can(regex("[[:space:]]", var.primary_super_admin_bootstrap_kid))
    )
    error_message = "primary_super_admin_bootstrap_kid must be null or a 1-256 character identifier without whitespace."
  }
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory in MiB for the API task."
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "Fargate CPU units for the inbound worker."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the inbound worker."
  type        = number
  default     = 1024
}

variable "migration_cpu" {
  description = "Fargate CPU units for the one-shot migration task."
  type        = number
  default     = 512
}

variable "migration_memory" {
  description = "Fargate memory in MiB for the one-shot migration task."
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "API task count. Defaults to zero so terraform apply cannot start the application."
  type        = number
  default     = 0

  validation {
    condition     = var.api_desired_count >= 0
    error_message = "api_desired_count cannot be negative."
  }
}

variable "worker_desired_count" {
  description = "Inbound worker count. Defaults to zero so terraform apply cannot consume mail."
  type        = number
  default     = 0

  validation {
    condition     = var.worker_desired_count >= 0
    error_message = "worker_desired_count cannot be negative."
  }
}

variable "secrets_ready" {
  description = "Explicit operator acknowledgement that all three Secrets Manager containers contain current values and both PostgreSQL URLs use sslmode=verify-full with the image-bundled RDS CA."
  type        = bool
  default     = false
}

variable "migrations_complete" {
  description = "Explicit operator acknowledgement that the one-shot migration task succeeded."
  type        = bool
  default     = false
}

variable "enable_execute_command" {
  description = "Enable ECS Exec for operator diagnostics. Access is still controlled by IAM."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention for application tasks."
  type        = number
  default     = 30
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_engine_version" {
  description = "PostgreSQL major version. Minor upgrades are managed automatically."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16([.][0-9]+)?$", var.db_engine_version))
    error_message = "db_engine_version must remain PostgreSQL 16 to match the pinned postgres16 parameter group."
  }
}

variable "db_allocated_storage" {
  description = "Initial RDS gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Maximum autoscaled RDS storage in GiB."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Run RDS in Multi-AZ mode. Keep true for production."
  type        = bool
  default     = true
}

variable "db_deletion_protection" {
  description = "Protect RDS from deletion. Keep true for production."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Automated RDS backup retention."
  type        = number
  default     = 14
}

variable "database_admin_security_group_ids" {
  description = "Operator-controlled security groups allowed to bootstrap PostgreSQL, such as an SSM-managed admin host."
  type        = set(string)
  default     = []
}

variable "inbound_object_retention_days" {
  description = "Days before raw inbound MIME expires. Required explicitly when SES inbound is enabled."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.inbound_object_retention_days == null || (var.inbound_object_retention_days >= 1 && var.inbound_object_retention_days <= 3650)
    error_message = "inbound_object_retention_days must be null or between 1 and 3650 days."
  }
}

variable "noncurrent_object_retention_days" {
  description = "Days to retain noncurrent S3 object versions."
  type        = number
  default     = 90
}

variable "sqs_message_retention_seconds" {
  description = "Inbound queue retention in seconds."
  type        = number
  default     = 1209600
}

variable "sqs_visibility_timeout_seconds" {
  description = "Inbound visibility timeout. Must exceed one worker processing attempt."
  type        = number
  default     = 180
}

variable "sqs_max_receive_count" {
  description = "Failed attempts before a message moves to the DLQ."
  type        = number
  default     = 5
}

variable "enable_public_endpoint" {
  description = "Create a WAF-protected public HTTPS ALB."
  type        = bool
  default     = false

  validation {
    condition = !var.enable_public_endpoint || (
      var.service_domain != null &&
      (var.certificate_arn != null || (var.create_certificate && var.hosted_zone_id != null))
    )
    error_message = "enable_public_endpoint requires service_domain and either certificate_arn or create_certificate=true with hosted_zone_id."
  }
}

variable "enable_private_endpoint" {
  description = "Create an internal HTTPS ALB restricted to explicit client security groups."
  type        = bool
  default     = false

  validation {
    condition = !var.enable_private_endpoint || (
      var.private_service_domain != null &&
      var.private_certificate_arn != null &&
      length(var.private_client_security_group_ids) > 0
    )
    error_message = "enable_private_endpoint requires private_service_domain, private_certificate_arn, and at least one private_client_security_group_id."
  }
}

variable "private_service_domain" {
  description = "Private TLS hostname for the internal ALB."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.private_service_domain == null || can(regex("^(?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:[.](?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$", var.private_service_domain))
    error_message = "private_service_domain must be a valid fully qualified DNS name."
  }
}

variable "private_certificate_arn" {
  description = "Existing operator-owned ACM certificate ARN for private_service_domain."
  type        = string
  default     = null
  nullable    = true
}

variable "private_client_security_group_ids" {
  description = "Client security groups allowed to connect to the internal HTTPS ALB."
  type        = set(string)
  default     = []
}

variable "private_hosted_zone_id" {
  description = "Optional operator-owned private Route53 hosted zone ID."
  type        = string
  default     = null
  nullable    = true
}

variable "create_private_route53_record" {
  description = "Create the private_service_domain alias in private_hosted_zone_id."
  type        = bool
  default     = false

  validation {
    condition     = !var.create_private_route53_record || (var.enable_private_endpoint && var.private_hosted_zone_id != null)
    error_message = "create_private_route53_record requires enable_private_endpoint=true and private_hosted_zone_id."
  }
}

variable "service_domain" {
  description = "HTTPS hostname for the API, for example emails.example.com. Required only for a public endpoint."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.service_domain == null || can(regex("^(?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:[.](?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$", var.service_domain))
    error_message = "service_domain must be a valid fully qualified DNS name."
  }
}

variable "hosted_zone_id" {
  description = "Operator-owned Route53 hosted zone ID used for optional certificate validation and API DNS."
  type        = string
  default     = null
  nullable    = true
}

variable "create_certificate" {
  description = "Create and DNS-validate an ACM certificate in the operator account."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "Existing ACM certificate ARN for the API hostname."
  type        = string
  default     = null
  nullable    = true
}

variable "alb_deletion_protection" {
  description = "Protect the optional public ALB from accidental deletion."
  type        = bool
  default     = true
}

variable "create_route53_records" {
  description = "Create API and SES identity records in hosted_zone_id."
  type        = bool
  default     = false

  validation {
    condition     = !var.create_route53_records || var.hosted_zone_id != null
    error_message = "create_route53_records requires hosted_zone_id."
  }
}

variable "public_rate_limit_per_5_minutes" {
  description = "Required WAF per-IP request limit for the public endpoint."
  type        = number
  default     = 2000

  validation {
    condition     = var.public_rate_limit_per_5_minutes >= 100 && var.public_rate_limit_per_5_minutes <= 2000000000
    error_message = "public_rate_limit_per_5_minutes must be between 100 and 2,000,000,000."
  }
}

variable "load_balancer_log_retention_days" {
  description = "Retention for public and private ALB access logs."
  type        = number
  default     = 90

  validation {
    condition     = var.load_balancer_log_retention_days >= 1 && var.load_balancer_log_retention_days <= 3650
    error_message = "load_balancer_log_retention_days must be between 1 and 3650."
  }
}

variable "email_domain" {
  description = "Operator-owned domain to verify with SES. Null skips SES identity resources."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.email_domain == null || can(regex("^(?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:[.](?i:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$", var.email_domain))
    error_message = "email_domain must be a valid fully qualified DNS name."
  }
}

variable "enable_ses_inbound" {
  description = "Create a dormant SES receipt rule. Terraform never activates the account-global rule set."
  type        = bool
  default     = false

  validation {
    condition = !var.enable_ses_inbound || (
      var.email_domain != null &&
      length(var.inbound_recipients) > 0 &&
      var.inbound_object_retention_days != null
    )
    error_message = "enable_ses_inbound requires email_domain, inbound_recipients, and explicit inbound_object_retention_days."
  }
}

variable "inbound_recipients" {
  description = "Domains or addresses accepted by the optional SES receipt rule."
  type        = list(string)
  default     = []
}

variable "inbound_object_prefix" {
  description = "S3 key prefix used by the SES receipt rule."
  type        = string
  default     = "inbound/"

  validation {
    condition     = !startswith(var.inbound_object_prefix, "/") && !strcontains(var.inbound_object_prefix, "..")
    error_message = "inbound_object_prefix must be a relative S3 key prefix without '..'."
  }
}

variable "alarm_notification_topic_arn" {
  description = "Existing operator-owned SNS topic ARN for alarms. Required before service counts can be non-zero."
  type        = string
  default     = null
  nullable    = true
}
