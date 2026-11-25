variable "tenancy_ocid" {
  description = "Used to look up availability domains."
  type        = string
}

variable "compartment_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "ssh_public_key" {
  description = "Contents of the public key (not the path)."
  type        = string
}

variable "name" {
  description = "Display name and hostname."
  type        = string
  default     = "selfphotos"
}

# Defaults = the whole Always Free ARM allowance (since June 2026).
variable "ocpus" {
  type    = number
  default = 2
}

variable "memory_in_gbs" {
  type    = number
  default = 12
}

variable "boot_volume_size_in_gbs" {
  type    = number
  default = 200
}
