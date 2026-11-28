//! Concrete public-body schemas for the admin edge.
//!
//! Every schema below is transcribed from the router that registers the route; the route table is
//! the only caller. Zod modes are preserved: `z.object` strips unknown keys, `.strict()` rejects
//! them, `.passthrough()`/`.catchall()` keep them.

#![forbid(unsafe_code)]

use crate::schema::{
    any, array_sized, boolean, coerce_integer, date, datetime, email, enumeration, integer,
    literal, literal_int, literal_true, number, object, pattern, record_any, record_of, string_any,
    text, trimmed, uuid, Schema,
};

pub fn checklist_any(max: usize) -> Schema {
    array_sized(text(0, 64), 0, max)
}

pub fn uuid_params() -> Schema {
    object().req("id", uuid()).strict().build()
}

pub fn identifier(max: usize) -> Schema {
    pattern(1, max, "^[A-Za-z0-9_-]+$")
}

/// `zListQuery`/`zPaginationQuery`: known filters plus `.passthrough()`.
pub fn list_query() -> Schema {
    object()
        .opt("search", text(0, 200))
        .opt("page", coerce_integer(1, i64::MAX))
        .opt("pageSize", coerce_integer(1, 200))
        .opt("sortKey", text(0, 64))
        .opt("sortDirection", enumeration(&["asc", "desc"]))
        .opt("from", text(0, 40))
        .opt("to", text(0, 40))
        .opt("dateFrom", text(0, 40))
        .opt("dateTo", text(0, 40))
        .passthrough()
        .build()
}

pub fn summary_export_query() -> Schema {
    object().opt("checklist", text(0, 1000)).build()
}

fn mutation_reason() -> Schema {
    trimmed(10, 500)
}

fn reason() -> Schema {
    text(3, 500)
}

fn amount() -> Schema {
    pattern(0, 20, r"^\d{1,14}(\.\d{1,4})?$")
}

fn currency() -> Schema {
    pattern(0, 3, "^[A-Z]{3}$")
}

fn mfa_code() -> Schema {
    pattern(0, 6, r"^\d{6}$")
}

fn password() -> Schema {
    crate::schema::password_schema()
}

fn json_object() -> Schema {
    record_any(64)
}

fn base_version() -> Schema {
    integer(1, i64::MAX)
}

fn admin_role() -> Schema {
    enumeration(&[
        "GATEWAY_ADMIN",
        "SECURITY_ADMIN",
        "FINANCE",
        "OPERATOR",
        "COMPLIANCE",
        "MLRO",
        "SUPPORT",
    ])
}

fn gateway_code() -> Schema {
    pattern(2, 64, "^[A-Za-z0-9_-]+$")
}

/* ------------------------------------------------------------------------------ auth */

pub fn login() -> Schema {
    object()
        .req("identifier", text(3, 160))
        .req("password", text(1, 128))
        .strict()
        .build()
}

pub fn mfa() -> Schema {
    object()
        .opt("challengeId", text(4, 128))
        .req("code", mfa_code())
        .strict()
        .build()
}

pub fn accept_invitation() -> Schema {
    object()
        .req("token", text(16, 256))
        .req("password", password())
        .opt(
            "phone",
            crate::schema::trimmed_pattern(6, 20, r"^\+?[0-9 ()-]{6,20}$"),
        )
        .strict()
        .build()
}

pub fn mfa_resend() -> Schema {
    object().req("challengeId", uuid()).strict().build()
}

pub fn password_forgot() -> Schema {
    object().req("email", email()).strict().build()
}

pub fn password_reset() -> Schema {
    object()
        .req("email", email())
        .req("code", pattern(0, 6, r"^\d{6}$"))
        .req("newPassword", password())
        .strict()
        .build()
}

/* ----------------------------------------------------------------------- applications */

pub fn application_patch() -> Schema {
    object()
        .opt("status", enumeration(&["SUSPENDED", "ACTIVE"]))
        .opt("assignedWalletId", uuid())
        .null_opt(
            "railWhitelist",
            array_sized(pattern(0, 64, "^[A-Za-z0-9_.-]+$"), 0, 200),
        )
        .opt(
            "redirectDomainAllowlist",
            array_sized(trimmed(1, 253), 0, 100),
        )
        .req("reason", mutation_reason())
        .opt("checklist", checklist_any(10))
        .strict()
        .require_one_of(
            &[
                "status",
                "assignedWalletId",
                "railWhitelist",
                "redirectDomainAllowlist",
            ],
            "status",
            "at least one change is required",
        )
        .build()
}

pub fn application_token_params() -> Schema {
    object()
        .req("id", uuid())
        .req("tokenId", uuid())
        .strict()
        .build()
}

pub fn application_token_revoke() -> Schema {
    object()
        .req("reason", mutation_reason())
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn payment_link_state() -> Schema {
    object()
        .req("state", literal("CANCELLED"))
        .req("reason", mutation_reason())
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn pos_terminal_status() -> Schema {
    object()
        .req("status", enumeration(&["INACTIVE", "BLOCKED", "ACTIVE"]))
        .req("reason", mutation_reason())
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

/* -------------------------------------------------------------------------- approvals */

fn decision_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "DIFF_REVIEWED",
            "SUBJECT_CONTEXT_REVIEWED",
            "MAKER_CHECKER_SEPARATION_VERIFIED",
            "RISK_ASSESSED",
        ]),
        0,
        10,
    )
}

pub fn approval_decision() -> Schema {
    object()
        .req("reason", reason())
        .opt("checkerUserId", identifier(64))
        .opt("baseVersion", base_version())
        .opt("comment", text(0, 2000))
        .opt("outcome", enumeration(&["WON", "LOST"]))
        .opt("riskAcceptanceNote", text(0, 2000))
        .opt("checklist", decision_checklist())
        .strict()
        .build()
}

pub fn approval_bulk_reject() -> Schema {
    object()
        .req("approvalIds", array_sized(identifier(64), 1, 50))
        .req("reason", reason())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "SELECTION_REVIEWED",
                    "REASONS_DOCUMENTED",
                    "MAKER_NOTIFICATION_PLANNED",
                    "CHECKER_AUTHORITY_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn approval_extend_emergency() -> Schema {
    object()
        .req("days", integer(1, 7))
        .req("reason", reason())
        .strict()
        .build()
}

pub fn approval_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

/* ------------------------------------------------------------------------------ users */

fn user_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "EMAIL_VERIFIED",
            "ROLE_SCOPE_CONFIRMED",
            "AUTHORITIES_REVIEWED",
            "MFA_REQUIREMENT_CONFIRMED",
        ]),
        0,
        10,
    )
}

fn user_edit_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "SELECTION_REVIEWED",
            "STATUS_IMPACT_REVIEWED",
            "NOTIFICATION_PLANNED",
            "AUTHORITY_CONFIRMED",
        ]),
        0,
        10,
    )
}

fn authorities_map() -> Schema {
    record_of(64, array_sized(text(0, 64), 0, 50))
}

pub fn user_create() -> Schema {
    object()
        .req("email", email())
        .opt("fullName", text(2, 120))
        .req("role", admin_role())
        .opt("locale", enumeration(&["ar", "en"]))
        .opt("authorities", authorities_map())
        .opt("checklist", user_checklist())
        .strict()
        .build()
}

pub fn user_patch() -> Schema {
    object()
        .opt("fullName", text(2, 120))
        .opt("role", admin_role())
        .opt(
            "status",
            enumeration(&["INVITED", "ACTIVE", "SUSPENDED", "DISABLED", "LOCKED"]),
        )
        .opt("locale", enumeration(&["ar", "en"]))
        .opt("authorities", authorities_map())
        .opt("baseVersion", base_version())
        .opt("reason", text(3, 500))
        .opt("checklist", user_edit_checklist())
        .strict()
        .build()
}

pub fn user_bulk_patch() -> Schema {
    object()
        .req("userIds", array_sized(identifier(64), 1, 200))
        .opt("role", admin_role())
        .opt(
            "status",
            enumeration(&["INVITED", "ACTIVE", "SUSPENDED", "DISABLED", "LOCKED"]),
        )
        .opt("reason", text(3, 500))
        .opt("baseVersion", base_version())
        .opt("checklist", user_edit_checklist())
        .strict()
        .build()
}

pub fn user_invite() -> Schema {
    object()
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "IDENTITY_VERIFIED",
                    "INVITATION_EXPIRY_REVIEWED",
                    "DELIVERY_CHANNEL_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn user_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

/* ------------------------------------------------------------------------- merchants */

fn merchant_suspend_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "IMPACT_REVIEWED",
            "REASON_DOCUMENTED",
            "NOTIFICATION_PLANNED",
            "WALLET_DISPUTE_CHECKED",
        ]),
        0,
        10,
    )
}

pub fn merchant_suspend() -> Schema {
    object()
        .opt(
            "reasonCode",
            enumeration(&[
                "AML",
                "FRAUD",
                "KYB_EXPIRED",
                "COMMISSION_CEILING",
                "MERCHANT_REQUEST",
                "OTHER",
            ]),
        )
        .opt("reason", reason())
        .opt("notes", text(0, 2000))
        .opt("emergency", boolean())
        .opt("ratifyWithinHours", integer(1, 168))
        .opt("baseVersion", base_version())
        .opt("checklist", merchant_suspend_checklist())
        .strict()
        .require_one_of(
            &["reasonCode", "reason"],
            "reasonCode",
            "A suspension reason is required",
        )
        .build()
}

