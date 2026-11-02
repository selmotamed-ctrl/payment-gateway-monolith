-- DropForeignKey
ALTER TABLE `payment_attempts` DROP FOREIGN KEY `payment_attempts_route_id_fkey`;

-- DropIndex
DROP INDEX `merchants_kybStatus_idx` ON `merchants`;

-- DropIndex
DROP INDEX `merchants_tax_id_idx` ON `merchants`;

-- DropIndex
DROP INDEX `merchants_registration_no_idx` ON `merchants`;

-- DropIndex
DROP INDEX `payment_attempts_route_id_status_idx` ON `payment_attempts`;

-- DropIndex
DROP INDEX `audit_log_entity_type_entity_id_idx` ON `audit_log`;

-- DropIndex
DROP INDEX `aml_screenings_subject_type_subject_id_idx` ON `aml_screenings`;

-- DropIndex
DROP INDEX `aml_screenings_result_idx` ON `aml_screenings`;

-- DropIndex
DROP INDEX `regulatory_reports_status_idx` ON `regulatory_reports`;

-- AlterTable
ALTER TABLE `merchants` MODIFY `legalName` VARCHAR(255) NOT NULL,
    MODIFY `tradeName` VARCHAR(255) NOT NULL,
    MODIFY `display_name` VARCHAR(255) NULL,
    MODIFY `taxId` VARCHAR(64) NULL,
    MODIFY `registrationNo` VARCHAR(64) NULL,
    MODIFY `businessCategory` VARCHAR(128) NULL,
    MODIFY `onboardingChannel` VARCHAR(64) NOT NULL,
    MODIFY `contactPhone` VARCHAR(64) NULL,
    MODIFY `suspensionReasonCode` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `access_tokens` MODIFY `name` VARCHAR(128) NOT NULL;

-- AlterTable
ALTER TABLE `payment_links` MODIFY `key` VARCHAR(64) NOT NULL;

