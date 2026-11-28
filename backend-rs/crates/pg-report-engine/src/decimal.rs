//! Decimal transforms with decimal.js precision (`precision: 40`, `ROUND_HALF_UP`).
//!
//! Port of `core-back/lib/reportEngineSdk/compiler/TransformPipelineExecutor.ts` (formulas and
//! `toDecimalPlaces`) and of the BigInt `round` pipe in
//! `core-back/engine/transforms/TransformPipeline.ts:195` (modes `NONE`/`NEAREST`/`UP`/`DOWN`).
//!
//! Money invariant: never a float. Computed values are emitted as plain decimal strings with no
//! exponent and no trailing zeros, exactly like decimal.js `toFixed()` without an argument.
//! Division is computed by `bigdecimal` (100 significant digits, more than decimal.js's 40) and
//! then rounded HALF_UP at the transform's scale, so every value a report spec can hold matches
//! the TS engine at the emitted precision.

#![forbid(unsafe_code)]

use std::str::FromStr;

use bigdecimal::BigDecimal;
use serde_json::{Map, Value};

use crate::spec::Formula;

/// decimal.js `precision: 40`. Division by `bigdecimal` uses its own default (100 digits), which
/// exceeds this, so the 40-digit contract is never the limiting factor.
pub const PRECISION: u32 = 40;
/// `DIVISION_SCALE`: fractional division and share results are rounded to 10 places.
pub const DIVISION_SCALE: u32 = 10;
/// `VARIANCE_BPS` results are rounded to whole basis points.
pub const VARIANCE_BPS_SCALE: u32 = 0;

/// The `round` pipe modes (`SPEC_AMOUNT_ROUNDING`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundMode {
    /// Leave the value untouched.
    None,
    /// Half away from zero.
    Nearest,
    /// Away from zero when any discarded digit is non-zero.
    Up,
    /// Toward zero (truncate).
    Down,
}

impl RoundMode {
    /// `NONE` / `NEAREST` / `UP` / `DOWN`.
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::Nearest => "NEAREST",
            Self::Up => "UP",
            Self::Down => "DOWN",
        }
    }

    /// Parses the wire value; `None` for anything outside the four modes (`parseDecimal` caller
    /// rejects the pipe in TS).
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "NONE" => Some(Self::None),
            "NEAREST" => Some(Self::Nearest),
            "UP" => Some(Self::Up),
            "DOWN" => Some(Self::Down),
            _ => None,
        }
    }
}

/// `toDecimalOrNull`: `null`/`undefined`/`""` and non-numeric text are null; booleans are null.
#[must_use]
pub fn parse_decimal(value: &Value) -> Option<BigDecimal> {
    match value {
        Value::Null | Value::Bool(_) => None,
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Some(BigDecimal::from(integer))
            } else if let Some(integer) = number.as_u64() {
                Some(BigDecimal::from(integer))
            } else {
                number
                    .as_f64()
                    .filter(|float| float.is_finite())
                    .and_then(|float| BigDecimal::from_str(&format!("{float}")).ok())
            }
        }
        Value::String(text) => parse_decimal_str(text),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// Parses a decimal literal (`^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$`).
#[must_use]
pub fn parse_decimal_str(text: &str) -> Option<BigDecimal> {
    let trimmed = text.trim();
    if trimmed.is_empty() || !is_decimal_literal(trimmed) {
        return None;
    }
    BigDecimal::from_str(trimmed).ok()
}

fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if text.starts_with('+') || text.starts_with('-') {
        index = 1;
    }
    let mut digits_before = 0;
    while index < bytes.len() && bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        digits_before += 1;
    }
    let mut digits_after = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while index < bytes.len() && bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            digits_after += 1;
        }
    }
    if digits_before == 0 && digits_after == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(byte) if *byte == b'e' || *byte == b'E') {
        index += 1;
        if matches!(bytes.get(index), Some(byte) if *byte == b'+' || *byte == b'-') {
            index += 1;
        }
        let mut exponent_digits = 0;
        while index < bytes.len() && bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            exponent_digits += 1;
        }
        if exponent_digits == 0 {
            return false;
        }
    }
    index == bytes.len()
}

/// `decimalString(value)` = `toFixed()`: plain notation, no exponent, trailing zeros trimmed.
#[must_use]
pub fn decimal_string(value: &BigDecimal) -> String {
    trim_decimal(&plain_string(value))
}

