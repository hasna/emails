resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name}/worker"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/ecs/${var.name}/migration"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  count = var.enable_private_endpoint ? 1 : 0

  name        = var.private_dns_namespace
  description = "Private Emails service discovery"
  vpc         = aws_vpc.this.id
}

resource "aws_service_discovery_service" "api" {
  count = var.enable_private_endpoint ? 1 : 0

  name = "api"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this[0].id

    dns_records {
      ttl  = 30
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

locals {
  common_environment = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = tostring(local.api_port) },
    { name = "HASNA_EMAILS_MODE", value = "self_hosted" },
    { name = "EMAILS_INBOUND_S3_BUCKET", value = aws_s3_bucket.inbound.id },
    { name = "EMAILS_ARCHIVE_S3_BUCKET", value = aws_s3_bucket.attachments.id },
    { name = "EMAILS_ARCHIVE_S3_REGION", value = var.aws_region },
    { name = "MAILERY_INGEST_S3_BUCKET", value = aws_s3_bucket.inbound.id },
  ]

  database_secret = {
    name      = "DATABASE_URL"
    valueFrom = aws_secretsmanager_secret.database_url.arn
  }

  migration_database_secret = {
    name      = "DATABASE_URL"
    valueFrom = aws_secretsmanager_secret.migration_database_url.arn
  }

  signing_secret = {
    name      = "API_KEY_SIGNING_SECRET"
    valueFrom = aws_secretsmanager_secret.api_signing_key.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.api.arn

  runtime_platform {
    cpu_architecture        = var.container_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name                   = "api"
    image                  = var.container_image
    essential              = true
    user                   = "bun"
    readonlyRootFilesystem = false
    command                = ["mailery-serve"]
    stopTimeout            = 120
    environment            = local.common_environment
    secrets                = [local.database_secret, local.signing_secret]
    portMappings = [{
      name          = "http"
      containerPort = local.api_port
      hostPort      = local.api_port
      protocol      = "tcp"
    }]
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:${local.api_port}/ready || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.worker.arn

  runtime_platform {
    cpu_architecture        = var.container_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name                   = "worker"
    image                  = var.container_image
    essential              = true
    user                   = "bun"
    readonlyRootFilesystem = false
    command                = ["mailery-serve", "ingest-worker"]
    stopTimeout            = 120
    environment = concat(local.common_environment, [
      { name = "MAILERY_INGEST_QUEUE_URL", value = aws_sqs_queue.inbound.id },
    ])
    secrets = [local.database_secret]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${var.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migration_cpu)
  memory                   = tostring(var.migration_memory)
  execution_role_arn       = aws_iam_role.execution["migration"].arn
  task_role_arn            = aws_iam_role.migration.arn

  runtime_platform {
    cpu_architecture        = var.container_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name                   = "migration"
    image                  = var.container_image
    essential              = true
    user                   = "bun"
    readonlyRootFilesystem = false
    command                = ["mailery", "db", "migrate"]
    environment            = local.common_environment
    secrets                = [local.migration_database_secret]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migration.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_minimum_healthy_percent = var.api_desired_count == 1 ? 0 : 50
  deployment_maximum_percent         = 200
  enable_execute_command             = var.enable_execute_command
  health_check_grace_period_seconds  = var.enable_public_endpoint ? 120 : null
  wait_for_steady_state              = false

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.tasks.id]
    subnets          = aws_subnet.private[*].id
  }

  dynamic "load_balancer" {
    for_each = var.enable_public_endpoint ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api[0].arn
      container_name   = "api"
      container_port   = local.api_port
    }
  }

  dynamic "service_registries" {
    for_each = var.enable_private_endpoint ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.api[0].arn
    }
  }

  lifecycle {
    precondition {
      condition     = var.api_desired_count == 0 || (var.secrets_ready && var.migrations_complete && var.enable_nat_gateway && local.alarm_topic_is_operator_owned)
      error_message = "Starting the API requires secrets_ready, migrations_complete, NAT egress, and an operator-owned alarm_notification_topic_arn."
    }
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this, aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_minimum_healthy_percent = var.worker_desired_count == 1 ? 0 : 50
  deployment_maximum_percent         = 200
  enable_execute_command             = var.enable_execute_command
  wait_for_steady_state              = false

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.tasks.id]
    subnets          = aws_subnet.private[*].id
  }

  lifecycle {
    precondition {
      condition     = var.worker_desired_count == 0 || (var.secrets_ready && var.migrations_complete && var.enable_nat_gateway && local.alarm_topic_is_operator_owned)
      error_message = "Starting the worker requires secrets_ready, migrations_complete, NAT egress, and an operator-owned alarm_notification_topic_arn."
    }
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]
}
