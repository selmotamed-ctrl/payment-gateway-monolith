-- Admin-assisted onboarding, persisted review evidence and secure KYB files.

ALTER TABLE `join_requests`
  ADD COLUMN `profile_json` JSON NULL,
  ADD COLUMN `review_checklist_json` JSON NULL,
  ADD COLUMN `duplicate_flags_json` JSON NULL,
  ADD COLUMN `sla_paused_at` DATETIME(3) NULL,
  ADD COLUMN `sla_remaining_seconds` INT NULL,
  ADD COLUMN `last_screened_at` DATETIME(3) NULL;

ALTER TABLE `kyb_documents`
  ADD COLUMN `original_file_name` TEXT NULL,
  ADD COLUMN `content_ciphertext` LONGTEXT NULL,
  ADD COLUMN `uploaded_by` VARCHAR(191) NULL,
  ADD COLUMN `review_notes` TEXT NULL,
  ADD INDEX `kyb_documents_uploaded_by_idx` (`uploaded_by`),
  ADD CONSTRAINT `kyb_documents_uploaded_by_fkey`
    FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `beneficial_owners`
  ADD COLUMN `national_id_hash` CHAR(64) NULL,
  ADD INDEX `beneficial_owners_national_id_hash_idx` (`national_id_hash`);

ALTER TABLE `merchants`
  ADD COLUMN `payout_account_hash` CHAR(64) NULL,
  ADD INDEX `merchants_tax_id_idx` (`taxId`(100)),
  ADD INDEX `merchants_registration_no_idx` (`registrationNo`(100)),
  ADD INDEX `merchants_contact_phone_idx` (`contactPhone`),
  ADD INDEX `merchants_contact_email_idx` (`contactEmail`),
  ADD INDEX `merchants_payout_account_hash_idx` (`payout_account_hash`);

ALTER TABLE `users`
  ADD COLUMN `invitation_token_hash` CHAR(64) NULL,
  ADD COLUMN `invitation_expires_at` DATETIME(3) NULL,
  ADD COLUMN `invited_by` VARCHAR(191) NULL,
  ADD INDEX `users_invitation_token_hash_idx` (`invitation_token_hash`),
  ADD INDEX `users_invited_by_idx` (`invited_by`),
  ADD CONSTRAINT `users_invited_by_fkey`
    FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
