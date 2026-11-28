//! Platform Settings reads and the checkout-support settings.
//!
//! Port of `core-back/api/internal/admin.ts:19792-20630` (settings, communication status,
//! checkout-support) and `lib/communication/settings.ts` + `settingsWrite.ts` (effective
//! configuration, secret masking, `listPlatformSettingsForApi`).
//!
//! Secrets never leave the process: `valueJson` carries `••••` when a sealed secret exists, and the
//! communication configuration masks every provider secret. The vault ciphertext is not read here;
//! only the existence of the latest version's secret row matters for the mask and `configured`.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDateTime;
use ntex::web::HttpRequest;
use pg_http::ApiError;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::helpers::{iso, iso_or_null, js_json, CHECKOUT_SUPPORT_KEY, SECRET_MASK};
use crate::http::error_response;
use crate::routes::common::json_ok;
use crate::state::AppState;

const COMMUNICATION_EMAIL: &str = "communication.email";
const COMMUNICATION_SMS: &str = "communication.sms";
const COMMUNICATION_POLICY: &str = "communication.policy";
const AUTH_GOOGLE: &str = "auth.google";

/// `SECRET_FIELDS` from `settingsWrite.ts`.
fn secret_fields(key: &str) -> &'static [&'static str] {
    match key {
        COMMUNICATION_EMAIL => &["smtpPassword"],
        COMMUNICATION_SMS => &["webhookSecret"],
        AUTH_GOOGLE => &["clientSecret"],
        _ => &[],
    }
}

/// `listPlatformSettingsForApi`: every version, ordered `key ASC, version DESC`, with the known
/// secret fields masked when that exact version has a sealed value.
async fn list_platform_settings_for_api(pool: &sqlx::PgPool) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, created_at, updated_at, key, scope, value_json, version, source,
                effective_from, approval_request_id
           FROM platform_settings
          ORDER BY key ASC, version DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;

    let secret_rows = sqlx::query(
        "SELECT key, scope, version, field
           FROM platform_setting_secrets
          WHERE scope = 'PLATFORM'
          ORDER BY version DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut secrets: BTreeMap<(String, String, i32), BTreeSet<String>> = BTreeMap::new();
    for row in &secret_rows {
        let key: String = row
            .try_get("key")
            .map_err(crate::routes::common::database_error)?;
        if secret_fields(&key).is_empty() {
            continue;
        }
        let scope: String = row
            .try_get("scope")
            .map_err(crate::routes::common::database_error)?;
        let version: i32 = row
            .try_get("version")
            .map_err(crate::routes::common::database_error)?;
        let field: String = row
            .try_get("field")
            .map_err(crate::routes::common::database_error)?;
        secrets
            .entry((key, scope, version))
            .or_default()
            .insert(field);
    }

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let created_at: NaiveDateTime = row
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let updated_at: NaiveDateTime = row
            .try_get("updated_at")
            .map_err(crate::routes::common::database_error)?;
        let key: String = row
            .try_get("key")
            .map_err(crate::routes::common::database_error)?;
        let scope: String = row
            .try_get("scope")
            .map_err(crate::routes::common::database_error)?;
        let mut value_json: Value = row
            .try_get("value_json")
            .map_err(crate::routes::common::database_error)?;
        let version: i32 = row
            .try_get("version")
            .map_err(crate::routes::common::database_error)?;
        if let Some(fields) = secrets.get(&(key.clone(), scope.clone(), version)) {
            if let Value::Object(object) = &mut value_json {
                for field in fields {
                    object.insert(field.clone(), Value::String(SECRET_MASK.to_owned()));
                }
            }
        }
        let source: String = row
            .try_get("source")
            .map_err(crate::routes::common::database_error)?;
        let effective_from: NaiveDateTime = row
            .try_get("effective_from")
            .map_err(crate::routes::common::database_error)?;
        let approval_request_id: Option<Uuid> = row
            .try_get("approval_request_id")
            .map_err(crate::routes::common::database_error)?;
        out.push(json!({
            "id": id,
            "createdAt": iso(created_at),
            "updatedAt": iso(updated_at),
            "key": key,
            "scope": scope,
            "valueJson": js_json(value_json),
            "version": version,
            "source": source,
            "effectiveFrom": iso(effective_from),
            "approvalRequestId": approval_request_id,
        }));
    }
    Ok(out)
}

