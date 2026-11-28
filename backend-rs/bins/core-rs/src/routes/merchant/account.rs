//! Merchant account reads: auth status, onboarding, cash-outs, API tokens, credential sets, users,
//! POS terminals and outbound webhooks.
//!
//! Port of `core-back/api/internal/merchant.ts:1165-1960` (auth/me + onboarding), `2910-3917`
//! (cash-outs, tokens, credential sets, users, POS) and `4182-4296` (webhooks). Write endpoints stay
//! 501 (P7); the SSE screen stream stays 501 (P5-T08).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::list_query::{
    build_list_query, count_unless_skipped, list_response, ColumnKind, ColumnMap, DateFilter,
    ListSpec, RangeFilter, RangeKind, SortDirection,
};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

use super::super::common::json_ok;
use super::super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use super::{
    application_scope, assert_application_in_scope, assert_merchant_authority, cursor_rows, f,
    path_uuid, query_map, query_scalar, require_merchant_session, row_json, rows_json, set_filter,
    set_in_filter, CursorColumn, FieldKind, Fields,
};
use crate::http::error_response;
use crate::routes::common::database_error;
use crate::state::AppState;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, ScopeRule};

const ORIGIN_AUTH_ME: &str = "core-back/api/internal/merchant.ts:1354";
const ORIGIN_JOIN_REQUEST: &str = "core-back/api/internal/merchant.ts:1512";
const ORIGIN_REVALIDATIONS: &str = "core-back/api/internal/merchant.ts:1590";
const ORIGIN_OWNERS: &str = "core-back/api/internal/merchant.ts:1855";
const ORIGIN_CASHOUTS: &str = "core-back/api/internal/merchant.ts:2910";
const ORIGIN_TOKENS: &str = "core-back/api/internal/merchant.ts:3116";
const ORIGIN_CREDENTIALS: &str = "core-back/api/internal/merchant.ts:3288";
const ORIGIN_CREDENTIAL: &str = "core-back/api/internal/merchant.ts:3442";
const ORIGIN_USERS: &str = "core-back/api/internal/merchant.ts:3512";
const ORIGIN_POS_TERMINALS: &str = "core-back/api/internal/merchant.ts:3712";
const ORIGIN_POS_TERMINAL: &str = "core-back/api/internal/merchant.ts:3759";
const ORIGIN_EVENT_TYPES: &str = "core-back/api/internal/merchant.ts:4218";
const ORIGIN_WEBHOOK_ENDPOINTS: &str = "core-back/api/internal/merchant.ts:4227";
const ORIGIN_WEBHOOK_DELIVERIES: &str = "core-back/api/internal/merchant.ts:4275";

/// `WEBHOOK_EVENT_TYPES` (`engine/webhooks/events.ts`).
pub const WEBHOOK_EVENT_TYPES: [&str; 9] = [
    "payment.succeeded",
    "payment.failed",
    "payment.expired",
    "payment.refunded",
    "dispute.opened",
    "dispute.closed",
    "cashout.paid",
    "cashout.failed",
    "link.expired",
];

/// `WEBHOOK_RETRY_DELAYS_MS` in seconds.
pub const WEBHOOK_RETRY_DELAYS_SECONDS: [i64; 7] = [5, 300, 1800, 7200, 18000, 36000, 36000];
/// `WEBHOOK_MAX_ATTEMPTS` (`delays.length + 1`).
pub const WEBHOOK_MAX_ATTEMPTS: i64 = 8;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let onboarding =
        super::policy_authorities(&["onboarding:write", "merchant:read", "merchant:write"]);
    let cashouts = super::policy_authorities(&["cashout:read", "cashout:request"]);
    let tokens = super::policy_authorities(&["token:manage"]);
    let credentials = super::policy_authorities(&["credential:manage"]);
    let users = super::policy_authorities(&["user:manage"]);
    let pos = super::policy_authorities(&["pos:manage", "merchant:read", "merchant:write"]);
    let webhook_read =
        super::policy_authorities(&["merchant:read", "merchant:write", "application:manage"]);
    vec![
        MountedRoute {
            // Registered before `requireAuthentication` in TS (`merchant.ts:1354`).
            policy: Policy::new(
                "GET",
                "/internal/merchant/auth/me",
                Channel::Merchant,
                Authn::None,
                ORIGIN_AUTH_ME,
            )
            .body(BodyRule::None),
            handler: Handler::Custom(auth_me),
            guard: PrincipalGuard::None,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/onboarding/join-request",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_JOIN_REQUEST,
            )
            .authorities(&onboarding.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(onboarding_join_request),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/onboarding/kyb-revalidations",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_REVALIDATIONS,
            )
            .authorities(&onboarding.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(onboarding_revalidations),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/onboarding/beneficial-owners",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_OWNERS,
            )
            .authorities(&onboarding.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(onboarding_owners),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/cashouts",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_CASHOUTS,
            )
            .authorities(&cashouts.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_cashouts),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/tokens",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_TOKENS,
            )
            .authorities(&tokens.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_tokens),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/credential-sets",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_CREDENTIALS,
            )
            .authorities(&credentials.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_credential_sets),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/credential-sets/:id",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_CREDENTIAL,
            )
            .authorities(&credentials.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_credential_set),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/users",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_USERS,
            )
            .authorities(&users.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_users),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/pos/terminals",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_POS_TERMINALS,
            )
            .authorities(&pos.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_pos_terminals),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/pos/terminals/:id",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_POS_TERMINAL,
            )
            .authorities(&pos.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_pos_terminal),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/webhooks/event-types",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_EVENT_TYPES,
            )
            .authorities(&webhook_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(webhook_event_types),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/webhooks/endpoints",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_WEBHOOK_ENDPOINTS,
            )
            .authorities(&webhook_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(webhook_endpoints),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/webhooks/deliveries",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_WEBHOOK_DELIVERIES,
            )
            .authorities(&webhook_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(webhook_deliveries),
            guard: PrincipalGuard::Merchant,
        },
    ]
}

// ---------------------------------------------------------------------------------------------
// auth/me
// ---------------------------------------------------------------------------------------------

fn env_bool(key: &str) -> Option<bool> {
    let raw = std::env::var(key).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_text(key: &str) -> String {
    std::env::var(key).unwrap_or_default().trim().to_owned()
}

fn json_text(value: &Value, keys: &[&str]) -> String {
    let Some(map) = value.as_object() else {
        return String::new();
    };
    for key in keys {
        if let Some(Value::String(text)) = map.get(*key) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_owned();
            }
        }
    }
    String::new()
}

