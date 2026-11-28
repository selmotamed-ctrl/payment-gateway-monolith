//! A faithful-enough subset of zod 4 for the admin edge contract.
//!
//! The TS edge validates every public payload with zod before forwarding it (`parseOrThrow` in
//! `admin-back/lib/error/index.ts`): `.strict()` objects reject unknown keys, plain objects strip
//! them, `.passthrough()`/`.catchall()` keep them, transforms (trim, default, coerce) change the
//! value core receives, and failures become `400 VALIDATION_FAILED` with the raw zod issue list.
//!
//! This module reproduces those behaviours for the shapes the admin edge actually uses.

#![forbid(unsafe_code)]

use serde_json::{json, Map, Value};

use crate::error::{ApiError, EdgeResult};

/// One zod issue. Serialised as `{ code, path, message }` (plus `keys` for `unrecognized_keys`).
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: String,
    pub path: Vec<String>,
    pub message: String,
    pub keys: Option<Vec<String>>,
}

impl Issue {
    #[must_use]
    pub fn new(code: &str, path: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            path,
            message: message.into(),
            keys: None,
        }
    }

    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".to_owned(), Value::String(self.code.clone()));
        map.insert(
            "path".to_owned(),
            Value::Array(self.path.iter().cloned().map(Value::String).collect()),
        );
        map.insert("message".to_owned(), Value::String(self.message.clone()));
        if let Some(keys) = &self.keys {
            map.insert(
                "keys".to_owned(),
                Value::Array(keys.iter().cloned().map(Value::String).collect()),
            );
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone, Default)]
pub struct StringRule {
    min: Option<usize>,
    max: Option<usize>,
    regex: Option<&'static str>,
    uuid: bool,
    email: bool,
    datetime: bool,
    date: bool,
    trim: bool,
    lowercase: bool,
    password: bool,
    url: bool,
    cron_min_gap: Option<u32>,
}

#[derive(Debug, Clone, Copy)]
pub struct NumberRule {
    integer: bool,
    min: Option<f64>,
    max: Option<f64>,
    coerce: bool,
}

#[derive(Debug, Clone)]
pub struct Field {
    name: &'static str,
    schema: Schema,
    presence: Presence,
    nullable: bool,
}

#[derive(Debug, Clone)]
enum Presence {
    Required,
    Optional,
    Default(Value),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectMode {
    /// zod default: unknown keys are stripped from the output.
    Strip,
    /// `.strict()`: unknown keys are rejected with `unrecognized_keys`.
    Strict,
    /// `.passthrough()` / `.catchall(z.unknown())`: unknown keys are kept.
    Passthrough,
}

#[derive(Debug, Clone)]
pub struct Refinement {
    fields: &'static [&'static str],
    path: &'static str,
    message: &'static str,
}

/// A declarative validator for one JSON value.
#[derive(Debug, Clone)]
pub enum Schema {
    Any,
    Bool,
    Number(NumberRule),
    String(StringRule),
    Enum(&'static [&'static str]),
    LiteralString(&'static str),
    LiteralBool(bool),
    LiteralInt(i64),
    Array {
        items: Box<Schema>,
        min: Option<usize>,
        max: Option<usize>,
    },
    Object {
        fields: Vec<Field>,
        mode: ObjectMode,
        refinements: Vec<Refinement>,
    },
    Record {
        key_max: usize,
        value: Box<Schema>,
    },
    Union(Vec<Schema>),
}

/// Builder for an object schema.
#[derive(Debug, Clone)]
pub struct ObjectBuilder {
    fields: Vec<Field>,
    mode: ObjectMode,
    refinements: Vec<Refinement>,
}

