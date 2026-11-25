# Where things were before the parts became optional (count).

moved {
  from = oci_identity_compartment.selfphotos
  to   = oci_identity_compartment.selfphotos[0]
}

moved {
  from = module.oci_network
  to   = module.oci_network[0]
}

moved {
  from = module.oci_vm
  to   = module.oci_vm[0]
}

moved {
  from = module.oci_budget
  to   = module.oci_budget[0]
}

moved {
  from = module.backup
  to   = module.backup[0]
}

moved {
  from = module.dns
  to   = module.dns[0]
}
