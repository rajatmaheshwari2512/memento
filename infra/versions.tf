# Which Terraform and providers this code needs; `terraform init` records the exact versions in .terraform.lock.hcl.

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

  # No `backend` block, so state is the local file terraform.tfstate (gitignored): back it up with .env.
}
