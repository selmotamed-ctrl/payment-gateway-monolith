//! Canonical merchant channel contract.
//!
//! Port of `merchant-back/api/contract.ts`: the core schemas the edge re-validates against and the
//! public→core mappers. The rules of the TypeScript file are kept literally:
//!
//! * only keys accepted by the core schema are emitted (core schemas are strict);
//! * keys required by the core schema are always emitted;
//! * renamed fields are mapped explicitly, unknown keys never pass through;
//! * optional core fields the public API does not expose are omitted.

#![forbid(unsafe_code)]

use base64::Engine as _;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::validate::{Field, Pattern, Schema};

/// `core-back` parses JSON bodies with a 1 MiB limit; evidence travels base64 encoded.
pub const CORE_JSON_BODY_LIMIT_BYTES: usize = 1024 * 1024;
/// `MAX_EVIDENCE_FILE_BYTES = floor(((CORE_JSON_BODY_LIMIT_BYTES - 96 KiB) * 3) / 4)`.
pub const MAX_EVIDENCE_FILE_BYTES: usize = (CORE_JSON_BODY_LIMIT_BYTES - 96 * 1024) * 3 / 4;

pub const USER_ROLES: &[&str] = &["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"];
pub const USER_STATUSES: &[&str] = &["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"];
pub const CREDENTIAL_ENTRY_TYPES: &[&str] = &["HEADER", "QUERY", "BODY", "CERTIFICATE"];
pub const CREDENTIAL_ENVS: &[&str] = &["SANDBOX", "LIVE"];
pub const SETTLEMENT_TARGETS: &[&str] = &["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"];
pub const POS_TERMINAL_STATUSES: &[&str] = &["ACTIVE", "INACTIVE", "BLOCKED"];
pub const POS_TERMINAL_PATCH_STATUSES: &[&str] = &["ACTIVE", "INACTIVE"];
pub const LINK_FEE_BEARERS: &[&str] = &[
    "PAYER",
    "MERCHANT",
    "PLATFORM",
    "MERCHANT_ABSORBS",
    "PAYER_SURCHARGE",
    "SPLIT",
];
pub const PUBLIC_LINK_FEE_BEARERS: &[&str] = &["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"];

fn core_id() -> Schema {
    Schema::string().min(1).max(64)
}

fn core_amount() -> Schema {
    Schema::string().pattern(Pattern::Amount)
}

fn core_volume() -> Schema {
    Schema::string().pattern(Pattern::Volume)
}

fn core_authority_list() -> Schema {
    Schema::array(Schema::string().min(2).max(64)).array_max(50)
}

fn core_json_record() -> Schema {
    Schema::json_object(64)
}

fn credential_entry() -> Schema {
    Schema::object(vec![
        ("key", Field::required(Schema::string().min(1).max(64))),
        (
            "type",
            Field::required(Schema::Enum(CREDENTIAL_ENTRY_TYPES)),
        ),
        ("value", Field::required(Schema::string().max(4096))),
        (
            "isSecret",
            Field::with_default(Schema::Bool, Value::Bool(true)),
        ),
    ])
}

/// `coreWalletCreateSchema`.
#[must_use]
pub fn core_wallet_create_schema() -> Schema {
    Schema::object(vec![
        (
            "currency",
            Field::with_default(Schema::string().len(3), json!("LYD")),
        ),
        ("label", Field::optional(Schema::string().max(80))),
    ])
}

/// `coreApplicationCreateSchema`.
#[must_use]
pub fn core_application_create_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::required(Schema::string().min(2).max(160))),
        (
            "businessUseDescription",
            Field::optional(Schema::string().max(2000)),
        ),
        ("expectedMonthlyVolume", Field::optional(core_volume())),
        ("assignedWalletId", Field::required(core_id())),
        (
            "railWhitelist",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_min(1)),
        ),
        (
            "redirectDomainAllowlist",
            Field::optional(Schema::array(Schema::string().min(1).max(200)).array_min(1)),
        ),
    ])
}

/// `coreApplicationPatchSchema`.
#[must_use]
pub fn core_application_patch_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::optional(Schema::string().min(2).max(160))),
        (
            "businessUseDescription",
            Field::optional(Schema::string().max(2000)),
        ),
        ("expectedMonthlyVolume", Field::optional(core_volume())),
        ("assignedWalletId", Field::optional(core_id())),
        (
            "railWhitelist",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_min(1)),
        ),
        (
            "redirectDomainAllowlist",
            Field::optional(Schema::array(Schema::string().min(1).max(200)).array_min(1)),
        ),
    ])
}

