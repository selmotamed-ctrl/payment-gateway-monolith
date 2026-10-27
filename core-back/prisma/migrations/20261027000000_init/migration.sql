-- CreateTable
CREATE TABLE `merchants` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `legalName` TEXT NOT NULL,
    `tradeName` TEXT NOT NULL,
    `taxId` TEXT NULL,
    `registrationNo` TEXT NULL,
    `businessCategory` TEXT NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'CLOSED') NOT NULL DEFAULT 'PENDING',
    `kybStatus` ENUM('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED') NOT NULL DEFAULT 'UNVERIFIED',
    `riskTier` ENUM('LOW', 'STANDARD', 'HIGH') NOT NULL DEFAULT 'STANDARD',
    `onboardingChannel` VARCHAR(191) NOT NULL,
    `country` CHAR(2) NOT NULL,
    `contactPhone` VARCHAR(191) NULL,
    `contactEmail` VARCHAR(191) NULL,
    `activatedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `suspensionReasonCode` VARCHAR(191) NULL,
    `closedAt` DATETIME(3) NULL,
    `commissionReceivableCeiling` DECIMAL(18, 4) NULL,
    `negativeBalanceCeiling` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `payoutBankDetailsJson` JSON NULL,

    INDEX `merchants_status_idx`(`status`),
    INDEX `merchants_kybStatus_idx`(`kybStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `password_hash` TEXT NULL,
    `role` ENUM('GATEWAY_ADMIN', 'SECURITY_ADMIN', 'FINANCE', 'OPERATOR', 'COMPLIANCE', 'MLRO', 'SUPPORT', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'MERCHANT_CASHIER') NOT NULL,
    `authorities_map` JSON NOT NULL,
    `app_scope_ids` JSON NULL,
    `is_maker` BOOLEAN NOT NULL DEFAULT false,
    `is_checker` BOOLEAN NOT NULL DEFAULT false,
    `mfa_required` BOOLEAN NOT NULL DEFAULT true,
    `mfa_secret_ciphertext` TEXT NULL,
    `status` ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED') NOT NULL DEFAULT 'INVITED',

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_merchant_id_idx`(`merchant_id`),
    INDEX `users_role_idx`(`role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `applications` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `businessUseDescription` TEXT NULL,
    `expectedMonthlyVolume` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `assigned_wallet_id` VARCHAR(191) NOT NULL,
    `rail_whitelist` JSON NULL,
    `redirect_domain_allowlist` JSON NULL,
    `status` ENUM('DRAFT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'PENDING',

    INDEX `applications_merchant_id_idx`(`merchant_id`),
    INDEX `applications_assigned_wallet_id_idx`(`assigned_wallet_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallets` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `gl_account_id` VARCHAR(191) NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'LYD',
    `status` ENUM('PENDING', 'ACTIVE', 'FROZEN', 'CLOSED') NOT NULL DEFAULT 'PENDING',

    UNIQUE INDEX `wallets_gl_account_id_key`(`gl_account_id`),
    INDEX `wallets_merchant_id_idx`(`merchant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `access_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `application_id` VARCHAR(191) NOT NULL,
    `name` TEXT NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `last_four` CHAR(4) NOT NULL,
    `scopes` JSON NOT NULL,
    `ip_whitelist_enabled` BOOLEAN NOT NULL DEFAULT false,
    `revoked_at` DATETIME(3) NULL,
    `last_used_at` DATETIME(3) NULL,

    UNIQUE INDEX `access_tokens_token_hash_key`(`token_hash`),
    INDEX `access_tokens_merchant_id_idx`(`merchant_id`),
    INDEX `access_tokens_application_id_idx`(`application_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `access_token_ips` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `token_id` VARCHAR(191) NOT NULL,
    `cidr` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `access_token_ips_token_id_cidr_key`(`token_id`, `cidr`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_links` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `application_id` VARCHAR(191) NOT NULL,
    `wallet_id` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `fee_bearer` ENUM('MERCHANT_ABSORBS', 'PAYER_SURCHARGE', 'SPLIT') NOT NULL,
    `split_ratio_json` JSON NULL,
    `infinite_use` BOOLEAN NOT NULL DEFAULT false,
    `use_count` INTEGER NOT NULL DEFAULT 1,
    `confirmed_count` INTEGER NOT NULL DEFAULT 0,
    `active_locked_count` INTEGER NOT NULL DEFAULT 0,
    `redirect_url` TEXT NULL,
    `rail_whitelist` JSON NULL,
    `state` ENUM('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `expires_at` DATETIME(3) NULL,

    UNIQUE INDEX `payment_links_key_key`(`key`),
    INDEX `payment_links_application_id_idx`(`application_id`),
    INDEX `payment_links_wallet_id_idx`(`wallet_id`),
    INDEX `payment_links_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pos_terminals` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `application_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `location` TEXT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',

    INDEX `pos_terminals_application_id_idx`(`application_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pos_screens` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `pos_id` VARCHAR(191) NOT NULL,
    `screen_code` VARCHAR(191) NOT NULL,
    `auth_token_hash` CHAR(64) NOT NULL,
    `realtime_room_id` VARCHAR(191) NULL,
    `last_active_at` DATETIME(3) NULL,

    UNIQUE INDEX `pos_screens_screen_code_key`(`screen_code`),
    INDEX `pos_screens_pos_id_idx`(`pos_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gl_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `account_type` ENUM('TREASURY', 'GATEWAY_CLEARING', 'MERCHANT_WALLET', 'PLATFORM_INCOME', 'PROVIDER_FEE_EXPENSE', 'GATEWAY_FEE_EXPENSE', 'GATEWAY_FEE_ACCRUAL', 'COMMISSION_RECEIVABLE', 'AML_HOLD', 'CHARGEBACK_RESERVE', 'SUSPENSE') NOT NULL,
    `owner_id` VARCHAR(191) NULL,
    `gateway_id` VARCHAR(191) NULL,
    `credential_set_id` VARCHAR(191) NULL,
    `env` VARCHAR(191) NULL,
    `currency` CHAR(3) NOT NULL,
    `last_checkpoint_id` VARCHAR(191) NULL,
    `checkpoint_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `checkpoint_at` DATETIME(3) NULL,
    `seed_key` VARCHAR(191) NULL,

    UNIQUE INDEX `gl_accounts_seed_key_key`(`seed_key`),
    INDEX `gl_accounts_account_type_idx`(`account_type`),
    INDEX `gl_accounts_owner_id_idx`(`owner_id`),
    INDEX `gl_accounts_gateway_id_idx`(`gateway_id`),
    UNIQUE INDEX `gl_accounts_gateway_id_env_credential_set_id_key`(`gateway_id`, `env`, `credential_set_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_entries` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `ref_type` ENUM('PAYMENT_ATTEMPT', 'ADJUSTMENT', 'AML_RELEASE', 'AML_VOID', 'SETTLEMENT_SWEEP', 'FEE_VARIANCE', 'COMMISSION_NETTING', 'DISPUTE_OUTCOME') NOT NULL,
    `ref_id` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,

    UNIQUE INDEX `journal_entries_ref_type_ref_id_key`(`ref_type`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_lines` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `entry_id` VARCHAR(191) NOT NULL,
    `gl_account_id` VARCHAR(191) NOT NULL,
    `direction` ENUM('DEBIT', 'CREDIT') NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,

    INDEX `journal_lines_entry_id_idx`(`entry_id`),
    INDEX `journal_lines_gl_account_id_idx`(`gl_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NULL,
    `application_id` VARCHAR(191) NULL,
    `rail_code` TEXT NOT NULL,
    `calc_type` ENUM('FLAT', 'PERCENTAGE', 'TIERED', 'HYBRID') NOT NULL,
    `flat_fee` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `percentage_rate` DECIMAL(8, 6) NOT NULL DEFAULT 0,
    `tiers_json` JSON NULL,
    `min_fee` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `max_fee` DECIMAL(18, 4) NULL,
    `fee_bearer_default` ENUM('MERCHANT_ABSORBS', 'PAYER_SURCHARGE', 'SPLIT') NOT NULL,
    `rounding_mode` TEXT NOT NULL,
    `effective_from` DATETIME(3) NOT NULL,
    `effective_to` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `approval_request_id` VARCHAR(191) NULL,
    `seed_key` VARCHAR(191) NULL,

    UNIQUE INDEX `commission_profiles_seed_key_key`(`seed_key`),
    INDEX `commission_profiles_merchant_id_idx`(`merchant_id`),
    INDEX `commission_profiles_application_id_idx`(`application_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `velocity_rules` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `scope_type` ENUM('END_CLIENT_IP', 'END_CLIENT_PHONE', 'END_CLIENT_CARD', 'MERCHANT', 'APPLICATION', 'RAIL', 'LINK') NOT NULL,
    `scope_value` VARCHAR(191) NULL,
    `window_seconds` INTEGER NOT NULL,
    `max_count` INTEGER NOT NULL,
    `max_amount` DECIMAL(18, 4) NULL,
    `action` ENUM('REJECT', 'FLAG') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `effective_from` DATETIME(3) NOT NULL,
    `effective_to` DATETIME(3) NULL,
    `approval_request_id` VARCHAR(191) NULL,

    INDEX `velocity_rules_scope_type_scope_value_idx`(`scope_type`, `scope_value`),
    INDEX `velocity_rules_active_idx`(`active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `aml_cases` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `subject_type` ENUM('MERCHANT', 'END_CLIENT', 'PAYMENT_ATTEMPT', 'BENEFICIAL_OWNER') NOT NULL,
    `subject_id` VARCHAR(191) NOT NULL,
    `trigger_reason` TEXT NOT NULL,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL,
    `severity_inputs_json` JSON NOT NULL,
    `screening_id` VARCHAR(191) NULL,
    `rule_id` VARCHAR(191) NULL,
    `rule_version` INTEGER NULL,
    `hold_journal_entry_id` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'IN_REVIEW', 'PENDING_CHECKER', 'RELEASED', 'REJECTED_VOID', 'FROZEN', 'ESCALATED_STR') NOT NULL DEFAULT 'OPEN',
    `sla_due_at` DATETIME(3) NULL,
    `assigned_reviewer_id` VARCHAR(191) NULL,
    `regulatory_report_id` VARCHAR(191) NULL,
    `confidential` BOOLEAN NOT NULL DEFAULT true,
    `reviewer_notes` TEXT NULL,

    INDEX `aml_cases_status_idx`(`status`),
    INDEX `aml_cases_subject_type_subject_id_idx`(`subject_type`, `subject_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adjustments` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `type` ENUM('CHARGEBACK', 'REFUND', 'MANUAL_CREDIT', 'MANUAL_DEBIT', 'CORRECTION', 'CASHOUT_SUBTRACTION') NOT NULL,
    `target_gl_account_id` VARCHAR(191) NOT NULL,
    `source_attempt_id` VARCHAR(191) NULL,
    `dispute_id` VARCHAR(191) NULL,
    `drafted_by_system` BOOLEAN NOT NULL DEFAULT false,
    `amount` DECIMAL(18, 4) NOT NULL,
    `reverse_commission` BOOLEAN NOT NULL DEFAULT false,
    `reason` TEXT NOT NULL,
    `external_dispute_ref` TEXT NULL,
    `provider_refund_ref` TEXT NULL,
    `state` ENUM('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'EXECUTING', 'EXECUTED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
    `journal_entry_id` VARCHAR(191) NULL,

    UNIQUE INDEX `adjustments_dispute_id_key`(`dispute_id`),
    UNIQUE INDEX `adjustments_journal_entry_id_key`(`journal_entry_id`),
    INDEX `adjustments_target_gl_account_id_idx`(`target_gl_account_id`),
    INDEX `adjustments_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cashout_requests` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `wallet_id` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `destination_bank_json` JSON NOT NULL,
    `state` ENUM('PENDING', 'REJECTED', 'PROCESSING', 'COMPLETE', 'SUBTRACTED') NOT NULL DEFAULT 'PENDING',
    `adjustment_id` VARCHAR(191) NULL,

    INDEX `cashout_requests_merchant_id_idx`(`merchant_id`),
    INDEX `cashout_requests_wallet_id_idx`(`wallet_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_requests` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `subject_type` VARCHAR(191) NOT NULL,
    `subject_id` VARCHAR(191) NOT NULL,
    `payload_diff_json` JSON NOT NULL,
    `mode` ENUM('STANDARD', 'EMERGENCY_RATIFICATION') NOT NULL DEFAULT 'STANDARD',
    `base_version` INTEGER NULL,
    `expires_at` DATETIME(3) NULL,
    `ratify_due_at` DATETIME(3) NULL,
    `maker_user_id` VARCHAR(191) NOT NULL,
    `checker_user_id` VARCHAR(191) NULL,
    `state` ENUM('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'EXECUTED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
    `rejection_reason` TEXT NULL,
    `risk_acceptance_note` TEXT NULL,

    INDEX `approval_requests_maker_user_id_idx`(`maker_user_id`),
    INDEX `approval_requests_checker_user_id_idx`(`checker_user_id`),
    INDEX `approval_requests_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateways` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` TEXT NOT NULL,
    `operator` VARCHAR(191) NOT NULL,
    `country` CHAR(2) NOT NULL DEFAULT 'LY',
    `aliases` JSON NOT NULL,
    `kind` ENUM('DIRECT', 'AGGREGATOR', 'NATIVE_ADAPTER', 'INTERNAL') NOT NULL,
    `status` ENUM('DRAFT', 'SANDBOX_VERIFIED', 'PENDING_APPROVAL', 'LIVE', 'SUSPENDED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `active_version_id` VARCHAR(191) NULL,
    `verificationState` ENUM('VERIFIED', 'UNVERIFIED') NOT NULL DEFAULT 'UNVERIFIED',
    `riskClass` ENUM('NORMAL', 'HIGH_RISK') NOT NULL DEFAULT 'NORMAL',
    `metadata` JSON NULL,

    UNIQUE INDEX `gateways_code_key`(`code`),
    UNIQUE INDEX `gateways_active_version_id_key`(`active_version_id`),
    INDEX `gateways_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_versions` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_id` VARCHAR(191) NOT NULL,
    `version_number` INTEGER NOT NULL,
    `snapshot_ciphertext` TEXT NOT NULL,
    `content_hash` CHAR(64) NOT NULL,
    `state` ENUM('DRAFT', 'SANDBOX_VERIFIED', 'PENDING_APPROVAL', 'LIVE', 'SUPERSEDED', 'ROLLED_BACK') NOT NULL DEFAULT 'DRAFT',
    `created_by` VARCHAR(191) NOT NULL,
    `approval_request_id` VARCHAR(191) NULL,
    `change_note` TEXT NULL,
    `rollback_version_id` VARCHAR(191) NULL,

    UNIQUE INDEX `gateway_versions_content_hash_key`(`content_hash`),
    INDEX `gateway_versions_state_idx`(`state`),
    UNIQUE INDEX `gateway_versions_gateway_id_version_number_key`(`gateway_id`, `version_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_version_evidence` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `evidence_json` JSON NOT NULL,
    `ran_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `gateway_version_evidence_gateway_version_id_key`(`gateway_version_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_environments` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `env` ENUM('SANDBOX', 'LIVE') NOT NULL,
    `base_urls` JSON NOT NULL,
    `allowed_hosts` JSON NOT NULL,
    `inbound_ip_allowlist` JSON NOT NULL,
    `outbound_egress_ips` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `gateway_environments_gateway_version_id_env_key`(`gateway_version_id`, `env`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_auth` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `env` VARCHAR(191) NOT NULL,
    `method` ENUM('NONE', 'API_KEY', 'PERMANENT_TOKEN', 'TOKEN_ENDPOINT', 'REFRESH_TOKEN', 'USERNAME_PASSWORD', 'BASIC', 'REQUEST_SIGNATURE', 'OAUTH2_CLIENT_CREDENTIALS', 'MUTUAL_TLS') NOT NULL,
    `auth_apply` ENUM('HEADER', 'QUERY', 'BODY') NOT NULL,
    `refresh_config_json` JSON NULL,

    UNIQUE INDEX `gateway_auth_gateway_version_id_env_key`(`gateway_version_id`, `env`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_settings` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `amount_scale` INTEGER NOT NULL,
    `amount_precision` INTEGER NOT NULL,
    `amount_rounding` VARCHAR(191) NOT NULL,
    `amount_format` VARCHAR(191) NOT NULL,
    `reference_format` JSON NOT NULL,
    `session_ttl_seconds` INTEGER NOT NULL,
    `otp_ttl_seconds` INTEGER NOT NULL,
    `otp_resend_cooldown_seconds` INTEGER NOT NULL,
    `max_otp_attempts` INTEGER NOT NULL DEFAULT 3,
    `supports_status_check` BOOLEAN NOT NULL DEFAULT false,
    `status_check_min_age_seconds` INTEGER NULL,
    `supports_idempotency_key` BOOLEAN NOT NULL DEFAULT false,
    `supports_cancel` BOOLEAN NOT NULL DEFAULT false,
    `rate_limit_per_second` INTEGER NULL,
    `concurrency_cap` INTEGER NULL,
    `timeout_ms` INTEGER NOT NULL DEFAULT 15000,
    `max_response_bytes` INTEGER NOT NULL DEFAULT 2097152,
    `gateway_timezone` VARCHAR(191) NOT NULL DEFAULT 'Africa/Tripoli',

    UNIQUE INDEX `gateway_settings_gateway_version_id_key`(`gateway_version_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credential_sets` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_id` VARCHAR(191) NOT NULL,
    `env` ENUM('SANDBOX', 'LIVE') NOT NULL,
    `owner_type` ENUM('PLATFORM', 'MERCHANT') NOT NULL,
    `owner_merchant_id` VARCHAR(191) NULL,
    `external_merchant_id` VARCHAR(191) NULL,
    `settlement_target` ENUM('PLATFORM_CLEARING', 'MERCHANT_DIRECT', 'PROVIDER_HELD') NOT NULL,
    `entries_ciphertext` JSON NOT NULL,
    `mtls_cert_ciphertext` TEXT NULL,
    `status` ENUM('UNTESTED', 'VERIFIED', 'FAILING', 'REVOKED') NOT NULL DEFAULT 'UNTESTED',
    `last_verified_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NULL,

    INDEX `credential_sets_owner_merchant_id_idx`(`owner_merchant_id`),
    UNIQUE INDEX `credential_sets_gateway_id_env_external_merchant_id_key`(`gateway_id`, `env`, `external_merchant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assets` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `mime` ENUM('IMAGE_PNG', 'IMAGE_SVG_XML') NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `storage_key` TEXT NOT NULL,
    `sha256` CHAR(64) NOT NULL,

    UNIQUE INDEX `assets_name_key`(`name`),
    UNIQUE INDEX `assets_sha256_key`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rails` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_ar` TEXT NOT NULL,
    `name_en` TEXT NOT NULL,
    `logo_asset_id` VARCHAR(191) NULL,
    `collection_mode` ENUM('OTP_PULL', 'REDIRECT', 'EMBEDDED', 'PUSH_APPROVAL', 'QR_DISPLAY', 'PAY_CODE', 'DEEP_LINK', 'MANUAL', 'HYBRID') NOT NULL,
    `sub_modes` JSON NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'LYD',
    `min_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `max_amount` DECIMAL(18, 4) NULL,
    `display_order` INTEGER NOT NULL DEFAULT 0,
    `blocked` BOOLEAN NOT NULL DEFAULT false,
    `capabilities` JSON NOT NULL,
    `refund_window_days` INTEGER NULL,
    `instructions_ar` TEXT NULL,
    `instructions_en` TEXT NULL,
    `metadata` JSON NULL,

    UNIQUE INDEX `rails_code_key`(`code`),
    INDEX `rails_collection_mode_idx`(`collection_mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rail_fields` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `rail_id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `type` ENUM('PHONE', 'NUMBER', 'STRING', 'OTP', 'BIRTH_YEAR', 'CARD_NUMBER', 'PAN', 'WALLET_ID', 'FROM_LIST') NOT NULL,
    `checksum` ENUM('NONE', 'LUHN') NOT NULL DEFAULT 'NONE',
    `label_ar` TEXT NOT NULL,
    `label_en` TEXT NOT NULL,
    `placeholder_ar` TEXT NULL,
    `placeholder_en` TEXT NULL,
    `regex` TEXT NULL,
    `min_length` INTEGER NULL,
    `max_length` INTEGER NULL,
    `min_val` DECIMAL(18, 4) NULL,
    `max_val` DECIMAL(18, 4) NULL,
    `options_json` JSON NULL,
    `required` BOOLEAN NOT NULL DEFAULT true,
    `order_index` INTEGER NOT NULL,
    `sensitivity` ENUM('NORMAL', 'SENSITIVE', 'PAN') NOT NULL DEFAULT 'NORMAL',
    `normalizer` JSON NULL,

    UNIQUE INDEX `rail_fields_rail_id_key_key`(`rail_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rail_routes` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `rail_id` VARCHAR(191) NOT NULL,
    `gateway_id` VARCHAR(191) NOT NULL,
    `credential_policy` ENUM('PLATFORM', 'MERCHANT_REQUIRED', 'MERCHANT_OR_PLATFORM') NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `routing_strategy` ENUM('EFFECTIVE_COST', 'STRICT_PRIORITY', 'WEIGHTED') NOT NULL DEFAULT 'EFFECTIVE_COST',
    `weight` INTEGER NOT NULL DEFAULT 100,
    `cost_model` JSON NOT NULL,
    `mismatch_policy` JSON NOT NULL,
    `min_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `max_amount` DECIMAL(18, 4) NULL,
    `daily_cap_amount` DECIMAL(18, 4) NULL,
    `status` ENUM('ACTIVE', 'PAUSED', 'DRAINING') NOT NULL DEFAULT 'ACTIVE',
    `health_state` ENUM('HEALTHY', 'DEGRADED', 'OPEN_BREAKER') NOT NULL DEFAULT 'HEALTHY',
    `maintenance_windows` JSON NULL,
    `scope` JSON NOT NULL,

    INDEX `rail_routes_status_health_state_idx`(`status`, `health_state`),
    UNIQUE INDEX `rail_routes_rail_id_gateway_id_credential_policy_key`(`rail_id`, `gateway_id`, `credential_policy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `crypto_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `purpose` ENUM('OUTBOUND_SIGN', 'INBOUND_VERIFY') NOT NULL,
    `algorithm` ENUM('HMAC_SHA256', 'HMAC_SHA512', 'RSA_SHA256', 'SHA256') NOT NULL,
    `secret_key_ref` TEXT NULL,
    `secret_key_encoding` ENUM('UTF8', 'HEX', 'BASE64') NOT NULL,
    `canonicalization_mode` ENUM('SORTED_KEY_VALUE_AMP', 'SORTED_VALUES_HASH', 'TEMPLATE_STRING', 'JSON_CANONICAL', 'RAW_BODY', 'TIMESTAMP_DOT_RAW_BODY') NOT NULL,
    `template_string` TEXT NULL,
    `included_fields` JSON NOT NULL,
    `excluded_fields` JSON NOT NULL,
    `output_encoding` ENUM('HEX_LOWER', 'HEX_UPPER', 'BASE64') NOT NULL,

    UNIQUE INDEX `crypto_profiles_gateway_version_id_name_key`(`gateway_version_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flows` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `rail_id` VARCHAR(191) NULL,
    `sub_mode` VARCHAR(191) NULL,
    `phase` ENUM('CREDENTIAL_CHECK', 'PRE_INITIATE', 'INITIATE', 'SUBMIT', 'VERIFY', 'CANCEL', 'REFUND', 'VOID', 'CAPTURE', 'SETTLEMENT_FETCH') NOT NULL,

    INDEX `flows_gateway_version_id_phase_idx`(`gateway_version_id`, `phase`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flow_steps` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `flow_id` VARCHAR(191) NOT NULL,
    `order_index` INTEGER NOT NULL,
    `type` ENUM('HTTP', 'COMPUTE', 'RENDER', 'WAIT', 'ASSERT', 'BRANCH') NOT NULL,
    `method` VARCHAR(191) NULL,
    `url_template` TEXT NULL,
    `content_type` ENUM('APPLICATION_JSON', 'APPLICATION_FORM_URLENCODED', 'MULTIPART_FORM_DATA', 'APPLICATION_XML', 'TEXT_XML', 'TEXT_PLAIN') NULL,
    `xml_template` TEXT NULL,
    `timeout_ms` INTEGER NULL,
    `success_check` JSON NULL,
    `sideEffect` ENUM('READ_ONLY', 'SENDS_NOTIFICATION', 'MOVES_MONEY') NOT NULL,
    `retry_policy` ENUM('SAFE', 'SAFE_WITH_COOLDOWN', 'NEVER') NOT NULL,
    `idempotency_config` JSON NOT NULL,
    `point_of_no_return` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `flow_steps_flow_id_order_index_key`(`flow_id`, `order_index`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `step_parameters` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `step_id` VARCHAR(191) NOT NULL,
    `place` ENUM('HEADERS', 'QUERY', 'PATH', 'BODY', 'FORM', 'MULTIPART', 'XML') NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `source` ENUM('GATEWAY_META', 'ROUTE_META', 'CREDENTIAL', 'ATTEMPT', 'CUSTOMER_FIELD', 'STATE', 'PREVIOUS_RESPONSE', 'URLS', 'CLIENT_CONTEXT', 'CONSTANT', 'NOW', 'RANDOM', 'COMPUTED', 'CRYPTO_SIGNATURE') NOT NULL,
    `selector` TEXT NULL,
    `constant_value` TEXT NULL,
    `crypto_profile_id` VARCHAR(191) NULL,
    `transforms` JSON NOT NULL,

    UNIQUE INDEX `step_parameters_step_id_place_key_key`(`step_id`, `place`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `step_outputs` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `step_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `selector` TEXT NULL,
    `transforms` JSON NOT NULL,
    `store_as` ENUM('STATE', 'PUBLIC', 'SETTLED_AMOUNT', 'PROVIDER_FEE', 'PROVIDER_REF', 'NETWORK_REF') NOT NULL,
    `required` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `step_outputs_step_id_name_key`(`step_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `status_rules` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `phase` VARCHAR(191) NOT NULL,
    `order_index` INTEGER NOT NULL,
    `selector` TEXT NOT NULL,
    `op` ENUM('EQUALS', 'NOT_EQUALS', 'IN', 'EXISTS', 'MATCHES') NOT NULL,
    `value_json` JSON NOT NULL,
    `canonical_status` ENUM('AWAITING_CUSTOMER', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'UNKNOWN') NOT NULL,
    `canonical_substatus` TEXT NULL,
    `canonical_error` TEXT NULL,

    UNIQUE INDEX `status_rules_gateway_version_id_phase_order_index_key`(`gateway_version_id`, `phase`, `order_index`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `error_maps` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `gateway_code` VARCHAR(191) NOT NULL,
    `canonical_error` VARCHAR(191) NOT NULL,
    `classification` ENUM('RETRYABLE_OTP', 'TERMINAL_DECLINE', 'LIMIT_EXCEEDED', 'GATEWAY_FAULT', 'AMBIGUOUS') NOT NULL,
    `retryable` BOOLEAN NOT NULL DEFAULT false,
    `counts_toward_lockout` BOOLEAN NOT NULL DEFAULT false,
    `counts_toward_breaker` BOOLEAN NOT NULL DEFAULT false,
    `customer_message_ar` TEXT NULL,
    `customer_message_en` TEXT NULL,
    `operator_hint` TEXT NULL,

    UNIQUE INDEX `error_maps_gateway_version_id_gateway_code_canonical_error_key`(`gateway_version_id`, `gateway_code`, `canonical_error`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `confirmation_channels` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `route_id` VARCHAR(191) NULL,
    `type` ENUM('WEBHOOK', 'RETURN_URL', 'BROWSER_CALLBACK', 'POLL', 'STATEMENT', 'OPERATOR') NOT NULL,
    `path_token` VARCHAR(191) NOT NULL,
    `crypto_profile_id` VARCHAR(191) NULL,
    `verify_method` ENUM('HMAC_BODY', 'HASH_FIELDS', 'SORTED_VALUES_HASH', 'RSA', 'SHARED_TOKEN', 'IP_ONLY', 'NONE_PLUS_INQUIRY') NOT NULL,
    `signature_header` TEXT NULL,
    `timestamp_selector` TEXT NULL,
    `timestamp_tolerance_sec` INTEGER NOT NULL DEFAULT 300,
    `ip_allowlist` JSON NULL,
    `body_format` ENUM('JSON', 'FORM', 'XML') NOT NULL,
    `correlation_selector` TEXT NULL,
    `dedupe_key_selector` TEXT NULL,
    `event_map` JSON NOT NULL,
    `must_inquire` BOOLEAN NOT NULL DEFAULT false,
    `ack_status` INTEGER NOT NULL DEFAULT 200,
    `ack_body_template` TEXT NULL,

    UNIQUE INDEX `confirmation_channels_path_token_key`(`path_token`),
    INDEX `confirmation_channels_gateway_version_id_idx`(`gateway_version_id`),
    INDEX `confirmation_channels_route_id_idx`(`route_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `poll_policies` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `route_id` VARCHAR(191) NOT NULL,
    `first_after_seconds` INTEGER NOT NULL DEFAULT 5,
    `backoff_seconds` JSON NOT NULL,
    `max_duration_seconds` INTEGER NOT NULL DEFAULT 900,
    `stop_on_states` JSON NOT NULL,

    UNIQUE INDEX `poll_policies_route_id_key`(`route_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `widget_definitions` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `route_id` VARCHAR(191) NOT NULL,
    `kind` ENUM('LIGHTBOX', 'IFRAME', 'SDK_WEBVIEW', 'NATIVE_ANDROID') NOT NULL,
    `sdk_driver` TEXT NULL,
    `script_urls` JSON NOT NULL,
    `script_sri_hashes` JSON NOT NULL,
    `config_template` JSON NOT NULL,
    `callbacks_map` JSON NOT NULL,
    `allowed_origins` JSON NOT NULL,
    `iframe_sandbox_attrs` JSON NOT NULL,
    `csp_additions` VARCHAR(191) NULL,

    UNIQUE INDEX `widget_definitions_route_id_key`(`route_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `redirect_definitions` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `route_id` VARCHAR(191) NOT NULL,
    `method` ENUM('GET', 'POST_FORM') NOT NULL,
    `url_source_output` TEXT NOT NULL,
    `form_fields_output` TEXT NULL,
    `target` ENUM('SAME_WINDOW', 'NEW_TAB', 'TOP_FRAME') NOT NULL,
    `return_method_expected` ENUM('GET', 'POST') NOT NULL,
    `return_params_map` JSON NOT NULL,

    UNIQUE INDEX `redirect_definitions_route_id_key`(`route_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `statement_sources` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_id` VARCHAR(191) NOT NULL,
    `type` ENUM('API', 'SFTP', 'UPLOAD') NOT NULL,
    `schedule_cron` TEXT NULL,
    `parser_config` JSON NOT NULL,
    `settlement_lag_days` INTEGER NOT NULL DEFAULT 0,
    `dedupe_key_template` TEXT NULL,

    INDEX `statement_sources_gateway_id_idx`(`gateway_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `manual_instructions` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `rail_id` VARCHAR(191) NOT NULL,
    `instructions_ar` TEXT NOT NULL,
    `instructions_en` TEXT NOT NULL,
    `destination_account_template` TEXT NULL,
    `reference_format` TEXT NULL,
    `proof_upload_allowed` BOOLEAN NOT NULL DEFAULT false,
    `operator_sla_minutes` INTEGER NULL,
    `auto_expiry_minutes` INTEGER NULL,

    UNIQUE INDEX `manual_instructions_rail_id_key`(`rail_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attempt_groups` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `link_id` VARCHAR(191) NOT NULL,
    `customer_fingerprint` CHAR(64) NOT NULL,
    `success_count` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `attempt_groups_link_id_customer_fingerprint_key`(`link_id`, `customer_fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_attempts` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `idempotency_key` VARCHAR(191) NULL,
    `link_id` VARCHAR(191) NOT NULL,
    `attempt_group_id` VARCHAR(191) NOT NULL,
    `application_id` VARCHAR(191) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `rail_id` VARCHAR(191) NOT NULL,
    `route_id` VARCHAR(191) NOT NULL,
    `credential_set_id` VARCHAR(191) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `commission_profile_id` VARCHAR(191) NOT NULL,
    `env` ENUM('SANDBOX', 'LIVE') NOT NULL,
    `mode` VARCHAR(191) NOT NULL,
    `sub_mode` VARCHAR(191) NULL,
    `status` ENUM('CREATED', 'INITIATING', 'AWAITING_CUSTOMER', 'AUTHORIZING', 'VERIFYING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED') NOT NULL DEFAULT 'CREATED',
    `substatus` TEXT NULL,
    `gateway_reference` VARCHAR(191) NULL,
    `provider_reference` VARCHAR(191) NULL,
    `network_reference` VARCHAR(191) NULL,
    `requested_amount` DECIMAL(18, 4) NOT NULL,
    `surcharge_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `total_charged_amount` DECIMAL(18, 4) NOT NULL,
    `gateway_amount_wire` TEXT NULL,
    `settled_amount` DECIMAL(18, 4) NULL,
    `gateway_fee_amount` DECIMAL(18, 4) NULL,
    `platform_commission_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `net_merchant_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `feeBearer` ENUM('MERCHANT_ABSORBS', 'PAYER_SURCHARGE', 'SPLIT') NOT NULL,
    `settlement_target` ENUM('PLATFORM_CLEARING', 'MERCHANT_DIRECT', 'PROVIDER_HELD') NOT NULL DEFAULT 'PLATFORM_CLEARING',
    `currency` CHAR(3) NOT NULL,
    `customer_fields_masked` JSON NOT NULL,
    `public_outputs` JSON NULL,
    `context_ciphertext` TEXT NOT NULL,
    `point_of_no_return` BOOLEAN NOT NULL DEFAULT false,
    `otp_attempts` INTEGER NOT NULL DEFAULT 0,
    `last_otp_sent_at` DATETIME(3) NULL,
    `client_ip` TEXT NULL,
    `user_agent` TEXT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `grace_expires_at` DATETIME(3) NOT NULL,
    `next_check_at` DATETIME(3) NULL,
    `ledger_entry_id` VARCHAR(191) NULL,
    `terminal_at` DATETIME(3) NULL,

    UNIQUE INDEX `payment_attempts_reference_key`(`reference`),
    UNIQUE INDEX `payment_attempts_ledger_entry_id_key`(`ledger_entry_id`),
    INDEX `payment_attempts_link_id_idx`(`link_id`),
    INDEX `payment_attempts_merchant_id_idx`(`merchant_id`),
    INDEX `payment_attempts_status_next_check_at_idx`(`status`, `next_check_at`),
    INDEX `payment_attempts_gateway_version_id_idx`(`gateway_version_id`),
    INDEX `payment_attempts_route_id_status_idx`(`route_id`, `status`),
    UNIQUE INDEX `payment_attempts_link_id_idempotency_key_key`(`link_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attempt_step_logs` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `attempt_id` VARCHAR(191) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `phase` TEXT NOT NULL,
    `step_id` VARCHAR(191) NULL,
    `step_order` INTEGER NOT NULL,
    `redacted_request_json` JSON NOT NULL,
    `redacted_response_text` TEXT NOT NULL,
    `http_status` INTEGER NULL,
    `duration_ms` INTEGER NULL,
    `outcome` TEXT NOT NULL,

    INDEX `attempt_step_logs_attempt_id_idx`(`attempt_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbound_events` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `channel_id` VARCHAR(191) NOT NULL,
    `gateway_id` VARCHAR(191) NOT NULL,
    `env` TEXT NOT NULL,
    `raw_body_bytes` LONGBLOB NOT NULL,
    `redacted_headers_json` JSON NOT NULL,
    `source_ip` TEXT NOT NULL,
    `verified` BOOLEAN NOT NULL,
    `verification_error` TEXT NULL,
    `dedupe_key` CHAR(64) NOT NULL,
    `attempt_id` VARCHAR(191) NULL,
    `received_at` DATETIME(3) NOT NULL,
    `processed_at` DATETIME(3) NULL,
    `processing_result` TEXT NULL,

    INDEX `inbound_events_gateway_id_idx`(`gateway_id`),
    UNIQUE INDEX `inbound_events_channel_id_dedupe_key_key`(`channel_id`, `dedupe_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operator_cases` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `attempt_id` VARCHAR(191) NULL,
    `reconciliation_item_id` VARCHAR(191) NULL,
    `kind` ENUM('UNKNOWN', 'HELD', 'CONFLICT', 'MISMATCH', 'LATE_SUCCESS', 'MANUAL_REVIEW', 'UNMATCHED_STATEMENT') NOT NULL,
    `priority` ENUM('P1', 'P2', 'P3') NOT NULL,
    `sla_due_at` DATETIME(3) NOT NULL,
    `state` ENUM('OPEN', 'IN_PROGRESS', 'PENDING_CHECKER', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `assignee_user_id` VARCHAR(191) NULL,
    `resolution_notes` TEXT NULL,
    `approval_request_id` VARCHAR(191) NULL,

    UNIQUE INDEX `operator_cases_reconciliation_item_id_key`(`reconciliation_item_id`),
    INDEX `operator_cases_state_priority_idx`(`state`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_runs` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `statement_source_id` VARCHAR(191) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `window_end` DATETIME(3) NOT NULL,
    `file_hash` CHAR(64) NOT NULL,
    `stats_json` JSON NOT NULL,
    `file_name` TEXT NULL,
    `file_content` LONGBLOB NULL,
    `ingested_at` DATETIME(3) NULL,

    UNIQUE INDEX `reconciliation_runs_file_hash_key`(`file_hash`),
    INDEX `reconciliation_runs_statement_source_id_idx`(`statement_source_id`),
    INDEX `reconciliation_runs_ingested_at_idx`(`ingested_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `background_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `job_type` ENUM('RECONCILIATION_RUN', 'ADJUSTMENT_EXECUTION') NOT NULL,
    `reference_type` VARCHAR(191) NOT NULL,
    `reference_id` VARCHAR(191) NOT NULL,
    `payload_json` JSON NOT NULL,
    `state` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_at` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `completed_at` DATETIME(3) NULL,

    INDEX `background_jobs_state_available_at_idx`(`state`, `available_at`),
    INDEX `background_jobs_state_locked_at_idx`(`state`, `locked_at`),
    INDEX `background_jobs_reference_type_reference_id_idx`(`reference_type`, `reference_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_items` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `run_id` VARCHAR(191) NOT NULL,
    `attempt_id` VARCHAR(191) NULL,
    `our_reference` TEXT NOT NULL,
    `provider_reference` TEXT NOT NULL,
    `batch_reference` TEXT NULL,
    `statement_amount` DECIMAL(18, 4) NOT NULL,
    `statement_fee` DECIMAL(18, 4) NOT NULL,
    `result` ENUM('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_AT_GATEWAY', 'MISSING_LOCALLY', 'DUPLICATE') NOT NULL,
    `operator_case_id` VARCHAR(191) NULL,

    INDEX `reconciliation_items_run_id_idx`(`run_id`),
    INDEX `reconciliation_items_result_idx`(`result`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_health_samples` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `route_id` VARCHAR(191) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `definitive_failures` INTEGER NOT NULL DEFAULT 0,
    `ambiguous_unknowns` INTEGER NOT NULL DEFAULT 0,
    `rate_limits_429` INTEGER NOT NULL DEFAULT 0,
    `successes` INTEGER NOT NULL DEFAULT 0,
    `p50_ms` INTEGER NULL,
    `p95_ms` INTEGER NULL,
    `p99_ms` INTEGER NULL,

    INDEX `gateway_health_samples_route_id_window_start_idx`(`route_id`, `window_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `detail_change_logs` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `actor_id` VARCHAR(191) NOT NULL,
    `merchant_id` VARCHAR(191) NULL,
    `entity_type` VARCHAR(191) NOT NULL,
    `entity_id` VARCHAR(191) NOT NULL,
    `field_name` TEXT NOT NULL,
    `old_value` TEXT NULL,
    `new_value` TEXT NULL,
    `approval_request_id` VARCHAR(191) NULL,
    `source` ENUM('PORTAL', 'ADMIN', 'API', 'SYSTEM') NOT NULL,
    `request_id` TEXT NOT NULL,
    `client_ip` TEXT NULL,

    INDEX `detail_change_logs_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `actor_id` VARCHAR(191) NOT NULL,
    `role` TEXT NOT NULL,
    `action` TEXT NOT NULL,
    `entity_type` VARCHAR(191) NOT NULL,
    `entity_id` VARCHAR(191) NOT NULL,
    `before_json` JSON NOT NULL,
    `after_json` JSON NOT NULL,
    `approval_request_id` VARCHAR(191) NULL,

    INDEX `audit_log_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_identities` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `kind` ENUM('PHONE', 'EMAIL', 'GOOGLE') NOT NULL,
    `identifier_normalized` VARCHAR(191) NOT NULL,
    `provider_subject` VARCHAR(191) NULL,
    `verified_at` DATETIME(3) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `last_used_at` DATETIME(3) NULL,

    UNIQUE INDEX `user_identities_provider_subject_key`(`provider_subject`),
    INDEX `user_identities_user_id_idx`(`user_id`),
    UNIQUE INDEX `user_identities_kind_identifier_normalized_key`(`kind`, `identifier_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `join_requests` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `submitted_by_user_id` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED', 'PENDING_CHECKER', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED') NOT NULL DEFAULT 'DRAFT',
    `onboarding_channel` ENUM('SELF_SERVICE', 'ADMIN_ASSISTED') NOT NULL,
    `submitted_at` DATETIME(3) NULL,
    `assigned_reviewer_id` VARCHAR(191) NULL,
    `sla_due_at` DATETIME(3) NOT NULL,
    `screening_id` VARCHAR(191) NULL,
    `proposed_risk_tier` ENUM('LOW', 'STANDARD', 'HIGH') NOT NULL DEFAULT 'STANDARD',
    `four_eyes_required` BOOLEAN NOT NULL DEFAULT true,
    `four_eyes_reasons` JSON NULL,
    `decision` TEXT NULL,
    `decision_reason_code` TEXT NULL,
    `decision_notes` TEXT NULL,
    `info_request_json` JSON NULL,
    `resubmission_of_id` VARCHAR(191) NULL,
    `approval_request_id` VARCHAR(191) NULL,

    INDEX `join_requests_merchant_id_idx`(`merchant_id`),
    INDEX `join_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `kyb_documents` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `join_request_id` VARCHAR(191) NULL,
    `subject_type` ENUM('MERCHANT', 'BENEFICIAL_OWNER') NOT NULL,
    `subject_id` VARCHAR(191) NOT NULL,
    `doc_type` ENUM('COMMERCIAL_REGISTRY', 'TAX_CERTIFICATE', 'ARTICLES_OF_ASSOCIATION', 'OWNER_ID', 'SIGNATORY_ID', 'PROOF_OF_ADDRESS', 'BANK_LETTER', 'SECTOR_LICENSE', 'OTHER') NOT NULL,
    `storage_key` TEXT NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `mime` TEXT NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `av_status` ENUM('PENDING', 'CLEAN', 'INFECTED') NOT NULL DEFAULT 'PENDING',
    `status` ENUM('UPLOADED', 'ACCEPTED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'UPLOADED',
    `reviewed_by` VARCHAR(191) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `expires_on` DATE NULL,
    `rejection_reason_code` TEXT NULL,

    INDEX `kyb_documents_merchant_id_idx`(`merchant_id`),
    INDEX `kyb_documents_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `beneficial_owners` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `merchant_id` VARCHAR(191) NOT NULL,
    `full_name_ar` TEXT NOT NULL,
    `full_name_en` TEXT NULL,
    `national_id_ciphertext` TEXT NOT NULL,
    `date_of_birth` DATE NOT NULL,
    `nationality` CHAR(2) NOT NULL,
    `ownership_percent` DECIMAL(5, 2) NULL,
    `role` ENUM('OWNER', 'DIRECTOR', 'SIGNATORY', 'CONTROLLER') NOT NULL,
    `pep_declared` BOOLEAN NOT NULL DEFAULT false,
    `screening_status` ENUM('NOT_SCREENED', 'CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH') NOT NULL DEFAULT 'NOT_SCREENED',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `valid_from` DATETIME(3) NOT NULL,
    `valid_to` DATETIME(3) NULL,

    INDEX `beneficial_owners_merchant_id_idx`(`merchant_id`),
    INDEX `beneficial_owners_screening_status_idx`(`screening_status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `aml_screenings` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `subject_type` ENUM('MERCHANT', 'BENEFICIAL_OWNER', 'END_CLIENT', 'PAYMENT_ATTEMPT') NOT NULL,
    `subject_id` VARCHAR(191) NOT NULL,
    `trigger` ENUM('ONBOARDING', 'PERIODIC', 'LIST_UPDATE', 'OWNER_CHANGE', 'TRANSACTION', 'MANUAL') NOT NULL,
    `provider_code` VARCHAR(191) NOT NULL,
    `provider_request_ref` TEXT NULL,
    `list_versions_json` JSON NOT NULL,
    `input_hash` CHAR(64) NOT NULL,
    `result` ENUM('CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH', 'ERROR') NOT NULL,
    `match_count` INTEGER NOT NULL DEFAULT 0,
    `highest_score` DECIMAL(5, 2) NULL,
    `requested_at` DATETIME(3) NOT NULL,
    `completed_at` DATETIME(3) NULL,

    INDEX `aml_screenings_subject_type_subject_id_idx`(`subject_type`, `subject_id`),
    INDEX `aml_screenings_result_idx`(`result`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `aml_screening_matches` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `screening_id` VARCHAR(191) NOT NULL,
    `list_type` ENUM('SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'INTERNAL_WATCHLIST') NOT NULL,
    `list_name` TEXT NOT NULL,
    `list_entry_ref` TEXT NOT NULL,
    `matched_name` TEXT NOT NULL,
    `score` DECIMAL(5, 2) NOT NULL,
    `attributes_json` JSON NOT NULL,
    `disposition` ENUM('UNREVIEWED', 'FALSE_POSITIVE', 'TRUE_MATCH', 'ESCALATED') NOT NULL DEFAULT 'UNREVIEWED',
    `disposition_by` VARCHAR(191) NULL,
    `disposition_notes` TEXT NULL,
    `suppress_future` BOOLEAN NOT NULL DEFAULT false,
    `suppress_until` DATE NULL,

    INDEX `aml_screening_matches_screening_id_idx`(`screening_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `aml_rules` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` TEXT NOT NULL,
    `rule_type` ENUM('SINGLE_AMOUNT', 'CUMULATIVE_WINDOW', 'STRUCTURING', 'RISK_TIER', 'COUNTERPARTY_COUNTRY', 'RAIL', 'MERCHANT_DIRECT_AMOUNT') NOT NULL,
    `scope` JSON NOT NULL,
    `params` JSON NOT NULL,
    `action` ENUM('HOLD', 'FLAG', 'BLOCK', 'CASE_ONLY') NOT NULL,
    `base_severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `effective_from` DATETIME(3) NOT NULL,
    `effective_to` DATETIME(3) NULL,
    `approval_request_id` VARCHAR(191) NULL,

    UNIQUE INDEX `aml_rules_code_key`(`code`),
    INDEX `aml_rules_active_idx`(`active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reporting_rules` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `authority` VARCHAR(64) NOT NULL DEFAULT 'CBL',
    `report_type` ENUM('LARGE_TRANSACTION', 'SUSPICIOUS_ACTIVITY', 'PERIODIC_RETURN') NOT NULL,
    `threshold_amount` DECIMAL(18, 4) NULL,
    `window_seconds` INTEGER NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'LYD',
    `conditions` JSON NOT NULL,
    `source_reference` TEXT NULL,
    `status` ENUM('PROVISIONAL', 'CONFIRMED') NOT NULL DEFAULT 'PROVISIONAL',
    `effective_from` DATETIME(3) NOT NULL,
    `effective_to` DATETIME(3) NULL,
    `approval_request_id` VARCHAR(191) NULL,

    INDEX `reporting_rules_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `regulatory_reports` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `report_type` ENUM('LARGE_TRANSACTION', 'SUSPICIOUS_ACTIVITY', 'PERIODIC_RETURN') NOT NULL,
    `authority` TEXT NOT NULL,
    `subject_type` TEXT NOT NULL,
    `subject_id` TEXT NOT NULL,
    `aml_case_id` VARCHAR(191) NULL,
    `period_start` DATETIME(3) NULL,
    `period_end` DATETIME(3) NULL,
    `status` ENUM('DRAFT', 'PENDING_CHECKER', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'REJECTED_BY_AUTHORITY') NOT NULL DEFAULT 'DRAFT',
    `payload_ciphertext` TEXT NOT NULL,
    `payload_sha256` CHAR(64) NOT NULL,
    `submission_ref` TEXT NULL,
    `submitted_at` DATETIME(3) NULL,
    `confidential` BOOLEAN NOT NULL DEFAULT true,
    `approval_request_id` VARCHAR(191) NULL,

    UNIQUE INDEX `regulatory_reports_aml_case_id_key`(`aml_case_id`),
    INDEX `regulatory_reports_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `disputes` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `attempt_id` VARCHAR(191) NOT NULL,
    `gateway_id` VARCHAR(191) NOT NULL,
    `rail_id` VARCHAR(191) NOT NULL,
    `external_dispute_ref` VARCHAR(191) NOT NULL,
    `source` ENUM('WEBHOOK', 'STATEMENT', 'MANUAL') NOT NULL,
    `reason_code` TEXT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` ENUM('OPENED', 'EVIDENCE_REQUESTED', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'EXPIRED', 'WITHDRAWN') NOT NULL DEFAULT 'OPENED',
    `opened_at` DATETIME(3) NOT NULL,
    `evidence_due_at` DATETIME(3) NULL,
    `outcome_at` DATETIME(3) NULL,
    `adjustment_id` VARCHAR(191) NULL,
    `evidence_json` JSON NULL,

    INDEX `disputes_attempt_id_idx`(`attempt_id`),
    UNIQUE INDEX `disputes_gateway_id_external_dispute_ref_key`(`gateway_id`, `external_dispute_ref`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_templates` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `channel` ENUM('SMS', 'EMAIL', 'IN_APP') NOT NULL,
    `lang` ENUM('AR', 'EN') NOT NULL,
    `subject_template` TEXT NULL,
    `body_template` TEXT NOT NULL,
    `confidentiality_class` ENUM('PUBLIC', 'MERCHANT', 'INTERNAL') NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `active` BOOLEAN NOT NULL DEFAULT true,

    INDEX `notification_templates_code_idx`(`code`),
    UNIQUE INDEX `notification_templates_code_channel_lang_version_key`(`code`, `channel`, `lang`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `event_id` VARCHAR(191) NOT NULL,
    `recipient_user_id` VARCHAR(191) NULL,
    `recipient_merchant_id` VARCHAR(191) NULL,
    `address_masked` TEXT NOT NULL,
    `address_ciphertext` TEXT NOT NULL,
    `template_code` TEXT NOT NULL,
    `channel` ENUM('SMS', 'EMAIL', 'IN_APP') NOT NULL,
    `lang` ENUM('AR', 'EN') NOT NULL,
    `payload_json` JSON NOT NULL,
    `status` ENUM('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED') NOT NULL DEFAULT 'QUEUED',
    `provider_message_id` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NULL,

    UNIQUE INDEX `notifications_event_id_key`(`event_id`),
    INDEX `notifications_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_settings` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL DEFAULT 'PLATFORM',
    `value_json` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `effective_from` DATETIME(3) NOT NULL,
    `approval_request_id` VARCHAR(191) NULL,

    INDEX `platform_settings_key_scope_idx`(`key`, `scope`),
    UNIQUE INDEX `platform_settings_key_scope_version_key`(`key`, `scope`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `applications` ADD CONSTRAINT `applications_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `applications` ADD CONSTRAINT `applications_assigned_wallet_id_fkey` FOREIGN KEY (`assigned_wallet_id`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallets_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallets_gl_account_id_fkey` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_tokens` ADD CONSTRAINT `access_tokens_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_tokens` ADD CONSTRAINT `access_tokens_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_token_ips` ADD CONSTRAINT `access_token_ips_token_id_fkey` FOREIGN KEY (`token_id`) REFERENCES `access_tokens`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_links` ADD CONSTRAINT `payment_links_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_links` ADD CONSTRAINT `payment_links_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pos_terminals` ADD CONSTRAINT `pos_terminals_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pos_screens` ADD CONSTRAINT `pos_screens_pos_id_fkey` FOREIGN KEY (`pos_id`) REFERENCES `pos_terminals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gl_accounts` ADD CONSTRAINT `gl_accounts_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gl_accounts` ADD CONSTRAINT `gl_accounts_credential_set_id_fkey` FOREIGN KEY (`credential_set_id`) REFERENCES `credential_sets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_lines` ADD CONSTRAINT `journal_lines_entry_id_fkey` FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_lines` ADD CONSTRAINT `journal_lines_gl_account_id_fkey` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_profiles` ADD CONSTRAINT `commission_profiles_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_profiles` ADD CONSTRAINT `commission_profiles_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_profiles` ADD CONSTRAINT `commission_profiles_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `velocity_rules` ADD CONSTRAINT `velocity_rules_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_cases` ADD CONSTRAINT `aml_cases_screening_id_fkey` FOREIGN KEY (`screening_id`) REFERENCES `aml_screenings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_cases` ADD CONSTRAINT `aml_cases_rule_id_fkey` FOREIGN KEY (`rule_id`) REFERENCES `aml_rules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_cases` ADD CONSTRAINT `aml_cases_hold_journal_entry_id_fkey` FOREIGN KEY (`hold_journal_entry_id`) REFERENCES `journal_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_cases` ADD CONSTRAINT `aml_cases_assigned_reviewer_id_fkey` FOREIGN KEY (`assigned_reviewer_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adjustments` ADD CONSTRAINT `adjustments_target_gl_account_id_fkey` FOREIGN KEY (`target_gl_account_id`) REFERENCES `gl_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adjustments` ADD CONSTRAINT `adjustments_source_attempt_id_fkey` FOREIGN KEY (`source_attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adjustments` ADD CONSTRAINT `adjustments_dispute_id_fkey` FOREIGN KEY (`dispute_id`) REFERENCES `disputes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adjustments` ADD CONSTRAINT `adjustments_journal_entry_id_fkey` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cashout_requests` ADD CONSTRAINT `cashout_requests_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cashout_requests` ADD CONSTRAINT `cashout_requests_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cashout_requests` ADD CONSTRAINT `cashout_requests_adjustment_id_fkey` FOREIGN KEY (`adjustment_id`) REFERENCES `adjustments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_maker_user_id_fkey` FOREIGN KEY (`maker_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_checker_user_id_fkey` FOREIGN KEY (`checker_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateways` ADD CONSTRAINT `gateways_active_version_id_fkey` FOREIGN KEY (`active_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_versions` ADD CONSTRAINT `gateway_versions_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_versions` ADD CONSTRAINT `gateway_versions_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_versions` ADD CONSTRAINT `gateway_versions_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_versions` ADD CONSTRAINT `gateway_versions_rollback_version_id_fkey` FOREIGN KEY (`rollback_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_version_evidence` ADD CONSTRAINT `gateway_version_evidence_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_environments` ADD CONSTRAINT `gateway_environments_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_auth` ADD CONSTRAINT `gateway_auth_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_settings` ADD CONSTRAINT `gateway_settings_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credential_sets` ADD CONSTRAINT `credential_sets_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credential_sets` ADD CONSTRAINT `credential_sets_owner_merchant_id_fkey` FOREIGN KEY (`owner_merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rails` ADD CONSTRAINT `rails_logo_asset_id_fkey` FOREIGN KEY (`logo_asset_id`) REFERENCES `assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rail_fields` ADD CONSTRAINT `rail_fields_rail_id_fkey` FOREIGN KEY (`rail_id`) REFERENCES `rails`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rail_routes` ADD CONSTRAINT `rail_routes_rail_id_fkey` FOREIGN KEY (`rail_id`) REFERENCES `rails`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rail_routes` ADD CONSTRAINT `rail_routes_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `crypto_profiles` ADD CONSTRAINT `crypto_profiles_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flows` ADD CONSTRAINT `flows_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flows` ADD CONSTRAINT `flows_rail_id_fkey` FOREIGN KEY (`rail_id`) REFERENCES `rails`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flow_steps` ADD CONSTRAINT `flow_steps_flow_id_fkey` FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `step_parameters` ADD CONSTRAINT `step_parameters_step_id_fkey` FOREIGN KEY (`step_id`) REFERENCES `flow_steps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `step_parameters` ADD CONSTRAINT `step_parameters_crypto_profile_id_fkey` FOREIGN KEY (`crypto_profile_id`) REFERENCES `crypto_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `step_outputs` ADD CONSTRAINT `step_outputs_step_id_fkey` FOREIGN KEY (`step_id`) REFERENCES `flow_steps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `status_rules` ADD CONSTRAINT `status_rules_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `error_maps` ADD CONSTRAINT `error_maps_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `confirmation_channels` ADD CONSTRAINT `confirmation_channels_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `confirmation_channels` ADD CONSTRAINT `confirmation_channels_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `confirmation_channels` ADD CONSTRAINT `confirmation_channels_crypto_profile_id_fkey` FOREIGN KEY (`crypto_profile_id`) REFERENCES `crypto_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `poll_policies` ADD CONSTRAINT `poll_policies_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `widget_definitions` ADD CONSTRAINT `widget_definitions_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `redirect_definitions` ADD CONSTRAINT `redirect_definitions_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `statement_sources` ADD CONSTRAINT `statement_sources_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `manual_instructions` ADD CONSTRAINT `manual_instructions_rail_id_fkey` FOREIGN KEY (`rail_id`) REFERENCES `rails`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attempt_groups` ADD CONSTRAINT `attempt_groups_link_id_fkey` FOREIGN KEY (`link_id`) REFERENCES `payment_links`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_link_id_fkey` FOREIGN KEY (`link_id`) REFERENCES `payment_links`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_attempt_group_id_fkey` FOREIGN KEY (`attempt_group_id`) REFERENCES `attempt_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_rail_id_fkey` FOREIGN KEY (`rail_id`) REFERENCES `rails`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_credential_set_id_fkey` FOREIGN KEY (`credential_set_id`) REFERENCES `credential_sets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_commission_profile_id_fkey` FOREIGN KEY (`commission_profile_id`) REFERENCES `commission_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_ledger_entry_id_fkey` FOREIGN KEY (`ledger_entry_id`) REFERENCES `journal_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attempt_step_logs` ADD CONSTRAINT `attempt_step_logs_attempt_id_fkey` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attempt_step_logs` ADD CONSTRAINT `attempt_step_logs_gateway_version_id_fkey` FOREIGN KEY (`gateway_version_id`) REFERENCES `gateway_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attempt_step_logs` ADD CONSTRAINT `attempt_step_logs_step_id_fkey` FOREIGN KEY (`step_id`) REFERENCES `flow_steps`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inbound_events` ADD CONSTRAINT `inbound_events_channel_id_fkey` FOREIGN KEY (`channel_id`) REFERENCES `confirmation_channels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inbound_events` ADD CONSTRAINT `inbound_events_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inbound_events` ADD CONSTRAINT `inbound_events_attempt_id_fkey` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operator_cases` ADD CONSTRAINT `operator_cases_attempt_id_fkey` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operator_cases` ADD CONSTRAINT `operator_cases_reconciliation_item_id_fkey` FOREIGN KEY (`reconciliation_item_id`) REFERENCES `reconciliation_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operator_cases` ADD CONSTRAINT `operator_cases_assignee_user_id_fkey` FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operator_cases` ADD CONSTRAINT `operator_cases_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reconciliation_runs` ADD CONSTRAINT `reconciliation_runs_statement_source_id_fkey` FOREIGN KEY (`statement_source_id`) REFERENCES `statement_sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reconciliation_items` ADD CONSTRAINT `reconciliation_items_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `reconciliation_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reconciliation_items` ADD CONSTRAINT `reconciliation_items_attempt_id_fkey` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_health_samples` ADD CONSTRAINT `gateway_health_samples_route_id_fkey` FOREIGN KEY (`route_id`) REFERENCES `rail_routes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `detail_change_logs` ADD CONSTRAINT `detail_change_logs_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `detail_change_logs` ADD CONSTRAINT `detail_change_logs_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `detail_change_logs` ADD CONSTRAINT `detail_change_logs_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_identities` ADD CONSTRAINT `user_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `join_requests` ADD CONSTRAINT `join_requests_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `join_requests` ADD CONSTRAINT `join_requests_submitted_by_user_id_fkey` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `join_requests` ADD CONSTRAINT `join_requests_assigned_reviewer_id_fkey` FOREIGN KEY (`assigned_reviewer_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `join_requests` ADD CONSTRAINT `join_requests_screening_id_fkey` FOREIGN KEY (`screening_id`) REFERENCES `aml_screenings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `join_requests` ADD CONSTRAINT `join_requests_resubmission_of_id_fkey` FOREIGN KEY (`resubmission_of_id`) REFERENCES `join_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `join_requests` ADD CONSTRAINT `join_requests_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `kyb_documents` ADD CONSTRAINT `kyb_documents_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `kyb_documents` ADD CONSTRAINT `kyb_documents_join_request_id_fkey` FOREIGN KEY (`join_request_id`) REFERENCES `join_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `kyb_documents` ADD CONSTRAINT `kyb_documents_reviewed_by_fkey` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `beneficial_owners` ADD CONSTRAINT `beneficial_owners_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_screening_matches` ADD CONSTRAINT `aml_screening_matches_screening_id_fkey` FOREIGN KEY (`screening_id`) REFERENCES `aml_screenings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_screening_matches` ADD CONSTRAINT `aml_screening_matches_disposition_by_fkey` FOREIGN KEY (`disposition_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aml_rules` ADD CONSTRAINT `aml_rules_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reporting_rules` ADD CONSTRAINT `reporting_rules_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `regulatory_reports` ADD CONSTRAINT `regulatory_reports_aml_case_id_fkey` FOREIGN KEY (`aml_case_id`) REFERENCES `aml_cases`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `regulatory_reports` ADD CONSTRAINT `regulatory_reports_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `disputes_attempt_id_fkey` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `disputes_gateway_id_fkey` FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `disputes_rail_id_fkey` FOREIGN KEY (`rail_id`) REFERENCES `rails`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_recipient_user_id_fkey` FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_recipient_merchant_id_fkey` FOREIGN KEY (`recipient_merchant_id`) REFERENCES `merchants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `platform_settings` ADD CONSTRAINT `platform_settings_approval_request_id_fkey` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
-- Schema version support (single-row table managed outside the Prisma datamodel).
CREATE TABLE IF NOT EXISTS `schema_versions` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `version` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `schema_versions_pkey` PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `schema_versions` (`id`, `version`) VALUES (1, 5)
ON DUPLICATE KEY UPDATE `version` = VALUES(`version`);

-- Domain invariants that the Prisma datamodel cannot express.
ALTER TABLE `journal_lines` ADD CONSTRAINT `journal_lines_amount_positive` CHECK (`amount` > 0);

ALTER TABLE `attempt_groups` ADD CONSTRAINT `attempt_groups_single_success` CHECK (`success_count` <= 1);

-- MariaDB forbids a CHECK constraint on a column that is part of a foreign
-- key, so the maker != checker invariant is enforced by a trigger instead.
DROP TRIGGER IF EXISTS `approval_requests_checker_not_maker`;
CREATE TRIGGER `approval_requests_checker_not_maker` BEFORE INSERT ON `approval_requests`
FOR EACH ROW
BEGIN
    IF NEW.`checker_user_id` IS NOT NULL AND NEW.`checker_user_id` = NEW.`maker_user_id` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checker_user_id must differ from maker_user_id';
    END IF;
END;

ALTER TABLE `payment_links` ADD CONSTRAINT `payment_links_slot_reservation_invariant` CHECK (`infinite_use` = true OR (`confirmed_count` + `active_locked_count`) <= `use_count`);