fn json_bool(value: &Value) -> Option<bool> {
    match value.as_object()?.get("enabled")? {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn email_looks_valid(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty() && !domain.is_empty() && domain.contains('.')
}

fn latest_settings(settings: &[PgRow], key: &str) -> Option<Value> {
    let mut best: Option<(i32, Value)> = None;
    for row in settings {
        let row_key: String = row.get("key");
        if row_key != key {
            continue;
        }
        let version: i32 = row.get("version");
        let value: Value = row.try_get("value_json").unwrap_or(Value::Null);
        if best.as_ref().is_none_or(|(current, _)| version > *current) {
            best = Some((version, value));
        }
    }
    best.map(|(_, value)| value)
}

/// The public half of `communicationStatus`/`publicCommunicationStatus`
/// (`lib/communication/settings.ts:460-515`). Platform-setting secrets are not decrypted in P4, so a
/// password/webhook secret that only exists encrypted reads as missing until P8-T07.
async fn public_communication_status(state: &AppState) -> Result<Value, ApiError> {
    let settings = sqlx::query(
        "SELECT key, version, value_json FROM platform_settings \
          WHERE scope = 'PLATFORM' AND key IN ('communication.email', 'communication.sms', 'auth.google')",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;

    let email = latest_settings(&settings, "communication.email").unwrap_or(Value::Null);
    let sms = latest_settings(&settings, "communication.sms").unwrap_or(Value::Null);
    let google = latest_settings(&settings, "auth.google").unwrap_or(Value::Null);

    let email_disabled = email.get("enabled") == Some(&Value::Bool(false));
    let host = {
        let from_settings = json_text(&email, &["smtpHost", "host"]);
        if from_settings.is_empty() {
            env_text("SMTP_HOST")
        } else {
            from_settings
        }
    };
    let from_email = {
        let from_settings = json_text(&email, &["fromEmail", "from"]);
        if from_settings.is_empty() {
            env_text("SMTP_FROM_EMAIL")
        } else {
            from_settings
        }
    };
    let username = {
        let from_settings = json_text(&email, &["smtpUsername", "user", "username"]);
        if from_settings.is_empty() {
            env_text("SMTP_USER")
        } else {
            from_settings
        }
    };
    let password_from_env = env_text("SMTP_PASSWORD");
    let mut email_missing = Vec::new();
    if host.is_empty() {
        email_missing.push("smtpHost");
    }
    if !email_looks_valid(&from_email) {
        email_missing.push("fromEmail");
    }
    if !username.is_empty() && password_from_env.is_empty() {
        email_missing.push("smtpPassword");
    }
    let email_enabled = !email_disabled
        && json_bool(&email)
            .or_else(|| env_bool("COMMUNICATION_EMAIL_ENABLED"))
            .unwrap_or(false);
    let email_configured = !email_disabled && email_missing.is_empty() && email_enabled;

    let sms_disabled = sms.get("enabled") == Some(&Value::Bool(false));
    let webhook_url = {
        let from_settings = json_text(&sms, &["webhookUrl", "url"]);
        if from_settings.is_empty() {
            env_text("SMS_WEBHOOK_URL")
        } else {
            from_settings
        }
    };
    let webhook_secret = env_text("SMS_WEBHOOK_SECRET");
    let mut sms_missing = Vec::new();
    if webhook_url.is_empty() {
        sms_missing.push("webhookUrl");
    }
    if webhook_secret.is_empty() {
        sms_missing.push("webhookSecret");
    }
    let sms_enabled = !sms_disabled
        && json_bool(&sms)
            .or_else(|| env_bool("COMMUNICATION_SMS_ENABLED"))
            .unwrap_or(false);
    let sms_configured = !sms_disabled && sms_missing.is_empty() && sms_enabled;

    let google_disabled = google.get("enabled") == Some(&Value::Bool(false));
    let client_id = {
        let from_settings = json_text(&google, &["clientId"]);
        if from_settings.is_empty() {
            env_text("GOOGLE_CLIENT_ID")
        } else {
            from_settings
        }
    };
    let client_secret = env_text("GOOGLE_CLIENT_SECRET");
    let redirect_uri = {
        let from_settings = json_text(&google, &["redirectUri"]);
        if from_settings.is_empty() {
            env_text("GOOGLE_REDIRECT_URI")
        } else {
            from_settings
        }
    };
    let google_configured = !google_disabled
        && !client_id.is_empty()
        && !client_secret.is_empty()
        && !redirect_uri.is_empty()
        && json_bool(&google)
            .or_else(|| env_bool("GOOGLE_AUTH_ENABLED"))
            .unwrap_or(false);

    let maintenance = if email_configured {
        Value::Null
    } else {
        json!({
            "active": true,
            "code": "EMAIL_NOT_CONFIGURED",
            "message": "Merchant registration and sign-in are unavailable until email delivery is configured in Platform Settings.",
        })
    };
    Ok(json!({
        "emailConfigured": email_configured,
        "smsConfigured": sms_configured,
        "googleEnabled": google_configured,
        "registrationEnabled": email_configured,
        "passwordResetEnabled": email_configured,
        "maintenance": maintenance,
    }))
}

fn communication_fallback() -> Value {
    json!({
        "emailConfigured": false,
        "smsConfigured": false,
        "googleEnabled": false,
        "registrationEnabled": false,
        "passwordResetEnabled": false,
        "maintenance": {
            "active": true,
            "code": "EMAIL_NOT_CONFIGURED",
            "message": "Merchant registration and sign-in are unavailable until email delivery is configured.",
        },
    })
}

/// `GET /internal/merchant/auth/me` — the public merchant communications status.
pub fn auth_me<'a>(
    state: &'a AppState,
    _request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let communication = public_communication_status(state)
            .await
            .unwrap_or_else(|_| communication_fallback());
        let commit = std::env::var("GIT_COMMIT").unwrap_or_default();
        let version = if std::env::var("GIT_COMMIT").is_ok() {
            commit.chars().take(12).collect::<String>()
        } else {
            "dev".to_owned()
        };
        json_ok(&json!({
            "platformName": "Payment Gateway",
            "version": version,
            "suspended": false,
            "communication": communication,
        }))
    })
}

// ---------------------------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------------------------

const JOIN_REQUEST_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("status", "status", FieldKind::Text),
    f("onboarding_channel", "onboardingChannel", FieldKind::Text),
    f("submitted_at", "submittedAt", FieldKind::Timestamp),
    f("decision", "decision", FieldKind::Text),
    f(
        "decision_reason_code",
        "decisionReasonCode",
        FieldKind::Text,
    ),
    f("info_request_json", "infoRequestJson", FieldKind::Json),
    f("profile_json", "profileJson", FieldKind::Json),
    f("resubmission_of_id", "resubmissionOfId", FieldKind::Uuid),
];

