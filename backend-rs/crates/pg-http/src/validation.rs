//! zod-shaped validation issues.
//!
//! The code and path are the contract; messages are best effort (chapter 2 §4).
//! Mirrors the `details` array of `400 INVALID_BODY` (core) and `400 VALIDATION_FAILED` (edges).

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Issue {
    pub code: String,
    pub path: Vec<String>,
    pub message: String,
    /// zod extras such as `minimum`, `inclusive`, `expected`, `received`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Issue {
    #[must_use]
    pub fn new(code: impl Into<String>, path: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path,
            message: message.into(),
            extra: serde_json::Map::new(),
        }
    }

    #[must_use]
    pub fn invalid_type(path: Vec<String>, expected: &str) -> Self {
        let mut issue = Self::new(
            "invalid_type",
            path,
            format!("Invalid input: expected {expected}"),
        );
        issue
            .extra
            .insert("expected".to_owned(), Value::String(expected.to_owned()));
        issue
    }

    #[must_use]
    pub fn too_small(path: Vec<String>, minimum: i64, inclusive: bool) -> Self {
        let mut issue = Self::new("too_small", path, "Input is too small");
        issue
            .extra
            .insert("minimum".to_owned(), Value::from(minimum));
        issue
            .extra
            .insert("inclusive".to_owned(), Value::Bool(inclusive));
        issue
    }

    #[must_use]
    pub fn too_big(path: Vec<String>, maximum: i64, inclusive: bool) -> Self {
        let mut issue = Self::new("too_big", path, "Input is too big");
        issue
            .extra
            .insert("maximum".to_owned(), Value::from(maximum));
        issue
            .extra
            .insert("inclusive".to_owned(), Value::Bool(inclusive));
        issue
    }

    #[must_use]
    pub fn invalid_value(path: Vec<String>, expected: Vec<String>) -> Self {
        let mut issue = Self::new("invalid_value", path, "Invalid option");
        issue.extra.insert(
            "expected".to_owned(),
            Value::Array(expected.into_iter().map(Value::String).collect()),
        );
        issue
    }

    #[must_use]
    pub fn unrecognized_keys(path: Vec<String>, keys: Vec<String>) -> Self {
        let mut issue = Self::new("unrecognized_keys", path, "Unrecognized key(s) in object");
        issue.extra.insert(
            "keys".to_owned(),
            Value::Array(keys.into_iter().map(Value::String).collect()),
        );
        issue
    }

    #[must_use]
    pub fn custom(path: Vec<String>, message: impl Into<String>) -> Self {
        Self::new("custom", path, message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidationError {
    pub issues: Vec<Issue>,
}

impl ValidationError {
    #[must_use]
    pub fn new(issues: Vec<Issue>) -> Self {
        Self { issues }
    }

    #[must_use]
    pub fn single(issue: Issue) -> Self {
        Self::new(vec![issue])
    }

    #[must_use]
    pub fn to_details(&self) -> Value {
        serde_json::to_value(&self.issues).unwrap_or_else(|_| Value::Array(Vec::new()))
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} validation issue(s)", self.issues.len())
    }
}

impl std::error::Error for ValidationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_shape_includes_zod_extras() {
        let issue = Issue::too_small(vec!["page".to_owned()], 1, true);
        let json = serde_json::to_value(issue).expect("json");
        assert_eq!(json["code"], "too_small");
        assert_eq!(json["path"][0], "page");
        assert_eq!(json["minimum"], 1);
        assert_eq!(json["inclusive"], true);
    }

    #[test]
    fn unrecognized_keys_lists_keys() {
        let issue = Issue::unrecognized_keys(vec![], vec!["extra".to_owned()]);
        let json = serde_json::to_value(issue).expect("json");
        assert_eq!(json["keys"][0], "extra");
    }
}
