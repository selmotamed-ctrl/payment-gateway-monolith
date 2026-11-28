//! The closed transform library.
//!
//! Port of `core-back/engine/transforms/TransformPipeline.ts` (842 lines). Every operation, every
//! argument rule and every error message is reproduced; money operations keep an arbitrary-precision
//! decimal (`num-bigint`) and never touch a floating-point value.
//!
//! | Group | Operations |
//! | :--- | :--- |
//! | Money (BigInt) | `scale`, `MUL_INT`, `DIV_DECIMAL`, `round`, `format_decimal`, `to_int` |
//! | Strings | `to_string`, `concat`, `template`, `lowercase`, `uppercase`, `trim`, `pad_left`, `pad_right`, `substring`, `mask`, `prepend`, `arabic_digits_to_ascii`, `phone_normalize` |
//! | JSON | `sort_keys`, `values_only`, `join_pairs` |
//! | Dates | `format_date`, `epoch_seconds`, `epoch_millis` |
//! | Random | `uuid`, `numeric_random` |
//! | Encoding | `base64_encode`, `hex_lower`, `hex_upper`, `url_encode`, `json_encode`, `xml_escape` |
//! | Crypto | `sha256`, `sha512`, `hmac_sha256`, `hmac_sha512`, `rsa_sha256_sign` |
//!
//! `to_number` exists for non-money values; a monetary step output (`SETTLED_AMOUNT`,
//! `PROVIDER_FEE`) refuses it at validation time and again at run time (`MONEY_OUTPUT_FLOAT_FORBIDDEN`).
//!
//! Recorded deviations (see `README.md`):
//!
//! - `format_date` accepts RFC 3339, `YYYY-MM-DD` and `YYYY-MM-DD HH:MM:SS` strings and epoch
//!   milliseconds; JavaScript `new Date()` accepts a wider set.
//! - `substring`/`mask`/`pad_*` count UTF-16 code units like JavaScript. Slicing through a surrogate
//!   pair cannot produce a lone surrogate in a Rust `String`, so the halves are replaced lossily.
//! - `join_pairs` sorts with the UTF-16 comparator instead of ICU `localeCompare`.

#![forbid(unsafe_code)]

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::Tz;
use num_bigint::BigInt;
use pg_crypto::canonical::js_sort_keys;
use pg_crypto::{decode_key, encode_output, rsa_sha256_sign, KeyEncoding, OutputEncoding};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::EngineError;
use crate::ports::{Clock, Rng};
use crate::selector::stringify_value;

/// `TRANSFORM_OPERATIONS` in declaration order.
pub const TRANSFORM_OPERATIONS: [&str; 39] = [
    "scale",
    "MUL_INT",
    "DIV_DECIMAL",
    "round",
    "format_decimal",
    "to_int",
    "to_number",
    "to_string",
    "concat",
    "template",
    "lowercase",
    "uppercase",
    "trim",
    "pad_left",
    "pad_right",
    "substring",
    "mask",
    "prepend",
    "arabic_digits_to_ascii",
    "phone_normalize",
    "sort_keys",
    "values_only",
    "join_pairs",
    "format_date",
    "epoch_seconds",
    "epoch_millis",
    "uuid",
    "numeric_random",
    "base64_encode",
    "hex_lower",
    "hex_upper",
    "url_encode",
    "json_encode",
    "xml_escape",
    "sha256",
    "sha512",
    "hmac_sha256",
    "hmac_sha512",
    "rsa_sha256_sign",
];

/// `MONETARY_OUTPUT_STORES`.
pub const MONETARY_OUTPUT_STORES: [&str; 2] = ["SETTLED_AMOUNT", "PROVIDER_FEE"];

/// `TransformPipe`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransformPipe {
    pub op: String,
    #[serde(default)]
    pub args: Vec<Value>,
}

impl TransformPipe {
    #[must_use]
    pub fn new(op: impl Into<String>, args: Vec<Value>) -> Self {
        Self {
            op: op.into(),
            args,
        }
    }

    #[must_use]
    pub fn no_args(op: impl Into<String>) -> Self {
        Self::new(op, Vec::new())
    }

    #[must_use]
    pub fn scale(factor: u64) -> Self {
        Self::new("scale", vec![Value::from(factor)])
    }

    #[must_use]
    pub fn mul_int(factor: u64) -> Self {
        Self::new("MUL_INT", vec![Value::from(factor)])
    }

    #[must_use]
    pub fn div_decimal(divisor: &str, places: u32) -> Self {
        Self::new(
            "DIV_DECIMAL",
            vec![Value::String(divisor.to_owned()), Value::from(places)],
        )
    }

    #[must_use]
    pub fn round(mode: &str, places: u32) -> Self {
        Self::new(
            "round",
            vec![Value::String(mode.to_owned()), Value::from(places)],
        )
    }

    #[must_use]
    pub fn format_decimal(places: u32) -> Self {
        Self::new("format_decimal", vec![Value::from(places)])
    }

    #[must_use]
    pub fn to_int() -> Self {
        Self::no_args("to_int")
    }

    #[must_use]
    pub fn to_string() -> Self {
        Self::no_args("to_string")
    }

    #[must_use]
    pub fn phone_normalize(style: &str) -> Self {
        Self::new("phone_normalize", vec![Value::String(style.to_owned())])
    }

    #[must_use]
    pub fn format_date(pattern: &str, timezone: &str) -> Self {
        Self::new(
            "format_date",
            vec![
                Value::String(pattern.to_owned()),
                Value::String(timezone.to_owned()),
            ],
        )
    }

    #[must_use]
    pub fn template(pattern: &str) -> Self {
        Self::new("template", vec![Value::String(pattern.to_owned())])
    }
}

/// A secret reference resolver (`TransformSecretResolver`).
pub trait SecretResolver: Send + Sync {
    fn resolve_secret(&self, reference: &str) -> Result<Vec<u8>, String>;
}

/// The per-call context (`TransformContext`).
pub struct TransformContext<'a> {
    pub template_values: &'a Map<String, Value>,
    pub secret_resolver: Option<&'a dyn SecretResolver>,
    pub hash_output_encoding: Option<OutputEncoding>,
}

impl<'a> TransformContext<'a> {
    #[must_use]
    pub fn with_values(values: &'a Map<String, Value>) -> Self {
        Self {
            template_values: values,
            secret_resolver: None,
            hash_output_encoding: None,
        }
    }
}

