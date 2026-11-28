//! Declarative signing canonicalisation.
//!
//! Port of `core-back/engine/crypto/CryptoEngine.ts:87-230`. Sorting uses JavaScript `.sort()`
//! semantics, which compare UTF-16 code units, not Unicode scalar values.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::fmt;

use serde_json::{Map, Value};

pub use crate::digest::{KeyEncoding, OutputEncoding};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalizationMode {
    MoamalatSecureHash,
    DpayWebhookVerify,
    PlutuCallbackHash,
    MypayRawBody,
    SortedKeyValueAmp,
    TimestampDotRawBody,
    SortedValuesHash,
    TemplateString,
    JsonCanonical,
    RawBody,
}

impl CanonicalizationMode {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "MOAMALAT_SECURE_HASH" => Self::MoamalatSecureHash,
            "DPAY_WEBHOOK_VERIFY" => Self::DpayWebhookVerify,
            "PLUTU_CALLBACK_HASH" => Self::PlutuCallbackHash,
            "MYPAY_RAW_BODY" => Self::MypayRawBody,
            "SORTED_KEY_VALUE_AMP" => Self::SortedKeyValueAmp,
            "TIMESTAMP_DOT_RAW_BODY" => Self::TimestampDotRawBody,
            "SORTED_VALUES_HASH" => Self::SortedValuesHash,
            "TEMPLATE_STRING" => Self::TemplateString,
            "JSON_CANONICAL" => Self::JsonCanonical,
            "RAW_BODY" => Self::RawBody,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoAlgorithm {
    HmacSha256,
    HmacSha512,
    RsaSha256,
    Sha256,
}

impl CryptoAlgorithm {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "HMAC_SHA256" => Self::HmacSha256,
            "HMAC_SHA512" => Self::HmacSha512,
            "RSA_SHA256" => Self::RsaSha256,
            "SHA256" => Self::Sha256,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct CanonicalizationInput {
    pub fields: Map<String, Value>,
    pub raw_body: Option<Vec<u8>>,
    pub timestamp: Option<String>,
    pub included_fields: Option<Vec<String>>,
    pub excluded_fields: Option<Vec<String>>,
    pub template_string: Option<String>,
    pub value_separator: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalError {
    MissingTimestampOrRawBody,
    MissingTemplate,
    MissingRawBody,
}

impl fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTimestampOrRawBody => f.write_str(
                "Timestamp and raw body are required for timestamp-dot-raw-body canonicalization",
            ),
            Self::MissingTemplate => {
                f.write_str("A template string is required for template-string canonicalization")
            }
            Self::MissingRawBody => {
                f.write_str("Raw body is required for raw-body canonicalization")
            }
        }
    }
}

impl std::error::Error for CanonicalError {}

pub fn canonicalize(
    mode: CanonicalizationMode,
    input: &CanonicalizationInput,
) -> Result<String, CanonicalError> {
    match mode {
        CanonicalizationMode::MoamalatSecureHash | CanonicalizationMode::SortedKeyValueAmp => {
            let filtered = filter_fields(
                &input.fields,
                input.included_fields.as_deref(),
                input.excluded_fields.as_deref(),
            );
            Ok(sorted_key_value_amp(&filtered))
        }
        CanonicalizationMode::DpayWebhookVerify | CanonicalizationMode::TimestampDotRawBody => {
            let timestamp = input
                .timestamp
                .as_deref()
                .ok_or(CanonicalError::MissingTimestampOrRawBody)?;
            let raw_body = input
                .raw_body
                .as_deref()
                .ok_or(CanonicalError::MissingTimestampOrRawBody)?;
            Ok(format!("{timestamp}.{}", String::from_utf8_lossy(raw_body)))
        }
        CanonicalizationMode::PlutuCallbackHash | CanonicalizationMode::SortedValuesHash => {
            let filtered = filter_fields(&input.fields, input.included_fields.as_deref(), None);
            let excluded = input
                .excluded_fields
                .clone()
                .unwrap_or_else(|| vec!["hashed".to_owned()]);
            Ok(sorted_values_hash(
                &filtered,
                &excluded,
                input.value_separator.as_deref().unwrap_or(""),
            ))
        }
        CanonicalizationMode::TemplateString => {
            let template = input
                .template_string
                .as_deref()
                .ok_or(CanonicalError::MissingTemplate)?;
            let filtered = filter_fields(
                &input.fields,
                input.included_fields.as_deref(),
                input.excluded_fields.as_deref(),
            );
            Ok(render_template(template, &filtered))
        }
        CanonicalizationMode::JsonCanonical => {
            let filtered = filter_fields(
                &input.fields,
                input.included_fields.as_deref(),
                input.excluded_fields.as_deref(),
            );
            let value = sorted_object(&Value::Object(filtered));
            Ok(serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned()))
        }
        CanonicalizationMode::MypayRawBody | CanonicalizationMode::RawBody => input
            .raw_body
            .as_deref()
            .map(|raw| String::from_utf8_lossy(raw).into_owned())
            .ok_or(CanonicalError::MissingRawBody),
    }
}