/// `BigDecimal`'s `Display` switches to scientific notation for small magnitudes; decimal.js
/// `toFixed()` never does. Guard the scale so a hostile spec cannot make us allocate gigabytes.
fn plain_string(value: &BigDecimal) -> String {
    let (_, scale) = value.as_bigint_and_exponent();
    if scale.abs() > 1_000 {
        value.to_string()
    } else {
        value.to_plain_string()
    }
}

fn trim_decimal(text: &str) -> String {
    let text = text.trim();
    if !text.contains('.') {
        return if text == "-0" {
            "0".to_owned()
        } else {
            text.to_owned()
        };
    }
    let mut trimmed = text.trim_end_matches('0');
    trimmed = trimmed.trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" || trimmed == "-0" {
        "0".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn split_decimal(text: &str) -> (bool, String, String) {
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (integer, fraction) = match rest.split_once('.') {
        Some((integer, fraction)) => (integer, fraction),
        None => (rest, ""),
    };
    let integer = if integer.is_empty() { "0" } else { integer };
    (negative, integer.to_owned(), fraction.to_owned())
}

fn increment_digits(digits: &mut Vec<u8>) {
    for index in (0..digits.len()).rev() {
        if let Some(digit) = digits.get_mut(index) {
            if *digit < 9 {
                *digit += 1;
                return;
            }
            *digit = 0;
        }
    }
    digits.insert(0, 1);
}

/// Rounds a plain decimal string to `places` decimal places with the given mode.
fn round_plain(text: &str, places: u32, mode: RoundMode) -> String {
    let (negative, integer, fraction) = split_decimal(text);
    let places = places as usize;
    if fraction.len() <= places {
        return trim_decimal(text);
    }
    let kept: String = fraction.chars().take(places).collect();
    let rest: Vec<char> = fraction.chars().skip(places).collect();
    let increment = match mode {
        RoundMode::None | RoundMode::Down => false,
        RoundMode::Up => rest.iter().any(|digit| *digit != '0'),
        RoundMode::Nearest => rest.first().is_some_and(|first| *first >= '5'),
    };

    let mut digits: Vec<u8> = Vec::with_capacity(integer.len() + places);
    digits.extend(
        integer
            .bytes()
            .filter(u8::is_ascii_digit)
            .map(|byte| byte - b'0'),
    );
    digits.extend(
        kept.bytes()
            .filter(u8::is_ascii_digit)
            .map(|byte| byte - b'0'),
    );
    if increment {
        increment_digits(&mut digits);
    }
    let digits_text: String = digits
        .iter()
        .map(|digit| char::from(b'0' + *digit))
        .collect();
    let (integer_part, fraction_part) = if places == 0 {
        (digits_text, String::new())
    } else if digits_text.len() <= places {
        let padding = "0".repeat(places - digits_text.len());
        ("0".to_owned(), format!("{padding}{digits_text}"))
    } else {
        let split = digits_text.len() - places;
        let integer_part = digits_text.get(..split).unwrap_or("0").to_owned();
        let fraction_part = digits_text.get(split..).unwrap_or("").to_owned();
        (integer_part, fraction_part)
    };
    let magnitude = if fraction_part.is_empty() {
        integer_part
    } else {
        format!("{integer_part}.{fraction_part}")
    };
    let nonzero = magnitude
        .chars()
        .any(|character| character != '0' && character != '.');
    let signed = if negative && nonzero {
        format!("-{magnitude}")
    } else {
        magnitude
    };
    trim_decimal(&signed)
}

/// The `round` pipe (`TransformPipeline.ts:658`).
#[must_use]
pub fn round_decimal(value: &BigDecimal, mode: RoundMode, places: u32) -> String {
    match mode {
        RoundMode::None => decimal_string(value),
        _ => round_plain(&plain_string(value), places, mode),
    }
}

fn is_zero(value: &BigDecimal) -> bool {
    value == &BigDecimal::from(0_i64)
}

/// `SAFE_DIVIDE`: `left / right` at 10 places, `"0"` when the divisor is zero (TS).
#[must_use]
pub fn safe_divide(left: &BigDecimal, right: &BigDecimal) -> String {
    divide_to(left, right, DIVISION_SCALE).unwrap_or_else(|| "0".to_owned())
}

/// Division rounded HALF_UP to `places`; `None` when the divisor is zero.
#[must_use]
pub fn divide_to(left: &BigDecimal, right: &BigDecimal, places: u32) -> Option<String> {
    if is_zero(right) {
        return None;
    }
    let quotient = left.clone() / right.clone();
    Some(round_decimal(&quotient, RoundMode::Nearest, places))
}

/// `PERCENTAGE_SHARE`: `left / total * 100` at 10 places, `"0"` for a zero total.
#[must_use]
pub fn percentage_share(left: &BigDecimal, total: &BigDecimal) -> String {
    if is_zero(total) {
        return "0".to_owned();
    }
    let ratio = left.clone() / total.clone() * BigDecimal::from(100_i64);
    round_decimal(&ratio, RoundMode::Nearest, DIVISION_SCALE)
}

/// `VARIANCE_BPS`: `(left - right) / right * 10_000` at 0 places, `"0"` for a zero right side.
#[must_use]
pub fn variance_bps(left: &BigDecimal, right: &BigDecimal) -> String {
    if is_zero(right) {
        return "0".to_owned();
    }
    let ratio = (left.clone() - right.clone()) / right.clone() * BigDecimal::from(10_000_i64);
    round_decimal(&ratio, RoundMode::Nearest, VARIANCE_BPS_SCALE)
}

/// The port plan's name for `VARIANCE_BPS`: `(left - right) / right * 10_000` at 0 places.
#[must_use]
pub fn percent_bps(left: &BigDecimal, right: &BigDecimal) -> String {
    variance_bps(left, right)
}

/// Applies a `COMPUTE_COLUMN` formula. `None` mirrors the TS `null` result (missing operand).
#[must_use]
pub fn apply_formula(
    formula: Formula,
    left: Option<&BigDecimal>,
    right: Option<&BigDecimal>,
    total_for_share: &BigDecimal,
) -> Option<String> {
    match formula {
        Formula::Add => Some(decimal_string(&(left?.clone() + right?.clone()))),
        Formula::Subtract => Some(decimal_string(&(left?.clone() - right?.clone()))),
        Formula::Multiply => Some(decimal_string(&(left?.clone() * right?.clone()))),
        Formula::SafeDivide => Some(safe_divide(left?, right?)),
        Formula::PercentageShare => Some(percentage_share(left?, total_for_share)),
        Formula::VarianceBps => Some(variance_bps(left?, right?)),
        Formula::Unknown => None,
    }
}

/// `rows.reduce((acc, row) => acc.plus(toDecimalOrNull(row[column]) ?? 0), 0)`.
#[must_use]
pub fn sum_column(rows: &[Map<String, Value>], column: &str) -> BigDecimal {
    let mut total = BigDecimal::from(0_i64);
    for row in rows {
        if let Some(value) = row.get(column) {
            if let Some(decimal) = parse_decimal(value) {
                total += decimal;
            }
        }
    }
    total
}

/// `String(value)` with the TS `?? ""` treatment of null.
fn text_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// One `COMPARE_WITH_ASSET` comparison for a single field: the live value (`target`), the asset
/// value (`expected`) and their signed difference (`variance`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CompareOutcome {
    /// The live dataset value, when there is a live row.
    pub target: Option<String>,
    /// The comparison asset value.
    pub expected: Option<String>,
    /// `target - expected` (or `-expected` for a missing live row).
    pub variance: Option<String>,
    /// True when the values differ by more than `tolerance_minor` (or are not comparable).
    pub out_of_tolerance: bool,
}