const KYB_DOCUMENT_FIELDS: Fields = &[
    f("kd_id", "id", FieldKind::Uuid),
    f("kd_created_at", "createdAt", FieldKind::Timestamp),
    f("kd_subject_type", "subjectType", FieldKind::Text),
    f("kd_doc_type", "docType", FieldKind::Text),
    f("kd_original_file_name", "originalFileName", FieldKind::Text),
    f("kd_mime", "mime", FieldKind::Text),
    f("kd_size_bytes", "sizeBytes", FieldKind::Int),
    f("kd_status", "status", FieldKind::Text),
    f("kd_av_status", "avStatus", FieldKind::Text),
    f("kd_expires_on", "expiresOn", FieldKind::DateOnly),
    f(
        "kd_rejection_reason_code",
        "rejectionReasonCode",
        FieldKind::Text,
    ),
    f(
        "kd_status_changed_at",
        "statusChangedAt",
        FieldKind::Timestamp,
    ),
];

/// Screening reason codes are staff-only; the merchant view maps them to the neutral `POLICY`.
#[must_use]
pub fn merchant_visible_decision_reason_code(code: Option<&str>) -> Value {
    let Some(code) = code else {
        return Value::Null;
    };
    let upper = code.to_ascii_uppercase();
    let screening = [
        "AML", "SCREEN", "SANCTION", "WATCH", "PEP", "ADVERSE", "MATCH",
    ]
    .iter()
    .any(|needle| upper.contains(needle));
    Value::String(if screening {
        "POLICY".to_owned()
    } else {
        code.to_owned()
    })
}

/// `GET /internal/merchant/onboarding/join-request`.
pub fn onboarding_join_request<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["onboarding:write", "merchant:read", "merchant:write"],
            )?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let row = sqlx::query(
            "SELECT id, created_at, updated_at, status::text AS status, \
                    onboarding_channel::text AS onboarding_channel, submitted_at, decision, \
                    decision_reason_code, info_request_json, profile_json, resubmission_of_id \
               FROM join_requests WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let row = match row {
            Ok(row) => row,
            Err(error) => return error_response(request, database_error(error)),
        };
        let Some(row) = row else {
            return json_ok(&json!({ "joinRequest": Value::Null }));
        };
        let join_request_id: Uuid = row.get("id");
        let documents = sqlx::query(
            "SELECT id AS kd_id, created_at AS kd_created_at, subject_type::text AS kd_subject_type, \
                    doc_type::text AS kd_doc_type, original_file_name AS kd_original_file_name, \
                    mime AS kd_mime, size_bytes AS kd_size_bytes, status::text AS kd_status, \
                    av_status::text AS kd_av_status, expires_on AS kd_expires_on, \
                    rejection_reason_code AS kd_rejection_reason_code, \
                    status_changed_at AS kd_status_changed_at \
               FROM kyb_documents WHERE join_request_id = $1 ORDER BY created_at ASC",
        )
        .bind(join_request_id)
        .fetch_all(&state.pools.main)
        .await;
        let documents = match documents {
            Ok(rows) => match rows_json(&rows, KYB_DOCUMENT_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            },
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut view = match row_json(&row, JOIN_REQUEST_FIELDS) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        if let Value::Object(map) = &mut view {
            let code = row.get::<Option<String>, _>("decision_reason_code");
            map.insert(
                "decisionReasonCode".to_owned(),
                merchant_visible_decision_reason_code(code.as_deref()),
            );
            map.insert("kybDocuments".to_owned(), Value::Array(documents));
        }
        json_ok(&json!({ "joinRequest": view }))
    })
}

const REVALIDATION_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("doc_type", "docType", FieldKind::Text),
    f("reason_code", "reasonCode", FieldKind::Text),
    f("message", "message", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("requested_at", "requestedAt", FieldKind::Timestamp),
    f("due_at", "dueAt", FieldKind::Timestamp),
    f("fulfilled_at", "fulfilledAt", FieldKind::Timestamp),
];

const REVALIDATION_SOURCE_FIELDS: Fields = &[
    f("src_id", "id", FieldKind::Uuid),
    f("src_doc_type", "docType", FieldKind::Text),
    f(
        "src_original_file_name",
        "originalFileName",
        FieldKind::Text,
    ),
    f("src_status", "status", FieldKind::Text),
    f("src_expires_on", "expiresOn", FieldKind::DateOnly),
];

const REVALIDATION_FULFILLED_FIELDS: Fields = &[
    f("ful_id", "id", FieldKind::Uuid),
    f("ful_doc_type", "docType", FieldKind::Text),
    f("ful_status", "status", FieldKind::Text),
    f("ful_av_status", "avStatus", FieldKind::Text),
];

/// `GET /internal/merchant/onboarding/kyb-revalidations`.
pub fn onboarding_revalidations<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["onboarding:write", "merchant:read", "merchant:write"],
            )?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let rows = sqlx::query(
            "SELECT r.id, r.created_at, r.updated_at, r.doc_type::text AS doc_type, \
                    r.reason_code, r.message, r.status::text AS status, r.requested_at, \
                    r.due_at, r.fulfilled_at, \
                    s.id AS src_id, s.doc_type::text AS src_doc_type, \
                    s.original_file_name AS src_original_file_name, s.status::text AS src_status, \
                    s.expires_on AS src_expires_on, \
                    f.id AS ful_id, f.doc_type::text AS ful_doc_type, f.status::text AS ful_status, \
                    f.av_status::text AS ful_av_status \
               FROM kyb_revalidation_requests r \
               LEFT JOIN kyb_documents s ON s.id = r.document_id \
               LEFT JOIN kyb_documents f ON f.id = r.fulfilled_document_id \
              WHERE r.merchant_id = $1 \
              ORDER BY r.status ASC, r.requested_at DESC",
        )
        .bind(merchant_id)
        .fetch_all(&state.pools.main)
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut revalidations = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut item = match row_json(row, REVALIDATION_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            let source_id: Option<Uuid> = row.try_get("src_id").unwrap_or(None);
            let source = if source_id.is_some() {
                match row_json(row, REVALIDATION_SOURCE_FIELDS) {
                    Ok(value) => value,
                    Err(error) => return error_response(request, error),
                }
            } else {
                Value::Null
            };
            let fulfilled_id: Option<Uuid> = row.try_get("ful_id").unwrap_or(None);
            let fulfilled = if fulfilled_id.is_some() {
                match row_json(row, REVALIDATION_FULFILLED_FIELDS) {
                    Ok(value) => value,
                    Err(error) => return error_response(request, error),
                }
            } else {
                Value::Null
            };
            if let Value::Object(map) = &mut item {
                map.insert("sourceDocument".to_owned(), source);
                map.insert("fulfilledDocument".to_owned(), fulfilled);
            }
            revalidations.push(item);
        }
        json_ok(&json!({ "revalidations": revalidations }))
    })
}

