-- ============================================================================
-- 20261103000000_high_scale_architecture_and_indexes.sql
--
-- HIGH-SCALE (10M-100M+ ROWS) PRODUCTION MIGRATION FOR core-back
-- Replaces the flawed 20261103000000_perf_indexes.sql with:
--   1. Column type tightening (@db.Text -> VARCHAR) to eliminate disk temp tables
--      and enable native B-Tree indexing on provider/gateway/network references.
--   2. Missing B-Tree & Covering Indexes (including provider_reference,
--      gateway_reference, network_reference, and UUIDv7 covering ledger index).
--   3. Safe Redundant Index Cleanup (KEEPING payment_attempts_merchant_id_created_at_idx
--      which the prior SQL mistakenly dropped!).
--   4. O(1) Materialized Financial & Operational Tables:
--      - gl_accounts.current_balance & lines_since_checkpoint
--      - route_daily_volumes
--      - velocity_window_buckets
--      - merchant_daily_stats
--      - kyb_document_hash_stats
--      - entity_search_tokens
--      - Hot/Cold Payload Offload Tables (inbound_event_payloads,
--        reconciliation_run_files, audit_log_payloads)
-- ============================================================================

-- ============================================================================
-- PART 1: COLUMN TYPE TIGHTENING (TEXT -> VARCHAR FOR INDEXABILITY & RAM TEMP TABLES)
-- ============================================================================

ALTER TABLE `payment_attempts`
  MODIFY COLUMN `reference` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `idempotency_key` VARCHAR(128) NULL,
  MODIFY COLUMN `mode` VARCHAR(32) NOT NULL,
  MODIFY COLUMN `sub_mode` VARCHAR(32) NULL,
  MODIFY COLUMN `substatus` VARCHAR(64) NULL,
  MODIFY COLUMN `gateway_reference` VARCHAR(128) NULL,
  MODIFY COLUMN `provider_reference` VARCHAR(128) NULL,
  MODIFY COLUMN `network_reference` VARCHAR(128) NULL,
  MODIFY COLUMN `gateway_amount_wire` VARCHAR(64) NULL,
  MODIFY COLUMN `client_ip` VARCHAR(45) NULL;

ALTER TABLE `merchants`
  MODIFY COLUMN `legal_name` VARCHAR(255) NOT NULL,
  MODIFY COLUMN `trade_name` VARCHAR(255) NOT NULL,
  MODIFY COLUMN `tax_id` VARCHAR(64) NULL,
  MODIFY COLUMN `registration_no` VARCHAR(64) NULL,
  MODIFY COLUMN `business_category` VARCHAR(128) NULL,
  MODIFY COLUMN `contact_phone` VARCHAR(64) NULL,
  MODIFY COLUMN `contact_email` VARCHAR(191) NULL;

ALTER TABLE `reconciliation_items`
  MODIFY COLUMN `our_reference` VARCHAR(128) NOT NULL,
  MODIFY COLUMN `provider_reference` VARCHAR(128) NOT NULL,
  MODIFY COLUMN `batch_reference` VARCHAR(128) NULL;

ALTER TABLE `adjustments`
  MODIFY COLUMN `external_dispute_ref` VARCHAR(128) NULL,
  MODIFY COLUMN `provider_refund_ref` VARCHAR(128) NULL;

ALTER TABLE `audit_log`
  MODIFY COLUMN `role` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `action` VARCHAR(96) NOT NULL,
  MODIFY COLUMN `entity_type` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `entity_id` VARCHAR(64) NOT NULL;

ALTER TABLE `detail_change_logs`
  MODIFY COLUMN `entity_type` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `entity_id` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `field_name` VARCHAR(128) NOT NULL,
  MODIFY COLUMN `request_id` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `client_ip` VARCHAR(45) NULL;

ALTER TABLE `inbound_events`
  MODIFY COLUMN `env` VARCHAR(16) NOT NULL,
  MODIFY COLUMN `source_ip` VARCHAR(45) NOT NULL,
  MODIFY COLUMN `processing_result` VARCHAR(64) NULL;

ALTER TABLE `aml_screenings`
  MODIFY COLUMN `provider_code` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `provider_request_ref` VARCHAR(128) NULL;

