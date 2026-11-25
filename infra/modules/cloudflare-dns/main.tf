# A records for the VM, e.g. photos.example.com -> VM IP.
# Only these records are managed. The rest of the zone is left alone.

# Look up the zone's ID from its name. (`filter` is an attribute, so it uses `=`.)
data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

# for_each makes one record per subdomain. In state they are named
# cloudflare_dns_record.this["photos"], cloudflare_dns_record.this["drive"], ...
resource "cloudflare_dns_record" "this" {
  for_each = var.subdomains

  zone_id = data.cloudflare_zone.this.id
  # The full name, because that's what Cloudflare returns. A short "photos" could
  # show up as a change on every plan.
  name    = "${each.value}.${var.zone_name}"
  type    = "A"
  content = var.ipv4
  ttl     = 1 # 1 = automatic
  # MUST stay false ("DNS only", grey cloud): Cloudflare's proxy caps uploads at
  # 100 MB, which would break long videos.
  proxied = false
  comment = "SelfPhotos VM. Managed by Terraform. Keep DNS only."
}
