//! Translation between the public admin vocabulary and core's canonical vocabulary.
//!
//! Port of `admin-back/api/contract.ts` (1,691 LOC). Core validates every forwarded body with a
//! strict zod object, so the edge must emit only keys core accepts, always emit the keys core
//! requires, translate renamed fields and never pass unknown public fields through.
//!
//! Every mapper here is pure. Where the TS mapper throws an `ApiError` (a missing canonical
//! field, an unsupported decision), the Rust mapper returns the same status/code/message.

#![forbid(unsafe_code)]

use serde_json::{json, Map, Number, Value};

use crate::error::{ApiError, EdgeResult};

pub type Rec = Map<String, Value>;

fn as_record(value: &Value) -> Rec {
    value.as_object().cloned().unwrap_or_default()
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn s(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn n(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

fn b(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn a(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    a(value, key)
        .into_iter()
        .filter_map(|entry| entry.as_str().map(str::to_owned))
        .collect()
}

fn rec(value: &Value, key: &str) -> Rec {
    value.get(key).map(as_record).unwrap_or_default()
}

fn clamp(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn non_empty(value: Option<String>, fallback: &str) -> String {
    let candidate = value.unwrap_or_default();
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn pick_enum(value: Option<&Value>, allowed: &[&'static str]) -> Option<&'static str> {
    let candidate = value.and_then(Value::as_str)?.trim().to_uppercase();
    if candidate.is_empty() {
        return None;
    }
    allowed
        .iter()
        .find(|entry| entry.to_uppercase() == candidate)
        .copied()
}

fn pick_enum_str(value: Option<String>, allowed: &[&'static str]) -> Option<&'static str> {
    let candidate = value?.trim().to_uppercase();
    if candidate.is_empty() {
        return None;
    }
    allowed
        .iter()
        .find(|entry| entry.to_uppercase() == candidate)
        .copied()
}

/// `Number(value)` without the JS `undefined` special case.
fn js_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(raw) => raw.trim().parse::<f64>().ok()?,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        _ => return None,
    };
    number.is_finite().then_some(number)
}

fn js_integer(value: Option<&Value>) -> Option<i64> {
    let number = js_number(value)?;
    (number.fract() == 0.0).then_some(number as i64)
}

fn clamp_number(value: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    let number = n_value(value)?;
    Some((number.round() as i64).clamp(min, max))
}

fn n_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|entry| entry.is_finite())
}

fn missing_canonical(key: &str) -> ApiError {
    ApiError::new(
        400,
        "VALIDATION_FAILED",
        format!("The canonical core field \"{key}\" is required"),
    )
    .with_details(json!({ "path": [key], "message": "Required" }))
}

fn require_canonical(value: Option<String>, key: &str, min_length: usize) -> EdgeResult<String> {
    let candidate = value.unwrap_or_default();
    let trimmed = candidate.trim();
    if trimmed.chars().count() >= min_length {
        Ok(trimmed.to_owned())
    } else {
        Err(missing_canonical(key))
    }
}

fn put(map: &mut Rec, key: &str, value: Value) {
    map.insert(key.to_owned(), value);
}

fn value_string(value: String) -> Value {
    Value::String(value)
}

fn checklist_of(source: &Value) -> Option<Value> {
    let list: Vec<Value> = a(source, "checklist")
        .into_iter()
        .filter(|entry| entry.is_string())
        .take(10)
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(Value::Array(list))
    }
}

fn insert_checklist(result: &mut Rec, source: &Value) {
    if let Some(checklist) = checklist_of(source) {
        put(result, "checklist", checklist);
    }
}

const DECIMAL_PATTERN: &str = r"^\d{1,14}(\.\d{1,4})?$";
const DATE_PATTERN: &str = r"^\d{4}-\d{2}-\d{2}$";
const PERCENTAGE_PATTERN: &str = r"^\d{1,6}(\.\d{1,6})?$";

fn is_decimal(value: &str) -> bool {
    crate::schema::regex_match(DECIMAL_PATTERN, value)
}

fn is_date(value: &str) -> bool {
    crate::schema::regex_match(DATE_PATTERN, value)
}

fn is_percentage(value: &str) -> bool {
    crate::schema::regex_match(PERCENTAGE_PATTERN, value)
}

/* ------------------------------------------------------------------ gateway catalog */

const GATEWAY_KINDS: &[&str] = &["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"];
const RISK_CLASSES: &[&str] = &["NORMAL", "HIGH_RISK"];
const GATEWAY_ENVIRONMENTS: &[&str] = &["SANDBOX", "LIVE"];

fn to_verification_state(value: Option<String>) -> Option<&'static str> {
    let level = value?.trim().to_uppercase();
    match level.as_str() {
        "VERIFIED" => Some("VERIFIED"),
        "PARTIAL" | "INTERNAL" => Some("UNVERIFIED"),
        _ => None,
    }
}

pub fn to_core_gateway_create(body: &Value) -> EdgeResult<Value> {
    let source = as_record(body);
    let source_value = Value::Object(source.clone());
    let name = non_empty(s(body, "name"), "gateway");
    let mut result = Rec::new();
    put(
        &mut result,
        "code",
        value_string(s(body, "code").unwrap_or_default().trim().to_lowercase()),
    );
    put(&mut result, "name", value_string(name.clone()));
    let operator = s(body, "operator")
        .or_else(|| s(body, "category"))
        .filter(|entry| !entry.trim().is_empty())
        .unwrap_or_else(|| name.clone());
    put(&mut result, "operator", value_string(operator));
    put(
        &mut result,
        "kind",
        value_string(
            pick_enum(body.get("kind"), GATEWAY_KINDS)
                .unwrap_or("DIRECT")
                .to_owned(),
        ),
    );
    if let Some(country) = s(body, "country").filter(|entry| !entry.is_empty()) {
        let upper: String = country.to_uppercase().chars().take(2).collect();
        put(&mut result, "country", value_string(upper));
    }
    let aliases: Vec<Value> = strings(&source_value, "aliases")
        .into_iter()
        .take(20)
        .map(Value::String)
        .collect();
    if !aliases.is_empty() {
        put(&mut result, "aliases", Value::Array(aliases));
    }
    if let Some(state) = to_verification_state(s(body, "evidenceLevel")) {
        put(
            &mut result,
            "verificationState",
            value_string(state.to_owned()),
        );
    }
    if let Some(risk) = pick_enum(body.get("riskClass"), RISK_CLASSES) {
        put(&mut result, "riskClass", value_string(risk.to_owned()));
    }
    Ok(Value::Object(result))
}

pub fn to_core_gateway_update(body: &Value) -> EdgeResult<Value> {
    let source = as_record(body);
    let source_value = Value::Object(source);
    let mut result = Rec::new();
    if let Some(code) = s(body, "code").map(|value| value.trim().to_lowercase()) {
        if !code.is_empty() {
            put(&mut result, "code", value_string(code));
        }
    }
    if let Some(name) = s(body, "name") {
        if !name.is_empty() {
            put(&mut result, "name", value_string(name));
        }
    }
    if let Some(operator) = s(body, "operator")
        .or_else(|| s(body, "category"))
        .filter(|value| !value.is_empty())
    {
        put(&mut result, "operator", value_string(operator));
    }
    if let Some(country) = s(body, "country").filter(|value| !value.is_empty()) {
        let upper: String = country.to_uppercase().chars().take(2).collect();
        put(&mut result, "country", value_string(upper));
    }
    if let Some(kind) = pick_enum(body.get("kind"), GATEWAY_KINDS) {
        put(&mut result, "kind", value_string(kind.to_owned()));
    }
    let aliases: Vec<Value> = strings(&source_value, "aliases")
        .into_iter()
        .take(20)
        .map(Value::String)
        .collect();
    if !aliases.is_empty() {
        put(&mut result, "aliases", Value::Array(aliases));
    }
    if let Some(state) = to_verification_state(s(body, "evidenceLevel")) {
        put(
            &mut result,
            "verificationState",
            value_string(state.to_owned()),
        );
    }
    if let Some(risk) = pick_enum(body.get("riskClass"), RISK_CLASSES) {
        put(&mut result, "riskClass", value_string(risk.to_owned()));
    }
    Ok(Value::Object(result))
}

pub fn to_core_gateway_version_create(body: &Value) -> EdgeResult<Value> {
    let source = as_record(body);
    let source_value = Value::Object(source);
    let mut result = Rec::new();
    if let Some(note) = s(body, "changelog") {
        if !note.is_empty() {
            put(&mut result, "changeNote", value_string(clamp(&note, 1000)));
        }
    }
    let mut derived = Rec::new();
    if let Some(version) = n(body, "version") {
        if version.fract() == 0.0 {
            put(&mut derived, "version", json!(version as i64));
        } else {
            put(&mut derived, "version", json!(version));
        }
    }
    if let Some(based_on) = s(body, "basedOnVersionId") {
        if !based_on.is_empty() {
            put(&mut derived, "basedOnVersionId", value_string(based_on));
        }
    }
    let snapshot = body
        .get("snapshot")
        .filter(|value| is_record(value))
        .cloned()
        .unwrap_or(Value::Object(derived));
    put(&mut result, "snapshot", snapshot);
    let _ = source_value;
    Ok(Value::Object(result))
}

pub fn to_core_gateway_rollback(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "versionId",
        value_string(s(body, "targetVersionId").unwrap_or_default()),
    );
    if let Some(reason) = s(body, "reason") {
        if !reason.is_empty() {
            put(&mut result, "reason", value_string(clamp(&reason, 500)));
        }
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

fn resolve_environment(code: Option<String>, fallback: &'static str) -> &'static str {
    let value = code.unwrap_or_default().trim().to_uppercase();
    if value.is_empty() {
        return fallback;
    }
    if value.contains("LIVE") || value.contains("PROD") {
        return "LIVE";
    }
    if ["SANDBOX", "TEST", "UAT", "STAGING", "DEV"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        return "SANDBOX";
    }
    fallback
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed.host_str().map(|host| {
                parsed
                    .port()
                    .map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"))
            })
        })
        .unwrap_or_else(|| url.to_owned())
}

pub fn to_core_gateway_version_environments(body: &Value) -> EdgeResult<Value> {
    let entries: Vec<Value> = a(body, "environments")
        .into_iter()
        .filter(|entry| entry.is_object())
        .collect();
    let requested = pick_enum(body.get("env"), GATEWAY_ENVIRONMENTS);
    let fallback = requested.unwrap_or("SANDBOX");
    let resolved: Vec<(Value, &'static str)> = entries
        .into_iter()
        .map(|entry| {
            let env = entry.get("env").or_else(|| entry.get("code"));
            let env = resolve_environment(
                env.and_then(Value::as_str).map(str::to_owned),
                requested.unwrap_or(fallback),
            );
            (entry, env)
        })
        .collect();
    let target = requested
        .or_else(|| resolved.first().map(|(_, env)| *env))
        .unwrap_or(fallback);
    let selected: Vec<&(Value, &'static str)> =
        resolved.iter().filter(|(_, env)| *env == target).collect();
    let mut base_urls = Rec::new();
    let mut allowed_hosts: Vec<String> = Vec::new();
    let mut inbound: Vec<String> = Vec::new();
    let mut outbound: Vec<String> = Vec::new();
    for (entry, env) in &selected {
        let code = non_empty(s(entry, "code"), &env.to_lowercase());
        let base_url = s(entry, "baseUrl");
        if let Some(base_url) = base_url.as_deref().filter(|value| !value.is_empty()) {
            base_urls.insert(clamp(&code, 40), value_string(clamp(base_url, 500)));
        }
        let explicit = strings(entry, "allowedHosts");
        if !explicit.is_empty() {
            for host in explicit {
                let host = clamp(&host, 200);
                if !allowed_hosts.contains(&host) {
                    allowed_hosts.push(host);
                }
            }
        } else if let Some(base_url) = base_url.as_deref().filter(|value| !value.is_empty()) {
            let host = clamp(&host_of(base_url), 200);
            if !host.is_empty() && !allowed_hosts.contains(&host) {
                allowed_hosts.push(host);
            }
        }
        for ip in strings(entry, "inboundIpAllowlist") {
            let ip = clamp(&ip, 64);
            if !inbound.contains(&ip) {
                inbound.push(ip);
            }
        }
        for ip in strings(entry, "outboundEgressIps") {
            let ip = clamp(&ip, 64);
            if !outbound.contains(&ip) {
                outbound.push(ip);
            }
        }
    }
    let mut result = Rec::new();
    put(&mut result, "env", value_string(target.to_owned()));
    put(&mut result, "baseUrls", Value::Object(base_urls));
    put(
        &mut result,
        "allowedHosts",
        Value::Array(
            allowed_hosts
                .into_iter()
                .take(20)
                .map(Value::String)
                .collect(),
        ),
    );
    if !inbound.is_empty() {
        put(
            &mut result,
            "inboundIpAllowlist",
            Value::Array(inbound.into_iter().take(50).map(Value::String).collect()),
        );
    }
    if !outbound.is_empty() {
        put(
            &mut result,
            "outboundEgressIps",
            Value::Array(outbound.into_iter().take(50).map(Value::String).collect()),
        );
    }
    if let Some((entry, _)) = selected.first() {
        let active = b(entry, "enabled").or_else(|| b(entry, "active"));
        if let Some(active) = active {
            put(&mut result, "enabled", Value::Bool(active));
        }
    }
    Ok(Value::Object(result))
}

const AUTH_METHODS: &[&str] = &[
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
];
const AUTH_APPLY: &[&str] = &["HEADER", "QUERY", "BODY"];

pub fn to_core_gateway_version_auth(body: &Value) -> EdgeResult<Value> {
    let source = as_record(body);
    let auth = rec(body, "auth");
    let mut settings = rec(body, "settings");
    for (key, value) in auth {
        settings.insert(key, value);
    }
    let settings_value = Value::Object(settings);
    let env = pick_enum(
        body.get("env")
            .or_else(|| body.get("auth").and_then(|auth| auth.get("env"))),
        GATEWAY_ENVIRONMENTS,
    )
    .unwrap_or("LIVE");
    let method = pick_enum(
        body.get("authMethod")
            .or_else(|| body.get("auth").and_then(|auth| auth.get("method"))),
        AUTH_METHODS,
    )
    .unwrap_or("NONE");
    let auth_apply = pick_enum(
        body.get("authApply")
            .or_else(|| body.get("auth").and_then(|auth| auth.get("authApply"))),
        AUTH_APPLY,
    )
    .or_else(|| pick_enum(settings_value.get("authApply"), AUTH_APPLY))
    .unwrap_or("HEADER");
    let mut result = Rec::new();
    put(&mut result, "env", value_string(env.to_owned()));
    put(&mut result, "method", value_string(method.to_owned()));
    put(
        &mut result,
        "authApply",
        value_string(auth_apply.to_owned()),
    );
    let mut refresh = Rec::new();
    for key in [
        "username",
        "keyRef",
        "tokenUrl",
        "clientIdRef",
        "clientSecretRef",
        "extraHeaders",
        "header_name",
        "query_name",
        "body_name",
        "token_endpoint",
        "refresh_url",
        "refresh_period_ms",
        "signature_header",
        "timestamp_header",
        "signature_algorithm",
    ] {
        if let Some(value) = settings_value.get(key) {
            refresh.insert(key.to_owned(), value.clone());
        }
    }
    if !refresh.is_empty() {
        put(&mut result, "refreshConfigJson", Value::Object(refresh));
    }
    let _ = source;
    Ok(Value::Object(result))
}

const AMOUNT_SCALES: &[i64] = &[1, 100, 1000];
const AMOUNT_PRECISIONS: &[i64] = &[0, 2, 3];
const AMOUNT_ROUNDING: &[&str] = &["NONE", "NEAREST", "UP", "DOWN"];
const AMOUNT_FORMATS: &[&str] = &["STRING_DECIMAL", "INTEGER_MINOR_UNITS", "NUMBER"];

pub fn to_core_gateway_version_settings(body: &Value) -> EdgeResult<Value> {
    let pipeline = rec(body, "amountPipeline");
    let mut settings = rec(body, "settings");
    for (key, value) in pipeline {
        settings.insert(key, value);
    }
    let settings_value = Value::Object(settings);
    let amount_scale = settings_value
        .get("amountScale")
        .and_then(Value::as_i64)
        .filter(|value| AMOUNT_SCALES.contains(value))
        .unwrap_or(1);
    let amount_precision = settings_value
        .get("amountPrecision")
        .and_then(Value::as_i64)
        .filter(|value| AMOUNT_PRECISIONS.contains(value))
        .unwrap_or(2);
    let mut result = Rec::new();
    put(&mut result, "amountScale", json!(amount_scale));
    put(&mut result, "amountPrecision", json!(amount_precision));
    put(
        &mut result,
        "amountRounding",
        value_string(
            pick_enum_str(
                settings_value
                    .get("amountRounding")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                AMOUNT_ROUNDING,
            )
            .unwrap_or("NONE")
            .to_owned(),
        ),
    );
    put(
        &mut result,
        "amountFormat",
        value_string(
            pick_enum_str(
                settings_value
                    .get("amountFormat")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                AMOUNT_FORMATS,
            )
            .unwrap_or("STRING_DECIMAL")
            .to_owned(),
        ),
    );
    put(
        &mut result,
        "referenceFormat",
        settings_value
            .get("referenceFormat")
            .filter(|value| is_record(value))
            .cloned()
            .unwrap_or_else(|| Value::Object(Rec::new())),
    );
    put(
        &mut result,
        "sessionTtlSeconds",
        json!(clamp_number(settings_value.get("sessionTtlSeconds"), 30, 86_400).unwrap_or(1800)),
    );
    put(
        &mut result,
        "otpTtlSeconds",
        json!(clamp_number(settings_value.get("otpTtlSeconds"), 30, 3600).unwrap_or(300)),
    );
    put(
        &mut result,
        "otpResendCooldownSeconds",
        json!(clamp_number(settings_value.get("otpResendCooldownSeconds"), 0, 3600).unwrap_or(60)),
    );
    if let Some(timeout) = clamp_number(
        body.get("timeoutMs")
            .or_else(|| settings_value.get("timeoutMs")),
        1000,
        120_000,
    ) {
        put(&mut result, "timeoutMs", json!(timeout));
    }
    if let Some(value) = clamp_number(settings_value.get("maxOtpAttempts"), 1, 10) {
        put(&mut result, "maxOtpAttempts", json!(value));
    }
    if let Some(value) = b(&settings_value, "supportsStatusCheck") {
        put(&mut result, "supportsStatusCheck", Value::Bool(value));
    }
    if let Some(value) = clamp_number(settings_value.get("statusCheckMinAgeSeconds"), 0, 86_400) {
        put(&mut result, "statusCheckMinAgeSeconds", json!(value));
    }
    if let Some(value) = b(&settings_value, "supportsIdempotencyKey") {
        put(&mut result, "supportsIdempotencyKey", Value::Bool(value));
    }
    if let Some(value) = b(&settings_value, "supportsCancel") {
        put(&mut result, "supportsCancel", Value::Bool(value));
    }
    if let Some(value) = clamp_number(settings_value.get("rateLimitPerSecond"), 1, 1000) {
        put(&mut result, "rateLimitPerSecond", json!(value));
    }
    if let Some(value) = clamp_number(settings_value.get("concurrencyCap"), 1, 1000) {
        put(&mut result, "concurrencyCap", json!(value));
    }
    if let Some(value) = clamp_number(settings_value.get("maxResponseBytes"), 1024, 10_485_760) {
        put(&mut result, "maxResponseBytes", json!(value));
    }
    if let Some(timezone) = s(&settings_value, "gatewayTimezone").filter(|value| !value.is_empty())
    {
        put(
            &mut result,
            "gatewayTimezone",
            value_string(clamp(&timezone, 64)),
        );
    }
    Ok(Value::Object(result))
}

const CRYPTO_ALGORITHMS: &[&str] = &["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"];
const CRYPTO_PURPOSES: &[&str] = &["OUTBOUND_SIGN", "INBOUND_VERIFY"];
const CANONICALIZATION_MODES: &[&str] = &[
    "SORTED_KEY_VALUE_AMP",
    "SORTED_VALUES_HASH",
    "TEMPLATE_STRING",
    "JSON_CANONICAL",
    "RAW_BODY",
    "TIMESTAMP_DOT_RAW_BODY",
];
const OUTPUT_ENCODINGS: &[&str] = &["HEX_LOWER", "HEX_UPPER", "BASE64"];
fn to_secret_key_encoding(value: Option<String>) -> &'static str {
    match value.unwrap_or_default().trim().to_uppercase().as_str() {
        "HEX" => "HEX",
        "BASE64" => "BASE64",
        _ => "UTF8",
    }
}

pub fn to_core_gateway_version_crypto_profiles(body: &Value) -> EdgeResult<Value> {
    let profiles: Vec<Value> = a(body, "cryptoProfiles")
        .into_iter()
        .filter(|profile| profile.is_object())
        .take(20)
        .map(|profile| {
            let encoding = s(&profile, "encoding").map(|value| value.trim().to_uppercase());
            let canonicalization =
                s(&profile, "canonicalization").map(|value| value.trim().to_uppercase());
            let output_encoding =
                s(&profile, "outputEncoding").map(|value| value.trim().to_uppercase());
            let mut result = Rec::new();
            put(
                &mut result,
                "name",
                value_string(clamp(
                    &non_empty(
                        s(&profile, "code").or_else(|| s(&profile, "name")),
                        "profile",
                    ),
                    64,
                )),
            );
            put(
                &mut result,
                "purpose",
                value_string(
                    pick_enum(
                        profile.get("purpose").or_else(|| profile.get("direction")),
                        CRYPTO_PURPOSES,
                    )
                    .unwrap_or("OUTBOUND_SIGN")
                    .to_owned(),
                ),
            );
            put(
                &mut result,
                "algorithm",
                value_string(
                    pick_enum(profile.get("algorithm"), CRYPTO_ALGORITHMS)
                        .unwrap_or("SHA256")
                        .to_owned(),
                ),
            );
            put(
                &mut result,
                "secretKeyEncoding",
                value_string(
                    to_secret_key_encoding(
                        s(&profile, "keyEncoding").or_else(|| s(&profile, "encoding")),
                    )
                    .to_owned(),
                ),
            );
            let canonical = canonicalization
                .as_deref()
                .filter(|value| CANONICALIZATION_MODES.contains(value))
                .map(str::to_owned)
                .or_else(|| {
                    encoding
                        .as_deref()
                        .filter(|value| CANONICALIZATION_MODES.contains(value))
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "SORTED_KEY_VALUE_AMP".to_owned());
            put(&mut result, "canonicalizationMode", value_string(canonical));
            let output = output_encoding
                .as_deref()
                .filter(|value| OUTPUT_ENCODINGS.contains(value))
                .map(str::to_owned)
                .or_else(|| {
                    encoding
                        .as_deref()
                        .filter(|value| OUTPUT_ENCODINGS.contains(value))
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "HEX_LOWER".to_owned());
            put(&mut result, "outputEncoding", value_string(output));
            if let Some(secret) = s(&profile, "secretRef").filter(|value| !value.is_empty()) {
                put(
                    &mut result,
                    "secretKeyRef",
                    value_string(clamp(&secret, 120)),
                );
            }
            let fields: Vec<Value> = strings(&profile, "fields")
                .into_iter()
                .take(100)
                .map(Value::String)
                .collect();
            if !fields.is_empty() {
                put(&mut result, "includedFields", Value::Array(fields));
            }
            Value::Object(result)
        })
        .collect();
    Ok(json!({ "profiles": profiles }))
}

const FLOW_PHASES: &[&str] = &[
    "CREDENTIAL_CHECK",
    "PRE_INITIATE",
    "INITIATE",
    "SUBMIT",
    "VERIFY",
    "CANCEL",
    "REFUND",
    "VOID",
    "CAPTURE",
    "SETTLEMENT_FETCH",
];
const FLOW_STEP_TYPES: &[&str] = &["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"];
const SIDE_EFFECTS: &[&str] = &["READ_ONLY", "SENDS_NOTIFICATION", "MOVES_MONEY"];
const RETRY_POLICIES: &[&str] = &["SAFE", "SAFE_WITH_COOLDOWN", "NEVER"];

fn to_core_flow_step(entry: &Value) -> Value {
    let mut result = Rec::new();
    put(
        &mut result,
        "type",
        value_string(
            pick_enum(entry.get("type"), FLOW_STEP_TYPES)
                .unwrap_or("HTTP")
                .to_owned(),
        ),
    );
    put(
        &mut result,
        "sideEffect",
        value_string(
            pick_enum(entry.get("sideEffect"), SIDE_EFFECTS)
                .unwrap_or("READ_ONLY")
                .to_owned(),
        ),
    );
    put(
        &mut result,
        "retryPolicy",
        value_string(
            pick_enum(entry.get("retryPolicy"), RETRY_POLICIES)
                .unwrap_or("SAFE")
                .to_owned(),
        ),
    );
    if let Some(method) = s(entry, "method") {
        put(&mut result, "method", value_string(clamp(&method, 10)));
    }
    if let Some(url) = s(entry, "urlTemplate").or_else(|| s(entry, "url")) {
        put(&mut result, "urlTemplate", value_string(clamp(&url, 1000)));
    }
    if let Some(content_type) = s(entry, "contentType") {
        put(
            &mut result,
            "contentType",
            value_string(clamp(&content_type, 80)),
        );
    }
    if let Some(point_of_no_return) = b(entry, "pointOfNoReturn") {
        put(
            &mut result,
            "pointOfNoReturn",
            Value::Bool(point_of_no_return),
        );
    }
    match entry.get("idempotencyConfig") {
        Some(value) if is_record(value) => {
            put(&mut result, "idempotencyConfig", value.clone());
        }
        Some(value) => {
            if let Some(mode) = value.as_str().filter(|mode| !mode.is_empty()) {
                put(
                    &mut result,
                    "idempotencyConfig",
                    json!({ "mode": clamp(mode, 64) }),
                );
            }
        }
        None => {}
    }
    if let Some(timeout) = clamp_number(entry.get("timeoutMs"), 1000, 120_000) {
        put(&mut result, "timeoutMs", json!(timeout));
    }
    Value::Object(result)
}

fn resolve_flow_phases(flow: &Value) -> Vec<&'static str> {
    let mut mapped: Vec<&'static str> = Vec::new();
    for phase in strings(flow, "phases").into_iter().chain(s(flow, "phase")) {
        if let Some(phase) = pick_enum_str(Some(phase), FLOW_PHASES) {
            if !mapped.contains(&phase) {
                mapped.push(phase);
            }
        }
    }
    if mapped.is_empty() {
        mapped.push(pick_enum(flow.get("code"), FLOW_PHASES).unwrap_or("INITIATE"));
    }
    mapped
}

pub fn to_core_gateway_version_flows(body: &Value) -> EdgeResult<Value> {
    let mut flows: Vec<Value> = Vec::new();
    for entry in a(body, "flows")
        .into_iter()
        .filter(|entry| entry.is_object())
        .take(40)
    {
        let steps = a(&entry, "steps");
        for phase in resolve_flow_phases(&entry) {
            let phase_steps: Vec<Value> = steps
                .iter()
                .filter(|step| {
                    step.get("phase")
                        .and_then(Value::as_str)
                        .is_none_or(|step_phase| step_phase.trim().to_uppercase() == phase)
                })
                .map(to_core_flow_step)
                .collect();
            flows.push(json!({ "phase": phase, "steps": phase_steps }));
        }
    }
    Ok(json!({ "flows": flows }))
}

const CHANNEL_TYPES: &[&str] = &[
    "WEBHOOK",
    "RETURN_URL",
    "BROWSER_CALLBACK",
    "POLL",
    "STATEMENT",
    "OPERATOR",
];
const VERIFY_METHODS: &[&str] = &[
    "HMAC_BODY",
    "HASH_FIELDS",
    "SORTED_VALUES_HASH",
    "RSA",
    "SHARED_TOKEN",
    "IP_ONLY",
    "NONE_PLUS_INQUIRY",
];
const BODY_FORMATS: &[&str] = &["JSON", "FORM", "XML"];

fn default_verify_method(channel_type: &str) -> &'static str {
    match channel_type {
        "POLL" | "OPERATOR" => "NONE_PLUS_INQUIRY",
        "STATEMENT" => "HASH_FIELDS",
        "RETURN_URL" | "BROWSER_CALLBACK" => "SHARED_TOKEN",
        _ => "HMAC_BODY",
    }
}

fn resolve_path_token(entry: &Value) -> String {
    let candidate = s(entry, "pathToken")
        .or_else(|| s(entry, "token"))
        .or_else(|| s(entry, "path"))
        .or_else(|| s(entry, "code"))
        .or_else(|| s(entry, "name"));
    match candidate {
        Some(candidate) if (8..=120).contains(&candidate.len()) => candidate,
        _ => uuid::Uuid::new_v4().simple().to_string(),
    }
}

fn channel_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "WEBHOOK" => "WEBHOOK",
        "RETURN_URL" => "RETURN_URL",
        "BROWSER_CALLBACK" => "BROWSER_CALLBACK",
        "INQUIRY_POLL" | "POLL" => "POLL",
        "STATEMENT" => "STATEMENT",
        "OPERATOR" => "OPERATOR",
        "SYNC_RESPONSE" => "WEBHOOK",
        _ => return None,
    })
}

fn to_core_channel(entry: &Value, forced_type: Option<&'static str>) -> Option<Value> {
    if !is_record(entry) {
        return None;
    }
    let kind = s(entry, "kind").unwrap_or_default().trim().to_uppercase();
    let channel_type = forced_type
        .or_else(|| pick_enum(entry.get("type"), CHANNEL_TYPES))
        .or_else(|| channel_kind(&kind))
        .unwrap_or("WEBHOOK");
    let verify = pick_enum(entry.get("verifyMethod"), VERIFY_METHODS)
        .unwrap_or_else(|| default_verify_method(channel_type));
    let mut result = Rec::new();
    put(&mut result, "type", value_string(channel_type.to_owned()));
    put(
        &mut result,
        "pathToken",
        value_string(resolve_path_token(entry)),
    );
    put(&mut result, "verifyMethod", value_string(verify.to_owned()));
    put(
        &mut result,
        "bodyFormat",
        value_string(
            pick_enum(entry.get("bodyFormat"), BODY_FORMATS)
                .unwrap_or("JSON")
                .to_owned(),
        ),
    );
    if let Some(route_id) = s(entry, "routeId") {
        put(&mut result, "routeId", value_string(clamp(&route_id, 64)));
    }
    if let Some(header) = s(entry, "signatureHeader") {
        put(
            &mut result,
            "signatureHeader",
            value_string(clamp(&header, 120)),
        );
    }
    if let Some(selector) = s(entry, "correlationSelector") {
        put(
            &mut result,
            "correlationSelector",
            value_string(clamp(&selector, 160)),
        );
    }
    if let Some(selector) = s(entry, "dedupeKeySelector") {
        put(
            &mut result,
            "dedupeKeySelector",
            value_string(clamp(&selector, 160)),
        );
    }
    if let Some(template) = s(entry, "ackBodyTemplate") {
        put(
            &mut result,
            "ackBodyTemplate",
            value_string(clamp(&template, 1000)),
        );
    }
    if let Some(tolerance) = clamp_number(
        entry
            .get("timestampToleranceSec")
            .or_else(|| entry.get("timestampToleranceSeconds")),
        30,
        86_400,
    ) {
        put(&mut result, "timestampToleranceSec", json!(tolerance));
    }
    let ip_list: Vec<Value> = strings(entry, "ipAllowlist")
        .into_iter()
        .take(50)
        .map(Value::String)
        .collect();
    if !ip_list.is_empty() {
        put(&mut result, "ipAllowlist", Value::Array(ip_list));
    }
    if let Some(status) = clamp_number(entry.get("ackStatus"), 200, 599) {
        put(&mut result, "ackStatus", json!(status));
    }
    let weak_verification = verify == "SHARED_TOKEN" || verify == "IP_ONLY";
    let weak_transport = channel_type == "RETURN_URL" || channel_type == "BROWSER_CALLBACK";
    let must_inquire = b(entry, "mustInquire").unwrap_or(weak_verification || weak_transport);
    put(&mut result, "mustInquire", Value::Bool(must_inquire));
    Some(Value::Object(result))
}

pub fn to_core_gateway_version_channels(body: &Value) -> EdgeResult<Value> {
    let mut channels: Vec<Value> = Vec::new();
    for entry in a(body, "confirmationChannels") {
        if let Some(channel) = to_core_channel(&entry, None) {
            channels.push(channel);
        }
    }
    for entry in a(body, "pollPolicies") {
        if let Some(channel) = to_core_channel(&entry, Some("POLL")) {
            channels.push(channel);
        }
    }
    channels.truncate(20);
    Ok(json!({ "channels": channels }))
}

const STATUS_RULE_OPS: &[&str] = &["equals", "not_equals", "in", "exists", "matches"];
const CANONICAL_STATUSES: &[&str] = &[
    "AWAITING_CUSTOMER",
    "VERIFYING",
    "SUCCEEDED",
    "FAILED",
    "UNKNOWN",
];

fn to_canonical_status(value: &Value) -> &'static str {
    if let Some(direct) = pick_enum(Some(value), CANONICAL_STATUSES) {
        return direct;
    }
    let status = value.as_str().unwrap_or_default().trim().to_uppercase();
    if [
        "SUCCEEDED",
        "REFUNDED",
        "PARTIALLY_REFUNDED",
        "CAPTURED",
        "SETTLED",
    ]
    .contains(&status.as_str())
    {
        return "SUCCEEDED";
    }
    if [
        "FAILED",
        "EXPIRED",
        "CANCELLED",
        "BLOCKED",
        "DISPUTED",
        "DECLINED",
        "REJECTED",
    ]
    .contains(&status.as_str())
    {
        return "FAILED";
    }
    if [
        "CREATED",
        "INITIATING",
        "AUTHORIZING",
        "PROCESSING",
        "PENDING",
    ]
    .contains(&status.as_str())
    {
        return "VERIFYING";
    }
    if status == "AWAITING_CUSTOMER" {
        return "AWAITING_CUSTOMER";
    }
    "UNKNOWN"
}

pub fn to_core_gateway_version_status_rules(body: &Value) -> EdgeResult<Value> {
    let rules: Vec<Value> = a(body, "statusRules")
        .into_iter()
        .filter(|rule| rule.is_object())
        .take(50)
        .map(|rule| {
            let gateway_code = s(&rule, "gatewayCode").or_else(|| s(&rule, "selector"));
            let mut result = Rec::new();
            put(
                &mut result,
                "phase",
                value_string(clamp(&non_empty(s(&rule, "phase"), "INITIATE"), 40)),
            );
            put(
                &mut result,
                "selector",
                value_string(clamp(&non_empty(gateway_code.clone(), "status"), 160)),
            );
            put(
                &mut result,
                "op",
                value_string(
                    pick_enum(rule.get("op"), STATUS_RULE_OPS)
                        .unwrap_or("equals")
                        .to_owned(),
                ),
            );
            let value = match rule.get("value") {
                Some(value) => value.clone(),
                None => gateway_code.map_or(Value::Null, Value::String),
            };
            put(&mut result, "value", value);
            put(
                &mut result,
                "canonicalStatus",
                value_string(
                    to_canonical_status(rule.get("canonicalStatus").unwrap_or(&Value::Null))
                        .to_owned(),
                ),
            );
            if let Some(substatus) = s(&rule, "canonicalSubstatus") {
                put(
                    &mut result,
                    "canonicalSubstatus",
                    value_string(clamp(&substatus, 80)),
                );
            }
            if let Some(error) = s(&rule, "canonicalError").or_else(|| s(&rule, "messageEn")) {
                put(
                    &mut result,
                    "canonicalError",
                    value_string(clamp(&error, 80)),
                );
            }
            Value::Object(result)
        })
        .collect();
    Ok(json!({ "rules": rules }))
}

const ERROR_CLASSIFICATIONS: &[&str] = &[
    "RETRYABLE_OTP",
    "TERMINAL_DECLINE",
    "LIMIT_EXCEEDED",
    "GATEWAY_FAULT",
    "AMBIGUOUS",
];

pub fn to_core_gateway_version_error_maps(body: &Value) -> EdgeResult<Value> {
    let maps: Vec<Value> = a(body, "errorMaps")
        .into_iter()
        .filter(|entry| entry.is_object())
        .take(100)
        .map(|entry| {
            let gateway_code = clamp(
                &non_empty(
                    s(&entry, "gatewayCode").or_else(|| s(&entry, "code")),
                    "UNKNOWN",
                ),
                80,
            );
            let otp_retryable = b(&entry, "otpRetryable");
            let canonical_error = clamp(
                &non_empty(
                    s(&entry, "canonicalError")
                        .or_else(|| s(&entry, "canonicalStatus"))
                        .or_else(|| s(&entry, "errorCode")),
                    &gateway_code,
                ),
                80,
            );
            let mut result = Rec::new();
            put(&mut result, "gatewayCode", value_string(gateway_code));
            put(&mut result, "canonicalError", value_string(canonical_error));
            let classification = pick_enum(entry.get("classification"), ERROR_CLASSIFICATIONS)
                .unwrap_or(if otp_retryable == Some(true) {
                    "RETRYABLE_OTP"
                } else {
                    "AMBIGUOUS"
                });
            put(
                &mut result,
                "classification",
                value_string(classification.to_owned()),
            );
            if let Some(value) = b(&entry, "retryable") {
                put(&mut result, "retryable", Value::Bool(value));
            }
            if let Some(value) = b(&entry, "countsTowardLockout") {
                put(&mut result, "countsTowardLockout", Value::Bool(value));
            }
            if let Some(value) = b(&entry, "countsTowardBreaker") {
                put(&mut result, "countsTowardBreaker", Value::Bool(value));
            }
            if let Some(value) = s(&entry, "customerMessageAr").or_else(|| s(&entry, "messageAr")) {
                put(
                    &mut result,
                    "customerMessageAr",
                    value_string(clamp(&value, 500)),
                );
            }
            if let Some(value) = s(&entry, "customerMessageEn").or_else(|| s(&entry, "messageEn")) {
                put(
                    &mut result,
                    "customerMessageEn",
                    value_string(clamp(&value, 500)),
                );
            }
            if let Some(hint) = s(&entry, "operatorHint") {
                put(&mut result, "operatorHint", value_string(clamp(&hint, 500)));
            }
            Value::Object(result)
        })
        .collect();
    Ok(json!({ "maps": maps }))
}

pub fn to_core_gateway_version_dry_run(body: &Value) -> EdgeResult<Value> {
    let payload = rec(body, "payload");
    let mut result = Rec::new();
    if let Some(rail_code) =
        s(&Value::Object(payload.clone()), "railCode").or_else(|| s(body, "railCode"))
    {
        put(&mut result, "railCode", value_string(clamp(&rail_code, 64)));
    }
    if let Some(amount) = s(&Value::Object(payload.clone()), "amount") {
        if is_decimal(&amount) {
            put(&mut result, "amount", value_string(amount));
        }
    }
    if let Some(currency) = s(&Value::Object(payload), "currency") {
        if currency.len() == 3 {
            put(&mut result, "currency", value_string(currency));
        }
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_gateway_version_run_suite(body: &Value) -> EdgeResult<Value> {
    let mut scenarios: Vec<String> = strings(body, "scenarios")
        .into_iter()
        .filter(|scenario| scenario.len() <= 64)
        .take(30)
        .collect();
    if let Some(suite) = s(body, "suite").filter(|suite| suite.len() <= 64) {
        scenarios.insert(0, suite);
    }
    let mut result = Rec::new();
    if !scenarios.is_empty() {
        put(
            &mut result,
            "scenarios",
            Value::Array(scenarios.into_iter().map(Value::String).collect()),
        );
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* --------------------------------------------------------------------------- users */

const USER_ROLES: &[&str] = &[
    "GATEWAY_ADMIN",
    "SECURITY_ADMIN",
    "FINANCE",
    "OPERATOR",
    "COMPLIANCE",
    "MLRO",
    "SUPPORT",
];
const USER_STATUSES: &[&str] = &["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"];

fn map_user_status(value: Option<String>) -> Option<&'static str> {
    let status = value?.trim().to_uppercase();
    if status.is_empty() {
        return None;
    }
    if status == "LOCKED" {
        return Some("SUSPENDED");
    }
    USER_STATUSES
        .iter()
        .find(|candidate| **candidate == status)
        .copied()
}

fn flatten_authorities(value: Option<&Value>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        let candidate = entry.trim();
        if candidate.len() < 2 || candidate.len() > 64 {
            return;
        }
        if !result.iter().any(|existing| existing == candidate) {
            result.push(candidate.to_owned());
        }
    };
    match value {
        Some(Value::Array(entries)) => {
            for entry in entries {
                if let Some(entry) = entry.as_str() {
                    push(entry);
                }
            }
            return result;
        }
        Some(Value::Object(map)) => {
            for (key, entry) in map {
                match entry {
                    Value::Bool(true) => push(key),
                    Value::Array(items) => {
                        if items.is_empty() {
                            push(key);
                            continue;
                        }
                        for item in items {
                            if let Some(item) = item.as_str() {
                                if key.contains(':') {
                                    push(key);
                                } else {
                                    push(&format!("{key}:{item}"));
                                }
                            }
                        }
                    }
                    Value::String(entry) => {
                        if key.contains(':') {
                            push(key);
                        } else {
                            push(&format!("{key}:{entry}"));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    result
}

pub fn to_core_user_create(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "email",
        value_string(s(body, "email").unwrap_or_default().trim().to_lowercase()),
    );
    let role = pick_enum(body.get("role"), USER_ROLES)
        .map(str::to_owned)
        .or_else(|| s(body, "role"))
        .unwrap_or_default();
    put(&mut result, "role", value_string(role));
    let authorities: Vec<Value> = flatten_authorities(body.get("authorities"))
        .into_iter()
        .take(60)
        .map(Value::String)
        .collect();
    if !authorities.is_empty() {
        put(&mut result, "authoritiesMap", Value::Array(authorities));
    }
    insert_checklist(&mut result, body);
    // Never `phone` or `password`, even from a legacy payload: the invitee sets both.
    Ok(Value::Object(result))
}

pub fn to_core_user_update(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    if let Some(role) = s(body, "role").filter(|value| !value.is_empty()) {
        put(&mut result, "role", value_string(role));
    }
    if let Some(status) = map_user_status(s(body, "status")) {
        put(&mut result, "status", value_string(status.to_owned()));
    }
    let authorities: Vec<Value> = flatten_authorities(body.get("authorities"))
        .into_iter()
        .take(60)
        .map(Value::String)
        .collect();
    if !authorities.is_empty() {
        put(&mut result, "authoritiesMap", Value::Array(authorities));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_user_updates(body: &Value) -> EdgeResult<Vec<Value>> {
    let base = to_core_user_update(body)?;
    let mut results = Vec::new();
    for user_id in strings(body, "userIds") {
        let mut update = Rec::new();
        put(&mut update, "id", value_string(user_id));
        if let Value::Object(fields) = &base {
            for (key, value) in fields {
                update.insert(key.clone(), value.clone());
            }
        }
        results.push(Value::Object(update));
    }
    Ok(results)
}

/* ------------------------------------------------------------------ join requests/kyb */

pub fn to_core_join_request_assign(body: &Value) -> EdgeResult<Value> {
    Ok(json!({ "reviewerId": s(body, "assigneeUserId").unwrap_or_default() }))
}

pub fn to_core_join_request_request_info(body: &Value) -> EdgeResult<Value> {
    let message = clamp(&s(body, "message").unwrap_or_default(), 500);
    let items: Vec<Value> = strings(body, "requestedItems")
        .into_iter()
        .take(50)
        .map(|item| json!({ "field": clamp(&item, 80), "message": message }))
        .collect();
    Ok(json!({ "items": items }))
}

pub fn to_core_join_request_decide(body: &Value) -> EdgeResult<Value> {
    let decision = s(body, "decision")
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    let core_decision = match decision.as_str() {
        "APPROVE" | "APPROVED" => "APPROVED",
        "REJECT" | "REJECTED" => "REJECTED",
        _ => {
            return Err(ApiError::new(
                400,
                "UNSUPPORTED_DECISION",
                "Core only supports the APPROVED and REJECTED join request decisions; use the request-info route to ask for more documents",
            )
            .with_details(json!({ "decision": if decision.is_empty() { Value::Null } else { Value::String(decision.clone()) } })));
        }
    };
    let mut result = Rec::new();
    put(
        &mut result,
        "decision",
        value_string(core_decision.to_owned()),
    );
    if let Some(reason) = s(body, "reason").or_else(|| s(body, "reasonCode")) {
        put(&mut result, "reasonCode", value_string(clamp(&reason, 64)));
    }
    if let Some(notes) = s(body, "notes").or_else(|| s(body, "reason")) {
        put(&mut result, "notes", value_string(clamp(&notes, 4000)));
    }
    if let Some(tier) = s(body, "proposedRiskTier").map(|value| value.to_uppercase()) {
        if matches!(tier.as_str(), "LOW" | "STANDARD" | "HIGH") {
            put(&mut result, "proposedRiskTier", value_string(tier));
        }
    }
    Ok(Value::Object(result))
}

pub fn to_core_kyb_document_review(body: &Value) -> EdgeResult<Value> {
    let decision = s(body, "decision")
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    let core_decision = match decision.as_str() {
        "ACCEPT" | "ACCEPTED" => "ACCEPTED",
        "REJECT" | "REJECTED" => "REJECTED",
        _ => {
            return Err(ApiError::new(
                400,
                "UNSUPPORTED_DECISION",
                "Core only supports the ACCEPTED and REJECTED kyb document review decisions",
            )
            .with_details(json!({ "decision": if decision.is_empty() { Value::Null } else { Value::String(decision) } })));
        }
    };
    let mut result = Rec::new();
    put(
        &mut result,
        "decision",
        value_string(core_decision.to_owned()),
    );
    if let Some(reason) = s(body, "reasonCode").or_else(|| s(body, "notes")) {
        put(&mut result, "reasonCode", value_string(clamp(&reason, 64)));
    }
    if let Some(notes) = s(body, "notes") {
        put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    }
    if let Some(justification) = s(body, "duplicateJustification") {
        put(
            &mut result,
            "duplicateJustification",
            value_string(clamp(&justification, 4000)),
        );
    }
    if let Some(expires) = s(body, "expiresOn") {
        if is_date(&expires) {
            put(&mut result, "expiresOn", value_string(expires));
        }
    }
    let checklist: Vec<Value> = a(body, "checklist")
        .into_iter()
        .filter(|entry| entry.is_string())
        .map(|entry| value_string(clamp(entry.as_str().unwrap_or_default(), 160)))
        .take(50)
        .collect();
    if !checklist.is_empty() {
        put(&mut result, "checklist", Value::Array(checklist));
    }
    Ok(Value::Object(result))
}

pub fn to_core_kyb_document_replacement(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "message",
        value_string(clamp(&s(body, "message").unwrap_or_default(), 2000)),
    );
    if let Some(reason) = s(body, "reasonCode") {
        put(&mut result, "reasonCode", value_string(clamp(&reason, 64)));
    }
    Ok(Value::Object(result))
}

pub fn to_core_kyb_document_revalidation(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "message",
        value_string(clamp(&s(body, "message").unwrap_or_default(), 2000)),
    );
    if let Some(reason) = s(body, "reasonCode") {
        put(&mut result, "reasonCode", value_string(clamp(&reason, 64)));
    }
    if let Some(due) = s(body, "dueAt").filter(|value| !value.is_empty()) {
        put(&mut result, "dueAt", value_string(due));
    }
    Ok(Value::Object(result))
}

/* ------------------------------------------------------------------------ merchants */

const MERCHANT_SUSPENSION_REASONS: &[&str] = &[
    "AML",
    "FRAUD",
    "KYB_EXPIRED",
    "COMMISSION_CEILING",
    "MERCHANT_REQUEST",
    "OTHER",
];

pub fn to_core_merchant_suspend(body: &Value) -> EdgeResult<Value> {
    let raw_reason = s(body, "reasonCode")
        .or_else(|| s(body, "reason"))
        .unwrap_or_default();
    let reason_code = raw_reason.trim().to_uppercase();
    let known = MERCHANT_SUSPENSION_REASONS.contains(&reason_code.as_str());
    let mut result = Rec::new();
    put(
        &mut result,
        "reasonCode",
        value_string(if known {
            reason_code.clone()
        } else {
            "OTHER".to_owned()
        }),
    );
    let notes = s(body, "notes").unwrap_or_else(|| {
        if known {
            String::new()
        } else {
            raw_reason.clone()
        }
    });
    put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    if let Some(emergency) = b(body, "emergency") {
        put(&mut result, "emergency", Value::Bool(emergency));
    }
    if let Some(hours) = js_integer(body.get("ratifyWithinHours")).filter(|value| *value > 0) {
        put(&mut result, "ratifyWithinHours", json!(hours));
    }
    if let Some(version) = js_integer(body.get("baseVersion")).filter(|value| *value > 0) {
        put(&mut result, "baseVersion", json!(version));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_merchant_reinstate(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "reason",
        value_string(clamp(&s(body, "reason").unwrap_or_default(), 2000)),
    );
    if let Some(version) = js_integer(body.get("baseVersion")).filter(|value| *value > 0) {
        put(&mut result, "baseVersion", json!(version));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_merchant_propose_edit(body: &Value) -> EdgeResult<Value> {
    let patch: Vec<Value> = a(body, "patch")
        .into_iter()
        .filter(|entry| entry.is_object())
        .take(200)
        .collect();
    let mut result = Rec::new();
    put(&mut result, "patch", Value::Array(patch));
    if let Some(reason) = s(body, "reason").filter(|value| !value.is_empty()) {
        put(&mut result, "reason", value_string(clamp(&reason, 2000)));
    }
    if let Some(version) = js_integer(body.get("baseVersion")).filter(|value| *value > 0) {
        put(&mut result, "baseVersion", json!(version));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_merchant_descriptive(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    for field in [
        "tradeName",
        "displayName",
        "logoUrl",
        "supportEmail",
        "supportPhone",
    ] {
        if let Some(value) = s(body, field).filter(|value| !value.is_empty()) {
            put(&mut result, field, value_string(value));
        }
    }
    if let Some(reason) = s(body, "reason").filter(|value| !value.is_empty()) {
        put(&mut result, "reason", value_string(clamp(&reason, 2000)));
    }
    if let Some(version) = js_integer(body.get("baseVersion")).filter(|value| *value > 0) {
        put(&mut result, "baseVersion", json!(version));
    }
    Ok(Value::Object(result))
}

pub fn to_core_merchant_close(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "reasonCode",
        value_string(clamp(
            &s(body, "reasonCode").unwrap_or_else(|| "OTHER".to_owned()),
            64,
        )),
    );
    if let Some(notes) = s(body, "notes").filter(|value| !value.is_empty()) {
        put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    }
    if let Some(version) = js_integer(body.get("baseVersion")).filter(|value| *value > 0) {
        put(&mut result, "baseVersion", json!(version));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_merchant_withdraw(body: &Value) -> EdgeResult<Value> {
    match s(body, "reason").filter(|value| !value.is_empty()) {
        Some(reason) => Ok(json!({ "reason": clamp(&reason, 2000) })),
        None => Ok(Value::Object(Rec::new())),
    }
}

/* ------------------------------------------------------------------------ approvals */

const DISPUTE_OUTCOMES: &[&str] = &["WON", "LOST"];

pub fn to_core_approval_approve(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    if let Some(notes) = s(body, "comment").or_else(|| s(body, "reason")) {
        put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    }
    if let Some(outcome) = pick_enum(body.get("outcome"), DISPUTE_OUTCOMES) {
        put(&mut result, "outcome", value_string(outcome.to_owned()));
    }
    if let Some(note) = s(body, "riskAcceptanceNote") {
        put(
            &mut result,
            "riskAcceptanceNote",
            value_string(clamp(&note, 2000)),
        );
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_approval_reject(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "reason",
        value_string(clamp(&s(body, "reason").unwrap_or_default(), 2000)),
    );
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ------------------------------------------------------------------------------ aml */

pub fn to_core_aml_match_disposition(body: &Value) -> EdgeResult<Value> {
    let disposition = s(body, "disposition")
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    let core = match disposition.as_str() {
        "FALSE_POSITIVE" => "FALSE_POSITIVE",
        "CONFIRMED_MATCH" | "TRUE_MATCH" => "TRUE_MATCH",
        // PENDING is not terminal: core keeps it open by escalating it.
        _ => "ESCALATED",
    };
    let mut result = Rec::new();
    put(&mut result, "disposition", value_string(core.to_owned()));
    if let Some(notes) = s(body, "notes") {
        put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    }
    if let Some(suppress) = b(body, "suppressFuture") {
        put(&mut result, "suppressFuture", Value::Bool(suppress));
    }
    if let Some(until) = s(body, "suppressUntil").filter(|value| is_date(value)) {
        put(&mut result, "suppressUntil", value_string(until));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_aml_case_propose(body: &Value) -> EdgeResult<Value> {
    let action = s(body, "action").unwrap_or_default().trim().to_uppercase();
    let core = match action.as_str() {
        "AML_HOLD" | "BLOCK" | "HOLD" => "HOLD",
        "RELEASE" => "RELEASE",
        "REJECT" => "REJECT",
        // CASE_ONLY and REPORT both end up as an escalation for the checker.
        _ => "ESCALATE",
    };
    let mut result = Rec::new();
    put(&mut result, "action", value_string(core.to_owned()));
    if let Some(notes) = s(body, "notes").or_else(|| s(body, "reason")) {
        put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

const AML_RULE_TYPES: &[&str] = &[
    "SINGLE_AMOUNT",
    "CUMULATIVE_WINDOW",
    "STRUCTURING",
    "RISK_TIER",
    "COUNTERPARTY_COUNTRY",
    "RAIL",
    "MERCHANT_DIRECT_AMOUNT",
];
const AML_RULE_ACTIONS: &[&str] = &["HOLD", "FLAG", "BLOCK", "CASE_ONLY"];
const AML_SEVERITIES: &[&str] = &["LOW", "MEDIUM", "HIGH", "CRITICAL"];

pub fn to_core_aml_rule(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "code",
        value_string(s(body, "code").unwrap_or_default()),
    );
    put(
        &mut result,
        "name",
        value_string(s(body, "name").unwrap_or_default()),
    );
    put(
        &mut result,
        "ruleType",
        value_string(
            pick_enum(body.get("ruleType"), AML_RULE_TYPES)
                .unwrap_or("SINGLE_AMOUNT")
                .to_owned(),
        ),
    );
    put(
        &mut result,
        "action",
        value_string(
            pick_enum(body.get("action"), AML_RULE_ACTIONS)
                .unwrap_or("FLAG")
                .to_owned(),
        ),
    );
    put(
        &mut result,
        "baseSeverity",
        value_string(
            pick_enum(body.get("baseSeverity"), AML_SEVERITIES)
                .unwrap_or("MEDIUM")
                .to_owned(),
        ),
    );
    put(&mut result, "params", Value::Object(rec(body, "params")));
    let scope = rec(body, "scope");
    if !scope.is_empty() {
        put(&mut result, "scope", Value::Object(scope));
    }
    if let Some(effective) = s(body, "effectiveFrom").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "effectiveFrom",
            value_string(clamp(&effective, 64)),
        );
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

const REPORT_TYPES: &[&str] = &[
    "LARGE_TRANSACTION",
    "SUSPICIOUS_ACTIVITY",
    "PERIODIC_RETURN",
];

fn infer_report_type(explicit: Option<&Value>, hints: &[Option<String>]) -> String {
    if let Some(direct) = pick_enum(explicit, REPORT_TYPES) {
        return direct.to_owned();
    }
    for hint in hints.iter().flatten() {
        let value = hint.trim().to_uppercase();
        if value.is_empty() {
            continue;
        }
        if value.contains("LARGE") || value.contains("THRESHOLD") {
            return "LARGE_TRANSACTION".to_owned();
        }
        if value.contains("SUSPICIOUS") || value.contains("SAR") {
            return "SUSPICIOUS_ACTIVITY".to_owned();
        }
        if value.contains("PERIODIC") || value.contains("RETURN") {
            return "PERIODIC_RETURN".to_owned();
        }
    }
    "LARGE_TRANSACTION".to_owned()
}

fn required_formats(report_type: &str) -> Vec<Value> {
    let formats: &[&str] = match report_type {
        "INCIDENT" => &["DOCX"],
        "PERIODIC_RETURN" => &["XLSX"],
        _ => &["XML"],
    };
    formats
        .iter()
        .map(|format| value_string((*format).to_owned()))
        .collect()
}

pub fn to_core_aml_reporting_rule(body: &Value) -> EdgeResult<Value> {
    let report_type =
        infer_report_type(body.get("reportType"), &[s(body, "code"), s(body, "name")]);
    let formats = required_formats(&report_type);
    let mut result = Rec::new();
    put(&mut result, "reportType", value_string(report_type.clone()));
    put(
        &mut result,
        "sourceReference",
        value_string(
            s(body, "code")
                .or_else(|| s(body, "name"))
                .unwrap_or_default(),
        ),
    );
    put(
        &mut result,
        "requiredOutputFormats",
        Value::Array(formats.clone()),
    );
    put(
        &mut result,
        "primaryOutputFormat",
        formats.first().cloned().unwrap_or(Value::Null),
    );
    if let Some(threshold) = s(body, "threshold").filter(|value| is_decimal(value)) {
        put(&mut result, "thresholdAmount", value_string(threshold));
    }
    if let Some(currency) = s(body, "currency").filter(|value| value.len() == 3) {
        put(
            &mut result,
            "currency",
            value_string(currency.to_uppercase()),
        );
    }
    if let Some(days) = n(body, "windowDays") {
        let seconds = ((days * 86_400.0).round() as i64).clamp(1, 31_536_000);
        put(&mut result, "windowSeconds", json!(seconds));
    }
    Ok(Value::Object(result))
}

pub fn to_core_aml_report(body: &Value) -> EdgeResult<Value> {
    let case_id = s(body, "caseId");
    let reporting_rule_id = s(body, "reportingRuleId").unwrap_or_default();
    let mut payload = Rec::new();
    put(
        &mut payload,
        "reportingRuleId",
        value_string(reporting_rule_id.clone()),
    );
    put(
        &mut payload,
        "periodStart",
        value_string(s(body, "periodStart").unwrap_or_default()),
    );
    put(
        &mut payload,
        "periodEnd",
        value_string(s(body, "periodEnd").unwrap_or_default()),
    );
    if let Some(notes) = s(body, "notes") {
        put(&mut payload, "notes", value_string(notes));
    }
    let report_type = infer_report_type(
        body.get("reportType"),
        &[Some(reporting_rule_id.clone()), case_id.clone()],
    );
    put(
        &mut payload,
        "requiredOutputFormats",
        Value::Array(required_formats(&report_type)),
    );
    let mut result = Rec::new();
    put(&mut result, "reportType", value_string(report_type));
    put(
        &mut result,
        "subjectType",
        value_string(if case_id.is_some() {
            "AML_CASE".to_owned()
        } else {
            "REPORTING_RULE".to_owned()
        }),
    );
    put(
        &mut result,
        "subjectId",
        value_string(case_id.clone().unwrap_or_else(|| reporting_rule_id.clone())),
    );
    put(&mut result, "payload", Value::Object(payload));
    if let Some(case_id) = &case_id {
        put(&mut result, "amlCaseId", value_string(case_id.clone()));
    }
    if let Some(authority) = s(body, "authority") {
        put(
            &mut result,
            "authority",
            value_string(clamp(&authority, 64)),
        );
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* -------------------------------------------------------------------------------- rails */

fn rail_collection_mode(value: Option<String>) -> Option<&'static str> {
    let mode = value?.trim().to_uppercase();
    Some(match mode.as_str() {
        "OTP_PULL" => "OTP_PULL",
        "REDIRECT" => "REDIRECT",
        "EMBEDDED" => "EMBEDDED",
        "PUSH_APPROVAL" | "PUSH" => "PUSH_APPROVAL",
        "QR_DISPLAY" | "QR" => "QR_DISPLAY",
        "PAY_CODE" | "CASH" => "PAY_CODE",
        "DEEP_LINK" => "DEEP_LINK",
        "MANUAL" | "TRANSFER" => "MANUAL",
        "HYBRID" => "HYBRID",
        _ => return None,
    })
}

fn capabilities_record(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(value) if is_record(value) => Some(value.clone()),
        Some(Value::Array(entries)) => {
            let mut record = Rec::new();
            for entry in entries {
                if let Some(entry) = entry.as_str() {
                    record.insert(clamp(entry, 40), Value::Bool(true));
                }
            }
            Some(Value::Object(record))
        }
        _ => None,
    }
}

pub fn to_core_rail_create(body: &Value) -> EdgeResult<Value> {
    let name = clamp(&non_empty(s(body, "name"), "rail"), 160);
    let name_ar = clamp(&non_empty(s(body, "nameAr"), &name), 160);
    let name_en = clamp(&non_empty(s(body, "nameEn"), &name), 160);
    let Some(mode) = rail_collection_mode(s(body, "collectionMode")) else {
        return Err(missing_canonical("collectionMode"));
    };
    let mut result = Rec::new();
    put(
        &mut result,
        "code",
        value_string(s(body, "code").unwrap_or_default().trim().to_lowercase()),
    );
    put(&mut result, "nameAr", value_string(name_ar));
    put(&mut result, "nameEn", value_string(name_en));
    put(&mut result, "collectionMode", value_string(mode.to_owned()));
    let sub_modes: Vec<Value> = strings(body, "subModes")
        .into_iter()
        .take(20)
        .map(Value::String)
        .collect();
    if !sub_modes.is_empty() {
        put(&mut result, "subModes", Value::Array(sub_modes));
    }
    if let Some(currency) = s(body, "currency").filter(|value| value.len() == 3) {
        put(
            &mut result,
            "currency",
            value_string(currency.to_uppercase()),
        );
    }
    for key in ["minAmount", "maxAmount"] {
        if let Some(value) = s(body, key).filter(|value| is_decimal(value)) {
            put(&mut result, key, value_string(value));
        }
    }
    if let Some(capabilities) = capabilities_record(body.get("capabilities")) {
        if capabilities.as_object().is_some_and(|map| !map.is_empty()) {
            put(&mut result, "capabilities", capabilities);
        }
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_rail_update(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    let name = s(body, "name")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let name_ar = s(body, "nameAr")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let name_en = s(body, "nameEn")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(name_ar) = &name_ar {
        put(&mut result, "nameAr", value_string(clamp(name_ar, 160)));
    }
    if let Some(name_en) = &name_en {
        put(&mut result, "nameEn", value_string(clamp(name_en, 160)));
    }
    if let Some(name) = &name {
        if name_ar.is_none() && name_en.is_none() {
            put(&mut result, "nameAr", value_string(clamp(name, 160)));
            put(&mut result, "nameEn", value_string(clamp(name, 160)));
        }
    }
    if let Some(active) = b(body, "active") {
        put(&mut result, "blocked", Value::Bool(!active));
    }
    for key in ["minAmount", "maxAmount", "instructionsAr", "instructionsEn"] {
        if let Some(value) = s(body, key) {
            put(
                &mut result,
                key,
                value_string(clamp(
                    &value,
                    if key.starts_with("instructions") {
                        2000
                    } else {
                        40
                    },
                )),
            );
        }
    }
    if let Some(order) = clamp_number(body.get("displayOrder"), 0, 9999) {
        put(&mut result, "displayOrder", json!(order));
    }
    if let Some(capabilities) = capabilities_record(body.get("capabilities")) {
        if capabilities.as_object().is_some_and(|map| !map.is_empty()) {
            put(&mut result, "capabilities", capabilities);
        }
    }
    match body.get("logoAssetId") {
        Some(Value::Null) => {
            put(&mut result, "logoAssetId", Value::Null);
        }
        Some(Value::String(value)) if !value.is_empty() => {
            put(&mut result, "logoAssetId", value_string(value.clone()));
        }
        _ => {}
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

fn rail_field_type(value: Option<String>) -> &'static str {
    let upper = value.unwrap_or_default().trim().to_uppercase();
    match upper.as_str() {
        "NUMBER" | "NUMERIC" => "number",
        "PHONE" => "phone",
        "OTP" => "otp",
        "WALLET_ID" => "wallet_id",
        "SELECT" | "FROM_LIST" => "from_list",
        "TEXT" | "STRING" | "NATIONAL_ID" | "PASSPORT" | "DATE" | "HIDDEN" => "string",
        _ => "string",
    }
}

fn rail_normalizer(value: Option<String>) -> Option<&'static str> {
    let upper = value?.trim().to_uppercase();
    Some(match upper.as_str() {
        "ARABIC_DIGITS_TO_ASCII" => "arabic_digits_to_ascii",
        "PHONE_NORMALIZE_LOCAL_09" => "phone_normalize_local_09",
        "PHONE_NORMALIZE_INTL_218" => "phone_normalize_intl_218",
        "PHONE_NORMALIZE_E164" => "phone_normalize_e164",
        _ => return None,
    })
}

fn to_core_field_key(value: Option<String>) -> String {
    let raw = value.unwrap_or_default().to_lowercase();
    let mut key = String::with_capacity(raw.len());
    let mut last_underscore = false;
    for character in raw.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
            key.push(character);
            last_underscore = character == '_';
        } else if !last_underscore {
            key.push('_');
            last_underscore = true;
        }
    }
    let key = key.trim_matches('_').to_owned();
    let key = clamp(&key, 64);
    if key.is_empty() {
        "field".to_owned()
    } else {
        key
    }
}

pub fn to_core_rail_fields(body: &Value) -> EdgeResult<Value> {
    let fields: Vec<Value> = a(body, "fields")
        .into_iter()
        .filter(|field| field.is_object())
        .take(40)
        .enumerate()
        .map(|(index, field)| {
            let key = to_core_field_key(
                s(&field, "code")
                    .or_else(|| s(&field, "key"))
                    .or_else(|| s(&field, "fieldKey")),
            );
            let label_en = clamp(
                &non_empty(s(&field, "labelEn").or_else(|| s(&field, "label")), &key),
                200,
            );
            let label_ar = clamp(
                &non_empty(
                    s(&field, "labelAr").or_else(|| s(&field, "label")),
                    &label_en,
                ),
                200,
            );
            let mut result = Rec::new();
            put(&mut result, "key", value_string(key));
            put(
                &mut result,
                "type",
                value_string(
                    rail_field_type(s(&field, "type").or_else(|| s(&field, "inputType")))
                        .to_owned(),
                ),
            );
            put(&mut result, "labelAr", value_string(label_ar));
            put(&mut result, "labelEn", value_string(label_en));
            put(
                &mut result,
                "orderIndex",
                json!(clamp_number(
                    field.get("orderIndex").or_else(|| field.get("order")),
                    0,
                    999
                )
                .unwrap_or(index as i64)),
            );
            if let Some(required) = b(&field, "required") {
                put(&mut result, "required", Value::Bool(required));
            }
            let sensitivity = s(&field, "sensitivity")
                .unwrap_or_default()
                .trim()
                .to_uppercase();
            if sensitivity == "SENSITIVE" || sensitivity == "PAN" {
                put(&mut result, "sensitivity", value_string(sensitivity));
            } else if b(&field, "sensitive") == Some(true) {
                put(
                    &mut result,
                    "sensitivity",
                    value_string("SENSITIVE".to_owned()),
                );
            }
            if let Some(pattern) = s(&field, "pattern").or_else(|| s(&field, "regex")) {
                put(&mut result, "regex", value_string(clamp(&pattern, 200)));
            }
            if let Some(value) = clamp_number(field.get("minLength"), 0, 64) {
                put(&mut result, "minLength", json!(value));
            }
            if let Some(value) = clamp_number(field.get("maxLength"), 0, 64) {
                put(&mut result, "maxLength", json!(value));
            }
            if let Some(normalizer) = rail_normalizer(s(&field, "normalizer")) {
                put(&mut result, "normalizer", json!({ "type": normalizer }));
            }
            let options: Vec<Value> = strings(&field, "options")
                .into_iter()
                .take(100)
                .map(Value::String)
                .collect();
            if !options.is_empty() {
                put(&mut result, "optionsJson", json!({ "options": options }));
            }
            Value::Object(result)
        })
        .collect();
    let mut result = Rec::new();
    put(&mut result, "fields", Value::Array(fields));
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ------------------------------------------------------------------------------- routes */

const CREDENTIAL_POLICIES: &[&str] = &["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"];

pub fn to_core_route_create(body: &Value) -> EdgeResult<Value> {
    let Some(policy) = pick_enum(body.get("credentialPolicy"), CREDENTIAL_POLICIES) else {
        return Err(missing_canonical("credentialPolicy"));
    };
    let mut result = Rec::new();
    put(
        &mut result,
        "railId",
        value_string(require_canonical(s(body, "railId"), "railId", 1)?),
    );
    put(
        &mut result,
        "gatewayId",
        value_string(require_canonical(s(body, "gatewayId"), "gatewayId", 1)?),
    );
    put(
        &mut result,
        "credentialPolicy",
        value_string(policy.to_owned()),
    );
    if let Some(priority) = clamp_number(body.get("priority"), 0, 9999) {
        put(&mut result, "priority", json!(priority));
    }
    let cost_model = rec(body, "costModel");
    if !cost_model.is_empty() {
        put(&mut result, "costModel", Value::Object(cost_model));
    }
    if let Some(limit) = s(body, "limitAmount").filter(|value| is_decimal(value)) {
        put(&mut result, "maxAmount", value_string(limit));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_route_update(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    if let Some(priority) = clamp_number(body.get("priority"), 0, 9999) {
        put(&mut result, "priority", json!(priority));
    }
    if let Some(weight) = clamp_number(body.get("weight"), 1, 1000) {
        put(&mut result, "weight", json!(weight));
    }
    let cost_model = rec(body, "costModel");
    if !cost_model.is_empty() {
        put(&mut result, "costModel", Value::Object(cost_model));
    }
    let scope = rec(body, "scope");
    if !scope.is_empty() {
        put(&mut result, "scope", Value::Object(scope));
    }
    if let Some(policy) = body.get("mismatchPolicy").filter(|value| is_record(value)) {
        put(&mut result, "mismatchPolicy", policy.clone());
    }
    if let Some(windows) = body.get("maintenanceWindows").and_then(Value::as_array) {
        let windows: Vec<Value> = windows
            .iter()
            .filter(|entry| entry.is_object())
            .take(50)
            .cloned()
            .collect();
        put(&mut result, "maintenanceWindows", Value::Array(windows));
    }
    for key in ["minAmount", "maxAmount", "dailyCapAmount"] {
        if let Some(value) = s(body, key).filter(|value| is_decimal(value)) {
            put(&mut result, key, value_string(value));
        }
    }
    if let Some(limit) = s(body, "limitAmount").filter(|value| is_decimal(value)) {
        put(&mut result, "maxAmount", value_string(limit));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_route_state(body: &Value) -> EdgeResult<Value> {
    let Some(status) = pick_enum(
        body.get("status").or_else(|| body.get("state")),
        &["ACTIVE", "PAUSED", "DRAINING"],
    ) else {
        return Err(missing_canonical("status"));
    };
    let mut result = Rec::new();
    put(&mut result, "status", value_string(status.to_owned()));
    if let Some(reason) = s(body, "reason").filter(|value| !value.is_empty()) {
        put(&mut result, "reason", value_string(clamp(&reason, 500)));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ------------------------------------------------------------------------------- assets */

const ASSET_MIMES: &[&str] = &["image/png", "image/svg+xml"];

fn asset_mime(value: Option<String>) -> Option<&'static str> {
    let mime = value?
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    ASSET_MIMES.iter().find(|entry| **entry == mime).copied()
}

pub fn to_core_asset_create(body: &Value) -> EdgeResult<Value> {
    let Some(mime) = asset_mime(s(body, "contentType")) else {
        return Err(missing_canonical("mime"));
    };
    let Some(size) = clamp_number(body.get("sizeBytes"), 1, 2_000_000) else {
        return Err(missing_canonical("sizeBytes"));
    };
    let sha256 = s(body, "checksumSha256")
        .or_else(|| s(body, "sha256"))
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if !crate::schema::regex_match(r"^[a-f0-9]{64}$", &sha256) {
        return Err(missing_canonical("sha256"));
    }
    Ok(json!({
        "name": clamp(&non_empty(s(body, "name"), "asset"), 120),
        "mime": mime,
        "sizeBytes": size,
        "storageKey": clamp(&non_empty(s(body, "storageKey"), "asset"), 300),
        "sha256": sha256,
    }))
}

/* ---------------------------------------------------------------------- operator cases */

pub fn to_core_operator_case_resolve(body: &Value) -> EdgeResult<Value> {
    let Some(action) = pick_enum(
        body.get("action"),
        &["MARK_SUCCEEDED", "MARK_FAILED", "CLOSE_CASE"],
    ) else {
        return Err(missing_canonical("action"));
    };
    let mut result = Rec::new();
    put(&mut result, "action", value_string(action.to_owned()));
    put(
        &mut result,
        "reason",
        value_string(require_canonical(s(body, "reason"), "reason", 3)?),
    );
    if let Some(notes) = s(body, "notes") {
        put(&mut result, "notes", value_string(clamp(&notes, 2000)));
    }
    if let Some(reference) = s(body, "providerReference").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "providerReference",
            value_string(clamp(&reference, 191)),
        );
    }
    if let Some(amount) = s(body, "settledAmount").filter(|value| !value.is_empty()) {
        put(&mut result, "settledAmount", value_string(amount));
    }
    if let Some(code) = s(body, "resolutionCode").filter(|value| !value.is_empty()) {
        put(&mut result, "resolutionCode", value_string(code));
    }
    if let Some(reference) = s(body, "reference").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "reference",
            value_string(clamp(&reference, 191)),
        );
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ---------------------------------------------------------------------------- reconciliation */

const STATEMENT_SOURCE_TYPES: &[&str] = &["API", "SFTP", "UPLOAD"];

fn parser_config(source: &Value) -> Value {
    let mut config = Rec::new();
    if let Some(file_type) = s(source, "fileType") {
        put(&mut config, "fileType", value_string(file_type));
    }
    if let Some(delimiter) = s(source, "delimiter") {
        put(&mut config, "delimiter", value_string(delimiter));
    }
    if let Some(has_header) = b(source, "hasHeader") {
        put(&mut config, "hasHeader", Value::Bool(has_header));
    }
    let mapping = rec(source, "columnMapping");
    if !mapping.is_empty() {
        put(&mut config, "columnMapping", Value::Object(mapping));
    }
    if let Some(date_format) = s(source, "dateFormat") {
        put(&mut config, "dateFormat", value_string(date_format));
    }
    if let Some(currency) = s(source, "currency") {
        put(
            &mut config,
            "currency",
            value_string(currency.to_uppercase()),
        );
    }
    Value::Object(config)
}

pub fn to_core_reconciliation_source_create(body: &Value) -> EdgeResult<Value> {
    let Some(source_type) = pick_enum(body.get("type"), STATEMENT_SOURCE_TYPES) else {
        return Err(missing_canonical("type"));
    };
    let mut result = Rec::new();
    put(
        &mut result,
        "gatewayId",
        value_string(require_canonical(s(body, "gatewayId"), "gatewayId", 1)?),
    );
    put(&mut result, "type", value_string(source_type.to_owned()));
    put(&mut result, "parserConfig", parser_config(body));
    if let Some(cron) = s(body, "scheduleCron").filter(|value| !value.is_empty()) {
        put(&mut result, "scheduleCron", value_string(clamp(&cron, 120)));
    }
    if let Some(lag) = clamp_number(body.get("settlementLagDays"), 0, 365) {
        put(&mut result, "settlementLagDays", json!(lag));
    }
    if let Some(template) = s(body, "dedupeKeyTemplate").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "dedupeKeyTemplate",
            value_string(clamp(&template, 200)),
        );
    }
    if let Some(currency) = s(body, "currency").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "currency",
            value_string(currency.to_uppercase()),
        );
    }
    if let Some(env) = s(body, "env").filter(|value| !value.is_empty()) {
        put(&mut result, "env", value_string(clamp(&env, 16)));
    }
    if let Some(credential) = s(body, "credentialSetId").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "credentialSetId",
            value_string(require_canonical(Some(credential), "credentialSetId", 1)?),
        );
    }
    Ok(Value::Object(result))
}

pub fn to_core_reconciliation_upload(body: &Value) -> EdgeResult<Value> {
    let mut result = Rec::new();
    put(
        &mut result,
        "sourceId",
        value_string(require_canonical(s(body, "sourceId"), "sourceId", 1)?),
    );
    if let Some(value) = s(body, "periodStart").filter(|value| !value.is_empty()) {
        put(&mut result, "periodStart", value_string(clamp(&value, 64)));
    }
    if let Some(value) = s(body, "periodEnd").filter(|value| !value.is_empty()) {
        put(&mut result, "periodEnd", value_string(clamp(&value, 64)));
    }
    if let Some(currency) = s(body, "currency").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "currency",
            value_string(currency.to_uppercase()),
        );
    }
    if let Some(auto_post) = b(body, "autoPost") {
        put(&mut result, "autoPost", Value::Bool(auto_post));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ------------------------------------------------------------ disputes and adjustments */

const DISPUTE_SOURCES: &[&str] = &["WEBHOOK", "STATEMENT", "MANUAL"];

pub fn to_core_dispute_create(body: &Value) -> EdgeResult<Value> {
    let amount = s(body, "amount");
    let currency = s(body, "currency");
    let Some(source) = pick_enum(body.get("source"), DISPUTE_SOURCES) else {
        return Err(missing_canonical("source"));
    };
    let amount = amount
        .filter(|value| is_decimal(value))
        .ok_or_else(|| missing_canonical("amount"))?;
    let currency = currency
        .filter(|value| value.len() == 3)
        .map(|value| value.to_uppercase())
        .ok_or_else(|| missing_canonical("currency"))?;
    let mut result = Rec::new();
    put(
        &mut result,
        "attemptId",
        value_string(require_canonical(
            s(body, "paymentReference"),
            "attemptId",
            1,
        )?),
    );
    put(
        &mut result,
        "gatewayId",
        value_string(require_canonical(s(body, "gatewayId"), "gatewayId", 1)?),
    );
    put(
        &mut result,
        "railId",
        value_string(require_canonical(s(body, "railId"), "railId", 1)?),
    );
    put(
        &mut result,
        "externalDisputeRef",
        value_string(require_canonical(
            s(body, "externalDisputeRef"),
            "externalDisputeRef",
            2,
        )?),
    );
    put(&mut result, "source", value_string(source.to_owned()));
    put(&mut result, "amount", value_string(amount));
    put(&mut result, "currency", value_string(currency));
    if let Some(reason) = s(body, "reason").filter(|value| !value.is_empty()) {
        put(&mut result, "reasonCode", value_string(clamp(&reason, 80)));
    }
    Ok(Value::Object(result))
}

fn adjustment_type(value: Option<String>) -> Option<&'static str> {
    Some(match value?.trim().to_uppercase().as_str() {
        "CHARGEBACK" => "CHARGEBACK",
        "REFUND" => "REFUND",
        "MANUAL_CREDIT" | "RECOVERY" => "MANUAL_CREDIT",
        "MANUAL_DEBIT" | "WRITEOFF" => "MANUAL_DEBIT",
        "CORRECTION" | "FEE_VARIANCE" => "CORRECTION",
        _ => return None,
    })
}

pub fn to_core_adjustment_create(body: &Value) -> EdgeResult<Value> {
    let Some(kind) = adjustment_type(s(body, "type")) else {
        return Err(missing_canonical("type"));
    };
    let amount = s(body, "amount")
        .filter(|value| is_decimal(value))
        .ok_or_else(|| missing_canonical("amount"))?;
    let reason = s(body, "reason")
        .or_else(|| s(body, "reasonCode"))
        .unwrap_or_default()
        .trim()
        .to_owned();
    if reason.chars().count() < 2 {
        return Err(missing_canonical("reason"));
    }
    let mut result = Rec::new();
    put(&mut result, "type", value_string(kind.to_owned()));
    put(
        &mut result,
        "targetGlAccountId",
        value_string(require_canonical(
            s(body, "targetGlAccountId"),
            "targetGlAccountId",
            1,
        )?),
    );
    put(&mut result, "amount", value_string(amount));
    put(&mut result, "reason", value_string(clamp(&reason, 1000)));
    if let Some(dispute_id) = s(body, "disputeId").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "disputeId",
            value_string(clamp(&dispute_id, 64)),
        );
    }
    if let Some(attempt) = s(body, "attemptId").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "sourceAttemptId",
            value_string(clamp(&attempt, 64)),
        );
    }
    if let Some(reference) = s(body, "externalDisputeRef").filter(|value| !value.is_empty()) {
        put(
            &mut result,
            "externalDisputeRef",
            value_string(clamp(&reference, 120)),
        );
    }
    if let Some(reverse) = b(body, "reverseCommission") {
        put(&mut result, "reverseCommission", Value::Bool(reverse));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

pub fn to_core_cashout_process(body: &Value) -> EdgeResult<Value> {
    let decision = s(body, "decision")
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    if decision != "APPROVE" && decision != "REJECT" {
        return Err(ApiError::new(
            400,
            "UNSUPPORTED_DECISION",
            "Core only supports the APPROVE and REJECT cash-out decisions",
        )
        .with_details(json!({ "decision": if decision.is_empty() { Value::Null } else { Value::String(decision) } })));
    }
    let mut result = Rec::new();
    put(&mut result, "decision", value_string(decision));
    if let Some(reason) = s(body, "reason").filter(|value| !value.is_empty()) {
        put(&mut result, "reason", value_string(clamp(&reason, 1000)));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ------------------------------------------------------- commission and velocity rules */

fn commission_calc_type(value: Option<String>) -> Option<&'static str> {
    Some(match value?.trim().to_uppercase().as_str() {
        "FLAT" => "FLAT",
        "PERCENTAGE" => "PERCENTAGE",
        "TIERED" => "TIERED",
        "MIXED" => "HYBRID",
        _ => return None,
    })
}

pub fn to_core_commission_profile_create(body: &Value) -> EdgeResult<Value> {
    let Some(calc_type) = commission_calc_type(s(body, "model")) else {
        return Err(missing_canonical("calcType"));
    };
    let mut result = Rec::new();
    put(
        &mut result,
        "railCode",
        value_string(require_canonical(s(body, "railCode"), "railCode", 1)?),
    );
    put(&mut result, "calcType", value_string(calc_type.to_owned()));
    if let Some(flat) = s(body, "flatAmount").filter(|value| is_decimal(value)) {
        put(&mut result, "flatFee", value_string(flat));
    }
    if let Some(percentage) = s(body, "percentage").filter(|value| is_percentage(value)) {
        put(&mut result, "percentageRate", value_string(percentage));
    }
    let tiers: Vec<Value> = a(body, "tiers")
        .into_iter()
        .filter(|entry| entry.is_object())
        .take(20)
        .collect();
    if !tiers.is_empty() {
        put(&mut result, "tiersJson", Value::Array(tiers));
    }
    if let Some(value) = s(body, "minFee").filter(|value| is_decimal(value)) {
        put(&mut result, "minFee", value_string(value));
    }
    if let Some(value) = s(body, "maxFee").filter(|value| is_decimal(value)) {
        put(&mut result, "maxFee", value_string(value));
    }
    if let Some(value) = s(body, "feeBearerDefault").filter(|value| !value.is_empty()) {
        put(&mut result, "feeBearerDefault", value_string(value));
    }
    if let Some(value) = s(body, "roundingMode").filter(|value| !value.is_empty()) {
        put(&mut result, "roundingMode", value_string(value));
    }
    if let Some(value) = s(body, "merchantId").filter(|value| !value.is_empty()) {
        put(&mut result, "merchantId", value_string(value));
    }
    if let Some(value) = s(body, "applicationId").filter(|value| !value.is_empty()) {
        put(&mut result, "applicationId", value_string(value));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

const VELOCITY_SCOPE_TYPES: &[&str] = &[
    "END_CLIENT_IP",
    "END_CLIENT_PHONE",
    "END_CLIENT_CARD",
    "MERCHANT",
    "APPLICATION",
    "RAIL",
    "LINK",
];

fn velocity_scope_type(value: Option<String>) -> Option<&'static str> {
    Some(match value?.trim().to_uppercase().as_str() {
        "MERCHANT" => "MERCHANT",
        "APPLICATION" => "APPLICATION",
        "LINK" => "LINK",
        "IP" => "END_CLIENT_IP",
        _ => return None,
    })
}

fn velocity_action(value: Option<String>) -> Option<&'static str> {
    Some(match value?.trim().to_uppercase().as_str() {
        "BLOCK" => "REJECT",
        "REVIEW" | "THROTTLE" | "CHALLENGE" => "FLAG",
        _ => return None,
    })
}

pub fn to_core_velocity_rule_create(body: &Value) -> EdgeResult<Value> {
    let scope = s(body, "scope").unwrap_or_default().trim().to_uppercase();
    let scope_type = pick_enum(body.get("scopeType"), VELOCITY_SCOPE_TYPES)
        .or_else(|| velocity_scope_type(Some(scope)))
        .ok_or_else(|| missing_canonical("scopeType"))?;
    let window = clamp_number(body.get("windowSeconds"), 1, 31_536_000)
        .ok_or_else(|| missing_canonical("windowSeconds"))?;
    let max_count = clamp_number(body.get("maxAttempts"), 1, 1_000_000)
        .ok_or_else(|| missing_canonical("maxCount"))?;
    let action = velocity_action(s(body, "action")).ok_or_else(|| missing_canonical("action"))?;
    let mut result = Rec::new();
    put(
        &mut result,
        "scopeType",
        value_string(scope_type.to_owned()),
    );
    put(&mut result, "windowSeconds", json!(window));
    put(&mut result, "maxCount", json!(max_count));
    put(&mut result, "action", value_string(action.to_owned()));
    if let Some(amount) = s(body, "maxAmount").filter(|value| is_decimal(value)) {
        put(&mut result, "maxAmount", value_string(amount));
    }
    insert_checklist(&mut result, body);
    Ok(Value::Object(result))
}

/* ------------------------------------------------------------------------------ settings */

fn setting_value(value: &Value) -> Value {
    let Some(map) = value.as_object() else {
        return json!({ "value": value });
    };
    if map.keys().any(|key| key.chars().count() > 64) {
        return json!({ "value": value });
    }
    value.clone()
}

pub fn to_core_settings_update(body: &Value) -> EdgeResult<Value> {
    let settings = rec(body, "settings");
    let mut entries: Vec<Value> = Vec::new();
    for (key, value) in &settings {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            continue;
        }
        entries.push(json!({
            "key": clamp(trimmed, 120),
            "valueJson": setting_value(value),
        }));
        if entries.len() >= 50 {
            break;
        }
    }
    if entries.is_empty() {
        return Err(missing_canonical("settings"));
    }
    let mut result = Rec::new();
    put(&mut result, "settings", Value::Array(entries));
    insert_checklist(&mut result, body);
    if let Some(reason) = s(body, "reason") {
        let trimmed = reason.trim();
        if trimmed.chars().count() >= 3 {
            put(&mut result, "reason", value_string(clamp(trimmed, 500)));
        }
    }
    Ok(Value::Object(result))
}

/// Keep the `Number` import used by the crate (money never becomes `f64` on the wire).
#[allow(dead_code)]
fn _number_guard() -> Number {
    Number::from(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_create_supplies_required_core_fields() {
        let value =
            to_core_gateway_create(&json!({"code":" Edfali ","name":"Edfali","category":"bank"}))
                .expect("map");
        assert_eq!(value["code"], "edfali");
        assert_eq!(value["operator"], "bank");
        assert_eq!(value["kind"], "DIRECT");
    }

    #[test]
    fn gateway_environments_resolves_hosts_and_dedupes() {
        let value = to_core_gateway_version_environments(&json!({
            "environments":[
                {"code":"api","env":"prod","baseUrl":"https://api.example.com/v1","enabled":false},
                {"code":"api2","env":"test","baseUrl":"https://sandbox.example.com"}
            ]
        }))
        .expect("map");
        assert_eq!(value["env"], "LIVE");
        assert_eq!(value["baseUrls"]["api"], "https://api.example.com/v1");
        assert_eq!(value["allowedHosts"], json!(["api.example.com"]));
        assert_eq!(value["enabled"], false);
    }

    #[test]
    fn gateway_settings_defaults_and_clamps() {
        let value = to_core_gateway_version_settings(&json!({
            "settings":{"amountScale":100,"otpTtlSeconds":99999,"supportsCancel":true},
            "timeoutMs":500
        }))
        .expect("map");
        assert_eq!(value["amountScale"], 100);
        assert_eq!(value["otpTtlSeconds"], 3600);
        assert_eq!(value["timeoutMs"], 1000);
        assert_eq!(value["amountPrecision"], 2);
        assert_eq!(value["supportsCancel"], true);
    }

    #[test]
    fn gateway_flows_split_steps_by_phase_and_generate_tokens() {
        let value = to_core_gateway_version_flows(&json!({
            "flows":[{"phases":["INITIATE","VERIFY"],"steps":[
                {"type":"HTTP","method":"POST","url":"https://x"},
                {"type":"ASSERT","phase":"verify"}
            ]}]
        }))
        .expect("map");
        assert_eq!(value["flows"].as_array().map(Vec::len), Some(2));
        assert_eq!(value["flows"][0]["steps"].as_array().map(Vec::len), Some(1));
        let channels = to_core_gateway_version_channels(&json!({
            "confirmationChannels":[{"type":"RETURN_URL"}],
            "pollPolicies":[{"kind":"POLL"}]
        }))
        .expect("map");
        assert_eq!(channels["channels"][0]["verifyMethod"], "SHARED_TOKEN");
        assert_eq!(channels["channels"][0]["mustInquire"], true);
        assert_eq!(channels["channels"][1]["type"], "POLL");
        assert_eq!(
            channels["channels"][1]["pathToken"].as_str().map(str::len),
            Some(32)
        );
    }

    #[test]
    fn user_create_never_forwards_phone_or_password() {
        let value = to_core_user_create(&json!({
            "email":"A@B.CO","password":"hunter22","phone":"+218900",
            "role":"operator","authorities":{"security":["read","write"]}
        }))
        .expect("map");
        assert_eq!(value["email"], "a@b.co");
        assert_eq!(value["role"], "OPERATOR");
        assert_eq!(
            value["authoritiesMap"],
            json!(["security:read", "security:write"])
        );
        assert!(value.get("password").is_none());
        assert!(value.get("phone").is_none());
    }

    #[test]
    fn unsupported_decisions_keep_the_ts_error() {
        let error =
            to_core_join_request_decide(&json!({"decision":"REQUEST_INFO"})).expect_err("error");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "UNSUPPORTED_DECISION");
        let error = to_core_cashout_process(&json!({"decision":"HOLD"})).expect_err("error");
        assert_eq!(error.code, "UNSUPPORTED_DECISION");
    }

    #[test]
    fn merchant_suspend_maps_unknown_reason_to_other_and_keeps_text() {
        let value = to_core_merchant_suspend(&json!({"reason":"something strange"})).expect("map");
        assert_eq!(value["reasonCode"], "OTHER");
        assert_eq!(value["notes"], "something strange");
    }

    #[test]
    fn rail_create_requires_collection_mode() {
        let error =
            to_core_rail_create(&json!({"code":"x","collectionMode":"WAT"})).expect_err("error");
        assert_eq!(error.code, "VALIDATION_FAILED");
        assert_eq!(
            error
                .details
                .as_ref()
                .map(|details| details["path"][0].clone()),
            Some(json!("collectionMode"))
        );
    }

    #[test]
    fn rail_fields_normalise_keys_and_capabilities() {
        let value = to_core_rail_fields(&json!({
            "fields":[{"code":"Phone Number!","type":"PHONE","label":"Phone","normalizer":"phone_normalize_e164","options":["a"]}]
        }))
        .expect("map");
        assert_eq!(value["fields"][0]["key"], "phone_number");
        assert_eq!(value["fields"][0]["type"], "phone");
        assert_eq!(
            value["fields"][0]["normalizer"]["type"],
            "phone_normalize_e164"
        );
        assert_eq!(value["fields"][0]["optionsJson"]["options"], json!(["a"]));
    }

    #[test]
    fn commission_tiers_are_an_array_and_mixed_maps_to_hybrid() {
        let value = to_core_commission_profile_create(&json!({
            "railCode":"edfali","model":"mixed","tiers":[{"from":"0","to":"10","rate":"1"}]
        }))
        .expect("map");
        assert_eq!(value["calcType"], "HYBRID");
        assert!(value["tiersJson"].is_array());
    }

    #[test]
    fn velocity_rule_requires_every_canonical_field() {
        let value = to_core_velocity_rule_create(&json!({
            "scope":"IP","scopeType":"END_CLIENT_IP","windowSeconds":60,"maxAttempts":5,"action":"BLOCK"
        }))
        .expect("map");
        assert_eq!(value["action"], "REJECT");
        let error = to_core_velocity_rule_create(
            &json!({"scope":"DEVICE","windowSeconds":60,"maxAttempts":5,"action":"BLOCK"}),
        )
        .expect_err("error");
        assert_eq!(error.details.unwrap()["path"][0], "scopeType");
    }

    #[test]
    fn settings_update_wraps_non_objects_and_caps_entries() {
        let value = to_core_settings_update(
            &json!({"settings":{"a":1,"b":{"x":true}},"reason":" a reason "}),
        )
        .expect("map");
        assert_eq!(value["settings"][0]["valueJson"], json!({"value":1}));
        assert_eq!(value["settings"][1]["valueJson"], json!({"x":true}));
        assert_eq!(value["reason"], "a reason");
    }
}