-- AlterTable
ALTER TABLE `gl_accounts` ADD COLUMN `current_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    ADD COLUMN `lines_since_checkpoint` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `commission_profiles` MODIFY `rail_code` VARCHAR(64) NOT NULL,
    MODIFY `rounding_mode` VARCHAR(32) NOT NULL;

-- AlterTable
ALTER TABLE `adjustments` MODIFY `external_dispute_ref` VARCHAR(191) NULL,
    MODIFY `provider_refund_ref` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `gateways` MODIFY `code` VARCHAR(64) NOT NULL,
    MODIFY `name` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `rails` MODIFY `code` VARCHAR(64) NOT NULL,
    MODIFY `name_ar` VARCHAR(191) NOT NULL,
    MODIFY `name_en` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `payment_attempts` ADD COLUMN `end_client_card_alias` VARCHAR(64) NULL,
    ADD COLUMN `end_client_ip` VARCHAR(45) NULL,
    ADD COLUMN `end_client_phone_hash` CHAR(64) NULL,
    MODIFY `reference` VARCHAR(64) NOT NULL,
    MODIFY `idempotency_key` VARCHAR(128) NULL,
    MODIFY `mode` VARCHAR(32) NOT NULL,
    MODIFY `sub_mode` VARCHAR(64) NULL,
    MODIFY `substatus` VARCHAR(96) NULL,
    MODIFY `gateway_reference` VARCHAR(128) NULL,
    MODIFY `provider_reference` VARCHAR(128) NULL,
    MODIFY `network_reference` VARCHAR(128) NULL,
    MODIFY `gateway_amount_wire` VARCHAR(64) NULL,
    MODIFY `client_ip` VARCHAR(45) NULL;

-- AlterTable
ALTER TABLE `attempt_step_logs` MODIFY `phase` VARCHAR(32) NOT NULL,
    MODIFY `outcome` VARCHAR(96) NOT NULL;

-- AlterTable
ALTER TABLE `inbound_events` MODIFY `env` VARCHAR(16) NOT NULL,
    MODIFY `source_ip` VARCHAR(45) NOT NULL,
    MODIFY `processing_result` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `reconciliation_runs` MODIFY `file_name` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `reconciliation_items` MODIFY `our_reference` VARCHAR(191) NOT NULL,
    MODIFY `provider_reference` VARCHAR(191) NOT NULL,
    MODIFY `batch_reference` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `detail_change_logs` MODIFY `entity_type` VARCHAR(64) NOT NULL,
    MODIFY `entity_id` VARCHAR(64) NOT NULL,
    MODIFY `field_name` VARCHAR(191) NOT NULL,
    MODIFY `request_id` VARCHAR(191) NOT NULL,
    MODIFY `client_ip` VARCHAR(45) NULL;

-- AlterTable
ALTER TABLE `audit_log` MODIFY `role` VARCHAR(64) NOT NULL,
    MODIFY `action` VARCHAR(96) NOT NULL,
    MODIFY `entity_type` VARCHAR(64) NOT NULL,
    MODIFY `entity_id` VARCHAR(64) NOT NULL;

-- AlterTable
ALTER TABLE `aml_screenings` MODIFY `provider_code` VARCHAR(64) NOT NULL,
    MODIFY `provider_request_ref` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `regulatory_reports` MODIFY `authority` VARCHAR(64) NOT NULL,
    MODIFY `subject_type` VARCHAR(64) NOT NULL,
    MODIFY `subject_id` VARCHAR(64) NOT NULL,
    MODIFY `submission_ref` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `notifications` MODIFY `template_code` VARCHAR(64) NOT NULL,
    MODIFY `provider_message_id` VARCHAR(191) NULL;


-- ---------------------------------------------------------------------------
-- Backfill O(1) GL balances from the existing checkpoint plus post-checkpoint
-- journal lines. `checkpoint_at` is retained as an anchor for historical
-- snapshots; `last_checkpoint_id` is reset to a real journal-line UUID so new
-- incremental checkpoints can use the collision-free id cursor.
-- ---------------------------------------------------------------------------
UPDATE `gl_accounts` g
SET `current_balance` = g.`checkpoint_balance` + COALESCE((
      SELECT SUM(CASE WHEN l.`direction` = 'DEBIT' THEN l.`amount` ELSE -l.`amount` END)
      FROM `journal_lines` l
      WHERE l.`gl_account_id` = g.`id`
        AND (g.`checkpoint_at` IS NULL OR l.`created_at` > g.`checkpoint_at`)
    ), 0),
    `lines_since_checkpoint` = (
      SELECT COUNT(*)
      FROM `journal_lines` l
      WHERE l.`gl_account_id` = g.`id`
        AND (g.`checkpoint_at` IS NULL OR l.`created_at` > g.`checkpoint_at`)
    ),
    `last_checkpoint_id` = CASE
      WHEN g.`checkpoint_at` IS NULL THEN NULL
      ELSE (
        SELECT MAX(l.`id`)
        FROM `journal_lines` l
        WHERE l.`gl_account_id` = g.`id`
          AND l.`created_at` <= g.`checkpoint_at`
      )
    END;

-- CreateTable
CREATE TABLE `route_daily_volumes` (
    `route_id` VARCHAR(191) NOT NULL,
    `day_bucket` CHAR(10) NOT NULL,
    `succeeded_count` INTEGER NOT NULL DEFAULT 0,
    `total_charged_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `rdv_day_bucket_idx`(`day_bucket`),
    PRIMARY KEY (`route_id`, `day_bucket`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `velocity_window_buckets` (
    `scope_type` ENUM('END_CLIENT_IP', 'END_CLIENT_PHONE', 'END_CLIENT_CARD', 'MERCHANT', 'APPLICATION', 'RAIL', 'LINK') NOT NULL,
    `scope_hash` CHAR(64) NOT NULL,
    `bucket_epoch` INTEGER NOT NULL,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `succeeded_count` INTEGER NOT NULL DEFAULT 0,
    `total_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `vwb_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`scope_type`, `scope_hash`, `bucket_epoch`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merchant_daily_stats` (
    `merchant_id` VARCHAR(191) NOT NULL,
    `day_bucket` CHAR(10) NOT NULL,
    `rail_code` VARCHAR(64) NOT NULL,
    `initiated_count` INTEGER NOT NULL DEFAULT 0,
    `succeeded_count` INTEGER NOT NULL DEFAULT 0,
    `failed_count` INTEGER NOT NULL DEFAULT 0,
    `expired_count` INTEGER NOT NULL DEFAULT 0,
    `refunded_count` INTEGER NOT NULL DEFAULT 0,
    `disputed_count` INTEGER NOT NULL DEFAULT 0,
    `gross_succeeded_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `platform_commission_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `net_merchant_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `mds_day_rail_idx`(`day_bucket`, `rail_code`),
    PRIMARY KEY (`merchant_id`, `day_bucket`, `rail_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `kyb_document_hash_stats` (
    `sha256` CHAR(64) NOT NULL,
    `doc_count` INTEGER NOT NULL DEFAULT 1,
    `merchant_count` INTEGER NOT NULL DEFAULT 1,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `kdhs_merchant_count_idx`(`merchant_count`, `updated_at`),
    PRIMARY KEY (`sha256`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill KYB duplicate-hash counters from the existing documents.
INSERT INTO `kyb_document_hash_stats`
  (`sha256`, `doc_count`, `merchant_count`, `first_seen_at`, `updated_at`)
SELECT `sha256`, COUNT(*), COUNT(DISTINCT `merchant_id`), MIN(`created_at`), MAX(`updated_at`)
FROM `kyb_documents`
GROUP BY `sha256`
ON DUPLICATE KEY UPDATE
  `doc_count` = VALUES(`doc_count`),
  `merchant_count` = VALUES(`merchant_count`),
  `first_seen_at` = VALUES(`first_seen_at`),
  `updated_at` = VALUES(`updated_at`);

-- CreateTable
CREATE TABLE `entity_search_tokens` (
    `token` VARCHAR(128) NOT NULL,
    `entity_type` VARCHAR(32) NOT NULL,
    `entity_id` VARCHAR(191) NOT NULL,
    `merchant_id` VARCHAR(191) NULL,
    `is_sensitive` BOOLEAN NOT NULL DEFAULT false,
    `base_weight` INTEGER NOT NULL DEFAULT 800,
    `title` VARCHAR(255) NOT NULL,
    `subtitle` VARCHAR(255) NULL,
    `reference` VARCHAR(128) NULL,
    `status` VARCHAR(64) NULL,
    `operator_case_id` VARCHAR(191) NULL,
    `entity_created_at` DATETIME(3) NOT NULL,

    INDEX `est_type_token_created_idx`(`entity_type`, `token`, `entity_created_at`),
    INDEX `est_entity_lookup_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`token`, `entity_type`, `entity_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cache_invalidation_events` (
    `event_seq` BIGINT NOT NULL AUTO_INCREMENT,
    `topic` VARCHAR(64) NOT NULL,
    `payload_key` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cie_created_at_idx`(`created_at`),
    PRIMARY KEY (`event_seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbound_event_payloads` (
    `event_id` VARCHAR(191) NOT NULL,
    `raw_body_bytes` LONGBLOB NOT NULL,
    `redacted_headers_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`event_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_run_files` (
    `run_id` VARCHAR(191) NOT NULL,
    `file_content` LONGBLOB NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`run_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log_payloads` (
    `audit_log_id` VARCHAR(191) NOT NULL,
    `before_json` JSON NOT NULL,
    `after_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`audit_log_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `merchants_tax_id_idx` ON `merchants`(`taxId`);

-- CreateIndex
CREATE INDEX `merchants_registration_no_idx` ON `merchants`(`registrationNo`);

-- CreateIndex
CREATE INDEX `gl_accounts_lines_since_checkpoint_idx` ON `gl_accounts`(`lines_since_checkpoint`);

-- CreateIndex
CREATE INDEX `journal_lines_gl_account_id_cov_idx` ON `journal_lines`(`gl_account_id`, `id`, `direction`, `amount`);

-- CreateIndex
CREATE INDEX `journal_lines_gl_account_created_at_idx` ON `journal_lines`(`gl_account_id`, `created_at`);

-- CreateIndex
CREATE INDEX `payment_attempts_provider_ref_idx` ON `payment_attempts`(`provider_reference`);

-- CreateIndex
CREATE INDEX `payment_attempts_gateway_ref_idx` ON `payment_attempts`(`gateway_reference`);

-- CreateIndex
CREATE INDEX `payment_attempts_network_ref_idx` ON `payment_attempts`(`network_reference`);

-- CreateIndex
CREATE INDEX `payment_attempts_status_expires_cov_idx` ON `payment_attempts`(`status`, `expires_at`, `terminal_at`, `substatus`);

-- CreateIndex
CREATE INDEX `payment_attempts_route_status_term_cov_idx` ON `payment_attempts`(`route_id`, `status`, `terminal_at`, `total_charged_amount`);

-- CreateIndex
CREATE INDEX `payment_attempts_end_client_ip_idx` ON `payment_attempts`(`end_client_ip`, `created_at`);

-- CreateIndex
CREATE INDEX `payment_attempts_end_client_phone_idx` ON `payment_attempts`(`end_client_phone_hash`, `created_at`);

-- CreateIndex
CREATE INDEX `payment_attempts_end_client_card_idx` ON `payment_attempts`(`end_client_card_alias`, `created_at`);

-- CreateIndex
CREATE INDEX `inbound_events_processed_at_received_at_idx` ON `inbound_events`(`processed_at`, `received_at`);

-- CreateIndex
CREATE INDEX `reconciliation_items_run_result_idx` ON `reconciliation_items`(`run_id`, `result`);

-- CreateIndex
CREATE INDEX `reconciliation_items_run_created_idx` ON `reconciliation_items`(`run_id`, `created_at`);

-- CreateIndex
CREATE INDEX `reconciliation_items_our_ref_idx` ON `reconciliation_items`(`our_reference`);

-- CreateIndex
CREATE INDEX `reconciliation_items_provider_ref_idx` ON `reconciliation_items`(`provider_reference`);

-- CreateIndex
CREATE INDEX `audit_log_created_at_idx` ON `audit_log`(`created_at`);

-- CreateIndex
CREATE INDEX `aml_screenings_subject_requested_at_idx` ON `aml_screenings`(`subject_type`, `subject_id`, `requested_at`);

-- CreateIndex
CREATE INDEX `aml_screenings_provider_req_ref_idx` ON `aml_screenings`(`provider_request_ref`);

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inbound_event_payloads` ADD CONSTRAINT `inbound_event_payloads_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `inbound_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reconciliation_run_files` ADD CONSTRAINT `reconciliation_run_files_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `reconciliation_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_log_payloads` ADD CONSTRAINT `audit_log_payloads_audit_log_id_fkey` FOREIGN KEY (`audit_log_id`) REFERENCES `audit_log`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Application schema version.
-- ---------------------------------------------------------------------------
INSERT INTO `schema_versions` (`id`, `version`)
VALUES (1, 7)
ON DUPLICATE KEY UPDATE `version` = VALUES(`version`);