/// One validation diagnostic (`TransformValidationError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformValidationError {
    pub index: usize,
    pub op: String,
    pub message: String,
    pub path: Option<String>,
}

impl TransformValidationError {
    fn new(index: usize, op: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            index,
            op: op.into(),
            message: message.into(),
            path: None,
        }
    }
}

impl std::fmt::Display for TransformValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.op, self.message)
    }
}

/// A transform usage site (`TransformUsage`).
#[derive(Debug, Clone)]
pub struct TransformUsage {
    pub path: String,
    pub pipes: Vec<TransformPipe>,
    pub store_as: Option<String>,
}

/// The pipeline. The clock feeds `format_date`/`epoch_*` when the value is absent; the RNG feeds
/// `uuid` and `numeric_random`.
#[derive(Clone)]
pub struct TransformPipeline {
    clock: Arc<dyn Clock>,
    rng: Arc<dyn Rng>,
}

impl TransformPipeline {
    #[must_use]
    pub fn new(clock: Arc<dyn Clock>, rng: Arc<dyn Rng>) -> Self {
        Self { clock, rng }
    }

    /// `validate(pipes)`.
    #[must_use]
    pub fn validate(&self, pipes: &[TransformPipe]) -> Vec<TransformValidationError> {
        let mut errors = Vec::new();
        for (index, pipe) in pipes.iter().enumerate() {
            let op = pipe.op.as_str();
            if !TRANSFORM_OPERATIONS.contains(&op) {
                errors.push(TransformValidationError::new(
                    index,
                    op,
                    "Transform operation is not in the closed library",
                ));
                continue;
            }
            let args = &pipe.args;
            let require_count = |errors: &mut Vec<TransformValidationError>, count: usize| {
                if args.len() != count {
                    errors.push(TransformValidationError::new(
                        index,
                        op,
                        format!("Operation expects {count} argument(s)"),
                    ));
                }
            };
            let require_integer =
                |errors: &mut Vec<TransformValidationError>, position: usize, positive: bool| {
                    let candidate = args.get(position);
                    let valid = candidate.is_some_and(|value| {
                        value.as_u64().is_some_and(|number| {
                            (!positive || number > 0) && number <= i64::MAX as u64
                        }) || value.as_i64().is_some_and(|number| !positive || number > 0)
                    });
                    if !valid {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            format!(
                                "Argument {} must be {}integer",
                                position + 1,
                                if positive { "a positive " } else { "an " }
                            ),
                        ));
                    }
                };
            match op {
                "scale" | "MUL_INT" => {
                    require_count(&mut errors, 1);
                    require_integer(&mut errors, 0, true);
                }
                "DIV_DECIMAL" => {
                    require_count(&mut errors, 2);
                    if !args.first().is_some_and(is_decimal_compatible) {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Divisor must be decimal-compatible",
                        ));
                    }
                    require_integer(&mut errors, 1, true);
                }
                "round" => {
                    if args.is_empty() || args.len() > 2 {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Operation expects a rounding mode and an optional decimal place count",
                        ));
                    }
                    let mode = args.first().map(stringify_value).unwrap_or_default();
                    if !matches!(mode.as_str(), "NONE" | "NEAREST" | "UP" | "DOWN") {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Rounding mode is invalid",
                        ));
                    }
                    if args.len() == 2 {
                        let places = args.get(1).and_then(Value::as_u64);
                        if places.is_none_or(|places| places > 18) {
                            errors.push(TransformValidationError::new(
                                index,
                                op,
                                "Decimal place count must be an integer between 0 and 18",
                            ));
                        }
                    }
                }
                "format_decimal" => {
                    require_count(&mut errors, 1);
                    require_integer(&mut errors, 0, false);
                }
                "to_int"
                | "to_number"
                | "to_string"
                | "lowercase"
                | "uppercase"
                | "trim"
                | "arabic_digits_to_ascii"
                | "sort_keys"
                | "values_only"
                | "epoch_seconds"
                | "epoch_millis"
                | "uuid"
                | "base64_encode"
                | "hex_lower"
                | "hex_upper"
                | "url_encode"
                | "json_encode"
                | "xml_escape"
                | "sha256"
                | "sha512" => {
                    require_count(&mut errors, 0);
                }
                "concat" => {
                    if args.is_empty() {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Concat requires at least one value",
                        ));
                    }
                }
                "template" => {
                    require_count(&mut errors, 1);
                    if !args.first().is_some_and(Value::is_string) {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Template pattern must be a string",
                        ));
                    }
                }
                "pad_left" | "pad_right" => {
                    require_count(&mut errors, 2);
                    require_integer(&mut errors, 0, false);
                    let valid = args
                        .get(1)
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.chars().count() == 1);
                    if !valid {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Padding character must contain one character",
                        ));
                    }
                }
                "substring" => {
                    if args.len() != 1 && args.len() != 2 {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Substring expects one or two indexes",
                        ));
                    }
                    require_integer(&mut errors, 0, false);
                    if args.len() == 2 {
                        require_integer(&mut errors, 1, false);
                    }
                }
                "mask" => {
                    require_count(&mut errors, 2);
                    require_integer(&mut errors, 0, false);
                    require_integer(&mut errors, 1, false);
                }
                "prepend" | "rsa_sha256_sign" => {
                    require_count(&mut errors, 1);
                    if !args
                        .first()
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty())
                    {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Secret reference must be a non-empty string",
                        ));
                    }
                }
                "hmac_sha256" | "hmac_sha512" => {
                    if args.len() != 1 && args.len() != 2 {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Operation expects a key reference and an optional key encoding",
                        ));
                    }
                    if !args
                        .first()
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty())
                    {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Secret reference must be a non-empty string",
                        ));
                    }
                    if args.len() == 2
                        && !args
                            .get(1)
                            .and_then(Value::as_str)
                            .is_some_and(|text| matches!(text, "UTF8" | "HEX" | "BASE64"))
                    {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Key encoding must be UTF8, HEX, or BASE64",
                        ));
                    }
                }
                "phone_normalize" => {
                    require_count(&mut errors, 1);
                    if !args
                        .first()
                        .and_then(Value::as_str)
                        .is_some_and(|style| matches!(style, "LOCAL_09" | "INTL_218" | "E164"))
                    {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Phone normalization style is invalid",
                        ));
                    }
                }
                "join_pairs" => {
                    require_count(&mut errors, 2);
                    if !args.iter().all(Value::is_string) {
                        errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Join separators must be strings",
                        ));
                    }
                }
                "format_date" => {
                    require_count(&mut errors, 2);
                    match (
                        args.first().and_then(Value::as_str),
                        args.get(1).and_then(Value::as_str),
                    ) {
                        (Some(_), Some(timezone)) => {
                            if timezone.parse::<Tz>().is_err() {
                                errors.push(TransformValidationError::new(
                                    index,
                                    op,
                                    "Timezone is invalid",
                                ));
                            }
                        }
                        _ => errors.push(TransformValidationError::new(
                            index,
                            op,
                            "Date pattern and timezone must be strings",
                        )),
                    }
                }
                "numeric_random" => {
                    require_count(&mut errors, 1);
                    require_integer(&mut errors, 0, true);
                }
                _ => {}
            }
        }
        errors
    }

    /// Refuses the pipes when [`Self::validate`] reports an error.
    pub fn assert_valid(&self, pipes: &[TransformPipe]) -> Result<(), EngineError> {
        let errors = self.validate(pipes);
        if errors.is_empty() {
            return Ok(());
        }
        Err(transform_error(errors))
    }

    /// Validates the pipes of one step output against its store.
    #[must_use]
    pub fn validate_for_store(
        &self,
        pipes: &[TransformPipe],
        store_as: Option<&str>,
    ) -> Vec<TransformValidationError> {
        let mut errors = self.validate(pipes);
        if store_as.is_some_and(|store| MONETARY_OUTPUT_STORES.contains(&store)) {
            for (index, pipe) in pipes.iter().enumerate() {
                if pipe.op == "to_number" {
                    errors.push(TransformValidationError::new(
                        index,
                        "to_number",
                        "Money outputs must not use to_number; money is persisted as a decimal, never as a native float",
                    ));
                }
            }
        }
        errors
    }

    /// Refuses the pipes for the given store.
    pub fn assert_valid_for_store(
        &self,
        pipes: &[TransformPipe],
        store_as: Option<&str>,
    ) -> Result<(), EngineError> {
        let errors = self.validate_for_store(pipes, store_as);
        if errors.is_empty() {
            return Ok(());
        }
        Err(transform_error(errors))
    }

    /// `apply(value, pipes)`: runs every pipe in order.
    pub fn apply(
        &self,
        value: Value,
        pipes: &[TransformPipe],
        context: &TransformContext<'_>,
    ) -> Result<Value, EngineError> {
        self.assert_valid(pipes)?;
        let mut current = value;
        for pipe in pipes {
            current = self.apply_one(current, pipe, context)?;
        }
        Ok(current)
    }

    fn apply_one(
        &self,
        value: Value,
        pipe: &TransformPipe,
        context: &TransformContext<'_>,
    ) -> Result<Value, EngineError> {
        let args = &pipe.args;
        match pipe.op.as_str() {
            "scale" | "MUL_INT" => {
                let decimal = parse_decimal(&value)?;
                let factor = integer_arg(args, 0)?;
                Ok(Value::String(decimal_to_plain_string(multiply_integer(
                    &decimal, factor,
                ))))
            }
            "DIV_DECIMAL" => {
                let decimal = parse_decimal(&value)?;
                let places = integer_arg(args, 1)?;
                let places = u32::try_from(places)
                    .map_err(|_| transform_value_error("Decimal places cannot be negative"))?;
                Ok(Value::String(decimal_to_plain_string(divide_decimal(
                    &decimal,
                    args.first().unwrap_or(&Value::Null),
                    places,
                )?)))
            }
            "round" => {
                let decimal = parse_decimal(&value)?;
                let mode = args.first().and_then(Value::as_str).unwrap_or("NONE");
                let places = if args.len() > 1 {
                    u32::try_from(integer_arg(args, 1)?)
                        .map_err(|_| transform_value_error("Decimal places cannot be negative"))?
                } else {
                    0
                };
                let mode = RoundMode::parse(mode)
                    .ok_or_else(|| transform_value_error("Rounding mode is invalid"))?;
                Ok(Value::String(decimal_to_plain_string(round_decimal(
                    &decimal, mode, places,
                )?)))
            }
            "format_decimal" => {
                let places = u32::try_from(integer_arg(args, 0)?)
                    .map_err(|_| transform_value_error("Decimal places cannot be negative"))?;
                Ok(Value::String(format_decimal_places(&value, places)?))
            }
            "to_int" => {
                let decimal = parse_decimal(&value)?;
                let rounded = round_decimal(&decimal, RoundMode::Down, 0)?;
                let text = rounded.coefficient.to_string();
                let number = text
                    .parse::<i64>()
                    .map_err(|_| transform_value_error("Integer value is out of range"))?;
                let number = if rounded.negative { -number } else { number };
                Ok(Value::from(number))
            }
            "to_number" => {
                let text = match &value {
                    Value::String(text) => text.trim().to_owned(),
                    Value::Number(number) => number.to_string(),
                    Value::Bool(boolean) => boolean.to_string(),
                    Value::Null => "0".to_owned(),
                    other => stringify_value(other),
                };
                let parsed = text.parse::<f64>().unwrap_or(f64::NAN);
                Ok(serde_json::Number::from_f64(parsed).map_or(Value::Null, Value::Number))
            }
            "to_string" => Ok(Value::String(stringify_value(&value))),
            "concat" => {
                let mut output = stringify_value(&value);
                for argument in args {
                    output.push_str(&stringify_value(argument));
                }
                Ok(Value::String(output))
            }
            "template" => {
                let pattern = args.first().and_then(Value::as_str).unwrap_or("");
                Ok(Value::String(crate::selector::render_template_with(
                    pattern,
                    |key| {
                        context
                            .template_values
                            .get(key)
                            .cloned()
                            .unwrap_or(Value::Null)
                    },
                )))
            }
            "lowercase" => Ok(Value::String(stringify_value(&value).to_lowercase())),
            "uppercase" => Ok(Value::String(stringify_value(&value).to_uppercase())),
            "trim" => Ok(Value::String(js_trim(&stringify_value(&value)).to_owned())),
            "pad_left" | "pad_right" => {
                let text = stringify_value(&value);
                let length = usize_arg(args, 0)?;
                let character = args
                    .get(1)
                    .and_then(Value::as_str)
                    .and_then(|text| text.chars().next())
                    .ok_or_else(|| transform_value_error("Padding character is missing"))?;
                Ok(Value::String(pad(
                    &text,
                    length,
                    character,
                    pipe.op == "pad_left",
                )))
            }
            "substring" => {
                let text = stringify_value(&value);
                let start = signed_arg(args, 0)?;
                let end = if args.len() > 1 {
                    Some(signed_arg(args, 1)?)
                } else {
                    None
                };
                Ok(Value::String(utf16_slice(&text, start, end)))
            }
            "mask" => {
                let text = stringify_value(&value);
                let visible_start = usize_arg(args, 0)?;
                let visible_end = usize_arg(args, 1)?;
                let units: Vec<u16> = text.encode_utf16().collect();
                if visible_start + visible_end >= units.len() {
                    return Ok(Value::String("*".repeat(units.len())));
                }
                let mut masked: Vec<u16> = Vec::with_capacity(units.len());
                masked.extend_from_slice(&units[..visible_start]);
                masked.extend(std::iter::repeat_n(
                    '*' as u16,
                    units.len() - visible_start - visible_end,
                ));
                masked.extend_from_slice(&units[units.len() - visible_end..]);
                Ok(Value::String(String::from_utf16_lossy(&masked)))
            }
            "prepend" => {
                let reference = args.first().and_then(Value::as_str).unwrap_or("");
                let secret = resolve_secret(context, reference)?;
                let mut output = String::from_utf8_lossy(&secret).into_owned();
                output.push_str(&stringify_value(&value));
                Ok(Value::String(output))
            }
            "arabic_digits_to_ascii" => {
                let mut text = stringify_value(&value);
                const ARABIC: [char; 10] = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
                const EASTERN: [char; 10] = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
                for (digit, (arabic, eastern)) in ARABIC.iter().zip(EASTERN.iter()).enumerate() {
                    text = text.replace(*arabic, &digit.to_string());
                    text = text.replace(*eastern, &digit.to_string());
                }
                Ok(Value::String(text))
            }
            "phone_normalize" => {
                let style = args.first().and_then(Value::as_str).unwrap_or("E164");
                Ok(Value::String(normalize_phone(&value, style)?))
            }
            "sort_keys" => Ok(sorted_object(&value)),
            "values_only" => match &value {
                Value::Object(map) => Ok(Value::Array(map.values().cloned().collect())),
                _ => Err(transform_value_error("Operation requires an object")),
            },
            "join_pairs" => {
                let Value::Object(map) = &value else {
                    return Err(transform_value_error("Operation requires an object"));
                };
                let separator = args.first().and_then(Value::as_str).unwrap_or("");
                let joiner = args.get(1).and_then(Value::as_str).unwrap_or("");
                let keys = js_sort_keys(map.keys().cloned());
                let pairs: Vec<String> = keys
                    .into_iter()
                    .map(|key| {
                        let value = map.get(&key).map(stringify_value).unwrap_or_default();
                        format!("{key}{separator}{value}")
                    })
                    .collect();
                Ok(Value::String(pairs.join(joiner)))
            }
            "format_date" => {
                let pattern = args.first().and_then(Value::as_str).unwrap_or("");
                let timezone = args.get(1).and_then(Value::as_str).unwrap_or("UTC");
                let date = parse_date_value(&value)?.unwrap_or_else(|| self.clock.now());
                Ok(Value::String(format_date(date, pattern, timezone)?))
            }
            "epoch_seconds" => {
                let date = parse_date_value(&value)?.unwrap_or_else(|| self.clock.now());
                Ok(Value::from(date.timestamp()))
            }
            "epoch_millis" => {
                let date = parse_date_value(&value)?.unwrap_or_else(|| self.clock.now());
                Ok(Value::from(date.timestamp_millis()))
            }
            "uuid" => Ok(Value::String(self.rng.uuid().to_string())),
            "numeric_random" => {
                let length = usize_arg(args, 0)?;
                let mut output = String::with_capacity(length);
                for _ in 0..length {
                    output.push(char::from(b'0' + (self.rng.int(10) % 10) as u8));
                }
                Ok(Value::String(output))
            }
            "base64_encode" => Ok(Value::String(
                BASE64.encode(stringify_value(&value).as_bytes()),
            )),
            "hex_lower" => Ok(Value::String(hex::encode(stringify_value(&value)))),
            "hex_upper" => Ok(Value::String(hex::encode_upper(stringify_value(&value)))),
            "url_encode" => Ok(Value::String(crate::selector::encode_uri_component(
                &stringify_value(&value),
            ))),
            "json_encode" => Ok(Value::String(
                serde_json::to_string(&value).unwrap_or_default(),
            )),
            "xml_escape" => Ok(Value::String(crate::selector::xml_escape(&value))),
            "sha256" => Ok(Value::String(pg_crypto::sha256_hex(
                stringify_value(&value).as_bytes(),
            ))),
            "sha512" => Ok(Value::String(hex::encode(pg_crypto::sha512(
                stringify_value(&value).as_bytes(),
            )))),
            "hmac_sha256" | "hmac_sha512" => {
                let reference = args.first().and_then(Value::as_str).unwrap_or("");
                let secret = resolve_secret(context, reference)?;
                let encoding = key_encoding(args.get(1).and_then(Value::as_str));
                let key = decode_key(&String::from_utf8_lossy(&secret), encoding)
                    .map_err(|error| transform_value_error(error.to_string()))?;
                let data = stringify_value(&value);
                let digest = if pipe.op == "hmac_sha256" {
                    pg_crypto::hmac_sha256(&key, data.as_bytes())
                } else {
                    pg_crypto::hmac_sha512(&key, data.as_bytes())
                };
                Ok(Value::String(encode_output(
                    &digest,
                    context
                        .hash_output_encoding
                        .unwrap_or(OutputEncoding::HexLower),
                )))
            }
            "rsa_sha256_sign" => {
                let reference = args.first().and_then(Value::as_str).unwrap_or("");
                let secret = resolve_secret(context, reference)?;
                let output = context
                    .hash_output_encoding
                    .unwrap_or(OutputEncoding::Base64);
                Ok(Value::String(
                    rsa_sha256_sign(&secret, stringify_value(&value).as_bytes(), output)
                        .map_err(|error| transform_value_error(error.to_string()))?,
                ))
            }
            other => Err(transform_value_error(format!(
                "Transform operation '{other}' is not in the closed library"
            ))),
        }
    }
}

