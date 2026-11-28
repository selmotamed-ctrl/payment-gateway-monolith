//! Checkout request validation.
//!
//! Port of the zod schemas in `checkout-back/api/public/{pay,inbound,return,certificate}.ts` and
//! the shared primitives in `checkout-back/lib/zReady/index.ts`.
//!
//! The edge reports `400 VALIDATION_FAILED` with the zod-shaped issue list
//! (`{code, path, message}` and `keys` for `unrecognized_keys`). Message text is best effort, the
//! `code` and `path` are the contract (chapter 2 §4).

#![forbid(unsafe_code)]

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::error::EdgeFailure;

/// One zod-shaped validation issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub code: &'static str,
    pub path: Vec<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
}

impl Issue {
    fn new(code: &'static str, path: &[&str], message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.iter().map(|part| (*part).to_owned()).collect(),
            message: message.into(),
            keys: None,
        }
    }

    fn nested(code: &'static str, path: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path,
            message: message.into(),
            keys: None,
        }
    }

    fn unrecognized(keys: Vec<String>) -> Self {
        let message = if keys.len() == 1 {
            format!("Unrecognized key: \"{}\"", keys[0])
        } else {
            format!(
                "Unrecognized keys: {}",
                keys.iter()
                    .map(|key| format!("\"{key}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        Self {
            code: "unrecognized_keys",
            path: Vec::new(),
            message,
            keys: Some(keys),
        }
    }
}

fn failed(issues: Vec<Issue>) -> EdgeFailure {
    EdgeFailure::validation(
        serde_json::to_value(issues).unwrap_or_else(|_| Value::Array(Vec::new())),
    )
}

fn single(issue: Issue) -> EdgeFailure {
    failed(vec![issue])
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn invalid_type(path: &[&str], expected: &str, received: &Value) -> Issue {
    Issue::new(
        "invalid_type",
        path,
        format!(
            "Invalid input: expected {expected}, received {}",
            json_type_name(received)
        ),
    )
}

fn missing_type(path: &[&str], expected: &str) -> Issue {
    Issue::new(
        "invalid_type",
        path,
        format!("Invalid input: expected {expected}, received undefined"),
    )
}

fn too_small(path: &[&str], minimum: usize) -> Issue {
    Issue::new(
        "too_small",
        path,
        format!("Too small: expected string to have >= {minimum} characters"),
    )
}

fn too_big(path: &[&str], maximum: usize) -> Issue {
    Issue::new(
        "too_big",
        path,
        format!("Too big: expected string to have <= {maximum} characters"),
    )
}

fn invalid_format(path: &[&str], message: &str) -> Issue {
    Issue::new("invalid_format", path, message)
}

fn invalid_enum(path: &[&str], options: &[&str]) -> Issue {
    Issue::new(
        "invalid_value",
        path,
        format!(
            "Invalid option: expected one of {}",
            options
                .iter()
                .map(|option| format!("\"{option}\""))
                .collect::<Vec<_>>()
                .join("|")
        ),
    )
}

/// `strict_object`: the body must be a JSON object and every key must be known.
fn strict_object<'a>(
    body: Option<&'a Value>,
    known: &[&str],
) -> Result<&'a Map<String, Value>, Vec<Issue>> {
    let Some(body) = body else {
        return Err(vec![missing_type(&[], "object")]);
    };
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(&[], "object", body)]);
    };
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .cloned()
        .collect();
    if unknown.is_empty() {
        Ok(object)
    } else {
        Err(vec![Issue::unrecognized(unknown)])
    }
}

fn required_string(
    object: &Map<String, Value>,
    key: &str,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match object.get(key) {
        None => {
            issues.push(missing_type(&[key], "string"));
            None
        }
        Some(Value::String(value)) => Some(value.clone()),
        Some(other) => {
            issues.push(invalid_type(&[key], "string", other));
            None
        }
    }
}

fn check_charset(
    key: &str,
    value: &str,
    min: usize,
    max: usize,
    pattern: fn(&str) -> bool,
    pattern_message: &str,
    issues: &mut Vec<Issue>,
) {
    if value.chars().count() < min {
        issues.push(too_small(&[key], min));
        return;
    }
    if value.chars().count() > max {
        issues.push(too_big(&[key], max));
        return;
    }
    if !pattern(value) {
        issues.push(invalid_format(&[key], pattern_message));
    }
}

