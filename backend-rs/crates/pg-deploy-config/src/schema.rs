//! JSON Schema export for `pgctl.toml` (chapter 7 §7: `pgctl config schema`).
//!
//! The schema is derived from [`PgctlConfig`] with `schemars`, so it cannot drift from the
//! deserialiser: adding a field adds it to the schema in the same change. `deny_unknown_fields`
//! is enforced by serde, not by JSON Schema (`additionalProperties` is advisory for editors), so
//! the generated schema is documentation and editor support, while `config validate` is the
//! authority.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::model::PgctlConfig;

/// The schema as a JSON value.
#[must_use]
pub fn json_schema() -> Value {
    let schema = schemars::schema_for!(PgctlConfig);
    serde_json::to_value(&schema).unwrap_or(Value::Null)
}

/// The schema as pretty-printed JSON (`pgctl config schema`).
#[must_use]
pub fn json_schema_pretty() -> String {
    serde_json::to_string_pretty(&json_schema()).unwrap_or_else(|_| "null".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_describes_the_document() {
        let schema = json_schema();
        assert!(schema.is_object(), "schema must be an object, got {schema}");
        let text = schema.to_string();
        for key in [
            "\"deployment\"",
            "\"hosts\"",
            "\"services\"",
            "\"database\"",
            "\"redis\"",
            "\"object_storage\"",
            "\"backup\"",
            "\"secrets\"",
            "\"network\"",
            "\"tls\"",
            "\"sandbox\"",
            "\"seed\"",
        ] {
            assert!(text.contains(key), "schema is missing {key}");
        }
        assert!(
            text.contains("\"impl\""),
            "the renamed impl field must appear"
        );
    }

    #[test]
    fn schema_never_contains_a_secret_value() {
        let text = json_schema_pretty();
        assert!(!text.contains("change-me"));
        assert!(!text.contains("EICAR"));
    }

    #[test]
    fn pretty_printing_is_valid_json() {
        let text = json_schema_pretty();
        let parsed: Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(parsed, json_schema());
    }
}