fn transform_error(errors: Vec<TransformValidationError>) -> EngineError {
    EngineError::with_code(
        400,
        "TRANSFORM_INVALID",
        errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; "),
    )
}

fn transform_value_error(message: impl Into<String>) -> EngineError {
    EngineError::with_code(400, "TRANSFORM_ERROR", message)
}

fn resolve_secret(context: &TransformContext<'_>, reference: &str) -> Result<Vec<u8>, EngineError> {
    let resolver = context
        .secret_resolver
        .ok_or_else(|| transform_value_error("A secret resolver is required for this transform"))?;
    resolver
        .resolve_secret(reference)
        .map_err(transform_value_error)
}

fn key_encoding(raw: Option<&str>) -> KeyEncoding {
    match raw.unwrap_or("UTF8") {
        "HEX" => KeyEncoding::Hex,
        "BASE64" => KeyEncoding::Base64,
        _ => KeyEncoding::Utf8,
    }
}

/// Validates every transform usage of a definition (`validateTransformUsage`).
#[must_use]
pub fn validate_transform_usage(
    pipeline: &TransformPipeline,
    usages: &[TransformUsage],
) -> Vec<TransformValidationError> {
    let mut errors = Vec::new();
    for usage in usages {
        for error in pipeline.validate_for_store(&usage.pipes, usage.store_as.as_deref()) {
            errors.push(TransformValidationError {
                path: Some(usage.path.clone()),
                ..error
            });
        }
    }
    errors
}