const OWNER_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("full_name_ar", "fullNameAr", FieldKind::Text),
    f("full_name_en", "fullNameEn", FieldKind::Text),
    f("date_of_birth", "dateOfBirth", FieldKind::DateOnly),
    f("nationality", "nationality", FieldKind::Text),
    f("ownership_percent", "ownershipPercent", FieldKind::Decimal),
    f("role", "role", FieldKind::Text),
    f("pep_declared", "pepDeclared", FieldKind::Bool),
    f("active", "active", FieldKind::Bool),
    f("valid_from", "validFrom", FieldKind::Timestamp),
    f("valid_to", "validTo", FieldKind::Timestamp),
];

/// `GET /internal/merchant/onboarding/beneficial-owners`.
pub fn onboarding_owners<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["onboarding:write", "merchant:read", "merchant:write"],
            )?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let rows = sqlx::query(
            "SELECT id, created_at, full_name_ar, full_name_en, date_of_birth, nationality, \
                    ownership_percent, role::text AS role, pep_declared, active, valid_from, valid_to \
               FROM beneficial_owners WHERE merchant_id = $1 ORDER BY created_at ASC",
        )
        .bind(merchant_id)
        .fetch_all(&state.pools.main)
        .await;
        match rows {
            Ok(rows) => {
                let mut owners = Vec::with_capacity(rows.len());
                for row in &rows {
                    let mut owner = match row_json(row, OWNER_FIELDS) {
                        Ok(value) => value,
                        Err(error) => return error_response(request, error),
                    };
                    let full_name_ar: Option<String> = row.try_get("full_name_ar").unwrap_or(None);
                    if let Value::Object(map) = &mut owner {
                        map.insert(
                            "fullName".to_owned(),
                            full_name_ar.map_or(Value::Null, Value::String),
                        );
                    }
                    owners.push(owner);
                }
                json_ok(&json!({ "owners": owners }))
            }
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Cash-outs
// ---------------------------------------------------------------------------------------------

const CASHOUT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("wallet_id", "walletId", FieldKind::Uuid),
    f("amount", "amount", FieldKind::Decimal),
    f("state", "state", FieldKind::Text),
    f("adjustment_id", "adjustmentId", FieldKind::Uuid),
];

/// `GET /internal/merchant/cashouts`.
pub fn list_cashouts<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["cashout:read", "cashout:request"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        let columns = ColumnMap::new()
            .with("id", "c.id", ColumnKind::Uuid)
            .with("walletId", "c.wallet_id::text", ColumnKind::Text)
            .with("state", "c.state::text", ColumnKind::Text)
            .with("amount", "c.amount", ColumnKind::Decimal)
            .with("createdAt", "c.created_at", ColumnKind::Timestamp)
            .with("merchant", "c.merchant_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["walletId"])
            .with_in("state", "state")
            .with_equals("walletId", "walletId")
            .with_equals("__merchant", "merchant")
            .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("state", "state")
            .with_sortable("amount", "amount")
            .with_sortable("requestedAt", "createdAt")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT c.id, c.created_at, c.updated_at, c.wallet_id, c.amount, \
                    c.state::text AS state, c.adjustment_id \
               FROM cashout_requests c {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total =
            match count_unless_skipped(&built, "cashout_requests c", &state.pools.main).await {
                Ok(total) => total,
                Err(error) => return error_response(request, crate::auth::db_error(error)),
            };
        let mut cashouts = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut cashout = match row_json(row, CASHOUT_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            let requested_at = cashout.get("createdAt").cloned().unwrap_or(Value::Null);
            if let Value::Object(map) = &mut cashout {
                map.insert("requestedAt".to_owned(), requested_at);
            }
            cashouts.push(cashout);
        }
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "cashouts",
            Value::Array(cashouts),
            total,
            &built,
            &cursors,
        ))
    })
}

// ---------------------------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/tokens`.
pub fn list_tokens<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["token:manage"])?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        let revoked = query_scalar(request, "revoked").filter(|value| !value.is_empty());
        if let Some(revoked) = revoked.as_deref() {
            match revoked {
                "true" => set_filter(&mut map, "revoked", "true"),
                "false" => set_filter(&mut map, "revoked", "false"),
                _ => {}
            }
        }
        if let Some(scope) = application_scope(principal) {
            set_in_filter(&mut map, "applications", &scope);
        }
        let columns = ColumnMap::new()
            .with("id", "t.id", ColumnKind::Uuid)
            .with("name", "t.name", ColumnKind::Text)
            .with("lastFour", "t.last_four", ColumnKind::Text)
            .with(
                "ipWhitelistEnabled",
                "t.ip_whitelist_enabled",
                ColumnKind::Bool,
            )
            .with("createdAt", "t.created_at", ColumnKind::Timestamp)
            .with("lastUsedAt", "t.last_used_at", ColumnKind::Timestamp)
            .with("merchant", "t.merchant_id::text", ColumnKind::Text)
            .with("applications", "t.application_id::text", ColumnKind::Text)
            .with("revoked", "(t.revoked_at IS NOT NULL)", ColumnKind::Bool);
        let spec = ListSpec::default()
            .with_search(&["name", "lastFour"])
            .with_boolean("ipWhitelistEnabled", "ipWhitelistEnabled")
            .with_equals("__merchant", "merchant")
            .with_boolean("__revoked", "revoked")
            .with_in("__applications", "applications")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_date(DateFilter::new("lastUsedAt", "lastUsedAt").with_keys("dateFrom", "dateTo"))
            .with_sortable("name", "name")
            .with_sortable("lastUsedAt", "lastUsedAt")
            .with_sortable("createdAt", "createdAt")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT t.id, t.name, t.last_four, t.scopes, t.expires_at, t.ip_whitelist_enabled, \
                    t.revoked_at, t.last_used_at, t.created_at \
               FROM access_tokens t {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(&built, "access_tokens t", &state.pools.main).await {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let ids: Vec<Uuid> = rows.iter().map(|row| row.get("id")).collect();
        let ips = if ids.is_empty() {
            Vec::new()
        } else {
            match sqlx::query(
                "SELECT token_id, cidr FROM access_token_ips WHERE token_id = ANY($1::uuid[]) \
                  ORDER BY created_at ASC, id ASC",
            )
            .bind(&ids)
            .fetch_all(&state.pools.main)
            .await
            {
                Ok(rows) => rows,
                Err(error) => return error_response(request, database_error(error)),
            }
        };
        let mut cidrs: BTreeMap<Uuid, Vec<String>> = BTreeMap::new();
        for row in &ips {
            let token_id: Uuid = row.get("token_id");
            let cidr: String = row.get("cidr");
            cidrs.entry(token_id).or_default().push(cidr);
        }
        let mut tokens = Vec::with_capacity(rows.len());
        for row in &rows {
            let id: Uuid = row.get("id");
            let scopes: Value = row
                .try_get("scopes")
                .map(|value: Value| pg_types::js_object_order(&value))
                .unwrap_or(Value::Null);
            let allowed = cidrs
                .remove(&id)
                .unwrap_or_default()
                .into_iter()
                .map(Value::String)
                .collect();
            let mut map = Map::new();
            map.insert("id".to_owned(), Value::String(id.to_string()));
            map.insert("name".to_owned(), Value::String(row.get("name")));
            map.insert("lastFour".to_owned(), Value::String(row.get("last_four")));
            map.insert("scopes".to_owned(), scopes);
            map.insert(
                "expiresAt".to_owned(),
                super::iso_timestamp(row.try_get("expires_at").unwrap_or(None)),
            );
            map.insert(
                "ipWhitelistEnabled".to_owned(),
                Value::Bool(row.get("ip_whitelist_enabled")),
            );
            map.insert(
                "revokedAt".to_owned(),
                super::iso_timestamp(row.try_get("revoked_at").unwrap_or(None)),
            );
            map.insert(
                "lastUsedAt".to_owned(),
                super::iso_timestamp(row.try_get("last_used_at").unwrap_or(None)),
            );
            map.insert("allowedCidrs".to_owned(), Value::Array(allowed));
            tokens.push(Value::Object(map));
        }
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "tokens",
            Value::Array(tokens),
            total,
            &built,
            &cursors,
        ))
    })
}