/// `GET /internal/admin/settings`.
pub async fn list_settings(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let settings = list_platform_settings_for_api(&state.pools.main).await?;
    Ok(json!({ "settings": settings }))
}

/// `GET /internal/admin/settings/summary`.
pub async fn settings_summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT key, scope, version, effective_from, updated_at
           FROM platform_settings
          ORDER BY key ASC, version DESC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let now = chrono::Utc::now();
    let mut latest: BTreeMap<String, (i32, NaiveDateTime, NaiveDateTime)> = BTreeMap::new();
    let mut scopes: BTreeMap<String, i64> = BTreeMap::new();
    for row in &rows {
        let key: String = row
            .try_get("key")
            .map_err(crate::routes::common::database_error)?;
        let scope: String = row
            .try_get("scope")
            .map_err(crate::routes::common::database_error)?;
        let version: i32 = row
            .try_get("version")
            .map_err(crate::routes::common::database_error)?;
        let effective_from: NaiveDateTime = row
            .try_get("effective_from")
            .map_err(crate::routes::common::database_error)?;
        let updated_at: NaiveDateTime = row
            .try_get("updated_at")
            .map_err(crate::routes::common::database_error)?;
        *scopes.entry(scope).or_insert(0) += 1;
        latest
            .entry(key)
            .or_insert((version, effective_from, updated_at));
    }
    let current: Vec<&(i32, NaiveDateTime, NaiveDateTime)> = latest.values().collect();
    let now_naive = now.naive_utc();
    let future_effective = current
        .iter()
        .filter(|(_, effective_from, _)| *effective_from > now_naive)
        .count();
    let updated_last_24h = current
        .iter()
        .filter(|(_, _, updated_at)| {
            (now_naive - *updated_at).num_milliseconds() <= 24 * 60 * 60 * 1000
        })
        .count();
    Ok(json!({
        "summary": {
            "keys": current.len(),
            "versions": rows.len(),
            "scopes": scopes,
            "futureEffective": future_effective,
            "updatedLast24h": updated_last_24h,
        }
    }))
}

// ---------------------------------------------------------------------------------------------
// Communication configuration (effective view)
// ---------------------------------------------------------------------------------------------

struct SettingView {
    value: Map<String, Value>,
    source: String,
    enabled_explicitly_false: bool,
}