fn is_decimal_compatible(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_))
}

fn integer_arg(args: &[Value], position: usize) -> Result<u64, EngineError> {
    let value = args
        .get(position)
        .ok_or_else(|| transform_value_error(format!("Argument {} is missing", position + 1)))?;
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }
    if let Some(number) = value.as_i64() {
        if number >= 0 {
            return Ok(number as u64);
        }
    }
    Err(transform_value_error(format!(
        "Argument {} must be a non-negative integer",
        position + 1
    )))
}

fn usize_arg(args: &[Value], position: usize) -> Result<usize, EngineError> {
    usize::try_from(integer_arg(args, position)?)
        .map_err(|_| transform_value_error("Argument is too large"))
}

fn signed_arg(args: &[Value], position: usize) -> Result<i64, EngineError> {
    args.get(position).and_then(Value::as_i64).ok_or_else(|| {
        transform_value_error(format!("Argument {} must be an integer", position + 1))
    })
}

// ---------------------------------------------------------------------------------------------
// Decimal arithmetic on BigInt
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct DecimalValue {
    negative: bool,
    coefficient: BigInt,
    scale: u32,
}

const MAX_DECIMAL_DIGITS: usize = 4096;

fn parse_decimal(value: &Value) -> Result<DecimalValue, EngineError> {
    let literal = match value {
        Value::String(text) => text.trim().to_owned(),
        Value::Number(number) => number.to_string(),
        Value::Bool(_) | Value::Null | Value::Array(_) | Value::Object(_) => {
            return Err(transform_value_error(
                "Decimal value must be a string or a number",
            ));
        }
    };
    parse_decimal_literal(&literal)
}