// ---------------------------------------------------------------------------------------------
// Credential sets
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/credential-sets`.
pub fn list_credential_sets<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["credential:manage"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "owner", merchant_id.to_string());
        let columns = ColumnMap::new()
            .with("id", "c.id", ColumnKind::Uuid)
            .with(
                "externalMerchantId",
                "c.external_merchant_id",
                ColumnKind::Text,
            )
            .with("gateway.code", "g.code", ColumnKind::Text)
            .with("gatewayId", "c.gateway_id", ColumnKind::Uuid)
            .with("status", "c.status::text", ColumnKind::Text)
            .with("env", "c.env::text", ColumnKind::Text)
            .with(
                "settlementTarget",
                "c.settlement_target::text",
                ColumnKind::Text,
            )
            .with("createdAt", "c.created_at", ColumnKind::Timestamp)
            .with("owner", "c.owner_merchant_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["externalMerchantId", "gateway.code"])
            .with_in("status", "status")
            .with_equals("gatewayCode", "gateway.code")
            .with_equals("env", "env")
            .with_equals("settlementTarget", "settlementTarget")
            .with_equals("__owner", "owner")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("gatewayCode", "gatewayId")
            .with_sortable("env", "env")
            .with_sortable("status", "status")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT c.id, g.code AS gateway_code, c.env::text AS env, \
                    c.owner_type::text AS owner_type, c.settlement_target::text AS settlement_target, \
                    c.status::text AS status, c.last_verified_at, c.expires_at, c.created_at \
               FROM credential_sets c JOIN gateways g ON g.id = c.gateway_id \
              {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(
            &built,
            "credential_sets c JOIN gateways g ON g.id = c.gateway_id",
            &state.pools.main,
        )
        .await
        {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let mut credential_sets = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut item = Map::new();
            item.insert(
                "id".to_owned(),
                Value::String(row.get::<Uuid, _>("id").to_string()),
            );
            item.insert(
                "gatewayCode".to_owned(),
                Value::String(row.get("gateway_code")),
            );
            item.insert("env".to_owned(), Value::String(row.get("env")));
            item.insert(
                "ownerType".to_owned(),
                Value::String(row.get::<String, _>("owner_type")),
            );
            item.insert(
                "settlementTarget".to_owned(),
                Value::String(row.get("settlement_target")),
            );
            item.insert("status".to_owned(), Value::String(row.get("status")));
            item.insert(
                "lastVerifiedAt".to_owned(),
                super::iso_timestamp(row.try_get("last_verified_at").unwrap_or(None)),
            );
            item.insert(
                "expiresAt".to_owned(),
                super::iso_timestamp(row.try_get("expires_at").unwrap_or(None)),
            );
            credential_sets.push(Value::Object(item));
        }
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "credentialSets",
            Value::Array(credential_sets),
            total,
            &built,
            &cursors,
        ))
    })
}

fn credential_not_found() -> ApiError {
    ApiError::new(
        404,
        "CREDENTIAL_SET_NOT_FOUND",
        "The credential set does not exist",
    )
}

/// `GET /internal/merchant/credential-sets/:id`.
pub fn get_credential_set<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["credential:manage"])?;
            let id = path_uuid(
                request,
                4,
                "CREDENTIAL_SET_NOT_FOUND",
                "The credential set does not exist",
            )?;
            Ok((merchant_id, id))
        })();
        let (merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let row = sqlx::query(
            "SELECT c.id, g.code AS gateway_code, c.env::text AS env, c.status::text AS status, \
                    c.settlement_target::text AS settlement_target, c.last_verified_at, \
                    c.entries_ciphertext \
               FROM credential_sets c JOIN gateways g ON g.id = c.gateway_id \
              WHERE c.id = $1 AND c.owner_type = 'MERCHANT' AND c.owner_merchant_id = $2",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        match row {
            Ok(Some(row)) => {
                let entries_raw: Value = row.try_get("entries_ciphertext").unwrap_or(Value::Null);
                let entries: Vec<Value> = entries_raw
                    .as_array()
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|entry| {
                                let is_secret = entry
                                    .get("isSecret")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false);
                                let mut map = Map::new();
                                map.insert(
                                    "key".to_owned(),
                                    entry.get("key").cloned().unwrap_or(Value::Null),
                                );
                                map.insert(
                                    "type".to_owned(),
                                    entry.get("type").cloned().unwrap_or(Value::Null),
                                );
                                map.insert("isSecret".to_owned(), Value::Bool(is_secret));
                                map.insert(
                                    "value".to_owned(),
                                    Value::String(
                                        if is_secret {
                                            "[REDACTED]"
                                        } else {
                                            "[WRITE_ONLY]"
                                        }
                                        .to_owned(),
                                    ),
                                );
                                Value::Object(map)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                json_ok(&json!({
                    "id": row.get::<Uuid, _>("id"),
                    "gatewayCode": row.get::<String, _>("gateway_code"),
                    "env": row.get::<String, _>("env"),
                    "status": row.get::<String, _>("status"),
                    "settlementTarget": row.get::<String, _>("settlement_target"),
                    "lastVerifiedAt": super::iso_timestamp(row.try_get("last_verified_at").unwrap_or(None)),
                    "entries": entries,
                }))
            }
            Ok(None) => error_response(request, credential_not_found()),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/users`.