pub fn merchant_reinstate() -> Schema {
    object()
        .req("reason", reason())
        .opt("baseVersion", base_version())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "COMPLIANCE_CLEARANCE_VERIFIED",
                    "OUTSTANDING_ITEMS_RESOLVED",
                    "WALLET_DISPUTE_CHECKED",
                    "REASON_DOCUMENTED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn json_patch() -> Schema {
    array_sized(
        object()
            .req(
                "op",
                enumeration(&["add", "remove", "replace", "move", "copy", "test"]),
            )
            .req("path", text(1, 512))
            .opt("value", any())
            .opt("from", text(1, 512))
            .strict()
            .build(),
        1,
        200,
    )
}

pub fn merchant_propose_edit() -> Schema {
    object()
        .req("reason", reason())
        .req("patch", json_patch())
        .req("baseVersion", base_version())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "PATCH_REVIEWED",
                    "SOURCE_DOCUMENT_VERIFIED",
                    "MAKER_REASON_DOCUMENTED",
                    "CHECKER_SCOPE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn merchant_descriptive() -> Schema {
    object()
        .opt("tradeName", text(2, 200))
        .opt("displayName", text(0, 200))
        .opt("logoUrl", crate::schema::url_text(500))
        .opt("supportEmail", email())
        .opt("supportPhone", text(6, 40))
        .opt("baseVersion", base_version())
        .opt("reason", text(0, 2000))
        .strict()
        .require_one_of(
            &[
                "tradeName",
                "displayName",
                "logoUrl",
                "supportEmail",
                "supportPhone",
            ],
            "tradeName",
            "At least one descriptive field is required",
        )
        .build()
}

pub fn merchant_close() -> Schema {
    object()
        .req(
            "reasonCode",
            enumeration(&["MERCHANT_REQUEST", "COMPLIANCE", "BUSINESS_CLOSED", "OTHER"]),
        )
        .opt("notes", text(0, 2000))
        .opt("baseVersion", base_version())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "BALANCE_ZERO_VERIFIED",
                    "OPEN_DISPUTES_CLEARED",
                    "CASHOUTS_CLEARED",
                    "IRREVERSIBLE_ACKNOWLEDGED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn merchant_withdraw() -> Schema {
    object().opt("reason", text(3, 2000)).strict().build()
}

pub fn merchant_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

pub fn merchant_bulk_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("approvalId", identifier(64))
        .strict()
        .build()
}