fn parse_decimal_literal(literal: &str) -> Result<DecimalValue, EngineError> {
    let trimmed = literal.trim();
    let (sign, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1, &trimmed[1..]),
        Some(b'+') => (1, &trimmed[1..]),
        Some(_) => (1, trimmed),
        None => return Err(transform_value_error("Invalid decimal value ''")),
    };
    let mut parts = rest.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(transform_value_error(format!(
            "Invalid decimal value '{trimmed}'"
        )));
    }
    if whole.len() + fraction.len() > MAX_DECIMAL_DIGITS {
        return Err(transform_value_error("Decimal value is too large"));
    }
    let digits = format!("{whole}{fraction}");
    let coefficient = BigInt::parse_bytes(digits.as_bytes(), 10)
        .ok_or_else(|| transform_value_error(format!("Invalid decimal value '{trimmed}'")))?;
    Ok(DecimalValue {
        negative: sign < 0,
        coefficient,
        scale: u32::try_from(fraction.len()).unwrap_or(0),
    })
}

fn ten_pow(exponent: u32) -> BigInt {
    BigInt::from(10).pow(exponent)
}

fn decimal_to_plain_string(value: DecimalValue) -> String {
    let sign = if value.negative && value.coefficient != BigInt::from(0) {
        "-"
    } else {
        ""
    };
    if value.scale == 0 {
        return format!("{sign}{}", value.coefficient);
    }
    let digits = value.coefficient.to_string();
    let padded = format!("{digits:0>width$}", width = (value.scale as usize) + 1);
    let split = padded.len() - value.scale as usize;
    let (whole, fraction) = padded.split_at(split);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    }
}

fn rescale(value: &DecimalValue, scale: u32) -> DecimalValue {
    if scale == value.scale {
        return value.clone();
    }
    let coefficient = if scale > value.scale {
        &value.coefficient * ten_pow(scale - value.scale)
    } else {
        &value.coefficient / ten_pow(value.scale - scale)
    };
    DecimalValue {
        negative: value.negative,
        coefficient,
        scale,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoundMode {
    None,
    Nearest,
    Up,
    Down,
}

impl RoundMode {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "NONE" => Some(Self::None),
            "NEAREST" => Some(Self::Nearest),
            "UP" => Some(Self::Up),
            "DOWN" => Some(Self::Down),
            _ => None,
        }
    }
}

fn round_decimal(
    value: &DecimalValue,
    mode: RoundMode,
    places: u32,
) -> Result<DecimalValue, EngineError> {
    if mode == RoundMode::None {
        return Ok(value.clone());
    }
    if places > 18 {
        return Err(transform_value_error("Decimal places cannot exceed 18"));
    }
    let divisor = ten_pow(value.scale);
    let numerator = &value.coefficient * ten_pow(places);
    let negative = value.negative;
    let absolute = if numerator < BigInt::from(0) {
        -numerator
    } else {
        numerator
    };
    let mut quotient = &absolute / &divisor;
    let remainder = &absolute % &divisor;
    let zero = BigInt::from(0);
    let two = BigInt::from(2);
    match mode {
        RoundMode::Nearest => {
            if &remainder * &two >= divisor {
                quotient += BigInt::from(1);
            }
        }
        RoundMode::Up => {
            if remainder > zero {
                quotient += BigInt::from(1);
            }
        }
        RoundMode::Down | RoundMode::None => {}
    }
    Ok(DecimalValue {
        negative: negative && quotient != BigInt::from(0),
        coefficient: quotient,
        scale: places,
    })
}

