//! Public (portal + external API) request schemas.
//!
//! Port of the zod schemas declared in `merchant-back/api/**`. Each function returns the schema of
//! one route family; the route table reuses them for bodies, params and query strings exactly like
//! the TypeScript `coreForward({ schema, paramsSchema, querySchema })` options.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::error::EdgeApiError;
use crate::validate::{normalize_libyan_phone, Field, Issue, PathItem, Pattern, Schema};

pub const PAYMENT_STATUSES: &[&str] = &[
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
];
pub const LINK_STATUSES: &[&str] = &["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"];
pub const DISPUTE_STATUSES: &[&str] = &[
    "PENDING_REVIEW",
    "ACCEPTED",
    "REJECTED",
    "WITHDRAWN",
    "RESOLVED",
];
pub const CASHOUT_STATUSES: &[&str] = &[
    "PENDING_REVIEW",
    "APPROVED",
    "REJECTED",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
];
pub const WEBHOOK_DELIVERY_STATUSES: &[&str] = &["PENDING", "DELIVERED", "PARKED"];
pub const KYB_DOCUMENT_TYPES: &[&str] = &[
    "COMMERCIAL_REGISTRY",
    "TAX_CERTIFICATE",
    "ARTICLES_OF_ASSOCIATION",
    "OWNER_ID",
    "SIGNATORY_ID",
    "PROOF_OF_ADDRESS",
    "BANK_LETTER",
    "SECTOR_LICENSE",
    "OTHER",
];
pub const EVIDENCE_TYPES: &[&str] = &[
    "RECEIPT",
    "INVOICE",
    "DELIVERY_PROOF",
    "CORRESPONDENCE",
    "OTHER",
];

fn identifier() -> Schema {
    Schema::string().min(1).max(64).pattern(Pattern::Identifier)
}

fn password() -> Schema {
    Schema::string().min(10).max(128).password()
}

fn email() -> Schema {
    Schema::string().pattern(Pattern::Email)
}

fn json_object() -> Schema {
    Schema::json_object(64)
}

fn page() -> Schema {
    Schema::coerce_integer().int_min(1)
}

fn page_size() -> Schema {
    Schema::coerce_integer().int_min(1).int_max(200)
}

/* -------------------------------------------------------------------------- *
 * auth
 * -------------------------------------------------------------------------- */

/// `registerSchema` (`api/public/auth.ts:69-76`).
#[must_use]
pub fn register_schema() -> Schema {
    Schema::object(vec![
        ("email", Field::required(email())),
        ("password", Field::required(password())),
        (
            "fullName",
            Field::required(Schema::string().min(2).max(120)),
        ),
        ("locale", Field::optional(Schema::Enum(&["ar", "en"]))),
    ])
}

/// `verifyIdentitySchema`.
#[must_use]
pub fn verify_identity_schema() -> Schema {
    Schema::object(vec![
        (
            "identityType",
            Field::required(Schema::Enum(&["NATIONAL_ID", "PASSPORT"])),
        ),
        (
            "identityNumber",
            Field::required(Schema::string().min(4).max(32)),
        ),
        ("phone", Field::required(Schema::string().phone())),
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::Otp)),
        ),
    ])
}

/// `loginSchema`.
#[must_use]
pub fn login_schema() -> Schema {
    Schema::object(vec![
        (
            "identifier",
            Field::required(Schema::string().min(3).max(128)),
        ),
        (
            "password",
            Field::required(Schema::string().min(1).max(128)),
        ),
    ])
}

/// `googleStartSchema` (also the legacy `/auth/google` alias).
#[must_use]
pub fn google_start_schema() -> Schema {
    Schema::object(vec![
        (
            "mode",
            Field::optional(Schema::Enum(&["login", "register"])),
        ),
        (
            "returnPath",
            Field::optional(Schema::Enum(&["/login", "/register"])),
        ),
        ("redirectUri", Field::optional(Schema::string().max(512))),
    ])
}

/// `googleCallbackQuerySchema`.
#[must_use]
pub fn google_callback_query_schema() -> Schema {
    Schema::object(vec![
        ("code", Field::required(Schema::string().min(8).max(4096))),
        ("state", Field::required(Schema::string().min(8).max(256))),
    ])
}

/// `googleExchangeSchema`.
#[must_use]
pub fn google_exchange_schema() -> Schema {
    Schema::object(vec![(
        "ticket",
        Field::required(Schema::string().min(16).max(512)),
    )])
}

/// `emailVerifySchema`.
#[must_use]
pub fn email_verify_schema() -> Schema {
    Schema::object(vec![
        ("email", Field::required(email())),
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::MfaCode)),
        ),
    ])
}

/// `emailResendSchema`.
#[must_use]
pub fn email_resend_schema() -> Schema {
    Schema::object(vec![("email", Field::required(email()))])
}

/// `passwordForgotSchema`.
#[must_use]
pub fn password_forgot_schema() -> Schema {
    Schema::object(vec![("email", Field::required(email()))])
}

/// `passwordResetSchema`.
#[must_use]
pub fn password_reset_schema() -> Schema {
    Schema::object(vec![
        ("email", Field::required(email())),
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::MfaCode)),
        ),
        ("newPassword", Field::required(password())),
    ])
}

/// `mfaSchema`.
#[must_use]
pub fn mfa_schema() -> Schema {
    Schema::object(vec![
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::MfaCode)),
        ),
        (
            "challengeId",
            Field::optional(Schema::string().min(4).max(128)),
        ),
    ])
}

