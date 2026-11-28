//! JavaScript object key ordering.
//!
//! JavaScript enumerates canonical array-index keys (`"0"`, `"1"`, … up to `2^32 - 2`) first in
//! ascending numeric order, then all other string keys in insertion order. PostgreSQL `jsonb`
//! returns its own order, so any dynamic map that reaches the wire must be re-ordered.
//!
//! Chapter 2 §13.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

/// A canonical array index: decimal digits, no leading zero (except `"0"`), `<= 2^32 - 2`.
#[must_use]
pub fn is_array_index(key: &str) -> bool {
    if key.is_empty() || key.len() > 10 {
        return false;
    }
    if key.len() > 1 && key.starts_with('0') {
        return false;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    key.parse::<u64>().is_ok_and(|index| index <= 4_294_967_294)
}

/// Re-order `value` recursively (objects only; array element order is preserved).
#[must_use]
pub fn js_object_order(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut indices: Vec<(&String, &Value)> = Vec::new();
            let mut strings: Vec<(&String, &Value)> = Vec::new();
            for (key, entry) in map {
                if is_array_index(key) {
                    indices.push((key, entry));
                } else {
                    strings.push((key, entry));
                }
            }
            indices.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(u64::MAX));
            let mut ordered = Map::with_capacity(map.len());
            for (key, entry) in indices.into_iter().chain(strings) {
                ordered.insert(key.clone(), js_object_order(entry));
            }
            Value::Object(ordered)
        }
        Value::Array(items) => Value::Array(items.iter().map(js_object_order).collect()),
        other => other.clone(),
    }
}

/// Re-order and serialise. Used at the HTTP boundary for every dynamic map.
#[must_use]
pub fn js_object_order_string(value: &Value) -> String {
    serde_json::to_string(&js_object_order(value)).unwrap_or_else(|_| "null".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integer_like_keys_come_first_in_numeric_order() {
        let value = json!({"b": 1, "10": 2, "2": 3, "a": 4, "0": 5});
        assert_eq!(
            js_object_order_string(&value),
            r#"{"0":5,"2":3,"10":2,"b":1,"a":4}"#
        );
    }

    #[test]
    fn non_canonical_indices_are_strings() {
        let value = json!({"01": 1, "4294967295": 2, "4294967294": 3});
        assert_eq!(
            js_object_order_string(&value),
            r#"{"4294967294":3,"01":1,"4294967295":2}"#
        );
    }
}
