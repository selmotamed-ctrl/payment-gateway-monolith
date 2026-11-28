//! Request ids and log redaction.
//!
//! Port of `checkout-back/lib/requestLogger/index.ts`:
//! * `resolveRequestId` accepts `x-request-id` only when it matches `^[A-Za-z0-9._:-]{1,128}$`
//!   and generates a UUIDv4 otherwise;
//! * `redactUrl` masks capability path segments (link keys, attempt ids/tokens, certificate ids,
//!   inbound path tokens) and sensitive query values before a URL is logged;
//! * `redactSecrets` masks sensitive object keys at any depth and truncates long strings.
//!
//! The edge never logs a request body, a callback body, an authorization header or a payer
//! secret: only the line `<ISO> <request-id> <METHOD> <redacted-path> <status> <duration>` plus
//! the request-id response header.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

pub const REDACTED: &str = "[REDACTED]";
const MAX_STRING_LENGTH: usize = 256;

/// `SENSITIVE_KEY_PATTERN`, as a case-insensitive substring predicate.
///
/// The TypeScript pattern is a single large alternation; matching substrings keeps the same
/// outcomes for the field names the edge logs (`password`, `token`, `otp`, `email`, `phone`,
/// `authorization`, `apiKey`, `signature`, `cookie`, ...). `key` is included, exactly like the
/// original alternation, so `apiKey` and `monkey` are redacted.
const SENSITIVE_KEY_PARTS: [&str; 56] = [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "otp",
    "pin",
    "cvv",
    "cvc",
    "pan",
    "card_number",
    "card-number",
    "cardnumber",
    "authorization",
    "api_key",
    "api-key",
    "apikey",
    "private_key",
    "private-key",
    "privatekey",
    "credential",
    "cookie",
    "session",
    "signature",
    "nonce",
    "client_secret",
    "client-secret",
    "clientsecret",
    "encryption_key",
    "mtls",
    "key",
    "email",
    "phone",
    "msisdn",
    "mobile",
    "iban",
    "account_number",
    "account-no",
    "accountno",
    "full_name",
    "full-name",
    "first_name",
    "first-name",
    "last_name",
    "last-name",
    "holder_name",
    "holder-name",
    "identity",
    "national_id",
    "national-id",
    "id_number",
    "id-number",
    "passport",
    "dob",
    "birth",
    "address",
];

fn sensitive_key(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == "name" {
        return true;
    }
    SENSITIVE_KEY_PARTS.iter().any(|part| lower.contains(part))
}

/// Capability path segments: `/inbound/<gw>/<env>/<token>`, `/pay/<key>`, `/return/<token>`,
/// `/logs/<attempt>`, `/verify/certificate/<id>`.
fn redact_path(path: &str) -> String {
    let mut value = path.to_owned();
    value = replace_after(&value, "/inbound/", 3);
    value = replace_after(&value, "/pay/", 1);
    value = replace_after(&value, "/return/", 1);
    value = replace_after(&value, "/logs/", 1);
    value = replace_after(&value, "/verify/certificate/", 1);
    value
}

/// Replaces the `index`-th path segment after `marker` with `[REDACTED]`.
fn replace_after(value: &str, marker: &str, index: usize) -> String {
    let Some(start) = value.find(marker) else {
        return value.to_owned();
    };
    let mut search = start + marker.len();
    for _ in 1..index {
        match value[search..].find('/') {
            Some(offset) => search += offset + 1,
            None => return value.to_owned(),
        }
    }
    let end = value[search..]
        .find(['/', '?'])
        .map_or(value.len(), |offset| search + offset);
    if end <= search {
        return value.to_owned();
    }
    let mut output = String::with_capacity(value.len());
    output.push_str(&value[..search]);
    output.push_str(REDACTED);
    output.push_str(&value[end..]);
    output
}

/// `redactUrl`: mask capability segments and sensitive query values, truncate others to 64.
#[must_use]
pub fn redact_url(url: &str) -> String {
    let query_index = url.find('?');
    let (path, query) = match query_index {
        Some(index) => (&url[..index], Some(&url[index + 1..])),
        None => (url, None),
    };
    let redacted_path = redact_path(path);
    let Some(query) = query else {
        return redacted_path;
    };
    let mut parts = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if sensitive_key(key) {
            parts.push(format!("{key}={REDACTED}"));
        } else {
            let decoded = url::form_urlencoded::parse(format!("x={value}").as_bytes())
                .next()
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            let truncated: String = decoded.chars().take(64).collect();
            parts.push(format!(
                "{key}={}",
                url::form_urlencoded::byte_serialize(truncated.as_bytes()).collect::<String>()
            ));
        }
    }
    if parts.is_empty() {
        redacted_path
    } else {
        format!("{redacted_path}?{}", parts.join("&"))
    }
}