/// `mfaResendSchema`.
#[must_use]
pub fn mfa_resend_schema() -> Schema {
    Schema::object(vec![(
        "challengeId",
        Field::required(Schema::string().pattern(Pattern::Uuid)),
    )])
}

/// `acceptInvitationSchema`.
#[must_use]
pub fn accept_invitation_schema() -> Schema {
    Schema::object(vec![
        ("token", Field::required(Schema::string().min(16).max(256))),
        ("password", Field::required(password())),
    ])
}

/* -------------------------------------------------------------------------- *
 * onboarding
 * -------------------------------------------------------------------------- */

/// `joinRequestSchema` (`api/public/onboarding.ts:41-55`).
#[must_use]
pub fn join_request_schema() -> Schema {
    Schema::object(vec![
        (
            "legalName",
            Field::optional(Schema::string().min(2).max(160)),
        ),
        (
            "tradeName",
            Field::optional(Schema::string().min(2).max(160)),
        ),
        ("country", Field::optional(Schema::string().min(2).max(2))),
        (
            "businessType",
            Field::optional(Schema::string().min(2).max(64)),
        ),
        (
            "registrationNumber",
            Field::optional(Schema::string().min(2).max(64)),
        ),
        (
            "taxNumber",
            Field::optional(Schema::string().min(2).max(64)),
        ),
        ("address", Field::optional(Schema::string().min(4).max(400))),
        ("phone", Field::optional(Schema::string().min(6).max(20))),
        ("email", Field::optional(Schema::string().min(3).max(160))),
        (
            "website",
            Field::optional(Schema::string().pattern(Pattern::Website)),
        ),
        ("locale", Field::optional(Schema::Enum(&["ar", "en"]))),
    ])
}

/// `beneficialOwnerSchema`.
#[must_use]
pub fn beneficial_owner_schema() -> Schema {
    Schema::object(vec![
        (
            "fullName",
            Field::required(Schema::string().min(2).max(160)),
        ),
        (
            "identityType",
            Field::required(Schema::Enum(&["NATIONAL_ID", "PASSPORT"])),
        ),
        (
            "identityNumber",
            Field::required(Schema::string().min(4).max(32)),
        ),
        (
            "nationality",
            Field::optional(Schema::string().min(2).max(64)),
        ),
        (
            "dateOfBirth",
            Field::optional(Schema::string().pattern(Pattern::IsoDate)),
        ),
        (
            "ownershipPercent",
            Field::optional(Schema::string().pattern(Pattern::OwnershipPercent)),
        ),
        ("position", Field::optional(Schema::string().min(2).max(80))),
    ])
}

/// `beneficialOwnerParamsSchema`.
#[must_use]
pub fn id_params_schema() -> Schema {
    Schema::object(vec![("id", Field::required(identifier()))])
}

/// `kybDocumentSchema` (multipart fields).
#[must_use]
pub fn kyb_document_schema() -> Schema {
    Schema::object(vec![
        (
            "documentType",
            Field::required(Schema::Enum(KYB_DOCUMENT_TYPES)),
        ),
        (
            "reference",
            Field::optional(Schema::string().min(1).max(128)),
        ),
        (
            "issuedAt",
            Field::optional(Schema::string().pattern(Pattern::IsoDate)),
        ),
        (
            "expiresAt",
            Field::optional(Schema::string().pattern(Pattern::IsoDate)),
        ),
        ("notes", Field::optional(Schema::string().max(1000))),
        ("revalidationRequestId", Field::optional(identifier())),
    ])
}

/// `submitSchema`.
#[must_use]
pub fn onboarding_submit_schema() -> Schema {
    Schema::object(vec![
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
        ("acknowledgement", Field::required(Schema::LiteralTrue)),
    ])
}

/// `withdrawSchema` (`z.string().trim().min(3).max(500).optional()`).
#[must_use]
pub fn withdraw_schema() -> Schema {
    Schema::object(vec![(
        "reason",
        Field::optional(Schema::string().trimmed().min(3).max(500)),
    )])
}

/* -------------------------------------------------------------------------- *
 * wallets / applications / links
 * -------------------------------------------------------------------------- */

/// `walletCreateSchema`.
#[must_use]
pub fn wallet_create_schema() -> Schema {
    Schema::object(vec![
        ("applicationId", Field::required(identifier())),
        ("label", Field::required(Schema::string().min(2).max(120))),
        (
            "currency",
            Field::required(Schema::string().pattern(Pattern::Currency)),
        ),
        (
            "openingAmount",
            Field::optional(Schema::string().pattern(Pattern::Amount)),
        ),
    ])
}

/// `statementQuerySchema`.
#[must_use]
pub fn statement_query_schema() -> Schema {
    Schema::passthrough(vec![
        (
            "month",
            Field::optional(Schema::string().pattern(Pattern::Month)),
        ),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
    ])
}

/// `walletParamsSchema` / any `{ id }` params.
#[must_use]
pub fn wallet_params_schema() -> Schema {
    Schema::object(vec![("id", Field::required(identifier()))])
}

/// `{ id, month }` params of the statement export.
#[must_use]
pub fn wallet_month_params_schema() -> Schema {
    Schema::object(vec![
        ("id", Field::required(identifier())),
        (
            "month",
            Field::required(Schema::string().pattern(Pattern::Month)),
        ),
    ])
}