fn as_object(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

fn text(values: impl IntoIterator<Item = Option<String>>) -> String {
    for value in values {
        if let Some(value) = value.map(|value| value.trim().to_owned()) {
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

fn field_text(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(Value::String(value)) = object.get(*key) {
            if !value.trim().is_empty() {
                return Some(value.trim().to_owned());
            }
        }
        if let Some(Value::Number(value)) = object.get(*key) {
            return Some(value.to_string());
        }
    }
    None
}

fn env_text(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_bool(key: &str, fallback: bool) -> bool {
    match std::env::var(key) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => fallback,
        },
        Err(_) => fallback,
    }
}

fn env_number(key: &str, fallback: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(fallback)
}

fn email_like(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !value.chars().any(char::is_whitespace)
}

struct CommunicationRows {
    email: Option<SettingView>,
    sms: Option<SettingView>,
    policy: Option<SettingView>,
    google: Option<SettingView>,
    email_secret: bool,
    sms_secret: bool,
    google_secret: bool,
}

async fn load_communication_rows(pool: &sqlx::PgPool) -> Result<CommunicationRows, ApiError> {
    let keys = vec![
        COMMUNICATION_EMAIL.to_owned(),
        COMMUNICATION_SMS.to_owned(),
        COMMUNICATION_POLICY.to_owned(),
        AUTH_GOOGLE.to_owned(),
    ];
    let rows = sqlx::query(
        "SELECT key, version, value_json, source
           FROM platform_settings
          WHERE scope = 'PLATFORM' AND key = ANY($1::text[])
          ORDER BY key ASC, version DESC",
    )
    .bind(&keys)
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut latest: BTreeMap<String, (i32, Value, String)> = BTreeMap::new();
    for row in &rows {
        let key: String = row
            .try_get("key")
            .map_err(crate::routes::common::database_error)?;
        if latest.contains_key(&key) {
            continue;
        }
        let version: i32 = row
            .try_get("version")
            .map_err(crate::routes::common::database_error)?;
        let value_json: Value = row
            .try_get("value_json")
            .map_err(crate::routes::common::database_error)?;
        let source: String = row
            .try_get("source")
            .map_err(crate::routes::common::database_error)?;
        latest.insert(key, (version, value_json, source));
    }

    let secret_rows = sqlx::query(
        "SELECT key, version, field
           FROM platform_setting_secrets
          WHERE scope = 'PLATFORM' AND key = ANY($1::text[])
          ORDER BY version DESC",
    )
    .bind(&keys)
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut secrets: BTreeMap<(String, i32), BTreeSet<String>> = BTreeMap::new();
    for row in &secret_rows {
        let key: String = row
            .try_get("key")
            .map_err(crate::routes::common::database_error)?;
        let version: i32 = row
            .try_get("version")
            .map_err(crate::routes::common::database_error)?;
        let field: String = row
            .try_get("field")
            .map_err(crate::routes::common::database_error)?;
        secrets.entry((key, version)).or_default().insert(field);
    }

    let view = |key: &str| -> Option<SettingView> {
        latest.get(key).map(|(_, value, source)| {
            let object = as_object(value);
            let explicit_false = object.get("enabled") == Some(&Value::Bool(false));
            SettingView {
                value: object,
                source: source.clone(),
                enabled_explicitly_false: explicit_false,
            }
        })
    };
    let has_secret = |key: &str, field: &str| -> bool {
        latest.get(key).is_some_and(|(version, _, _)| {
            secrets
                .get(&(key.to_owned(), *version))
                .is_some_and(|fields| fields.contains(field))
        })
    };
    Ok(CommunicationRows {
        email: view(COMMUNICATION_EMAIL),
        sms: view(COMMUNICATION_SMS),
        policy: view(COMMUNICATION_POLICY),
        google: view(AUTH_GOOGLE),
        email_secret: has_secret(COMMUNICATION_EMAIL, "smtpPassword"),
        sms_secret: has_secret(COMMUNICATION_SMS, "webhookSecret"),
        google_secret: has_secret(AUTH_GOOGLE, "clientSecret"),
    })
}

fn source_of(view: Option<&SettingView>, env_has_any: bool) -> &'static str {
    match view {
        None => {
            if env_has_any {
                "ENV"
            } else {
                "MISSING"
            }
        }
        Some(view) => {
            if view.source.eq_ignore_ascii_case("ENV_BOOTSTRAP") {
                "ENV_BOOTSTRAP"
            } else {
                "ADMIN"
            }
        }
    }
}

struct EmailConfig {
    enabled: bool,
    from_email: String,
    from_name: String,
    reply_to: String,
    host: String,
    port: i64,
    security: String,
    username: String,
    password: String,
    timeout_ms: i64,
    allow_insecure: bool,
    source: String,
    configured: bool,
    missing: Vec<String>,
}

fn merged_email(rows: &CommunicationRows) -> EmailConfig {
    let empty = Map::new();
    let view = rows.email.as_ref();
    let object = view.map_or(&empty, |view| &view.value);
    let admin_disabled = view.is_some_and(|view| view.enabled_explicitly_false);
    let host = text([
        field_text(object, &["smtpHost", "host"]),
        env_text("SMTP_HOST"),
    ]);
    let from_email = text([
        field_text(object, &["fromEmail", "from"]),
        env_text("SMTP_FROM_EMAIL"),
    ]);
    let security = text([
        field_text(object, &["smtpSecurity", "security"]),
        env_text("SMTP_SECURITY"),
    ])
    .to_ascii_uppercase();
    let security = if security == "TLS" || security == "NONE" {
        security
    } else {
        "STARTTLS".to_owned()
    };
    let username = text([
        field_text(object, &["smtpUsername", "user", "username"]),
        env_text("SMTP_USER"),
    ]);
    let password = if rows.email_secret {
        "***".to_owned()
    } else {
        env_text("SMTP_PASSWORD").unwrap_or_default()
    };
    let mut missing = Vec::new();
    if host.is_empty() {
        missing.push("smtpHost".to_owned());
    }
    if !email_like(&from_email) {
        missing.push("fromEmail".to_owned());
    }
    if !username.is_empty() && password.is_empty() {
        missing.push("smtpPassword".to_owned());
    }
    let enabled = !admin_disabled && env_bool("COMMUNICATION_EMAIL_ENABLED", false);
    let source = source_of(
        view,
        env_text("SMTP_HOST").is_some()
            || env_text("SMTP_FROM_EMAIL").is_some()
            || env_text("SMTP_USER").is_some()
            || env_bool("COMMUNICATION_EMAIL_ENABLED", false),
    );
    EmailConfig {
        enabled,
        from_email,
        from_name: text([
            field_text(object, &["fromName"]),
            env_text("SMTP_FROM_NAME"),
            Some("Payment Gateway".to_owned()),
        ]),
        reply_to: text([field_text(object, &["replyTo"]), env_text("SMTP_REPLY_TO")]),
        host,
        // TS `number(env.SMTP_PORT, field(...))` reads the environment first; the zod default
        // (587) is already positive, so the setting's `smtpPort` never wins. Replicated.
        port: env_number("SMTP_PORT", 587.0) as i64,
        security,
        username,
        password,
        // Same TS quirk as `smtpPort`: `SMTP_TIMEOUT_MS` has a default, so it always wins.
        timeout_ms: env_number("SMTP_TIMEOUT_MS", 10_000.0) as i64,
        allow_insecure: env_bool("SMTP_ALLOW_INSECURE", false),
        source: source.to_owned(),
        configured: !admin_disabled && missing.is_empty() && enabled,
        missing,
    }
}

struct SmsConfig {
    enabled: bool,
    webhook_url: String,
    webhook_secret: String,
    sender_id: String,
    timeout_ms: i64,
    source: String,
    configured: bool,
    missing: Vec<String>,
}

fn merged_sms(rows: &CommunicationRows) -> SmsConfig {
    let empty = Map::new();
    let view = rows.sms.as_ref();
    let object = view.map_or(&empty, |view| &view.value);
    let admin_disabled = view.is_some_and(|view| view.enabled_explicitly_false);
    let webhook_url = text([
        field_text(object, &["webhookUrl", "url"]),
        env_text("SMS_WEBHOOK_URL"),
    ]);
    let webhook_secret = if rows.sms_secret {
        "***".to_owned()
    } else {
        env_text("SMS_WEBHOOK_SECRET").unwrap_or_default()
    };
    let mut missing = Vec::new();
    if webhook_url.is_empty() {
        missing.push("webhookUrl".to_owned());
    }
    if webhook_secret.is_empty() {
        missing.push("webhookSecret".to_owned());
    }
    let enabled = !admin_disabled && env_bool("COMMUNICATION_SMS_ENABLED", false);
    SmsConfig {
        enabled,
        webhook_url,
        webhook_secret,
        sender_id: text([field_text(object, &["senderId"]), env_text("SMS_SENDER_ID")]),
        // `SMS_TIMEOUT_MS` has a zod default, so it wins over the setting (TS parity).
        timeout_ms: env_number("SMS_TIMEOUT_MS", 10_000.0) as i64,
        source: source_of(
            view,
            env_text("SMS_WEBHOOK_URL").is_some()
                || env_text("SMS_WEBHOOK_SECRET").is_some()
                || env_bool("COMMUNICATION_SMS_ENABLED", false),
        )
        .to_owned(),
        configured: !admin_disabled && missing.is_empty() && enabled,
        missing,
    }
}

struct GoogleConfig {
    enabled: bool,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    hosted_domain: String,
    source: String,
    configured: bool,
    missing: Vec<String>,
}

fn merged_google(rows: &CommunicationRows) -> GoogleConfig {
    let empty = Map::new();
    let view = rows.google.as_ref();
    let object = view.map_or(&empty, |view| &view.value);
    let admin_disabled = view.is_some_and(|view| view.enabled_explicitly_false);
    let client_id = text([
        field_text(object, &["clientId"]),
        env_text("GOOGLE_CLIENT_ID"),
    ]);
    let client_secret = if rows.google_secret {
        "***".to_owned()
    } else {
        env_text("GOOGLE_CLIENT_SECRET").unwrap_or_default()
    };
    let redirect_uri = text([
        field_text(object, &["redirectUri"]),
        env_text("GOOGLE_REDIRECT_URI"),
    ]);
    let mut missing = Vec::new();
    if client_id.is_empty() {
        missing.push("clientId".to_owned());
    }
    if client_secret.is_empty() {
        missing.push("clientSecret".to_owned());
    }
    if redirect_uri.is_empty() {
        missing.push("redirectUri".to_owned());
    }
    let enabled = !admin_disabled && env_bool("GOOGLE_AUTH_ENABLED", false);
    GoogleConfig {
        enabled,
        client_id,
        client_secret,
        redirect_uri,
        hosted_domain: text([
            field_text(object, &["hostedDomain"]),
            env_text("GOOGLE_HOSTED_DOMAIN"),
        ]),
        source: source_of(
            view,
            env_text("GOOGLE_CLIENT_ID").is_some()
                || env_text("GOOGLE_CLIENT_SECRET").is_some()
                || env_text("GOOGLE_REDIRECT_URI").is_some()
                || env_bool("GOOGLE_AUTH_ENABLED", false),
        )
        .to_owned(),
        configured: !admin_disabled && missing.is_empty() && enabled,
        missing,
    }
}

struct PolicyConfig {
    sms_mode: String,
    sms_template_codes: Vec<String>,
    staff_sms_fallback: bool,
    source: String,
}

fn merged_policy(rows: &CommunicationRows) -> PolicyConfig {
    let empty = Map::new();
    let view = rows.policy.as_ref();
    let object = view.map_or(&empty, |view| &view.value);
    let mode = field_text(object, &["smsMode"])
        .unwrap_or_default()
        .to_ascii_uppercase();
    let sms_mode = if ["OFF", "AUTH_ONLY", "CRITICAL_ONLY", "ALL"].contains(&mode.as_str()) {
        mode
    } else {
        "CRITICAL_ONLY".to_owned()
    };
    let codes: Vec<String> = match object.get("smsTemplateCodes") {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(|entry| entry.trim().to_ascii_uppercase())
            .filter(|entry| !entry.is_empty())
            .collect(),
        _ => [
            "LOGIN_MFA",
            "EMAIL_VERIFICATION",
            "PASSWORD_RESET",
            "PASSWORD_CHANGED",
            "STAFF_INVITATION",
            "SECURITY_ALERT",
        ]
        .iter()
        .map(|entry| (*entry).to_owned())
        .collect(),
    };
    PolicyConfig {
        sms_mode,
        sms_template_codes: codes,
        staff_sms_fallback: match object.get("staffSmsFallbackWhenEmailMissing") {
            Some(Value::Bool(value)) => *value,
            _ => true,
        },
        source: source_of(view, false).to_owned(),
    }
}

struct ChannelStatus {
    last_test_at: Option<chrono::DateTime<chrono::Utc>>,
    last_test_status: Option<String>,
    last_test_error: Option<String>,
    last_delivery_at: Option<chrono::DateTime<chrono::Utc>>,
    last_delivery_status: Option<String>,
    consecutive_failures: i64,
}

async fn load_channel_status(
    pool: &sqlx::PgPool,
) -> (Option<ChannelStatus>, Option<ChannelStatus>) {
    let result = sqlx::query(
        "SELECT channel, last_test_at, last_test_status, last_test_error, last_delivery_at,
                last_delivery_status, consecutive_failures
           FROM communication_channel_status
          WHERE channel IN ('EMAIL', 'SMS')",
    )
    .fetch_all(pool)
    .await;
    let Ok(rows) = result else {
        return (None, None);
    };
    let mut email = None;
    let mut sms = None;
    for row in &rows {
        let Ok(channel) = row.try_get::<String, _>("channel") else {
            continue;
        };
        let status = ChannelStatus {
            last_test_at: row.try_get("last_test_at").ok().flatten(),
            last_test_status: row.try_get("last_test_status").ok().flatten(),
            last_test_error: row.try_get("last_test_error").ok().flatten(),
            last_delivery_at: row.try_get("last_delivery_at").ok().flatten(),
            last_delivery_status: row.try_get("last_delivery_status").ok().flatten(),
            consecutive_failures: row.try_get::<i32, _>("consecutive_failures").unwrap_or(0) as i64,
        };
        if channel == "EMAIL" {
            email = Some(status);
        } else if channel == "SMS" {
            sms = Some(status);
        }
    }
    (email, sms)
}

/// `GET /internal/admin/settings/communication/status`.
pub async fn communication_status(
    state: &AppState,
    _request: &HttpRequest,
) -> Result<Value, ApiError> {
    let rows = load_communication_rows(&state.pools.main).await?;
    let email = merged_email(&rows);
    let sms = merged_sms(&rows);
    let google = merged_google(&rows);
    let policy = merged_policy(&rows);
    let (email_status, sms_status) = load_channel_status(&state.pools.main).await;
    let email_status = email_status.unwrap_or(ChannelStatus {
        last_test_at: None,
        last_test_status: None,
        last_test_error: None,
        last_delivery_at: None,
        last_delivery_status: None,
        consecutive_failures: 0,
    });
    let sms_status = sms_status.unwrap_or(ChannelStatus {
        last_test_at: None,
        last_test_status: None,
        last_test_error: None,
        last_delivery_at: None,
        last_delivery_status: None,
        consecutive_failures: 0,
    });
    let maintenance = if email.configured {
        Value::Null
    } else {
        json!({
            "active": true,
            "code": "EMAIL_NOT_CONFIGURED",
            "message": "Merchant registration and sign-in are unavailable until email delivery is configured in Platform Settings.",
        })
    };
    let email_password = if email.password.is_empty() {
        ""
    } else {
        SECRET_MASK
    };
    let sms_secret = if sms.webhook_secret.is_empty() {
        ""
    } else {
        SECRET_MASK
    };
    let google_secret = if google.client_secret.is_empty() {
        ""
    } else {
        SECRET_MASK
    };
    Ok(json!({
        "status": {
            "email": {
                "enabled": email.enabled,
                "configured": email.configured,
                "source": email.source,
                "missingFields": email.missing,
                "lastTestAt": iso_or_null(email_status.last_test_at.map(|value| value.naive_utc())),
                "lastTestStatus": email_status.last_test_status,
                "lastTestError": email_status.last_test_error,
                "lastDeliveryAt": iso_or_null(email_status.last_delivery_at.map(|value| value.naive_utc())),
                "lastDeliveryStatus": email_status.last_delivery_status,
                "consecutiveFailures": email_status.consecutive_failures,
            },
            "sms": {
                "enabled": sms.enabled,
                "configured": sms.configured,
                "source": sms.source,
                "missingFields": sms.missing,
                "lastTestAt": iso_or_null(sms_status.last_test_at.map(|value| value.naive_utc())),
                "lastTestStatus": sms_status.last_test_status,
                "lastDeliveryAt": iso_or_null(sms_status.last_delivery_at.map(|value| value.naive_utc())),
                "lastDeliveryStatus": sms_status.last_delivery_status,
                "consecutiveFailures": sms_status.consecutive_failures,
            },
            "google": {
                "enabled": google.enabled,
                "configured": google.configured,
                "source": google.source,
                "missingFields": google.missing,
            },
            "maintenance": maintenance,
        },
        "configuration": {
            "email": {
                "enabled": email.enabled,
                "provider": "SMTP",
                "fromEmail": email.from_email,
                "fromName": email.from_name,
                "replyTo": email.reply_to,
                "smtpHost": email.host,
                "smtpPort": email.port,
                "smtpSecurity": email.security,
                "smtpUsername": email.username,
                "smtpPassword": email_password,
                "timeoutMs": email.timeout_ms,
                "allowInsecure": email.allow_insecure,
                "source": email.source,
                "configured": email.configured,
                "missingFields": email.missing,
            },
            "sms": {
                "enabled": sms.enabled,
                "provider": "WEBHOOK",
                "webhookUrl": sms.webhook_url,
                "webhookSecret": sms_secret,
                "senderId": sms.sender_id,
                "timeoutMs": sms.timeout_ms,
                "source": sms.source,
                "configured": sms.configured,
                "missingFields": sms.missing,
            },
            "google": {
                "enabled": google.enabled,
                "clientId": google.client_id,
                "clientSecret": google_secret,
                "redirectUri": google.redirect_uri,
                "hostedDomain": google.hosted_domain,
                "source": google.source,
                "configured": google.configured,
                "missingFields": google.missing,
            },
            "policy": {
                "smsMode": policy.sms_mode,
                "smsTemplateCodes": policy.sms_template_codes,
                "staffSmsFallbackWhenEmailMissing": policy.staff_sms_fallback,
                "source": policy.source,
            },
        }
    }))
}

// ---------------------------------------------------------------------------------------------
// Checkout support settings
// ---------------------------------------------------------------------------------------------

struct CheckoutSupportRow {
    id: Uuid,
    version: i32,
    value_json: Value,
    effective_from: NaiveDateTime,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

async fn load_checkout_support(pool: &sqlx::PgPool) -> Result<Vec<CheckoutSupportRow>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, version, value_json, effective_from, created_at, updated_at
           FROM platform_settings
          WHERE key = $1
          ORDER BY version DESC",
    )
    .bind(CHECKOUT_SUPPORT_KEY)
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(CheckoutSupportRow {
            id: row
                .try_get("id")
                .map_err(crate::routes::common::database_error)?,
            version: row
                .try_get("version")
                .map_err(crate::routes::common::database_error)?,
            value_json: row
                .try_get("value_json")
                .map_err(crate::routes::common::database_error)?,
            effective_from: row
                .try_get("effective_from")
                .map_err(crate::routes::common::database_error)?,
            created_at: row
                .try_get("created_at")
                .map_err(crate::routes::common::database_error)?,
            updated_at: row
                .try_get("updated_at")
                .map_err(crate::routes::common::database_error)?,
        });
    }
    Ok(out)
}