fn is_token_chars(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_idempotency_chars(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn is_otp(value: &str) -> bool {
    (4..=8).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_money4(value: &str) -> bool {
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some() {
        return false;
    }
    if whole.is_empty() || whole.len() > 14 || !whole.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    match fraction {
        None => true,
        Some(fraction) => {
            !fraction.is_empty()
                && fraction.len() <= 4
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

fn is_signed_money4(value: &str) -> bool {
    value
        .strip_prefix('-')
        .map_or_else(|| is_money4(value), is_money4)
}

fn validate_named(
    object: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
    pattern: fn(&str) -> bool,
    pattern_message: &str,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let value = required_string(object, key, issues)?;
    let before = issues.len();
    check_charset(key, &value, min, max, pattern, pattern_message, issues);
    (issues.len() == before).then_some(value)
}

/// `zLinkKey`: 6..64 of `[A-Za-z0-9_-]`.
pub fn validate_link_key(raw: &str) -> Result<String, EdgeFailure> {
    validate_token_param(
        raw,
        "linkKey",
        6,
        64,
        "link key is too short",
        "link key is too long",
    )
}

/// `zAttemptId`: 6..64 of `[A-Za-z0-9_-]`.
pub fn validate_attempt_id(raw: &str) -> Result<String, EdgeFailure> {
    validate_token_param(
        raw,
        "attemptId",
        6,
        64,
        "attempt id is too short",
        "attempt id is too long",
    )
}

/// `zAttemptToken`: 8..256 of `[A-Za-z0-9_-]`.
pub fn validate_attempt_token(raw: &str) -> Result<String, EdgeFailure> {
    validate_token_param(
        raw,
        "attemptToken",
        8,
        256,
        "attempt token is too short",
        "attempt token is too long",
    )
}

fn validate_token_param(
    raw: &str,
    path: &'static str,
    min: usize,
    max: usize,
    too_short: &'static str,
    too_long: &'static str,
) -> Result<String, EdgeFailure> {
    let length = raw.chars().count();
    if length < min {
        return Err(single(Issue::new("too_small", &[path], too_short)));
    }
    if length > max {
        return Err(single(Issue::new("too_big", &[path], too_long)));
    }
    if !is_token_chars(raw) {
        return Err(single(invalid_format(&[path], "invalid link key")));
    }
    Ok(raw.to_owned())
}

/// `paramsSchema` of the certificate route: 16..64 characters.
pub fn validate_public_id(raw: &str) -> Result<String, EdgeFailure> {
    let length = raw.chars().count();
    if length < 16 {
        return Err(single(too_small(&["publicId"], 16)));
    }
    if length > 64 {
        return Err(single(too_big(&["publicId"], 64)));
    }
    Ok(raw.to_owned())
}

/// `CLIENT_EVENTS`, copied verbatim.
pub const CLIENT_EVENTS: [&str; 4] = [
    "completeCallback",
    "errorCallback",
    "widgetEvent",
    "returnHint",
];

/// `translateClientEvent`: legacy aliases onto the canonical core event.
#[must_use]
pub fn translate_client_event(value: &str) -> Option<&'static str> {
    let normalized: String = value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    match normalized.as_str() {
        "completecallback" => Some("completeCallback"),
        "errorcallback" | "cancelcallback" => Some("errorCallback"),
        "widgetready" | "widgetclosed" | "widgetevent" => Some("widgetEvent"),
        "returnhint" => Some("returnHint"),
        _ => None,
    }
}

/// `initiateSchema` (strict).
pub fn parse_initiate(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(body, &["railCode", "subMode", "formData", "idempotencyKey"])
        .map_err(failed)?;
    let mut issues = Vec::new();
    let rail_code = validate_named(
        object,
        "railCode",
        1,
        64,
        is_token_chars,
        "invalid rail code",
        &mut issues,
    );
    let sub_mode = match object.get("subMode") {
        None => None,
        Some(Value::String(value)) => {
            let valid = (1..=64).contains(&value.chars().count()) && is_token_chars(value);
            if !valid {
                issues.push(invalid_format(&["subMode"], "Invalid string"));
                None
            } else {
                Some(value.clone())
            }
        }
        Some(other) => {
            issues.push(invalid_type(&["subMode"], "string", other));
            None
        }
    };
    let form_data = parse_form_data(object.get("formData"), &mut issues);
    let idempotency_key = validate_idempotency(object, "idempotencyKey", true, &mut issues);
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    output.insert(
        "railCode".to_owned(),
        Value::String(rail_code.unwrap_or_default()),
    );
    if let Some(sub_mode) = sub_mode {
        output.insert("subMode".to_owned(), Value::String(sub_mode));
    }
    output.insert(
        "formData".to_owned(),
        form_data.unwrap_or_else(|| json!({})),
    );
    output.insert(
        "idempotencyKey".to_owned(),
        Value::String(idempotency_key.unwrap_or_default()),
    );
    Ok(Value::Object(output))
}

fn validate_idempotency(
    object: &Map<String, Value>,
    key: &str,
    required: bool,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match object.get(key) {
        None if !required => None,
        None => {
            issues.push(missing_type(&[key], "string"));
            None
        }
        Some(Value::String(value)) => {
            let length = value.chars().count();
            if length < 8 {
                issues.push(Issue::new(
                    "too_small",
                    &[key],
                    "idempotency key is too short",
                ));
                None
            } else if length > 128 {
                issues.push(Issue::new("too_big", &[key], "idempotency key is too long"));
                None
            } else if !is_idempotency_chars(value) {
                issues.push(invalid_format(&[key], "invalid idempotency key"));
                None
            } else {
                Some(value.clone())
            }
        }
        Some(other) => {
            issues.push(invalid_type(&[key], "string", other));
            None
        }
    }
}

/// `zFormData`: string keys (<=128) to string (<=512) | number | boolean | null.
fn parse_form_data(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Value> {
    match value {
        None => None,
        Some(Value::Object(object)) => {
            let mut output = Map::new();
            for (key, entry) in object {
                if key.chars().count() > 128 {
                    issues.push(Issue::nested(
                        "too_big",
                        vec!["formData".to_owned(), key.clone()],
                        "Too big: expected string to have <= 128 characters",
                    ));
                    continue;
                }
                match entry {
                    Value::String(text) if text.chars().count() > 512 => {
                        issues.push(Issue::nested(
                            "too_big",
                            vec!["formData".to_owned(), key.clone()],
                            "Too big: expected string to have <= 512 characters",
                        ));
                    }
                    Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => {
                        output.insert(key.clone(), entry.clone());
                    }
                    other => {
                        issues.push(Issue::nested(
                            "invalid_type",
                            vec!["formData".to_owned(), key.clone()],
                            format!(
                                "Invalid input: expected string, number, boolean or null, received {}",
                                json_type_name(other)
                            ),
                        ));
                    }
                }
            }
            Some(Value::Object(output))
        }
        Some(other) => {
            issues.push(invalid_type(&["formData"], "object", other));
            None
        }
    }
}

/// `evidence` / `payload`: a record with keys <=64 and any value.
fn parse_evidence(
    object: &Map<String, Value>,
    key: &str,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    match object.get(key) {
        None => None,
        Some(Value::Object(entries)) => {
            let mut output = Map::new();
            for (entry_key, entry_value) in entries {
                if entry_key.chars().count() > 64 {
                    issues.push(Issue::nested(
                        "too_big",
                        vec![key.to_owned(), entry_key.clone()],
                        "Too big: expected string to have <= 64 characters",
                    ));
                } else {
                    output.insert(entry_key.clone(), entry_value.clone());
                }
            }
            Some(Value::Object(output))
        }
        Some(other) => {
            issues.push(invalid_type(&[key], "object", other));
            None
        }
    }
}

/// `confirmSchema` (strict): otp, evidence, idempotencyKey.
pub fn parse_confirm(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(body, &["otp", "evidence", "idempotencyKey"]).map_err(failed)?;
    let mut issues = Vec::new();
    let otp = match required_string(object, "otp", &mut issues) {
        Some(value) if !is_otp(&value) => {
            issues.push(invalid_format(&["otp"], "invalid otp"));
            None
        }
        other => other,
    };
    let evidence = parse_evidence(object, "evidence", &mut issues);
    let idempotency_key = validate_idempotency(object, "idempotencyKey", true, &mut issues);
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    output.insert("otp".to_owned(), Value::String(otp.unwrap_or_default()));
    if let Some(evidence) = evidence {
        output.insert("evidence".to_owned(), evidence);
    }
    output.insert(
        "idempotencyKey".to_owned(),
        Value::String(idempotency_key.unwrap_or_default()),
    );
    Ok(Value::Object(output))
}

/// `resendSchema` (strict): optional idempotencyKey. `req.body ?? {}` is applied by the caller.
pub fn parse_resend(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(body, &["idempotencyKey"]).map_err(failed)?;
    let mut issues = Vec::new();
    let idempotency_key = validate_idempotency(object, "idempotencyKey", false, &mut issues);
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    if let Some(key) = idempotency_key {
        output.insert("idempotencyKey".to_owned(), Value::String(key));
    }
    Ok(Value::Object(output))
}

/// `cancelSchema` (strict): optional idempotencyKey and reason (<=256).
pub fn parse_cancel(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(body, &["idempotencyKey", "reason"]).map_err(failed)?;
    let mut issues = Vec::new();
    let idempotency_key = validate_idempotency(object, "idempotencyKey", false, &mut issues);
    let reason = match object.get("reason") {
        None => None,
        Some(Value::String(value)) if value.chars().count() <= 256 => Some(value.clone()),
        Some(Value::String(_)) => {
            issues.push(too_big(&["reason"], 256));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&["reason"], "string", other));
            None
        }
    };
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    if let Some(key) = idempotency_key {
        output.insert("idempotencyKey".to_owned(), Value::String(key));
    }
    if let Some(reason) = reason {
        output.insert("reason".to_owned(), Value::String(reason));
    }
    Ok(Value::Object(output))
}

/// `clientEventSchema` (strict) with the `zClientEvent` preprocess.
pub fn parse_client_event(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(body, &["event", "payload", "idempotencyKey"]).map_err(failed)?;
    let mut issues = Vec::new();
    let event = match required_string(object, "event", &mut issues) {
        Some(value) => match translate_client_event(&value) {
            Some(canonical) => Some(canonical.to_owned()),
            None if CLIENT_EVENTS.contains(&value.as_str()) => Some(value),
            None => {
                issues.push(invalid_enum(&["event"], &CLIENT_EVENTS));
                None
            }
        },
        None => None,
    };
    let payload = parse_evidence(object, "payload", &mut issues);
    let idempotency_key = validate_idempotency(object, "idempotencyKey", false, &mut issues);
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    output.insert("event".to_owned(), Value::String(event.unwrap_or_default()));
    if let Some(payload) = payload {
        output.insert("payload".to_owned(), payload);
    }
    if let Some(key) = idempotency_key {
        output.insert("idempotencyKey".to_owned(), Value::String(key));
    }
    Ok(Value::Object(output))
}

fn parse_optional_money(
    object: &Map<String, Value>,
    key: &str,
    signed: bool,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    match object.get(key) {
        None => None,
        Some(Value::String(value))
            if if signed {
                is_signed_money4(value)
            } else {
                is_money4(value)
            } =>
        {
            Some(Value::String(value.clone()))
        }
        Some(Value::String(_)) => {
            issues.push(invalid_format(&[key], "Invalid string"));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&[key], "string", other));
            None
        }
    }
}

fn parse_optional_enum(
    object: &Map<String, Value>,
    key: &str,
    options: &[&str],
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    match object.get(key) {
        None => None,
        Some(Value::String(value)) if options.contains(&value.as_str()) => {
            Some(Value::String(value.clone()))
        }
        Some(Value::String(_value)) => {
            issues.push(invalid_enum(&[key], options));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&[key], "string", other));
            None
        }
    }
}