fn owner_create() -> Schema {
    object()
        .req("fullName", trimmed(2, 160))
        .opt("fullNameEn", trimmed(2, 160))
        .req("identityType", enumeration(&["NATIONAL_ID", "PASSPORT"]))
        .req("identityNumber", trimmed(4, 32))
        .opt("nationality", text(2, 2))
        .opt("dateOfBirth", date())
        .opt(
            "ownershipPercent",
            pattern(0, 6, r"^\d{1,3}(?:\.\d{1,2})?$"),
        )
        .opt(
            "role",
            enumeration(&["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]),
        )
        .opt("pepDeclared", boolean())
        .opt("position", trimmed(2, 80))
        .strict()
        .build()
}

pub fn beneficial_owner_create() -> Schema {
    owner_create()
}

pub fn beneficial_owner_patch() -> Schema {
    object()
        .opt("fullName", trimmed(2, 160))
        .opt("fullNameEn", trimmed(2, 160))
        .opt("identityType", enumeration(&["NATIONAL_ID", "PASSPORT"]))
        .opt("identityNumber", trimmed(4, 32))
        .opt("nationality", text(2, 2))
        .opt("dateOfBirth", date())
        .opt(
            "ownershipPercent",
            pattern(0, 6, r"^\d{1,3}(?:\.\d{1,2})?$"),
        )
        .opt(
            "role",
            enumeration(&["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]),
        )
        .opt("pepDeclared", boolean())
        .opt("position", trimmed(2, 80))
        .strict()
        .require_one_of(
            &[
                "fullName",
                "fullNameEn",
                "identityType",
                "identityNumber",
                "nationality",
                "dateOfBirth",
                "ownershipPercent",
                "role",
                "pepDeclared",
                "position",
            ],
            "fullName",
            "at least one field is required",
        )
        .build()
}

pub fn owner_params() -> Schema {
    object()
        .req("id", uuid())
        .req("ownerId", uuid())
        .strict()
        .build()
}

pub fn merchant_revalidation() -> Schema {
    object()
        .req(
            "docType",
            enumeration(&[
                "COMMERCIAL_REGISTRY",
                "TAX_CERTIFICATE",
                "ARTICLES_OF_ASSOCIATION",
                "OWNER_ID",
                "SIGNATORY_ID",
                "PROOF_OF_ADDRESS",
                "BANK_LETTER",
                "SECTOR_LICENSE",
                "OTHER",
            ]),
        )
        .req("dueAt", trimmed(10, 64))
        .req("message", trimmed(3, 1000))
        .opt("reasonCode", trimmed(1, 64))
        .strict()
        .build()
}

/* --------------------------------------------------------------------- join requests */

pub fn join_request_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

pub fn join_request_owner_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("ownerId", identifier(64))
        .strict()
        .build()
}

pub fn join_request_document_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("docId", identifier(64))
        .strict()
        .build()
}

pub fn join_request_assign() -> Schema {
    object()
        .req("assigneeUserId", identifier(64))
        .opt("dueAt", text(0, 64))
        .opt("note", text(0, 1000))
        .strict()
        .build()
}

pub fn join_request_request_info() -> Schema {
    object()
        .req("requestedItems", array_sized(text(1, 160), 1, 50))
        .req("message", text(3, 2000))
        .opt("dueAt", text(0, 64))
        .strict()
        .build()
}

pub fn join_request_decide() -> Schema {
    object()
        .req(
            "decision",
            enumeration(&[
                "APPROVE",
                "REJECT",
                "APPROVED",
                "REJECTED",
                "REQUEST_INFO",
                "WITHDRAW",
            ]),
        )
        .opt("reason", reason())
        .opt("reasonCode", text(0, 64))
        .opt("notes", text(0, 4000))
        .opt("checklist", record_of(64, boolean()))
        .opt(
            "proposedRiskTier",
            enumeration(&["LOW", "STANDARD", "HIGH"]),
        )
        .opt("checkerUserId", identifier(64))
        .opt("baseVersion", base_version())
        .strict()
        .require_one_of(
            &["reason", "reasonCode"],
            "reason",
            "a reason or reasonCode is required",
        )
        .build()
}

pub fn join_request_checklist() -> Schema {
    object()
        .req("items", record_of(80, boolean()))
        .strict()
        .build()
}

pub fn admin_assisted() -> Schema {
    record_any(1000)
}

/* ------------------------------------------------------------------------ kyb review */

pub fn kyb_review() -> Schema {
    object()
        .req(
            "decision",
            enumeration(&["ACCEPT", "REJECT", "ACCEPTED", "REJECTED"]),
        )
        .opt("reasonCode", text(2, 64))
        .opt("notes", text(0, 2000))
        .opt("checklist", array_sized(text(1, 160), 0, 50))
        .opt("duplicateJustification", text(0, 4000))
        .opt("expiresOn", date())
        .strict()
        .build()
}

pub fn kyb_replacement() -> Schema {
    object()
        .opt("reasonCode", text(2, 64))
        .req("message", text(5, 2000))
        .strict()
        .build()
}

pub fn kyb_revalidation() -> Schema {
    object()
        .opt("reasonCode", text(2, 64))
        .req("message", text(5, 2000))
        .opt("dueAt", datetime())
        .strict()
        .build()
}

pub fn kyb_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

/* --------------------------------------------------------------------------- gateways */

pub fn gateway_create() -> Schema {
    object()
        .req("code", gateway_code())
        .req("name", text(2, 160))
        .opt("description", text(0, 2000))
        .opt("category", text(2, 64))
        .opt("country", text(2, 2))
        .opt(
            "evidenceLevel",
            enumeration(&["VERIFIED", "PARTIAL", "INTERNAL"]),
        )
        .opt("active", boolean())
        .opt("operator", text(2, 160))
        .opt(
            "kind",
            enumeration(&["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]),
        )
        .opt("aliases", array_sized(text(1, 64), 0, 20))
        .opt("riskClass", enumeration(&["NORMAL", "HIGH_RISK"]))
        .strict()
        .build()
}

pub fn gateway_patch() -> Schema {
    object()
        .opt("code", gateway_code())
        .opt("name", text(2, 160))
        .opt("description", text(0, 2000))
        .opt("category", text(2, 64))
        .opt("country", text(2, 2))
        .opt(
            "kind",
            enumeration(&["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]),
        )
        .opt(
            "evidenceLevel",
            enumeration(&["VERIFIED", "PARTIAL", "INTERNAL"]),
        )
        .opt("active", boolean())
        .opt("baseVersion", base_version())
        .opt("operator", text(2, 160))
        .opt("aliases", array_sized(text(1, 64), 0, 20))
        .opt("riskClass", enumeration(&["NORMAL", "HIGH_RISK"]))
        .strict()
        .build()
}

pub fn gateway_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

pub fn version_id_params() -> Schema {
    object().req("vid", identifier(64)).build()
}

pub fn version_create() -> Schema {
    object()
        .req("version", coerce_integer(1, 100_000))
        .opt("basedOnVersionId", identifier(64))
        .opt("changelog", text(0, 2000))
        .opt("active", boolean())
        .opt("snapshot", json_object())
        .strict()
        .build()
}

pub fn version_clone() -> Schema {
    object().opt("changelog", text(0, 1000)).strict().build()
}

fn environment_entry() -> Schema {
    object()
        .opt("code", text(1, 32))
        .opt("env", enumeration(&["SANDBOX", "LIVE"]))
        .opt("baseUrl", text(1, 300))
        .opt("allowedHosts", array_sized(text(0, 200), 0, 20))
        .opt("inboundIpAllowlist", array_sized(text(0, 64), 0, 50))
        .opt("outboundEgressIps", array_sized(text(0, 64), 0, 50))
        .opt("active", boolean())
        .opt("enabled", boolean())
        .opt("timeoutMs", integer(100, 120_000))
        .passthrough()
        .build()
}

pub fn gateway_environments() -> Schema {
    object()
        .req("environments", array_sized(environment_entry(), 1, 10))
        .opt("env", enumeration(&["SANDBOX", "LIVE"]))
        .passthrough()
        .build()
}

pub fn gateway_auth() -> Schema {
    object()
        .opt(
            "authMethod",
            enumeration(&[
                "NONE",
                "API_KEY",
                "PERMANENT_TOKEN",
                "TOKEN_ENDPOINT",
                "REFRESH_TOKEN",
                "USERNAME_PASSWORD",
                "BASIC",
                "REQUEST_SIGNATURE",
                "OAUTH2_CLIENT_CREDENTIALS",
                "MUTUAL_TLS",
            ]),
        )
        .opt("auth", json_object())
        .opt("credentialSetId", identifier(64))
        .opt("settings", json_object())
        .opt("env", enumeration(&["SANDBOX", "LIVE"]))
        .opt("authApply", enumeration(&["HEADER", "QUERY", "BODY"]))
        .passthrough()
        .build()
}

pub fn gateway_settings() -> Schema {
    object()
        .opt("settings", json_object())
        .opt("timeoutMs", integer(100, 120_000))
        .opt("retries", integer(0, 10))
        .passthrough()
        .build()
}

pub fn gateway_crypto_profiles() -> Schema {
    object()
        .req(
            "cryptoProfiles",
            array_sized(
                object()
                    .opt("code", text(1, 64))
                    .opt("name", text(1, 64))
                    .opt(
                        "algorithm",
                        enumeration(&[
                            "HMAC_SHA256",
                            "HMAC_SHA512",
                            "RSA_SHA256",
                            "SHA256",
                            "PLAIN",
                            "NONE",
                        ]),
                    )
                    .opt("encoding", text(0, 64))
                    .opt("keyEncoding", text(0, 32))
                    .opt("canonicalization", text(0, 64))
                    .opt("secretRef", text(0, 128))
                    .opt("fields", array_sized(text(0, 64), 0, 50))
                    .opt("purpose", enumeration(&["OUTBOUND_SIGN", "INBOUND_VERIFY"]))
                    .opt(
                        "direction",
                        enumeration(&["OUTBOUND_SIGN", "INBOUND_VERIFY"]),
                    )
                    .opt("toleranceSeconds", integer(0, 86_400))
                    .passthrough()
                    .build(),
                1,
                20,
            ),
        )
        .passthrough()
        .build()
}

pub fn gateway_flows() -> Schema {
    object()
        .req(
            "flows",
            array_sized(
                object()
                    .opt("code", text(1, 64))
                    .opt("name", text(1, 160))
                    .opt("phase", text(2, 64))
                    .opt("phases", array_sized(text(2, 64), 0, 30))
                    .opt("steps", array_sized(json_object(), 0, 200))
                    .opt("amountPipeline", array_sized(json_object(), 0, 50))
                    .passthrough()
                    .build(),
                1,
                50,
            ),
        )
        .passthrough()
        .build()
}

pub fn gateway_channels() -> Schema {
    object()
        .opt("clientActions", array_sized(json_object(), 0, 20))
        .opt("confirmationChannels", array_sized(json_object(), 0, 20))
        .opt("pollPolicies", array_sized(json_object(), 0, 20))
        .passthrough()
        .build()
}

pub fn gateway_status_rules() -> Schema {
    object()
        .req("statusRules", array_sized(json_object(), 1, 100))
        .passthrough()
        .build()
}

pub fn gateway_error_maps() -> Schema {
    object()
        .req("errorMaps", array_sized(json_object(), 1, 100))
        .passthrough()
        .build()
}

fn gateway_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "CREDENTIAL_REFS_VERIFIED",
            "ENVIRONMENT_MATCH_REVIEWED",
            "SECRET_STORAGE_VERIFIED",
            "CREDENTIAL_CHECK_APPROVED",
            "PHASE_SELECTED",
            "SAMPLE_PAYLOAD_REVIEWED",
            "CREDENTIAL_CONTEXT_READY",
            "RESULT_INTERPRETATION_REVIEWED",
        ]),
        0,
        10,
    )
}

pub fn gateway_dry_run() -> Schema {
    object()
        .opt("scenario", text(2, 64))
        .opt("phase", text(0, 64))
        .opt("credentialSets", array_sized(record_any(64), 0, 40))
        .opt("payload", json_object())
        .opt("dryRun", boolean())
        .opt("checklist", gateway_checklist())
        .strict()
        .build()
}

pub fn gateway_run_suite() -> Schema {
    object()
        .req(
            "suite",
            enumeration(&[
                "SANDBOX_15",
                "CONTRACT_AMOUNT",
                "CONTRACT_REFERENCE",
                "CONTRACT_SIGNATURE",
            ]),
        )
        .opt(
            "environment",
            enumeration(&["sandbox", "test", "uat", "live"]),
        )
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "SUITE_SELECTED",
                    "SANDBOX_ENV_VERIFIED",
                    "EVIDENCE_CAPTURE_READY",
                    "RESULTS_REVIEW_PLANNED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn gateway_submit_approval() -> Schema {
    object()
        .req("reason", text(3, 500))
        .opt("baseVersion", base_version())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "GATES_REVIEWED",
                    "EVIDENCE_VERIFIED",
                    "ROLLBACK_READY",
                    "CHECKER_INDEPENDENCE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn gateway_rollback() -> Schema {
    object()
        .req("targetVersionId", identifier(64))
        .req("reason", text(3, 500))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "TARGET_VERSION_VERIFIED",
                    "GATES_VERIFIED",
                    "IMPACT_REVIEWED",
                    "ROLLBACK_AUTHORITY_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn gateway_ai_transcript() -> Schema {
    object()
        .opt(
            "railKind",
            enumeration(&[
                "OTP_PULL",
                "REDIRECT",
                "EMBEDDED",
                "QR_DISPLAY",
                "PUSH_APPROVAL",
                "HYBRID",
            ]),
        )
        .strict()
        .build()
}

pub fn gateway_spec_verify() -> Schema {
    object().req("spec", any()).strict().build()
}

pub fn gateway_spec_import() -> Schema {
    object()
        .req("spec", any())
        .opt("credentialsValues", record_of(64, text(0, 4096)))
        .opt("credentials_values", record_of(64, text(0, 4096)))
        .opt("mode", enumeration(&["CREATE_NEW", "NEW_VERSION"]))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "SPEC_VERIFIED",
                    "CREDENTIALS_VERIFIED",
                    "IMPORT_MODE_REVIEWED",
                    "NO_SECRET_EXPOSURE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn gateway_export_query() -> Schema {
    object()
        .opt("search", text(0, 200))
        .opt("page", coerce_integer(1, i64::MAX))
        .opt("pageSize", coerce_integer(1, 200))
        .opt("sortKey", text(0, 64))
        .opt("sortDirection", enumeration(&["asc", "desc"]))
        .opt("from", text(0, 40))
        .opt("to", text(0, 40))
        .opt("dateFrom", text(0, 40))
        .opt("dateTo", text(0, 40))
        .opt("checklist", text(0, 1000))
        .passthrough()
        .build()
}

/* ------------------------------------------------------------------------------ rails */

fn rail_create_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "NAMES_VERIFIED",
            "LIMITS_VERIFIED",
            "INSTRUCTIONS_REVIEWED",
            "AVAILABILITY_IMPACT_REVIEWED",
        ]),
        0,
        10,
    )
}

pub fn rail_create() -> Schema {
    object()
        .req("code", pattern(2, 64, "^[A-Za-z0-9_-]+$"))
        .opt("name", text(1, 160))
        .opt("nameAr", text(1, 160))
        .opt("nameEn", text(1, 160))
        .opt("gatewayId", identifier(64))
        .req(
            "collectionMode",
            enumeration(&[
                "OTP_PULL",
                "REDIRECT",
                "EMBEDDED",
                "PUSH_APPROVAL",
                "QR_DISPLAY",
                "PAY_CODE",
                "DEEP_LINK",
                "MANUAL",
                "HYBRID",
                "QR",
                "PUSH",
                "TRANSFER",
                "CASH",
            ]),
        )
        .opt("subModes", array_sized(text(1, 64), 0, 20))
        .opt("feeBearer", enumeration(&["PAYER", "MERCHANT", "PLATFORM"]))
        .opt("active", boolean())
        .opt("labels", record_of(16, text(0, 160)))
        .opt("currency", text(3, 3))
        .opt("minAmount", amount())
        .opt("maxAmount", amount())
        .opt(
            "capabilities",
            either_union(vec![
                array_sized(text(0, 40), 0, 50),
                record_of(40, boolean()),
            ]),
        )
        .passthrough()
        .build()
}