/// The shared `zListQuery`.
#[must_use]
pub fn list_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("search", Field::optional(Schema::string().max(200))),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
        ("sortKey", Field::optional(Schema::string().max(64))),
        (
            "sortDirection",
            Field::optional(Schema::Enum(&["asc", "desc"])),
        ),
        ("from", Field::optional(Schema::string().max(40))),
        ("to", Field::optional(Schema::string().max(40))),
        ("dateFrom", Field::optional(Schema::string().max(40))),
        ("dateTo", Field::optional(Schema::string().max(40))),
    ])
}

fn application_fields(required_name: bool) -> Vec<(&'static str, Field)> {
    vec![
        (
            "name",
            if required_name {
                Field::required(Schema::string().min(2).max(160))
            } else {
                Field::optional(Schema::string().min(2).max(160))
            },
        ),
        ("description", Field::optional(Schema::string().max(2000))),
        (
            "businessUseDescription",
            Field::optional(Schema::string().max(2000)),
        ),
        (
            "expectedMonthlyVolume",
            Field::optional(Schema::string().pattern(Pattern::Volume)),
        ),
        ("assignedWalletId", Field::optional(identifier())),
        (
            "railWhitelist",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_min(1)),
        ),
        (
            "redirectDomainAllowlist",
            Field::optional(Schema::array(Schema::string().min(1).max(200)).array_min(1)),
        ),
        (
            "website",
            Field::optional(Schema::string().pattern(Pattern::Website)),
        ),
        ("category", Field::optional(Schema::string().min(2).max(64))),
        (
            "settlementCurrency",
            Field::optional(Schema::string().pattern(Pattern::Currency)),
        ),
        (
            "contactEmail",
            Field::optional(Schema::string().min(3).max(160)),
        ),
        (
            "contactPhone",
            Field::optional(Schema::string().min(6).max(20)),
        ),
    ]
}

/// `applicationCreateSchema`.
#[must_use]
pub fn application_create_schema() -> Schema {
    Schema::object(application_fields(true))
}

/// `applicationPatchSchema`.
#[must_use]
pub fn application_patch_schema() -> Schema {
    let mut fields = application_fields(false);
    fields.push(("baseVersion", Field::optional(Schema::integer().int_min(1))));
    fields.push((
        "sensitive",
        Field::optional(Schema::object(vec![
            ("assignedWalletId", Field::optional(identifier())),
            (
                "railWhitelist",
                Field::optional(Schema::array(Schema::string().min(1).max(64)).array_min(1)),
            ),
            (
                "redirectDomainAllowlist",
                Field::optional(Schema::array(Schema::string().min(1).max(200)).array_min(1)),
            ),
        ])),
    ));
    fields.push(("reason", Field::optional(Schema::string().max(500))));
    Schema::object(fields)
}

/// `linkCreateSchema` (`api/protected/links.ts:11-25`).
#[must_use]
pub fn link_create_schema() -> Schema {
    Schema::object(vec![
        ("title", Field::required(Schema::string().min(1).max(160))),
        ("description", Field::optional(Schema::string().max(1000))),
        (
            "amount",
            Field::required(Schema::string().pattern(Pattern::Amount)),
        ),
        (
            "currency",
            Field::required(Schema::string().pattern(Pattern::Currency)),
        ),
        (
            "feeBearer",
            Field::optional(Schema::Enum(&[
                "MERCHANT_ABSORBS",
                "PAYER_SURCHARGE",
                "SPLIT",
            ])),
        ),
        ("expiresAt", Field::optional(Schema::string().max(64))),
        (
            "maxUses",
            Field::optional(Schema::integer().int_min(1).int_max(1_000_000)),
        ),
        (
            "activeSlots",
            Field::optional(Schema::integer().int_min(1).int_max(100_000)),
        ),
        (
            "allowedRails",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_max(50)),
        ),
        ("metadata", Field::optional(json_object())),
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
    ])
}

/// `linkListQuerySchema`.
#[must_use]
pub fn link_list_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("status", Field::optional(Schema::Enum(LINK_STATUSES))),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
    ])
}

/// `cancelSchema` (links and external links).
#[must_use]
pub fn cancel_schema() -> Schema {
    Schema::object(vec![
        ("reason", Field::optional(Schema::string().max(256))),
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
    ])
}

/* -------------------------------------------------------------------------- *
 * POS
 * -------------------------------------------------------------------------- */

/// `terminalCreateSchema`.
#[must_use]
pub fn terminal_create_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::required(Schema::string().min(2).max(120))),
        ("applicationId", Field::optional(identifier())),
        ("location", Field::optional(Schema::string().max(160))),
        ("deviceId", Field::optional(Schema::string().max(128))),
    ])
}

/// `terminalPatchSchema`.
#[must_use]
pub fn terminal_patch_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::optional(Schema::string().min(2).max(120))),
        ("location", Field::optional(Schema::string().max(160))),
        (
            "status",
            Field::optional(Schema::Enum(&["ACTIVE", "INACTIVE"])),
        ),
    ])
}

/// `screenCreateSchema`.
#[must_use]
pub fn screen_create_schema() -> Schema {
    Schema::object(vec![
        ("label", Field::required(Schema::string().min(1).max(120))),
        (
            "mode",
            Field::optional(Schema::Enum(&["CASHIER", "CUSTOMER"])),
        ),
        (
            "ttlSeconds",
            Field::optional(Schema::integer().int_min(60).int_max(3600)),
        ),
    ])
}

