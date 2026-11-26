output "public_ip" {
  description = "Stays the same across reboots. Changes only if the VM is recreated, and then Terraform updates DNS for you."
  value       = oci_core_instance.this.public_ip
}
