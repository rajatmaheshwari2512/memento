# An email if Oracle ever starts charging.

resource "oci_budget_budget" "this" {
  compartment_id = var.tenancy_ocid
  display_name   = "selfphotos-monthly"
  description    = "Alert on any real spend. Managed by Terraform."
  amount         = var.amount
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
}

# Email when actual spend this month reaches the budget.
resource "oci_budget_alert_rule" "actual" {
  budget_id      = oci_budget_budget.this.id
  display_name   = "actual-spend"
  type           = "ACTUAL"
  threshold_type = "PERCENTAGE"
  threshold      = 100
  recipients     = var.alert_email
  message        = "SelfPhotos: Oracle spend has reached the monthly budget. Check Billing → Cost Analysis."
}

# Email when Oracle predicts the month will end over budget.
resource "oci_budget_alert_rule" "forecast" {
  budget_id      = oci_budget_budget.this.id
  display_name   = "forecast-spend"
  type           = "FORECAST"
  threshold_type = "PERCENTAGE"
  threshold      = 100
  recipients     = var.alert_email
  message        = "SelfPhotos: Oracle forecasts spend over the monthly budget. Check Billing → Cost Analysis."
}
