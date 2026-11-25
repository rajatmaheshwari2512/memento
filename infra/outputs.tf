# Values printed after `terraform apply`. Read one with `terraform output <name>`.
# Sensitive ones show as (sensitive). Read them with `terraform output -raw <name>`.
# ./memento prod setup copies the backup user's keys into .env. A part that's off: null.

output "vm_public_ip" {
  value = one(module.oci_vm[*].public_ip)
}

output "ssh_command" {
  value = one([for vm in module.oci_vm : "ssh ubuntu@${vm.public_ip}"])
}

output "hostnames" {
  value = flatten(module.dns[*].hostnames)
}

output "backup_bucket" {
  value = one(module.backup[*].bucket_name)
}

output "backup_access_key_id" {
  value = one(module.backup[*].access_key_id)
}

output "backup_secret_access_key" {
  value     = one(module.backup[*].secret_access_key)
  sensitive = true
}