impl ObjectBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            fields: Vec::new(),
            mode: ObjectMode::Strip,
            refinements: Vec::new(),
        }
    }

    #[must_use]
    pub fn req(mut self, name: &'static str, schema: Schema) -> Self {
        self.fields.push(Field {
            name,
            schema,
            presence: Presence::Required,
            nullable: false,
        });
        self
    }

    #[must_use]
    pub fn opt(mut self, name: &'static str, schema: Schema) -> Self {
        self.fields.push(Field {
            name,
            schema,
            presence: Presence::Optional,
            nullable: false,
        });
        self
    }

    #[must_use]
    pub fn null_opt(mut self, name: &'static str, schema: Schema) -> Self {
        self.fields.push(Field {
            name,
            schema,
            presence: Presence::Optional,
            nullable: true,
        });
        self
    }

    #[must_use]
    pub fn def(mut self, name: &'static str, schema: Schema, default: Value) -> Self {
        self.fields.push(Field {
            name,
            schema,
            presence: Presence::Default(default),
            nullable: false,
        });
        self
    }

    #[must_use]
    pub fn strict(mut self) -> Self {
        self.mode = ObjectMode::Strict;
        self
    }

    #[must_use]
    pub fn passthrough(mut self) -> Self {
        self.mode = ObjectMode::Passthrough;
        self
    }

    /// `.refine((value) => fields.some(...), { path })`.
    #[must_use]
    pub fn require_one_of(
        mut self,
        fields: &'static [&'static str],
        path: &'static str,
        message: &'static str,
    ) -> Self {
        self.refinements.push(Refinement {
            fields,
            path,
            message,
        });
        self
    }

    #[must_use]
    pub fn build(self) -> Schema {
        Schema::Object {
            fields: self.fields,
            mode: self.mode,
            refinements: self.refinements,
        }
    }
}

impl Default for ObjectBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[must_use]
pub fn object() -> ObjectBuilder {
    ObjectBuilder::new()
}

#[must_use]
pub fn any() -> Schema {
    Schema::Any
}

#[must_use]
pub fn boolean() -> Schema {
    Schema::Bool
}

/// A string with only a length window.
#[must_use]
pub fn text(min: usize, max: usize) -> Schema {
    Schema::String(StringRule {
        min: Some(min),
        max: Some(max),
        ..StringRule::default()
    })
}

/// A string with a regular-expression constraint.
#[must_use]
pub fn pattern(min: usize, max: usize, regex: &'static str) -> Schema {
    Schema::String(StringRule {
        min: Some(min),
        max: Some(max),
        regex: Some(regex),
        ..StringRule::default()
    })
}

/// A trimmed string with a regular-expression constraint (`z.string().trim().regex(...)`).
#[must_use]
pub fn trimmed_pattern(min: usize, max: usize, regex: &'static str) -> Schema {
    Schema::String(StringRule {
        min: Some(min),
        max: Some(max),
        regex: Some(regex),
        trim: true,
        ..StringRule::default()
    })
}

#[must_use]
pub fn trimmed(min: usize, max: usize) -> Schema {
    let mut rule = StringRule {
        min: Some(min),
        max: Some(max),
        ..StringRule::default()
    };
    rule.trim = true;
    Schema::String(rule)
}

#[must_use]
pub fn uuid() -> Schema {
    Schema::String(StringRule {
        uuid: true,
        ..StringRule::default()
    })
}

#[must_use]
pub fn email() -> Schema {
    Schema::String(StringRule {
        email: true,
        max: Some(320),
        ..StringRule::default()
    })
}

/// `z.string().url()` restricted to http(s), like the descriptive logo and filing endpoint.
#[must_use]
pub fn url_text(max: usize) -> Schema {
    Schema::String(StringRule {
        max: Some(max),
        url: true,
        ..StringRule::default()
    })
}

#[must_use]
pub fn datetime() -> Schema {
    Schema::String(StringRule {
        datetime: true,
        ..StringRule::default()
    })
}

#[must_use]
pub fn date() -> Schema {
    Schema::String(StringRule {
        date: true,
        ..StringRule::default()
    })
}

#[must_use]
pub fn enumeration(values: &'static [&'static str]) -> Schema {
    Schema::Enum(values)
}

#[must_use]
pub fn literal(value: &'static str) -> Schema {
    Schema::LiteralString(value)
}

#[must_use]
pub fn literal_true() -> Schema {
    Schema::LiteralBool(true)
}

#[must_use]
pub fn integer(min: i64, max: i64) -> Schema {
    Schema::Number(NumberRule {
        integer: true,
        min: Some(min as f64),
        max: Some(max as f64),
        coerce: false,
    })
}

/// `z.number()` (fractional allowed) with a window.
#[must_use]
pub fn number(min: f64, max: f64) -> Schema {
    Schema::Number(NumberRule {
        integer: false,
        min: Some(min),
        max: Some(max),
        coerce: false,
    })
}

/// `z.literal(<number>)`.
#[must_use]
pub fn literal_int(value: i64) -> Schema {
    Schema::LiteralInt(value)
}

