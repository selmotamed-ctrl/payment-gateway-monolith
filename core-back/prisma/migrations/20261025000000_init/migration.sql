-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KybStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('LOW', 'STANDARD', 'HIGH');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('GATEWAY_ADMIN', 'SECURITY_ADMIN', 'FINANCE', 'OPERATOR', 'COMPLIANCE', 'MLRO', 'SUPPORT', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'MERCHANT_CASHIER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('PENDING', 'ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "FeeBearer" AS ENUM ('MERCHANT_ABSORBS', 'PAYER_SURCHARGE', 'SPLIT');

-- CreateEnum
CREATE TYPE "PaymentLinkState" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PosStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "GlAccountType" AS ENUM ('TREASURY', 'GATEWAY_CLEARING', 'MERCHANT_WALLET', 'PLATFORM_INCOME', 'PROVIDER_FEE_EXPENSE', 'GATEWAY_FEE_EXPENSE', 'GATEWAY_FEE_ACCRUAL', 'COMMISSION_RECEIVABLE', 'AML_HOLD', 'CHARGEBACK_RESERVE', 'SUSPENSE');

-- CreateEnum
CREATE TYPE "JournalRefType" AS ENUM ('PAYMENT_ATTEMPT', 'ADJUSTMENT', 'AML_RELEASE', 'AML_VOID', 'SETTLEMENT_SWEEP', 'FEE_VARIANCE', 'COMMISSION_NETTING', 'DISPUTE_OUTCOME');

-- CreateEnum
CREATE TYPE "JournalDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "CommissionCalcType" AS ENUM ('FLAT', 'PERCENTAGE', 'TIERED', 'HYBRID');

-- CreateEnum
CREATE TYPE "VelocityScopeType" AS ENUM ('END_CLIENT_IP', 'END_CLIENT_PHONE', 'END_CLIENT_CARD', 'MERCHANT', 'APPLICATION', 'RAIL', 'LINK');

-- CreateEnum
CREATE TYPE "VelocityAction" AS ENUM ('REJECT', 'FLAG');

-- CreateEnum
CREATE TYPE "AmlSubjectType" AS ENUM ('MERCHANT', 'END_CLIENT', 'PAYMENT_ATTEMPT', 'BENEFICIAL_OWNER');

-- CreateEnum
CREATE TYPE "AmlSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AmlCaseStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'PENDING_CHECKER', 'RELEASED', 'REJECTED_VOID', 'FROZEN', 'ESCALATED_STR');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('CHARGEBACK', 'REFUND', 'MANUAL_CREDIT', 'MANUAL_DEBIT', 'CORRECTION', 'CASHOUT_SUBTRACTION');

-- CreateEnum
CREATE TYPE "AdjustmentState" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'EXECUTING', 'EXECUTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CashoutState" AS ENUM ('PENDING', 'REJECTED', 'PROCESSING', 'COMPLETE', 'SUBTRACTED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('STANDARD', 'EMERGENCY_RATIFICATION');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'EXECUTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GatewayKind" AS ENUM ('DIRECT', 'AGGREGATOR', 'NATIVE_ADAPTER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "GatewayStatus" AS ENUM ('DRAFT', 'SANDBOX_VERIFIED', 'PENDING_APPROVAL', 'LIVE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "GatewayVerificationState" AS ENUM ('VERIFIED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "GatewayRiskClass" AS ENUM ('NORMAL', 'HIGH_RISK');

-- CreateEnum
CREATE TYPE "GatewayEnvironmentType" AS ENUM ('SANDBOX', 'LIVE');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('NONE', 'API_KEY', 'PERMANENT_TOKEN', 'TOKEN_ENDPOINT', 'REFRESH_TOKEN', 'USERNAME_PASSWORD', 'BASIC', 'REQUEST_SIGNATURE', 'OAUTH2_CLIENT_CREDENTIALS', 'MUTUAL_TLS');

-- CreateEnum
CREATE TYPE "AuthApply" AS ENUM ('HEADER', 'QUERY', 'BODY');

-- CreateEnum
CREATE TYPE "CredentialOwnerType" AS ENUM ('PLATFORM', 'MERCHANT');

-- CreateEnum
CREATE TYPE "SettlementTarget" AS ENUM ('PLATFORM_CLEARING', 'MERCHANT_DIRECT', 'PROVIDER_HELD');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('UNTESTED', 'VERIFIED', 'FAILING', 'REVOKED');

-- CreateEnum
CREATE TYPE "AssetMime" AS ENUM ('IMAGE_PNG', 'IMAGE_SVG_XML');

-- CreateEnum
CREATE TYPE "CollectionMode" AS ENUM ('OTP_PULL', 'REDIRECT', 'EMBEDDED', 'PUSH_APPROVAL', 'QR_DISPLAY', 'PAY_CODE', 'DEEP_LINK', 'MANUAL', 'HYBRID');

-- CreateEnum
CREATE TYPE "RailFieldType" AS ENUM ('PHONE', 'NUMBER', 'STRING', 'OTP', 'BIRTH_YEAR', 'CARD_NUMBER', 'PAN', 'WALLET_ID', 'FROM_LIST');

-- CreateEnum
CREATE TYPE "ChecksumType" AS ENUM ('NONE', 'LUHN');

-- CreateEnum
CREATE TYPE "RailFieldSensitivity" AS ENUM ('NORMAL', 'SENSITIVE', 'PAN');

-- CreateEnum
CREATE TYPE "CredentialPolicy" AS ENUM ('PLATFORM', 'MERCHANT_REQUIRED', 'MERCHANT_OR_PLATFORM');

-- CreateEnum
CREATE TYPE "RoutingStrategy" AS ENUM ('EFFECTIVE_COST', 'STRICT_PRIORITY', 'WEIGHTED');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DRAINING');

-- CreateEnum
CREATE TYPE "HealthState" AS ENUM ('HEALTHY', 'DEGRADED', 'OPEN_BREAKER');

-- CreateEnum
CREATE TYPE "CryptoPurpose" AS ENUM ('OUTBOUND_SIGN', 'INBOUND_VERIFY');

-- CreateEnum
CREATE TYPE "CryptoAlgorithm" AS ENUM ('HMAC_SHA256', 'HMAC_SHA512', 'RSA_SHA256', 'SHA256');

-- CreateEnum
CREATE TYPE "SecretKeyEncoding" AS ENUM ('UTF8', 'HEX', 'BASE64');

-- CreateEnum
CREATE TYPE "CanonicalizationMode" AS ENUM ('SORTED_KEY_VALUE_AMP', 'SORTED_VALUES_HASH', 'TEMPLATE_STRING', 'JSON_CANONICAL', 'RAW_BODY', 'TIMESTAMP_DOT_RAW_BODY');

-- CreateEnum
CREATE TYPE "OutputEncoding" AS ENUM ('HEX_LOWER', 'HEX_UPPER', 'BASE64');

-- CreateEnum
CREATE TYPE "FlowPhase" AS ENUM ('CREDENTIAL_CHECK', 'PRE_INITIATE', 'INITIATE', 'SUBMIT', 'VERIFY', 'CANCEL', 'REFUND', 'VOID', 'CAPTURE', 'SETTLEMENT_FETCH');

-- CreateEnum
CREATE TYPE "FlowStepType" AS ENUM ('HTTP', 'COMPUTE', 'RENDER', 'WAIT', 'ASSERT', 'BRANCH');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('APPLICATION_JSON', 'APPLICATION_FORM_URLENCODED', 'MULTIPART_FORM_DATA', 'APPLICATION_XML', 'TEXT_XML', 'TEXT_PLAIN');

-- CreateEnum
CREATE TYPE "SideEffect" AS ENUM ('READ_ONLY', 'SENDS_NOTIFICATION', 'MOVES_MONEY');

-- CreateEnum
CREATE TYPE "RetryPolicy" AS ENUM ('SAFE', 'SAFE_WITH_COOLDOWN', 'NEVER');

-- CreateEnum
CREATE TYPE "StepParameterPlace" AS ENUM ('HEADERS', 'QUERY', 'PATH', 'BODY', 'FORM', 'MULTIPART', 'XML');

-- CreateEnum
CREATE TYPE "StepParameterSource" AS ENUM ('GATEWAY_META', 'ROUTE_META', 'CREDENTIAL', 'ATTEMPT', 'CUSTOMER_FIELD', 'STATE', 'PREVIOUS_RESPONSE', 'URLS', 'CLIENT_CONTEXT', 'CONSTANT', 'NOW', 'RANDOM', 'COMPUTED', 'CRYPTO_SIGNATURE');

-- CreateEnum
CREATE TYPE "StepOutputStoreAs" AS ENUM ('STATE', 'PUBLIC', 'SETTLED_AMOUNT', 'PROVIDER_FEE', 'PROVIDER_REF', 'NETWORK_REF');

-- CreateEnum
CREATE TYPE "StatusRuleOp" AS ENUM ('EQUALS', 'NOT_EQUALS', 'IN', 'EXISTS', 'MATCHES');

-- CreateEnum
CREATE TYPE "CanonicalStatus" AS ENUM ('AWAITING_CUSTOMER', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ErrorClassification" AS ENUM ('RETRYABLE_OTP', 'TERMINAL_DECLINE', 'LIMIT_EXCEEDED', 'GATEWAY_FAULT', 'AMBIGUOUS');

-- CreateEnum
CREATE TYPE "ConfirmationChannelType" AS ENUM ('WEBHOOK', 'RETURN_URL', 'BROWSER_CALLBACK', 'POLL', 'STATEMENT', 'OPERATOR');

-- CreateEnum
CREATE TYPE "VerifyMethod" AS ENUM ('HMAC_BODY', 'HASH_FIELDS', 'SORTED_VALUES_HASH', 'RSA', 'SHARED_TOKEN', 'IP_ONLY', 'NONE_PLUS_INQUIRY');

-- CreateEnum
CREATE TYPE "BodyFormat" AS ENUM ('JSON', 'FORM', 'XML');

-- CreateEnum
CREATE TYPE "WidgetKind" AS ENUM ('LIGHTBOX', 'IFRAME', 'SDK_WEBVIEW', 'NATIVE_ANDROID');

-- CreateEnum
CREATE TYPE "RedirectMethod" AS ENUM ('GET', 'POST_FORM');

-- CreateEnum
CREATE TYPE "RedirectTarget" AS ENUM ('SAME_WINDOW', 'NEW_TAB', 'TOP_FRAME');

-- CreateEnum
CREATE TYPE "ReturnMethod" AS ENUM ('GET', 'POST');

-- CreateEnum
CREATE TYPE "StatementSourceType" AS ENUM ('API', 'SFTP', 'UPLOAD');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('CREATED', 'INITIATING', 'AWAITING_CUSTOMER', 'AUTHORIZING', 'VERIFYING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "OperatorCaseKind" AS ENUM ('UNKNOWN', 'HELD', 'CONFLICT', 'MISMATCH', 'LATE_SUCCESS', 'MANUAL_REVIEW', 'UNMATCHED_STATEMENT');

-- CreateEnum
CREATE TYPE "OperatorCasePriority" AS ENUM ('P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "OperatorCaseState" AS ENUM ('OPEN', 'IN_PROGRESS', 'PENDING_CHECKER', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReconciliationResult" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_AT_GATEWAY', 'MISSING_LOCALLY', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "DetailChangeSource" AS ENUM ('PORTAL', 'ADMIN', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "IdentityKind" AS ENUM ('PHONE', 'EMAIL', 'GOOGLE');

-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED', 'PENDING_CHECKER', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OnboardingChannel" AS ENUM ('SELF_SERVICE', 'ADMIN_ASSISTED');

-- CreateEnum
CREATE TYPE "KybSubjectType" AS ENUM ('MERCHANT', 'BENEFICIAL_OWNER');

-- CreateEnum
CREATE TYPE "KybDocumentType" AS ENUM ('COMMERCIAL_REGISTRY', 'TAX_CERTIFICATE', 'ARTICLES_OF_ASSOCIATION', 'OWNER_ID', 'SIGNATORY_ID', 'PROOF_OF_ADDRESS', 'BANK_LETTER', 'SECTOR_LICENSE', 'OTHER');

-- CreateEnum
CREATE TYPE "AvStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "KybDocumentStatus" AS ENUM ('UPLOADED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BeneficialOwnerRole" AS ENUM ('OWNER', 'DIRECTOR', 'SIGNATORY', 'CONTROLLER');

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('NOT_SCREENED', 'CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH');

-- CreateEnum
CREATE TYPE "AmlScreeningSubjectType" AS ENUM ('MERCHANT', 'BENEFICIAL_OWNER', 'END_CLIENT', 'PAYMENT_ATTEMPT');

-- CreateEnum
CREATE TYPE "AmlScreeningTrigger" AS ENUM ('ONBOARDING', 'PERIODIC', 'LIST_UPDATE', 'OWNER_CHANGE', 'TRANSACTION', 'MANUAL');

-- CreateEnum
CREATE TYPE "AmlScreeningResult" AS ENUM ('CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH', 'ERROR');

-- CreateEnum
CREATE TYPE "AmlMatchListType" AS ENUM ('SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'INTERNAL_WATCHLIST');

-- CreateEnum
CREATE TYPE "AmlMatchDisposition" AS ENUM ('UNREVIEWED', 'FALSE_POSITIVE', 'TRUE_MATCH', 'ESCALATED');

-- CreateEnum
CREATE TYPE "AmlRuleType" AS ENUM ('SINGLE_AMOUNT', 'CUMULATIVE_WINDOW', 'STRUCTURING', 'RISK_TIER', 'COUNTERPARTY_COUNTRY', 'RAIL', 'MERCHANT_DIRECT_AMOUNT');

-- CreateEnum
CREATE TYPE "AmlRuleAction" AS ENUM ('HOLD', 'FLAG', 'BLOCK', 'CASE_ONLY');

-- CreateEnum
CREATE TYPE "AmlBaseSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReportingType" AS ENUM ('LARGE_TRANSACTION', 'SUSPICIOUS_ACTIVITY', 'PERIODIC_RETURN');

-- CreateEnum
CREATE TYPE "ReportingRuleStatus" AS ENUM ('PROVISIONAL', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "RegulatoryReportStatus" AS ENUM ('DRAFT', 'PENDING_CHECKER', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'REJECTED_BY_AUTHORITY');

-- CreateEnum
CREATE TYPE "DisputeSource" AS ENUM ('WEBHOOK', 'STATEMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPENED', 'EVIDENCE_REQUESTED', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationLang" AS ENUM ('AR', 'EN');

-- CreateEnum
CREATE TYPE "ConfidentialityClass" AS ENUM ('PUBLIC', 'MERCHANT', 'INTERNAL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "PlatformSettingScope" AS ENUM ('PLATFORM');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT NOT NULL,
    "taxId" TEXT,
    "registrationNo" TEXT,
    "businessCategory" TEXT,
    "status" "MerchantStatus" NOT NULL DEFAULT 'PENDING',
    "kybStatus" "KybStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "riskTier" "RiskTier" NOT NULL DEFAULT 'STANDARD',
    "onboardingChannel" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspensionReasonCode" TEXT,
    "closedAt" TIMESTAMP(3),
    "commissionReceivableCeiling" DECIMAL(18,4),
    "negativeBalanceCeiling" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "payoutBankDetailsJson" JSONB,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "role" "UserRole" NOT NULL,
    "authorities_map" JSONB NOT NULL,
    "app_scope_ids" JSONB,
    "is_maker" BOOLEAN NOT NULL DEFAULT false,
    "is_checker" BOOLEAN NOT NULL DEFAULT false,
    "mfa_required" BOOLEAN NOT NULL DEFAULT true,
    "mfa_secret_ciphertext" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessUseDescription" TEXT,
    "expectedMonthlyVolume" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "assigned_wallet_id" TEXT NOT NULL,
    "rail_whitelist" JSONB,
    "redirect_domain_allowlist" JSONB,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "gl_account_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'LYD',
    "status" "WalletStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_tokens" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "last_four" CHAR(4) NOT NULL,
    "scopes" JSONB NOT NULL,
    "ip_whitelist_enabled" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_token_ips" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "token_id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,

    CONSTRAINT "access_token_ips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "key" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fee_bearer" "FeeBearer" NOT NULL,
    "split_ratio_json" JSONB,
    "infinite_use" BOOLEAN NOT NULL DEFAULT false,
    "use_count" INTEGER NOT NULL DEFAULT 1,
    "confirmed_count" INTEGER NOT NULL DEFAULT 0,
    "active_locked_count" INTEGER NOT NULL DEFAULT 0,
    "redirect_url" TEXT,
    "rail_whitelist" JSONB,
    "state" "PaymentLinkState" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_terminals" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "status" "PosStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "pos_terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_screens" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "pos_id" TEXT NOT NULL,
    "screen_code" TEXT NOT NULL,
    "auth_token_hash" CHAR(64) NOT NULL,
    "realtime_room_id" TEXT,
    "last_active_at" TIMESTAMP(3),

    CONSTRAINT "pos_screens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gl_accounts" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "account_type" "GlAccountType" NOT NULL,
    "owner_id" TEXT,
    "gateway_id" TEXT,
    "credential_set_id" TEXT,
    "env" TEXT,
    "currency" CHAR(3) NOT NULL,
    "last_checkpoint_id" TEXT,
    "checkpoint_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "checkpoint_at" TIMESTAMP(3),
    "seed_key" TEXT,

    CONSTRAINT "gl_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ref_type" "JournalRefType" NOT NULL,
    "ref_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "entry_id" TEXT NOT NULL,
    "gl_account_id" TEXT NOT NULL,
    "direction" "JournalDirection" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_profiles" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT,
    "application_id" TEXT,
    "rail_code" TEXT NOT NULL,
    "calc_type" "CommissionCalcType" NOT NULL,
    "flat_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "percentage_rate" DECIMAL(8,6) NOT NULL DEFAULT 0,
    "tiers_json" JSONB,
    "min_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "max_fee" DECIMAL(18,4),
    "fee_bearer_default" "FeeBearer" NOT NULL,
    "rounding_mode" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "approval_request_id" TEXT,
    "seed_key" TEXT,

    CONSTRAINT "commission_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "velocity_rules" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "scope_type" "VelocityScopeType" NOT NULL,
    "scope_value" TEXT,
    "window_seconds" INTEGER NOT NULL,
    "max_count" INTEGER NOT NULL,
    "max_amount" DECIMAL(18,4),
    "action" "VelocityAction" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "approval_request_id" TEXT,

    CONSTRAINT "velocity_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_cases" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "subject_type" "AmlSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "trigger_reason" TEXT NOT NULL,
    "severity" "AmlSeverity" NOT NULL,
    "severity_inputs_json" JSONB NOT NULL,
    "screening_id" TEXT,
    "rule_id" TEXT,
    "rule_version" INTEGER,
    "hold_journal_entry_id" TEXT,
    "status" "AmlCaseStatus" NOT NULL DEFAULT 'OPEN',
    "sla_due_at" TIMESTAMP(3),
    "assigned_reviewer_id" TEXT,
    "regulatory_report_id" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "reviewer_notes" TEXT,

    CONSTRAINT "aml_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustments" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "target_gl_account_id" TEXT NOT NULL,
    "source_attempt_id" TEXT,
    "dispute_id" TEXT,
    "drafted_by_system" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(18,4) NOT NULL,
    "reverse_commission" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "external_dispute_ref" TEXT,
    "provider_refund_ref" TEXT,
    "state" "AdjustmentState" NOT NULL DEFAULT 'DRAFT',
    "journal_entry_id" TEXT,

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashout_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "destination_bank_json" JSONB NOT NULL,
    "state" "CashoutState" NOT NULL DEFAULT 'PENDING',
    "adjustment_id" TEXT,

    CONSTRAINT "cashout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "payload_diff_json" JSONB NOT NULL,
    "mode" "ApprovalMode" NOT NULL DEFAULT 'STANDARD',
    "base_version" INTEGER,
    "expires_at" TIMESTAMP(3),
    "ratify_due_at" TIMESTAMP(3),
    "maker_user_id" TEXT NOT NULL,
    "checker_user_id" TEXT,
    "state" "ApprovalState" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "risk_acceptance_note" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateways" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL DEFAULT 'LY',
    "aliases" JSONB NOT NULL,
    "kind" "GatewayKind" NOT NULL,
    "status" "GatewayStatus" NOT NULL DEFAULT 'DRAFT',
    "active_version_id" TEXT,
    "verificationState" "GatewayVerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "riskClass" "GatewayRiskClass" NOT NULL DEFAULT 'NORMAL',
    "metadata" JSONB,

    CONSTRAINT "gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_versions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot_ciphertext" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "state" "GatewayStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT NOT NULL,
    "approval_request_id" TEXT,
    "change_note" TEXT,
    "rollback_version_id" TEXT,

    CONSTRAINT "gateway_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_environments" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "env" "GatewayEnvironmentType" NOT NULL,
    "base_urls" JSONB NOT NULL,
    "allowed_hosts" JSONB NOT NULL,
    "inbound_ip_allowlist" JSONB NOT NULL,
    "outbound_egress_ips" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "gateway_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_auth" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "method" "AuthMethod" NOT NULL,
    "auth_apply" "AuthApply" NOT NULL,
    "refresh_config_json" JSONB,

    CONSTRAINT "gateway_auth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_settings" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "amount_scale" INTEGER NOT NULL,
    "amount_precision" INTEGER NOT NULL,
    "amount_rounding" TEXT NOT NULL,
    "amount_format" TEXT NOT NULL,
    "reference_format" JSONB NOT NULL,
    "session_ttl_seconds" INTEGER NOT NULL,
    "otp_ttl_seconds" INTEGER NOT NULL,
    "otp_resend_cooldown_seconds" INTEGER NOT NULL,
    "max_otp_attempts" INTEGER NOT NULL DEFAULT 3,
    "supports_status_check" BOOLEAN NOT NULL DEFAULT false,
    "status_check_min_age_seconds" INTEGER,
    "supports_idempotency_key" BOOLEAN NOT NULL DEFAULT false,
    "supports_cancel" BOOLEAN NOT NULL DEFAULT false,
    "rate_limit_per_second" INTEGER,
    "concurrency_cap" INTEGER,
    "timeout_ms" INTEGER NOT NULL DEFAULT 15000,
    "max_response_bytes" INTEGER NOT NULL DEFAULT 2097152,
    "gateway_timezone" TEXT NOT NULL DEFAULT 'Africa/Tripoli',

    CONSTRAINT "gateway_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_sets" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "env" "GatewayEnvironmentType" NOT NULL,
    "owner_type" "CredentialOwnerType" NOT NULL,
    "owner_merchant_id" TEXT,
    "external_merchant_id" TEXT,
    "settlement_target" "SettlementTarget" NOT NULL,
    "entries_ciphertext" JSONB NOT NULL,
    "mtls_cert_ciphertext" TEXT,
    "status" "CredentialStatus" NOT NULL DEFAULT 'UNTESTED',
    "last_verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "credential_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "mime" "AssetMime" NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rails" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "logo_asset_id" TEXT,
    "collection_mode" "CollectionMode" NOT NULL,
    "sub_modes" JSONB,
    "currency" CHAR(3) NOT NULL DEFAULT 'LYD',
    "min_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "max_amount" DECIMAL(18,4),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB NOT NULL,
    "refund_window_days" INTEGER,
    "instructions_ar" TEXT,
    "instructions_en" TEXT,
    "metadata" JSONB,

    CONSTRAINT "rails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rail_fields" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "rail_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "RailFieldType" NOT NULL,
    "checksum" "ChecksumType" NOT NULL DEFAULT 'NONE',
    "label_ar" TEXT NOT NULL,
    "label_en" TEXT NOT NULL,
    "placeholder_ar" TEXT,
    "placeholder_en" TEXT,
    "regex" TEXT,
    "min_length" INTEGER,
    "max_length" INTEGER,
    "min_val" DECIMAL(18,4),
    "max_val" DECIMAL(18,4),
    "options_json" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "order_index" INTEGER NOT NULL,
    "sensitivity" "RailFieldSensitivity" NOT NULL DEFAULT 'NORMAL',
    "normalizer" JSONB,

    CONSTRAINT "rail_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rail_routes" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "rail_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "credential_policy" "CredentialPolicy" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "routing_strategy" "RoutingStrategy" NOT NULL DEFAULT 'EFFECTIVE_COST',
    "weight" INTEGER NOT NULL DEFAULT 100,
    "cost_model" JSONB NOT NULL,
    "mismatch_policy" JSONB NOT NULL,
    "min_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "max_amount" DECIMAL(18,4),
    "daily_cap_amount" DECIMAL(18,4),
    "status" "RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "health_state" "HealthState" NOT NULL DEFAULT 'HEALTHY',
    "maintenance_windows" JSONB,
    "scope" JSONB NOT NULL,

    CONSTRAINT "rail_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crypto_profiles" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "CryptoPurpose" NOT NULL,
    "algorithm" "CryptoAlgorithm" NOT NULL,
    "secret_key_ref" TEXT,
    "secret_key_encoding" "SecretKeyEncoding" NOT NULL,
    "canonicalization_mode" "CanonicalizationMode" NOT NULL,
    "template_string" TEXT,
    "included_fields" JSONB NOT NULL,
    "excluded_fields" JSONB NOT NULL,
    "output_encoding" "OutputEncoding" NOT NULL,

    CONSTRAINT "crypto_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flows" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "rail_id" TEXT,
    "sub_mode" TEXT,
    "phase" "FlowPhase" NOT NULL,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_steps" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "flow_id" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "type" "FlowStepType" NOT NULL,
    "method" TEXT,
    "url_template" TEXT,
    "content_type" "ContentType",
    "xml_template" TEXT,
    "timeout_ms" INTEGER,
    "success_check" JSONB,
    "sideEffect" "SideEffect" NOT NULL,
    "retry_policy" "RetryPolicy" NOT NULL,
    "idempotency_config" JSONB NOT NULL,
    "point_of_no_return" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "flow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_parameters" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "step_id" TEXT NOT NULL,
    "place" "StepParameterPlace" NOT NULL,
    "key" TEXT NOT NULL,
    "source" "StepParameterSource" NOT NULL,
    "selector" TEXT,
    "constant_value" TEXT,
    "crypto_profile_id" TEXT,
    "transforms" JSONB NOT NULL,

    CONSTRAINT "step_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_outputs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "step_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "selector" TEXT,
    "transforms" JSONB NOT NULL,
    "store_as" "StepOutputStoreAs" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "step_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_rules" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "selector" TEXT NOT NULL,
    "op" "StatusRuleOp" NOT NULL,
    "value_json" JSONB NOT NULL,
    "canonical_status" "CanonicalStatus" NOT NULL,
    "canonical_substatus" TEXT,
    "canonical_error" TEXT,

    CONSTRAINT "status_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_maps" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "gateway_code" TEXT NOT NULL,
    "canonical_error" TEXT NOT NULL,
    "classification" "ErrorClassification" NOT NULL,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "counts_toward_lockout" BOOLEAN NOT NULL DEFAULT false,
    "counts_toward_breaker" BOOLEAN NOT NULL DEFAULT false,
    "customer_message_ar" TEXT,
    "customer_message_en" TEXT,
    "operator_hint" TEXT,

    CONSTRAINT "error_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "confirmation_channels" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "route_id" TEXT,
    "type" "ConfirmationChannelType" NOT NULL,
    "path_token" TEXT NOT NULL,
    "crypto_profile_id" TEXT,
    "verify_method" "VerifyMethod" NOT NULL,
    "signature_header" TEXT,
    "timestamp_selector" TEXT,
    "timestamp_tolerance_sec" INTEGER NOT NULL DEFAULT 300,
    "ip_allowlist" JSONB,
    "body_format" "BodyFormat" NOT NULL,
    "correlation_selector" TEXT,
    "dedupe_key_selector" TEXT,
    "event_map" JSONB NOT NULL,
    "must_inquire" BOOLEAN NOT NULL DEFAULT false,
    "ack_status" INTEGER NOT NULL DEFAULT 200,
    "ack_body_template" TEXT,

    CONSTRAINT "confirmation_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_policies" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "route_id" TEXT NOT NULL,
    "first_after_seconds" INTEGER NOT NULL DEFAULT 5,
    "backoff_seconds" JSONB NOT NULL,
    "max_duration_seconds" INTEGER NOT NULL DEFAULT 900,
    "stop_on_states" JSONB NOT NULL,

    CONSTRAINT "poll_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_definitions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "route_id" TEXT NOT NULL,
    "kind" "WidgetKind" NOT NULL,
    "sdk_driver" TEXT,
    "script_urls" JSONB NOT NULL,
    "script_sri_hashes" JSONB NOT NULL,
    "config_template" JSONB NOT NULL,
    "callbacks_map" JSONB NOT NULL,
    "allowed_origins" JSONB NOT NULL,
    "iframe_sandbox_attrs" JSONB NOT NULL,
    "csp_additions" TEXT,

    CONSTRAINT "widget_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redirect_definitions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "route_id" TEXT NOT NULL,
    "method" "RedirectMethod" NOT NULL,
    "url_source_output" TEXT NOT NULL,
    "form_fields_output" TEXT,
    "target" "RedirectTarget" NOT NULL,
    "return_method_expected" "ReturnMethod" NOT NULL,
    "return_params_map" JSONB NOT NULL,

    CONSTRAINT "redirect_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_sources" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "type" "StatementSourceType" NOT NULL,
    "schedule_cron" TEXT,
    "parser_config" JSONB NOT NULL,
    "settlement_lag_days" INTEGER NOT NULL DEFAULT 0,
    "dedupe_key_template" TEXT,

    CONSTRAINT "statement_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_instructions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "rail_id" TEXT NOT NULL,
    "instructions_ar" TEXT NOT NULL,
    "instructions_en" TEXT NOT NULL,
    "destination_account_template" TEXT,
    "reference_format" TEXT,
    "proof_upload_allowed" BOOLEAN NOT NULL DEFAULT false,
    "operator_sla_minutes" INTEGER,
    "auto_expiry_minutes" INTEGER,

    CONSTRAINT "manual_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_groups" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "link_id" TEXT NOT NULL,
    "customer_fingerprint" CHAR(64) NOT NULL,
    "success_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attempt_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "link_id" TEXT NOT NULL,
    "attempt_group_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "rail_id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "credential_set_id" TEXT NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "commission_profile_id" TEXT NOT NULL,
    "env" "GatewayEnvironmentType" NOT NULL,
    "mode" TEXT NOT NULL,
    "sub_mode" TEXT,
    "status" "AttemptStatus" NOT NULL DEFAULT 'CREATED',
    "substatus" TEXT,
    "gateway_reference" TEXT,
    "provider_reference" TEXT,
    "network_reference" TEXT,
    "requested_amount" DECIMAL(18,4) NOT NULL,
    "surcharge_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_charged_amount" DECIMAL(18,4) NOT NULL,
    "gateway_amount_wire" TEXT,
    "settled_amount" DECIMAL(18,4),
    "gateway_fee_amount" DECIMAL(18,4),
    "platform_commission_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net_merchant_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "feeBearer" "FeeBearer" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "customer_fields_masked" JSONB NOT NULL,
    "context_ciphertext" TEXT NOT NULL,
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_otp_sent_at" TIMESTAMP(3),
    "client_ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "grace_expires_at" TIMESTAMP(3) NOT NULL,
    "next_check_at" TIMESTAMP(3),
    "ledger_entry_id" TEXT,
    "terminal_at" TIMESTAMP(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_step_logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "gateway_version_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "step_id" TEXT,
    "step_order" INTEGER NOT NULL,
    "redacted_request_json" JSONB NOT NULL,
    "redacted_response_text" TEXT NOT NULL,
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "attempt_step_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "channel_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "raw_body_bytes" BYTEA NOT NULL,
    "redacted_headers_json" JSONB NOT NULL,
    "source_ip" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verification_error" TEXT,
    "dedupe_key" CHAR(64) NOT NULL,
    "attempt_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),
    "processing_result" TEXT,

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_cases" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "attempt_id" TEXT,
    "reconciliation_item_id" TEXT,
    "kind" "OperatorCaseKind" NOT NULL,
    "priority" "OperatorCasePriority" NOT NULL,
    "sla_due_at" TIMESTAMP(3) NOT NULL,
    "state" "OperatorCaseState" NOT NULL DEFAULT 'OPEN',
    "assignee_user_id" TEXT,
    "resolution_notes" TEXT,
    "approval_request_id" TEXT,

    CONSTRAINT "operator_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "statement_source_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "file_hash" CHAR(64) NOT NULL,
    "stats_json" JSONB NOT NULL,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_items" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "run_id" TEXT NOT NULL,
    "attempt_id" TEXT,
    "our_reference" TEXT NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "batch_reference" TEXT,
    "statement_amount" DECIMAL(18,4) NOT NULL,
    "statement_fee" DECIMAL(18,4) NOT NULL,
    "result" "ReconciliationResult" NOT NULL,
    "operator_case_id" TEXT,

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_health_samples" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "route_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "definitive_failures" INTEGER NOT NULL DEFAULT 0,
    "ambiguous_unknowns" INTEGER NOT NULL DEFAULT 0,
    "rate_limits_429" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "p50_ms" INTEGER,
    "p95_ms" INTEGER,
    "p99_ms" INTEGER,

    CONSTRAINT "gateway_health_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detail_change_logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "actor_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "approval_request_id" TEXT,
    "source" "DetailChangeSource" NOT NULL,
    "request_id" TEXT NOT NULL,
    "client_ip" TEXT,

    CONSTRAINT "detail_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "actor_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" JSONB NOT NULL,
    "after_json" JSONB NOT NULL,
    "approval_request_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "IdentityKind" NOT NULL,
    "identifier_normalized" TEXT NOT NULL,
    "provider_subject" TEXT,
    "verified_at" TIMESTAMP(3),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "join_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "submitted_by_user_id" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "onboarding_channel" "OnboardingChannel" NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "assigned_reviewer_id" TEXT,
    "sla_due_at" TIMESTAMP(3) NOT NULL,
    "screening_id" TEXT,
    "proposed_risk_tier" "RiskTier" NOT NULL DEFAULT 'STANDARD',
    "four_eyes_required" BOOLEAN NOT NULL DEFAULT true,
    "four_eyes_reasons" JSONB,
    "decision" TEXT,
    "decision_reason_code" TEXT,
    "decision_notes" TEXT,
    "info_request_json" JSONB,
    "resubmission_of_id" TEXT,
    "approval_request_id" TEXT,

    CONSTRAINT "join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyb_documents" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "join_request_id" TEXT,
    "subject_type" "KybSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "doc_type" "KybDocumentType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "av_status" "AvStatus" NOT NULL DEFAULT 'PENDING',
    "status" "KybDocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "expires_on" DATE,
    "rejection_reason_code" TEXT,

    CONSTRAINT "kyb_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beneficial_owners" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "full_name_ar" TEXT NOT NULL,
    "full_name_en" TEXT,
    "national_id_ciphertext" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "nationality" CHAR(2) NOT NULL,
    "ownership_percent" DECIMAL(5,2),
    "role" "BeneficialOwnerRole" NOT NULL,
    "pep_declared" BOOLEAN NOT NULL DEFAULT false,
    "screening_status" "ScreeningStatus" NOT NULL DEFAULT 'NOT_SCREENED',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "beneficial_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_screenings" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "subject_type" "AmlScreeningSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "trigger" "AmlScreeningTrigger" NOT NULL,
    "provider_code" TEXT NOT NULL,
    "provider_request_ref" TEXT,
    "list_versions_json" JSONB NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "result" "AmlScreeningResult" NOT NULL,
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "highest_score" DECIMAL(5,2),
    "requested_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "aml_screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_screening_matches" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "screening_id" TEXT NOT NULL,
    "list_type" "AmlMatchListType" NOT NULL,
    "list_name" TEXT NOT NULL,
    "list_entry_ref" TEXT NOT NULL,
    "matched_name" TEXT NOT NULL,
    "score" DECIMAL(5,2) NOT NULL,
    "attributes_json" JSONB NOT NULL,
    "disposition" "AmlMatchDisposition" NOT NULL DEFAULT 'UNREVIEWED',
    "disposition_by" TEXT,
    "disposition_notes" TEXT,
    "suppress_future" BOOLEAN NOT NULL DEFAULT false,
    "suppress_until" DATE,

    CONSTRAINT "aml_screening_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_rules" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rule_type" "AmlRuleType" NOT NULL,
    "scope" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "action" "AmlRuleAction" NOT NULL,
    "base_severity" "AmlBaseSeverity" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "approval_request_id" TEXT,

    CONSTRAINT "aml_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporting_rules" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "authority" TEXT NOT NULL DEFAULT 'CBL',
    "report_type" "ReportingType" NOT NULL,
    "threshold_amount" DECIMAL(18,4),
    "window_seconds" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'LYD',
    "conditions" JSONB NOT NULL,
    "source_reference" TEXT,
    "status" "ReportingRuleStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "approval_request_id" TEXT,

    CONSTRAINT "reporting_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_reports" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "report_type" "ReportingType" NOT NULL,
    "authority" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "aml_case_id" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "status" "RegulatoryReportStatus" NOT NULL DEFAULT 'DRAFT',
    "payload_ciphertext" TEXT NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "submission_ref" TEXT,
    "submitted_at" TIMESTAMP(3),
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "approval_request_id" TEXT,

    CONSTRAINT "regulatory_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "rail_id" TEXT NOT NULL,
    "external_dispute_ref" TEXT NOT NULL,
    "source" "DisputeSource" NOT NULL,
    "reason_code" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPENED',
    "opened_at" TIMESTAMP(3) NOT NULL,
    "evidence_due_at" TIMESTAMP(3),
    "outcome_at" TIMESTAMP(3),
    "adjustment_id" TEXT,
    "evidence_json" JSONB,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "lang" "NotificationLang" NOT NULL,
    "subject_template" TEXT,
    "body_template" TEXT NOT NULL,
    "confidentiality_class" "ConfidentialityClass" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "event_id" TEXT NOT NULL,
    "recipient_user_id" TEXT,
    "recipient_merchant_id" TEXT,
    "address_masked" TEXT NOT NULL,
    "address_ciphertext" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "lang" "NotificationLang" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "key" TEXT NOT NULL,
    "scope" "PlatformSettingScope" NOT NULL DEFAULT 'PLATFORM',
    "value_json" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "approval_request_id" TEXT,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchants_status_idx" ON "merchants"("status");

-- CreateIndex
CREATE INDEX "merchants_kybStatus_idx" ON "merchants"("kybStatus");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_merchant_id_idx" ON "users"("merchant_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "applications_merchant_id_idx" ON "applications"("merchant_id");

-- CreateIndex
CREATE INDEX "applications_assigned_wallet_id_idx" ON "applications"("assigned_wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_gl_account_id_key" ON "wallets"("gl_account_id");

-- CreateIndex
CREATE INDEX "wallets_merchant_id_idx" ON "wallets"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_tokens_token_hash_key" ON "access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "access_tokens_merchant_id_idx" ON "access_tokens"("merchant_id");

-- CreateIndex
CREATE INDEX "access_tokens_application_id_idx" ON "access_tokens"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_token_ips_token_id_cidr_key" ON "access_token_ips"("token_id", "cidr");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_key_key" ON "payment_links"("key");

-- CreateIndex
CREATE INDEX "payment_links_application_id_idx" ON "payment_links"("application_id");

-- CreateIndex
CREATE INDEX "payment_links_wallet_id_idx" ON "payment_links"("wallet_id");

-- CreateIndex
CREATE INDEX "payment_links_state_idx" ON "payment_links"("state");

-- CreateIndex
CREATE INDEX "pos_terminals_application_id_idx" ON "pos_terminals"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_screens_screen_code_key" ON "pos_screens"("screen_code");

-- CreateIndex
CREATE INDEX "pos_screens_pos_id_idx" ON "pos_screens"("pos_id");

-- CreateIndex
CREATE UNIQUE INDEX "gl_accounts_seed_key_key" ON "gl_accounts"("seed_key");

-- CreateIndex
CREATE INDEX "gl_accounts_account_type_idx" ON "gl_accounts"("account_type");

-- CreateIndex
CREATE INDEX "gl_accounts_owner_id_idx" ON "gl_accounts"("owner_id");

-- CreateIndex
CREATE INDEX "gl_accounts_gateway_id_idx" ON "gl_accounts"("gateway_id");

-- CreateIndex
CREATE UNIQUE INDEX "gl_accounts_gateway_id_env_credential_set_id_key" ON "gl_accounts"("gateway_id", "env", "credential_set_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_ref_type_ref_id_key" ON "journal_entries"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines"("entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_gl_account_id_idx" ON "journal_lines"("gl_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "commission_profiles_seed_key_key" ON "commission_profiles"("seed_key");

-- CreateIndex
CREATE INDEX "commission_profiles_merchant_id_idx" ON "commission_profiles"("merchant_id");

-- CreateIndex
CREATE INDEX "commission_profiles_application_id_idx" ON "commission_profiles"("application_id");

-- CreateIndex
CREATE INDEX "velocity_rules_scope_type_scope_value_idx" ON "velocity_rules"("scope_type", "scope_value");

-- CreateIndex
CREATE INDEX "velocity_rules_active_idx" ON "velocity_rules"("active");

-- CreateIndex
CREATE INDEX "aml_cases_status_idx" ON "aml_cases"("status");

-- CreateIndex
CREATE INDEX "aml_cases_subject_type_subject_id_idx" ON "aml_cases"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "adjustments_dispute_id_key" ON "adjustments"("dispute_id");

-- CreateIndex
CREATE UNIQUE INDEX "adjustments_journal_entry_id_key" ON "adjustments"("journal_entry_id");

-- CreateIndex
CREATE INDEX "adjustments_target_gl_account_id_idx" ON "adjustments"("target_gl_account_id");

-- CreateIndex
CREATE INDEX "adjustments_state_idx" ON "adjustments"("state");

-- CreateIndex
CREATE INDEX "cashout_requests_merchant_id_idx" ON "cashout_requests"("merchant_id");

-- CreateIndex
CREATE INDEX "cashout_requests_wallet_id_idx" ON "cashout_requests"("wallet_id");

-- CreateIndex
CREATE INDEX "approval_requests_maker_user_id_idx" ON "approval_requests"("maker_user_id");

-- CreateIndex
CREATE INDEX "approval_requests_checker_user_id_idx" ON "approval_requests"("checker_user_id");

-- CreateIndex
CREATE INDEX "approval_requests_state_idx" ON "approval_requests"("state");

-- CreateIndex
CREATE UNIQUE INDEX "gateways_code_key" ON "gateways"("code");

-- CreateIndex
CREATE UNIQUE INDEX "gateways_active_version_id_key" ON "gateways"("active_version_id");

-- CreateIndex
CREATE INDEX "gateways_status_idx" ON "gateways"("status");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_versions_content_hash_key" ON "gateway_versions"("content_hash");

-- CreateIndex
CREATE INDEX "gateway_versions_state_idx" ON "gateway_versions"("state");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_versions_gateway_id_version_number_key" ON "gateway_versions"("gateway_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_environments_gateway_version_id_env_key" ON "gateway_environments"("gateway_version_id", "env");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_auth_gateway_version_id_env_key" ON "gateway_auth"("gateway_version_id", "env");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_settings_gateway_version_id_key" ON "gateway_settings"("gateway_version_id");

-- CreateIndex
CREATE INDEX "credential_sets_owner_merchant_id_idx" ON "credential_sets"("owner_merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_sets_gateway_id_env_external_merchant_id_key" ON "credential_sets"("gateway_id", "env", "external_merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_name_key" ON "assets"("name");

-- CreateIndex
CREATE UNIQUE INDEX "assets_sha256_key" ON "assets"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "rails_code_key" ON "rails"("code");

-- CreateIndex
CREATE INDEX "rails_collection_mode_idx" ON "rails"("collection_mode");

-- CreateIndex
CREATE UNIQUE INDEX "rail_fields_rail_id_key_key" ON "rail_fields"("rail_id", "key");

-- CreateIndex
CREATE INDEX "rail_routes_status_health_state_idx" ON "rail_routes"("status", "health_state");

-- CreateIndex
CREATE UNIQUE INDEX "rail_routes_rail_id_gateway_id_credential_policy_key" ON "rail_routes"("rail_id", "gateway_id", "credential_policy");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_profiles_gateway_version_id_name_key" ON "crypto_profiles"("gateway_version_id", "name");

-- CreateIndex
CREATE INDEX "flows_gateway_version_id_phase_idx" ON "flows"("gateway_version_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "flow_steps_flow_id_order_index_key" ON "flow_steps"("flow_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "step_parameters_step_id_place_key_key" ON "step_parameters"("step_id", "place", "key");

-- CreateIndex
CREATE UNIQUE INDEX "step_outputs_step_id_name_key" ON "step_outputs"("step_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "status_rules_gateway_version_id_phase_order_index_key" ON "status_rules"("gateway_version_id", "phase", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "error_maps_gateway_version_id_gateway_code_canonical_error_key" ON "error_maps"("gateway_version_id", "gateway_code", "canonical_error");

-- CreateIndex
CREATE UNIQUE INDEX "confirmation_channels_path_token_key" ON "confirmation_channels"("path_token");

-- CreateIndex
CREATE INDEX "confirmation_channels_gateway_version_id_idx" ON "confirmation_channels"("gateway_version_id");

-- CreateIndex
CREATE INDEX "confirmation_channels_route_id_idx" ON "confirmation_channels"("route_id");

-- CreateIndex
CREATE UNIQUE INDEX "poll_policies_route_id_key" ON "poll_policies"("route_id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_definitions_route_id_key" ON "widget_definitions"("route_id");

-- CreateIndex
CREATE UNIQUE INDEX "redirect_definitions_route_id_key" ON "redirect_definitions"("route_id");

-- CreateIndex
CREATE INDEX "statement_sources_gateway_id_idx" ON "statement_sources"("gateway_id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_instructions_rail_id_key" ON "manual_instructions"("rail_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_groups_link_id_customer_fingerprint_key" ON "attempt_groups"("link_id", "customer_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_reference_key" ON "payment_attempts"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_ledger_entry_id_key" ON "payment_attempts"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "payment_attempts_link_id_idx" ON "payment_attempts"("link_id");

-- CreateIndex
CREATE INDEX "payment_attempts_merchant_id_idx" ON "payment_attempts"("merchant_id");

-- CreateIndex
CREATE INDEX "payment_attempts_status_next_check_at_idx" ON "payment_attempts"("status", "next_check_at");

-- CreateIndex
CREATE INDEX "payment_attempts_gateway_version_id_idx" ON "payment_attempts"("gateway_version_id");

-- CreateIndex
CREATE INDEX "attempt_step_logs_attempt_id_idx" ON "attempt_step_logs"("attempt_id");

-- CreateIndex
CREATE INDEX "inbound_events_gateway_id_idx" ON "inbound_events"("gateway_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_channel_id_dedupe_key_key" ON "inbound_events"("channel_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "operator_cases_reconciliation_item_id_key" ON "operator_cases"("reconciliation_item_id");

-- CreateIndex
CREATE INDEX "operator_cases_state_priority_idx" ON "operator_cases"("state", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_file_hash_key" ON "reconciliation_runs"("file_hash");

-- CreateIndex
CREATE INDEX "reconciliation_runs_statement_source_id_idx" ON "reconciliation_runs"("statement_source_id");

-- CreateIndex
CREATE INDEX "reconciliation_items_run_id_idx" ON "reconciliation_items"("run_id");

-- CreateIndex
CREATE INDEX "reconciliation_items_result_idx" ON "reconciliation_items"("result");

-- CreateIndex
CREATE INDEX "gateway_health_samples_route_id_window_start_idx" ON "gateway_health_samples"("route_id", "window_start");

-- CreateIndex
CREATE INDEX "detail_change_logs_entity_type_entity_id_idx" ON "detail_change_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider_subject");

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_kind_identifier_normalized_key" ON "user_identities"("kind", "identifier_normalized");

-- CreateIndex
CREATE INDEX "join_requests_merchant_id_idx" ON "join_requests"("merchant_id");

-- CreateIndex
CREATE INDEX "join_requests_status_idx" ON "join_requests"("status");

-- CreateIndex
CREATE INDEX "kyb_documents_merchant_id_idx" ON "kyb_documents"("merchant_id");

-- CreateIndex
CREATE INDEX "kyb_documents_sha256_idx" ON "kyb_documents"("sha256");

-- CreateIndex
CREATE INDEX "beneficial_owners_merchant_id_idx" ON "beneficial_owners"("merchant_id");

-- CreateIndex
CREATE INDEX "beneficial_owners_screening_status_idx" ON "beneficial_owners"("screening_status");

-- CreateIndex
CREATE INDEX "aml_screenings_subject_type_subject_id_idx" ON "aml_screenings"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "aml_screenings_result_idx" ON "aml_screenings"("result");

-- CreateIndex
CREATE INDEX "aml_screening_matches_screening_id_idx" ON "aml_screening_matches"("screening_id");

-- CreateIndex
CREATE UNIQUE INDEX "aml_rules_code_key" ON "aml_rules"("code");

-- CreateIndex
CREATE INDEX "aml_rules_active_idx" ON "aml_rules"("active");

-- CreateIndex
CREATE INDEX "reporting_rules_status_idx" ON "reporting_rules"("status");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_reports_aml_case_id_key" ON "regulatory_reports"("aml_case_id");

-- CreateIndex
CREATE INDEX "regulatory_reports_status_idx" ON "regulatory_reports"("status");

-- CreateIndex
CREATE INDEX "disputes_attempt_id_idx" ON "disputes"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_gateway_id_external_dispute_ref_key" ON "disputes"("gateway_id", "external_dispute_ref");

-- CreateIndex
CREATE INDEX "notification_templates_code_idx" ON "notification_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_channel_lang_version_key" ON "notification_templates"("code", "channel", "lang", "version");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_event_id_key" ON "notifications"("event_id");

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "platform_settings_key_scope_idx" ON "platform_settings"("key", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_key_scope_version_key" ON "platform_settings"("key", "scope", "version");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_assigned_wallet_id_fkey" FOREIGN KEY ("assigned_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_token_ips" ADD CONSTRAINT "access_token_ips_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "access_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_screens" ADD CONSTRAINT "pos_screens_pos_id_fkey" FOREIGN KEY ("pos_id") REFERENCES "pos_terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_credential_set_id_fkey" FOREIGN KEY ("credential_set_id") REFERENCES "credential_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_profiles" ADD CONSTRAINT "commission_profiles_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_profiles" ADD CONSTRAINT "commission_profiles_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_profiles" ADD CONSTRAINT "commission_profiles_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "velocity_rules" ADD CONSTRAINT "velocity_rules_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_cases" ADD CONSTRAINT "aml_cases_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "aml_screenings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_cases" ADD CONSTRAINT "aml_cases_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "aml_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_cases" ADD CONSTRAINT "aml_cases_hold_journal_entry_id_fkey" FOREIGN KEY ("hold_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_cases" ADD CONSTRAINT "aml_cases_assigned_reviewer_id_fkey" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_target_gl_account_id_fkey" FOREIGN KEY ("target_gl_account_id") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_source_attempt_id_fkey" FOREIGN KEY ("source_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashout_requests" ADD CONSTRAINT "cashout_requests_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashout_requests" ADD CONSTRAINT "cashout_requests_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashout_requests" ADD CONSTRAINT "cashout_requests_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_maker_user_id_fkey" FOREIGN KEY ("maker_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_checker_user_id_fkey" FOREIGN KEY ("checker_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "gateway_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_versions" ADD CONSTRAINT "gateway_versions_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_versions" ADD CONSTRAINT "gateway_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_versions" ADD CONSTRAINT "gateway_versions_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_versions" ADD CONSTRAINT "gateway_versions_rollback_version_id_fkey" FOREIGN KEY ("rollback_version_id") REFERENCES "gateway_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_environments" ADD CONSTRAINT "gateway_environments_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_auth" ADD CONSTRAINT "gateway_auth_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_settings" ADD CONSTRAINT "gateway_settings_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_sets" ADD CONSTRAINT "credential_sets_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_sets" ADD CONSTRAINT "credential_sets_owner_merchant_id_fkey" FOREIGN KEY ("owner_merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rails" ADD CONSTRAINT "rails_logo_asset_id_fkey" FOREIGN KEY ("logo_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rail_fields" ADD CONSTRAINT "rail_fields_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "rails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rail_routes" ADD CONSTRAINT "rail_routes_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "rails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rail_routes" ADD CONSTRAINT "rail_routes_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crypto_profiles" ADD CONSTRAINT "crypto_profiles_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "rails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_parameters" ADD CONSTRAINT "step_parameters_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "flow_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_parameters" ADD CONSTRAINT "step_parameters_crypto_profile_id_fkey" FOREIGN KEY ("crypto_profile_id") REFERENCES "crypto_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_outputs" ADD CONSTRAINT "step_outputs_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "flow_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_rules" ADD CONSTRAINT "status_rules_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_maps" ADD CONSTRAINT "error_maps_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmation_channels" ADD CONSTRAINT "confirmation_channels_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmation_channels" ADD CONSTRAINT "confirmation_channels_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmation_channels" ADD CONSTRAINT "confirmation_channels_crypto_profile_id_fkey" FOREIGN KEY ("crypto_profile_id") REFERENCES "crypto_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_policies" ADD CONSTRAINT "poll_policies_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_definitions" ADD CONSTRAINT "widget_definitions_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redirect_definitions" ADD CONSTRAINT "redirect_definitions_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_sources" ADD CONSTRAINT "statement_sources_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_instructions" ADD CONSTRAINT "manual_instructions_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "rails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_groups" ADD CONSTRAINT "attempt_groups_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "payment_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "payment_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_attempt_group_id_fkey" FOREIGN KEY ("attempt_group_id") REFERENCES "attempt_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "rails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_credential_set_id_fkey" FOREIGN KEY ("credential_set_id") REFERENCES "credential_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_commission_profile_id_fkey" FOREIGN KEY ("commission_profile_id") REFERENCES "commission_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_step_logs" ADD CONSTRAINT "attempt_step_logs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_step_logs" ADD CONSTRAINT "attempt_step_logs_gateway_version_id_fkey" FOREIGN KEY ("gateway_version_id") REFERENCES "gateway_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_step_logs" ADD CONSTRAINT "attempt_step_logs_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "flow_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "confirmation_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_cases" ADD CONSTRAINT "operator_cases_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_cases" ADD CONSTRAINT "operator_cases_reconciliation_item_id_fkey" FOREIGN KEY ("reconciliation_item_id") REFERENCES "reconciliation_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_cases" ADD CONSTRAINT "operator_cases_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_cases" ADD CONSTRAINT "operator_cases_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_statement_source_id_fkey" FOREIGN KEY ("statement_source_id") REFERENCES "statement_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_health_samples" ADD CONSTRAINT "gateway_health_samples_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detail_change_logs" ADD CONSTRAINT "detail_change_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detail_change_logs" ADD CONSTRAINT "detail_change_logs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detail_change_logs" ADD CONSTRAINT "detail_change_logs_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_assigned_reviewer_id_fkey" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "aml_screenings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_resubmission_of_id_fkey" FOREIGN KEY ("resubmission_of_id") REFERENCES "join_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyb_documents" ADD CONSTRAINT "kyb_documents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyb_documents" ADD CONSTRAINT "kyb_documents_join_request_id_fkey" FOREIGN KEY ("join_request_id") REFERENCES "join_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyb_documents" ADD CONSTRAINT "kyb_documents_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beneficial_owners" ADD CONSTRAINT "beneficial_owners_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_screening_matches" ADD CONSTRAINT "aml_screening_matches_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "aml_screenings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_screening_matches" ADD CONSTRAINT "aml_screening_matches_disposition_by_fkey" FOREIGN KEY ("disposition_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_rules" ADD CONSTRAINT "aml_rules_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_rules" ADD CONSTRAINT "reporting_rules_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_reports" ADD CONSTRAINT "regulatory_reports_aml_case_id_fkey" FOREIGN KEY ("aml_case_id") REFERENCES "aml_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_reports" ADD CONSTRAINT "regulatory_reports_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "rails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_merchant_id_fkey" FOREIGN KEY ("recipient_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Schema version support (single-row table managed outside the Prisma datamodel).
CREATE TABLE IF NOT EXISTS "schema_versions" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "schema_versions_pkey" PRIMARY KEY ("id")
);

INSERT INTO "schema_versions" ("id", "version") VALUES (1, 1)
ON CONFLICT ("id") DO UPDATE SET "version" = EXCLUDED."version";

-- Domain invariants that the Prisma datamodel cannot express.
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "attempt_groups" ADD CONSTRAINT "attempt_groups_single_success" CHECK ("success_count" <= 1);

ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_checker_not_maker" CHECK ("checker_user_id" IS NULL OR "checker_user_id" <> "maker_user_id");

ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_slot_reservation_invariant" CHECK ("infinite_use" = true OR ("confirmed_count" + "active_locked_count") <= "use_count");