/// `coreUserCreateSchema`.
#[must_use]
pub fn core_user_create_schema() -> Schema {
    Schema::object(vec![
        (
            "email",
            Field::required(Schema::string().pattern(Pattern::Email)),
        ),
        ("phone", Field::optional(Schema::string().min(6).max(20))),
        (
            "password",
            Field::required(Schema::string().min(10).max(128)),
        ),
        ("role", Field::required(Schema::Enum(USER_ROLES))),
        (
            "authoritiesMap",
            Field::with_default(core_authority_list(), json!([])),
        ),
    ])
}

/// `coreUserPatchSchema` (the target user travels in the body).
#[must_use]
pub fn core_user_patch_schema() -> Schema {
    Schema::object(vec![
        ("id", Field::required(core_id())),
        ("authoritiesMap", Field::optional(core_authority_list())),
        ("role", Field::optional(Schema::Enum(USER_ROLES))),
        ("status", Field::optional(Schema::Enum(USER_STATUSES))),
    ])
}

/// `coreUserPatchByIdSchema`.
#[must_use]
pub fn core_user_patch_by_id_schema() -> Schema {
    Schema::object(vec![
        ("authoritiesMap", Field::optional(core_authority_list())),
        ("role", Field::optional(Schema::Enum(USER_ROLES))),
        ("status", Field::optional(Schema::Enum(USER_STATUSES))),
    ])
}

/// `coreCredentialSetCreateSchema`.
#[must_use]
pub fn core_credential_set_create_schema() -> Schema {
    Schema::object(vec![
        (
            "gatewayCode",
            Field::required(Schema::string().min(2).max(64)),
        ),
        ("env", Field::required(Schema::Enum(CREDENTIAL_ENVS))),
        (
            "externalMerchantId",
            Field::required(Schema::string().min(2).max(120)),
        ),
        (
            "settlementTarget",
            Field::required(Schema::Enum(SETTLEMENT_TARGETS)),
        ),
        (
            "entries",
            Field::required(Schema::array(credential_entry()).array_min(1).array_max(40)),
        ),
    ])
}

/// `coreCredentialSetUpdateSchema`.
#[must_use]
pub fn core_credential_set_update_schema() -> Schema {
    Schema::object(vec![(
        "entries",
        Field::required(Schema::array(credential_entry()).array_min(1).array_max(40)),
    )])
}

/// `coreCashoutCreateSchema`.
#[must_use]
pub fn core_cashout_create_schema() -> Schema {
    Schema::object(vec![
        ("walletId", Field::required(core_id())),
        ("amount", Field::required(core_amount())),
        ("destinationBank", Field::required(core_json_record())),
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
    ])
}

/// `corePosTerminalCreateSchema`.
#[must_use]
pub fn core_pos_terminal_create_schema() -> Schema {
    Schema::object(vec![
        ("applicationId", Field::required(core_id())),
        ("name", Field::required(Schema::string().min(1).max(120))),
        ("location", Field::optional(Schema::string().max(200))),
    ])
}

/// `corePosTerminalPatchSchema`.
#[must_use]
pub fn core_pos_terminal_patch_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::optional(Schema::string().min(1).max(120))),
        ("location", Field::optional(Schema::string().max(200))),
        (
            "status",
            Field::optional(Schema::Enum(POS_TERMINAL_STATUSES)),
        ),
    ])
}

/// `coreDisputeEvidenceSchema`.
#[must_use]
pub fn core_dispute_evidence_schema() -> Schema {
    Schema::object(vec![
        ("evidence", Field::required(core_json_record())),
        ("notes", Field::optional(Schema::string().max(4000))),
    ])
}

/// `coreJoinRequestSchema`.
#[must_use]
pub fn core_join_request_schema() -> Schema {
    Schema::object(vec![
        (
            "legalName",
            Field::optional(Schema::string().min(2).max(160)),
        ),
        (
            "tradeName",
            Field::optional(Schema::string().min(2).max(160)),
        ),
        ("country", Field::optional(Schema::string().len(2))),
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
        (
            "email",
            Field::optional(Schema::string().pattern(Pattern::Email)),
        ),
        (
            "website",
            Field::optional(Schema::string().pattern(Pattern::Website)),
        ),
        ("locale", Field::optional(Schema::Enum(&["ar", "en"]))),
    ])
}

