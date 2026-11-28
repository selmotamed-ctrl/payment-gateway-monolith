//! Prisma-model field tables for the Sandbox read routes.
//!
//! Every table lists the model fields in `core-back/prisma/schema.prisma` declaration order, which is
//! the order Prisma serialises them in. Handlers that hand-shape a row (the Studio lists) build the
//! object themselves; the tables here are for the handlers that return a whole model row
//! (`syncAudits`, `disputes`, `cashouts`, the admin `merchant`, the payment `attempt`, …).
//!
//! **DEV-SANDBOX-07 (`journalLines[].shardSeq`):** Prisma returns a JavaScript `BigInt`, which
//! `JSON.stringify` refuses, so the TS payment-detail route would raise a 500 for a payment with
//! journal lines. The Rust route renders the column as a JSON number (clamped to the i32 range to
//! keep the row decodable); a shard above 2^31 lines is beyond the sandbox dataset by design.

#![forbid(unsafe_code)]

use crate::routes::merchant::{f, FieldKind, Fields};

/// `SandboxSyncAudit` (`sandbox_sync_audits`).
pub const AUDIT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Text),
    f("sync_type", "syncType", FieldKind::Text),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("actor_id", "actorId", FieldKind::Uuid),
    f("actor_role", "actorRole", FieldKind::Text),
    f("blueprint_revision", "blueprintRevision", FieldKind::Int),
    f("summary_json", "summaryJson", FieldKind::Json),
    f("created_at", "createdAt", FieldKind::Timestamp),
];

/// The projection yielding [`AUDIT_FIELDS`] (`sandbox_sync_audits` has no alias requirement).
pub const AUDIT_COLUMNS: &str = "id, sync_type, merchant_id, actor_id, actor_role, \
     blueprint_revision, summary_json, created_at";

/// `SystemExecutionPlane` (`system_execution_plane`).
pub const PLANE_FIELDS: Fields = &[
    f("id", "id", FieldKind::Int),
    f("plane", "plane", FieldKind::Text),
    f("allow_fake_rails", "allowFakeRails", FieldKind::Bool),
    f("live_sync_revision", "liveSyncRevision", FieldKind::Int),
    f(
        "last_synced_from_live",
        "lastSyncedFromLive",
        FieldKind::Timestamp,
    ),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
];

pub const PLANE_COLUMNS: &str = "id, plane, allow_fake_rails, live_sync_revision, \
     last_synced_from_live, updated_at";

/// `Merchant` (`merchants`) in model order.
pub const MERCHANT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("version", "version", FieldKind::Int),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("legal_name", "legalName", FieldKind::Text),
    f("trade_name", "tradeName", FieldKind::Text),
    f("display_name", "displayName", FieldKind::Text),
    f("logo_url", "logoUrl", FieldKind::Text),
    f("support_email", "supportEmail", FieldKind::Text),
    f("support_phone", "supportPhone", FieldKind::Text),
    f("tax_id", "taxId", FieldKind::Text),
    f("registration_no", "registrationNo", FieldKind::Text),
    f("business_category", "businessCategory", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("kyb_status", "kybStatus", FieldKind::Text),
    f("risk_tier", "riskTier", FieldKind::Text),
    f("onboarding_channel", "onboardingChannel", FieldKind::Text),
    f("country", "country", FieldKind::Text),
    f("contact_phone", "contactPhone", FieldKind::Text),
    f("contact_email", "contactEmail", FieldKind::Text),
    f("activated_at", "activatedAt", FieldKind::Timestamp),
    f("suspended_at", "suspendedAt", FieldKind::Timestamp),
    f(
        "suspension_reason_code",
        "suspensionReasonCode",
        FieldKind::Text,
    ),
    f("suspension_notes", "suspensionNotes", FieldKind::Text),
    f("closed_at", "closedAt", FieldKind::Timestamp),
    f("closed_reason_code", "closedReasonCode", FieldKind::Text),
    f("closed_notes", "closedNotes", FieldKind::Text),
    f(
        "commission_receivable_ceiling",
        "commissionReceivableCeiling",
        FieldKind::Decimal,
    ),
    f(
        "negative_balance_ceiling",
        "negativeBalanceCeiling",
        FieldKind::Decimal,
    ),
    f(
        "payout_bank_details_json",
        "payoutBankDetailsJson",
        FieldKind::Json,
    ),
    f("payout_account_hash", "payoutAccountHash", FieldKind::Text),
    f(
        "next_kyb_review_at",
        "nextKybReviewAt",
        FieldKind::Timestamp,
    ),
];

