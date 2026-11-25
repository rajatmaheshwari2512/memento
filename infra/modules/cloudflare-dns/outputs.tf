output "hostnames" {
  value = [for r in cloudflare_dns_record.this : r.name]
}
