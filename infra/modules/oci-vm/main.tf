# The free ARM VM that runs Caddy and Immich.
# Terraform only creates it. Everything inside it (Docker, rclone, Caddy, Immich)
# is set up by Ansible (../../../host), so there is no cloud-init script here.

# `data` blocks read things that already exist instead of creating them.

# The region's first availability domain. This finds its name.
data "oci_identity_availability_domains" "this" {
  compartment_id = var.tenancy_ocid
}

# The newest Ubuntu 24.04 image that runs on the A1 (ARM) shape.
# "24.04" leaves out the "24.04 Minimal" images.
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "this" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[0].name
  display_name        = var.name
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  create_vnic_details {
    subnet_id        = var.subnet_id
    assign_public_ip = true
    hostname_label   = var.name
  }

  # Read once, at first boot, to let the `ubuntu` user log in with your key.
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
  }

  lifecycle {
    # `terraform destroy`, or any change that needs a new VM, stops with an error
    # instead of deleting the VM (Postgres and thumbnails live on its disk).
    prevent_destroy = true

    ignore_changes = [
      # Oracle publishes new Ubuntu images often, so the data block above returns a
      # new ID. For Linux images, Oracle applies a new source_id IN PLACE by swapping
      # the boot disk, which would wipe the VM. Ignoring it pins the image used at
      # creation. Ubuntu updates itself through apt instead.
      source_details[0].source_id,
      # The SSH key only matters at first boot. Manage keys on the VM after that.
      metadata,
      # Changing it would need a new VM.
      availability_domain,
    ]
  }
}
