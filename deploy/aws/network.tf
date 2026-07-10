resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count = var.availability_zone_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = var.availability_zone_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 16)

  tags = {
    Name = "${var.name}-private-${local.azs[count.index]}"
    Tier = "private"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.availability_zone_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"

  depends_on = [aws_internet_gateway.this]
  tags       = { Name = "${var.name}-nat-${count.index + 1}" }
}

resource "aws_nat_gateway" "this" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.this]
  tags       = { Name = "${var.name}-${local.azs[count.index]}" }
}

resource "aws_route_table" "private" {
  count = var.availability_zone_count

  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? var.availability_zone_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = var.availability_zone_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = { Name = "${var.name}-s3" }
}

resource "aws_security_group" "alb" {
  count = var.enable_public_endpoint ? 1 : 0

  name_prefix = "${var.name}-alb-"
  description = "Public HTTPS ingress for Emails"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "private_alb" {
  count = var.enable_private_endpoint ? 1 : 0

  name_prefix = "${var.name}-private-alb-"
  description = "Operator-allowlisted private HTTPS ingress for Emails"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "tasks" {
  name_prefix = "${var.name}-tasks-"
  description = "Emails Fargate tasks"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_ipv4" {
  count = var.enable_public_endpoint ? 1 : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "HTTPS from IPv4"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_ipv6" {
  count = var.enable_public_endpoint ? 1 : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "HTTPS from IPv6"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_ingress_rule" "private_alb_clients" {
  for_each = var.enable_private_endpoint ? var.private_client_security_group_ids : []

  security_group_id            = aws_security_group.private_alb[0].id
  referenced_security_group_id = each.value
  description                  = "HTTPS from operator-approved private client"
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_tasks" {
  count = var.enable_public_endpoint ? 1 : 0

  security_group_id            = aws_security_group.alb[0].id
  referenced_security_group_id = aws_security_group.tasks.id
  description                  = "API targets only"
  from_port                    = local.api_port
  to_port                      = local.api_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "tasks_alb" {
  count = var.enable_public_endpoint ? 1 : 0

  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb[0].id
  description                  = "API traffic from ALB"
  from_port                    = local.api_port
  to_port                      = local.api_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "private_alb_tasks" {
  count = var.enable_private_endpoint ? 1 : 0

  security_group_id            = aws_security_group.private_alb[0].id
  referenced_security_group_id = aws_security_group.tasks.id
  description                  = "API targets only"
  from_port                    = local.api_port
  to_port                      = local.api_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "tasks_private_alb" {
  count = var.enable_private_endpoint ? 1 : 0

  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.private_alb[0].id
  description                  = "API traffic from internal TLS ALB"
  from_port                    = local.api_port
  to_port                      = local.api_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  description       = "TLS to AWS APIs and operator-selected providers"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "tasks_dns_udp" {
  security_group_id = aws_security_group.tasks.id
  description       = "DNS UDP to VPC resolver"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "tasks_dns_tcp" {
  security_group_id = aws_security_group.tasks.id
  description       = "DNS TCP to VPC resolver"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name}-db-"
  description = "Emails PostgreSQL; private task access only"
  vpc_id      = aws_vpc.this.id

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_egress_rule" "tasks_database" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "PostgreSQL to private RDS"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "database_tasks" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.tasks.id
  description                  = "PostgreSQL from Fargate"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "database_admin" {
  for_each = var.database_admin_security_group_ids

  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value
  description                  = "PostgreSQL from operator-approved administration host"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