/// `GET /internal/admin/settings/checkout-support`.
pub async fn checkout_support(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let rows = load_checkout_support(&state.pools.main).await?;
    let latest = rows.first();
    Ok(json!({
        "key": CHECKOUT_SUPPORT_KEY,
        "value": latest.map_or(Value::Null, |row| js_json(row.value_json.clone())),
        "version": latest.map(|row| row.version),
        "updatedAt": latest.map_or(Value::Null, |row| Value::String(iso(row.updated_at))),
    }))
}

/// `GET /internal/admin/settings/checkout-support/history`.
pub async fn checkout_support_history(
    state: &AppState,
    _request: &HttpRequest,
) -> Result<Value, ApiError> {
    let rows = load_checkout_support(&state.pools.main).await?;
    let versions: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.id,
                "version": row.version,
                "valueJson": js_json(row.value_json.clone()),
                "effectiveFrom": iso(row.effective_from),
                "createdAt": iso(row.created_at),
                "updatedAt": iso(row.updated_at),
            })
        })
        .collect();
    Ok(json!({ "key": CHECKOUT_SUPPORT_KEY, "versions": versions }))
}

/// `GET /internal/admin/settings/checkout-support/summary`.
pub async fn checkout_support_summary(
    state: &AppState,
    _request: &HttpRequest,
) -> Result<Value, ApiError> {
    let rows = load_checkout_support(&state.pools.main).await?;
    let latest = rows.first();
    let value = latest.map_or_else(Map::new, |row| as_object(&row.value_json));
    let channels: Vec<&str> = ["support_phone", "support_whatsapp", "support_email"]
        .into_iter()
        .filter(|key| {
            value
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|entry| !entry.trim().is_empty())
        })
        .collect();
    let faq_items = value
        .get("faq_items")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let now = chrono::Utc::now().naive_utc();
    Ok(json!({
        "summary": {
            "enabled": value.get("enabled") == Some(&Value::Bool(true)),
            "showPlatformContact": value.get("show_platform_contact") != Some(&Value::Bool(false)),
            "showMerchantContact": value.get("show_merchant_contact") != Some(&Value::Bool(false)),
            "faqItems": faq_items,
            "channels": channels,
            "channelCount": channels.len(),
            "versions": rows.len(),
            "currentVersion": latest.map_or(0, |row| row.version),
            "updatedAt": latest.map_or(Value::Null, |row| Value::String(iso(row.updated_at))),
            "effectiveFrom": latest.map_or(Value::Null, |row| Value::String(iso(row.effective_from))),
            "futureEffective": latest.is_some_and(|row| row.effective_from > now),
        }
    }))
}