fn parse_nullable_string(
    object: &Map<String, Value>,
    key: &str,
    max: Option<usize>,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    match object.get(key) {
        None => None,
        Some(Value::Null) => Some(Value::Null),
        Some(Value::String(value)) => {
            if max.is_some_and(|limit| value.chars().count() > limit) {
                issues.push(too_big(&[key], max.unwrap_or_default()));
                None
            } else {
                Some(Value::String(value.clone()))
            }
        }
        Some(other) => {
            issues.push(invalid_type(&[key], "string", other));
            None
        }
    }
}

fn insert_if_some(output: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        output.insert(key.to_owned(), value);
    }
}

const SANDBOX_STATUSES: [&str; 4] = ["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"];
const INSTRUMENT_TYPES: [&str; 4] = ["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"];
const QUICK_PRESETS: [&str; 4] = [
    "SET_ZERO",
    "SET_LINK_AMOUNT",
    "TOP_UP_5000",
    "RESET_DAILY_SPENT",
];
const SANDBOX_ACTIONS: [&str; 6] = [
    "APPROVE_PUSH_OR_QR",
    "DECLINE_PUSH_OR_QR",
    "APPROVE_WITH_VARIANCE",
    "FIRE_WEBHOOK_NOW",
    "REPLAY_DUPLICATE_WEBHOOK",
    "FIRE_TAMPERED_WEBHOOK",
];

