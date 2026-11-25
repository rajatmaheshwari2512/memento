variable "compartment_id" {
  description = "Compartment to create the network in."
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "Source range allowed to reach port 22."
  type        = string
}

variable "name" {
  description = "Prefix for display names."
  type        = string
  default     = "selfphotos"
}

variable "vcn_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.0.0.0/24"
}