/// `screenParamsSchema`.
#[must_use]
pub fn screen_params_schema() -> Schema {
    Schema::object(vec![("screenCode", Field::required(identifier()))])
}

/* -------------------------------------------------------------------------- *
 * payments / disputes / cash-outs
 * -------------------------------------------------------------------------- */

/// `paymentQuerySchema`.
#[must_use]
pub fn payment_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("linkId", Field::optional(identifier())),
        ("status", Field::optional(Schema::Enum(PAYMENT_STATUSES))),
        ("from", Field::optional(Schema::string().max(64))),
        ("to", Field::optional(Schema::string().max(64))),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
    ])
}

/// `disputeQuerySchema`.
#[must_use]
pub fn dispute_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("status", Field::optional(Schema::Enum(DISPUTE_STATUSES))),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
    ])
}

/// `evidenceSchema` (multipart metadata).
#[must_use]
pub fn evidence_schema() -> Schema {
    Schema::object(vec![
        (
            "evidenceType",
            Field::optional(Schema::Enum(EVIDENCE_TYPES)),
        ),
        ("notes", Field::optional(Schema::string().max(2000))),
        ("note", Field::optional(Schema::string().max(2000))),
        (
            "occurredAt",
            Field::optional(Schema::string().pattern(Pattern::IsoDatePrefix)),
        ),
    ])
}

/// `attachmentParamsSchema`.
#[must_use]
pub fn attachment_params_schema() -> Schema {
    Schema::object(vec![
        ("id", Field::required(identifier())),
        ("attachmentId", Field::required(identifier())),
    ])
}

/// `cashoutCreateSchema`.
#[must_use]
pub fn cashout_create_schema() -> Schema {
    Schema::object(vec![
        ("walletId", Field::required(identifier())),
        (
            "amount",
            Field::required(Schema::string().pattern(Pattern::Amount)),
        ),
        (
            "currency",
            Field::required(Schema::string().pattern(Pattern::Currency)),
        ),
        ("bankAccountId", Field::optional(identifier())),
        ("destinationBank", Field::optional(json_object())),
        ("reference", Field::optional(Schema::string().max(140))),
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
    ])
}

/// `cashoutQuerySchema`.
#[must_use]
pub fn cashout_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("status", Field::optional(Schema::Enum(CASHOUT_STATUSES))),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
    ])
}

/* -------------------------------------------------------------------------- *
 * users / credential sets / tokens
 * -------------------------------------------------------------------------- */

fn authorities_schema() -> Schema {
    Schema::Union(vec![
        Schema::array(Schema::string().min(2).max(64)).array_max(50),
        Schema::JsonObject { key_max: 64 },
    ])
}

/// `userCreateSchema`.
#[must_use]
pub fn user_create_schema() -> Schema {
    Schema::object(vec![
        ("email", Field::required(email())),
        ("phone", Field::optional(Schema::string().phone())),
        (
            "fullName",
            Field::required(Schema::string().min(2).max(120)),
        ),
        ("password", Field::optional(password())),
        (
            "role",
            Field::required(Schema::Enum(&[
                "MERCHANT_ADMIN",
                "MERCHANT_STAFF",
                "MERCHANT_CASHIER",
            ])),
        ),
        ("authoritiesMap", Field::optional(authorities_schema())),
        ("locale", Field::optional(Schema::Enum(&["ar", "en"]))),
    ])
}

/// `userPatchSchema`.
#[must_use]
pub fn user_patch_schema() -> Schema {
    Schema::object(vec![
        (
            "fullName",
            Field::optional(Schema::string().min(2).max(120)),
        ),
        (
            "role",
            Field::optional(Schema::Enum(&[
                "MERCHANT_ADMIN",
                "MERCHANT_STAFF",
                "MERCHANT_CASHIER",
            ])),
        ),
        (
            "status",
            Field::optional(Schema::Enum(&["ACTIVE", "SUSPENDED"])),
        ),
        ("authoritiesMap", Field::optional(authorities_schema())),
        ("locale", Field::optional(Schema::Enum(&["ar", "en"]))),
        ("baseVersion", Field::optional(Schema::integer().int_min(1))),
    ])
}

/// `userBulkPatchSchema`.
#[must_use]
pub fn user_bulk_patch_schema() -> Schema {
    Schema::object(vec![
        (
            "userIds",
            Field::required(Schema::array(identifier()).array_min(1).array_max(200)),
        ),
        (
            "role",
            Field::optional(Schema::Enum(&[
                "MERCHANT_ADMIN",
                "MERCHANT_STAFF",
                "MERCHANT_CASHIER",
            ])),
        ),
        (
            "status",
            Field::optional(Schema::Enum(&["ACTIVE", "SUSPENDED"])),
        ),
        ("authoritiesMap", Field::optional(authorities_schema())),
        ("reason", Field::optional(Schema::string().min(3).max(500))),
    ])
}

fn credential_entry_schema() -> Schema {
    Schema::object(vec![
        ("key", Field::required(Schema::string().min(1).max(64))),
        (
            "type",
            Field::required(Schema::Enum(&["HEADER", "QUERY", "BODY", "CERTIFICATE"])),
        ),
        ("value", Field::required(Schema::string().max(4096))),
        (
            "isSecret",
            Field::with_default(Schema::Bool, Value::Bool(true)),
        ),
    ])
}

