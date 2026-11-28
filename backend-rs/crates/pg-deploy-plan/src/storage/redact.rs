//! Secret redaction for plan output.
//!
//! The plan model never carries a secret value: configuration files use `{{secret:<name>}}` and
//! SQL uses psql variables (`:'name'`). This module is a defence-in-depth pass over the rendered
//! JSON so a hand-built plan, a future executor or a mistake cannot print an inline credential.

#![forbid(unsafe_code)]

use serde_json::Value;

/// Markers that introduce a credential value in a rendered file or script.
///
/// Ordered most-specific first: `password =` must win over the generic `password `, otherwise
/// only the `=` would be masked.
const MARKERS: [&str; 7] = [
    "requirepass ",
    "masterauth ",
    "auth-pass ",
    "auth_pass ",
    "password = ",
    "password=",
    "password '",
];

fn redact_line(line: &str) -> String {
    let lowered = line.to_ascii_lowercase();
    for marker in MARKERS {
        let Some(position) = lowered.find(marker) else {
            continue;
        };
        let value_start = position + marker.len();
        let rest = &line[value_start..];
        let trimmed = rest.trim_start();
        // Placeholders, psql variables and an already-masked value are not secrets.
        // `psql --no-password` is deliberately not a marker: a generic `password ` pattern
        // would mask the following `-h` and corrupt the plan.
        if trimmed.starts_with("{{secret:")
            || trimmed.starts_with("{{redacted}}")
            || trimmed.starts_with(":'")
        {
            continue;
        }
        let token_start = value_start + (rest.len() - trimmed.len());
        let token_end = line[token_start..]
            .find(char::is_whitespace)
            .map_or(line.len(), |offset| token_start + offset);
        let mut masked = String::with_capacity(line.len());
        masked.push_str(&line[..token_start]);
        masked.push_str("{{redacted}}");
        masked.push_str(&line[token_end..]);
        return masked;
    }
    line.to_owned()
}

fn redact_text(text: &str) -> String {
    text.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

/// Recursively redact every string in a JSON value.
#[must_use]
pub fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, entry) in map {
                // A field named like a credential never carries a value in a plan; mask it if a
                // future model ever adds one.
                let lowered = key.to_ascii_lowercase();
                if (lowered.contains("password") || lowered.contains("secret_value"))
                    && entry.is_string()
                {
                    redacted.insert(key.clone(), Value::String("{{redacted}}".to_owned()));
                } else {
                    redacted.insert(key.clone(), redact_value(entry));
                }
            }
            Value::Object(redacted)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inline_credentials_are_masked() {
        let value = json!({
            "content": "port 6379\nrequirepass hunter2\nmaxmemory 4gb",
            "sql": "ALTER ROLE x PASSWORD 'hunter2';",
            "secret_refs": ["pg_db_password"],
            "path": "/etc/pg-redis/tls/server.key",
        });
        let redacted = redact_value(&value);
        let text = serde_json::to_string(&redacted).unwrap_or_default();
        assert!(!text.contains("hunter2"));
        assert!(text.contains("{{redacted}}"));
        assert!(text.contains("pg_db_password"), "names stay readable");
        assert!(
            text.contains("/etc/pg-redis/tls/server.key"),
            "paths stay readable"
        );
    }

    #[test]
    fn placeholders_and_psql_variables_are_not_masked() {
        let value = json!({
            "content": "requirepass {{secret:redis_password}}\nALTER ROLE x PASSWORD :'pg_db_password';",
        });
        let redacted = redact_value(&value);
        let text = serde_json::to_string(&redacted).unwrap_or_default();
        assert!(text.contains("{{secret:redis_password}}"));
        assert!(text.contains(":'pg_db_password'"));
        assert!(!text.contains("{{redacted}}"));
    }

    #[test]
    fn credential_named_fields_are_masked() {
        let value = json!({"password": "hunter2", "secret_value": "abc", "name": "ok"});
        let text = serde_json::to_string(&redact_value(&value)).unwrap_or_default();
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("abc"));
        assert!(text.contains("\"name\":\"ok\""));
    }

    #[test]
    fn unrelated_settings_are_untouched() {
        let value = json!({
            "content": "password_encryption = 'scram-sha-256'\nmaxmemory-policy volatile-ttl\nssl_key_file = '/tls/server.key'\npsql --no-password -h 127.0.0.1 -p 6432",
        });
        let text = serde_json::to_string(&redact_value(&value)).unwrap_or_default();
        assert!(!text.contains("{{redacted}}"));
    }
}