/// `z.string()` without a window.
#[must_use]
pub fn string_any() -> Schema {
    Schema::String(StringRule::default())
}

/// `cronField(minGap)`: a valid five-field cron with runs at least `min_gap` minutes apart.
#[must_use]
pub fn cron_field(min_gap: u32) -> Schema {
    Schema::String(StringRule {
        min: Some(1),
        max: Some(120),
        cron_min_gap: Some(min_gap),
        ..StringRule::default()
    })
}

/// `zPassword`: 12..128 with a lowercase, an uppercase letter and a digit.
#[must_use]
pub fn password_schema() -> Schema {
    Schema::String(StringRule {
        min: Some(12),
        max: Some(128),
        password: true,
        ..StringRule::default()
    })
}

/// `z.coerce.number().int().min().max()` (query and route params).
#[must_use]
pub fn coerce_integer(min: i64, max: i64) -> Schema {
    Schema::Number(NumberRule {
        integer: true,
        min: Some(min as f64),
        max: Some(max as f64),
        coerce: true,
    })
}

#[must_use]
pub fn array_sized(items: Schema, min: usize, max: usize) -> Schema {
    Schema::Array {
        items: Box::new(items),
        min: Some(min),
        max: Some(max),
    }
}

#[must_use]
pub fn record_any(key_max: usize) -> Schema {
    Schema::Record {
        key_max,
        value: Box::new(Schema::Any),
    }
}

#[must_use]
pub fn record_of(key_max: usize, value: Schema) -> Schema {
    Schema::Record {
        key_max,
        value: Box::new(value),
    }
}

#[must_use]
pub fn either(options: Vec<Schema>) -> Schema {
    Schema::Union(options)
}

/// Validate a value and return the parsed/transformed JSON.
pub fn validate(schema: &Schema, value: &Value) -> Result<Value, Vec<Issue>> {
    let mut issues = Vec::new();
    let parsed = validate_into(schema, value, &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        Ok(parsed.unwrap_or(Value::Null))
    } else {
        Err(issues)
    }
}

/// `parseOrThrow(schema, data)`.
pub fn parse_or_throw(schema: &Schema, value: &Value) -> EdgeResult<Value> {
    validate(schema, value)
        .map_err(|issues| ApiError::validation_failed(issues.iter().map(Issue::to_value).collect()))
}