/// `redactSecrets`: masks sensitive keys at any depth and truncates long strings.
#[must_use]
pub fn redact_secrets(value: &Value) -> Value {
    redact_at(value, 0)
}

fn redact_at(value: &Value, depth: usize) -> Value {
    if depth > 8 {
        return Value::String("[TRUNCATED]".to_owned());
    }
    match value {
        Value::String(text) if text.chars().count() > MAX_STRING_LENGTH => {
            let mut truncated: String = text.chars().take(MAX_STRING_LENGTH).collect();
            truncated.push_str("...[truncated]");
            Value::String(truncated)
        }
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .map(|entry| redact_at(entry, depth + 1))
                .collect(),
        ),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, entry) in object {
                if sensitive_key(key) {
                    output.insert(key.clone(), Value::String(REDACTED.to_owned()));
                } else {
                    output.insert(key.clone(), redact_at(entry, depth + 1));
                }
            }
            Value::Object(output)
        }
        other => other.clone(),
    }
}

/// `redactHeaders`: a flat map where sensitive header names are masked.
#[must_use]
pub fn redact_headers(headers: &ntex::http::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            let name = name.as_str().to_owned();
            let value = if sensitive_key(&name) {
                REDACTED.to_owned()
            } else {
                value.to_str().unwrap_or_default().to_owned()
            };
            (name, value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn capability_path_segments_are_masked() {
        assert_eq!(
            redact_url("/api/v1/inbound/gw/live/SECRETPATHTOKEN"),
            "/api/v1/inbound/gw/live/[REDACTED]"
        );
        let pay = redact_url("/api/v1/pay/LNKOKAY0001/logs/att_123/status");
        assert!(!pay.contains("LNKOKAY0001"));
        assert!(!pay.contains("att_123"));
        assert_eq!(
            redact_url("/api/v1/return/ATTEMPTTOKEN123?reference=R1&token=abc"),
            "/api/v1/return/[REDACTED]?reference=R1&token=[REDACTED]"
        );
        assert_eq!(
            redact_url("/api/v1/verify/certificate/opaquePublicId0123456789abcdef"),
            "/api/v1/verify/certificate/[REDACTED]"
        );
    }

    #[test]
    fn non_sensitive_query_values_survive_and_are_capped() {
        let long = "x".repeat(100);
        let redacted = redact_url(&format!("/api/v1/pay/key/status?note={long}"));
        assert!(redacted.contains("note="));
        assert!(redacted.len() < 120);
    }

    #[test]
    fn secrets_are_masked_at_any_depth() {
        let redacted = redact_secrets(&json!({
            "email": "merchant@example.com",
            "password": "super-secret",
            "nested": { "token": "pg_live_1", "authorization": "Bearer abc", "otp": "1234" },
            "list": [{ "apiKey": "key-1" }],
            "note": "visible",
            "amount": "100.0000",
        }));
        assert_eq!(redacted["email"], json!(REDACTED));
        assert_eq!(redacted["password"], json!(REDACTED));
        assert_eq!(redacted["nested"]["token"], json!(REDACTED));
        assert_eq!(redacted["nested"]["authorization"], json!(REDACTED));
        assert_eq!(redacted["nested"]["otp"], json!(REDACTED));
        assert_eq!(redacted["list"][0]["apiKey"], json!(REDACTED));
        assert_eq!(redacted["note"], json!("visible"));
        // `amount` is not a sensitive log key: money may be logged in a summary, never a payer secret.
        assert_eq!(redacted["amount"], json!("100.0000"));
    }

    #[test]
    fn long_values_are_truncated() {
        let redacted = redact_secrets(&json!({ "note": "x".repeat(400) }));
        let text = redacted["note"].as_str().expect("string");
        assert!(text.len() < 400);
        assert!(text.contains("[truncated]"));
    }

    #[test]
    fn headers_are_masked() {
        let mut headers = ntex::http::HeaderMap::new();
        headers.insert(
            ntex::http::header::HeaderName::from_static("authorization"),
            "Bearer abc".parse().expect("value"),
        );
        headers.insert(
            ntex::http::header::HeaderName::from_static("user-agent"),
            "checkout-front/1.0".parse().expect("value"),
        );
        let redacted = redact_headers(&headers);
        assert!(redacted.contains(&("authorization".to_owned(), REDACTED.to_owned())));
        assert!(redacted.contains(&("user-agent".to_owned(), "checkout-front/1.0".to_owned())));
    }
}
