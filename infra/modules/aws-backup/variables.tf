variable "bucket_name" {
  description = "Globally unique S3 bucket name."
  type        = string
}

variable "iam_user_name" {
  type    = string
  default = "selfphotos-backup"
}