/// `sandboxCreateSchema` (strict).
pub fn parse_sandbox_create(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(
        body,
        &[
            "railCode",
            "gatewayCode",
            "instrumentType",
            "identifier",
            "holderName",
            "secretPin",
            "expiry",
            "availableBalanceLyd",
            "dailyLimitLyd",
            "status",
            "staticOtp",
            "notes",
        ],
    )
    .map_err(failed)?;
    let mut issues = Vec::new();
    let rail_code = validate_named(object, "railCode", 2, 64, |_| true, "", &mut issues);
    let gateway_code = validate_named(object, "gatewayCode", 2, 64, |_| true, "", &mut issues);
    let instrument_type =
        parse_optional_enum(object, "instrumentType", &INSTRUMENT_TYPES, &mut issues);
    let identifier = validate_named(object, "identifier", 3, 64, |_| true, "", &mut issues);
    let holder_name = validate_named(object, "holderName", 2, 120, |_| true, "", &mut issues);
    let secret_pin = match object.get("secretPin") {
        None => None,
        Some(Value::String(value)) if (3..=16).contains(&value.chars().count()) => {
            Some(Value::String(value.clone()))
        }
        Some(Value::String(_)) => {
            issues.push(invalid_format(&["secretPin"], "Invalid string"));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&["secretPin"], "string", other));
            None
        }
    };
    let expiry = parse_nullable_string(object, "expiry", Some(16), &mut issues);
    let available = parse_optional_money(object, "availableBalanceLyd", false, &mut issues);
    let daily_limit = parse_optional_money(object, "dailyLimitLyd", false, &mut issues);
    let status = parse_optional_enum(object, "status", &SANDBOX_STATUSES, &mut issues);
    let static_otp = match object.get("staticOtp") {
        None => None,
        Some(Value::Null) => Some(Value::Null),
        Some(Value::String(value)) if is_otp(value) => Some(Value::String(value.clone())),
        Some(Value::String(_)) => {
            issues.push(invalid_format(&["staticOtp"], "Invalid string"));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&["staticOtp"], "string", other));
            None
        }
    };
    let notes = parse_nullable_string(object, "notes", Some(255), &mut issues);
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    output.insert(
        "railCode".to_owned(),
        Value::String(rail_code.unwrap_or_default()),
    );
    output.insert(
        "gatewayCode".to_owned(),
        Value::String(gateway_code.unwrap_or_default()),
    );
    insert_if_some(&mut output, "instrumentType", instrument_type);
    output.insert(
        "identifier".to_owned(),
        Value::String(identifier.unwrap_or_default()),
    );
    output.insert(
        "holderName".to_owned(),
        Value::String(holder_name.unwrap_or_default()),
    );
    insert_if_some(&mut output, "secretPin", secret_pin);
    insert_if_some(&mut output, "expiry", expiry);
    insert_if_some(&mut output, "availableBalanceLyd", available);
    insert_if_some(&mut output, "dailyLimitLyd", daily_limit);
    insert_if_some(&mut output, "status", status);
    insert_if_some(&mut output, "staticOtp", static_otp);
    insert_if_some(&mut output, "notes", notes);
    Ok(Value::Object(output))
}