fn multiply_integer(value: &DecimalValue, factor: u64) -> DecimalValue {
    DecimalValue {
        negative: value.negative,
        coefficient: &value.coefficient * BigInt::from(factor),
        scale: value.scale,
    }
}

fn divide_decimal(
    value: &DecimalValue,
    divisor: &Value,
    places: u32,
) -> Result<DecimalValue, EngineError> {
    if places > 18 {
        return Err(transform_value_error("Decimal places cannot exceed 18"));
    }
    let divisor = parse_decimal(divisor)?;
    if divisor.coefficient == BigInt::from(0) {
        return Err(transform_value_error("Decimal divisor cannot be zero"));
    }
    let numerator = &value.coefficient * ten_pow(places + divisor.scale);
    let denominator = &divisor.coefficient * ten_pow(value.scale);
    let quotient = &numerator / &denominator;
    let remainder = &numerator % &denominator;
    let rounded = if &remainder * BigInt::from(2) >= denominator {
        quotient + BigInt::from(1)
    } else {
        quotient
    };
    Ok(DecimalValue {
        negative: value.negative != divisor.negative,
        coefficient: rounded,
        scale: places,
    })
}

fn format_decimal_places(value: &Value, places: u32) -> Result<String, EngineError> {
    let decimal = parse_decimal(value)?;
    let negative = decimal.negative && decimal.coefficient != BigInt::from(0);
    let scaled = rescale(&decimal, places);
    let digits = format!(
        "{:0>width$}",
        scaled.coefficient,
        width = (places as usize) + 1
    );
    let split = digits.len() - places as usize;
    let (whole, fraction) = digits.split_at(split);
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = if places > 0 {
        format!(".{fraction}")
    } else {
        String::new()
    };
    Ok(format!(
        "{}{whole}{fraction}",
        if negative { "-" } else { "" }
    ))
}

// ---------------------------------------------------------------------------------------------
// JS-compatible string helpers
// ---------------------------------------------------------------------------------------------

fn js_trim(text: &str) -> &str {
    text.trim_matches(|character: char| is_js_whitespace(character))
}

fn is_js_whitespace(character: char) -> bool {
    character.is_whitespace() || character == '\u{FEFF}'
}

fn pad(text: &str, length: usize, character: char, left: bool) -> String {
    let units = text.encode_utf16().count();
    if units >= length {
        return text.to_owned();
    }
    let padding: String = std::iter::repeat_n(character, length - units).collect();
    if left {
        format!("{padding}{text}")
    } else {
        format!("{text}{padding}")
    }
}

fn utf16_slice(text: &str, start: i64, end: Option<i64>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let length = units.len() as i64;
    let normalize = |index: i64| {
        if index < 0 {
            (length + index).max(0)
        } else {
            index.min(length)
        }
    };
    let start = normalize(start);
    let end = end.map_or(length, normalize).max(start);
    String::from_utf16_lossy(&units[start as usize..end as usize])
}

fn normalize_phone(value: &Value, style: &str) -> Result<String, EngineError> {
    let original = stringify_value(value);
    let mut digits: String = original.chars().filter(char::is_ascii_digit).collect();
    if digits.starts_with("00") {
        digits = digits[2..].to_owned();
    }
    if style == "LOCAL_09" {
        if digits.starts_with("218") {
            digits = digits[3..].to_owned();
        }
        if digits.starts_with('0') {
            digits = digits[1..].to_owned();
        }
        if digits.len() != 9 {
            return Err(transform_value_error(
                "Phone number cannot be normalized to local 09 format",
            ));
        }
        return Ok(format!("0{digits}"));
    }
    if digits.starts_with('0') {
        digits = format!("218{}", &digits[1..]);
    }
    if !digits.starts_with("218") {
        digits = format!("218{digits}");
    }
    if digits.len() != 12 {
        return Err(transform_value_error(
            "Phone number cannot be normalized to Libyan format",
        ));
    }
    Ok(if style == "INTL_218" {
        digits
    } else {
        format!("+{digits}")
    })
}

fn sorted_object(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted_object).collect()),
        Value::Object(map) => {
            let mut output = Map::new();
            for key in js_sort_keys(map.keys().cloned()) {
                if let Some(value) = map.get(&key) {
                    output.insert(key, sorted_object(value));
                }
            }
            Value::Object(output)
        }
        other => other.clone(),
    }
}

fn parse_date_value(value: &Value) -> Result<Option<DateTime<Utc>>, EngineError> {
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => {
            let millis = number
                .as_i64()
                .ok_or_else(|| transform_value_error("Invalid date value"))?;
            DateTime::<Utc>::from_timestamp_millis(millis)
                .map(Some)
                .ok_or_else(|| transform_value_error("Invalid date value"))
        }
        Value::String(text) => {
            let text = text.trim();
            if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
                return Ok(Some(parsed.with_timezone(&Utc)));
            }
            if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
                return Ok(date.and_hms_opt(0, 0, 0).map(|value| value.and_utc()));
            }
            if let Ok(date) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S") {
                return Ok(Some(date.and_utc()));
            }
            Err(transform_value_error("Invalid date value"))
        }
        _ => Err(transform_value_error("Invalid date value")),
    }
}

fn format_date(date: DateTime<Utc>, pattern: &str, timezone: &str) -> Result<String, EngineError> {
    let timezone: Tz = timezone
        .parse()
        .map_err(|_| transform_value_error("Timezone is invalid"))?;
    let local = date.with_timezone(&timezone);
    let year = format!("{:04}", local.year());
    let month = format!("{:02}", local.month());
    let day = format!("{:02}", local.day());
    let hour = format!("{:02}", local.hour());
    let minute = format!("{:02}", local.minute());
    let second = format!("{:02}", local.second());
    let milliseconds = format!("{:03}", local.timestamp_subsec_millis());
    // The replacement order of `formatDate` is observable (`MM` before `mm`), so it is preserved.
    Ok(pattern
        .replace("YYYY", &year)
        .replace("MM", &month)
        .replace("DD", &day)
        .replace("HH", &hour)
        .replace("mm", &minute)
        .replace("ss", &second)
        .replace("SSS", &milliseconds))
}