ALTER TABLE `regulatory_reports`
  MODIFY COLUMN `authority` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `subject_type` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `subject_id` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `submission_ref` VARCHAR(128) NULL;

-- ============================================================================
-- PART 2: GENERATED & MATERIALIZED COLUMNS ON payment_attempts & gl_accounts
-- ============================================================================

ALTER TABLE `payment_attempts`
  ADD COLUMN `terminal_effective_at` DATETIME(3)
    GENERATED ALWAYS AS (COALESCE(`terminal_at`, `created_at`)) STORED,
  ADD COLUMN `end_client_ip` VARCHAR(45) NULL,
  ADD COLUMN `end_client_phone_hash` CHAR(64) NULL,
  ADD COLUMN `end_client_card_alias` VARCHAR(64) NULL;

ALTER TABLE `gl_accounts`
  ADD COLUMN `current_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN `lines_since_checkpoint` INT NOT NULL DEFAULT 0;

-- ============================================================================
-- PART 3: HIGH-SCALE COVERING & REFERENCE INDEXES
-- ============================================================================

-- 1. External reference indexes on payment_attempts (Missed by previous agent!)
ALTER TABLE `payment_attempts`
  ADD INDEX `payment_attempts_provider_ref_idx` (`provider_reference`),
  ADD INDEX `payment_attempts_gateway_ref_idx` (`gateway_reference`),
  ADD INDEX `payment_attempts_network_ref_idx` (`network_reference`);

-- 2. Covering index for ExpirySweeperWorker (100% Index-Only scan every tick)
ALTER TABLE `payment_attempts`
  ADD INDEX `payment_attempts_status_expires_cov_idx` (`status`, `expires_at`, `terminal_at`, `substatus`);

-- 3. Covering index for route daily volume fallback & route FK
ALTER TABLE `payment_attempts`
  ADD INDEX `payment_attempts_route_status_term_cov_idx` (`route_id`, `status`, `terminal_effective_at`, `total_charged_amount`);

-- 4. Velocity scope composite indexes (for fallback & historical audits)
ALTER TABLE `payment_attempts`
  ADD INDEX `payment_attempts_end_client_ip_idx` (`end_client_ip`, `created_at`),
  ADD INDEX `payment_attempts_end_client_phone_idx` (`end_client_phone_hash`, `created_at`),
  ADD INDEX `payment_attempts_end_client_card_idx` (`end_client_card_alias`, `created_at`);

-- 5. InboundInboxWorker claim index (IS NULL + received_at ordering)
ALTER TABLE `inbound_events`
  ADD INDEX `inbound_events_processed_at_received_at_idx` (`processed_at`, `received_at`);

-- 6. PeriodicScreeningWorker 3-column covering index for correlated MAX(requested_at)
ALTER TABLE `aml_screenings`
  ADD INDEX `aml_screenings_subject_requested_at_idx` (`subject_type`, `subject_id`, `requested_at`),
  ADD INDEX `aml_screenings_provider_req_ref_idx` (`provider_request_ref`);

-- 7. Collision-free UUIDv7 Covering Index on journal_lines (gl_account_id, id, direction, amount)
--    Replaces timestamp-based created_at delta scans and prevents same-millisecond bugs!
ALTER TABLE `journal_lines`
  ADD INDEX `journal_lines_gl_account_id_cov_idx` (`gl_account_id`, `id`, `direction`, `amount`),
  ADD INDEX `journal_lines_gl_account_created_at_idx` (`gl_account_id`, `created_at`);

-- 8. Reconciliation items reference & result indexes
ALTER TABLE `reconciliation_items`
  ADD INDEX `reconciliation_items_run_result_idx` (`run_id`, `result`),
  ADD INDEX `reconciliation_items_our_ref_idx` (`our_reference`),
  ADD INDEX `reconciliation_items_provider_ref_idx` (`provider_reference`);

-- 9. Adjustments external reference indexes
ALTER TABLE `adjustments`
  ADD INDEX `adjustments_provider_refund_ref_idx` (`provider_refund_ref`),
  ADD INDEX `adjustments_external_dispute_ref_idx` (`external_dispute_ref`);

-- 10. Merchants identifier & contact indexes
ALTER TABLE `merchants`
  ADD INDEX `merchants_contact_email_idx` (`contact_email`),
  ADD INDEX `merchants_contact_phone_idx` (`contact_phone`),
  ADD INDEX `merchants_tax_id_idx` (`tax_id`),
  ADD INDEX `merchants_registration_no_idx` (`registration_no`),
  ADD FULLTEXT INDEX `merchants_names_ft_idx` (`legal_name`, `trade_name`);

-- ============================================================================
-- PART 4: SAFE REDUNDANT INDEX DROPS
-- NOTE: Unlike the previous agent's script, we STRICTLY KEEP
--       `payment_attempts_merchant_id_created_at_idx` so unfiltered merchant
--       transaction lists (`WHERE merchant_id = ? ORDER BY created_at DESC`)
--       never filesort!
-- ============================================================================

ALTER TABLE `payment_attempts`  DROP INDEX `payment_attempts_link_id_idx`;
ALTER TABLE `payment_attempts`  DROP INDEX `payment_attempts_merchant_id_idx`;
ALTER TABLE `payment_attempts`  DROP INDEX `payment_attempts_route_id_status_idx`;
ALTER TABLE `audit_log`         DROP INDEX `audit_log_entity_type_entity_id_idx`;
ALTER TABLE `merchants`         DROP INDEX `merchants_kybStatus_idx`;
ALTER TABLE `aml_rules`         DROP INDEX `aml_rules_active_idx`;
ALTER TABLE `reconciliation_runs` DROP INDEX `reconciliation_runs_statement_source_id_idx`;
ALTER TABLE `users`             DROP INDEX `users_merchant_id_idx`;
ALTER TABLE `applications`      DROP INDEX `applications_merchant_id_idx`;
ALTER TABLE `wallets`           DROP INDEX `wallets_merchant_id_idx`;
ALTER TABLE `payment_links`     DROP INDEX `payment_links_application_id_idx`;
ALTER TABLE `cashout_requests`  DROP INDEX `cashout_requests_merchant_id_idx`, DROP INDEX `cashout_requests_wallet_id_idx`;
ALTER TABLE `credential_sets`   DROP INDEX `credential_sets_owner_merchant_id_idx`;
ALTER TABLE `kyb_documents`     DROP INDEX `kyb_documents_merchant_id_idx`;
ALTER TABLE `join_requests`     DROP INDEX `join_requests_status_idx`;
ALTER TABLE `aml_screenings`    DROP INDEX `aml_screenings_result_idx`;
ALTER TABLE `aml_screenings`    DROP INDEX `aml_screenings_subject_type_subject_id_idx`;
ALTER TABLE `regulatory_reports` DROP INDEX `regulatory_reports_status_idx`;
ALTER TABLE `notification_templates` DROP INDEX `notification_templates_code_idx`;
ALTER TABLE `journal_lines`     DROP INDEX `journal_lines_gl_account_id_idx`;

-- ============================================================================
-- PART 5: O(1) MATERIALIZED COUNTER, ROLLUP, SEARCH & OFFLOAD TABLES
-- ============================================================================

-- 1. O(1) Daily Route Volume Counter Table
CREATE TABLE IF NOT EXISTS `route_daily_volumes` (
  `route_id`             CHAR(36)       NOT NULL,
  `day_bucket`           CHAR(10)       NOT NULL,
  `succeeded_count`      INT            NOT NULL DEFAULT 0,
  `total_charged_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  `updated_at`           DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`route_id`, `day_bucket`),
  INDEX `rdv_day_bucket_idx` (`day_bucket`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. O(1) Velocity & AML Cumulative Window Bucket Table
CREATE TABLE IF NOT EXISTS `velocity_window_buckets` (
  `scope_type`      VARCHAR(32)    NOT NULL,
  `scope_hash`      CHAR(64)       NOT NULL,
  `bucket_epoch`    INT            NOT NULL,
  `attempt_count`   INT            NOT NULL DEFAULT 0,
  `succeeded_count` INT            NOT NULL DEFAULT 0,
  `total_amount`    DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  `expires_at`      DATETIME(3)    NOT NULL,
  PRIMARY KEY (`scope_type`, `scope_hash`, `bucket_epoch`),
  INDEX `vwb_expires_at_idx` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. O(1) Merchant Daily Analytics Rollup Table
CREATE TABLE IF NOT EXISTS `merchant_daily_stats` (
  `merchant_id`                CHAR(36)       NOT NULL,
  `day_bucket`                 CHAR(10)       NOT NULL,
  `rail_code`                  VARCHAR(64)    NOT NULL,
  `initiated_count`            INT            NOT NULL DEFAULT 0,
  `succeeded_count`            INT            NOT NULL DEFAULT 0,
  `failed_count`               INT            NOT NULL DEFAULT 0,
  `expired_count`              INT            NOT NULL DEFAULT 0,
  `refunded_count`             INT            NOT NULL DEFAULT 0,
  `disputed_count`             INT            NOT NULL DEFAULT 0,
  `gross_succeeded_amount`     DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  `platform_commission_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  `net_merchant_amount`        DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  `updated_at`                 DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`merchant_id`, `day_bucket`, `rail_code`),
  INDEX `mds_day_rail_idx` (`day_bucket`, `rail_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. O(1) KYB Document Duplicate Hash Counter Table
CREATE TABLE IF NOT EXISTS `kyb_document_hash_stats` (
  `sha256`         CHAR(64)    NOT NULL,
  `doc_count`      INT         NOT NULL DEFAULT 1,
  `merchant_count` INT         NOT NULL DEFAULT 1,
  `first_seen_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`sha256`),
  INDEX `kdhs_merchant_count_idx` (`merchant_count`, `updated_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Unified Global Deep Search Inverted Token Index Table
CREATE TABLE IF NOT EXISTS `entity_search_tokens` (
  `token`             VARCHAR(128) NOT NULL,
  `entity_type`       VARCHAR(32)  NOT NULL,
  `entity_id`         CHAR(36)     NOT NULL,
  `merchant_id`       CHAR(36)     NULL,
  `is_sensitive`      TINYINT(1)   NOT NULL DEFAULT 0,
  `base_weight`       INT          NOT NULL DEFAULT 800,
  `title`             VARCHAR(255) NOT NULL,
  `subtitle`          VARCHAR(255) NULL,
  `reference`         VARCHAR(128) NULL,
  `status`            VARCHAR(64)  NULL,
  `operator_case_id`  CHAR(36)     NULL,
  `entity_created_at` DATETIME(3)  NOT NULL,
  PRIMARY KEY (`token`, `entity_type`, `entity_id`),
  INDEX `est_type_token_created_idx` (`entity_type`, `token`, `entity_created_at` DESC),
  INDEX `est_entity_lookup_idx` (`entity_type`, `entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Cross-Node Cache Invalidation Ring Buffer Table
CREATE TABLE IF NOT EXISTS `cache_invalidation_events` (
  `id`          BIGINT AUTO_INCREMENT PRIMARY KEY,
  `topic`       VARCHAR(64)  NOT NULL,
  `payload_key` VARCHAR(128) NULL,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `cie_created_at_idx` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Hot/Cold Payload Offload Tables (Keeping Operational B-Trees Ultra-Narrow)
CREATE TABLE IF NOT EXISTS `inbound_event_payloads` (
  `event_id`              CHAR(36)    NOT NULL PRIMARY KEY,
  `raw_body_bytes`        LONGBLOB    NOT NULL,
  `redacted_headers_json` JSON        NOT NULL,
  `created_at`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED;

CREATE TABLE IF NOT EXISTS `reconciliation_run_files` (
  `run_id`       CHAR(36)    NOT NULL PRIMARY KEY,
  `file_content` LONGBLOB    NOT NULL,
  `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED;

CREATE TABLE IF NOT EXISTS `audit_log_payloads` (
  `audit_log_id` CHAR(36)    NOT NULL PRIMARY KEY,
  `before_json`  JSON        NOT NULL,
  `after_json`   JSON        NOT NULL,
  `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=COMPRESSED;