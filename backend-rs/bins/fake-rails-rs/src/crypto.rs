//! HMAC/HMAC-SHA512/SHA-256 signing recipes, secret derivation, OTP derivation and the portal
//! HS256 JWT. Ported from `engine/crypto/FakeCryptoSigner.ts` and `lib/jwt.ts`.

#![forbid(unsafe_code)]

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256, Sha384, Sha512};

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoAlgorithm {
    HmacSha256,
    HmacSha512,
    RsaSha256,
    Sha256,
}

impl CryptoAlgorithm {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "HMAC_SHA256" => Some(Self::HmacSha256),
            "HMAC_SHA512" => Some(Self::HmacSha512),
            "RSA_SHA256" => Some(Self::RsaSha256),
            "SHA256" => Some(Self::Sha256),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalizationMode {
    SortedKeyValueAmp,
    SortedValuesHash,
    TemplateString,
    JsonCanonical,
    RawBody,
    TimestampDotRawBody,
}

impl CanonicalizationMode {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "SORTED_KEY_VALUE_AMP" => Some(Self::SortedKeyValueAmp),
            "SORTED_VALUES_HASH" => Some(Self::SortedValuesHash),
            "TEMPLATE_STRING" => Some(Self::TemplateString),
            "JSON_CANONICAL" => Some(Self::JsonCanonical),
            "RAW_BODY" => Some(Self::RawBody),
            "TIMESTAMP_DOT_RAW_BODY" => Some(Self::TimestampDotRawBody),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretEncoding {
    Utf8,
    Hex,
    Base64,
}

impl SecretEncoding {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "UTF8" => Some(Self::Utf8),
            "HEX" => Some(Self::Hex),
            "BASE64" => Some(Self::Base64),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputEncoding {
    HexLower,
    HexUpper,
    Base64,
}

impl OutputEncoding {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "HEX_LOWER" => Some(Self::HexLower),
            "HEX_UPPER" => Some(Self::HexUpper),
            "BASE64" => Some(Self::Base64),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SigningRecipe {
    pub algorithm: CryptoAlgorithm,
    pub canonicalization_mode: CanonicalizationMode,
    pub secret: String,
    pub secret_key_encoding: SecretEncoding,
    pub output_encoding: OutputEncoding,
    pub template_string: Option<String>,
    pub included_fields: Option<Vec<String>>,
    pub excluded_fields: Option<Vec<String>>,
}

impl SigningRecipe {
    #[must_use]
    pub fn hmac_sha256_sorted(secret: impl Into<String>) -> Self {
        Self {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::SortedKeyValueAmp,
            secret: secret.into(),
            secret_key_encoding: SecretEncoding::Utf8,
            output_encoding: OutputEncoding::HexLower,
            template_string: None,
            included_fields: None,
            excluded_fields: None,
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CanonicalizeOptions<'a> {
    pub raw_body: Option<&'a str>,
    pub timestamp: Option<&'a str>,
    pub template: Option<&'a str>,
    pub included_fields: Option<&'a [String]>,
    pub excluded_fields: Option<&'a [String]>,
}

fn json_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn pairs(payload: &Value) -> Vec<(String, String)> {
    match payload {
        Value::Object(object) => object
            .iter()
            .filter(|(_, value)| !value.is_null())
            .map(|(key, value)| (key.clone(), json_string(value)))
            .collect(),
        other => vec![("value".to_owned(), json_string(other))],
    }
}

fn sorted_pairs(payload: &Value) -> Vec<(String, String)> {
    let mut entries = pairs(payload);
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut sorted = Map::new();
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            for key in keys {
                sorted.insert(key.clone(), sort_keys(&object[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

fn lookup_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn expand_template(template: &str, payload: &Value) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut output = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] != '{' {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        if cursor < chars.len() && chars[cursor] == '{' {
            cursor += 1;
        }
        let mut key = String::new();
        let mut valid = true;
        while cursor < chars.len() && chars[cursor] != '}' {
            let ch = chars[cursor];
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                key.push(ch);
                cursor += 1;
            } else {
                valid = false;
                break;
            }
        }
        if !valid || cursor >= chars.len() || key.is_empty() {
            output.push('{');
            index += 1;
            continue;
        }
        cursor += 1;
        if cursor < chars.len() && chars[cursor] == '}' {
            cursor += 1;
        }
        if let Some(value) = lookup_path(payload, &key) {
            output.push_str(&json_string(value));
        }
        index = cursor;
    }
    output
}

/// Canonical string for a signing recipe.
#[must_use]
pub fn canonicalize(
    mode: CanonicalizationMode,
    payload: &Value,
    options: &CanonicalizeOptions<'_>,
) -> String {
    let mut filtered = Map::new();
    if let Value::Object(object) = payload {
        let included = options.included_fields.unwrap_or(&[]);
        let excluded = options.excluded_fields.unwrap_or(&[]);
        for (key, value) in object {
            if !included.is_empty() && !included.contains(key) {
                continue;
            }
            if excluded.contains(key) {
                continue;
            }
            filtered.insert(key.clone(), value.clone());
        }
    } else {
        filtered.insert("value".to_owned(), payload.clone());
    }
    let filtered = Value::Object(filtered);
    match mode {
        CanonicalizationMode::SortedKeyValueAmp => sorted_pairs(&filtered)
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&"),
        CanonicalizationMode::SortedValuesHash => sorted_pairs(&filtered)
            .into_iter()
            .map(|(_, value)| value)
            .collect::<Vec<_>>()
            .join(""),
        CanonicalizationMode::TemplateString => {
            expand_template(options.template.unwrap_or_default(), &filtered)
        }
        CanonicalizationMode::JsonCanonical => {
            serde_json::to_string(&sort_keys(&filtered)).unwrap_or_default()
        }
        CanonicalizationMode::TimestampDotRawBody => format!(
            "{}.{}",
            options.timestamp.unwrap_or_default(),
            options
                .raw_body
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_default())
        ),
        CanonicalizationMode::RawBody => {
            options
                .raw_body
                .map(str::to_owned)
                .unwrap_or_else(|| match payload {
                    Value::String(text) => text.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                })
        }
    }
}

fn secret_bytes(secret: &str, encoding: SecretEncoding) -> ApiResult<Vec<u8>> {
    match encoding {
        SecretEncoding::Utf8 => Ok(secret.as_bytes().to_vec()),
        SecretEncoding::Hex => hex_decode(secret).ok_or_else(|| {
            ApiError::new(
                500,
                "INVALID_SECRET_ENCODING",
                "the secret is not valid hex",
            )
        }),
        SecretEncoding::Base64 => STANDARD.decode(secret).map_err(|_| {
            ApiError::new(
                500,
                "INVALID_SECRET_ENCODING",
                "the secret is not valid base64",
            )
        }),
    }
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0usize;
    while index < bytes.len() {
        let high = (bytes[index] as char).to_digit(16)?;
        let low = (bytes[index + 1] as char).to_digit(16)?;
        output.push(((high << 4) | low) as u8);
        index += 2;
    }
    Some(output)
}

#[must_use]
pub fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

#[must_use]
pub fn hex_upper(bytes: &[u8]) -> String {
    hex_lower(bytes).to_ascii_uppercase()
}

fn encode_output(bytes: &[u8], encoding: OutputEncoding) -> String {
    match encoding {
        OutputEncoding::HexLower => hex_lower(bytes),
        OutputEncoding::HexUpper => hex_upper(bytes),
        OutputEncoding::Base64 => STANDARD.encode(bytes),
    }
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> ApiResult<Vec<u8>> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key)
        .map_err(|_| ApiError::new(500, "HMAC_KEY", "invalid HMAC key"))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

pub fn hmac_sha512(key: &[u8], data: &[u8]) -> ApiResult<Vec<u8>> {
    let mut mac = <Hmac<Sha512> as KeyInit>::new_from_slice(key)
        .map_err(|_| ApiError::new(500, "HMAC_KEY", "invalid HMAC key"))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

#[must_use]
pub fn sha256_hex(data: &[u8]) -> String {
    hex_lower(&Sha256::digest(data))
}

#[must_use]
pub fn sha384_base64(data: &[u8]) -> String {
    STANDARD.encode(Sha384::digest(data))
}

pub fn sign(
    recipe: &SigningRecipe,
    payload: &Value,
    raw_body: Option<&str>,
    timestamp: Option<&str>,
) -> ApiResult<String> {
    let canonical = canonicalize(
        recipe.canonicalization_mode,
        payload,
        &CanonicalizeOptions {
            raw_body,
            timestamp,
            template: recipe.template_string.as_deref(),
            included_fields: recipe.included_fields.as_deref(),
            excluded_fields: recipe.excluded_fields.as_deref(),
        },
    );
    let key = secret_bytes(&recipe.secret, recipe.secret_key_encoding)?;
    match recipe.algorithm {
        CryptoAlgorithm::HmacSha256 => Ok(encode_output(
            &hmac_sha256(&key, canonical.as_bytes())?,
            recipe.output_encoding,
        )),
        CryptoAlgorithm::HmacSha512 => Ok(encode_output(
            &hmac_sha512(&key, canonical.as_bytes())?,
            recipe.output_encoding,
        )),
        CryptoAlgorithm::Sha256 => Ok(encode_output(
            &Sha256::digest(canonical.as_bytes()),
            recipe.output_encoding,
        )),
        CryptoAlgorithm::RsaSha256 => Err(ApiError::new(
            501,
            "UNSUPPORTED_SIGNING_ALGORITHM",
            "RSA_SHA256 signing is not implemented in the Rust port",
        )),
    }
}

/// Constant-time equality for signature strings.
#[must_use]
pub fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

#[must_use]
pub fn verify(
    recipe: &SigningRecipe,
    payload: &Value,
    expected: &str,
    raw_body: Option<&str>,
    timestamp: Option<&str>,
) -> bool {
    if recipe.algorithm == CryptoAlgorithm::RsaSha256 {
        return false;
    }
    match sign(recipe, payload, raw_body, timestamp) {
        Ok(computed) => constant_time_eq(&computed, expected),
        Err(_) => false,
    }
}

/// Deterministic secret shared with `core-back`'s seeder token (`deriveSecret`).
#[must_use]
pub fn derive_secret(seeder_token: &str, gateway_code: &str, purpose: &str) -> String {
    let data = format!("fake-rails:{gateway_code}:{purpose}");
    hmac_sha256(seeder_token.as_bytes(), data.as_bytes())
        .map(|bytes| hex_lower(&bytes))
        .unwrap_or_default()
}

/// Deterministic per-transaction OTP (`deriveOtp`).
#[must_use]
pub fn derive_otp(seed: &str, rail_code: &str, reference: &str, length: usize) -> String {
    let digest = sha256_hex(format!("{seed}:{rail_code}:{reference}").as_bytes());
    let prefix = &digest[..16.min(digest.len())];
    let numeric = u64::from_str_radix(prefix, 16).unwrap_or(0).to_string();
    let mut padded = numeric;
    while padded.len() < length {
        padded.insert(0, '0');
    }
    padded[..length.min(padded.len())].to_owned()
}

fn base64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

pub const JWT_TTL_SECONDS: i64 = 12 * 3600;

/// Signs an HS256 JWT with the exact header and claim order of `lib/jwt.ts`.
#[must_use]
pub fn sign_jwt(claims: &[(&str, Value)], secret: &str, ttl_seconds: i64) -> String {
    let now = chrono::Utc::now().timestamp();
    let header = base64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let mut body = Map::new();
    for (key, value) in claims {
        body.insert((*key).to_owned(), value.clone());
    }
    body.insert("iat".to_owned(), json!(now));
    body.insert("exp".to_owned(), json!(now + ttl_seconds));
    let body = base64url(
        serde_json::to_string(&Value::Object(body))
            .unwrap_or_default()
            .as_bytes(),
    );
    let data = format!("{header}.{body}");
    let signature = hmac_sha256(secret.as_bytes(), data.as_bytes())
        .map(|bytes| base64url(&bytes))
        .unwrap_or_default();
    format!("{data}.{signature}")
}

/// Verifies the signature and expiry; returns the decoded claims.
#[must_use]
pub fn verify_jwt(token: &str, secret: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let expected = hmac_sha256(
        secret.as_bytes(),
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
    )
    .ok()?;
    let provided = URL_SAFE_NO_PAD.decode(parts[2]).ok()?;
    if expected.len() != provided.len() {
        return None;
    }
    let mut difference = 0u8;
    for (a, b) in expected.iter().zip(provided.iter()) {
        difference |= a ^ b;
    }
    if difference != 0 {
        return None;
    }
    let payload: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).ok()?).ok()?;
    let exp = payload.get("exp").and_then(Value::as_i64)?;
    if exp * 1000 < chrono::Utc::now().timestamp_millis() {
        return None;
    }
    Some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_key_value_pairs() {
        assert_eq!(
            canonicalize(
                CanonicalizationMode::SortedKeyValueAmp,
                &json!({"b": "2", "a": "1"}),
                &CanonicalizeOptions::default()
            ),
            "a=1&b=2"
        );
    }

    #[test]
    fn sorts_values() {
        assert_eq!(
            canonicalize(
                CanonicalizationMode::SortedValuesHash,
                &json!({"b": "2", "a": "1"}),
                &CanonicalizeOptions::default()
            ),
            "12"
        );
    }

    #[test]
    fn signs_and_verifies_hmac_sha256() {
        let recipe = SigningRecipe {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::SortedKeyValueAmp,
            secret: "top-secret".to_owned(),
            secret_key_encoding: SecretEncoding::Utf8,
            output_encoding: OutputEncoding::HexUpper,
            template_string: None,
            included_fields: None,
            excluded_fields: None,
        };
        let signature = sign(
            &recipe,
            &json!({"amount": "10.00", "reference": "PG-1"}),
            None,
            None,
        )
        .expect("sign");
        assert!(signature.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(verify(
            &recipe,
            &json!({"reference": "PG-1", "amount": "10.00"}),
            &signature,
            None,
            None
        ));
        assert!(!verify(
            &recipe,
            &json!({"reference": "PG-1", "amount": "99.00"}),
            &signature,
            None,
            None
        ));
    }

    #[test]
    fn timestamp_dot_raw_body_covers_exact_bytes() {
        let recipe = SigningRecipe {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::TimestampDotRawBody,
            secret: "s3cret".to_owned(),
            secret_key_encoding: SecretEncoding::Utf8,
            output_encoding: OutputEncoding::HexLower,
            template_string: None,
            included_fields: None,
            excluded_fields: None,
        };
        let signature =
            sign(&recipe, &json!({}), Some(r#"{"a":1}"#), Some("1700000000")).expect("sign");
        assert!(verify(
            &recipe,
            &json!({}),
            &signature,
            Some(r#"{"a":1}"#),
            Some("1700000000")
        ));
        assert!(!verify(
            &recipe,
            &json!({}),
            &signature,
            Some(r#"{"a":2}"#),
            Some("1700000000")
        ));
    }

    #[test]
    fn derives_deterministic_secrets_and_otps() {
        let secret = derive_secret("seeder-token", "moamalat", "webhook");
        assert_eq!(secret, derive_secret("seeder-token", "moamalat", "webhook"));
        assert_ne!(secret, derive_secret("seeder-token", "moamalat", "sign"));
        assert_eq!(derive_otp("seed", "edfali", "REF-1", 4).len(), 4);
        assert_eq!(
            derive_otp("seed", "edfali", "REF-1", 4),
            derive_otp("seed", "edfali", "REF-1", 4)
        );
    }

    #[test]
    fn jwt_round_trips_and_rejects_tampering() {
        let token = sign_jwt(
            &[
                ("sub", json!("tester_admin")),
                ("role", json!("FAKE_RAILS_TESTER")),
            ],
            "jwt-secret-for-the-test-0123456789",
            JWT_TTL_SECONDS,
        );
        assert_eq!(token.split('.').count(), 3);
        let payload = verify_jwt(&token, "jwt-secret-for-the-test-0123456789").expect("verify");
        assert_eq!(payload["role"], json!("FAKE_RAILS_TESTER"));
        assert!(verify_jwt(&token, "another-secret-another-secret-00").is_none());
        assert!(verify_jwt("garbage", "jwt-secret-for-the-test-0123456789").is_none());
    }

    #[test]
    fn template_expansion_and_canonical_json() {
        let options = CanonicalizeOptions {
            template: Some("{{merchant.id}}-{amount}"),
            ..CanonicalizeOptions::default()
        };
        assert_eq!(
            canonicalize(
                CanonicalizationMode::TemplateString,
                &json!({"merchant": {"id": "M1"}, "amount": 10}),
                &options
            ),
            "M1-10"
        );
        assert_eq!(
            canonicalize(
                CanonicalizationMode::JsonCanonical,
                &json!({"b": 1, "a": {"d": 2, "c": 3}}),
                &CanonicalizeOptions::default()
            ),
            r#"{"a":{"c":3,"d":2},"b":1}"#
        );
    }
}