/// `coreBeneficialOwnerSchema`.
#[must_use]
pub fn core_beneficial_owner_schema() -> Schema {
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

/// `coreOnboardingSubmitSchema`.
#[must_use]
pub fn core_onboarding_submit_schema() -> Schema {
    Schema::object(vec![
        ("acknowledgement", Field::required(Schema::LiteralTrue)),
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
    ])
}

/// `coreLinkCreateSchema`.
#[must_use]
pub fn core_link_create_schema() -> Schema {
    Schema::object(vec![
        ("title", Field::required(Schema::string().min(1).max(160))),
        ("description", Field::optional(Schema::string().max(1000))),
        ("amount", Field::required(core_amount())),
        ("currency", Field::required(Schema::string().len(3))),
        ("feeBearer", Field::optional(Schema::Enum(LINK_FEE_BEARERS))),
        ("applicationId", Field::optional(core_id())),
        ("walletId", Field::optional(core_id())),
        ("expiresAt", Field::optional(Schema::string().max(64))),
        (
            "maxUses",
            Field::optional(Schema::integer().int_min(1).int_max(1_000_000)),
        ),
        ("infiniteUse", Field::optional(Schema::Bool)),
        (
            "activeSlots",
            Field::optional(Schema::integer().int_min(1).int_max(100_000)),
        ),
        (
            "allowedRails",
            Field::optional(Schema::array(Schema::string().min(1).max(64)).array_max(50)),
        ),
        ("metadata", Field::optional(core_json_record())),
        (
            "idempotencyKey",
            Field::optional(Schema::string().min(8).max(128)),
        ),
    ])
}

/// `coreTokenCreateSchema`.
#[must_use]
pub fn core_token_create_schema() -> Schema {
    Schema::object(vec![
        ("name", Field::required(Schema::string().min(2).max(120))),
        (
            "scopes",
            Field::required(
                Schema::array(Schema::string().min(2).max(64))
                    .array_min(1)
                    .array_max(50),
            ),
        ),
        (
            "allowedCidrs",
            Field::optional(Schema::array(Schema::string().min(3).max(64)).array_max(64)),
        ),
        ("applicationId", Field::optional(core_id())),
        ("expiresAt", Field::optional(Schema::string().max(64))),
    ])
}

/// `coreTokenIpsSchema`.
#[must_use]
pub fn core_token_ips_schema() -> Schema {
    Schema::object(vec![(
        "allowedCidrs",
        Field::required(Schema::array(Schema::string().min(3).max(64)).array_max(64)),
    )])
}

/// `coreRegisterSchema`.
#[must_use]
pub fn core_register_schema() -> Schema {
    Schema::object(vec![
        (
            "email",
            Field::required(Schema::string().pattern(Pattern::Email)),
        ),
        (
            "password",
            Field::required(Schema::string().min(10).max(128)),
        ),
        (
            "fullName",
            Field::required(Schema::string().min(2).max(120)),
        ),
        ("locale", Field::optional(Schema::Enum(&["ar", "en"]))),
    ])
}

/// `coreVerifyIdentitySchema`.
#[must_use]
pub fn core_verify_identity_schema() -> Schema {
    Schema::object(vec![
        (
            "identityType",
            Field::required(Schema::Enum(&["NATIONAL_ID", "PASSPORT"])),
        ),
        (
            "identityNumber",
            Field::required(Schema::string().min(4).max(32)),
        ),
        ("phone", Field::required(Schema::string().min(6).max(20))),
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::Otp)),
        ),
    ])
}

/// `coreLoginSchema`.
#[must_use]
pub fn core_login_schema() -> Schema {
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

/// `coreInvitationAcceptSchema`.
#[must_use]
pub fn core_invitation_accept_schema() -> Schema {
    Schema::object(vec![
        ("token", Field::required(Schema::string().min(16).max(256))),
        (
            "password",
            Field::required(Schema::string().min(10).max(128)),
        ),
        ("phone", Field::optional(Schema::string().min(6).max(20))),
    ])
}

/// `coreGoogleSchema`.
#[must_use]
pub fn core_google_schema() -> Schema {
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

/// `coreGoogleExchangeSchema`.
#[must_use]
pub fn core_google_exchange_schema() -> Schema {
    Schema::object(vec![(
        "ticket",
        Field::required(Schema::string().min(16).max(512)),
    )])
}

/// `coreEmailVerifySchema`.
#[must_use]
pub fn core_email_verify_schema() -> Schema {
    Schema::object(vec![
        (
            "email",
            Field::required(Schema::string().pattern(Pattern::Email)),
        ),
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::MfaCode)),
        ),
    ])
}

/// `coreEmailResendSchema`.
#[must_use]
pub fn core_email_resend_schema() -> Schema {
    Schema::object(vec![(
        "email",
        Field::required(Schema::string().pattern(Pattern::Email)),
    )])
}

/// `corePasswordForgotSchema`.
#[must_use]
pub fn core_password_forgot_schema() -> Schema {
    Schema::object(vec![(
        "email",
        Field::required(Schema::string().pattern(Pattern::Email)),
    )])
}

