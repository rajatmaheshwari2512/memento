# How Terraform logs in to each service. No keys live in this repo:
# each provider reads them from your Mac (see docs/setup.md, "Credentials").

# Oracle: reads ~/.oci/config, which `oci setup config` creates.
provider "oci" {
  region              = var.oci_region
  config_file_profile = var.oci_config_profile
}

# AWS: uses the named profile from ~/.aws/credentials (null = the default chain).
provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

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
