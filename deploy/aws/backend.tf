terraform {
  # Values are supplied by the operator with -backend-config. Nothing here
  # points at a vendor, fleet, or maintainer-owned account.
  backend "s3" {}
}