fn validate_into(
    schema: &Schema,
    value: &Value,
    path: &mut Vec<String>,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    match schema {
        Schema::Any => Some(value.clone()),
        Schema::Bool => match value {
            Value::Bool(boolean) => Some(Value::Bool(*boolean)),
            other => {
                invalid_type(path, "boolean", other, issues);
                None
            }
        },
        Schema::Number(rule) => validate_number(rule, value, path, issues),
        Schema::String(rule) => validate_string(rule, value, path, issues),
        Schema::Enum(values) => match value.as_str() {
            Some(candidate) if values.contains(&candidate) => Some(value.clone()),
            Some(_) => {
                issues.push(Issue::new(
                    "invalid_value",
                    path.clone(),
                    format!("Invalid option: expected one of {}", values.join("|")),
                ));
                None
            }
            None => {
                invalid_type(path, "string", value, issues);
                None
            }
        },
        Schema::LiteralString(expected) => match value.as_str() {
            Some(candidate) if candidate == *expected => Some(value.clone()),
            Some(_) => {
                issues.push(Issue::new(
                    "invalid_value",
                    path.clone(),
                    format!("Invalid literal value, expected \"{expected}\""),
                ));
                None
            }
            None => {
                invalid_type(path, "string", value, issues);
                None
            }
        },
        Schema::LiteralBool(expected) => match value.as_bool() {
            Some(candidate) if candidate == *expected => Some(value.clone()),
            Some(_) => {
                issues.push(Issue::new(
                    "invalid_value",
                    path.clone(),
                    format!("Invalid literal value, expected {expected}"),
                ));
                None
            }
            None => {
                invalid_type(path, "boolean", value, issues);
                None
            }
        },
        Schema::LiteralInt(expected) => match value.as_i64() {
            Some(candidate) if candidate == *expected => Some(value.clone()),
            Some(_) => {
                issues.push(Issue::new(
                    "invalid_value",
                    path.clone(),
                    format!("Invalid literal value, expected {expected}"),
                ));
                None
            }
            None => {
                invalid_type(path, "number", value, issues);
                None
            }
        },
        Schema::Array { items, min, max } => {
            let Some(values) = value.as_array() else {
                invalid_type(path, "array", value, issues);
                return None;
            };
            if let Some(minimum) = min {
                if values.len() < *minimum {
                    issues.push(Issue::new(
                        "too_small",
                        path.clone(),
                        format!("Too small: expected array to have >= {minimum} items"),
                    ));
                }
            }
            if let Some(maximum) = max {
                if values.len() > *maximum {
                    issues.push(Issue::new(
                        "too_big",
                        path.clone(),
                        format!("Too big: expected array to have <= {maximum} items"),
                    ));
                }
            }
            let mut output = Vec::with_capacity(values.len());
            for (index, entry) in values.iter().enumerate() {
                path.push(index.to_string());
                if let Some(parsed) = validate_into(items, entry, path, issues) {
                    output.push(parsed);
                }
                path.pop();
            }
            Some(Value::Array(output))
        }
        Schema::Object {
            fields,
            mode,
            refinements,
        } => validate_object(fields, *mode, refinements, value, path, issues),
        Schema::Record {
            key_max,
            value: item,
        } => {
            let Some(object) = value.as_object() else {
                invalid_type(path, "object", value, issues);
                return None;
            };
            let mut output = Map::new();
            for (key, entry) in object {
                if key.chars().count() > *key_max {
                    path.push(key.clone());
                    issues.push(Issue::new(
                        "too_big",
                        path.clone(),
                        format!("Too big: expected string to have <= {key_max} characters"),
                    ));
                    path.pop();
                    continue;
                }
                path.push(key.clone());
                if let Some(parsed) = validate_into(item, entry, path, issues) {
                    output.insert(key.clone(), parsed);
                }
                path.pop();
            }
            Some(Value::Object(output))
        }
        Schema::Union(options) => {
            for option in options {
                let mut local = Vec::new();
                let mut local_path = path.clone();
                if let Some(parsed) = validate_into(option, value, &mut local_path, &mut local) {
                    return Some(parsed);
                }
            }
            issues.push(Issue::new(
                "invalid_union",
                path.clone(),
                "Invalid input: no union member matched",
            ));
            None
        }
    }
}

fn invalid_type(path: &[String], expected: &str, value: &Value, issues: &mut Vec<Issue>) {
    let received = match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    issues.push(Issue::new(
        "invalid_type",
        path.to_vec(),
        format!("Invalid input: expected {expected}, received {received}"),
    ));
}

fn validate_number(
    rule: &NumberRule,
    value: &Value,
    path: &[String],
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let candidate = match value {
        Value::Number(number) => {
            if rule.integer {
                number
                    .as_i64()
                    .map(|_| Value::Number(number.clone()))
                    .or_else(|| {
                        number
                            .as_f64()
                            .filter(|value| value.fract() == 0.0)
                            .and_then(|value| {
                                (value >= i64::MIN as f64 && value <= i64::MAX as f64)
                                    .then_some(json!(value as i64))
                            })
                    })
            } else {
                number.as_f64().map(|_| Value::Number(number.clone()))
            }
        }
        Value::String(raw) if rule.coerce => {
            let trimmed = raw.trim();
            if rule.integer {
                trimmed
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite() && value.fract() == 0.0)
                    .and_then(|value| {
                        (value >= i64::MIN as f64 && value <= i64::MAX as f64)
                            .then_some(json!(value as i64))
                    })
            } else {
                trimmed
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
            }
        }
        _ => {
            invalid_type(path, "number", value, issues);
            return None;
        }
    };
    let Some(parsed) = candidate else {
        issues.push(Issue::new(
            "invalid_type",
            path.to_vec(),
            "Invalid input: expected an integer",
        ));
        return None;
    };
    let numeric = parsed.as_f64().unwrap_or(0.0);
    if let Some(minimum) = rule.min {
        if numeric < minimum {
            issues.push(Issue::new(
                "too_small",
                path.to_vec(),
                format!("Too small: expected number to be >= {minimum}"),
            ));
            return None;
        }
    }
    if let Some(maximum) = rule.max {
        if numeric > maximum {
            issues.push(Issue::new(
                "too_big",
                path.to_vec(),
                format!("Too big: expected number to be <= {maximum}"),
            ));
            return None;
        }
    }
    Some(parsed)
}

