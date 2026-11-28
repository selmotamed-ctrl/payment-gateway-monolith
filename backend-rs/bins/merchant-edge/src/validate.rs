//! Zod-shaped request validation.
//!
//! Port of the merchant edge's use of `zod@4` (`merchant-back/lib/zReady/index.ts`,
//! `merchant-back/api/**`). The public contract is a side effect of validation: zod rejects
//! unknown keys of a `.strict()` object, coerces query strings, applies the Libyan phone
//! normalisation, and the edge turns the resulting issue list into
//! `400 VALIDATION_FAILED { details: issues[] }` (`merchant-back/lib/error/index.ts:47`).
//!
//! The crate has no `regex` dependency on purpose (the workspace does not pin one), so every
//! pattern used by the TypeScript schemas is a named predicate here. That keeps the accepted
//! language explicit and tested instead of copied as an untested string.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

/// One element of a zod issue `path`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathItem {
    Key(String),
    Index(usize),
}

impl PathItem {
    fn to_value(&self) -> Value {
        match self {
            Self::Key(key) => Value::String(key.clone()),
            Self::Index(index) => Value::Number((*index).into()),
        }
    }
}

/// One zod issue: `{ code, path, message, …extra }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub path: Vec<PathItem>,
    pub message: String,
    pub extra: Vec<(&'static str, Value)>,
}

impl Issue {
    #[must_use]
    pub fn new(
        code: &'static str,
        path: Vec<PathItem>,
        message: impl Into<String>,
        extra: Vec<(&'static str, Value)>,
    ) -> Self {
        Self {
            code,
            path,
            message: message.into(),
            extra,
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".to_owned(), Value::String(self.code.to_owned()));
        map.insert(
            "path".to_owned(),
            Value::Array(self.path.iter().map(PathItem::to_value).collect()),
        );
        map.insert("message".to_owned(), Value::String(self.message.clone()));
        for (key, value) in &self.extra {
            map.insert((*key).to_owned(), value.clone());
        }
        Value::Object(map)
    }
}

fn invalid_type(path: Vec<PathItem>, expected: &str, received: &str) -> Issue {
    Issue::new(
        "invalid_type",
        path,
        format!("Invalid input: expected {expected}, received {received}"),
        vec![
            ("expected", Value::String(expected.to_owned())),
            ("received", Value::String(received.to_owned())),
        ],
    )
}

/// JSON `typeof` for the zod message.
#[must_use]
pub fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// A named string format / pattern used by the edge contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pattern {
    Identifier,
    Amount,
    Volume,
    Currency,
    Month,
    Otp,
    MfaCode,
    Email,
    Uuid,
    Digits,
    IsoDate,
    IsoDatePrefix,
    IsoDateTimePrefix,
    OwnershipPercent,
    Website,
    TokenScope,
    Phone,
    DateDigits,
}

impl Pattern {
    /// The zod `format` name reported in the issue (`invalid_format.format`).
    #[must_use]
    pub fn format_name(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Uuid => "uuid",
            Self::Website => "url",
            _ => "regex",
        }
    }

    #[must_use]
    pub fn matches(self, value: &str) -> bool {
        match self {
            Self::Identifier => !value.is_empty() && value.len() <= 64 && is_identifier(value),
            Self::Amount => is_decimal(value, 14, 4),
            Self::Volume => is_decimal(value, 12, 4),
            Self::Currency => value.len() == 3 && value.bytes().all(|b| b.is_ascii_uppercase()),
            Self::Month => is_month(value),
            Self::Otp => {
                (4..=8).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
            }
            Self::MfaCode => value.len() == 6 && value.bytes().all(|b| b.is_ascii_digit()),
            Self::Email => is_email(value),
            Self::Uuid => is_uuid(value),
            Self::Digits => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
            Self::IsoDate => is_iso_date(value),
            Self::IsoDatePrefix => value.len() >= 10 && is_iso_date(&value[..10]),
            Self::IsoDateTimePrefix => is_iso_datetime_prefix(value),
            Self::OwnershipPercent => is_ownership_percent(value),
            Self::Website => is_website(value),
            Self::TokenScope => is_token_scope(value),
            Self::Phone => normalize_libyan_phone(value).is_some(),
            Self::DateDigits => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
        }
    }
}