pub const MERCHANT_COLUMNS: &str = "m.id, m.version, m.created_at, m.updated_at, m.legal_name, \
     m.trade_name, m.display_name, m.logo_url, m.support_email, m.support_phone, m.tax_id, \
     m.registration_no, m.business_category, m.status::text AS status, \
     m.kyb_status::text AS kyb_status, m.risk_tier::text AS risk_tier, m.onboarding_channel, \
     m.country, m.contact_phone, m.contact_email, m.activated_at, m.suspended_at, \
     m.suspension_reason_code, m.suspension_notes, m.closed_at, m.closed_reason_code, \
     m.closed_notes, m.commission_receivable_ceiling, m.negative_balance_ceiling, \
     m.payout_bank_details_json, m.payout_account_hash, m.next_kyb_review_at";

/// `Wallet` (`wallets`) in model order.
pub const WALLET_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("gl_account_id", "glAccountId", FieldKind::Uuid),
    f("currency", "currency", FieldKind::Text),
    f("name", "name", FieldKind::Text),
    f("status", "status", FieldKind::Text),
];

pub const WALLET_COLUMNS: &str = "w.id, w.created_at, w.updated_at, w.merchant_id, \
     w.gl_account_id, w.currency, w.name, w.status::text AS status";

/// `Application` (`applications`) in model order.
pub const APPLICATION_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("name", "name", FieldKind::Text),
    f(
        "business_use_description",
        "businessUseDescription",
        FieldKind::Text,
    ),
    f(
        "expected_monthly_volume",
        "expectedMonthlyVolume",
        FieldKind::Decimal,
    ),
    f("assigned_wallet_id", "assignedWalletId", FieldKind::Uuid),
    f("rail_whitelist", "railWhitelist", FieldKind::Json),
    f(
        "redirect_domain_allowlist",
        "redirectDomainAllowlist",
        FieldKind::Json,
    ),
    f("status", "status", FieldKind::Text),
];

pub const APPLICATION_COLUMNS: &str = "a.id, a.created_at, a.updated_at, a.merchant_id, a.name, \
     a.business_use_description, a.expected_monthly_volume, a.assigned_wallet_id, \
     a.rail_whitelist, a.redirect_domain_allowlist, a.status::text AS status";

/// `PaymentLink` (`payment_links`) in model order.
pub const LINK_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("key", "key", FieldKind::Text),
    f("title", "title", FieldKind::Text),
    f("description", "description", FieldKind::Text),
    f("application_id", "applicationId", FieldKind::Uuid),
    f("wallet_id", "walletId", FieldKind::Uuid),
    f("amount", "amount", FieldKind::Decimal),
    f("currency", "currency", FieldKind::Text),
    f("fee_bearer", "feeBearer", FieldKind::Text),
    f("split_ratio_json", "splitRatioJson", FieldKind::Json),
    f("infinite_use", "infiniteUse", FieldKind::Bool),
    f("use_count", "useCount", FieldKind::Int),
    f("confirmed_count", "confirmedCount", FieldKind::Int),
    f("active_locked_count", "activeLockedCount", FieldKind::Int),
    f("redirect_url", "redirectUrl", FieldKind::Text),
    f("rail_whitelist", "railWhitelist", FieldKind::Json),
    f("env", "env", FieldKind::Text),
    f("state", "state", FieldKind::Text),
    f("expires_at", "expiresAt", FieldKind::Timestamp),
];

pub const LINK_COLUMNS: &str = "l.id, l.created_at, l.updated_at, l.key, l.title, l.description, \
     l.application_id, l.wallet_id, l.amount, l.currency, l.fee_bearer::text AS fee_bearer, \
     l.split_ratio_json, l.infinite_use, l.use_count, l.confirmed_count, l.active_locked_count, \
     l.redirect_url, l.rail_whitelist, l.env::text AS env, l.state::text AS state, l.expires_at";