/// A decimal string with exactly `places` fraction digits (money formatting helper).
pub fn decimal_string(value: Decimal, places: u32) -> String {
    let places = usize::try_from(places).unwrap_or(0);
    format!("{value:.places$}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;
    use crate::ports::Rng;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TestRng {
        counter: AtomicU32,
    }

    impl Rng for TestRng {
        fn uuid(&self) -> uuid::Uuid {
            uuid::Uuid::nil()
        }
        fn int(&self, max_exclusive: u32) -> u32 {
            self.counter.fetch_add(1, Ordering::SeqCst) % max_exclusive.max(1)
        }
    }

    struct Secrets;

    impl SecretResolver for Secrets {
        fn resolve_secret(&self, reference: &str) -> Result<Vec<u8>, String> {
            match reference {
                "CREDENTIAL.key" => Ok(b"secret".to_vec()),
                "CREDENTIAL.hex" => Ok(b"00ff10".to_vec()),
                other => Err(format!("no secret {other}")),
            }
        }
    }

    fn pipeline() -> TransformPipeline {
        TransformPipeline::new(
            Arc::new(FixedClock::at(1_700_000_000_000)),
            Arc::new(TestRng {
                counter: AtomicU32::new(0),
            }),
        )
    }

    fn empty_context() -> Map<String, Value> {
        Map::new()
    }

    #[test]
    fn money_rounding_uses_bigint_semantics() {
        let pipeline = pipeline();
        let values = empty_context();
        let context = TransformContext::with_values(&values);
        let apply = |value: Value, pipe: TransformPipe| {
            pipeline
                .apply(value, std::slice::from_ref(&pipe), &context)
                .expect("apply")
        };
        // scale: "12.3456" * 1000 = "12345.6", to_int truncates.
        assert_eq!(
            apply(json!("12.3456"), TransformPipe::scale(1000)),
            json!("12345.6")
        );
        assert_eq!(
            apply(json!("12345.6"), TransformPipe::to_int()),
            json!(12345)
        );
        // round NEAREST / UP / DOWN at 2 places.
        assert_eq!(
            apply(json!("1.005"), TransformPipe::round("NEAREST", 2)),
            json!("1.01")
        );
        assert_eq!(
            apply(json!("1.001"), TransformPipe::round("UP", 2)),
            json!("1.01")
        );
        assert_eq!(
            apply(json!("1.009"), TransformPipe::round("DOWN", 2)),
            json!("1")
        );
        assert_eq!(
            apply(json!("1.005"), TransformPipe::round("NONE", 2)),
            json!("1.005")
        );
        // DIV_DECIMAL: 10 / 3 at 4 places = 3.3333 (half-up on the truncated quotient).
        assert_eq!(
            apply(json!("10"), TransformPipe::div_decimal("3", 4)),
            json!("3.3333")
        );
        assert_eq!(
            apply(json!("10"), TransformPipe::div_decimal("2", 2)),
            json!("5")
        );
        // format_decimal pads and truncates.
        assert_eq!(
            apply(json!("12.5"), TransformPipe::format_decimal(2)),
            json!("12.50")
        );
        assert_eq!(
            apply(json!("12.567"), TransformPipe::format_decimal(2)),
            json!("12.56")
        );
        // Negative values keep the sign only when the coefficient is not zero.
        assert_eq!(
            apply(json!("-1.005"), TransformPipe::round("NEAREST", 2)),
            json!("-1.01")
        );
    }

    #[test]
    fn strings_and_templates() {
        let pipeline = pipeline();
        let mut values = Map::new();
        values.insert("reference".to_owned(), json!("ORD-1"));
        values.insert("amount".to_owned(), json!("12.5"));
        let context = TransformContext::with_values(&values);
        let apply = |value: Value, pipe: TransformPipe| {
            pipeline
                .apply(value, std::slice::from_ref(&pipe), &context)
                .expect("apply")
        };
        assert_eq!(
            apply(json!("x"), TransformPipe::template("{reference}/{amount}")),
            json!("ORD-1/12.5")
        );
        assert_eq!(
            apply(json!("  A b  "), TransformPipe::no_args("trim")),
            json!("A b")
        );
        assert_eq!(
            apply(
                json!("7"),
                TransformPipe::new("pad_left", vec![json!(3), json!("0")])
            ),
            json!("007")
        );
        assert_eq!(
            apply(
                json!("abc"),
                TransformPipe::new("substring", vec![json!(1)])
            ),
            json!("bc")
        );
        assert_eq!(
            apply(
                json!("abc"),
                TransformPipe::new("substring", vec![json!(0), json!(-1)])
            ),
            json!("ab")
        );
        assert_eq!(
            apply(
                json!("+218 91 234 5678"),
                TransformPipe::phone_normalize("LOCAL_09")
            ),
            json!("0912345678")
        );
        assert_eq!(
            apply(json!("0912345678"), TransformPipe::phone_normalize("E164")),
            json!("+218912345678")
        );
        assert_eq!(
            apply(
                json!("٩١٢"),
                TransformPipe::no_args("arabic_digits_to_ascii")
            ),
            json!("912")
        );
        assert_eq!(
            apply(
                json!("4111111111111111"),
                TransformPipe::new("mask", vec![json!(4), json!(4)])
            ),
            json!("4111********1111")
        );
        assert_eq!(
            apply(json!("a b"), TransformPipe::no_args("url_encode")),
            json!("a%20b")
        );
        assert_eq!(
            apply(json!("a<b"), TransformPipe::no_args("xml_escape")),
            json!("a&lt;b")
        );
        assert_eq!(
            apply(json!("abc"), TransformPipe::no_args("sha256")),
            json!("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            apply(json!("abc"), TransformPipe::no_args("base64_encode")),
            json!("YWJj")
        );
        assert_eq!(
            apply(
                json!({"b": 1, "a": [2]}),
                TransformPipe::no_args("sort_keys")
            ),
            json!({"a": [2], "b": 1})
        );
        assert_eq!(
            apply(
                json!({"a": 1, "b": 2}),
                TransformPipe::no_args("values_only")
            ),
            json!([1, 2])
        );
        assert_eq!(
            apply(
                json!({"b": 2, "a": 1}),
                TransformPipe::new("join_pairs", vec![json!("="), json!("&")])
            ),
            json!("a=1&b=2")
        );
        assert_eq!(
            apply(
                json!("x"),
                TransformPipe::new("concat", vec![json!("-"), json!(1)])
            ),
            json!("x-1")
        );
        assert_eq!(
            apply(
                json!("1122"),
                TransformPipe::new("mask", vec![json!(4), json!(0)])
            ),
            json!("****")
        );
    }

    #[test]
    fn dates_use_the_requested_timezone() {
        let pipeline = pipeline();
        let values = empty_context();
        let context = TransformContext::with_values(&values);
        // 2023-11-14T22:13:20Z is 2023-11-15 00:13:20 in Africa/Tripoli (UTC+2).
        let formatted = pipeline
            .apply(
                json!("2023-11-14T22:13:20Z"),
                &[TransformPipe::format_date("YYYYMMDDHHmm", "Africa/Tripoli")],
                &context,
            )
            .expect("format");
        assert_eq!(formatted, json!("202311150013"));
        let millis = pipeline
            .apply(
                json!("2023-11-14T22:13:20.123Z"),
                &[TransformPipe::format_date("YYYY-MM-DDTHH:mm:ss.SSS", "UTC")],
                &context,
            )
            .expect("format");
        assert_eq!(millis, json!("2023-11-14T22:13:20.123"));
        assert_eq!(
            pipeline
                .apply(
                    json!(null),
                    &[TransformPipe::no_args("epoch_seconds")],
                    &context
                )
                .expect("epoch"),
            json!(1_700_000_000_i64)
        );
        assert_eq!(
            pipeline
                .apply(
                    json!("2023-11-14T22:13:20Z"),
                    &[TransformPipe::no_args("epoch_millis")],
                    &context
                )
                .expect("epoch"),
            json!(1_700_000_000_000_i64)
        );
        assert_eq!(
            pipeline
                .apply(
                    json!("2023-11-14T22:13:20Z"),
                    &[TransformPipe::format_date("HH:mm", "Not/AZone")],
                    &context
                )
                .expect_err("timezone")
                .code,
            "TRANSFORM_INVALID"
        );
    }

    #[test]
    fn crypto_transforms_use_the_secret_resolver() {
        let pipeline = pipeline();
        let values = empty_context();
        let secrets = Secrets;
        let context = TransformContext {
            template_values: &values,
            secret_resolver: Some(&secrets),
            hash_output_encoding: None,
        };
        assert_eq!(
            pipeline
                .apply(
                    json!("abc"),
                    &[TransformPipe::new(
                        "hmac_sha256",
                        vec![json!("CREDENTIAL.key")]
                    )],
                    &context
                )
                .expect("hmac"),
            json!(hex::encode(pg_crypto::hmac_sha256(b"secret", b"abc")))
        );
        assert_eq!(
            pipeline
                .apply(
                    json!("abc"),
                    &[TransformPipe::new(
                        "hmac_sha256",
                        vec![json!("CREDENTIAL.hex"), json!("HEX")]
                    )],
                    &context
                )
                .expect("hmac hex"),
            json!(hex::encode(pg_crypto::hmac_sha256(
                &[0x00, 0xff, 0x10],
                b"abc"
            )))
        );
        assert_eq!(
            pipeline
                .apply(
                    json!("x"),
                    &[TransformPipe::new("prepend", vec![json!("CREDENTIAL.key")])],
                    &context
                )
                .expect("prepend"),
            json!("secretx")
        );
        let without = TransformContext::with_values(&values);
        assert!(pipeline
            .apply(
                json!("abc"),
                &[TransformPipe::new(
                    "hmac_sha256",
                    vec![json!("CREDENTIAL.key")]
                )],
                &without
            )
            .is_err());
    }

    #[test]
    fn random_operations_are_deterministic_under_the_test_rng() {
        let pipeline = pipeline();
        let values = empty_context();
        let context = TransformContext::with_values(&values);
        assert_eq!(
            pipeline
                .apply(
                    json!(null),
                    &[TransformPipe::new("numeric_random", vec![json!(4)])],
                    &context
                )
                .expect("random"),
            json!("0123")
        );
        assert_eq!(
            pipeline
                .apply(json!(null), &[TransformPipe::no_args("uuid")], &context)
                .expect("uuid"),
            json!("00000000-0000-0000-0000-000000000000")
        );
    }

    #[test]
    fn validation_matches_the_argument_rules() {
        let pipeline = pipeline();
        assert!(pipeline.validate(&[TransformPipe::scale(1000)]).is_empty());
        assert!(!pipeline.validate(&[TransformPipe::scale(0)]).is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::new("scale", vec![])])
            .is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::new("nope", vec![])])
            .is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::new("round", vec![json!("SIDEWAYS")])])
            .is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::new("round", vec![json!("UP"), json!(19)])])
            .is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::new("pad_left", vec![json!(2), json!("ab")])])
            .is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::format_date("YYYY", "America/NotReal")])
            .is_empty());
        assert!(pipeline
            .validate(&[TransformPipe::phone_normalize("E164")])
            .is_empty());
        assert!(!pipeline
            .validate(&[TransformPipe::phone_normalize("NOPE")])
            .is_empty());
    }

    #[test]
    fn monetary_outputs_refuse_to_number() {
        let pipeline = pipeline();
        let pipes = [TransformPipe::no_args("to_number")];
        assert!(pipeline.validate(&pipes).is_empty());
        assert!(pipeline
            .validate_for_store(&pipes, Some("SETTLED_AMOUNT"))
            .iter()
            .any(|error| error.op == "to_number"));
        assert!(pipeline
            .validate_for_store(&pipes, Some("PUBLIC"))
            .is_empty());
        assert!(pipeline
            .assert_valid_for_store(&pipes, Some("PROVIDER_FEE"))
            .is_err());
    }

    #[test]
    fn decimal_parsing_rejects_garbage() {
        assert!(parse_decimal(&json!("1.23")).is_ok());
        assert!(parse_decimal(&json!(1.5)).is_ok());
        assert!(parse_decimal(&json!("abc")).is_err());
        assert!(parse_decimal(&json!("1.2.3")).is_err());
        assert!(parse_decimal(&json!(".")).is_err());
        assert!(parse_decimal(&json!(true)).is_err());
        assert_eq!(
            decimal_to_plain_string(parse_decimal(&json!("001.200")).expect("decimal")),
            "1.2"
        );
        assert_eq!(
            decimal_to_plain_string(parse_decimal(&json!("-0.000")).expect("decimal")),
            "0"
        );
    }
}