pub fn list_users<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["user:manage"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        let columns = ColumnMap::new()
            .with("id", "u.id", ColumnKind::Uuid)
            .with("email", "u.email", ColumnKind::Text)
            .with("phone", "u.phone", ColumnKind::Text)
            .with("role", "u.role::text", ColumnKind::Text)
            .with("status", "u.status::text", ColumnKind::Text)
            .with("createdAt", "u.created_at", ColumnKind::Timestamp)
            .with("merchant", "u.merchant_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["email", "phone"])
            .with_in("status", "status")
            .with_equals("role", "role")
            .with_equals("__merchant", "merchant")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("email", "email")
            .with_sortable("role", "role")
            .with_sortable("status", "status")
            .with_sortable("createdAt", "createdAt")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT u.id, u.email, u.phone, u.role::text AS role, u.authorities_map, \
                    u.status::text AS status, u.mfa_required, u.created_at \
               FROM users u {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(&built, "users u", &state.pools.main).await {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let mut users = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut item = Map::new();
            item.insert(
                "id".to_owned(),
                Value::String(row.get::<Uuid, _>("id").to_string()),
            );
            item.insert(
                "email".to_owned(),
                row.try_get::<Option<String>, _>("email")
                    .unwrap_or(None)
                    .map_or(Value::Null, Value::String),
            );
            item.insert(
                "phone".to_owned(),
                row.try_get::<Option<String>, _>("phone")
                    .unwrap_or(None)
                    .map_or(Value::Null, Value::String),
            );
            item.insert("role".to_owned(), Value::String(row.get("role")));
            item.insert(
                "authoritiesMap".to_owned(),
                row.try_get::<Value, _>("authorities_map")
                    .map(|value| pg_types::js_object_order(&value))
                    .unwrap_or(Value::Null),
            );
            item.insert("status".to_owned(), Value::String(row.get("status")));
            item.insert(
                "mfaRequired".to_owned(),
                Value::Bool(row.get("mfa_required")),
            );
            users.push(Value::Object(item));
        }
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "users",
            Value::Array(users),
            total,
            &built,
            &cursors,
        ))
    })
}

// ---------------------------------------------------------------------------------------------
// POS terminals
// ---------------------------------------------------------------------------------------------

const POS_SCREEN_FIELDS: Fields = &[
    f("s_id", "id", FieldKind::Uuid),
    f("s_created_at", "createdAt", FieldKind::Timestamp),
    f("s_screen_code", "screenCode", FieldKind::Text),
    f("s_realtime_room_id", "realtimeRoomId", FieldKind::Text),
    f("s_last_active_at", "lastActiveAt", FieldKind::Timestamp),
];

const POS_TERMINAL_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("application_id", "applicationId", FieldKind::Uuid),
    f("name", "name", FieldKind::Text),
    f("location", "location", FieldKind::Text),
    f("status", "status", FieldKind::Text),
];