fn either_union(options: Vec<Schema>) -> Schema {
    crate::schema::either(options)
}

pub fn rail_patch() -> Schema {
    object()
        .opt("name", text(1, 160))
        .opt("nameAr", text(1, 160))
        .opt("nameEn", text(1, 160))
        .opt("subModes", array_sized(text(1, 64), 0, 20))
        .opt("feeBearer", enumeration(&["PAYER", "MERCHANT", "PLATFORM"]))
        .opt("active", boolean())
        .opt("labels", record_of(16, text(0, 160)))
        .opt("currency", text(3, 3))
        .opt("minAmount", amount())
        .opt("maxAmount", amount())
        .opt("displayOrder", integer(0, 9999))
        .opt(
            "capabilities",
            either_union(vec![
                array_sized(text(0, 40), 0, 50),
                record_of(40, boolean()),
            ]),
        )
        .opt("instructionsAr", text(0, 2000))
        .opt("instructionsEn", text(0, 2000))
        .null_opt("logoAssetId", uuid())
        .opt("baseVersion", base_version())
        .opt("checklist", rail_create_checklist())
        .passthrough()
        .build()
}

pub fn rail_fields() -> Schema {
    object()
        .req(
            "fields",
            array_sized(
                object()
                    .opt("code", text(1, 64))
                    .opt("key", text(1, 64))
                    .opt("fieldKey", text(1, 64))
                    .opt("label", text(1, 160))
                    .opt("labelAr", text(1, 160))
                    .opt("labelEn", text(1, 160))
                    .opt("type", text(1, 32))
                    .opt("inputType", text(1, 32))
                    .opt("required", boolean())
                    .opt("pattern", text(0, 200))
                    .opt("regex", text(0, 200))
                    .null_opt("minLength", integer(0, 64))
                    .null_opt("maxLength", integer(1, 256))
                    .opt("sensitive", boolean())
                    .opt("sensitivity", enumeration(&["NORMAL", "SENSITIVE", "PAN"]))
                    .opt(
                        "normalizer",
                        either_union(vec![text(0, 64), record_any(64)]),
                    )
                    .opt("options", array_sized(text(0, 160), 0, 100))
                    .opt("order", integer(0, 100))
                    .opt("orderIndex", integer(0, 100))
                    .passthrough()
                    .build(),
                1,
                50,
            ),
        )
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "FIELD_CODES_VERIFIED",
                    "VALIDATION_RULES_REVIEWED",
                    "SENSITIVITY_REVIEWED",
                    "CHECKOUT_IMPACT_REVIEWED",
                ]),
                0,
                10,
            ),
        )
        .passthrough()
        .build()
}

pub fn rail_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

pub fn route_create() -> Schema {
    object()
        .req("railId", identifier(64))
        .opt("gatewayId", identifier(64))
        .req(
            "environment",
            enumeration(&["sandbox", "test", "uat", "live"]),
        )
        .opt("priority", integer(0, 10_000))
        .opt("costModel", json_object())
        .opt("limitAmount", amount())
        .opt("limitCurrency", currency())
        .opt("active", boolean())
        .opt(
            "credentialPolicy",
            enumeration(&["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"]),
        )
        .strict()
        .build()
}

fn route_checklist() -> Schema {
    array_sized(
        enumeration(&[
            "PRIORITY_WEIGHT_REVIEWED",
            "LIMITS_CAP_VERIFIED",
            "SCOPE_COST_REVIEWED",
            "ROUTING_IMPACT_REVIEWED",
        ]),
        0,
        10,
    )
}

pub fn route_patch() -> Schema {
    object()
        .opt("priority", integer(0, 9999))
        .opt("weight", integer(1, 1000))
        .opt("costModel", json_object())
        .opt("scope", json_object())
        .opt("limitAmount", amount())
        .opt("minAmount", amount())
        .opt("maxAmount", amount())
        .opt("dailyCapAmount", amount())
        .opt("limitCurrency", currency())
        .opt("mismatchPolicy", json_object())
        .opt(
            "maintenanceWindows",
            array_sized(
                object()
                    .req("start", text(10, 64))
                    .req("end", text(10, 64))
                    .passthrough()
                    .build(),
                0,
                50,
            ),
        )
        .opt("baseVersion", base_version())
        .opt("checklist", route_checklist())
        .strict()
        .build()
}

pub fn route_health_override() -> Schema {
    object()
        .req(
            "state",
            enumeration(&["HEALTHY", "DEGRADED", "OPEN_BREAKER"]),
        )
        .req("reason", trimmed(10, 500))
        .opt("expiresAt", datetime())
        .opt("evidence", any())
        .strict()
        .build()
}

pub fn route_health_clear() -> Schema {
    object().req("reason", trimmed(10, 500)).strict().build()
}

pub fn route_state() -> Schema {
    object()
        .opt("status", enumeration(&["ACTIVE", "PAUSED", "DRAINING"]))
        .opt("state", enumeration(&["ACTIVE", "PAUSED", "DRAINING"]))
        .opt("reason", text(3, 500))
        .opt("checklist", route_checklist())
        .strict()
        .require_one_of(&["status", "state"], "status", "status is required")
        .build()
}

/* ----------------------------------------------------------------------------- assets */

pub fn asset_create() -> Schema {
    object()
        .req(
            "kind",
            enumeration(&["LOGO", "ICON", "DOCUMENT", "QR_TEMPLATE", "STATIC_FILE"]),
        )
        .req("name", text(1, 160))
        .req("contentType", text(3, 120))
        .req("storageKey", text(1, 400))
        .opt("sizeBytes", integer(0, 104_857_600))
        .opt("checksumSha256", pattern(0, 64, "^[a-f0-9]{64}$"))
        .opt("metadata", record_any(64))
        .strict()
        .build()
}

/* --------------------------------------------------------------------- operator cases */

pub fn operator_case_resolve() -> Schema {
    object()
        .req(
            "action",
            enumeration(&["MARK_SUCCEEDED", "MARK_FAILED", "CLOSE_CASE"]),
        )
        .req("reason", reason())
        .opt("notes", text(0, 2000))
        .opt("providerReference", text(1, 191))
        .opt("settledAmount", amount())
        .opt(
            "resolutionCode",
            enumeration(&[
                "FIXED_AT_SOURCE",
                "FALSE_POSITIVE",
                "DUPLICATE",
                "ACCEPTED_RISK",
                "REFERRED",
                "NO_ACTION_REQUIRED",
                "SOURCE_CLEARED",
                "OTHER",
            ]),
        )
        .opt("reference", text(1, 191))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "EVIDENCE_REVIEWED",
                    "ATTEMPT_STATUS_VERIFIED",
                    "OUTCOME_DOCUMENTED",
                    "CHECKER_REQUIREMENT_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn bulk_inquire() -> Schema {
    object()
        .req("caseIds", array_sized(identifier(64), 1, 200))
        .opt("reason", text(0, 500))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "ELIGIBILITY_REVIEWED",
                    "ATTEMPT_STATUS_VERIFIED",
                    "GATEWAY_SUPPORT_CONFIRMED",
                    "INQUIRY_SCOPE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn bulk_assign() -> Schema {
    object()
        .req("caseIds", array_sized(identifier(64), 1, 200))
        .null_opt("assigneeUserId", identifier(64))
        .opt("reason", text(0, 500))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "ASSIGNEE_VERIFIED",
                    "WORKLOAD_REVIEWED",
                    "NOTIFICATION_PLANNED",
                    "CASE_SCOPE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn bulk_state() -> Schema {
    object()
        .req("caseIds", array_sized(identifier(64), 1, 200))
        .req("state", enumeration(&["OPEN", "IN_PROGRESS"]))
        .opt("reason", text(0, 500))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "CASE_SCOPE_CONFIRMED",
                    "STATE_IMPACT_REVIEWED",
                    "SLA_IMPACT_REVIEWED",
                    "NOTIFICATION_PLANNED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn gateway_inquiry_cancel() -> Schema {
    object()
        .req("reason", trimmed(3, 500))
        .opt("checklist", array_sized(text(1, 64), 0, 10))
        .strict()
        .build()
}

pub fn gateway_inquiry_action() -> Schema {
    object()
        .opt("reason", trimmed(0, 500))
        .opt("checklist", array_sized(text(1, 64), 0, 10))
        .strict()
        .build()
}

pub fn operator_case_patch() -> Schema {
    object()
        .null_opt("assigneeUserId", identifier(64))
        .opt("state", enumeration(&["OPEN", "IN_PROGRESS"]))
        .strict()
        .build()
}

pub fn operator_case_acknowledge() -> Schema {
    object()
        .opt("notes", text(0, 2000))
        .opt("reason", text(0, 500))
        .strict()
        .build()
}