/// `corePasswordResetSchema`.
#[must_use]
pub fn core_password_reset_schema() -> Schema {
    Schema::object(vec![
        (
            "email",
            Field::required(Schema::string().pattern(Pattern::Email)),
        ),
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::MfaCode)),
        ),
        (
            "newPassword",
            Field::required(Schema::string().min(10).max(128)),
        ),
    ])
}

/// `coreMfaResendSchema`.
#[must_use]
pub fn core_mfa_resend_schema() -> Schema {
    Schema::object(vec![(
        "challengeId",
        Field::required(Schema::string().pattern(Pattern::Uuid)),
    )])
}

/// `coreMfaSchema`.
#[must_use]
pub fn core_mfa_schema() -> Schema {
    Schema::object(vec![
        (
            "code",
            Field::required(Schema::string().pattern(Pattern::MfaCode)),
        ),
        (
            "challengeId",
            Field::optional(Schema::string().min(4).max(4096)),
        ),
    ])
}

/* -------------------------------------------------------------------------- *
 * helpers
 * -------------------------------------------------------------------------- */

fn object_of(body: &Value) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    body.as_object()
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

fn as_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn as_plain_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `compact`: emit only the values that are not `undefined` (absent in JSON).
fn insert(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

fn first_defined<'a>(body: &'a Map<String, Value>, first: &str, second: &str) -> Option<&'a Value> {
    body.get(first)
        .filter(|value| !value.is_null())
        .or_else(|| body.get(second).filter(|value| !value.is_null()))
}

/// `value ?? fallback`: JSON `null` counts as absent.
fn non_null(value: Option<&Value>) -> Option<Value> {
    value.filter(|value| !value.is_null()).cloned()
}

/// `normalizeAuthorities`: list passthrough, portal map → enabled keys.
#[must_use]
pub fn normalize_authorities(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => Some(Value::Array(
            items
                .iter()
                .filter(|entry| entry.is_string())
                .cloned()
                .collect(),
        )),
        Some(Value::Object(record)) => Some(Value::Array(
            record
                .iter()
                .filter(|(_, enabled)| enabled.as_bool() == Some(true))
                .map(|(authority, _)| Value::String(authority.clone()))
                .collect(),
        )),
        _ => None,
    }
}

/// `normalizeCredentialEnv`.
#[must_use]
pub fn normalize_credential_env(value: Option<&Value>) -> Option<&'static str> {
    let normalized = as_string(value)?.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "LIVE" | "PRODUCTION" => Some("LIVE"),
        "SANDBOX" | "TEST" | "UAT" | "STAGING" | "DEV" | "DEVELOPMENT" => Some("SANDBOX"),
        _ => None,
    }
}

/// `normalizeSettlementTarget`.
#[must_use]
pub fn normalize_settlement_target(value: Option<&Value>) -> Option<&'static str> {
    match as_string(value)?.trim().to_ascii_uppercase().as_str() {
        "MERCHANT_DIRECT" => Some("MERCHANT_DIRECT"),
        "PLATFORM_CLEARING" | "PLATFORM_MANAGED" => Some("PLATFORM_CLEARING"),
        "PROVIDER_HELD" => Some("PROVIDER_HELD"),
        _ => None,
    }
}

/// `normalizeCredentialEntries`.
#[must_use]
pub fn normalize_credential_entries(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => Some(Value::Array(items.clone())),
        Some(Value::Object(record)) => Some(Value::Array(
            record
                .iter()
                .map(|(key, raw)| {
                    let rendered = match raw {
                        Value::String(text) => text.clone(),
                        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned()),
                    };
                    json!({
                        "key": key,
                        "type": "HEADER",
                        "value": rendered,
                        "isSecret": true,
                    })
                })
                .collect(),
        )),
        _ => None,
    }
}

/// `normalizeDestinationBank`.
#[must_use]
pub fn normalize_destination_bank(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(value @ Value::Object(_)) => Some(value.clone()),
        Some(Value::String(account)) => Some(json!({ "bankAccountId": account })),
        _ => None,
    }
}

/* -------------------------------------------------------------------------- *
 * mappers: public payload → canonical core payload
 * -------------------------------------------------------------------------- */

/// `toCoreWalletCreate`.
#[must_use]
pub fn to_core_wallet_create(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(
        &mut out,
        "currency",
        as_string(body.get("currency")).map(|value| Value::String(value.to_owned())),
    );
    insert(
        &mut out,
        "label",
        as_string(body.get("label")).map(|value| Value::String(value.to_owned())),
    );
    Value::Object(out)
}

