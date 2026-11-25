# The whole setup, wired together. Each block below calls one module in ./modules.
# A module is a folder of .tf files with its own inputs (variables) and outputs,
# like an Ansible role. One module's output feeds the next one's input, for example
# the VM's public IP goes into the Cloudflare DNS record.

# --- Oracle ---

# A compartment is a folder for Oracle resources. Keeping ours in one makes them
# easy to find and keeps them apart from anything else in the account.
# Terraform can't delete a compartment by default (enable_delete is false), so a
# destroy only forgets it.
resource "oci_identity_compartment" "selfphotos" {
  compartment_id = var.oci_tenancy_ocid
  name           = "selfphotos"
  description    = "SelfPhotos (Immich). Managed by Terraform."
}

module "oci_network" {
  source = "./modules/oci-network"

  compartment_id   = oci_identity_compartment.selfphotos.id
  ssh_allowed_cidr = var.ssh_allowed_cidr
}

module "oci_vm" {
  source = "./modules/oci-vm"

  tenancy_ocid   = var.oci_tenancy_ocid
  compartment_id = oci_identity_compartment.selfphotos.id
  subnet_id      = module.oci_network.subnet_id
  ssh_public_key = file(pathexpand(var.ssh_public_key_path))
}

module "oci_budget" {
  source = "./modules/oci-budget"

  tenancy_ocid = var.oci_tenancy_ocid
  amount       = var.budget_amount
  alert_email  = var.budget_alert_email
}

# --- AWS ---

module "backup" {
  source = "./modules/aws-backup"

  bucket_name = var.backup_bucket_name
}

# --- Cloudflare ---

module "dns" {
  source = "./modules/cloudflare-dns"

  zone_name  = var.domain
  subdomains = var.subdomains
  ipv4       = module.oci_vm.public_ip
}
