variable "tenancy_ocid" {
  type = string
}

variable "amount" {
  description = "Whole number, in the account's rate-card currency."
  type        = number
}

variable "alert_email" {
  type = string
}