/// `sandboxPatchSchema` (strict).
pub fn parse_sandbox_patch(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(
        body,
        &[
            "availableBalanceLyd",
            "deltaLyd",
            "dailyLimitLyd",
            "dailySpentLyd",
            "status",
            "staticOtp",
            "presetFault",
            "quickPreset",
            "linkAmountLyd",
            "reason",
        ],
    )
    .map_err(failed)?;
    let mut issues = Vec::new();
    let available = parse_optional_money(object, "availableBalanceLyd", false, &mut issues);
    let delta = parse_optional_money(object, "deltaLyd", true, &mut issues);
    let daily_limit = parse_optional_money(object, "dailyLimitLyd", false, &mut issues);
    let daily_spent = parse_optional_money(object, "dailySpentLyd", false, &mut issues);
    let status = parse_optional_enum(object, "status", &SANDBOX_STATUSES, &mut issues);
    let static_otp = match object.get("staticOtp") {
        None => None,
        Some(Value::Null) => Some(Value::Null),
        Some(Value::String(value)) if is_otp(value) => Some(Value::String(value.clone())),
        Some(Value::String(_)) => {
            issues.push(invalid_format(&["staticOtp"], "Invalid string"));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&["staticOtp"], "string", other));
            None
        }
    };
    let preset_fault = parse_nullable_string(object, "presetFault", Some(64), &mut issues);
    let quick_preset = parse_optional_enum(object, "quickPreset", &QUICK_PRESETS, &mut issues);
    let link_amount = match object.get("linkAmountLyd") {
        None => None,
        Some(Value::String(value)) => Some(Value::String(value.clone())),
        Some(other) => {
            issues.push(invalid_type(&["linkAmountLyd"], "string", other));
            None
        }
    };
    let reason = match object.get("reason") {
        None => None,
        Some(Value::String(value)) if value.chars().count() <= 255 => {
            Some(Value::String(value.clone()))
        }
        Some(Value::String(_)) => {
            issues.push(too_big(&["reason"], 255));
            None
        }
        Some(other) => {
            issues.push(invalid_type(&["reason"], "string", other));
            None
        }
    };
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    let mut output = Map::new();
    insert_if_some(&mut output, "availableBalanceLyd", available);
    insert_if_some(&mut output, "deltaLyd", delta);
    insert_if_some(&mut output, "dailyLimitLyd", daily_limit);
    insert_if_some(&mut output, "dailySpentLyd", daily_spent);
    insert_if_some(&mut output, "status", status);
    insert_if_some(&mut output, "staticOtp", static_otp);
    insert_if_some(&mut output, "presetFault", preset_fault);
    insert_if_some(&mut output, "quickPreset", quick_preset);
    insert_if_some(&mut output, "linkAmountLyd", link_amount);
    insert_if_some(&mut output, "reason", reason);
    Ok(Value::Object(output))
}

