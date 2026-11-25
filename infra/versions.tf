# Which Terraform and which providers (plugins) this code needs.
# `terraform init` downloads them and records the exact versions in .terraform.lock.hcl.
# "~> 9.13" means 9.13 or any newer 9.x, but never 10.0.

terraform {
  required_version = "~> 1.17"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.13"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }

  # No `backend` block, so state is the local file terraform.tfstate (gitignored).
  # docs/runbooks.md explains how to move it to an OCI bucket before GitHub Actions.
}