/// `CashoutRequest` (`cashout_requests`) in model order.
pub const CASHOUT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("wallet_id", "walletId", FieldKind::Uuid),
    f("amount", "amount", FieldKind::Decimal),
    f(
        "destination_bank_json",
        "destinationBankJson",
        FieldKind::Json,
    ),
    f("state", "state", FieldKind::Text),
    f("adjustment_id", "adjustmentId", FieldKind::Uuid),
    f("idempotency_key", "idempotencyKey", FieldKind::Text),
    f("requested_by_user_id", "requestedByUserId", FieldKind::Uuid),
];

pub const CASHOUT_COLUMNS: &str = "id, created_at, updated_at, merchant_id, wallet_id, amount, \
     destination_bank_json, state::text AS state, adjustment_id, idempotency_key, \
     requested_by_user_id";

/// `Dispute` (`disputes`) in model order.
pub const DISPUTE_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("attempt_id", "attemptId", FieldKind::Uuid),
    f("gateway_id", "gatewayId", FieldKind::Uuid),
    f("rail_id", "railId", FieldKind::Uuid),
    f(
        "external_dispute_ref",
        "externalDisputeRef",
        FieldKind::Text,
    ),
    f("source", "source", FieldKind::Text),
    f("reason_code", "reasonCode", FieldKind::Text),
    f("amount", "amount", FieldKind::Decimal),
    f("currency", "currency", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("opened_at", "openedAt", FieldKind::Timestamp),
    f("evidence_due_at", "evidenceDueAt", FieldKind::Timestamp),
    f("outcome_at", "outcomeAt", FieldKind::Timestamp),
    f("adjustment_id", "adjustmentId", FieldKind::Uuid),
    f("evidence_json", "evidenceJson", FieldKind::Json),
];

pub const DISPUTE_COLUMNS: &str = "id, created_at, updated_at, attempt_id, gateway_id, rail_id, \
     external_dispute_ref, source::text AS source, reason_code, amount, currency, \
     status::text AS status, opened_at, evidence_due_at, outcome_at, adjustment_id, evidence_json";

/// `Adjustment` (`adjustments`) in model order.
pub const ADJUSTMENT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("type", "type", FieldKind::Text),
    f("target_gl_account_id", "targetGlAccountId", FieldKind::Uuid),
    f("source_attempt_id", "sourceAttemptId", FieldKind::Uuid),
    f("dispute_id", "disputeId", FieldKind::Uuid),
    f("drafted_by_system", "draftedBySystem", FieldKind::Bool),
    f("amount", "amount", FieldKind::Decimal),
    f("reverse_commission", "reverseCommission", FieldKind::Bool),
    f("reason", "reason", FieldKind::Text),
    f(
        "external_dispute_ref",
        "externalDisputeRef",
        FieldKind::Text,
    ),
    f("provider_refund_ref", "providerRefundRef", FieldKind::Text),
    f("state", "state", FieldKind::Text),
    f("journal_entry_id", "journalEntryId", FieldKind::Uuid),
];

pub const ADJUSTMENT_COLUMNS: &str = "id, created_at, updated_at, type::text AS type, \
     target_gl_account_id, source_attempt_id, dispute_id, drafted_by_system, amount, \
     reverse_commission, reason, external_dispute_ref, provider_refund_ref, \
     state::text AS state, journal_entry_id";

/// `AttemptStepLog` (`attempt_step_logs`) in model order.
pub const STEP_LOG_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("attempt_id", "attemptId", FieldKind::Uuid),
    f("gateway_version_id", "gatewayVersionId", FieldKind::Uuid),
    f("phase", "phase", FieldKind::Text),
    f("step_id", "stepId", FieldKind::Uuid),
    f("step_order", "stepOrder", FieldKind::Int),
    f(
        "redacted_request_json",
        "redactedRequestJson",
        FieldKind::Json,
    ),
    f(
        "redacted_response_text",
        "redactedResponseText",
        FieldKind::Text,
    ),
    f("http_status", "httpStatus", FieldKind::Int),
    f("duration_ms", "durationMs", FieldKind::Int),
    f("outcome", "outcome", FieldKind::Text),
];

pub const STEP_LOG_COLUMNS: &str = "id, created_at, updated_at, attempt_id, gateway_version_id, \
     phase, step_id, step_order, redacted_request_json, redacted_response_text, http_status, \
     duration_ms, outcome";