async fn screens_by_terminal(
    state: &AppState,
    terminal_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, Vec<Value>>, ApiError> {
    if terminal_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let rows = sqlx::query(
        "SELECT pos_id, id AS s_id, created_at AS s_created_at, screen_code AS s_screen_code, \
                realtime_room_id AS s_realtime_room_id, last_active_at AS s_last_active_at \
           FROM pos_screens WHERE pos_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC",
    )
    .bind(terminal_ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let mut map: BTreeMap<Uuid, Vec<Value>> = BTreeMap::new();
    for row in &rows {
        let pos_id: Uuid = row.get("pos_id");
        let screen = row_json(row, POS_SCREEN_FIELDS)?;
        map.entry(pos_id).or_default().push(screen);
    }
    Ok(map)
}

/// `GET /internal/merchant/pos/terminals`.
pub fn list_pos_terminals<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["pos:manage", "merchant:read", "merchant:write"],
            )?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        if let Some(scope) = application_scope(principal) {
            set_in_filter(&mut map, "applications", &scope);
        }
        let columns = ColumnMap::new()
            .with("id", "p.id", ColumnKind::Uuid)
            .with("name", "p.name", ColumnKind::Text)
            .with("location", "p.location", ColumnKind::Text)
            .with("status", "p.status::text", ColumnKind::Text)
            .with("createdAt", "p.created_at", ColumnKind::Timestamp)
            .with("merchant", "a.merchant_id::text", ColumnKind::Text)
            .with("applications", "p.application_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["name", "location"])
            .with_in("status", "status")
            .with_equals("__merchant", "merchant")
            .with_in("__applications", "applications")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("name", "name")
            .with_sortable("location", "location")
            .with_sortable("status", "status")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT p.id, p.created_at, p.updated_at, p.application_id, p.name, p.location, \
                    p.status::text AS status \
               FROM pos_terminals p JOIN applications a ON a.id = p.application_id \
              {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(
            &built,
            "pos_terminals p JOIN applications a ON a.id = p.application_id",
            &state.pools.main,
        )
        .await
        {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let ids: Vec<Uuid> = rows.iter().map(|row| row.get("id")).collect();
        let mut screens = match screens_by_terminal(state, &ids).await {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut terminals = Vec::with_capacity(rows.len());
        for row in &rows {
            let id: Uuid = row.get("id");
            let mut terminal = match row_json(row, POS_TERMINAL_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            if let Value::Object(map) = &mut terminal {
                map.insert(
                    "screens".to_owned(),
                    Value::Array(screens.remove(&id).unwrap_or_default()),
                );
            }
            terminals.push(terminal);
        }
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "terminals",
            Value::Array(terminals),
            total,
            &built,
            &cursors,
        ))
    })
}

fn pos_not_found() -> ApiError {
    ApiError::new(
        404,
        "POS_TERMINAL_NOT_FOUND",
        "The POS terminal does not exist",
    )
}

/// `GET /internal/merchant/pos/terminals/:id`.
pub fn get_pos_terminal<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["pos:manage", "merchant:read", "merchant:write"],
            )?;
            let id = path_uuid(
                request,
                4,
                "POS_TERMINAL_NOT_FOUND",
                "The POS terminal does not exist",
            )?;
            Ok((principal, merchant_id, id))
        })();
        let (principal, merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let row = sqlx::query(
            "SELECT p.id, p.created_at, p.updated_at, p.application_id, p.name, p.location, \
                    p.status::text AS status \
               FROM pos_terminals p JOIN applications a ON a.id = p.application_id \
              WHERE p.id = $1 AND a.merchant_id = $2",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        match row {
            Ok(Some(row)) => {
                let application_id: Uuid = row.get("application_id");
                if let Err(error) = assert_application_in_scope(
                    application_scope(principal).as_deref(),
                    Some(application_id),
                ) {
                    return error_response(request, error);
                }
                let screens = match screens_by_terminal(state, &[id]).await {
                    Ok(mut value) => value.remove(&id).unwrap_or_default(),
                    Err(error) => return error_response(request, error),
                };
                let mut terminal = match row_json(&row, POS_TERMINAL_FIELDS) {
                    Ok(value) => value,
                    Err(error) => return error_response(request, error),
                };
                if let Value::Object(map) = &mut terminal {
                    map.insert("screens".to_owned(), Value::Array(screens));
                }
                json_ok(&json!({ "terminal": terminal }))
            }
            Ok(None) => error_response(request, pos_not_found()),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Outbound webhooks (AUTO-34 reads)
// ---------------------------------------------------------------------------------------------

fn iso_naive(value: Option<NaiveDateTime>) -> Value {
    super::iso_timestamp(value)
}

struct EndpointRow {
    id: Uuid,
    application_id: Uuid,
    view: Value,
}

async fn list_endpoints(
    state: &AppState,
    merchant_id: Uuid,
    application_id: Option<Uuid>,
) -> Result<Vec<EndpointRow>, ApiError> {
    let mut sql = String::from(
        "SELECT id, application_id, url, description, event_types, status, disabled_reason, \
                disabled_at, previous_secret_ciphertext, previous_secret_expires_at, \
                secret_rotated_at, failing_since, last_success_at, last_failure_at, created_at \
           FROM merchant_webhook_endpoints WHERE merchant_id = $1",
    );
    if application_id.is_some() {
        sql.push_str(" AND application_id = $2");
    }
    sql.push_str(" ORDER BY created_at ASC");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(merchant_id);
    if let Some(application_id) = application_id {
        query = query.bind(application_id);
    }
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let now = Utc::now();
    let mut endpoints = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.get("id");
        let application_id: Uuid = row.get("application_id");
        let previous_ciphertext: Option<String> =
            row.try_get("previous_secret_ciphertext").unwrap_or(None);
        let previous_expires: Option<NaiveDateTime> =
            row.try_get("previous_secret_expires_at").unwrap_or(None);
        let rotation_overlap_active = previous_ciphertext.is_some()
            && previous_expires.is_some_and(|expires| expires.and_utc() > now);
        let event_types: Value = row.try_get("event_types").unwrap_or(Value::Null);
        let mut view = Map::new();
        view.insert("id".to_owned(), Value::String(id.to_string()));
        view.insert(
            "applicationId".to_owned(),
            Value::String(application_id.to_string()),
        );
        view.insert("url".to_owned(), Value::String(row.get("url")));
        view.insert(
            "description".to_owned(),
            row.try_get::<Option<String>, _>("description")
                .unwrap_or(None)
                .map_or(Value::Null, Value::String),
        );
        view.insert("eventTypes".to_owned(), event_types);
        view.insert("status".to_owned(), Value::String(row.get("status")));
        view.insert(
            "disabledReason".to_owned(),
            row.try_get::<Option<String>, _>("disabled_reason")
                .unwrap_or(None)
                .map_or(Value::Null, Value::String),
        );
        view.insert(
            "disabledAt".to_owned(),
            iso_naive(row.try_get("disabled_at").unwrap_or(None)),
        );
        view.insert(
            "secretRotatedAt".to_owned(),
            iso_naive(row.try_get("secret_rotated_at").unwrap_or(None)),
        );
        view.insert(
            "rotationOverlapActive".to_owned(),
            Value::Bool(rotation_overlap_active),
        );
        view.insert(
            "lastSuccessAt".to_owned(),
            iso_naive(row.try_get("last_success_at").unwrap_or(None)),
        );
        view.insert(
            "lastFailureAt".to_owned(),
            iso_naive(row.try_get("last_failure_at").unwrap_or(None)),
        );
        view.insert(
            "failingSince".to_owned(),
            iso_naive(row.try_get("failing_since").unwrap_or(None)),
        );
        view.insert(
            "createdAt".to_owned(),
            iso_naive(row.try_get("created_at").unwrap_or(None)),
        );
        endpoints.push(EndpointRow {
            id,
            application_id,
            view: Value::Object(view),
        });
    }
    Ok(endpoints)
}

fn webhook_endpoint_not_found() -> ApiError {
    ApiError::new(
        404,
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "The webhook endpoint does not exist",
    )
}

/// `GET /internal/merchant/webhooks/event-types`.
pub fn webhook_event_types<'a>(
    _state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, _) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["merchant:read", "merchant:write", "application:manage"],
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            return error_response(request, error);
        }
        let disable_after_days = std::env::var("MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS")
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(5);
        json_ok(&json!({
            "eventTypes": WEBHOOK_EVENT_TYPES,
            "signature": {
                "scheme": "standard-webhooks",
                "headers": ["webhook-id", "webhook-timestamp", "webhook-signature"],
                "algorithm": "HMAC-SHA256 (base64) over `id.timestamp.body`",
            },
            "retry": {
                "maxAttempts": WEBHOOK_MAX_ATTEMPTS,
                "delaysSeconds": WEBHOOK_RETRY_DELAYS_SECONDS,
                "disableAfterDays": disable_after_days,
            },
        }))
    })
}

/// `GET /internal/merchant/webhooks/endpoints`.
pub fn webhook_endpoints<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["merchant:read", "merchant:write", "application:manage"],
            )?;
            let application_id = match query_scalar(request, "applicationId")
                .filter(|value| !value.is_empty())
            {
                None => None,
                Some(raw) => Some(Uuid::parse_str(&raw).map_err(|_| {
                    ApiError::new(400, "VALIDATION_FAILED", "Validation failed").with_details(json!({
                        "issues": [{ "path": ["applicationId"], "code": "invalid_string", "message": "Invalid uuid" }]
                    }))
                })?),
            };
            if let Some(application_id) = application_id {
                assert_application_in_scope(
                    application_scope(principal).as_deref(),
                    Some(application_id),
                )?;
            }
            Ok((principal, merchant_id, application_id))
        })();
        let (principal, merchant_id, application_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let scope = application_scope(principal);
        let endpoints = match list_endpoints(state, merchant_id, application_id).await {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let views: Vec<Value> = endpoints
            .into_iter()
            .filter(|endpoint| {
                scope
                    .as_deref()
                    .is_none_or(|scope| scope.contains(&endpoint.application_id))
            })
            .map(|endpoint| endpoint.view)
            .collect();
        json_ok(&json!({ "endpoints": views }))
    })
}

