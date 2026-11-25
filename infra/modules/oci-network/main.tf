# A private network (VCN) with one public subnet and a route to the internet.
#
#   internet ── internet gateway ── route table ── subnet (10.0.0.0/24) ── VM
#                                                    └─ security list = firewall
#
# The security list is Oracle's firewall in front of the VM. The VM has its own
# firewall too (iptables), which the Ansible caddy role opens for 80 and 443.

resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_id
  display_name   = "${var.name}-vcn"
  cidr_blocks    = [var.vcn_cidr]
  dns_label      = var.name
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name}-igw"
  enabled        = true
}

# Send all traffic that isn't for the VCN itself out through the internet gateway.
resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name}-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name}-public-sl"

  # The VM may connect out to anything (apt, Docker images, Hetzner, AWS).
  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  # protocol "6" is TCP, "1" is ICMP (Oracle uses protocol numbers).

  # SSH, for Ansible and you.
  ingress_security_rules {
    protocol    = "6"
    source      = var.ssh_allowed_cidr
    description = "SSH"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP. Caddy needs it to get the Let's Encrypt certificate, then redirects to HTTPS.
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    description = "HTTP (certificates + redirect)"
    tcp_options {
      min = 80
      max = 80
    }
  }

  # HTTPS: Immich through Caddy.
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    description = "HTTPS"
    tcp_options {
      min = 443
      max = 443
    }
  }

  # "Fragmentation needed" messages. Without them some large transfers stall.
  # Oracle's default security list has the same two ICMP rules.
  ingress_security_rules {
    protocol    = "1"
    source      = "0.0.0.0/0"
    description = "ICMP path MTU discovery"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol    = "1"
    source      = var.vcn_cidr
    description = "ICMP unreachable from inside the VCN"
    icmp_options {
      type = 3
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_id
  vcn_id                     = oci_core_vcn.this.id
  display_name               = "${var.name}-public"
  cidr_block                 = var.subnet_cidr
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
}