/// `JournalEntry` (`journal_entries`) in model order.
pub const JOURNAL_ENTRY_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("ref_type", "refType", FieldKind::Text),
    f("ref_id", "refId", FieldKind::Text),
    f("description", "description", FieldKind::Text),
];

pub const JOURNAL_ENTRY_COLUMNS: &str =
    "id, created_at, updated_at, ref_type::text AS ref_type, ref_id, description";

/// `JournalLine` (`journal_lines`) in model order (`shard_seq` as a JSON number, DEV-SANDBOX-07).
pub const JOURNAL_LINE_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("entry_id", "entryId", FieldKind::Uuid),
    f("gl_account_id", "glAccountId", FieldKind::Uuid),
    f("direction", "direction", FieldKind::Text),
    f("amount", "amount", FieldKind::Decimal),
    f("shard_id", "shardId", FieldKind::Int),
    f("shard_seq", "shardSeq", FieldKind::Int),
];

pub const JOURNAL_LINE_COLUMNS: &str = "id, created_at, updated_at, entry_id, gl_account_id, \
     direction::text AS direction, amount, shard_id::int AS shard_id, \
     LEAST(shard_seq, 2147483647)::int AS shard_seq";

/// `PaymentAttempt` (`payment_attempts`) in model order.
pub const ATTEMPT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("reference", "reference", FieldKind::Text),
    f("idempotency_key", "idempotencyKey", FieldKind::Text),
    f("link_id", "linkId", FieldKind::Uuid),
    f("attempt_group_id", "attemptGroupId", FieldKind::Uuid),
    f("application_id", "applicationId", FieldKind::Uuid),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("rail_id", "railId", FieldKind::Uuid),
    f("route_id", "routeId", FieldKind::Uuid),
    f("credential_set_id", "credentialSetId", FieldKind::Uuid),
    f("gateway_version_id", "gatewayVersionId", FieldKind::Uuid),
    f(
        "commission_profile_id",
        "commissionProfileId",
        FieldKind::Uuid,
    ),
    f("env", "env", FieldKind::Text),
    f("mode", "mode", FieldKind::Text),
    f("sub_mode", "subMode", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("substatus", "substatus", FieldKind::Text),
    f("gateway_reference", "gatewayReference", FieldKind::Text),
    f("provider_reference", "providerReference", FieldKind::Text),
    f("network_reference", "networkReference", FieldKind::Text),
    f("requested_amount", "requestedAmount", FieldKind::Decimal),
    f("surcharge_amount", "surchargeAmount", FieldKind::Decimal),
    f(
        "total_charged_amount",
        "totalChargedAmount",
        FieldKind::Decimal,
    ),
    f("gateway_amount_wire", "gatewayAmountWire", FieldKind::Text),
    f("settled_amount", "settledAmount", FieldKind::Decimal),
    f("gateway_fee_amount", "gatewayFeeAmount", FieldKind::Decimal),
    f(
        "platform_commission_amount",
        "platformCommissionAmount",
        FieldKind::Decimal,
    ),
    f(
        "net_merchant_amount",
        "netMerchantAmount",
        FieldKind::Decimal,
    ),
    f("fee_bearer", "feeBearer", FieldKind::Text),
    f("settlement_target", "settlementTarget", FieldKind::Text),
    f("wallet_id", "walletId", FieldKind::Uuid),
    f("wallet_gl_account_id", "walletGlAccountId", FieldKind::Uuid),
    f("currency", "currency", FieldKind::Text),
    f(
        "customer_fields_masked",
        "customerFieldsMasked",
        FieldKind::Json,
    ),
    f("public_outputs", "publicOutputs", FieldKind::Json),
    f("context_ciphertext", "contextCiphertext", FieldKind::Text),
    f("point_of_no_return", "pointOfNoReturn", FieldKind::Bool),
    f("otp_attempts", "otpAttempts", FieldKind::Int),
    f("last_otp_sent_at", "lastOtpSentAt", FieldKind::Timestamp),
    f("client_ip", "clientIp", FieldKind::Text),
    f("user_agent", "userAgent", FieldKind::Text),
    f("expires_at", "expiresAt", FieldKind::Timestamp),
    f("grace_expires_at", "graceExpiresAt", FieldKind::Timestamp),
    f("next_check_at", "nextCheckAt", FieldKind::Timestamp),
    f("ledger_entry_id", "ledgerEntryId", FieldKind::Uuid),
    f("terminal_at", "terminalAt", FieldKind::Timestamp),
    f("first_terminal_at", "firstTerminalAt", FieldKind::Timestamp),
    f("first_unknown_at", "firstUnknownAt", FieldKind::Timestamp),
    f("canonical_error", "canonicalError", FieldKind::Text),
];