/// `GET /internal/merchant/webhooks/deliveries`.
pub fn webhook_deliveries<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &["merchant:read", "merchant:write", "application:manage"],
            )?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let endpoint_id = match query_scalar(request, "endpointId").filter(|value| !value.is_empty())
        {
            None => None,
            Some(raw) => match Uuid::parse_str(&raw) {
                Ok(id) => Some(id),
                Err(_) => {
                    return error_response(
                        request,
                        ApiError::new(400, "VALIDATION_FAILED", "Validation failed").with_details(json!({
                            "issues": [{ "path": ["endpointId"], "code": "invalid_string", "message": "Invalid uuid" }]
                        })),
                    )
                }
            },
        };
        let status = query_scalar(request, "status").filter(|value| !value.is_empty());
        if let Some(status) = status.as_deref() {
            if !matches!(status, "PENDING" | "DELIVERED" | "PARKED") {
                return error_response(
                    request,
                    ApiError::new(400, "VALIDATION_FAILED", "Validation failed").with_details(json!({
                        "issues": [{ "path": ["status"], "code": "invalid_enum_value", "message": "Invalid enum value" }]
                    })),
                );
            }
        }
        let limit = match query_scalar(request, "limit").filter(|value| !value.is_empty()) {
            None => 50,
            Some(raw) => match raw.trim().parse::<i64>() {
                Ok(value) => value.clamp(1, 200),
                Err(_) => {
                    return error_response(
                        request,
                        ApiError::new(400, "VALIDATION_FAILED", "Validation failed").with_details(json!({
                            "issues": [{ "path": ["limit"], "code": "invalid_type", "message": "Expected number, received string" }]
                        })),
                    )
                }
            },
        };
        let before = match query_scalar(request, "before").filter(|value| !value.is_empty()) {
            None => None,
            Some(raw) => match DateTime::parse_from_rfc3339(&raw) {
                Ok(value) => Some(value.with_timezone(&Utc).naive_utc()),
                Err(_) => {
                    return error_response(
                        request,
                        ApiError::new(400, "VALIDATION_FAILED", "Validation failed").with_details(json!({
                            "issues": [{ "path": ["before"], "code": "invalid_string", "message": "Invalid datetime" }]
                        })),
                    )
                }
            },
        };

        let scope = application_scope(principal);
        if let Some(endpoint_id) = endpoint_id {
            let endpoints = match list_endpoints(state, merchant_id, None).await {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            let Some(found) = endpoints.iter().find(|endpoint| endpoint.id == endpoint_id) else {
                return error_response(request, webhook_endpoint_not_found());
            };
            if let Err(error) =
                assert_application_in_scope(scope.as_deref(), Some(found.application_id))
            {
                return error_response(request, error);
            }
        }

        let mut sql = String::from(
            "SELECT d.id, d.endpoint_id, d.event_id, d.event_type, d.status, d.attempts, \
                    d.next_attempt_at, d.last_attempt_at, d.last_status_code, d.last_latency_ms, \
                    d.last_error, d.delivered_at, d.parked_at, d.park_reason, d.created_at \
               FROM merchant_webhook_deliveries d WHERE d.merchant_id = $1",
        );
        let mut next = 2;
        if endpoint_id.is_some() {
            sql.push_str(&format!(" AND d.endpoint_id = ${next}::uuid"));
            next += 1;
        }
        if status.is_some() {
            sql.push_str(&format!(" AND d.status = ${next}"));
            next += 1;
        }
        if before.is_some() {
            sql.push_str(&format!(" AND d.created_at < ${next}"));
            next += 1;
        }
        sql.push_str(&format!(
            " ORDER BY d.created_at DESC, d.id DESC LIMIT ${next}"
        ));
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(merchant_id);
        if let Some(endpoint_id) = endpoint_id {
            query = query.bind(endpoint_id);
        }
        if let Some(status) = status.as_deref() {
            query = query.bind(status.to_owned());
        }
        if let Some(before) = before {
            query = query.bind(before);
        }
        let rows = match query.bind(limit).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let allowed_endpoints = if let Some(scope) = scope.as_deref() {
            match list_endpoints(state, merchant_id, None).await {
                Ok(endpoints) => Some(
                    endpoints
                        .into_iter()
                        .filter(|endpoint| scope.contains(&endpoint.application_id))
                        .map(|endpoint| endpoint.id)
                        .collect::<std::collections::BTreeSet<_>>(),
                ),
                Err(error) => return error_response(request, error),
            }
        } else {
            None
        };
        let mut deliveries = Vec::with_capacity(rows.len());
        for row in &rows {
            let endpoint: Uuid = row.get("endpoint_id");
            if let Some(allowed) = &allowed_endpoints {
                if !allowed.contains(&endpoint) {
                    continue;
                }
            }
            deliveries.push(json!({
                "id": row.get::<Uuid, _>("id"),
                "endpointId": endpoint,
                "eventId": row.get::<String, _>("event_id"),
                "eventType": row.get::<String, _>("event_type"),
                "status": row.get::<String, _>("status"),
                "attempts": row.get::<i32, _>("attempts"),
                "nextAttemptAt": iso_naive(row.try_get("next_attempt_at").unwrap_or(None)),
                "lastAttemptAt": iso_naive(row.try_get("last_attempt_at").unwrap_or(None)),
                "lastStatusCode": row.try_get::<Option<i32>, _>("last_status_code").unwrap_or(None),
                "lastLatencyMs": row.try_get::<Option<i32>, _>("last_latency_ms").unwrap_or(None),
                "lastError": row.try_get::<Option<String>, _>("last_error").unwrap_or(None),
                "deliveredAt": iso_naive(row.try_get("delivered_at").unwrap_or(None)),
                "parkedAt": iso_naive(row.try_get("parked_at").unwrap_or(None)),
                "parkReason": row.try_get::<Option<String>, _>("park_reason").unwrap_or(None),
                "createdAt": iso_naive(row.try_get("created_at").unwrap_or(None)),
            }));
        }
        json_ok(&json!({ "deliveries": deliveries }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screening_reason_codes_are_neutralised() {
        assert_eq!(
            merchant_visible_decision_reason_code(Some("AML_CONFIRMED_MATCH")),
            Value::String("POLICY".to_owned())
        );
        assert_eq!(
            merchant_visible_decision_reason_code(Some("PEP_HIT")),
            Value::String("POLICY".to_owned())
        );
        assert_eq!(
            merchant_visible_decision_reason_code(Some("DOCUMENTS_INCOMPLETE")),
            Value::String("DOCUMENTS_INCOMPLETE".to_owned())
        );
        assert_eq!(merchant_visible_decision_reason_code(None), Value::Null);
    }

    #[test]
    fn email_validation_is_the_ts_regex_subset() {
        assert!(email_looks_valid("ops@example.com"));
        assert!(!email_looks_valid("example.com"));
        assert!(!email_looks_valid("@example.com"));
        assert!(!email_looks_valid("ops@example"));
    }

    #[test]
    fn webhook_constants_match_the_events_module() {
        assert_eq!(WEBHOOK_MAX_ATTEMPTS, 8);
        assert_eq!(WEBHOOK_RETRY_DELAYS_SECONDS.len(), 7);
        assert_eq!(WEBHOOK_EVENT_TYPES.len(), 9);
    }
}