/// `credentialCreateSchema`.
#[must_use]
pub fn credential_create_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::required(Schema::string().min(2).max(120))),
        ("gatewayId", Field::optional(identifier())),
        (
            "environment",
            Field::optional(Schema::Enum(&["sandbox", "test", "uat", "live"])),
        ),
        (
            "ownership",
            Field::optional(Schema::Enum(&["MERCHANT_DIRECT", "PLATFORM_MANAGED"])),
        ),
        (
            "authMethod",
            Field::optional(Schema::Enum(&[
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
            ])),
        ),
        ("secrets", Field::optional(json_object())),
        ("settings", Field::optional(json_object())),
        (
            "gatewayCode",
            Field::optional(Schema::string().min(2).max(64)),
        ),
        ("env", Field::optional(Schema::Enum(&["SANDBOX", "LIVE"]))),
        (
            "externalMerchantId",
            Field::optional(Schema::string().min(2).max(120)),
        ),
        (
            "settlementTarget",
            Field::optional(Schema::Enum(&[
                "PLATFORM_CLEARING",
                "MERCHANT_DIRECT",
                "PROVIDER_HELD",
            ])),
        ),
        (
            "entries",
            Field::optional(
                Schema::array(credential_entry_schema())
                    .array_min(1)
                    .array_max(40),
            ),
        ),
    ])
}

/// `credentialUpdateSchema`.
#[must_use]
pub fn credential_update_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::optional(Schema::string().min(2).max(120))),
        ("secrets", Field::optional(json_object())),
        ("settings", Field::optional(json_object())),
        (
            "entries",
            Field::optional(
                Schema::array(credential_entry_schema())
                    .array_min(1)
                    .array_max(40),
            ),
        ),
    ])
}

/// `tokenCreateSchema` minus the transform (custom checks live in [`validate_token_create`]).
#[must_use]
pub fn token_create_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::required(Schema::string().min(2).max(120))),
        (
            "scopes",
            Field::required(
                Schema::array(Schema::string().pattern(Pattern::TokenScope))
                    .array_min(1)
                    .array_max(50),
            ),
        ),
        (
            "allowedCidrs",
            Field::optional(Schema::array(Schema::string().min(3).max(64)).array_max(64)),
        ),
        ("expiresAt", Field::optional(Schema::string().max(64))),
    ])
}

/// `tokenIpsSchema` minus the CIDR refinement.
#[must_use]
pub fn token_ips_schema() -> Schema {
    Schema::object(vec![(
        "allowedCidrs",
        Field::required(Schema::array(Schema::string().min(3).max(64)).array_max(64)),
    )])
}

/// `tokenIpsSchema`: validate the list as well (`zStrictCidrList` in the TS file).
pub fn validate_token_ips(body: Value) -> Result<Value, EdgeApiError> {
    if let Err(issues) = validate_cidr_list(&body, "allowedCidrs") {
        return Err(EdgeApiError::validation(issues));
    }
    Ok(body)
}

/// The CIDR rule of `zStrictCidr`: a valid address/CIDR that is not an allow-everyone range.
pub fn validate_strict_cidr(value: &str, path: Vec<PathItem>) -> Result<(), Issue> {
    let Some(parsed) = pg_edge::parse_cidr(value) else {
        return Err(Issue::new(
            "custom",
            path,
            "must be a valid ip address or CIDR",
            Vec::new(),
        ));
    };
    let minimum = if parsed.addr().is_ipv4() { 8 } else { 32 };
    if parsed.prefix_len() < minimum {
        return Err(Issue::new(
            "custom",
            path,
            format!("CIDR is too broad (minimum prefix /{minimum})"),
            Vec::new(),
        ));
    }
    Ok(())
}