/// Convenience wrapper that fills only the fields.
pub fn canonicalize_with(
    mode: CanonicalizationMode,
    fields: Map<String, Value>,
) -> Result<String, CanonicalError> {
    canonicalize(
        mode,
        &CanonicalizationInput {
            fields,
            ..CanonicalizationInput::default()
        },
    )
}

/// Case-insensitive include/exclude filter; exclusion wins.
#[must_use]
pub fn filter_fields(
    fields: &Map<String, Value>,
    included_fields: Option<&[String]>,
    excluded_fields: Option<&[String]>,
) -> Map<String, Value> {
    let excluded: std::collections::BTreeSet<String> = excluded_fields
        .unwrap_or_default()
        .iter()
        .map(|field| field.to_lowercase())
        .collect();
    let included: Option<std::collections::BTreeSet<String>> = included_fields
        .filter(|fields| !fields.is_empty())
        .map(|fields| fields.iter().map(|field| field.to_lowercase()).collect());

    let mut output = Map::new();
    for (key, value) in fields {
        let normalized = key.to_lowercase();
        if excluded.contains(&normalized) {
            continue;
        }
        if let Some(included) = &included {
            if !included.contains(&normalized) {
                continue;
            }
        }
        output.insert(key.clone(), value.clone());
    }
    output
}

/// `Object.keys(fields).sort()` with JS UTF-16 code-unit ordering.
#[must_use]
pub fn js_sort_keys(keys: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut keys: Vec<String> = keys.into_iter().collect();
    keys.sort_by(|left, right| js_utf16_cmp(left, right));
    keys
}

#[must_use]
pub fn js_utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn canonical_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => number.to_string(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned()),
    }
}

fn sorted_key_value_amp(fields: &Map<String, Value>) -> String {
    js_sort_keys(fields.keys().cloned())
        .into_iter()
        .filter_map(|key| {
            fields
                .get(&key)
                .map(|value| format!("{key}={}", canonical_value(value)))
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn sorted_values_hash(
    fields: &Map<String, Value>,
    excluded_fields: &[String],
    value_separator: &str,
) -> String {
    let excluded: std::collections::BTreeSet<String> = excluded_fields
        .iter()
        .map(|field| field.to_lowercase())
        .collect();
    js_sort_keys(fields.keys().cloned())
        .into_iter()
        .filter(|key| !excluded.contains(&key.to_lowercase()))
        .filter_map(|key| fields.get(&key).map(canonical_value))
        .collect::<Vec<_>>()
        .join(value_separator)
}

fn read_field_path<'a>(fields: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    if let Some(value) = fields.get(path) {
        return Some(value);
    }
    let mut segment_iter = path.split('.');
    let first = segment_iter.next()?;
    let mut current = fields.get(first)?;
    for segment in segment_iter {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn render_template(template: &str, fields: &Map<String, Value>) -> String {
    let bytes = template.as_bytes();
    let mut output = String::with_capacity(template.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'{' {
            let (open_len, close) = if bytes.get(index + 1) == Some(&b'{') {
                (2, "}}")
            } else {
                (1, "}")
            };
            let start = index + open_len;
            if let Some(relative_end) = template[start..].find(close) {
                let key = &template[start..start + relative_end];
                if !key.is_empty()
                    && key.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
                    })
                {
                    if let Some(value) = read_field_path(fields, key) {
                        output.push_str(&canonical_value(value));
                    }
                    index = start + relative_end + close.len();
                    continue;
                }
            }
        }
        let ch = template[index..].chars().next().unwrap_or('{');
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn sorted_object(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted_object).collect()),
        Value::Object(map) => {
            let mut output = Map::new();
            for key in js_sort_keys(map.keys().cloned()) {
                if let Some(entry) = map.get(&key) {
                    output.insert(key, sorted_object(entry));
                }
            }
            // JS enumerates canonical array indices numerically first after any object rebuild.
            Value::Object(reorder_array_indices(output))
        }
        other => other.clone(),
    }
}