macro_rules! handler {
    ($name:ident, $target:path) => {
        pub fn $name<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            _principal: Option<&'a pg_domain_auth::Principal>,
            _payload: ntex::web::types::Payload,
        ) -> crate::routes::HandlerFuture<'a> {
            Box::pin(async move {
                match $target(state, request).await {
                    Ok(body) => json_ok(&body),
                    Err(error) => error_response(request, error),
                }
            })
        }
    };
}

handler!(list_settings_handler, list_settings);
handler!(settings_summary_handler, settings_summary);
handler!(communication_status_handler, communication_status);
handler!(checkout_support_handler, checkout_support);
handler!(checkout_support_history_handler, checkout_support_history);
handler!(checkout_support_summary_handler, checkout_support_summary);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_fields_are_the_three_communication_keys() {
        assert_eq!(secret_fields(COMMUNICATION_EMAIL), &["smtpPassword"]);
        assert_eq!(secret_fields(COMMUNICATION_SMS), &["webhookSecret"]);
        assert_eq!(secret_fields(AUTH_GOOGLE), &["clientSecret"]);
        assert!(secret_fields("other.key").is_empty());
    }

    #[test]
    fn email_validation_matches_the_simple_ts_regex() {
        assert!(email_like("ops@example.com"));
        assert!(!email_like("ops@example"));
        assert!(!email_like("ops example.com"));
        assert!(!email_like("@example.com"));
    }

    #[test]
    fn policy_defaults_match_the_ts_merge() {
        let rows = CommunicationRows {
            email: None,
            sms: None,
            policy: None,
            google: None,
            email_secret: false,
            sms_secret: false,
            google_secret: false,
        };
        let policy = merged_policy(&rows);
        assert_eq!(policy.sms_mode, "CRITICAL_ONLY");
        assert_eq!(policy.sms_template_codes.len(), 6);
        assert!(policy.staff_sms_fallback);
    }
}