pub fn attempt_inquire() -> Schema {
    object()
        .opt("reason", trimmed(10, 500))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn operator_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

/* ----------------------------------------------------------------------- reconciliation */

pub fn reconciliation_source_create() -> Schema {
    object()
        .req("code", pattern(2, 64, "^[A-Za-z0-9_-]+$"))
        .req("name", text(2, 160))
        .opt("gatewayId", identifier(64))
        .req("fileType", enumeration(&["CSV", "XLSX", "JSON"]))
        .opt("delimiter", enumeration(&[",", ";", "|", "\t"]))
        .opt("hasHeader", boolean())
        .opt("columnMapping", record_of(64, text(0, 64)))
        .opt("dateFormat", text(0, 64))
        .opt("currency", pattern(0, 3, "^[A-Z]{3}$"))
        .opt("env", text(0, 16))
        .opt("credentialSetId", uuid())
        .opt("active", boolean())
        .opt("type", enumeration(&["API", "SFTP", "UPLOAD"]))
        .strict()
        .build()
}

pub fn reconciliation_source_patch() -> Schema {
    object()
        .require_one_of(
            &[
                "scheduleCron",
                "settlementLagDays",
                "dedupeKeyTemplate",
                "parserConfig",
                "active",
            ],
            "",
            "At least one field is required",
        )
        .null_opt("scheduleCron", text(0, 120))
        .opt("settlementLagDays", integer(0, 365))
        .null_opt("dedupeKeyTemplate", text(0, 200))
        .opt("parserConfig", record_any(64))
        .opt("active", boolean())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "PARSER_CONFIG_REVIEWED",
                    "SCHEDULE_LAG_VERIFIED",
                    "DEDUPE_TEMPLATE_REVIEWED",
                    "SOURCE_IMPACT_REVIEWED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn reconciliation_upload() -> Schema {
    object()
        .req("sourceId", identifier(64))
        .req("periodStart", text(0, 64))
        .req("periodEnd", text(0, 64))
        .opt("currency", pattern(0, 3, "^[A-Z]{3}$"))
        .opt("autoPost", boolean())
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "SOURCE_VERIFIED",
                    "FILE_REVIEWED",
                    "PERIOD_VERIFIED",
                    "DUPLICATE_CHECK_ACKNOWLEDGED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn reconciliation_source_params() -> Schema {
    object().req("id", identifier(64)).strict().build()
}

/* -------------------------------------------------------------------------- finance */

pub fn dispute_create() -> Schema {
    object()
        .req("merchantId", identifier(64))
        .opt("gatewayId", identifier(64))
        .req("paymentReference", text(1, 140))
        .req("externalDisputeRef", text(1, 140))
        .req(
            "type",
            enumeration(&[
                "CHARGEBACK",
                "REPRESENTMENT",
                "PRE_ARBITRATION",
                "REFUND_REQUEST",
            ]),
        )
        .req("amount", amount())
        .req("currency", currency())
        .req("reason", text(3, 500))
        .opt("dueAt", text(0, 64))
        .opt("railId", identifier(64))
        .opt("source", enumeration(&["WEBHOOK", "STATEMENT", "MANUAL"]))
        .strict()
        .build()
}

pub fn dispute_evidence() -> Schema {
    object()
        .req("evidence", json_object())
        .opt("notes", text(0, 2000))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "EVIDENCE_REFERENCE_VERIFIED",
                    "SUPPORTING_DOCUMENTS_ATTACHED",
                    "EVIDENCE_WINDOW_VERIFIED",
                    "SUMMARY_REVIEWED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn adjustment_create() -> Schema {
    object()
        .opt("disputeId", identifier(64))
        .opt("merchantId", identifier(64))
        .opt("attemptId", identifier(64))
        .req(
            "type",
            enumeration(&[
                "CHARGEBACK",
                "REFUND",
                "MANUAL_CREDIT",
                "MANUAL_DEBIT",
                "CORRECTION",
                "FEE_VARIANCE",
                "RECOVERY",
                "WRITEOFF",
            ]),
        )
        .req("amount", amount())
        .opt("currency", currency())
        .opt("reason", reason())
        .opt("reasonCode", text(0, 64))
        .opt("notes", text(0, 2000))
        .opt("reverseCommission", boolean())
        .opt("draft", boolean())
        .req("targetGlAccountId", identifier(64))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "TARGET_ACCOUNT_VERIFIED",
                    "AMOUNT_CURRENCY_VERIFIED",
                    "REASON_DOCUMENTED",
                    "SOURCE_LINKAGE_VERIFIED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .require_one_of(
            &["reason", "reasonCode"],
            "reason",
            "a reason or reasonCode is required",
        )
        .build()
}