fn reorder_array_indices(map: Map<String, Value>) -> Map<String, Value> {
    fn is_index(key: &str) -> bool {
        !key.is_empty()
            && key.len() <= 10
            && (key == "0" || !key.starts_with('0'))
            && key.bytes().all(|byte| byte.is_ascii_digit())
            && key.parse::<u64>().is_ok_and(|value| value <= 4_294_967_294)
    }
    let mut indices: Vec<(String, Value)> = Vec::new();
    let mut strings: Vec<(String, Value)> = Vec::new();
    for (key, value) in map {
        if is_index(&key) {
            indices.push((key, value));
        } else {
            strings.push((key, value));
        }
    }
    indices.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(u64::MAX));
    let mut output = Map::new();
    for (key, value) in indices.into_iter().chain(strings) {
        output.insert(key, value);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn sorted_key_value_amp_sorts_like_js() {
        let input = CanonicalizationInput {
            fields: fields(json!({"b": 2, "a": "x", "C": null})),
            ..CanonicalizationInput::default()
        };
        assert_eq!(
            canonicalize(CanonicalizationMode::SortedKeyValueAmp, &input).expect("ok"),
            "C=&a=x&b=2"
        );
    }

    #[test]
    fn json_canonical_sorts_recursively() {
        let input = CanonicalizationInput {
            fields: fields(json!({"b": {"z": 1, "a": 2}, "a": [{"y": 1, "x": 2}]})),
            ..CanonicalizationInput::default()
        };
        assert_eq!(
            canonicalize(CanonicalizationMode::JsonCanonical, &input).expect("ok"),
            r#"{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}"#
        );
    }

    #[test]
    fn template_supports_double_and_single_braces() {
        let input = CanonicalizationInput {
            fields: fields(json!({"amount": "10.0000", "nested": {"id": 7}})),
            template_string: Some("{{amount}}|{nested.id}|{missing}".to_owned()),
            ..CanonicalizationInput::default()
        };
        assert_eq!(
            canonicalize(CanonicalizationMode::TemplateString, &input).expect("ok"),
            "10.0000|7|"
        );
    }

    #[test]
    fn excluded_fields_win() {
        let input = CanonicalizationInput {
            fields: fields(json!({"amount": "1", "hashed": "x"})),
            excluded_fields: Some(vec!["HASHED".to_owned()]),
            ..CanonicalizationInput::default()
        };
        assert_eq!(
            canonicalize(CanonicalizationMode::SortedValuesHash, &input).expect("ok"),
            "1"
        );
    }

    #[test]
    fn utf16_sort_differs_from_scalar_order() {
        // U+FFFD (UTF-16 FF FD) sorts after U+1F600 (D83D DE00).
        assert_eq!(js_utf16_cmp("\u{1F600}", "\u{FFFD}"), Ordering::Less);
        assert_eq!(js_utf16_cmp("\u{FFFD}", "\u{1F600}"), Ordering::Greater);
    }
}
