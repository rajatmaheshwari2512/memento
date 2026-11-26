# The off-site backup: an S3 bucket that rclone uploads into as Deep Archive
# (rclone sets the storage class on each upload), plus an IAM user for the VM
# that can add files but can't delete or overwrite history.

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning keeps a replaced copy as a noncurrent version.
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Parts of a failed multi-part upload are cleaned up after 7 days.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Replaced copies are kept 180 days, then removed.
  rule {
    id     = "expire-replaced-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 180
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# --- The VM's backup user ---

resource "aws_iam_user" "backup" {
  name = var.iam_user_name
}

data "aws_iam_policy_document" "backup" {
  statement {
    sid       = "ListTheBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this.arn]
  }

  statement {
    sid = "AddAndReadFiles"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      # Lets rclone cancel its own failed multi-part upload. Doesn't touch stored files.
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.this.arn}/*"]
  }

  statement {
    sid    = "NeverDeleteOrWeaken"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:DeleteBucket",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketPolicy",
    ]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]
  }
}

resource "aws_iam_user_policy" "backup" {
  name   = "selfphotos-backup-no-delete"
  user   = aws_iam_user.backup.name
  policy = data.aws_iam_policy_document.backup.json
}

# The key pair rclone uses. Rotate it with: terraform apply -replace=module.backup.aws_iam_access_key.backup
resource "aws_iam_access_key" "backup" {
  user = aws_iam_user.backup.name
}
