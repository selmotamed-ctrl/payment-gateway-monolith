-- Merchant operations: optimistic concurrency, descriptive profile fields,
-- lifecycle evidence and approval maker rationale.

ALTER TABLE `merchants`
  ADD COLUMN `version` INT NOT NULL DEFAULT 1,
  ADD COLUMN `display_name` TEXT NULL,
  ADD COLUMN `logo_url` TEXT NULL,
  ADD COLUMN `support_email` VARCHAR(191) NULL,
  ADD COLUMN `support_phone` VARCHAR(191) NULL,
  ADD COLUMN `suspension_notes` TEXT NULL,
  ADD COLUMN `closed_reason_code` TEXT NULL,
  ADD COLUMN `closed_notes` TEXT NULL;

ALTER TABLE `approval_requests`
  ADD COLUMN `maker_reason` TEXT NULL;

ALTER TABLE `detail_change_logs`
  ADD INDEX `detail_change_logs_merchant_id_created_at_idx` (`merchant_id`, `created_at`);