/// `toCoreApplicationCreate`.
#[must_use]
pub fn to_core_application_create(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(&mut out, "name", body.get("name").cloned());
    insert(
        &mut out,
        "businessUseDescription",
        first_defined(body, "description", "businessUseDescription").cloned(),
    );
    insert(
        &mut out,
        "expectedMonthlyVolume",
        body.get("expectedMonthlyVolume").cloned(),
    );
    insert(
        &mut out,
        "assignedWalletId",
        body.get("assignedWalletId").cloned(),
    );
    insert(
        &mut out,
        "railWhitelist",
        body.get("railWhitelist").cloned(),
    );
    insert(
        &mut out,
        "redirectDomainAllowlist",
        body.get("redirectDomainAllowlist").cloned(),
    );
    Value::Object(out)
}

/// `toCoreApplicationPatch`.
#[must_use]
pub fn to_core_application_patch(body: &Value) -> Value {
    let body = object_of(body);
    let sensitive = as_plain_object(body.get("sensitive"));
    let mut out = Map::new();
    insert(&mut out, "name", body.get("name").cloned());
    insert(
        &mut out,
        "businessUseDescription",
        first_defined(body, "description", "businessUseDescription").cloned(),
    );
    insert(
        &mut out,
        "expectedMonthlyVolume",
        body.get("expectedMonthlyVolume").cloned(),
    );
    insert(
        &mut out,
        "assignedWalletId",
        non_null(body.get("assignedWalletId")).or_else(|| {
            sensitive
                .and_then(|value| value.get("assignedWalletId"))
                .cloned()
        }),
    );
    insert(
        &mut out,
        "railWhitelist",
        non_null(body.get("railWhitelist")).or_else(|| {
            sensitive
                .and_then(|value| value.get("railWhitelist"))
                .cloned()
        }),
    );
    insert(
        &mut out,
        "redirectDomainAllowlist",
        non_null(body.get("redirectDomainAllowlist")).or_else(|| {
            sensitive
                .and_then(|value| value.get("redirectDomainAllowlist"))
                .cloned()
        }),
    );
    Value::Object(out)
}

/// `toCoreUserCreate`.
#[must_use]
pub fn to_core_user_create(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(&mut out, "email", body.get("email").cloned());
    insert(&mut out, "phone", body.get("phone").cloned());
    insert(&mut out, "password", body.get("password").cloned());
    insert(&mut out, "role", body.get("role").cloned());
    insert(
        &mut out,
        "authoritiesMap",
        normalize_authorities(body.get("authoritiesMap")),
    );
    Value::Object(out)
}

/// `toCoreUserPatch` (bulk patch; one user per call, the id is in the body).
#[must_use]
pub fn to_core_user_patch(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(&mut out, "id", body.get("id").cloned());
    insert(
        &mut out,
        "authoritiesMap",
        normalize_authorities(body.get("authoritiesMap")),
    );
    insert(&mut out, "role", body.get("role").cloned());
    insert(&mut out, "status", body.get("status").cloned());
    Value::Object(out)
}

/// `toCoreUserPatchById`.
#[must_use]
pub fn to_core_user_patch_by_id(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(
        &mut out,
        "authoritiesMap",
        normalize_authorities(body.get("authoritiesMap")),
    );
    insert(&mut out, "role", body.get("role").cloned());
    insert(&mut out, "status", body.get("status").cloned());
    Value::Object(out)
}

/// `toCoreCredentialSetCreate`.
#[must_use]
pub fn to_core_credential_set_create(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(
        &mut out,
        "gatewayCode",
        as_string(body.get("gatewayCode"))
            .or_else(|| as_string(body.get("gatewayId")))
            .map(|value| Value::String(value.to_owned())),
    );
    insert(
        &mut out,
        "env",
        normalize_credential_env(first_defined(body, "env", "environment"))
            .map(|value| Value::String(value.to_owned())),
    );
    insert(
        &mut out,
        "externalMerchantId",
        as_string(body.get("externalMerchantId")).map(|value| Value::String(value.to_owned())),
    );
    insert(
        &mut out,
        "settlementTarget",
        normalize_settlement_target(first_defined(body, "settlementTarget", "ownership"))
            .map(|value| Value::String(value.to_owned())),
    );
    insert(
        &mut out,
        "entries",
        normalize_credential_entries(first_defined(body, "entries", "secrets")),
    );
    Value::Object(out)
}

/// `toCoreCredentialSetUpdate`.
#[must_use]
pub fn to_core_credential_set_update(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(
        &mut out,
        "entries",
        normalize_credential_entries(first_defined(body, "entries", "secrets")),
    );
    Value::Object(out)
}