fn validate_string(
    rule: &StringRule,
    value: &Value,
    path: &[String],
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let Some(raw) = value.as_str() else {
        invalid_type(path, "string", value, issues);
        return None;
    };
    let mut candidate = raw.to_owned();
    if rule.trim {
        candidate = candidate.trim().to_owned();
    }
    if rule.lowercase {
        candidate = candidate.to_lowercase();
    }
    if let Some(minimum) = rule.min {
        if candidate.chars().count() < minimum {
            issues.push(Issue::new(
                "too_small",
                path.to_vec(),
                format!("Too small: expected string to have >= {minimum} characters"),
            ));
            return None;
        }
    }
    if let Some(maximum) = rule.max {
        if candidate.chars().count() > maximum {
            issues.push(Issue::new(
                "too_big",
                path.to_vec(),
                format!("Too big: expected string to have <= {maximum} characters"),
            ));
            return None;
        }
    }
    if rule.uuid && !is_uuid(&candidate) {
        issues.push(Issue::new("invalid_format", path.to_vec(), "Invalid UUID"));
        return None;
    }
    if rule.email && !is_email(&candidate) {
        issues.push(Issue::new(
            "invalid_format",
            path.to_vec(),
            "Invalid email address",
        ));
        return None;
    }
    if rule.url && !is_http_url(&candidate) {
        issues.push(Issue::new("invalid_format", path.to_vec(), "Invalid URL"));
        return None;
    }
    if rule.date && !is_date(&candidate) {
        issues.push(Issue::new(
            "invalid_format",
            path.to_vec(),
            "Invalid date, expected YYYY-MM-DD",
        ));
        return None;
    }
    if rule.datetime && !is_datetime(&candidate) {
        issues.push(Issue::new(
            "invalid_format",
            path.to_vec(),
            "Invalid ISO datetime",
        ));
        return None;
    }
    if let Some(regex) = rule.regex {
        if !regex_match(regex, &candidate) {
            issues.push(Issue::new(
                "invalid_format",
                path.to_vec(),
                format!("Invalid string: must match pattern {regex}"),
            ));
            return None;
        }
    }
    if let Some(min_gap) = rule.cron_min_gap {
        match crate::cron::analyze_cron(&candidate) {
            None => {
                issues.push(Issue::new(
                    "custom",
                    path.to_vec(),
                    "must be a valid 5 field cron expression",
                ));
                return None;
            }
            Some(analysis) if analysis.min_gap_minutes < min_gap => {
                issues.push(Issue::new(
                    "custom",
                    path.to_vec(),
                    format!("runs must be at least {min_gap} minutes apart"),
                ));
                return None;
            }
            Some(_) => {}
        }
    }
    if rule.password {
        let mut failed = false;
        if !candidate.chars().any(|c| c.is_ascii_lowercase()) {
            issues.push(Issue::new(
                "invalid_format",
                path.to_vec(),
                "password must contain a lowercase letter",
            ));
            failed = true;
        }
        if !candidate.chars().any(|c| c.is_ascii_uppercase()) {
            issues.push(Issue::new(
                "invalid_format",
                path.to_vec(),
                "password must contain an uppercase letter",
            ));
            failed = true;
        }
        if !candidate.chars().any(|c| c.is_ascii_digit()) {
            issues.push(Issue::new(
                "invalid_format",
                path.to_vec(),
                "password must contain a digit",
            ));
            failed = true;
        }
        if failed {
            return None;
        }
    }
    Some(Value::String(candidate))
}

