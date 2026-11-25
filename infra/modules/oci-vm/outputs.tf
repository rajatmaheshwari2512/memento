output "public_ip" {
  description = "Stays the same across reboots. Changes only if the VM is recreated, and then Terraform updates DNS for you."
  value       = oci_core_instance.this.public_ip
}

output "instance_id" {
  value = oci_core_instance.this.id
}

output "private_ip" {
  description = "Its address inside the VCN. The temporary server only accepts connections from it."
  value       = oci_core_instance.this.private_ip
}