/// `toCoreCashoutCreate`.
#[must_use]
pub fn to_core_cashout_create(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(&mut out, "walletId", body.get("walletId").cloned());
    insert(&mut out, "amount", body.get("amount").cloned());
    insert(
        &mut out,
        "destinationBank",
        normalize_destination_bank(first_defined(body, "destinationBank", "bankAccountId")),
    );
    insert(
        &mut out,
        "idempotencyKey",
        body.get("idempotencyKey").cloned(),
    );
    Value::Object(out)
}

/// `toCorePosTerminalCreate`.
#[must_use]
pub fn to_core_pos_terminal_create(body: &Value) -> Value {
    let body = object_of(body);
    let mut out = Map::new();
    insert(
        &mut out,
        "applicationId",
        body.get("applicationId").cloned(),
    );
    insert(&mut out, "name", body.get("name").cloned());
    insert(&mut out, "location", body.get("location").cloned());
    Value::Object(out)
}

/// One uploaded document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceUpload {
    pub original_name: String,
    pub bytes: Vec<u8>,
}

/// `toCoreDisputeEvidence`: the file travels base64 encoded inside a regular JSON body.
#[must_use]
pub fn to_core_dispute_evidence(
    file: &EvidenceUpload,
    metadata: &Value,
    detected_mime: &str,
) -> Value {
    let metadata = object_of(metadata);
    let digest = Sha256::digest(&file.bytes);
    let mut evidence = Map::new();
    evidence.insert(
        "fileName".to_owned(),
        Value::String(truncate_chars(&file.original_name, 200)),
    );
    evidence.insert(
        "contentType".to_owned(),
        Value::String(detected_mime.to_owned()),
    );
    evidence.insert("sha256".to_owned(), Value::String(hex::encode(digest)));
    evidence.insert(
        "sizeBytes".to_owned(),
        Value::Number(u64::try_from(file.bytes.len()).unwrap_or(u64::MAX).into()),
    );
    evidence.insert(
        "contentBase64".to_owned(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(&file.bytes)),
    );
    if let Some(evidence_type) = as_string(metadata.get("evidenceType")) {
        if !evidence_type.is_empty() {
            evidence.insert(
                "evidenceType".to_owned(),
                Value::String(evidence_type.to_owned()),
            );
        }
    }
    if let Some(occurred_at) = as_string(metadata.get("occurredAt")) {
        if !occurred_at.is_empty() {
            evidence.insert(
                "occurredAt".to_owned(),
                Value::String(occurred_at.to_owned()),
            );
        }
    }
    let mut out = Map::new();
    out.insert("evidence".to_owned(), Value::Object(evidence));
    if let Some(notes) = as_string(metadata.get("notes")).filter(|value| !value.is_empty()) {
        out.insert("notes".to_owned(), Value::String(notes.to_owned()));
    }
    Value::Object(out)
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::validate_to_error;

    fn project(mapped: &Value, schema: Schema) -> Value {
        validate_to_error(&schema, mapped).expect("mapped payload must satisfy the core schema")
    }

    fn assert_no_unknown_keys(mapped: &Value, allowed: &[&str]) {
        for key in mapped.as_object().expect("object").keys() {
            assert!(allowed.contains(&key.as_str()), "unexpected key {key}");
        }
    }

    #[test]
    fn wallet_create_drops_portal_only_keys() {
        let mapped = to_core_wallet_create(&json!({
            "applicationId": "app_1",
            "label": "Main wallet",
            "currency": "LYD",
            "openingAmount": "10.0000"
        }));
        assert_eq!(mapped, json!({ "currency": "LYD", "label": "Main wallet" }));
        let validated = project(&mapped, core_wallet_create_schema());
        assert_eq!(validated, mapped);
    }

    #[test]
    fn application_create_maps_the_portal_vocabulary() {
        let mapped = to_core_application_create(&json!({
            "name": "Storefront",
            "description": "Online sales channel",
            "website": "https://shop.example",
            "category": "RETAIL",
            "settlementCurrency": "LYD",
            "contactEmail": "ops@example.com",
            "contactPhone": "0912345678",
            "assignedWalletId": "wal_1",
            "expectedMonthlyVolume": "1500.0000",
            "railWhitelist": ["CASH"],
            "redirectDomainAllowlist": ["https://shop.example"]
        }));
        assert_eq!(
            mapped,
            json!({
                "name": "Storefront",
                "businessUseDescription": "Online sales channel",
                "expectedMonthlyVolume": "1500.0000",
                "assignedWalletId": "wal_1",
                "railWhitelist": ["CASH"],
                "redirectDomainAllowlist": ["https://shop.example"]
            })
        );
        project(&mapped, core_application_create_schema());
    }

    #[test]
    fn application_create_omits_canonical_keys_the_portal_did_not_supply() {
        let mapped = to_core_application_create(&json!({
            "name": "Storefront",
            "description": "Online sales"
        }));
        assert_eq!(
            mapped,
            json!({ "name": "Storefront", "businessUseDescription": "Online sales" })
        );
        // The core schema requires assignedWalletId, so the edge refuses before calling core.
        assert_eq!(
            validate_to_error(&core_application_create_schema(), &mapped)
                .expect_err("missing wallet")
                .code,
            "VALIDATION_FAILED"
        );
    }

    #[test]
    fn application_patch_flattens_the_sensitive_portal_block() {
        let mapped = to_core_application_patch(&json!({
            "sensitive": {
                "assignedWalletId": "wal_1",
                "railWhitelist": ["CASH"],
                "redirectDomainAllowlist": ["https://shop.example"]
            },
            "reason": "settlement change"
        }));
        assert_eq!(
            mapped,
            json!({
                "assignedWalletId": "wal_1",
                "railWhitelist": ["CASH"],
                "redirectDomainAllowlist": ["https://shop.example"]
            })
        );
        project(&mapped, core_application_patch_schema());
    }

    #[test]
    fn user_create_normalises_the_authority_map_and_phone() {
        let mapped = to_core_user_create(&json!({
            "email": "ops@example.com",
            "phone": "912345678",
            "fullName": "Ops User",
            "password": "Sup3rSecretPass",
            "role": "MERCHANT_STAFF",
            "locale": "en",
            "authoritiesMap": { "merchant:read": true, "merchant:write": false }
        }));
        assert_eq!(
            mapped,
            json!({
                "email": "ops@example.com",
                "phone": "912345678",
                "password": "Sup3rSecretPass",
                "role": "MERCHANT_STAFF",
                "authoritiesMap": ["merchant:read"]
            })
        );
        project(&mapped, core_user_create_schema());
    }

    #[test]
    fn authority_list_passthrough_keeps_strings_only() {
        let mapped = to_core_user_create(&json!({
            "email": "ops@example.com",
            "password": "Sup3rSecretPass",
            "role": "MERCHANT_STAFF",
            "authoritiesMap": ["merchant:read", 7, "payment:read"]
        }));
        assert_eq!(
            mapped["authoritiesMap"],
            json!(["merchant:read", "payment:read"])
        );
    }

    #[test]
    fn user_patches_carry_or_drop_the_target_like_core() {
        let bulk = to_core_user_patch(&json!({
            "userIds": ["usr_1"],
            "id": "usr_1",
            "role": "MERCHANT_STAFF",
            "status": "ACTIVE",
            "reason": "rotation"
        }));
        assert_eq!(
            bulk,
            json!({ "id": "usr_1", "role": "MERCHANT_STAFF", "status": "ACTIVE" })
        );
        project(&bulk, core_user_patch_schema());

        let single = to_core_user_patch_by_id(&json!({
            "fullName": "Ops User",
            "role": "MERCHANT_CASHIER",
            "status": "SUSPENDED",
            "locale": "ar",
            "baseVersion": 2
        }));
        assert_eq!(
            single,
            json!({ "role": "MERCHANT_CASHIER", "status": "SUSPENDED" })
        );
        project(&single, core_user_patch_by_id_schema());
    }

    #[test]
    fn credential_set_create_maps_portal_secrets_to_entries() {
        let mapped = to_core_credential_set_create(&json!({
            "name": "Gateway credentials",
            "gatewayId": "gw_1",
            "environment": "sandbox",
            "ownership": "MERCHANT_DIRECT",
            "authMethod": "API_KEY",
            "secrets": { "apiKey": "secret-value" },
            "settings": { "timeout": 30 },
            "externalMerchantId": "merch-42"
        }));
        assert_eq!(
            mapped,
            json!({
                "gatewayCode": "gw_1",
                "env": "SANDBOX",
                "externalMerchantId": "merch-42",
                "settlementTarget": "MERCHANT_DIRECT",
                "entries": [{ "key": "apiKey", "type": "HEADER", "value": "secret-value", "isSecret": true }]
            })
        );
        assert_no_unknown_keys(
            &mapped,
            &[
                "gatewayCode",
                "env",
                "externalMerchantId",
                "settlementTarget",
                "entries",
            ],
        );
        project(&mapped, core_credential_set_create_schema());
    }

    #[test]
    fn credential_set_create_accepts_canonical_payload_one_to_one() {
        let mapped = to_core_credential_set_create(&json!({
            "name": "Gateway credentials",
            "gatewayCode": "FASTERPAY",
            "env": "LIVE",
            "externalMerchantId": "merch-42",
            "settlementTarget": "PLATFORM_CLEARING",
            "entries": [{ "key": "apiKey", "type": "HEADER", "value": "secret-value" }]
        }));
        assert_eq!(mapped["gatewayCode"], json!("FASTERPAY"));
        // `isSecret` defaults to true in the core schema, not in the mapper.
        let validated = project(&mapped, core_credential_set_create_schema());
        assert_eq!(validated["entries"][0]["isSecret"], json!(true));
    }

    #[test]
    fn credential_set_update_maps_secrets() {
        let mapped = to_core_credential_set_update(&json!({
            "name": "Gateway credentials",
            "secrets": { "apiKey": "secret-value" },
            "settings": { "timeout": 30 }
        }));
        assert_eq!(
            mapped,
            json!({
                "entries": [{ "key": "apiKey", "type": "HEADER", "value": "secret-value", "isSecret": true }]
            })
        );
        project(&mapped, core_credential_set_update_schema());
    }

    #[test]
    fn cashout_maps_the_bank_alias_and_keeps_the_canonical_record() {
        let mapped = to_core_cashout_create(&json!({
            "walletId": "wal_1",
            "amount": "250.0000",
            "currency": "LYD",
            "bankAccountId": "bank_1",
            "reference": "INV-1",
            "idempotencyKey": "idem-00000001"
        }));
        assert_eq!(
            mapped,
            json!({
                "walletId": "wal_1",
                "amount": "250.0000",
                "destinationBank": { "bankAccountId": "bank_1" },
                "idempotencyKey": "idem-00000001"
            })
        );
        project(&mapped, core_cashout_create_schema());

        let canonical = to_core_cashout_create(&json!({
            "walletId": "wal_1",
            "amount": "250.0000",
            "destinationBank": { "iban": "LY00", "swift": "LYBA" }
        }));
        assert_eq!(
            canonical["destinationBank"],
            json!({ "iban": "LY00", "swift": "LYBA" })
        );
    }

    #[test]
    fn pos_terminal_drops_portal_only_keys() {
        let mapped = to_core_pos_terminal_create(&json!({
            "name": "Till 1",
            "applicationId": "app_1",
            "location": "Tripoli",
            "deviceId": "device-9"
        }));
        assert_eq!(
            mapped,
            json!({ "name": "Till 1", "applicationId": "app_1", "location": "Tripoli" })
        );
        project(&mapped, core_pos_terminal_create_schema());
    }

    #[test]
    fn evidence_is_base64_encoded_inside_a_canonical_json_payload() {
        let bytes = b"%PDF-1.7\nreceipt\n%%EOF\n".to_vec();
        let file = EvidenceUpload {
            original_name: "receipt.pdf".to_owned(),
            bytes: bytes.clone(),
        };
        let mapped = to_core_dispute_evidence(
            &file,
            &json!({
                "evidenceType": "RECEIPT",
                "notes": "proof of delivery",
                "occurredAt": "2026-01-05"
            }),
            "application/pdf",
        );
        assert_eq!(mapped["notes"], json!("proof of delivery"));
        let evidence = &mapped["evidence"];
        assert_eq!(evidence["evidenceType"], json!("RECEIPT"));
        assert_eq!(evidence["occurredAt"], json!("2026-01-05"));
        assert_eq!(evidence["fileName"], json!("receipt.pdf"));
        assert_eq!(evidence["contentType"], json!("application/pdf"));
        assert_eq!(evidence["sizeBytes"], json!(bytes.len()));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(evidence["contentBase64"].as_str().expect("base64"))
            .expect("decode");
        assert_eq!(decoded, bytes);
        assert_eq!(evidence["sha256"].as_str().expect("sha").len(), 64);
        project(&mapped, core_dispute_evidence_schema());
    }

    #[test]
    fn evidence_limit_matches_the_typescript_constant() {
        assert_eq!(MAX_EVIDENCE_FILE_BYTES, 712_704);
        const { assert!(MAX_EVIDENCE_FILE_BYTES <= CORE_JSON_BODY_LIMIT_BYTES) };
    }

    #[test]
    fn credential_env_aliases() {
        for (input, expected) in [
            ("live", Some("LIVE")),
            ("PRODUCTION", Some("LIVE")),
            ("sandbox", Some("SANDBOX")),
            ("test", Some("SANDBOX")),
            ("uat", Some("SANDBOX")),
            ("staging", Some("SANDBOX")),
            ("dev", Some("SANDBOX")),
            ("development", Some("SANDBOX")),
            ("other", None),
        ] {
            assert_eq!(
                normalize_credential_env(Some(&json!(input))),
                expected,
                "{input}"
            );
        }
        assert_eq!(
            normalize_settlement_target(Some(&json!("PLATFORM_MANAGED"))),
            Some("PLATFORM_CLEARING")
        );
    }
}
