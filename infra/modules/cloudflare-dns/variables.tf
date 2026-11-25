variable "zone_name" {
  description = "The domain in Cloudflare, e.g. example.com."
  type        = string
}

variable "subdomains" {
  description = "One A record per name, e.g. [\"photos\"]."
  type        = set(string)
}

variable "ipv4" {
  description = "Where the records point (the VM)."
  type        = string
}