/// Apply the CIDR refinement of a list field, adding `path` indices to the first failure.
pub fn validate_cidr_list(body: &Value, field: &str) -> Result<(), Vec<Issue>> {
    let Some(entries) = body.get(field).and_then(Value::as_array) else {
        return Ok(());
    };
    let mut issues = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(text) = entry.as_str() else {
            continue; // the base schema already reports the type
        };
        if let Err(issue) = validate_strict_cidr(
            text,
            vec![PathItem::Key(field.to_owned()), PathItem::Index(index)],
        ) {
            issues.push(issue);
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// The full `POST /tokens` body validation: scopes limit/uniqueness, CIDR list, expiry.
///
/// Port of the `superRefine` + `transform` pipeline (`api/protected/tokens.ts:38-75`).
pub fn validate_token_create(
    body: Value,
    default_ttl_days: u32,
    max_ttl_days: u32,
    max_scopes: usize,
) -> Result<Value, EdgeApiError> {
    let mut issues = Vec::new();
    let base = match token_create_schema().validate(&body) {
        Ok(base) => base,
        Err(mut base_issues) => {
            issues.append(&mut base_issues);
            Value::Object(serde_json::Map::new())
        }
    };
    if !issues.is_empty() {
        return Err(EdgeApiError::validation(issues));
    }
    let scopes = base
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if scopes.len() > max_scopes {
        issues.push(Issue::new(
            "custom",
            vec![PathItem::Key("scopes".to_owned())],
            format!("at most {max_scopes} scopes are allowed"),
            Vec::new(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if scopes
        .iter()
        .filter_map(Value::as_str)
        .any(|scope| !seen.insert(scope.to_owned()))
    {
        issues.push(Issue::new(
            "custom",
            vec![PathItem::Key("scopes".to_owned())],
            "scopes must be unique",
            Vec::new(),
        ));
    }
    if let Err(mut cidr_issues) = validate_cidr_list(&base, "allowedCidrs") {
        issues.append(&mut cidr_issues);
    }
    if !issues.is_empty() {
        return Err(EdgeApiError::validation(issues));
    }

    let now = chrono::Utc::now();
    let max = now + chrono::Duration::days(i64::from(max_ttl_days));
    let expires_at = match base.get("expiresAt").and_then(Value::as_str) {
        None => now + chrono::Duration::days(i64::from(default_ttl_days)),
        Some(raw) => {
            if !Pattern::IsoDateTimePrefix.matches(raw) {
                issues.push(Issue::new(
                    "custom",
                    vec![PathItem::Key("expiresAt".to_owned())],
                    "must be an ISO 8601 date-time",
                    Vec::new(),
                ));
                return Err(EdgeApiError::validation(issues));
            }
            let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) else {
                issues.push(Issue::new(
                    "custom",
                    vec![PathItem::Key("expiresAt".to_owned())],
                    "must be an ISO 8601 date-time",
                    Vec::new(),
                ));
                return Err(EdgeApiError::validation(issues));
            };
            let parsed = parsed.with_timezone(&chrono::Utc);
            if parsed <= now {
                issues.push(Issue::new(
                    "custom",
                    vec![PathItem::Key("expiresAt".to_owned())],
                    "must be in the future",
                    Vec::new(),
                ));
                return Err(EdgeApiError::validation(issues));
            }
            if parsed > max {
                issues.push(Issue::new(
                    "custom",
                    vec![PathItem::Key("expiresAt".to_owned())],
                    format!("must be within {max_ttl_days} days"),
                    Vec::new(),
                ));
                return Err(EdgeApiError::validation(issues));
            }
            parsed
        }
    };
    let mut object = base.as_object().cloned().unwrap_or_default();
    object.insert(
        "expiresAt".to_owned(),
        Value::String(expires_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
    );
    Ok(Value::Object(object))
}

/* -------------------------------------------------------------------------- *
 * stats / webhooks
 * -------------------------------------------------------------------------- */

/// `overviewQuerySchema`.
#[must_use]
pub fn stats_overview_query_schema() -> Schema {
    Schema::object(vec![
        (
            "period",
            Field::optional(Schema::Enum(&["last_7d", "last_30d", "last_90d"])),
        ),
        ("from", Field::optional(Schema::string().max(64))),
        ("to", Field::optional(Schema::string().max(64))),
        (
            "currency",
            Field::optional(Schema::string().pattern(Pattern::Currency)),
        ),
    ])
}

/// `webhookEndpointCreateSchema`.
#[must_use]
pub fn webhook_endpoint_create_schema() -> Schema {
    Schema::object(vec![
        ("applicationId", Field::required(identifier())),
        ("url", Field::required(Schema::string().min(1).max(2000))),
        (
            "eventTypes",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_max(32)),
        ),
        (
            "description",
            Field::optional(Schema::nullable(Schema::string().max(200))),
        ),
    ])
}

/// `webhookEndpointPatchSchema`.
#[must_use]
pub fn webhook_endpoint_patch_schema() -> Schema {
    Schema::object(vec![
        ("url", Field::optional(Schema::string().min(1).max(2000))),
        (
            "eventTypes",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_max(32)),
        ),
        (
            "description",
            Field::optional(Schema::nullable(Schema::string().max(200))),
        ),
        ("enabled", Field::optional(Schema::Bool)),
    ])
}

/// `GET /webhooks/endpoints` query.
#[must_use]
pub fn webhook_endpoints_query_schema() -> Schema {
    Schema::object(vec![("applicationId", Field::optional(identifier()))])
}

/// `GET /webhooks/deliveries` query.
#[must_use]
pub fn webhook_deliveries_query_schema() -> Schema {
    Schema::object(vec![
        ("endpointId", Field::optional(identifier())),
        (
            "status",
            Field::optional(Schema::Enum(WEBHOOK_DELIVERY_STATUSES)),
        ),
        (
            "limit",
            Field::optional(Schema::coerce_integer().int_min(1).int_max(200)),
        ),
        ("before", Field::optional(Schema::string().max(64))),
    ])
}

/* -------------------------------------------------------------------------- *
 * report engine
 * -------------------------------------------------------------------------- */

/// `codeParams`.
#[must_use]
pub fn report_code_params_schema() -> Schema {
    Schema::object(vec![(
        "code",
        Field::required(Schema::string().min(1).max(64)),
    )])
}

/// `sourceParams`.
#[must_use]
pub fn report_source_params_schema() -> Schema {
    Schema::object(vec![(
        "sourceKey",
        Field::required(Schema::string().min(1).max(64)),
    )])
}

/// `idParams` (`z.string().uuid()`).
#[must_use]
pub fn uuid_params_schema() -> Schema {
    Schema::object(vec![(
        "id",
        Field::required(Schema::string().pattern(Pattern::Uuid)),
    )])
}

/// `executeBody`.
#[must_use]
pub fn report_execute_body_schema() -> Schema {
    Schema::object(vec![
        (
            "inputs",
            Field::with_default(Schema::json_object(1024), serde_json::json!({})),
        ),
        ("locale", Field::optional(Schema::string().max(16))),
        (
            "renderMode",
            Field::optional(Schema::Enum(&["CLIENT_PAGED_VECTOR", "SERVER_PDF"])),
        ),
    ])
}

/// `studioBody`.
#[must_use]
pub fn report_studio_body_schema() -> Schema {
    Schema::object(vec![
        (
            "specJson",
            Field::required(Schema::Union(vec![
                Schema::string(),
                Schema::json_object(1024),
            ])),
        ),
        ("assetsZipBase64", Field::optional(Schema::string())),
    ])
}

/// `studio/preview` body.
#[must_use]
pub fn report_preview_body_schema() -> Schema {
    Schema::object(vec![
        (
            "specJson",
            Field::required(Schema::Union(vec![
                Schema::string(),
                Schema::json_object(1024),
            ])),
        ),
        ("assetsZipBase64", Field::optional(Schema::string())),
        ("inputs", Field::optional(Schema::json_object(1024))),
        ("locale", Field::optional(Schema::string().max(16))),
        (
            "mode",
            Field::with_default(Schema::Enum(&["MOCK", "LIVE"]), serde_json::json!("MOCK")),
        ),
    ])
}

/// `studio/specs` POST body.
#[must_use]
pub fn report_spec_publish_body_schema() -> Schema {
    Schema::object(vec![
        (
            "specJson",
            Field::required(Schema::Union(vec![
                Schema::string(),
                Schema::json_object(1024),
            ])),
        ),
        ("assetsZipBase64", Field::optional(Schema::string())),
        ("publish", Field::optional(Schema::Bool)),
    ])
}

/// `studio/specs` GET query.
#[must_use]
pub fn report_specs_query_schema() -> Schema {
    Schema::passthrough(vec![("code", Field::optional(Schema::string().max(64)))])
}

/// `studio/chrome` POST body.
#[must_use]
pub fn report_chrome_body_schema() -> Schema {
    Schema::object(vec![
        (
            "specJson",
            Field::required(Schema::Union(vec![
                Schema::string(),
                Schema::json_object(1024),
            ])),
        ),
        ("assetsZipBase64", Field::optional(Schema::string())),
        ("publish", Field::optional(Schema::Bool)),
        ("makeDefault", Field::optional(Schema::Bool)),
    ])
}

/// `studio/chrome` GET query.
#[must_use]
pub fn report_chrome_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("type", Field::optional(Schema::string().max(16))),
        ("includeArchived", Field::optional(Schema::string())),
        ("includeAssets", Field::optional(Schema::string())),
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
        ("search", Field::optional(Schema::string().max(200))),
    ])
}

/// `studio/chrome/needs-migration` and `studio/needs-migration` query.
#[must_use]
pub fn report_needs_migration_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
        ("search", Field::optional(Schema::string().max(200))),
    ])
}

