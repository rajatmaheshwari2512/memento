# Inputs. Values without a default must be set in terraform.tfvars
# (copy terraform.tfvars.example). The others can be overridden there too.

# --- Oracle ---

variable "oci_region" {
  description = "Oracle home region. It can't be changed after sign-up."
  type        = string
  default     = "ap-hyderabad-1"
}

variable "oci_config_profile" {
  description = "Which profile in ~/.oci/config to use."
  type        = string
  default     = "DEFAULT"
}

variable "oci_tenancy_ocid" {
  description = "Your tenancy's OCID (ocid1.tenancy...). It's the `tenancy` line in ~/.oci/config."
  type        = string
}

variable "ssh_public_key_path" {
  description = "Public key put on the VM at first boot, for the `ubuntu` user."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "ssh_allowed_cidr" {
  description = "Who can reach SSH (port 22). Key-only login is on, so 0.0.0.0/0 is common; narrow it to your IP for extra safety."
  type        = string
  default     = "0.0.0.0/0"
}

variable "budget_amount" {
  description = "Monthly budget, a whole number in your account's rate-card currency. You get an email when spend reaches it. Check the currency, don't assume it: it can differ from your country's (Billing → Cost Analysis, or the usage API's `currency` field)."
  type        = number
}

variable "budget_alert_email" {
  description = "Where Oracle sends budget alerts."
  type        = string
}

# --- AWS ---

variable "aws_region" {
  description = "Region for the Deep Archive bucket."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Profile in ~/.aws/credentials with admin rights (docs/setup.md, step 2). Named on purpose, so Terraform never falls back to some other AWS account's default credentials on this Mac."
  type        = string
  default     = "selfphotos-admin"
}

variable "backup_bucket_name" {
  description = "S3 bucket name. Must be unique across all of AWS, e.g. selfphotos-backup-<something random>."
  type        = string
}

# --- Cloudflare ---

variable "domain" {
  description = "The Cloudflare zone (your domain), e.g. example.com."
  type        = string
}

variable "subdomains" {
  description = "A records to point at the VM: photos (Memento)."
  type        = set(string)
  default     = ["photos"]
}