pub fn cashout_process() -> Schema {
    object()
        .req("decision", enumeration(&["APPROVE", "REJECT", "HOLD"]))
        .opt("reason", reason())
        .opt("amount", amount())
        .opt("currency", currency())
        .opt("executedBy", identifier(64))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "BANK_DETAILS_VERIFIED",
                    "WALLET_BALANCE_VERIFIED",
                    "MERCHANT_ACTIVE",
                    "NO_AML_RESTRICTIONS",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn commission_profile_create() -> Schema {
    object()
        .req("code", pattern(2, 64, "^[A-Za-z0-9_-]+$"))
        .req("name", text(2, 160))
        .req(
            "model",
            enumeration(&["FLAT", "PERCENTAGE", "TIERED", "MIXED"]),
        )
        .opt("percentage", pattern(0, 20, r"^\d{1,3}(\.\d{1,4})?$"))
        .opt("flatAmount", amount())
        .opt("tiers", array_sized(record_any(64), 0, 20))
        .opt("minFee", amount())
        .opt("maxFee", amount())
        .opt(
            "feeBearerDefault",
            enumeration(&["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"]),
        )
        .opt(
            "roundingMode",
            enumeration(&["HALF_UP", "HALF_EVEN", "FLOOR", "CEIL"]),
        )
        .opt("merchantId", uuid())
        .opt("applicationId", uuid())
        .opt("currency", currency())
        .opt("active", boolean())
        .opt("railCode", text(1, 64))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn commission_profile_expire() -> Schema {
    object()
        .opt("effectiveTo", text(0, 64))
        .opt("reason", text(0, 500))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn velocity_rule_create() -> Schema {
    object()
        .req("code", pattern(2, 64, "^[A-Za-z0-9_-]+$"))
        .req("name", text(2, 160))
        .req(
            "scope",
            enumeration(&["MERCHANT", "APPLICATION", "LINK", "IP", "DEVICE"]),
        )
        .req("windowSeconds", integer(1, 86_400))
        .req("maxAttempts", integer(1, 100_000))
        .opt("maxAmount", amount())
        .opt("currency", currency())
        .req(
            "action",
            enumeration(&["BLOCK", "REVIEW", "THROTTLE", "CHALLENGE"]),
        )
        .opt("active", boolean())
        .opt(
            "scopeType",
            enumeration(&[
                "END_CLIENT_IP",
                "END_CLIENT_PHONE",
                "END_CLIENT_CARD",
                "MERCHANT",
                "APPLICATION",
                "RAIL",
                "LINK",
            ]),
        )
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn velocity_rule_deactivate() -> Schema {
    object()
        .opt("reason", text(0, 500))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn finance_period_query() -> Schema {
    object()
        .opt(
            "period",
            enumeration(&["today", "last_7d", "last_30d", "last_90d"]),
        )
        .opt("from", text(0, 64))
        .opt("to", text(0, 64))
        .opt("currency", currency())
        .strict()
        .build()
}

pub fn finance_period_export_query() -> Schema {
    object()
        .opt(
            "period",
            enumeration(&["today", "last_7d", "last_30d", "last_90d"]),
        )
        .opt("from", text(0, 64))
        .opt("to", text(0, 64))
        .opt("currency", currency())
        .opt("checklist", text(0, 1000))
        .strict()
        .build()
}

pub fn shard_params() -> Schema {
    object()
        .req("id", uuid())
        .req("shardId", coerce_integer(0, 255))
        .strict()
        .build()
}

pub fn shard_repair() -> Schema {
    object()
        .req("reason", mutation_reason())
        .req("planHash", pattern(0, 64, "^[0-9a-f]{64}$"))
        .strict()
        .build()
}

pub fn shard_scale() -> Schema {
    object()
        .req("width", integer(1, 256))
        .req("reason", mutation_reason())
        .strict()
        .build()
}

pub fn gl_checkpoint() -> Schema {
    object()
        .req("reason", mutation_reason())
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn finance_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

pub fn attachment_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("attachmentId", identifier(64))
        .build()
}

pub fn evidence_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("evidenceId", identifier(64))
        .build()
}

/* ------------------------------------------------------------------------------- aml */

fn aml_confidential() -> Schema {
    array_sized(
        enumeration(&[
            "MATCH_DETAILS_REVIEWED",
            "IDENTITY_EVIDENCE_CHECKED",
            "DISPOSITION_RATIONALE_DOCUMENTED",
            "ESCALATION_PATH_CONFIRMED",
        ]),
        0,
        10,
    )
}

pub fn aml_disposition() -> Schema {
    object()
        .req(
            "disposition",
            enumeration(&["FALSE_POSITIVE", "CONFIRMED_MATCH", "PENDING", "ESCALATED"]),
        )
        .req("notes", text(3, 2000))
        .opt("caseId", identifier(64))
        .opt("checklist", aml_confidential())
        .strict()
        .build()
}

pub fn aml_case_propose() -> Schema {
    object()
        .req(
            "severity",
            enumeration(&["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        )
        .req(
            "action",
            enumeration(&[
                "CASE_ONLY",
                "AML_HOLD",
                "BLOCK",
                "REPORT",
                "RELEASE",
                "REJECT",
            ]),
        )
        .req("reason", reason())
        .opt("notes", text(0, 2000))
        .opt("reportingRuleId", identifier(64))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "EVIDENCE_REVIEWED",
                    "SUBJECT_IDENTIFIED",
                    "REGULATORY_OBLIGATION_ASSESSED",
                    "CHECKER_INDEPENDENCE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn aml_rule() -> Schema {
    object()
        .req("code", text(2, 64))
        .req("name", text(2, 160))
        .req(
            "ruleType",
            enumeration(&[
                "SINGLE_AMOUNT",
                "CUMULATIVE_WINDOW",
                "STRUCTURING",
                "RISK_TIER",
                "COUNTERPARTY_COUNTRY",
                "RAIL",
                "MERCHANT_DIRECT_AMOUNT",
            ]),
        )
        .req(
            "action",
            enumeration(&["HOLD", "FLAG", "BLOCK", "CASE_ONLY"]),
        )
        .req(
            "baseSeverity",
            enumeration(&["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        )
        .opt("scope", json_object())
        .opt("params", json_object())
        .opt("effectiveFrom", text(0, 64))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "RULE_LOGIC_REVIEWED",
                    "THRESHOLDS_VERIFIED",
                    "REGULATORY_BASIS_DOCUMENTED",
                    "CHECKER_INDEPENDENCE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn aml_reporting_rule() -> Schema {
    object()
        .req("code", text(2, 64))
        .req("name", text(2, 160))
        .req("mode", enumeration(&["PROVISIONAL", "CONFIRMED"]))
        .req("threshold", amount())
        .req("currency", pattern(0, 3, "^[A-Z]{3}$"))
        .req("windowDays", integer(1, 365))
        .opt("active", boolean())
        .opt(
            "reportType",
            enumeration(&[
                "LARGE_TRANSACTION",
                "SUSPICIOUS_ACTIVITY",
                "PERIODIC_RETURN",
                "INCIDENT",
            ]),
        )
        .strict()
        .build()
}

pub fn aml_report() -> Schema {
    object()
        .req("reportingRuleId", identifier(64))
        .opt("caseId", identifier(64))
        .req("periodStart", text(0, 64))
        .req("periodEnd", text(0, 64))
        .opt("notes", text(0, 2000))
        .opt(
            "reportType",
            enumeration(&[
                "LARGE_TRANSACTION",
                "SUSPICIOUS_ACTIVITY",
                "PERIODIC_RETURN",
                "INCIDENT",
            ]),
        )
        .opt("authority", text(2, 64))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "REPORTING_RULE_VERIFIED",
                    "PERIOD_VERIFIED",
                    "CASE_LINKAGE_VERIFIED",
                    "NOTES_REVIEWED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn aml_report_submit() -> Schema {
    object()
        .req("submissionRef", text(1, 200))
        .opt("submittedAt", text(0, 64))
        .opt("filingChannel", text(2, 80))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "REPORT_APPROVED_VERIFIED",
                    "AUTHORITY_REFERENCE_VERIFIED",
                    "DEADLINE_VERIFIED",
                    "PAYLOAD_DIGEST_VERIFIED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn aml_report_acknowledge() -> Schema {
    object()
        .req(
            "status",
            enumeration(&["ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"]),
        )
        .opt("reason", text(0, 2000))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "AUTHORITY_RESPONSE_VERIFIED",
                    "DECISION_RECORDED",
                    "REJECTION_REASON_DOCUMENTED",
                    "REPORT_CLOSURE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn aml_report_schema_upload() -> Schema {
    object()
        .def("authority", text(2, 64), serde_json::json!("CBL"))
        .req(
            "reportType",
            enumeration(&[
                "LARGE_TRANSACTION",
                "SUSPICIOUS_ACTIVITY",
                "PERIODIC_RETURN",
                "INCIDENT",
            ]),
        )
        .def("reportCode", text(0, 40), serde_json::json!(""))
        .req("format", enumeration(&["XML", "XLSX", "DOCX"]))
        .req("schemaCode", text(2, 120))
        .req("name", text(2, 200))
        .opt("version", integer(1, 10_000))
        .req("definitionText", text(1, 2_000_000))
        .def("mappingBlueprint", json_object(), serde_json::json!({}))
        .opt("sampleContext", json_object())
        .opt("templateBase64", text(0, 20_000_000))
        .opt("notes", text(0, 4000))
        .strict()
        .build()
}

pub fn aml_report_schema_promote() -> Schema {
    object()
        .def("setAsDefault", boolean(), serde_json::json!(true))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn aml_report_schema_default() -> Schema {
    object()
        .def("authority", text(2, 64), serde_json::json!("CBL"))
        .req(
            "reportType",
            enumeration(&[
                "LARGE_TRANSACTION",
                "SUSPICIOUS_ACTIVITY",
                "PERIODIC_RETURN",
                "INCIDENT",
            ]),
        )
        .def("reportCode", text(0, 40), serde_json::json!(""))
        .req("format", enumeration(&["XML", "XLSX", "DOCX"]))
        .req("schemaId", identifier(64))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn aml_report_simulate() -> Schema {
    object().req("context", json_object()).strict().build()
}

pub fn aml_report_generate() -> Schema {
    object()
        .opt(
            "formats",
            array_sized(enumeration(&["XML", "XLSX", "DOCX"]), 1, 3),
        )
        .def("allowRegenerate", boolean(), serde_json::json!(false))
        .strict()
        .build()
}

pub fn aml_report_output_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("format", enumeration(&["XML", "XLSX", "DOCX"]))
        .build()
}

pub fn aml_empty_body() -> Schema {
    object().strict().build()
}

pub fn aml_schema_draft() -> Schema {
    object()
        .opt("name", text(2, 200))
        .opt("definitionText", text(1, 2_000_000))
        .opt("mappingBlueprint", json_object())
        .opt("sampleContext", json_object())
        .opt("templateBase64", text(0, 20_000_000))
        .opt("notes", text(0, 4000))
        .opt("baseRevision", integer(1, i64::MAX))
        .strict()
        .build()
}

pub fn aml_schema_validate() -> Schema {
    object()
        .opt("definitionText", text(1, 2_000_000))
        .opt("mappingBlueprint", json_object())
        .opt("sampleContext", json_object())
        .opt("context", json_object())
        .opt("format", enumeration(&["XML", "XLSX", "DOCX"]))
        .strict()
        .build()
}

pub fn aml_sample_context() -> Schema {
    object()
        .def(
            "sourceType",
            enumeration(&["SCHEMA", "PAYMENT_ATTEMPT", "AML_CASE", "REGULATORY_REPORT"]),
            serde_json::json!("SCHEMA"),
        )
        .opt("sourceId", identifier(64))
        .def("includePii", boolean(), serde_json::json!(false))
        .strict()
        .build()
}

pub fn aml_code_list_preview() -> Schema {
    object()
        .opt("mappingBlueprint", json_object())
        .opt("codeMapKey", text(0, 120))
        .opt("values", array_sized(string_any(), 0, 500))
        .strict()
        .build()
}

pub fn aml_template_upload() -> Schema {
    object()
        .req("templateBase64", text(0, 20_000_000))
        .opt("templateBinding", json_object())
        .strict()
        .build()
}

pub fn aml_template_analyze() -> Schema {
    object()
        .opt("templateBase64", text(0, 20_000_000))
        .strict()
        .build()
}

pub fn aml_schema_clone() -> Schema {
    object()
        .opt("version", integer(1, 10_000))
        .opt("name", text(2, 200))
        .opt("notes", text(0, 4000))
        .def("copySample", boolean(), serde_json::json!(false))
        .strict()
        .build()
}

pub fn aml_rule_bindings() -> Schema {
    object()
        .req(
            "bindings",
            array_sized(
                object()
                    .req("format", enumeration(&["XML", "XLSX", "DOCX"]))
                    .req("schemaId", identifier(64))
                    .strict()
                    .build(),
                0,
                3,
            ),
        )
        .strict()
        .build()
}

pub fn aml_report_narrative() -> Schema {
    object()
        .req("narrative", record_of(80, text(0, 20_000)))
        .opt("basePayloadSha256", text(64, 64))
        .strict()
        .build()
}

fn incident_severity() -> Schema {
    enumeration(&["SEV1", "SEV2", "SEV3", "SEV4"])
}

fn incident_status() -> Schema {
    enumeration(&[
        "DETECTED",
        "TRIAGED",
        "DECLARED",
        "CONTAINED",
        "MONITORING",
        "RESOLVED",
        "POSTMORTEM",
        "CLOSED",
    ])
}

fn incident_category() -> Schema {
    enumeration(&[
        "AVAILABILITY",
        "DATA_INTEGRITY",
        "SECURITY",
        "FRAUD",
        "COMPLIANCE",
        "THIRD_PARTY",
        "PAYMENT_PROCESSING",
        "OTHER",
    ])
}

fn incident_impact() -> Schema {
    enumeration(&["PLATFORM", "MERCHANT", "CHECKOUT", "ADMIN", "MULTI_TENANT"])
}

fn incident_link_type() -> Schema {
    enumeration(&[
        "ATTEMPT", "MERCHANT", "RAIL", "GATEWAY", "REPORT", "CASE", "OTHER",
    ])
}

pub fn incident_list_query() -> Schema {
    object()
        .opt("search", text(0, 200))
        .opt("page", coerce_integer(1, i64::MAX))
        .opt("pageSize", coerce_integer(1, 200))
        .opt("status", incident_status())
        .opt("severity", incident_severity())
        .opt("category", incident_category())
        .strict()
        .build()
}

pub fn incident_export_query() -> Schema {
    object()
        .opt("search", text(0, 200))
        .opt("status", incident_status())
        .opt("severity", incident_severity())
        .opt("category", incident_category())
        .opt("checklist", text(0, 1000))
        .strict()
        .build()
}

pub fn incident_create() -> Schema {
    object()
        .req("title", text(3, 300))
        .opt("summary", text(0, 20_000))
        .def("category", incident_category(), serde_json::json!("OTHER"))
        .def("severity", incident_severity(), serde_json::json!("SEV3"))
        .def(
            "impactScope",
            incident_impact(),
            serde_json::json!("PLATFORM"),
        )
        .opt("detectedAt", text(0, 64))
        .opt("commanderUserId", identifier(64))
        .def(
            "affectedServices",
            array_sized(text(1, 120), 0, 100),
            serde_json::json!([]),
        )
        .def(
            "affectedMerchantIds",
            array_sized(identifier(64), 0, 500),
            serde_json::json!([]),
        )
        .def(
            "affectedAttemptIds",
            array_sized(identifier(64), 0, 500),
            serde_json::json!([]),
        )
        .def("regulatorsNotified", boolean(), serde_json::json!(false))
        .strict()
        .build()
}

pub fn incident_patch() -> Schema {
    object()
        .opt("title", text(3, 300))
        .null_opt("summary", text(0, 20_000))
        .opt("category", incident_category())
        .opt("severity", incident_severity())
        .opt("impactScope", incident_impact())
        .null_opt("commanderUserId", identifier(64))
        .opt("affectedServices", array_sized(text(1, 120), 0, 100))
        .opt("affectedMerchantIds", array_sized(identifier(64), 0, 500))
        .opt("affectedAttemptIds", array_sized(identifier(64), 0, 500))
        .opt("regulatorsNotified", boolean())
        .null_opt("rootCause", text(0, 20_000))
        .null_opt("postmortemSummary", text(0, 50_000))
        .null_opt("postmortemJson", json_object())
        .strict()
        .build()
}

pub fn incident_transition() -> Schema {
    object()
        .req("status", incident_status())
        .opt("note", text(0, 5000))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn incident_timeline() -> Schema {
    object()
        .def(
            "type",
            enumeration(&[
                "DETECTED",
                "DECLARED",
                "STATUS_CHANGE",
                "NOTE",
                "ESCALATION",
                "COMMUNICATION",
                "ACTION",
                "REGULATORY",
            ]),
            serde_json::json!("NOTE"),
        )
        .req("summary", text(1, 5000))
        .opt("detailJson", json_object())
        .opt("occurredAt", text(0, 64))
        .strict()
        .build()
}

pub fn incident_responder() -> Schema {
    object()
        .opt("userId", identifier(64))
        .req("name", text(1, 200))
        .req("role", text(1, 120))
        .def("isCommander", boolean(), serde_json::json!(false))
        .strict()
        .build()
}

pub fn incident_responder_patch() -> Schema {
    object()
        .opt("acknowledged", boolean())
        .opt("released", boolean())
        .strict()
        .build()
}

pub fn incident_action() -> Schema {
    object()
        .req("title", text(1, 500))
        .opt("ownerUserId", identifier(64))
        .def("priority", integer(1, 4), serde_json::json!(3))
        .opt("dueAt", text(0, 64))
        .opt("notes", text(0, 5000))
        .strict()
        .build()
}

pub fn incident_action_patch() -> Schema {
    object()
        .opt("title", text(1, 500))
        .null_opt("ownerUserId", identifier(64))
        .opt("priority", integer(1, 4))
        .opt(
            "status",
            enumeration(&["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]),
        )
        .null_opt("dueAt", text(0, 64))
        .null_opt("notes", text(0, 5000))
        .strict()
        .build()
}

pub fn incident_link() -> Schema {
    object()
        .req("linkType", incident_link_type())
        .req("targetId", text(1, 200))
        .opt("label", text(0, 300))
        .strict()
        .build()
}

pub fn incident_communication() -> Schema {
    object()
        .req(
            "channel",
            enumeration(&["STATUS_PAGE", "EMAIL", "SMS", "REGULATOR", "INTERNAL"]),
        )
        .req("audience", text(1, 500))
        .req("subject", text(1, 500))
        .req("body", text(1, 50_000))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn incident_child_params() -> Schema {
    object()
        .req("id", identifier(64))
        .req("childId", identifier(64))
        .build()
}

pub fn aml_filing_adapter() -> Schema {
    object()
        .req("name", text(2, 120))
        .opt("authority", text(2, 64))
        .opt("kind", enumeration(&["MANUAL", "HTTP"]))
        .opt("status", enumeration(&["ACTIVE", "DISABLED"]))
        .null_opt("endpointUrl", crate::schema::url_text(500))
        .null_opt("authHeaderName", text(2, 80))
        .null_opt("authSecret", text(4, 4000))
        .opt("timeoutSeconds", integer(5, 120))
        .null_opt("configJson", json_object())
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn aml_filing_adapter_patch() -> Schema {
    object()
        .opt("name", text(2, 120))
        .opt("authority", text(2, 64))
        .opt("kind", enumeration(&["MANUAL", "HTTP"]))
        .opt("status", enumeration(&["ACTIVE", "DISABLED"]))
        .null_opt("endpointUrl", crate::schema::url_text(500))
        .null_opt("authHeaderName", text(2, 80))
        .null_opt("authSecret", text(4, 4000))
        .opt("timeoutSeconds", integer(5, 120))
        .null_opt("configJson", json_object())
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn aml_report_file() -> Schema {
    object()
        .req("adapterId", identifier(64))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "REPORT_APPROVED_VERIFIED",
                    "AUTHORITY_REFERENCE_VERIFIED",
                    "DEADLINE_VERIFIED",
                    "PAYLOAD_DIGEST_VERIFIED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn aml_id_params() -> Schema {
    object().req("id", identifier(64)).build()
}

/* --------------------------------------------------------------------------- settings */

pub fn settings_update() -> Schema {
    object()
        .req("settings", json_object())
        .opt("baseVersion", integer(1, i64::MAX))
        .opt("reason", text(3, 500))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "KEY_SCOPE_VERIFIED",
                    "VALUE_SCHEMA_REVIEWED",
                    "EFFECTIVE_DATE_REVIEWED",
                    "IMMUTABLE_VERSION_ACKNOWLEDGED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn settings_restore_preview() -> Schema {
    object().req("backup", any()).strict().build()
}

pub fn settings_restore_apply() -> Schema {
    object()
        .req("confirm", literal_true())
        .req("reason", text(3, 500))
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "BACKUP_REVIEWED",
                    "INVALID_ENTRIES_CLEARED",
                    "VERSION_CONFLICTS_REVIEWED",
                    "RESTORE_SCOPE_CONFIRMED",
                ]),
                0,
                10,
            ),
        )
        .req(
            "backup",
            object()
                .req(
                    "settings",
                    array_sized(
                        object()
                            .req("key", text(1, 120))
                            .opt("scope", text(0, 40))
                            .req("valueJson", record_any(1000))
                            .req("expectedCurrentVersion", integer(0, i64::MAX))
                            .opt("effectiveFrom", text(0, 64))
                            .strict()
                            .build(),
                        1,
                        100,
                    ),
                )
                .strict()
                .build(),
        )
        .strict()
        .build()
}

pub fn communication_test_email() -> Schema {
    object().req("to", email()).strict().build()
}

pub fn communication_test_sms() -> Schema {
    object().req("to", text(6, 32)).strict().build()
}

pub fn checkout_support() -> Schema {
    object()
        .req("enabled", boolean())
        .opt("show_platform_contact", boolean())
        .opt("show_merchant_contact", boolean())
        .opt("support_phone", text(0, 40))
        .opt("support_whatsapp", text(0, 40))
        .opt("support_email", text(0, 160))
        .opt("working_hours_ar", text(0, 300))
        .opt("working_hours_en", text(0, 300))
        .opt(
            "faq_items",
            array_sized(
                object()
                    .req("q_ar", text(0, 1000))
                    .req("a_ar", text(0, 4000))
                    .req("q_en", text(0, 1000))
                    .req("a_en", text(0, 4000))
                    .strict()
                    .build(),
                0,
                50,
            ),
        )
        .opt(
            "checklist",
            array_sized(
                enumeration(&[
                    "SUPPORT_CHANNELS_VERIFIED",
                    "FAQ_CONTENT_REVIEWED",
                    "WORKING_HOURS_VERIFIED",
                    "PAYER_VISIBILITY_REVIEWED",
                ]),
                0,
                10,
            ),
        )
        .strict()
        .build()
}

pub fn notification_template_update() -> Schema {
    object()
        .null_opt("subjectTemplate", text(0, 500))
        .req("bodyTemplate", text(1, 10_000))
        .opt(
            "confidentialityClass",
            enumeration(&["PUBLIC", "MERCHANT", "INTERNAL"]),
        )
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

/* ----------------------------------------------------------------------- object storage */

pub fn object_storage_object_params() -> Schema {
    object().req("id", identifier(64)).strict().build()
}

pub fn object_storage_legal_hold() -> Schema {
    object()
        .req("reason", trimmed(5, 512))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn object_storage_list() -> Schema {
    object()
        .opt("page", coerce_integer(1, i64::MAX))
        .opt("pageSize", coerce_integer(1, 200))
        .opt("namespace", trimmed(0, 64))
        .opt("status", trimmed(0, 32))
        .opt("statuses", trimmed(0, 200))
        .opt("bucket", trimmed(0, 16))
        .opt("ownerMerchantId", uuid())
        .opt("legalHold", enumeration(&["true", "false"]))
        .opt("sha256Hex", pattern(0, 64, "^[a-fA-F0-9]{64}$"))
        .opt("search", trimmed(0, 200))
        .opt(
            "sortKey",
            enumeration(&[
                "createdAt",
                "namespace",
                "status",
                "retainUntil",
                "byteSize",
                "originalFilename",
            ]),
        )
        .opt("sortDirection", enumeration(&["asc", "desc"]))
        .strict()
        .build()
}

pub fn object_storage_access_logs() -> Schema {
    object()
        .opt("page", coerce_integer(1, i64::MAX))
        .opt("pageSize", coerce_integer(1, 200))
        .opt("allowed", enumeration(&["true", "false"]))
        .opt("action", trimmed(0, 48))
        .opt("objectId", uuid())
        .opt("search", trimmed(0, 200))
        .strict()
        .build()
}

pub fn object_storage_maintenance_params() -> Schema {
    object()
        .req(
            "job",
            enumeration(&[
                "gc",
                "sweep",
                "scrub",
                "reconcile-locks",
                "rewrap",
                "av-scan",
            ]),
        )
        .strict()
        .build()
}

/* ----------------------------------------------------------------------------- backups */

pub fn backup_trigger() -> Schema {
    object()
        .req(
            "target",
            enumeration(&["all", "postgres_core", "audit_db", "redis"]),
        )
        .req("kind", enumeration(&["full", "delta"]))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn backup_drill() -> Schema {
    object()
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn backup_policy() -> Schema {
    object()
        .req("fullCron", crate::schema::cron_field(60))
        .req("deltaCron", crate::schema::cron_field(5))
        .req("drillCron", crate::schema::cron_field(60))
        .req("fullRetentionDays", integer(1, 3650))
        .req("walRetentionDays", integer(1, 3650))
        .req("alertLagSeconds", integer(1, 86_400))
        .opt("approvalRequestId", identifier(64))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

/* ----------------------------------------------------------------------------- academy */

fn iso_date() -> Schema {
    text(0, 40)
}

pub fn academy_progress() -> Schema {
    object()
        .req("baseRev", integer(0, i64::MAX))
        .req(
            "patch",
            object()
                .opt("activeTrack", text(1, 40))
                .opt(
                    "guideRead",
                    record_of(
                        120,
                        object().req("v", text(0, 20)).req("at", iso_date()).build(),
                    ),
                )
                .opt(
                    "lessons",
                    record_of(
                        120,
                        object()
                            .req("at", iso_date())
                            .req("v", text(0, 20))
                            .req(
                                "checkScore",
                                crate::schema::either(vec![
                                    literal_int(0),
                                    literal_int(1),
                                    literal_int(2),
                                ]),
                            )
                            .build(),
                    ),
                )
                .opt(
                    "labs",
                    record_of(
                        120,
                        object()
                            .req("bestScore", number(0.0, 100.0))
                            .req("attempts", integer(0, 100_000))
                            .opt("passedAt", iso_date())
                            .req("criticalErrors", integer(0, 10_000))
                            .req("v", text(0, 20))
                            .build(),
                    ),
                )
                .build(),
        )
        .build()
}

pub fn academy_exam_params() -> Schema {
    object().req("examId", text(1, 64)).build()
}

pub fn academy_start() -> Schema {
    object()
        .opt("integrityAccepted", boolean())
        .opt("checklist", checklist_any(10))
        .build()
}

pub fn academy_submit() -> Schema {
    object()
        .req("sessionId", text(1, 80))
        .req(
            "answers",
            record_of(
                40,
                either_union(vec![text(0, 40), array_sized(text(0, 40), 0, 20)]),
            ),
        )
        .build()
}

pub fn academy_track_params() -> Schema {
    object().req("trackId", text(1, 64)).strict().build()
}

pub fn academy_certificate_params() -> Schema {
    object().req("identifier", trimmed(8, 64)).strict().build()
}

pub fn academy_revoke() -> Schema {
    object().req("reason", trimmed(5, 500)).strict().build()
}

/* ------------------------------------------------------------------------- credentials */

fn credential_entry() -> Schema {
    object()
        .req("key", text(1, 64))
        .req(
            "type",
            enumeration(&["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
        )
        .req("value", text(0, 4096))
        .opt("isSecret", boolean())
        .strict()
        .build()
}

pub fn credential_set_create() -> Schema {
    object()
        .req("gatewayCode", text(2, 64))
        .req("env", enumeration(&["SANDBOX", "LIVE"]))
        .req("ownerType", enumeration(&["PLATFORM", "MERCHANT"]))
        .opt("ownerMerchantId", identifier(64))
        .opt("externalMerchantId", text(2, 120))
        .req(
            "settlementTarget",
            enumeration(&["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]),
        )
        .req("entries", array_sized(credential_entry(), 1, 40))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn credential_set_update() -> Schema {
    object()
        .req("entries", array_sized(credential_entry(), 1, 40))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn credential_set_verify() -> Schema {
    object()
        .opt("gatewayVersionId", identifier(64))
        .strict()
        .build()
}

pub fn credential_set_revoke() -> Schema {
    object()
        .opt("reason", text(2, 500))
        .opt("checklist", checklist_any(10))
        .strict()
        .build()
}

pub fn credential_set_params() -> Schema {
    object().req("id", identifier(64)).build()
}

/* ------------------------------------------------------------------------ audit logs */

pub fn audit_list_query() -> Schema {
    object()
        .opt("search", text(0, 200))
        .opt("page", coerce_integer(1, i64::MAX))
        .opt("pageSize", coerce_integer(1, 200))
        .opt("sortKey", text(0, 64))
        .opt("sortDirection", enumeration(&["asc", "desc"]))
        .opt("from", text(0, 40))
        .opt("to", text(0, 40))
        .opt("dateFrom", text(0, 40))
        .opt("dateTo", text(0, 40))
        .opt("checklist", text(0, 1000))
        .passthrough()
        .build()
}

/* --------------------------------------------------------------------- report engine */

pub fn report_engine_id_params() -> Schema {
    object().req("id", uuid()).strict().build()
}

pub fn report_engine_code_params() -> Schema {
    object().req("code", text(1, 64)).strict().build()
}

pub fn report_engine_source_params() -> Schema {
    object().req("sourceKey", text(1, 64)).strict().build()
}

fn report_checklist() -> Schema {
    checklist_any(10)
}

fn spec_json() -> Schema {
    either_union(vec![text(0, 100_000_000), record_any(1000)])
}

pub fn report_spec_body() -> Schema {
    object()
        .req("specJson", spec_json())
        .opt("assetsZipBase64", string_any())
        .opt("publish", boolean())
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_verify_body() -> Schema {
    object()
        .req("specJson", spec_json())
        .opt("assetsZipBase64", string_any())
        .strict()
        .build()
}

pub fn report_preview_body() -> Schema {
    object()
        .req("specJson", spec_json())
        .opt("assetsZipBase64", string_any())
        .opt("inputs", record_any(1000))
        .opt("locale", text(0, 16))
        .def(
            "mode",
            enumeration(&["MOCK", "LIVE"]),
            serde_json::json!("MOCK"),
        )
        .strict()
        .build()
}

pub fn report_override_body() -> Schema {
    object()
        .def(
            "allowedRoles",
            array_sized(string_any(), 0, 20),
            serde_json::json!([]),
        )
        .def(
            "allowedAuthorities",
            array_sized(string_any(), 0, 40),
            serde_json::json!([]),
        )
        .req("justification", trimmed(15, 1000))
        .opt("allowConfidentialAmlBypass", boolean())
        .opt("clear", boolean())
        .strict()
        .build()
}

pub fn report_execute_body() -> Schema {
    object()
        .def("inputs", record_any(1000), serde_json::json!({}))
        .opt("locale", text(0, 16))
        .opt(
            "chromeOverride",
            object()
                .opt(
                    "headerMode",
                    enumeration(&[
                        "GLOBAL_DEFAULT",
                        "SPECIFIC_CHROME_CODE",
                        "INLINE_SPEC",
                        "NONE",
                    ]),
                )
                .null_opt("headerChromeCode", text(0, 120))
                .opt(
                    "footerMode",
                    enumeration(&[
                        "GLOBAL_DEFAULT",
                        "SPECIFIC_CHROME_CODE",
                        "INLINE_SPEC",
                        "NONE",
                    ]),
                )
                .null_opt("footerChromeCode", text(0, 120))
                .build(),
        )
        .opt(
            "renderMode",
            enumeration(&["CLIENT_PAGED_VECTOR", "SERVER_PDF"]),
        )
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_chrome_body() -> Schema {
    object()
        .req("specJson", spec_json())
        .opt("assetsZipBase64", string_any())
        .opt("publish", boolean())
        .opt("makeDefault", boolean())
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_publish_body() -> Schema {
    object()
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_chrome_default_body() -> Schema {
    object()
        .req("isDefault", boolean())
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_merchant_params() -> Schema {
    object().req("merchantId", uuid()).strict().build()
}

pub fn report_merchant_suspend() -> Schema {
    object()
        .req("reason", trimmed(5, 500))
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_merchant_resume() -> Schema {
    object()
        .opt("checklist", report_checklist())
        .strict()
        .build()
}

pub fn report_reject_body() -> Schema {
    object().opt("notes", text(0, 2000)).strict().build()
}

pub fn report_empty_body() -> Schema {
    object().strict().build()
}
