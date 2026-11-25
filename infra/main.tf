# The whole setup, wired together. Each block below calls one module in ./modules.
# A module is a folder of .tf files with its own inputs (variables) and outputs,
# like an Ansible role. One module's output feeds the next one's input, for example
# the VM's public IP goes into the Cloudflare DNS record.
#
# Three optional parts, each on or off (./memento sets them from .env; variables.tf):
#   oracle_server   the Oracle server, its network and the budget alert
#   cloudflare_dns  the DNS record for the server
#   aws_backup      the backup bucket and its user

# --- Oracle ---

# A compartment is a folder for Oracle resources. Keeping ours in one makes them
# easy to find and keeps them apart from anything else in the account.
# Terraform can't delete a compartment by default (enable_delete is false), so a
# destroy only forgets it.
resource "oci_identity_compartment" "selfphotos" {
  count = var.oracle_server ? 1 : 0

  compartment_id = var.oci_tenancy_ocid
  name           = "selfphotos"
  description    = "SelfPhotos (Immich). Managed by Terraform."
}

module "oci_network" {
  source = "./modules/oci-network"
  count  = var.oracle_server ? 1 : 0

  compartment_id   = oci_identity_compartment.selfphotos[0].id
  ssh_allowed_cidr = var.ssh_allowed_cidr
}

module "oci_vm" {
  source = "./modules/oci-vm"
  count  = var.oracle_server ? 1 : 0

  tenancy_ocid   = var.oci_tenancy_ocid
  compartment_id = oci_identity_compartment.selfphotos[0].id
  subnet_id      = module.oci_network[0].subnet_id
  ssh_public_key = file(pathexpand(var.ssh_public_key_path))
}

module "oci_budget" {
  source = "./modules/oci-budget"
  count  = var.oracle_server ? 1 : 0

  tenancy_ocid = var.oci_tenancy_ocid
  amount       = var.budget_amount
  alert_email  = var.budget_alert_email
}

# --- AWS ---

module "backup" {
  source = "./modules/aws-backup"
  count  = var.aws_backup ? 1 : 0

  bucket_name = var.backup_bucket_name
}

# --- Cloudflare ---

module "dns" {
  source = "./modules/cloudflare-dns"
  count  = var.cloudflare_dns ? 1 : 0

  zone_name  = var.domain
  subdomains = var.subdomains
  # The Oracle server's, else your own server's (server_ipv4).
  ipv4 = var.oracle_server ? one(module.oci_vm[*].public_ip) : var.server_ipv4
}