pub const ATTEMPT_COLUMNS: &str = "pa.id, pa.created_at, pa.updated_at, pa.reference, \
     pa.idempotency_key, pa.link_id, pa.attempt_group_id, pa.application_id, pa.merchant_id, \
     pa.rail_id, pa.route_id, pa.credential_set_id, pa.gateway_version_id, \
     pa.commission_profile_id, pa.env::text AS env, pa.mode, pa.sub_mode, pa.status::text AS status, \
     pa.substatus, pa.gateway_reference, pa.provider_reference, pa.network_reference, \
     pa.requested_amount, pa.surcharge_amount, pa.total_charged_amount, pa.gateway_amount_wire, \
     pa.settled_amount, pa.gateway_fee_amount, pa.platform_commission_amount, \
     pa.net_merchant_amount, pa.fee_bearer::text AS fee_bearer, \
     pa.settlement_target::text AS settlement_target, pa.wallet_id, pa.wallet_gl_account_id, \
     pa.currency, pa.customer_fields_masked, pa.public_outputs, pa.context_ciphertext, \
     pa.point_of_no_return, pa.otp_attempts, pa.last_otp_sent_at, pa.client_ip, pa.user_agent, \
     pa.expires_at, pa.grace_expires_at, pa.next_check_at, pa.ledger_entry_id, pa.terminal_at, \
     pa.first_terminal_at, pa.first_unknown_at, pa.canonical_error";

/// `AccessToken` fields the Sandbox Studio serialises (the token hash never leaves the handler).
pub const TOKEN_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("name", "name", FieldKind::Text),
    f("last_four", "lastFour", FieldKind::Text),
    f("application_id", "applicationId", FieldKind::Uuid),
    f("scopes", "scopes", FieldKind::Json),
    f("expires_at", "expiresAt", FieldKind::Timestamp),
    f("revoked_at", "revokedAt", FieldKind::Timestamp),
    f("last_used_at", "lastUsedAt", FieldKind::Timestamp),
    f(
        "ip_whitelist_enabled",
        "ipWhitelistEnabled",
        FieldKind::Bool,
    ),
    f("created_at", "createdAt", FieldKind::Timestamp),
];

pub const TOKEN_COLUMNS: &str = "t.id, t.name, t.last_four, t.application_id, t.scopes, \
     t.expires_at, t.revoked_at, t.last_used_at, t.ip_whitelist_enabled, t.created_at";

/// `WalletStatus`/`ApplicationStatus`/`PaymentLinkState` sample of the enum list filter sets.
pub const JOURNAL_REF_TYPES: [&str; 8] = [
    "PAYMENT_ATTEMPT",
    "ADJUSTMENT",
    "AML_RELEASE",
    "AML_VOID",
    "SETTLEMENT_SWEEP",
    "FEE_VARIANCE",
    "COMMISSION_NETTING",
    "DISPUTE_OUTCOME",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_table_covers_the_prisma_model() {
        let keys: Vec<&str> = AUDIT_FIELDS.iter().map(|field| field.key).collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "syncType",
                "merchantId",
                "actorId",
                "actorRole",
                "blueprintRevision",
                "summaryJson",
                "createdAt"
            ]
        );
    }

    #[test]
    fn attempt_table_starts_with_the_model_order() {
        assert_eq!(ATTEMPT_FIELDS[0].key, "id");
        assert_eq!(ATTEMPT_FIELDS[1].key, "createdAt");
        assert_eq!(ATTEMPT_FIELDS[4].key, "idempotencyKey");
        assert_eq!(
            ATTEMPT_FIELDS.last().map(|field| field.key),
            Some("canonicalError")
        );
    }
}
