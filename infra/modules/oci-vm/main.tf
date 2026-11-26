# The free ARM VM that runs Caddy and Immich. Everything inside it is set up by Ansible (../../../host).

data "oci_identity_availability_domains" "this" {
  compartment_id = var.tenancy_ocid
}

# The newest Ubuntu 24.04 image that runs on the A1 (ARM) shape.
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
    # A destroy, or any change that needs a new VM, stops with an error instead of deleting it.
    prevent_destroy = true

    ignore_changes = [
      # Ignored on purpose: a new image ID would swap the boot disk in place and wipe the VM.
      source_details[0].source_id,
      # The SSH key only matters at first boot.
      metadata,
      availability_domain,
    ]
  }
}
