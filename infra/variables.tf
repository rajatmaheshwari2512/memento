# Inputs. ./memento sets them from .env (see .env.example) as TF_VAR_<name> environment
# variables: ./memento prod setup, ./memento prod dry-run.

# --- Which parts to make ---

variable "oracle_server" {
  description = "true: the Oracle server, its network and the budget alert (OCI_TENANCY_OCID set, SERVER_HOST empty)."
  type        = bool
}

variable "cloudflare_dns" {
  description = "true: the DNS record for MEMENTO_DOMAIN in Cloudflare (CLOUDFLARE_API_TOKEN set)."
  type        = bool
}

variable "aws_backup" {
  description = "true: the backup bucket and its user (BACKUP_BUCKET_NAME, and AWS_PROFILE or the AWS keys, set)."
  type        = bool
}

# --- Oracle ---

variable "oci_region" {
  description = "Oracle home region. It can't be changed after sign-up. null: the profile's region in ~/.oci/config."
  type        = string
  default     = null
}

variable "oci_config_profile" {
  description = "Which profile in ~/.oci/config to use."
  type        = string
  default     = "DEFAULT"
}

variable "oci_tenancy_ocid" {
  description = "Your tenancy's OCID (ocid1.tenancy...). It's the `tenancy` line in ~/.oci/config."
  type        = string
  default     = ""
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
  default     = null
}

variable "budget_alert_email" {
  description = "Where Oracle sends budget alerts."
  type        = string
  default     = ""
}

# --- AWS ---

variable "aws_region" {
  description = "Region for the Deep Archive bucket."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Profile in ~/.aws/credentials with admin rights. \"\": the AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables."
  type        = string
  default     = ""
}

variable "backup_bucket_name" {
  description = "S3 bucket name. Must be unique across all of AWS, e.g. memento-backup-<something random>."
  type        = string
  default     = ""
}

# --- Cloudflare ---

variable "domain" {
  description = "The Cloudflare zone (your domain), e.g. example.com."
  type        = string
  default     = ""
}

variable "subdomains" {
  description = "A records to point at the server: photos (Memento)."
  type        = set(string)
  default     = ["photos"]
}

variable "server_ipv4" {
  description = "Your own server's IPv4 address, for the DNS record when there's no Oracle server (SERVER_HOST)."
  type        = string
  default     = ""
}