/// `sandboxSimulateSchema` (strict).
pub fn parse_sandbox_simulate(body: Option<&Value>) -> Result<Value, EdgeFailure> {
    let object = strict_object(body, &["action"]).map_err(failed)?;
    let mut issues = Vec::new();
    let action = parse_optional_enum(object, "action", &SANDBOX_ACTIONS, &mut issues);
    if let Some(action) = action {
        if !issues.is_empty() {
            return Err(failed(issues));
        }
        return Ok(json!({ "action": action }));
    }
    if issues.is_empty() {
        issues.push(missing_type(&["action"], "string"));
    }
    Err(failed(issues))
}

/// The inbound path parameters after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundParams {
    pub gateway: String,
    pub env: String,
    pub path_token: String,
}

/// The five public environment aliases (`INBOUND_ENVIRONMENTS`).
pub const INBOUND_ENVIRONMENTS: [&str; 5] = ["sandbox", "test", "uat", "live", "production"];

/// `paramsSchema` of the inbound route.
pub fn parse_inbound_params(
    gateway: &str,
    env: &str,
    path_token: &str,
) -> Result<InboundParams, EdgeFailure> {
    let mut issues = Vec::new();
    if gateway.is_empty() {
        issues.push(Issue::new(
            "too_small",
            &["gateway"],
            "Too small: expected string to have >= 1 character",
        ));
    } else if gateway.chars().count() > 64 {
        issues.push(too_big(&["gateway"], 64));
    } else if !is_token_chars(gateway) {
        issues.push(invalid_format(&["gateway"], "invalid gateway identifier"));
    }
    if !INBOUND_ENVIRONMENTS.contains(&env) {
        issues.push(invalid_enum(&["env"], &INBOUND_ENVIRONMENTS));
    }
    if path_token.chars().count() < 4 {
        issues.push(Issue::new(
            "too_small",
            &["pathToken"],
            "Too small: expected string to have >= 4 characters",
        ));
    } else if path_token.chars().count() > 256 {
        issues.push(too_big(&["pathToken"], 256));
    } else if !is_token_chars(path_token) {
        issues.push(invalid_format(&["pathToken"], "invalid inbound path token"));
    }
    if !issues.is_empty() {
        return Err(failed(issues));
    }
    Ok(InboundParams {
        gateway: gateway.to_owned(),
        env: env.to_owned(),
        path_token: path_token.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_key_boundaries_match_zod() {
        for valid in ["LNK_123", "abcdef", &"A".repeat(64)] {
            assert!(validate_link_key(valid).is_ok(), "{valid}");
        }
        for invalid in ["", "abc", &"A".repeat(65), "has space", "has/slash"] {
            assert!(validate_link_key(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn attempt_and_token_boundaries_match_zod() {
        for valid in ["ATT_123", "abcdef"] {
            assert!(validate_attempt_id(valid).is_ok());
        }
        for invalid in ["", "abc", "has space", "has/slash"] {
            assert!(validate_attempt_id(invalid).is_err());
        }
        assert!(validate_attempt_token("attempttoken123").is_ok());
        assert!(validate_attempt_token("short").is_err());
        assert!(validate_attempt_token(&"a".repeat(257)).is_err());
    }

    #[test]
    fn rail_code_and_otp_and_idempotency_boundaries() {
        for valid in ["MOAMALAT", "sadad", "numo_pay"] {
            assert!(
                parse_initiate(Some(&json!({
                    "railCode": valid,
                    "formData": {},
                    "idempotencyKey": "idem-00000001",
                })))
                .is_ok(),
                "{valid}"
            );
        }
        for invalid in ["", "bad rail", "bad/rail", &"x".repeat(65)] {
            assert!(
                parse_initiate(Some(&json!({
                    "railCode": invalid,
                    "formData": {},
                    "idempotencyKey": "idem-00000001",
                })))
                .is_err(),
                "{invalid}"
            );
        }
        for valid in ["1234", "123456", "12345678"] {
            assert!(parse_confirm(Some(&json!({
                "otp": valid,
                "idempotencyKey": "idem-00000001",
            })))
            .is_ok());
        }
        for invalid in ["", "123", "123456789", "abcd"] {
            assert!(parse_confirm(Some(&json!({
                "otp": invalid,
                "idempotencyKey": "idem-00000001",
            })))
            .is_err());
        }
        for valid in ["idem-00000001", "A_b.c:d-12345678"] {
            assert!(parse_resend(Some(&json!({ "idempotencyKey": valid }))).is_ok());
        }
        for invalid in ["short", "has space", "has/slash", &"x".repeat(129)] {
            assert!(parse_resend(Some(&json!({ "idempotencyKey": invalid }))).is_err());
        }
    }

    #[test]
    fn initiate_applies_form_data_default_and_rejects_unknown_fields() {
        let parsed = parse_initiate(Some(&json!({
            "railCode": "MOAMALAT",
            "idempotencyKey": "idem-00000001",
        })))
        .expect("valid");
        assert_eq!(parsed.get("formData"), Some(&json!({})));
        assert!(!parsed.get("subMode").is_some_and(|_| true));

        let failure = parse_initiate(Some(&json!({
            "railCode": "MOAMALAT",
            "formData": {},
            "idempotencyKey": "idem-00000001",
            "extra": true,
        })))
        .expect_err("unknown");
        assert_eq!(failure.code, "VALIDATION_FAILED");
        let details = failure.details.expect("details");
        assert_eq!(details[0]["code"], "unrecognized_keys");
        assert_eq!(details[0]["keys"], json!(["extra"]));
    }

    #[test]
    fn form_data_accepts_only_scalars_and_reports_nested_paths() {
        let parsed = parse_initiate(Some(&json!({
            "railCode": "MOAMALAT",
            "formData": {
                "phone": "0912345678",
                "age": 42,
                "ok": true,
                "nothing": null,
            },
            "idempotencyKey": "idem-00000001",
        })))
        .expect("valid");
        assert_eq!(parsed["formData"]["age"], json!(42));

        let failure = parse_initiate(Some(&json!({
            "railCode": "MOAMALAT",
            "formData": { "nested": { "a": 1 } },
            "idempotencyKey": "idem-00000001",
        })))
        .expect_err("object value");
        let details = failure.details.expect("details");
        assert_eq!(details[0]["path"], json!(["formData", "nested"]));

        let failure = parse_initiate(Some(&json!({
            "railCode": "MOAMALAT",
            "formData": { "value": "x".repeat(513) },
            "idempotencyKey": "idem-00000001",
        })))
        .expect_err("long value");
        assert_eq!(failure.details.expect("details")[0]["code"], "too_big");
    }

    #[test]
    fn client_events_accept_aliases_and_canonical_values() {
        let parsed =
            parse_client_event(Some(&json!({ "event": "COMPLETE_CALLBACK" }))).expect("alias");
        assert_eq!(parsed["event"], json!("completeCallback"));
        let parsed = parse_client_event(Some(&json!({ "event": "widget-closed" }))).expect("alias");
        assert_eq!(parsed["event"], json!("widgetEvent"));
        let parsed =
            parse_client_event(Some(&json!({ "event": "returnHint" }))).expect("canonical");
        assert_eq!(parsed["event"], json!("returnHint"));
        let failure =
            parse_client_event(Some(&json!({ "event": "NOT_AN_EVENT" }))).expect_err("bad");
        assert_eq!(
            failure.details.expect("details")[0]["code"],
            "invalid_value"
        );
        assert_eq!(
            translate_client_event("cancel-callback"),
            Some("errorCallback")
        );
        assert_eq!(translate_client_event("WIDGET_READY"), Some("widgetEvent"));
        assert_eq!(translate_client_event("NOT_AN_EVENT"), None);
    }

    #[test]
    fn inbound_params_accept_aliases_and_reject_unknown_environments() {
        for env in ["sandbox", "test", "uat", "live", "production"] {
            assert!(parse_inbound_params("moamalat", env, "abc123token").is_ok());
        }
        let failure =
            parse_inbound_params("moamalat", "staging", "abc123token").expect_err("staging");
        assert_eq!(failure.code, "VALIDATION_FAILED");
        assert_eq!(failure.details.expect("details")[0]["path"], json!(["env"]));
        assert!(parse_inbound_params("bad gateway", "live", "abc123token").is_err());
        assert!(parse_inbound_params("moamalat", "live", "abc").is_err());
    }

    #[test]
    fn sandbox_schemas_accept_the_documented_money_shapes() {
        let parsed = parse_sandbox_patch(Some(&json!({
            "availableBalanceLyd": "10.5000",
            "deltaLyd": "-1.25",
            "quickPreset": "TOP_UP_5000",
        })))
        .expect("patch");
        assert_eq!(parsed["deltaLyd"], json!("-1.25"));
        assert!(parse_sandbox_patch(Some(&json!({ "deltaLyd": "1.23456" }))).is_err());
        assert!(parse_sandbox_patch(Some(&json!({ "availableBalanceLyd": "-1" }))).is_err());
        assert!(parse_sandbox_patch(Some(&json!({ "status": "GONE" }))).is_err());
        assert!(parse_sandbox_patch(Some(&json!({ "staticOtp": null }))).is_ok());
        assert!(parse_sandbox_patch(Some(&json!({ "unknown": 1 }))).is_err());

        let create = parse_sandbox_create(Some(&json!({
            "railCode": "MOAMALAT",
            "gatewayCode": "MOAMALAT",
            "identifier": "0912345678",
            "holderName": "Payer",
            "availableBalanceLyd": "100.0000",
        })))
        .expect("create");
        assert_eq!(create["identifier"], json!("0912345678"));
        assert!(parse_sandbox_create(Some(&json!({
            "railCode": "M",
            "gatewayCode": "MOAMALAT",
            "identifier": "0912345678",
            "holderName": "Payer",
        })))
        .is_err());

        let action = parse_sandbox_simulate(Some(&json!({ "action": "FIRE_WEBHOOK_NOW" })))
            .expect("simulate");
        assert_eq!(action["action"], json!("FIRE_WEBHOOK_NOW"));
        assert!(parse_sandbox_simulate(Some(&json!({}))).is_err());
    }

    #[test]
    fn optional_bodies_behave_like_express_json() {
        // resend/cancel receive `req.body ?? {}`.
        assert!(parse_resend(Some(&json!({}))).is_ok());
        assert!(parse_cancel(Some(&json!({}))).is_ok());
        // initiate/confirm/client-event receive an undefined body.
        assert!(parse_initiate(None).is_err());
        assert!(parse_confirm(None).is_err());
        assert!(parse_client_event(None).is_err());
    }

    #[test]
    fn public_id_boundaries() {
        assert!(validate_public_id("opaquePublicId0123456789abcdef").is_ok());
        assert!(validate_public_id("short").is_err());
        assert!(validate_public_id(&"a".repeat(65)).is_err());
    }
}