/// The TS comparison rules (`TransformPipelineExecutor.ts` `compareRow`):
/// numeric pairs compare with a tolerance, a missing live row counts the expected value as the
/// variance and is always out of tolerance, everything else compares as exact text.
#[must_use]
pub fn compare_field(
    present: bool,
    actual: Option<&Value>,
    expected: Option<&Value>,
    tolerance_minor: &BigDecimal,
) -> CompareOutcome {
    let actual_decimal = actual.and_then(parse_decimal);
    let expected_decimal = expected.and_then(parse_decimal);

    if present {
        if let (Some(actual_value), Some(expected_value)) =
            (actual_decimal.as_ref(), expected_decimal.as_ref())
        {
            let delta = actual_value.clone() - expected_value.clone();
            return CompareOutcome {
                target: Some(decimal_string(actual_value)),
                expected: Some(decimal_string(expected_value)),
                variance: Some(decimal_string(&delta)),
                out_of_tolerance: delta.abs() > *tolerance_minor,
            };
        }
        let actual_text = actual.map_or_else(String::new, text_of);
        let expected_text = expected.map_or_else(String::new, text_of);
        let mismatch = actual_text != expected_text;
        return CompareOutcome {
            target: non_empty(actual_text),
            expected: non_empty(expected_text),
            variance: None,
            out_of_tolerance: mismatch,
        };
    }

    if let Some(expected_value) = expected_decimal.as_ref() {
        return CompareOutcome {
            target: None,
            expected: Some(decimal_string(expected_value)),
            variance: Some(decimal_string(&(-expected_value.clone()))),
            out_of_tolerance: true,
        };
    }
    CompareOutcome {
        target: None,
        expected: expected.and_then(|value| non_empty(text_of(value))),
        variance: None,
        out_of_tolerance: true,
    }
}

