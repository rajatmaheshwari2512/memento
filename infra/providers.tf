# How Terraform logs in to each service. No keys live in this repo: ./memento passes
# them from .env, or each provider reads them from this computer. A part that's off
# needs no login.

# Oracle: reads ~/.oci/config, which `oci setup config` creates.
provider "oci" {
  region              = var.oci_region
  config_file_profile = var.oci_config_profile
}

# AWS: the named profile from ~/.aws/credentials, or (aws_profile "") the
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables. With aws_backup
# off, placeholder keys and no checks, so it never looks for an account.
provider "aws" {
  region  = var.aws_region
  profile = var.aws_backup && var.aws_profile != "" ? var.aws_profile : null

  access_key                  = var.aws_backup ? null : "unused"
  secret_key                  = var.aws_backup ? null : "unused"
  skip_credentials_validation = var.aws_backup ? null : true
  skip_requesting_account_id  = var.aws_backup ? null : true
  skip_metadata_api_check     = var.aws_backup ? null : true

  # Added to every AWS resource, so you can tell in the console what Terraform owns.
  default_tags {
    tags = {
      project    = "selfphotos"
      managed-by = "terraform"
    }
  }
}

# Cloudflare: reads the CLOUDFLARE_API_TOKEN environment variable.
provider "cloudflare" {}