/// `studio/catalog` and autocomplete queries (passthrough).
#[must_use]
pub fn report_catalog_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("page", Field::optional(page())),
        ("pageSize", Field::optional(page_size())),
        ("search", Field::optional(Schema::string().max(200))),
        ("sortKey", Field::optional(Schema::string().max(64))),
        (
            "sortDirection",
            Field::optional(Schema::Enum(&["asc", "desc"])),
        ),
    ])
}

/// `autocomplete/:sourceKey` query.
#[must_use]
pub fn report_autocomplete_query_schema() -> Schema {
    Schema::passthrough(vec![
        ("q", Field::optional(Schema::string())),
        (
            "limit",
            Field::optional(Schema::coerce_integer().int_min(1).int_max(50)),
        ),
        ("dependent", Field::optional(Schema::string())),
    ])
}

/// `clone` body.
#[must_use]
pub fn report_clone_body_schema() -> Schema {
    Schema::object(vec![(
        "code",
        Field::optional(Schema::string().min(1).max(64)),
    )])
}

/// `set-default` body.
#[must_use]
pub fn report_set_default_schema() -> Schema {
    Schema::object(vec![("isDefault", Field::required(Schema::Bool))])
}

/// `external/links` body: the same portal contract with the three public fee bearers.
#[must_use]
pub fn external_link_create_schema() -> Schema {
    link_create_schema()
}

/// `external` payment reference params.
#[must_use]
pub fn external_reference_params_schema() -> Schema {
    Schema::object(vec![("reference", Field::required(identifier()))])
}

/// `external` link key params.
#[must_use]
pub fn external_key_params_schema() -> Schema {
    Schema::object(vec![("key", Field::required(identifier()))])
}

