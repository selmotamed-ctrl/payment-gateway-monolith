//! JavaScript number formatting (`Number#toString`) via `ryu-js`.
//!
//! Used where a handler emits a JS number that may be fractional (route-health percentages,
//! report engine KPIs). Money never goes through this module.

#![forbid(unsafe_code)]

use ryu_js::Buffer;

/// Format a finite f64 exactly like `String(value)` in JavaScript.
#[must_use]
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity"
        } else {
            "Infinity"
        }
        .to_owned();
    }
    if value == 0.0 {
        // JavaScript has no "-0" in String(value).
        return "0".to_owned();
    }
    let mut buffer = Buffer::new();
    buffer.format_finite(value).to_owned()
}

/// A JSON number wrapper that serialises with JavaScript formatting.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JsNumber(pub f64);

impl serde::Serialize for JsNumber {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_f64(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_js_examples() {
        assert_eq!(js_number_to_string(1.0), "1");
        assert_eq!(js_number_to_string(1.5), "1.5");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(0.0000001), "1e-7");
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_to_string(-0.0), "0");
    }
}
