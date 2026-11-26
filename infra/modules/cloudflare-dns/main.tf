# A records for the VM, e.g. photos.example.com -> VM IP.
# Only these records are managed. The rest of the zone is left alone.

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

resource "cloudflare_dns_record" "this" {
  for_each = var.subdomains

  zone_id = data.cloudflare_zone.this.id
  name    = "${each.value}.${var.zone_name}"
  type    = "A"
  content = var.ipv4
  ttl     = 1 # 1 = automatic
  # Must stay false (DNS only): Cloudflare's proxy caps uploads at 100 MB.
  proxied = false
  comment = "SelfPhotos VM. Managed by Terraform. Keep DNS only."
}
