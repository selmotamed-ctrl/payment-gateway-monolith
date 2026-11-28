//! Deterministic spec hashing.
//!
//! Port of `core-back/lib/reportEngineSdk/specHash.ts`.
//!
//! The spec is stored in a PostgreSQL `jsonb` column, and `jsonb` does not keep the key order of
//! the document it was given, so the hash must be a function of the content only: every object's
//! keys are sorted recursively (JavaScript `Object.keys(...).sort()`, i.e. UTF-16 code-unit
//! order) and arrays keep their order. `spec_sha256` is then the lower-case hex SHA-256 of that
//! canonical JSON, reproducible from the stored row.
//!
//! Known limitation (documented for parity): numbers are written like `JSON.stringify` for all
//! values a report spec realistically holds (integers, monetary decimals), but Rust's `f64`
//! formatting differs from ECMAScript at the extremes (`1e-7` / `1e21`), where this port emits
//! plain decimal notation. A spec containing such a number would hash differently. No stored spec
//! in the released fixtures does.

#![forbid(unsafe_code)]

use std::cmp::Ordering;

use serde_json::Value;

use crate::sha256;

/// JavaScript's key order: UTF-16 code units, ascending.
#[must_use]
pub fn cmp_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `JSON.stringify(sortKeys(value))`.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// SHA-256 (hex) of a report spec's content; reproducible from the stored `spec_json`.
#[must_use]
pub fn spec_hash(spec: &Value) -> String {
    sha256::digest_hex(canonical_json(spec).as_bytes())
}

/// Parses a stored `spec_json` string and hashes it. `None` when the text is not JSON.
#[must_use]
pub fn spec_hash_from_str(spec_json: &str) -> Option<String> {
    serde_json::from_str::<Value>(spec_json)
        .ok()
        .map(|value| spec_hash(&value))
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| cmp_utf16(left.as_str(), right.as_str()));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key.as_str(), out);
                out.push(':');
                if let Some(entry) = map.get(key.as_str()) {
                    write_value(entry, out);
                }
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` string escaping: quote, backslash and control characters; UTF-8 kept as is.
fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// ECMAScript number text for the values a spec holds.
fn write_number(number: &serde_json::Number, out: &mut String) {
    if let Some(value) = number.as_i64() {
        out.push_str(&value.to_string());
        return;
    }
    if let Some(value) = number.as_u64() {
        out.push_str(&value.to_string());
        return;
    }
    if let Some(value) = number.as_f64() {
        if value.is_finite() {
            // `JSON.stringify(1.0)` is `1`; `Display` for f64 also prints `1`.
            out.push_str(&format!("{value}"));
            return;
        }
    }
    // serde_json cannot hold NaN/Infinity; JSON.stringify writes null if it ever did.
    out.push_str("null");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_keys_are_sorted_recursively_and_arrays_keep_order() {
        let left = json!({"b": 1, "a": {"z": [3, 1, 2], "y": true}, "c": null});
        let right = json!({"c": null, "a": {"y": true, "z": [3, 1, 2]}, "b": 1});
        assert_eq!(
            canonical_json(&left),
            r#"{"a":{"y":true,"z":[3,1,2]},"b":1,"c":null}"#
        );
        assert_eq!(canonical_json(&left), canonical_json(&right));
        assert_eq!(spec_hash(&left), spec_hash(&right));
    }

    #[test]
    fn key_order_uses_utf16_code_units_not_utf8_bytes() {
        // U+10000 is a surrogate pair (D800 DC00) and sorts BEFORE U+FFFD in JavaScript,
        // while UTF-8 byte order puts U+FFFD first.
        let value = json!({"\u{FFFD}": 1, "\u{10000}": 2});
        assert_eq!(canonical_json(&value), "{\"\u{10000}\":2,\"\u{FFFD}\":1}");
        assert_eq!(cmp_utf16("\u{10000}", "\u{FFFD}"), Ordering::Less);
    }

    #[test]
    fn numbers_render_like_json_stringify_for_spec_values() {
        let value = json!({"whole": 1.0, "fraction": 0.5, "integer": 800, "negative": -12.25, "big": 4_000_000_000u64});
        assert_eq!(
            canonical_json(&value),
            r#"{"big":4000000000,"fraction":0.5,"integer":800,"negative":-12.25,"whole":1}"#
        );
    }

    #[test]
    fn strings_are_escaped_and_utf8_is_preserved() {
        let value = json!({"text": "خطأ \"quoted\"\nline\t\\"});
        assert_eq!(
            canonical_json(&value),
            "{\"text\":\"خطأ \\\"quoted\\\"\\nline\\t\\\\\"}"
        );
    }

    #[test]
    fn spec_hash_is_stable_and_hex() {
        let spec = json!({"spec_kind": "REPORT_DESCRIPTOR", "spec_version": "1.0", "datasets": [], "sections": []});
        let first = spec_hash(&spec);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(first, spec_hash(&spec));
        assert_ne!(
            first,
            spec_hash(
                &json!({"datasets": [], "sections": [], "spec_version": "1.0", "spec_kind": "REPORT_DESCRIPTOR", "x": 1})
            )
        );
        assert_eq!(spec_hash_from_str(&spec.to_string()), Some(first));
        assert_eq!(spec_hash_from_str("not json"), None);
    }

    #[test]
    fn the_released_spec_hash_golden_vector() {
        // Computed by the TS SDK (`specContentSha256`) for this exact descriptor; a regression in
        // the canonical JSON (key order, escaping, number text) changes it.
        let spec = json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "spec_version": "1.0",
            "report": {"code": "ops-daily", "audience_scope": "BACKOFFICE_INTERNAL"},
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID", "cards": [{"dataset_id": "daily", "value_field": "volume"}]}]
        });
        assert_eq!(
            spec_hash(&spec),
            "7942fcd2c1e4f80df61cb7caaedb6801564eb05ab99be9d0ddbca49d284a4f3f"
        );
    }

    #[test]
    fn a_changed_value_changes_the_hash() {
        let before = json!({"datasets": [{"dataset_id": "daily", "limit": 1000}]});
        let after = json!({"datasets": [{"dataset_id": "daily", "limit": 1001}]});
        assert_ne!(spec_hash(&before), spec_hash(&after));
    }
}
