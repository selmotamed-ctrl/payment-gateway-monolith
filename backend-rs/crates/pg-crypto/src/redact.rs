//! Secret redaction and card-number detection.
//!
//! Port of `core-back/engine/crypto/Vault.ts:15-63,240-265,337-382`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

pub const REDACTED_VALUE: &str = "[REDACTED]";

const SENSITIVE_FIELD_NAMES: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "otp",
    "cvv",
    "pan",
    "authorization",
    "apikey",
    "webhooksecret",
    "clientsecret",
    "privatekey",
];

const SENSITIVE_FIELD_PATTERN_PARTS: &[&str] = &[
    "secret",
    "token",
    "password",
    "passwd",
    "passphrase",
    "apikey",
    "api_key",
    "privatekey",
    "private_key",
    "signingkey",
    "signing_key",
    "signature",
    "authorization",
    "auth",
    "credential",
    "cookie",
    "session",
    "pan",
    "card",
    "cvv",
    "cvc",
    "otp",
    "pin",
    "iban",
    "accountnumber",
    "account_number",
];

/// Luhn-valid 12–19 digit values are card numbers even when the field name is innocuous.
#[must_use]
pub fn looks_like_pan(value: &str) -> bool {
    let digits: String = value
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-')
        .collect();
    if digits.len() < 12 || digits.len() > 19 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let mut sum = 0_u32;
    let mut double = false;
    for byte in digits.bytes().rev() {
        let mut digit = u32::from(byte - b'0');
        if double {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        double = !double;
    }
    sum.is_multiple_of(10)
}

fn normalize_field_name(name: &str) -> String {
    name.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

#[must_use]
pub fn is_sensitive_field_name(name: &str) -> bool {
    let normalized = normalize_field_name(name);
    if SENSITIVE_FIELD_NAMES.contains(&normalized.as_str()) {
        return true;
    }
    SENSITIVE_FIELD_PATTERN_PARTS
        .iter()
        .any(|part| normalized.contains(part))
}

/// Replace literal secrets (longest first) and embedded PANs.
#[must_use]
pub fn redact_text(text: &str, literal_secrets: &[&str]) -> String {
    let mut secrets: Vec<&str> = literal_secrets
        .iter()
        .copied()
        .filter(|secret| !secret.is_empty())
        .collect();
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    secrets.dedup();
    let mut redacted = text.to_owned();
    for secret in secrets {
        redacted = redacted.replace(secret, REDACTED_VALUE);
    }
    redact_embedded_pans(&redacted)
}

fn redact_embedded_pans(text: &str) -> String {
    // Equivalent of `/\d(?:[ -]?\d){11,18}/g` with a Luhn check.
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let start = index;
            let mut end = index;
            let mut digits = 0_u32;
            while end < bytes.len() && digits < 19 {
                let byte = bytes[end];
                if byte.is_ascii_digit() {
                    digits += 1;
                    end += 1;
                } else if matches!(byte, b' ' | b'-')
                    && end + 1 < bytes.len()
                    && bytes[end + 1].is_ascii_digit()
                {
                    end += 1;
                } else {
                    break;
                }
            }
            let candidate = &text[start..end];
            if digits >= 12 && looks_like_pan(candidate) {
                output.push_str(REDACTED_VALUE);
                index = end;
                continue;
            }
        }
        let ch = text[index..].chars().next().unwrap_or('\u{FFFD}');
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

/// Recursively redact sensitive fields, literal secrets and embedded PANs.
#[must_use]
pub fn redact_payload(value: &Value, literal_secrets: &[&str]) -> Value {
    redact_value(value, false, literal_secrets)
}

fn redact_value(value: &Value, sensitive: bool, literal_secrets: &[&str]) -> Value {
    if sensitive {
        return Value::String(REDACTED_VALUE.to_owned());
    }
    match value {
        Value::String(text) => {
            if looks_like_pan(text) {
                Value::String(REDACTED_VALUE.to_owned())
            } else {
                Value::String(redact_text(text, literal_secrets))
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_value(item, false, literal_secrets))
                .collect(),
        ),
        Value::Object(map) => {
            let mut output = Map::new();
            for (key, entry) in map {
                output.insert(
                    key.clone(),
                    redact_value(entry, is_sensitive_field_name(key), literal_secrets),
                );
            }
            Value::Object(output)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn luhn_detection() {
        assert!(looks_like_pan("4111 1111 1111 1111"));
        assert!(!looks_like_pan("4111 1111 1111 1112"));
        assert!(!looks_like_pan("12345"));
    }

    #[test]
    fn redacts_sensitive_fields_and_literals() {
        let value = json!({
            "password": "hunter2",
            "nested": {"api_secret": "abc", "note": "token abc here"},
            "card": "4111111111111111"
        });
        let redacted = redact_payload(&value, &["abc"]);
        assert_eq!(redacted["password"], REDACTED_VALUE);
        assert_eq!(redacted["nested"]["api_secret"], REDACTED_VALUE);
        assert_eq!(redacted["nested"]["note"], "token [REDACTED] here");
        assert_eq!(redacted["card"], REDACTED_VALUE);
    }

    #[test]
    fn embedded_pan_is_redacted() {
        let text = redact_text("paid with 4111-1111-1111-1111 today", &[]);
        assert_eq!(text, "paid with [REDACTED] today");
    }
}