/// The output columns TS writes for a compared field: the optional `output_field`, then
/// `<dataset_field>_expected` and `<dataset_field>_variance`.
#[must_use]
pub fn compare_columns(
    dataset_field: &str,
    output_field: Option<&str>,
    outcome: &CompareOutcome,
) -> Vec<(String, Option<String>)> {
    let mut columns = Vec::with_capacity(3);
    if let Some(field) = output_field {
        columns.push((field.to_owned(), outcome.expected.clone()));
    }
    columns.push((
        format!("{dataset_field}_expected"),
        outcome.expected.clone(),
    ));
    columns.push((
        format!("{dataset_field}_variance"),
        outcome.variance.clone(),
    ));
    columns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decimal(text: &str) -> BigDecimal {
        parse_decimal_str(text).expect("decimal fixture")
    }

    fn value(text: &str) -> Value {
        json!(text)
    }

    #[test]
    fn parsing_matches_to_decimal_or_null() {
        assert_eq!(parse_decimal(&json!("12.5")), Some(decimal("12.5")));
        assert_eq!(parse_decimal(&json!(" 7 ")), Some(decimal("7")));
        assert_eq!(parse_decimal(&json!(3)), Some(decimal("3")));
        assert_eq!(parse_decimal(&json!(0.25)), Some(decimal("0.25")));
        assert_eq!(parse_decimal(&json!("")), None);
        assert_eq!(parse_decimal(&json!("abc")), None);
        assert_eq!(parse_decimal(&json!(true)), None);
        assert_eq!(parse_decimal(&Value::Null), None);
        assert_eq!(parse_decimal(&json!(["1"])), None);
    }

    #[test]
    fn decimal_string_is_plain_and_trimmed() {
        assert_eq!(decimal_string(&decimal("1.500")), "1.5");
        assert_eq!(decimal_string(&decimal("100.00")), "100");
        assert_eq!(decimal_string(&decimal("-0.0")), "0");
        assert_eq!(decimal_string(&decimal("0.0000001")), "0.0000001");
    }

    #[test]
    fn percentages_and_basis_points_round_half_up() {
        assert_eq!(percentage_share(&decimal("25"), &decimal("200")), "12.5");
        assert_eq!(
            percentage_share(&decimal("1"), &decimal("3")),
            "33.3333333333"
        );
        assert_eq!(
            percentage_share(&decimal("2"), &decimal("3")),
            "66.6666666667"
        );
        assert_eq!(percentage_share(&decimal("5"), &decimal("0")), "0");
        assert_eq!(variance_bps(&decimal("110"), &decimal("100")), "1000");
        assert_eq!(variance_bps(&decimal("100"), &decimal("110")), "-909");
        assert_eq!(variance_bps(&decimal("5"), &decimal("0")), "0");
        assert_eq!(percent_bps(&decimal("110"), &decimal("100")), "1000");
    }

    #[test]
    fn safe_divide_uses_ten_places() {
        assert_eq!(safe_divide(&decimal("1"), &decimal("3")), "0.3333333333");
        assert_eq!(safe_divide(&decimal("10"), &decimal("4")), "2.5");
        assert_eq!(safe_divide(&decimal("1"), &decimal("0")), "0");
        assert_eq!(divide_to(&decimal("1"), &decimal("0"), 2), None);
    }

    #[test]
    fn round_modes_follow_the_bigint_pipe() {
        assert_eq!(round_decimal(&decimal("10.4"), RoundMode::Nearest, 0), "10");
        assert_eq!(round_decimal(&decimal("10.5"), RoundMode::Nearest, 0), "11");
        assert_eq!(
            round_decimal(&decimal("-10.5"), RoundMode::Nearest, 0),
            "-11"
        );
        assert_eq!(
            round_decimal(&decimal("-3.5"), RoundMode::Nearest, 1),
            "-3.5"
        );
        assert_eq!(round_decimal(&decimal("10.1"), RoundMode::Up, 0), "11");
        assert_eq!(round_decimal(&decimal("-10.1"), RoundMode::Up, 0), "-11");
        assert_eq!(round_decimal(&decimal("10.9"), RoundMode::Down, 0), "10");
        assert_eq!(round_decimal(&decimal("-10.9"), RoundMode::Down, 0), "-10");
        assert_eq!(
            round_decimal(&decimal("10.449"), RoundMode::None, 2),
            "10.449"
        );
        assert_eq!(
            round_decimal(&decimal("76.255"), RoundMode::Nearest, 2),
            "76.26"
        );
        assert_eq!(
            round_decimal(&decimal("9.995"), RoundMode::Nearest, 2),
            "10"
        );
        assert_eq!(round_decimal(&decimal("0.004"), RoundMode::Nearest, 2), "0");
        assert_eq!(
            round_decimal(&decimal("-0.004"), RoundMode::Nearest, 2),
            "0"
        );
        assert_eq!(RoundMode::from_wire("NEAREST"), Some(RoundMode::Nearest));
        assert_eq!(RoundMode::from_wire("BANKERS"), None);
        assert_eq!(RoundMode::Up.as_wire(), "UP");
    }

    #[test]
    fn formulas_match_the_executor() {
        let total = decimal("250");
        assert_eq!(
            apply_formula(
                Formula::Add,
                Some(&decimal("0.1")),
                Some(&decimal("0.2")),
                &total
            ),
            Some("0.3".to_owned())
        );
        assert_eq!(
            apply_formula(
                Formula::Multiply,
                Some(&decimal("1.5")),
                Some(&decimal("4")),
                &total
            ),
            Some("6".to_owned())
        );
        assert_eq!(
            apply_formula(Formula::PercentageShare, Some(&decimal("50")), None, &total),
            Some("20".to_owned())
        );
        assert_eq!(
            apply_formula(Formula::Add, None, Some(&decimal("1")), &total),
            None
        );
        assert_eq!(
            apply_formula(Formula::Unknown, Some(&decimal("1")), None, &total),
            None
        );
    }

    #[test]
    fn sum_column_uses_zero_for_missing_values() {
        let rows = vec![
            json!({"volume": "10.5"})
                .as_object()
                .cloned()
                .expect("object"),
            json!({"volume": 2}).as_object().cloned().expect("object"),
            json!({"other": 9}).as_object().cloned().expect("object"),
        ];
        assert_eq!(decimal_string(&sum_column(&rows, "volume")), "12.5");
        assert_eq!(decimal_string(&sum_column(&rows, "missing")), "0");
    }

    #[test]
    fn the_ts_transform_pipeline_golden_row() {
        // `executeTransformPipeline` output for rows volume 1 / 3 / 0 (total 4) with right operand 3.
        let total = decimal("4");
        let rows = [
            (decimal("1"), "25", "-6667", "0.3333333333"),
            (decimal("3"), "75", "0", "1"),
            (decimal("0"), "0", "-10000", "0"),
        ];
        for (volume, share, bps, ratio) in rows {
            assert_eq!(percentage_share(&volume, &total), share);
            assert_eq!(variance_bps(&volume, &decimal("3")), bps);
            assert_eq!(safe_divide(&volume, &decimal("3")), ratio);
        }
    }

    #[test]
    fn compare_with_asset_reports_target_expected_and_variance() {
        let tolerance = decimal("10");
        let within = compare_field(true, Some(&value("100")), Some(&value("90")), &tolerance);
        assert_eq!(within.target.as_deref(), Some("100"));
        assert_eq!(within.expected.as_deref(), Some("90"));
        assert_eq!(within.variance.as_deref(), Some("10"));
        assert!(!within.out_of_tolerance);

        let outside = compare_field(true, Some(&value("100")), Some(&value("89")), &tolerance);
        assert!(outside.out_of_tolerance);

        let missing = compare_field(false, None, Some(&value("90")), &tolerance);
        assert_eq!(missing.target, None);
        assert_eq!(missing.expected.as_deref(), Some("90"));
        assert_eq!(missing.variance.as_deref(), Some("-90"));
        assert!(missing.out_of_tolerance);

        let text = compare_field(true, Some(&value("LYD")), Some(&value("USD")), &tolerance);
        assert_eq!(text.variance, None);
        assert!(text.out_of_tolerance);

        let columns = compare_columns("volume", Some("amount_expected"), &within);
        assert_eq!(
            columns[0],
            ("amount_expected".to_owned(), Some("90".to_owned()))
        );
        assert_eq!(
            columns[1],
            ("volume_expected".to_owned(), Some("90".to_owned()))
        );
        assert_eq!(
            columns[2],
            ("volume_variance".to_owned(), Some("10".to_owned()))
        );
    }
}
