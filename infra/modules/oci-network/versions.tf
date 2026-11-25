# Every module must say where its providers come from. Without this, Terraform
# assumes "hashicorp/oci", which doesn't exist, and `terraform init` fails.
terraform {
  required_providers {
    oci = {
      source = "oracle/oci"
    }
  }
}