fn validate_object(
    fields: &[Field],
    mode: ObjectMode,
    refinements: &[Refinement],
    value: &Value,
    path: &mut Vec<String>,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let Value::Object(object) = value else {
        invalid_type(path, "object", value, issues);
        return None;
    };
    let mut output = Map::new();
    for field in fields {
        let entry = object.get(field.name);
        match entry {
            Some(Value::Null) if field.nullable => {
                output.insert(field.name.to_owned(), Value::Null);
            }
            Some(entry) => {
                path.push(field.name.to_owned());
                if let Some(parsed) = validate_into(&field.schema, entry, path, issues) {
                    output.insert(field.name.to_owned(), parsed);
                }
                path.pop();
            }
            None => match &field.presence {
                Presence::Required => {
                    path.push(field.name.to_owned());
                    issues.push(Issue::new(
                        "invalid_type",
                        path.clone(),
                        "Invalid input: expected value, received undefined",
                    ));
                    path.pop();
                }
                Presence::Optional => {}
                Presence::Default(default) => {
                    output.insert(field.name.to_owned(), default.clone());
                }
            },
        }
    }
    if mode != ObjectMode::Strip {
        let mut unknown: Vec<String> = object
            .keys()
            .filter(|key| !fields.iter().any(|field| field.name == key.as_str()))
            .cloned()
            .collect();
        unknown.sort();
        if mode == ObjectMode::Strict && !unknown.is_empty() {
            let mut issue = Issue::new(
                "unrecognized_keys",
                path.clone(),
                if unknown.len() == 1 {
                    format!("Unrecognized key: \"{}\"", unknown[0])
                } else {
                    format!("Unrecognized keys: {}", unknown.join(", "))
                },
            );
            issue.keys = Some(unknown);
            issues.push(issue);
        } else if mode == ObjectMode::Passthrough {
            for key in unknown {
                if let Some(entry) = object.get(&key) {
                    output.insert(key, entry.clone());
                }
            }
        }
    }
    let parsed = Value::Object(output);
    for refinement in refinements {
        let present = refinement
            .fields
            .iter()
            .any(|name| object.get(*name).is_some_and(|entry| !entry.is_null()));
        if !present {
            if refinement.path.is_empty() {
                issues.push(Issue::new("custom", path.clone(), refinement.message));
            } else {
                path.push(refinement.path.to_owned());
                issues.push(Issue::new("custom", path.clone(), refinement.message));
                path.pop();
            }
        }
    }
    Some(parsed)
}

/// `z.uuid()` accepts any RFC 9562 version/variant combination `uuid` parses.
#[must_use]
pub fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

#[must_use]
pub fn is_email(value: &str) -> bool {
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !value.contains(char::is_whitespace)
        && value.len() <= 320
}

#[must_use]
pub fn is_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
        .unwrap_or(false)
}

#[must_use]
pub fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