/// The Libyan mobile phone normalisation of `merchant-back/lib/zReady/index.ts:6-14`.
///
/// `^(?:(?:(?:00|\+)?218)|0)?([9][1-5][0-9]{7})$`, returning group 1.
#[must_use]
pub fn normalize_libyan_phone(value: &str) -> Option<String> {
    let body = if let Some(rest) = value.strip_prefix("00218") {
        rest
    } else if let Some(rest) = value.strip_prefix("+218") {
        rest
    } else if let Some(rest) = value.strip_prefix("218") {
        rest
    } else if let Some(rest) = value.strip_prefix('0') {
        rest
    } else {
        value
    };
    let bytes = body.as_bytes();
    if bytes.len() != 9 {
        return None;
    }
    if bytes[0] != b'9' || !(b'1'..=b'5').contains(&bytes[1]) {
        return None;
    }
    if !bytes[2..].iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(body.to_owned())
}

fn is_identifier(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_decimal(value: &str, max_integer: usize, max_fraction: usize) -> bool {
    let mut parts = value.splitn(2, '.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if integer.is_empty()
        || integer.len() > max_integer
        || !integer.bytes().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    match fraction {
        None => true,
        Some(fraction) => {
            !fraction.is_empty()
                && fraction.len() <= max_fraction
                && fraction.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

fn is_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 7
        || bytes[4] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5].is_ascii_digit()
        || !bytes[6].is_ascii_digit()
    {
        return false;
    }
    matches!(
        (bytes[5], bytes[6]),
        (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2')
    )
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[..4].parse::<i32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

fn is_iso_datetime_prefix(value: &str) -> bool {
    // `^\d{4}-\d{2}-\d{2}T` then a value `Date.parse` accepts (the TS check uses both).
    let bytes = value.as_bytes();
    bytes.len() > 10
        && bytes[10] == b'T'
        && is_iso_date(&value[..10])
        && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn is_ownership_percent(value: &str) -> bool {
    let mut parts = value.splitn(2, '.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if integer.is_empty() || integer.len() > 3 || !integer.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match fraction {
        None => true,
        Some(fraction) => {
            !fraction.is_empty()
                && fraction.len() <= 2
                && fraction.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

/// `z.email()`: one `@`, a non-empty local part and a dotted domain, no whitespace.
fn is_email(value: &str) -> bool {
    if value.len() > 254 || value.contains(char::is_whitespace) {
        return false;
    }
    let mut parts = value.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || local.is_empty() || domain.is_empty() {
        return false;
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    if domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
        || !domain.contains('.')
    {
        return false;
    }
    domain
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn is_token_scope(value: &str) -> bool {
    let Some((resource, action)) = value.split_once(':') else {
        return false;
    };
    let valid = |part: &str| {
        let bytes = part.as_bytes();
        (2..=32).contains(&bytes.len())
            && bytes[0].is_ascii_lowercase()
            && bytes
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
    };
    valid(resource) && valid(action)
}

/// `zWebsite` (`merchant-back/lib/zReady/index.ts:58-68`): http(s) only, dotted hostname.
#[must_use]
pub fn is_website(value: &str) -> bool {
    if value.len() > 200 {
        return false;
    }
    let has_scheme = {
        let bytes = value.as_bytes();
        let mut index = 0;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'+' | b'.' | b'-'))
        {
            index += 1;
        }
        index > 0
            && index + 2 < bytes.len()
            && bytes[index] == b':'
            && bytes[index + 1] == b'/'
            && bytes[index + 2] == b'/'
            && bytes[0].is_ascii_alphabetic()
    };
    let candidate = if has_scheme {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let Ok(url) = url::Url::parse(&candidate) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    url.host_str()
        .map(|host| host.contains('.') && !host.starts_with('.') && !host.ends_with('.'))
        .unwrap_or(false)
}

/// Rule of a string schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StrRule {
    pub min: Option<usize>,
    pub max: Option<usize>,
    pub pattern: Option<Pattern>,
    /// Apply the Libyan phone normalisation and keep group 1 (zPhone transform).
    pub trim_phone: bool,
    /// `z.string().trim()`: trim before the length/format checks.
    pub trim: bool,
    /// The portal password policy (lowercase, uppercase, digit).
    pub password: bool,
}

impl StrRule {
    #[must_use]
    pub fn new() -> Self {
        Self {
            min: None,
            max: None,
            pattern: None,
            trim_phone: false,
            trim: false,
            password: false,
        }
    }
}

impl Default for StrRule {
    fn default() -> Self {
        Self::new()
    }
}

/// Integer rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntRule {
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub coerce: bool,
}

impl IntRule {
    #[must_use]
    pub fn new() -> Self {
        Self {
            min: None,
            max: None,
            coerce: false,
        }
    }
}

impl Default for IntRule {
    fn default() -> Self {
        Self::new()
    }
}

/// Array rule.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrayRule {
    pub min: Option<usize>,
    pub max: Option<usize>,
}

impl ArrayRule {
    #[must_use]
    pub fn new() -> Self {
        Self {
            min: None,
            max: None,
        }
    }
}

impl Default for ArrayRule {
    fn default() -> Self {
        Self::new()
    }
}

/// One object field.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub schema: Schema,
    pub optional: bool,
    pub default: Option<Value>,
}

impl Field {
    #[must_use]
    pub fn required(schema: Schema) -> Self {
        Self {
            schema,
            optional: false,
            default: None,
        }
    }

    #[must_use]
    pub fn optional(schema: Schema) -> Self {
        Self {
            schema,
            optional: true,
            default: None,
        }
    }

    #[must_use]
    pub fn with_default(schema: Schema, value: Value) -> Self {
        Self {
            schema,
            optional: true,
            default: Some(value),
        }
    }
}

/// Object schema; `strict` rejects unknown keys like `.strict()`.
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectRule {
    pub fields: Vec<(&'static str, Field)>,
    pub strict: bool,
}

impl ObjectRule {
    #[must_use]
    pub fn new(fields: Vec<(&'static str, Field)>) -> Self {
        Self {
            fields,
            strict: true,
        }
    }

    #[must_use]
    pub fn passthrough(fields: Vec<(&'static str, Field)>) -> Self {
        Self {
            fields,
            strict: false,
        }
    }
}

/// The supported schema vocabulary. Every constructor mirrors one zod builder.
#[derive(Debug, Clone, PartialEq)]
pub enum Schema {
    Any,
    Bool,
    Int(IntRule),
    Str(StrRule),
    Enum(&'static [&'static str]),
    LiteralTrue,
    Array(Box<Schema>, ArrayRule),
    Object(ObjectRule),
    Union(Vec<Schema>),
    /// `z.unknown().nullable()`-style wrapper used by the webhook `description` field.
    Nullable(Box<Schema>),
    /// `z.record(z.string().max(n), z.unknown())`.
    JsonObject {
        key_max: usize,
    },
}

impl Schema {
    #[must_use]
    pub fn string() -> Self {
        Self::Str(StrRule::new())
    }

    #[must_use]
    pub fn min(mut self, min: usize) -> Self {
        if let Self::Str(rule) = &mut self {
            rule.min = Some(min);
        }
        self
    }

    #[must_use]
    pub fn max(mut self, max: usize) -> Self {
        if let Self::Str(rule) = &mut self {
            rule.max = Some(max);
        }
        self
    }

    #[must_use]
    pub fn pattern(mut self, pattern: Pattern) -> Self {
        if let Self::Str(rule) = &mut self {
            rule.pattern = Some(pattern);
        }
        self
    }

    #[must_use]
    pub fn phone(mut self) -> Self {
        if let Self::Str(rule) = &mut self {
            rule.pattern = Some(Pattern::Phone);
            rule.trim_phone = true;
        }
        self
    }

    #[must_use]
    pub fn trimmed(mut self) -> Self {
        if let Self::Str(rule) = &mut self {
            rule.trim = true;
        }
        self
    }

    #[must_use]
    pub fn password(mut self) -> Self {
        if let Self::Str(rule) = &mut self {
            rule.password = true;
        }
        self
    }

    #[must_use]
    pub fn len(self, length: usize) -> Self {
        self.min(length).max(length)
    }

    #[must_use]
    pub fn integer() -> Self {
        Self::Int(IntRule::new())
    }

    #[must_use]
    pub fn coerce_integer() -> Self {
        let mut rule = IntRule::new();
        rule.coerce = true;
        Self::Int(rule)
    }

    #[must_use]
    pub fn int_min(mut self, min: i64) -> Self {
        if let Self::Int(rule) = &mut self {
            rule.min = Some(min);
        }
        self
    }

    #[must_use]
    pub fn int_max(mut self, max: i64) -> Self {
        if let Self::Int(rule) = &mut self {
            rule.max = Some(max);
        }
        self
    }

    #[must_use]
    pub fn array(item: Schema) -> Self {
        Self::Array(Box::new(item), ArrayRule::new())
    }

    #[must_use]
    pub fn array_min(mut self, min: usize) -> Self {
        if let Self::Array(_, rule) = &mut self {
            rule.min = Some(min);
        }
        self
    }

    #[must_use]
    pub fn array_max(mut self, max: usize) -> Self {
        if let Self::Array(_, rule) = &mut self {
            rule.max = Some(max);
        }
        self
    }

    #[must_use]
    pub fn object(fields: Vec<(&'static str, Field)>) -> Self {
        Self::Object(ObjectRule::new(fields))
    }

    #[must_use]
    pub fn passthrough(fields: Vec<(&'static str, Field)>) -> Self {
        Self::Object(ObjectRule::passthrough(fields))
    }

    #[must_use]
    pub fn empty_strict() -> Self {
        Self::object(Vec::new())
    }

    #[must_use]
    pub fn json_object(key_max: usize) -> Self {
        Self::JsonObject { key_max }
    }

    #[must_use]
    pub fn nullable(inner: Schema) -> Self {
        Self::Nullable(Box::new(inner))
    }

    fn type_name(&self) -> &'static str {
        match self {
            Self::Any => "unknown",
            Self::Bool => "boolean",
            Self::Int(_) => "int",
            Self::Str(_) => "string",
            Self::Enum(_) => "enum",
            Self::LiteralTrue => "literal",
            Self::Array(_, _) => "array",
            Self::Object(_) => "object",
            Self::Union(_) => "union",
            Self::Nullable(_) => "nullable",
            Self::JsonObject { .. } => "record",
        }
    }

    pub fn validate(&self, value: &Value) -> Result<Value, Vec<Issue>> {
        self.validate_at(value, &[])
    }

    pub fn validate_at(&self, value: &Value, path: &[PathItem]) -> Result<Value, Vec<Issue>> {
        match self {
            Self::Any => Ok(value.clone()),
            Self::Bool => match value {
                Value::Bool(boolean) => Ok(Value::Bool(*boolean)),
                other => Err(vec![invalid_type(
                    path.to_vec(),
                    "boolean",
                    json_type(other),
                )]),
            },
            Self::LiteralTrue => match value {
                Value::Bool(true) => Ok(Value::Bool(true)),
                other => Err(vec![Issue::new(
                    "invalid_value",
                    path.to_vec(),
                    "Invalid input: expected true",
                    vec![("values", Value::Array(vec![Value::Bool(true)]))],
                )
                .tap_type(other)]),
            },
            Self::Int(rule) => validate_int(*rule, value, path),
            Self::Str(rule) => validate_str(rule, value, path),
            Self::Enum(values) => match value {
                Value::String(text) if values.iter().any(|candidate| candidate == text) => {
                    Ok(value.clone())
                }
                _ => Err(vec![Issue::new(
                    "invalid_value",
                    path.to_vec(),
                    format!(
                        "Invalid option: expected one of {}",
                        values
                            .iter()
                            .map(|value| format!("\"{value}\""))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                    vec![(
                        "values",
                        Value::Array(
                            values
                                .iter()
                                .map(|value| Value::String((*value).to_owned()))
                                .collect(),
                        ),
                    )],
                )]),
            },
            Self::Array(item, rule) => validate_array(item, rule, value, path),
            Self::Object(rule) => validate_object(rule, value, path),
            Self::Union(options) => {
                let mut last: Vec<Issue> = Vec::new();
                for option in options {
                    match option.validate_at(value, path) {
                        Ok(validated) => return Ok(validated),
                        Err(issues) => last = issues,
                    }
                }
                Err(vec![Issue::new(
                    "invalid_union",
                    path.to_vec(),
                    "Invalid input",
                    vec![(
                        "errors",
                        Value::Array(
                            last.iter()
                                .map(Issue::to_json)
                                .map(|issue| Value::Array(vec![issue]))
                                .collect(),
                        ),
                    )],
                )])
            }
            Self::Nullable(inner) => {
                if value.is_null() {
                    Ok(Value::Null)
                } else {
                    inner.validate_at(value, path)
                }
            }
            Self::JsonObject { key_max } => validate_json_object(*key_max, value, path),
        }
    }
}

/// Small helper so `LiteralTrue` can still report `received`.
trait TapType {
    fn tap_type(self, received: &Value) -> Self;
}

impl TapType for Issue {
    fn tap_type(mut self, received: &Value) -> Self {
        self.extra
            .push(("received", Value::String(json_type(received).to_owned())));
        self
    }
}

fn validate_int(rule: IntRule, value: &Value, path: &[PathItem]) -> Result<Value, Vec<Issue>> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if rule.coerce => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite())
            }
        }
        _ => None,
    };
    let Some(number) = number else {
        return Err(vec![invalid_type(path.to_vec(), "int", json_type(value))]);
    };
    if number.fract() != 0.0 || number.abs() > i64::MAX as f64 {
        return Err(vec![invalid_type(path.to_vec(), "int", "number")]);
    }
    #[allow(clippy::cast_possible_truncation)]
    let integer = number as i64;
    if let Some(min) = rule.min {
        if integer < min {
            return Err(vec![Issue::new(
                "too_small",
                path.to_vec(),
                format!("Too small: expected number to be >= {min}"),
                vec![
                    ("minimum", Value::Number(min.into())),
                    ("origin", Value::String("number".to_owned())),
                    ("inclusive", Value::Bool(true)),
                ],
            )]);
        }
    }
    if let Some(max) = rule.max {
        if integer > max {
            return Err(vec![Issue::new(
                "too_big",
                path.to_vec(),
                format!("Too big: expected number to be <= {max}"),
                vec![
                    ("maximum", Value::Number(max.into())),
                    ("origin", Value::String("number".to_owned())),
                    ("inclusive", Value::Bool(true)),
                ],
            )]);
        }
    }
    Ok(Value::Number(integer.into()))
}

fn validate_str(rule: &StrRule, value: &Value, path: &[PathItem]) -> Result<Value, Vec<Issue>> {
    let Value::String(original) = value else {
        return Err(vec![invalid_type(
            path.to_vec(),
            "string",
            json_type(value),
        )]);
    };
    let trimmed = if rule.trim {
        original.trim().to_owned()
    } else {
        original.clone()
    };
    let text = &trimmed;
    // JavaScript `.length` and zod's `min`/`max` count UTF-16 code units.
    let length = text.encode_utf16().count();
    if let Some(min) = rule.min {
        if length < min {
            return Err(vec![Issue::new(
                "too_small",
                path.to_vec(),
                format!("Too small: expected string to have >= {min} characters"),
                vec![
                    ("minimum", Value::Number(min.into())),
                    ("origin", Value::String("string".to_owned())),
                    ("inclusive", Value::Bool(true)),
                ],
            )]);
        }
    }
    if let Some(max) = rule.max {
        if length > max {
            return Err(vec![Issue::new(
                "too_big",
                path.to_vec(),
                format!("Too big: expected string to have <= {max} characters"),
                vec![
                    ("maximum", Value::Number(max.into())),
                    ("origin", Value::String("string".to_owned())),
                    ("inclusive", Value::Bool(true)),
                ],
            )]);
        }
    }
    if let Some(pattern) = rule.pattern {
        if !pattern.matches(text) {
            let message = match pattern {
                Pattern::Email => "Invalid email address".to_owned(),
                Pattern::Phone => "Phone Invalid".to_owned(),
                Pattern::Uuid => "Invalid UUID".to_owned(),
                _ => "Invalid string: must match the pattern".to_owned(),
            };
            return Err(vec![Issue::new(
                "invalid_format",
                path.to_vec(),
                message,
                vec![
                    ("format", Value::String(pattern.format_name().to_owned())),
                    ("pattern", Value::String(format!("{pattern:?}"))),
                ],
            )]);
        }
    }
    if rule.password {
        if !text.bytes().any(|byte| byte.is_ascii_lowercase()) {
            return Err(vec![Issue::new(
                "invalid_format",
                path.to_vec(),
                "password must contain a lowercase letter",
                vec![("format", Value::String("regex".to_owned()))],
            )]);
        }
        if !text.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err(vec![Issue::new(
                "invalid_format",
                path.to_vec(),
                "password must contain an uppercase letter",
                vec![("format", Value::String("regex".to_owned()))],
            )]);
        }
        if !text.bytes().any(|byte| byte.is_ascii_digit()) {
            return Err(vec![Issue::new(
                "invalid_format",
                path.to_vec(),
                "password must contain a digit",
                vec![("format", Value::String("regex".to_owned()))],
            )]);
        }
    }
    if rule.trim_phone {
        let Some(normalized) = normalize_libyan_phone(text) else {
            return Err(vec![Issue::new(
                "invalid_format",
                path.to_vec(),
                "Phone Invalid",
                vec![("format", Value::String("regex".to_owned()))],
            )]);
        };
        return Ok(Value::String(normalized));
    }
    Ok(Value::String(trimmed))
}

fn validate_array(
    item: &Schema,
    rule: &ArrayRule,
    value: &Value,
    path: &[PathItem],
) -> Result<Value, Vec<Issue>> {
    let Value::Array(items) = value else {
        return Err(vec![invalid_type(path.to_vec(), "array", json_type(value))]);
    };
    if let Some(min) = rule.min {
        if items.len() < min {
            return Err(vec![Issue::new(
                "too_small",
                path.to_vec(),
                format!("Too small: expected array to have >= {min} items"),
                vec![
                    ("minimum", Value::Number(min.into())),
                    ("origin", Value::String("array".to_owned())),
                    ("inclusive", Value::Bool(true)),
                ],
            )]);
        }
    }
    if let Some(max) = rule.max {
        if items.len() > max {
            return Err(vec![Issue::new(
                "too_big",
                path.to_vec(),
                format!("Too big: expected array to have <= {max} items"),
                vec![
                    ("maximum", Value::Number(max.into())),
                    ("origin", Value::String("array".to_owned())),
                    ("inclusive", Value::Bool(true)),
                ],
            )]);
        }
    }
    let mut output = Vec::with_capacity(items.len());
    let mut issues = Vec::new();
    for (index, entry) in items.iter().enumerate() {
        let mut item_path = path.to_vec();
        item_path.push(PathItem::Index(index));
        match item.validate_at(entry, &item_path) {
            Ok(validated) => output.push(validated),
            Err(mut item_issues) => issues.append(&mut item_issues),
        }
    }
    if issues.is_empty() {
        Ok(Value::Array(output))
    } else {
        Err(issues)
    }
}

fn validate_object(
    rule: &ObjectRule,
    value: &Value,
    path: &[PathItem],
) -> Result<Value, Vec<Issue>> {
    let Value::Object(object) = value else {
        return Err(vec![invalid_type(
            path.to_vec(),
            "object",
            json_type(value),
        )]);
    };
    let mut issues = Vec::new();
    if rule.strict {
        let unknown: Vec<Value> = object
            .keys()
            .filter(|key| !rule.fields.iter().any(|(field, _)| field == key))
            .map(|key| Value::String(key.clone()))
            .collect();
        if !unknown.is_empty() {
            let listed = unknown
                .iter()
                .filter_map(Value::as_str)
                .map(|key| format!("'{key}'"))
                .collect::<Vec<_>>()
                .join(", ");
            issues.push(Issue::new(
                "unrecognized_keys",
                path.to_vec(),
                format!("Unrecognized key(s) in object: {listed}"),
                vec![("keys", Value::Array(unknown))],
            ));
        }
    }
    let mut output = Map::new();
    for (name, field) in &rule.fields {
        let mut field_path = path.to_vec();
        field_path.push(PathItem::Key((*name).to_owned()));
        match object.get(*name) {
            Some(entry) => match field.schema.validate_at(entry, &field_path) {
                Ok(validated) => {
                    output.insert((*name).to_owned(), validated);
                }
                Err(mut field_issues) => issues.append(&mut field_issues),
            },
            None => {
                if let Some(default) = &field.default {
                    output.insert((*name).to_owned(), default.clone());
                } else if !field.optional {
                    issues.push(invalid_type(
                        field_path,
                        field.schema.type_name(),
                        "undefined",
                    ));
                }
            }
        }
    }
    if !rule.strict {
        for (key, entry) in object {
            if !rule.fields.iter().any(|(field, _)| field == key) {
                output.insert(key.clone(), entry.clone());
            }
        }
    }
    if issues.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(issues)
    }
}

fn validate_json_object(
    key_max: usize,
    value: &Value,
    path: &[PathItem],
) -> Result<Value, Vec<Issue>> {
    let Value::Object(object) = value else {
        return Err(vec![invalid_type(
            path.to_vec(),
            "record",
            json_type(value),
        )]);
    };
    let mut issues = Vec::new();
    for key in object.keys() {
        if key.encode_utf16().count() > key_max {
            let mut key_path = path.to_vec();
            key_path.push(PathItem::Key(key.clone()));
            issues.push(Issue::new(
                "too_big",
                key_path,
                format!("Too big: expected string to have <= {key_max} characters"),
                vec![
                    ("maximum", Value::Number(key_max.into())),
                    ("origin", Value::String("string".to_owned())),
                ],
            ));
        }
    }
    if issues.is_empty() {
        Ok(value.clone())
    } else {
        Err(issues)
    }
}

/// Validate and convert the issue list into the edge error envelope's `details`.
pub fn validation_details(issues: Vec<Issue>) -> Value {
    Value::Array(issues.iter().map(Issue::to_json).collect())
}

/// Validate a payload, turning a failure into `400 VALIDATION_FAILED`.
pub fn validate_to_error(
    schema: &Schema,
    value: &Value,
) -> Result<Value, crate::error::EdgeApiError> {
    schema
        .validate(value)
        .map_err(crate::error::EdgeApiError::validation)
}

/// `z.coerce.number()` on a query value; `None` when it is not a number.
#[must_use]
pub fn coerce_query_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) if text.trim().is_empty() => Some(0),
        Value::String(text) => text.trim().parse::<f64>().ok().and_then(|parsed| {
            if parsed.is_finite() && parsed.fract() == 0.0 && parsed.abs() <= i64::MAX as f64 {
                #[allow(clippy::cast_possible_truncation)]
                Some(parsed as i64)
            } else {
                None
            }
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(fields: Vec<(&'static str, Field)>) -> Schema {
        Schema::object(fields)
    }

    #[test]
    fn strict_object_reports_unrecognized_keys_once() {
        let schema = object(vec![(
            "name",
            Field::required(Schema::string().min(2).max(5)),
        )]);
        let issues = schema
            .validate(&json!({ "name": "ok", "extra": 1, "other": true }))
            .expect_err("strict");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "unrecognized_keys");
        assert_eq!(issues[0].path, Vec::<PathItem>::new());
        let rendered = issues[0].to_json();
        assert_eq!(rendered["keys"], json!(["extra", "other"]));
    }

    #[test]
    fn missing_required_field_is_invalid_type() {
        let schema = object(vec![("name", Field::required(Schema::string()))]);
        let issues = schema.validate(&json!({})).expect_err("required");
        assert_eq!(issues[0].code, "invalid_type");
        assert_eq!(issues[0].path, vec![PathItem::Key("name".to_owned())]);
        assert!(issues[0].message.contains("received undefined"));
    }

    #[test]
    fn defaults_and_optional_fields_are_applied() {
        let schema = object(vec![
            (
                "currency",
                Field::with_default(Schema::string().len(3), json!("LYD")),
            ),
            ("label", Field::optional(Schema::string())),
        ]);
        let validated = schema.validate(&json!({})).expect("valid");
        assert_eq!(validated, json!({ "currency": "LYD" }));
    }

    #[test]
    fn string_bounds_use_utf16_length() {
        let schema = Schema::string().min(2).max(2);
        // One astral character is two UTF-16 code units, exactly like JS `.length`.
        assert!(schema.validate(&json!("\u{1f600}")).is_ok());
        let issues = schema.validate(&json!("a")).expect_err("short");
        assert_eq!(issues[0].code, "too_small");
        let issues = schema.validate(&json!("abc")).expect_err("long");
        assert_eq!(issues[0].code, "too_big");
    }

    #[test]
    fn phone_normalisation_matches_the_typescript_transform() {
        let schema = Schema::string().phone();
        assert_eq!(
            schema.validate(&json!("0912345678")).expect("valid"),
            json!("912345678")
        );
        assert_eq!(
            schema.validate(&json!("+218912345678")).expect("valid"),
            json!("912345678")
        );
        assert_eq!(
            schema.validate(&json!("00218912345678")).expect("valid"),
            json!("912345678")
        );
        assert_eq!(
            schema.validate(&json!("218912345678")).expect("valid"),
            json!("912345678")
        );
        assert!(schema.validate(&json!("912345678")).is_ok());
        assert!(schema.validate(&json!("0812345678")).is_err());
        assert!(schema.validate(&json!("091234567")).is_err());
        assert!(schema.validate(&json!("09123456789")).is_err());
    }

    #[test]
    fn amount_and_volume_patterns() {
        let amount = Schema::string().pattern(Pattern::Amount);
        assert!(amount.validate(&json!("250.0000")).is_ok());
        assert!(amount.validate(&json!("0")).is_ok());
        assert!(amount.validate(&json!("1.23456")).is_err());
        assert!(amount.validate(&json!(".5")).is_err());
        assert!(amount.validate(&json!("1.")).is_err());
        assert!(amount.validate(&json!("123456789012345")).is_err());
        let volume = Schema::string().pattern(Pattern::Volume);
        assert!(volume.validate(&json!("1500.0000")).is_ok());
        assert!(volume.validate(&json!("1234567890123")).is_err());
    }

    #[test]
    fn identifiers_emails_uuids_and_websites() {
        let identifier = Schema::string().min(1).max(64).pattern(Pattern::Identifier);
        assert!(identifier.validate(&json!("wal_1-2")).is_ok());
        assert!(identifier.validate(&json!("wal/1")).is_err());

        let email = Schema::string().pattern(Pattern::Email);
        assert!(email.validate(&json!("ops@example.com")).is_ok());
        assert!(email.validate(&json!("ops@example")).is_err());
        assert!(email.validate(&json!("ops@exa mple.com")).is_err());

        let uuid = Schema::string().pattern(Pattern::Uuid);
        assert!(uuid
            .validate(&json!("11111111-1111-4111-8111-111111111111"))
            .is_ok());
        assert!(uuid.validate(&json!("1111")).is_err());

        for url in [
            "https://shop.example",
            "http://shop.example/path",
            "shop.example",
        ] {
            assert!(is_website(url), "{url}");
        }
        for url in [
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ftp://example.com",
            "localhost",
        ] {
            assert!(!is_website(url), "{url}");
        }
    }

    #[test]
    fn dates_and_months() {
        assert!(Pattern::IsoDate.matches("2026-01-05"));
        assert!(!Pattern::IsoDate.matches("2026-02-30"));
        assert!(Pattern::IsoDatePrefix.matches("2026-01-05T10:00:00Z"));
        assert!(Pattern::Month.matches("2026-11"));
        assert!(!Pattern::Month.matches("2026-13"));
        assert!(Pattern::IsoDateTimePrefix.matches("2026-11-01T00:00:00.000Z"));
        assert!(!Pattern::IsoDateTimePrefix.matches("2999"));
        assert!(Pattern::OwnershipPercent.matches("100"));
        assert!(Pattern::OwnershipPercent.matches("12.5"));
        assert!(!Pattern::OwnershipPercent.matches("12.555"));
    }

    #[test]
    fn token_scopes_are_lowercase_resource_action() {
        assert!(Pattern::TokenScope.matches("links:read"));
        assert!(Pattern::TokenScope.matches("link:write"));
        assert!(!Pattern::TokenScope.matches("*"));
        assert!(!Pattern::TokenScope.matches("Links:Read"));
        assert!(!Pattern::TokenScope.matches("no.such.scope"));
        assert!(!Pattern::TokenScope.matches("a:b"));
    }

    #[test]
    fn integer_coercion_follows_zod() {
        let schema = Schema::coerce_integer().int_min(1).int_max(200);
        assert_eq!(schema.validate(&json!("2")).expect("valid"), json!(2));
        // `Number("")` is 0, which is below the minimum, exactly like `z.coerce.number().min(1)`.
        assert_eq!(
            schema.validate(&json!("")).expect_err("min")[0].code,
            "too_small"
        );
        let unbounded = Schema::coerce_integer();
        assert_eq!(unbounded.validate(&json!("")).expect("zero"), json!(0));
        assert_eq!(
            schema.validate(&json!("abc")).expect_err("nan")[0].code,
            "invalid_type"
        );
        assert_eq!(
            schema.validate(&json!("2.5")).expect_err("int")[0].code,
            "invalid_type"
        );
        assert_eq!(
            schema.validate(&json!(201)).expect_err("max")[0].code,
            "too_big"
        );
    }

    #[test]
    fn arrays_validate_each_item_with_an_indexed_path() {
        let schema = Schema::array(Schema::string().min(1))
            .array_min(1)
            .array_max(2);
        let issues = schema.validate(&json!(["a", 3])).expect_err("item");
        assert_eq!(issues[0].path, vec![PathItem::Index(1)]);
        assert_eq!(issues[0].code, "invalid_type");
        assert_eq!(
            schema.validate(&json!([])).expect_err("min")[0].code,
            "too_small"
        );
        assert_eq!(
            schema.validate(&json!(["a", "b", "c"])).expect_err("max")[0].code,
            "too_big"
        );
    }

    #[test]
    fn union_reports_invalid_union() {
        let schema = Schema::Union(vec![
            Schema::array(Schema::string()),
            Schema::json_object(64),
        ]);
        assert!(schema.validate(&json!(["a"])).is_ok());
        assert!(schema.validate(&json!({ "a": true })).is_ok());
        let issues = schema.validate(&json!("nope")).expect_err("union");
        assert_eq!(issues[0].code, "invalid_union");
    }

    #[test]
    fn json_object_limits_key_length() {
        let schema = Schema::json_object(4);
        assert!(schema.validate(&json!({ "abcd": 1 })).is_ok());
        let issues = schema.validate(&json!({ "abcde": 1 })).expect_err("key");
        assert_eq!(issues[0].code, "too_big");
        assert!(schema.validate(&json!([1])).is_err());
    }

    #[test]
    fn enums_and_literal_true() {
        let schema = Schema::Enum(&["A", "B"]);
        assert!(schema.validate(&json!("B")).is_ok());
        let issues = schema.validate(&json!("C")).expect_err("enum");
        assert_eq!(issues[0].code, "invalid_value");
        let literal = Schema::LiteralTrue;
        assert!(literal.validate(&json!(true)).is_ok());
        assert_eq!(
            literal.validate(&json!(false)).expect_err("literal")[0].code,
            "invalid_value"
        );
    }
}