/// `POST /tokens` core field check: the edge sends `expiresAt` always.
#[must_use]
pub fn normalize_phone_for_tests(value: &str) -> Option<String> {
    normalize_libyan_phone(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::validate_to_error;
    use serde_json::json;

    #[test]
    fn password_policy_matches_the_portal() {
        let schema = password();
        assert!(schema.validate(&json!("Sup3rSecretPass")).is_ok());
        assert!(schema.validate(&json!("short")).is_err());
        assert!(schema.validate(&json!("alllowercase1")).is_err());
        assert!(schema.validate(&json!("ALLUPPERCASE1")).is_err());
        assert!(schema.validate(&json!("NoDigitsHereAtAll")).is_err());
    }

    #[test]
    fn phone_is_transformed_inside_the_request_body() {
        let body = validate_to_error(
            &verify_identity_schema(),
            &json!({
                "identityType": "NATIONAL_ID",
                "identityNumber": "123456789012",
                "phone": "0912345678",
                "code": "123456"
            }),
        )
        .expect("valid");
        assert_eq!(body["phone"], json!("912345678"));
    }

    #[test]
    fn withdraw_reason_is_trimmed() {
        let body = validate_to_error(
            &withdraw_schema(),
            &json!({ "reason": "  Correcting details  " }),
        )
        .expect("valid");
        assert_eq!(body["reason"], json!("Correcting details"));
    }

    #[test]
    fn unknown_keys_are_rejected_on_strict_objects() {
        let issues = withrew_unknown();
        assert_eq!(issues[0].code, "unrecognized_keys");
    }

    fn withrew_unknown() -> Vec<Issue> {
        withdraw_schema()
            .validate(&json!({ "reason": "valid reason", "extra": 1 }))
            .expect_err("strict")
    }

    #[test]
    fn token_validation_defaults_and_limits_the_expiry() {
        let now = chrono::Utc::now();
        let validated = validate_token_create(
            json!({
                "name": "integration token",
                "scopes": ["link:read"],
                "allowedCidrs": ["10.0.0.0/8"]
            }),
            90,
            365,
            20,
        )
        .expect("valid");
        let expires = validated["expiresAt"].as_str().expect("expires");
        let parsed = chrono::DateTime::parse_from_rfc3339(expires).expect("iso");
        let days = (parsed.with_timezone(&chrono::Utc) - now).num_days();
        assert!((89..=90).contains(&days), "{days}");

        let past = (now - chrono::Duration::days(1))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        assert_eq!(
            validate_token_create(
                json!({ "name": "token", "scopes": ["link:read"], "expiresAt": past }),
                90,
                365,
                20
            )
            .expect_err("past")
            .status,
            400
        );

        let too_far = (now + chrono::Duration::days(400))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        assert!(validate_token_create(
            json!({ "name": "token", "scopes": ["link:read"], "expiresAt": too_far }),
            90,
            365,
            20
        )
        .is_err());
    }

    #[test]
    fn token_cidrs_and_scopes_are_refined() {
        for cidrs in [
            json!(["0.0.0.0/0"]),
            json!(["::/0"]),
            json!(["1.0.0.0/4"]),
            json!(["999.1.1.1/8"]),
            json!(["not-a-cidr"]),
            json!(["10.0.0.0/33"]),
            json!(["10.0.0.0/8", "::/0"]),
        ] {
            assert!(
                validate_token_create(
                    json!({ "name": "token", "scopes": ["link:read"], "allowedCidrs": cidrs }),
                    90,
                    365,
                    20
                )
                .is_err(),
                "{cidrs}"
            );
        }
        assert!(validate_token_create(
            json!({
                "name": "token",
                "scopes": ["link:read"],
                "allowedCidrs": ["203.0.113.7", "2001:db8::/48"]
            }),
            90,
            365,
            20
        )
        .is_ok());

        for scopes in [
            json!(["*"]),
            json!(["*:*"]),
            json!(["admin:*"]),
            json!(["Links:Read"]),
            json!(["no.such.scope"]),
            json!(["link:read", "link:read"]),
        ] {
            assert!(
                validate_token_create(json!({ "name": "token", "scopes": scopes }), 90, 365, 20)
                    .is_err(),
                "{scopes}"
            );
        }
        let too_many: Vec<String> = (0..21).map(|index| format!("link:action{index}")).collect();
        assert!(
            validate_token_create(json!({ "name": "token", "scopes": too_many }), 90, 365, 20)
                .is_err()
        );
    }

    #[test]
    fn report_engine_spec_json_accepts_a_string_or_object() {
        let string = validate_to_error(&report_studio_body_schema(), &json!({ "specJson": "{}" }))
            .expect("string");
        assert_eq!(string["specJson"], json!("{}"));
        let object = validate_to_error(
            &report_studio_body_schema(),
            &json!({ "specJson": { "version": 1 } }),
        )
        .expect("object");
        assert_eq!(object["specJson"], json!({ "version": 1 }));
        assert_eq!(
            report_studio_body_schema()
                .validate(&json!({ "specJson": 7 }))
                .expect_err("number")[0]
                .code,
            "invalid_union"
        );
    }

    #[test]
    fn nullable_webhook_description() {
        let body = validate_to_error(
            &webhook_endpoint_patch_schema(),
            &json!({ "enabled": false, "description": null }),
        )
        .expect("valid");
        assert_eq!(body["description"], Value::Null);
    }

    #[test]
    fn filters_accept_deep_pagination_and_passthrough_fields() {
        let query = json!({ "page": "23397", "pageSize": "25", "currency": "LYD" });
        let validated = validate_to_error(&list_query_schema(), &query).expect("valid");
        assert_eq!(validated["page"], json!(23397));
        assert_eq!(validated["pageSize"], json!(25));
        assert_eq!(validated["currency"], json!("LYD"));
    }

    #[test]
    fn stats_query_is_strict() {
        assert!(stats_overview_query_schema()
            .validate(&json!({ "period": "last_7d" }))
            .is_ok());
        assert!(stats_overview_query_schema()
            .validate(&json!({ "period": "last_7d", "extra": "1" }))
            .is_err());
        assert!(stats_overview_query_schema()
            .validate(&json!({ "currency": "lyd" }))
            .is_err());
    }

    #[test]
    fn external_link_requires_amount() {
        assert!(external_link_create_schema()
            .validate(&json!({ "title": "Invoice 43", "currency": "LYD" }))
            .is_err());
        assert!(external_link_create_schema()
            .validate(&json!({ "title": "Invoice 43", "amount": "125.5000", "currency": "LYD" }))
            .is_ok());
    }
}