#[must_use]
pub fn is_datetime(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

#[derive(Debug, Clone)]
enum Node {
    Empty,
    Literal(u8),
    Digit,
    Word,
    Class(Vec<(u8, u8)>),
    AnyChar,
    Sequence(Vec<Node>),
    Alternate(Vec<Node>),
    Repeat(Box<Node>, usize, Option<usize>),
}

struct Parser {
    chars: Vec<char>,
    index: usize,
}

impl Parser {
    fn new(pattern: &str) -> Self {
        Self {
            chars: pattern.chars().collect(),
            index: 0,
        }
    }

    fn parse(&mut self) -> Option<Node> {
        let node = self.parse_alternate()?;
        (self.index == self.chars.len()).then_some(node)
    }

    fn parse_alternate(&mut self) -> Option<Node> {
        let mut branches = vec![self.parse_sequence()?];
        while self.peek() == Some('|') {
            self.index += 1;
            branches.push(self.parse_sequence()?);
        }
        if branches.len() == 1 {
            branches.pop()
        } else {
            Some(Node::Alternate(branches))
        }
    }

    fn parse_sequence(&mut self) -> Option<Node> {
        let mut nodes = Vec::new();
        while let Some(character) = self.peek() {
            if character == ')' || character == '|' {
                break;
            }
            nodes.push(self.parse_atom()?);
        }
        Some(match nodes.len() {
            0 => Node::Empty,
            1 => nodes.pop()?,
            _ => Node::Sequence(nodes),
        })
    }

    fn parse_atom(&mut self) -> Option<Node> {
        let character = self.next()?;
        let mut node = match character {
            '\\' => match self.next()? {
                'd' => Node::Digit,
                'w' => Node::Word,
                other => Node::Literal(u8::try_from(other).ok()?),
            },
            '[' => self.parse_class()?,
            '(' => {
                if self.peek() == Some('?') {
                    self.index += 1;
                    if self.peek() == Some(':') {
                        self.index += 1;
                    }
                }
                let inner = self.parse_alternate()?;
                if self.next()? != ')' {
                    return None;
                }
                inner
            }
            '.' => Node::AnyChar,
            other => Node::Literal(u8::try_from(other).ok()?),
        };
        if let Some(quantifier) = self.peek() {
            let (min, max) = match quantifier {
                '+' => (1, None),
                '*' => (0, None),
                '?' => (0, Some(1)),
                '{' => {
                    self.index += 1;
                    let mut body = String::new();
                    while let Some(character) = self.peek() {
                        if character == '}' {
                            break;
                        }
                        body.push(character);
                        self.index += 1;
                    }
                    if self.next()? != '}' {
                        return None;
                    }
                    if let Some((min, max)) = body.split_once(',') {
                        let min = min.parse::<usize>().ok()?;
                        let max = if max.is_empty() {
                            None
                        } else {
                            Some(max.parse::<usize>().ok()?)
                        };
                        (min, max)
                    } else {
                        let count = body.parse::<usize>().ok()?;
                        (count, Some(count))
                    }
                }
                _ => return Some(node),
            };
            if !matches!(quantifier, '{') {
                self.index += 1;
            }
            node = Node::Repeat(Box::new(node), min, max);
        }
        Some(node)
    }

    fn parse_class(&mut self) -> Option<Node> {
        let mut ranges = Vec::new();
        let mut negated = false;
        if self.peek() == Some('^') {
            negated = true;
            self.index += 1;
        }
        let mut closed = false;
        while let Some(character) = self.next() {
            if character == ']' {
                closed = true;
                break;
            }
            let start = if character == '\\' {
                match self.next()? {
                    'd' => ('0', '9'),
                    other => (other, other),
                }
            } else {
                (character, character)
            };
            if self.peek() == Some('-')
                && self
                    .chars
                    .get(self.index + 1)
                    .is_some_and(|next| *next != ']')
            {
                self.index += 1;
                let end = self.next()?;
                ranges.push((u8::try_from(start.0).ok()?, u8::try_from(end).ok()?));
            } else {
                ranges.push((u8::try_from(start.0).ok()?, u8::try_from(start.1).ok()?));
            }
        }
        if !closed {
            return None;
        }
        if negated {
            let mut inverted = Vec::new();
            for byte in 0u8..=127 {
                if !ranges
                    .iter()
                    .any(|(low, high)| byte >= *low && byte <= *high)
                {
                    inverted.push((byte, byte));
                }
            }
            ranges = inverted;
        }
        Some(Node::Class(ranges))
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn next(&mut self) -> Option<char> {
        let character = self.peek()?;
        self.index += 1;
        Some(character)
    }
}

fn ends(node: &Node, input: &[u8], position: usize, out: &mut Vec<usize>) {
    match node {
        Node::Empty => out.push(position),
        Node::Literal(expected) => {
            if input.get(position).copied() == Some(*expected) {
                out.push(position + 1);
            }
        }
        Node::Digit => {
            if input.get(position).is_some_and(u8::is_ascii_digit) {
                out.push(position + 1);
            }
        }
        Node::Word => {
            if input
                .get(position)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            {
                out.push(position + 1);
            }
        }
        Node::Class(ranges) => {
            if let Some(byte) = input.get(position) {
                if ranges.iter().any(|(low, high)| byte >= low && byte <= high) {
                    out.push(position + 1);
                }
            }
        }
        Node::AnyChar => {
            if input.get(position).is_some_and(|byte| *byte != b'\n') {
                out.push(position + 1);
            }
        }
        Node::Sequence(nodes) => {
            let mut positions = vec![position];
            for node in nodes {
                let mut next = Vec::new();
                for current in &positions {
                    ends(node, input, *current, &mut next);
                }
                next.sort_unstable();
                next.dedup();
                next.truncate(4096);
                if next.is_empty() {
                    return;
                }
                positions = next;
            }
            out.extend(positions);
        }
        Node::Alternate(branches) => {
            for branch in branches {
                ends(branch, input, position, out);
            }
        }
        Node::Repeat(inner, min, max) => {
            let maximum = max
                .unwrap_or_else(|| input.len().saturating_add(1))
                .min(input.len() + 1);
            let mut current = vec![position];
            if *min == 0 {
                out.push(position);
            }
            for count in 1..=maximum {
                let mut next = Vec::new();
                for current_position in &current {
                    let mut ends_here = Vec::new();
                    ends(inner, input, *current_position, &mut ends_here);
                    for end in ends_here {
                        if end != *current_position {
                            next.push(end);
                        }
                    }
                }
                next.sort_unstable();
                next.dedup();
                next.truncate(4096);
                if next.is_empty() {
                    break;
                }
                if count >= *min {
                    out.extend(next.iter().copied());
                }
                current = next;
            }
        }
    }
}

/// A small anchored regex matcher that supports the constructs the contracts use.
#[must_use]
pub fn regex_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.strip_prefix('^').unwrap_or(pattern);
    let pattern = pattern.strip_suffix('$').unwrap_or(pattern);
    let mut parser = Parser::new(pattern);
    let Some(node) = parser.parse() else {
        return false;
    };
    let mut ends_here = Vec::new();
    ends(&node, value.as_bytes(), 0, &mut ends_here);
    ends_here.contains(&value.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issues(schema: &Schema, value: Value) -> Vec<String> {
        validate(schema, &value)
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }

    #[test]
    fn strict_objects_reject_unknown_keys() {
        let schema = object().req("a", text(1, 10)).strict().build();
        let error = validate(&schema, &json!({"a":"x","b":1})).expect_err("unknown key");
        assert_eq!(error[0].code, "unrecognized_keys");
        assert_eq!(error[0].keys.as_deref(), Some(&["b".to_owned()][..]));
    }

    #[test]
    fn plain_objects_strip_unknown_keys() {
        let schema = object().req("a", text(1, 10)).build();
        let parsed = validate(&schema, &json!({"a":"x","b":1})).expect("valid");
        assert_eq!(parsed, json!({"a":"x"}));
    }

    #[test]
    fn passthrough_keeps_unknown_keys() {
        let schema = object().req("a", text(1, 10)).passthrough().build();
        let parsed = validate(&schema, &json!({"a":"x","b":1})).expect("valid");
        assert_eq!(parsed, json!({"a":"x","b":1}));
    }

    #[test]
    fn defaults_and_nesting_apply() {
        let schema = object()
            .req("period", enumeration(&["24h", "7d"]))
            .def("limit", integer(1, 10), json!(5))
            .build();
        let parsed = validate(&schema, &json!({"period":"7d"})).expect("valid");
        assert_eq!(parsed, json!({"period":"7d","limit":5}));
    }

    #[test]
    fn coercion_accepts_query_strings() {
        let schema = object().opt("page", coerce_integer(1, 1_000_000)).build();
        let parsed = validate(&schema, &json!({"page":"12"})).expect("valid");
        assert_eq!(parsed, json!({"page":12}));
    }

    #[test]
    fn money_pattern_and_uuid_and_email_work() {
        assert!(regex_match(r"^\d{1,14}(\.\d{1,4})?$", "12.3456"));
        assert!(regex_match(r"^\d{1,14}(\.\d{1,4})?$", "12"));
        assert!(!regex_match(r"^\d{1,14}(\.\d{1,4})?$", "12.34567"));
        assert!(regex_match("^[A-Za-z0-9_-]+$", "rail_1-a"));
        assert!(!regex_match("^[A-Za-z0-9_-]+$", "rail 1"));
        assert!(regex_match(r"^\d{4}-(0[1-9]|1[0-2])$", "2026-11"));
        assert!(is_uuid("0192f6a0-1111-7111-8111-111111111111"));
        assert!(!is_uuid("nope"));
        assert!(is_email("a@b.co"));
        assert!(!is_email("a@b"));
    }

    #[test]
    fn refinements_add_custom_issues() {
        let schema = object()
            .opt("status", enumeration(&["A", "B"]))
            .opt("other", boolean())
            .require_one_of(
                &["status", "other"],
                "status",
                "at least one change is required",
            )
            .build();
        assert_eq!(issues(&schema, json!({})), vec!["custom"]);
        assert!(validate(&schema, &json!({"status":"A"})).is_ok());
    }

    #[test]
    fn nullable_fields_accept_null() {
        let schema = object().null_opt("logo", text(1, 10)).strict().build();
        assert_eq!(
            validate(&schema, &json!({"logo": null})).expect("valid"),
            json!({"logo": null})
        );
    }

    #[test]
    fn passwords_need_lowercase_uppercase_and_digit() {
        let schema = password_schema();
        assert!(validate(&schema, &json!("short")).is_err());
        assert!(validate(&schema, &json!("alllowercase123")).is_err());
        assert!(validate(&schema, &json!("ValidPassword1")).is_ok());
    }
}
