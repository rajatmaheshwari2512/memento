# Values printed after `terraform apply`. Read one with `terraform output <name>`.
# Sensitive ones show as (sensitive). Read them with `terraform output -raw <name>`.
# docs/setup.md step 4 copies these into .env.

output "vm_public_ip" {
  value = module.oci_vm.public_ip
}

output "ssh_command" {
  value = "ssh ubuntu@${module.oci_vm.public_ip}"
}

output "hostnames" {
  value = module.dns.hostnames
}

output "backup_bucket" {
  value = module.backup.bucket_name
}

output "backup_access_key_id" {
  value = module.backup.access_key_id
}

output "backup_secret_access_key" {
  value     = module.backup.secret_access_key
  sensitive = true
}

