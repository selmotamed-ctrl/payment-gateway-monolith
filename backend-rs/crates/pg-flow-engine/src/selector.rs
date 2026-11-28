//! JSON selectors, `{{path}}` templates, assertions and URL compilation.
//!
//! Port of `core-back/engine/apiConsumer/recursiveSelect.ts`,
//! `recursiveSet.ts`, `compileUrl.ts` and the context-template/assertion helpers of
//! `core-back/engine/flow/StepExecutor.ts:281-433,1180-1240`.
//!
//! Prototype-key blocking is preserved: a selector segment `__proto__`, `constructor` or
//! `prototype` is refused with `PROTOTYPE_POLLUTION_BLOCKED`, never resolved.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use url::Url;

use crate::error::{codes, EngineError};
use crate::jsregex::JsRegex;
use crate::schema::Assertion;

const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// The JS `encodeURIComponent` set: everything except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric()
            || matches!(
                character,
                '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')'
            )
        {
            output.push(character);
        } else {
            output.push('%');
            output.push_str(&format!("{byte:02X}"));
        }
    }
    output
}

fn path_error(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::new(400, code, message)
}

/// Splits and validates a selector path (`Selector path cannot be empty`).
pub fn normalize_path(selector: &str, label: &str) -> Result<Vec<String>, EngineError> {
    let path: Vec<String> = selector.split('.').map(str::to_owned).collect();
    if path.is_empty() || path.iter().any(String::is_empty) {
        return Err(path_error(
            codes::INVALID_PATH,
            format!("{label} path cannot be empty"),
        ));
    }
    for segment in &path {
        if FORBIDDEN_KEYS.contains(&segment.as_str()) {
            return Err(path_error(
                codes::PROTOTYPE_POLLUTION_BLOCKED,
                format!("Forbidden path segment: {segment}"),
            ));
        }
    }
    Ok(path)
}

/// `recursiveSelect`: a dotted path over objects and arrays. A missing segment returns `None`.
pub fn select<'a>(target: &'a Value, selector: &str) -> Result<Option<&'a Value>, EngineError> {
    let path = normalize_path(selector, "Selector")?;
    let mut current = target;
    for segment in &path {
        match current {
            Value::Object(map) => match map.get(segment) {
                Some(value) => current = value,
                None => return Ok(None),
            },
            Value::Array(items) => match segment.parse::<usize>() {
                Ok(index) => match items.get(index) {
                    Some(value) => current = value,
                    None => return Ok(None),
                },
                Err(_) => return Ok(None),
            },
            _ => return Ok(None),
        }
    }
    Ok(Some(current))
}

/// Owned variant of [`select`] for values that must outlive the borrow.
pub fn select_owned(target: &Value, selector: &str) -> Result<Option<Value>, EngineError> {
    Ok(select(target, selector)?.cloned())
}

fn is_numeric(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
}

/// `recursiveSet`: writes a dotted path, creating objects (and arrays for numeric segments).
pub fn set_path(root: &mut Value, setter: &str, value: Value) -> Result<(), EngineError> {
    if !root.is_object() {
        return Err(path_error(
            codes::INVALID_TARGET,
            "Setter target must be an object",
        ));
    }
    let path = normalize_path(setter, "Setter")?;
    set_at(root, &path, value)
}

fn set_at(current: &mut Value, path: &[String], value: Value) -> Result<(), EngineError> {
    let Some((segment, rest)) = path.split_first() else {
        return Ok(());
    };
    if rest.is_empty() {
        match current {
            Value::Object(map) => {
                map.insert(segment.clone(), value);
                Ok(())
            }
            Value::Array(items) => {
                let index = segment.parse::<usize>().map_err(|_| {
                    path_error(
                        codes::INVALID_PATH,
                        format!("Path segment '{segment}' cannot index an array"),
                    )
                })?;
                if index >= items.len() {
                    while items.len() < index {
                        items.push(Value::Null);
                    }
                    if items.len() == index {
                        items.push(value);
                    } else {
                        items[index] = value;
                    }
                } else {
                    items[index] = value;
                }
                Ok(())
            }
            _ => Err(path_error(
                codes::INVALID_PATH,
                format!("Path segment '{segment}' cannot be traversed"),
            )),
        }
    } else {
        let next_is_index = is_numeric(&rest[0]);
        match current {
            Value::Object(map) => {
                let entry = map.entry(segment.clone()).or_insert_with(|| {
                    if next_is_index {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Map::new())
                    }
                });
                if !entry.is_object() && !entry.is_array() {
                    *entry = if next_is_index {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Map::new())
                    };
                }
                set_at(entry, rest, value)
            }
            Value::Array(items) => {
                let index = segment.parse::<usize>().map_err(|_| {
                    path_error(
                        codes::INVALID_PATH,
                        format!("Path segment '{segment}' cannot index an array"),
                    )
                })?;
                if items.len() <= index {
                    items.resize(index + 1, Value::Null);
                }
                let entry = &mut items[index];
                if !entry.is_object() && !entry.is_array() {
                    *entry = if next_is_index {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Map::new())
                    };
                }
                set_at(entry, rest, value)
            }
            _ => Err(path_error(
                codes::INVALID_PATH,
                format!("Path segment '{segment}' cannot be traversed"),
            )),
        }
    }
}

/// `sourceMap(parameter, value)`: a dotted key becomes a nested object.
pub fn source_map(key: &str, value: Value) -> Result<Map<String, Value>, EngineError> {
    if key.contains('.') {
        let mut root = Value::Object(Map::new());
        set_path(&mut root, key, value)?;
        match root {
            Value::Object(map) => Ok(map),
            _ => Ok(Map::new()),
        }
    } else {
        let mut map = Map::new();
        map.insert(key.to_owned(), value);
        Ok(map)
    }
}

/// `mergeMaps`: recursive merge of plain objects; anything else is replaced.
pub fn merge_maps(target: &mut Map<String, Value>, source: Map<String, Value>) {
    for (key, value) in source {
        match (target.get_mut(&key), value) {
            (Some(Value::Object(existing)), Value::Object(incoming)) => {
                merge_maps(existing, incoming)
            }
            (_, value) => {
                target.insert(key, value);
            }
        }
    }
}

/// Formats a JSON value like `stringifyTemplateValue` (`String(value)` for anything with a useful
/// `toString`, `JSON.stringify` for a plain object).
#[must_use]
pub fn stringify_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(stringify_value)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Renders `{{path}}` / `{path}` from a lookup closure.
pub fn render_template_with<F>(template: &str, mut lookup: F) -> String
where
    F: FnMut(&str) -> Value,
{
    let mut output = String::with_capacity(template.len());
    let chars: Vec<char> = template.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let double = chars.get(index) == Some(&'{') && chars.get(index + 1) == Some(&'{');
        if chars[index] == '{' {
            let open = if double { index + 2 } else { index + 1 };
            let close = chars[open..].iter().position(|character| *character == '}');
            if let Some(offset) = close {
                let content: String = chars[open..open + offset].iter().collect();
                let valid = !content.is_empty()
                    && content.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
                    });
                if valid {
                    let closing_braces = if double { 2 } else { 1 };
                    let next = open + offset + closing_braces;
                    if next <= chars.len() {
                        output.push_str(&stringify_value(&lookup(&content)));
                        index = next;
                        continue;
                    }
                }
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

/// Resolves a `{{path}}` template against the execution-context roots, with the TS
/// composition-then-direct-root fallback (`resolveTemplatePath`).
pub fn render_context_template(
    template: &str,
    roots: &Map<String, Value>,
    direct_roots: &[&Map<String, Value>],
) -> String {
    render_template_with(template, |path| {
        if let Ok(Some(value)) = select(&Value::Object(roots.clone()), path) {
            return value.clone();
        }
        for root in direct_roots {
            if let Some(value) = root.get(path) {
                return value.clone();
            }
            if let Ok(Some(value)) = select(&Value::Object((*root).clone()), path) {
                return value.clone();
            }
        }
        Value::Null
    })
}

/// `evaluateAssertion`.
pub fn evaluate_assertion(assertion: &Assertion, source: &Value) -> Result<bool, EngineError> {
    let actual = select(source, &assertion.selector)?;
    match assertion.op {
        crate::schema::AssertionOp::Exists => Ok(actual.is_some_and(|value| !value.is_null())),
        crate::schema::AssertionOp::Equals => {
            let Some(actual) = actual else {
                return Ok(false);
            };
            let expected = assertion.value.as_ref().unwrap_or(&Value::Null);
            Ok(actual == expected || stringify_value(actual) == stringify_value(expected))
        }
        crate::schema::AssertionOp::NotEquals => {
            let actual = actual.cloned().unwrap_or(Value::Null);
            let expected = assertion.value.as_ref().unwrap_or(&Value::Null);
            Ok(actual != *expected && stringify_value(&actual) != stringify_value(expected))
        }
        crate::schema::AssertionOp::In => {
            let candidate = actual.cloned().unwrap_or(Value::Null);
            let Some(Value::Array(options)) = assertion.value.as_ref() else {
                return Ok(false);
            };
            Ok(options.iter().any(|option| {
                *option == candidate || stringify_value(option) == stringify_value(&candidate)
            }))
        }
        crate::schema::AssertionOp::Matches => {
            let (Some(Value::String(text)), Some(Value::String(pattern))) =
                (actual, assertion.value.as_ref())
            else {
                return Ok(false);
            };
            let regex = JsRegex::new(pattern).map_err(|error| {
                EngineError::new(
                    400,
                    codes::INVALID_STATUS_PATTERN,
                    format!("Invalid status-rule pattern '{pattern}': {error}"),
                )
            })?;
            Ok(regex.is_match(text))
        }
    }
}

/// `assertNoControlCharacters`.
pub fn assert_no_control_characters(value: &str, label: &str) -> Result<(), EngineError> {
    if value.contains(['\r', '\n', '\0']) {
        return Err(path_error(
            codes::HEADER_INJECTION_BLOCKED,
            format!("CR, LF, or NUL is forbidden in {label}"),
        ));
    }
    Ok(())
}

/// `assertPathIntegrity`.
pub fn assert_path_integrity(value: &str) -> Result<(), EngineError> {
    if value.contains('\\') {
        return Err(path_error(
            codes::INVALID_URL_PATH,
            "URL path contains an unencoded backslash",
        ));
    }
    if value.to_ascii_lowercase().contains("%2f") || value.to_ascii_lowercase().contains("%5c") {
        return Err(path_error(
            codes::INVALID_URL_PATH,
            "URL path contains an encoded path separator",
        ));
    }
    let path_part = value.split(['?', '#']).next().unwrap_or("");
    let path_only = match path_part.find('/') {
        Some(index) => &path_part[index..],
        None => path_part,
    };
    if path_only
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(path_error(
            codes::INVALID_URL_PATH,
            "URL path contains a traversal segment",
        ));
    }
    Ok(())
}

/// `encodeForDestination`.
#[must_use]
pub fn encode_for_destination(value: &Value, destination: &str) -> String {
    match destination {
        "JSON" => serde_json::to_string(value).unwrap_or_default(),
        "XML" => xml_escape(value),
        "FORM" => encode_uri_component(&stringify_value(value)),
        "HEADER" => stringify_value(value),
        _ => encode_uri_component(&stringify_value(value)),
    }
}

/// `xmlEscape`.
#[must_use]
pub fn xml_escape(value: &Value) -> String {
    stringify_value(value)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The options of [`compile_url`].
#[derive(Debug, Clone, Default)]
pub struct UrlOptions {
    pub allowed_hosts: Option<Vec<String>>,
    pub require_https: bool,
    pub allow_any_host: bool,
    pub allow_private_hosts: bool,
    pub allow_fragment: bool,
    pub allow_insecure_http: bool,
}

impl UrlOptions {
    #[must_use]
    pub fn strict(allowed_hosts: Vec<String>) -> Self {
        Self {
            allowed_hosts: Some(allowed_hosts),
            require_https: true,
            ..Self::default()
        }
    }
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .to_ascii_lowercase()
        .trim_end_matches('.')
        .to_owned()
}

fn is_private_host(host: &str) -> bool {
    let host = host
        .trim()
        .to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_owned();
    if host.is_empty() {
        return true;
    }
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return true;
    }
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        return !pg_egress::is_public_ip(address);
    }
    false
}

fn encode_path_segment(value: &Value) -> Result<String, EngineError> {
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| stringify_value(value));
    assert_no_control_characters(&text, "path parameter")?;
    if text.contains('/') || text.contains('\\') {
        return Err(path_error(
            codes::INVALID_URL_PATH,
            "Path parameters cannot contain path separators",
        ));
    }
    Ok(encode_uri_component(&text))
}

fn substitute_path_parameters(
    template: &str,
    parameters: &Map<String, Value>,
) -> Result<String, EngineError> {
    let mut encoded = BTreeMap::new();
    for (key, value) in parameters {
        encoded.insert(key.clone(), encode_path_segment(value)?);
    }
    let rendered = render_template_with(template, |key| match encoded.get(key) {
        Some(value) => Value::String(value.clone()),
        None => Value::String(format!("{{{key}}}")),
    });
    if let Some(start) = rendered.find('{') {
        if let Some(end) = rendered[start..].find('}') {
            let name = &rendered[start + 1..start + end];
            if !name.is_empty()
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
                })
            {
                return Err(EngineError::new(
                    400,
                    codes::MISSING_URL_PARAMETER,
                    format!("URL parameter '{name}' is missing"),
                ));
            }
        }
    }
    Ok(rendered)
}

fn append_query(url: &mut Url, query: &Map<String, Value>) -> Result<(), EngineError> {
    let mut parts: Vec<String> = Vec::new();
    fn walk(prefix: &str, value: &Value, parts: &mut Vec<String>) -> Result<(), EngineError> {
        match value {
            Value::Null => Ok(()),
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    walk(&format!("{prefix}[{index}]"), item, parts)?;
                }
                Ok(())
            }
            Value::Object(map) => {
                for (key, item) in map {
                    assert_no_control_characters(key, "query key")?;
                    walk(
                        &format!("{prefix}[{}]", encode_uri_component(key)),
                        item,
                        parts,
                    )?;
                }
                Ok(())
            }
            scalar => {
                let text = stringify_value(scalar);
                assert_no_control_characters(&text, "query value")?;
                parts.push(format!("{prefix}={}", encode_uri_component(&text)));
                Ok(())
            }
        }
    }
    for (key, value) in query {
        assert_no_control_characters(key, "query key")?;
        walk(&encode_uri_component(key), value, &mut parts)?;
    }
    if parts.is_empty() {
        return Ok(());
    }
    let existing = url.query().unwrap_or("");
    let combined = if existing.is_empty() {
        parts.join("&")
    } else {
        format!("{existing}&{}", parts.join("&"))
    };
    url.set_query(Some(&combined));
    Ok(())
}

/// `validateFinalUrl`.
pub fn validate_final_url(value: &str, options: &UrlOptions) -> Result<Url, EngineError> {
    assert_no_control_characters(value, "URL")?;
    assert_path_integrity(value)?;
    let parsed = Url::parse(value)
        .map_err(|_| EngineError::new(400, codes::INVALID_FINAL_URL, "Final URL is invalid"))?;
    let require_https = options.require_https;
    if require_https && parsed.scheme() != "https" {
        return Err(EngineError::new(
            400,
            codes::INSECURE_URL_BLOCKED,
            "Only HTTPS URLs are allowed",
        ));
    }
    if !require_https
        && parsed.scheme() != "https"
        && !(options.allow_insecure_http && parsed.scheme() == "http")
    {
        return Err(EngineError::new(
            400,
            "INVALID_URL_PROTOCOL",
            "Only HTTP and HTTPS URLs are allowed",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EngineError::new(
            400,
            codes::URL_USERINFO_BLOCKED,
            "URL userinfo is forbidden",
        ));
    }
    if parsed.fragment().is_some() && !options.allow_fragment {
        return Err(EngineError::new(
            400,
            codes::URL_FRAGMENT_BLOCKED,
            "URL fragments are forbidden",
        ));
    }
    let allowed: Vec<String> = options
        .allowed_hosts
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|host| normalize_host(&host))
        .filter(|host| !host.is_empty())
        .collect();
    if allowed.is_empty() && !options.allow_any_host {
        return Err(EngineError::new(
            400,
            codes::HOST_ALLOWLIST_EMPTY,
            "No outbound host allowlist is configured; refusing the request",
        ));
    }
    let hostname = parsed.host_str().unwrap_or_default().to_owned();
    if !options.allow_private_hosts && is_private_host(&hostname) {
        return Err(EngineError::new(
            400,
            codes::SSRF_PRIVATE_ADDRESS_BLOCKED,
            "Private, loopback and link-local hosts are not allowed",
        ));
    }
    if !allowed.is_empty() {
        let normalized_hostname = normalize_host(&hostname);
        let host_with_port = parsed.port().map_or_else(
            || normalized_hostname.clone(),
            |port| format!("{normalized_hostname}:{port}"),
        );
        if !allowed.contains(&normalized_hostname) && !allowed.contains(&host_with_port) {
            return Err(EngineError::new(
                400,
                codes::HOST_NOT_ALLOWED,
                format!(
                    "URL host '{}' is not allowed",
                    parsed.host_str().unwrap_or_default()
                ),
            ));
        }
    }
    Ok(parsed)
}

/// `compileUrl`: substitutes path parameters, appends the query and validates the result.
pub fn compile_url(
    template: &str,
    query: &Map<String, Value>,
    path_parameters: &Map<String, Value>,
    options: &UrlOptions,
) -> Result<String, EngineError> {
    assert_no_control_characters(template, "URL")?;
    let substituted = substitute_path_parameters(template, path_parameters)?;
    assert_no_control_characters(&substituted, "URL")?;
    assert_path_integrity(&substituted)?;
    let mut parsed = Url::parse(&substituted)
        .map_err(|_| EngineError::new(400, codes::INVALID_URL, "URL is invalid"))?;
    append_query(&mut parsed, query)?;
    let final_value = parsed.to_string();
    validate_final_url(&final_value, options)?;
    Ok(final_value)
}

/// One header value that may be sent.
pub fn header_value(value: &Value) -> Result<String, EngineError> {
    let text = stringify_value(value);
    assert_no_control_characters(&text, "header")?;
    Ok(text)
}

/// A `BTreeMap` of headers with lowercased names (`StepExecutor` normalises header names).
pub fn header_map(entries: impl IntoIterator<Item = (String, String)>) -> BTreeMap<String, String> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_ascii_lowercase(), value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Assertion, AssertionOp};
    use serde_json::json;

    #[test]
    fn select_walks_objects_and_arrays_and_blocks_prototypes() {
        let value = json!({"result": {"items": [{"id": "a"}, {"id": "b"}]}, "x": 1});
        assert_eq!(
            select(&value, "result.items.1.id").expect("select"),
            Some(&json!("b"))
        );
        assert_eq!(select(&value, "result.missing").expect("select"), None);
        assert_eq!(select(&value, "x.y").expect("select"), None);
        let error = select(&value, "__proto__.polluted").expect_err("blocked");
        assert_eq!(error.code, "PROTOTYPE_POLLUTION_BLOCKED");
        assert_eq!(
            select(&value, "a..b").expect_err("empty").code,
            "INVALID_PATH"
        );
    }

    #[test]
    fn set_path_creates_objects_and_arrays() {
        let mut root = json!({});
        set_path(&mut root, "a.b.0.c", json!("x")).expect("set");
        assert_eq!(root, json!({"a": {"b": [{"c": "x"}]}}));
        set_path(&mut root, "a.b.1", json!(2)).expect("set");
        assert_eq!(root["a"]["b"][1], json!(2));
        let mut scalar = json!(1);
        assert_eq!(
            set_path(&mut scalar, "a", json!(1))
                .expect_err("scalar")
                .code,
            "INVALID_TARGET"
        );
        assert_eq!(
            set_path(&mut root, "__proto__.x", json!(1))
                .expect_err("blocked")
                .code,
            "PROTOTYPE_POLLUTION_BLOCKED"
        );
    }

    #[test]
    fn templates_support_double_and_single_braces() {
        let roots =
            json!({"attempt": {"reference": "ORD-1"}, "customer": {"phone": "+218900000000"}});
        let value = roots.as_object().expect("object").clone();
        let direct: Vec<&Map<String, Value>> = Vec::new();
        assert_eq!(
            render_context_template(
                "ref={{attempt.reference}}&p={customer.phone}",
                &value,
                &direct
            ),
            "ref=ORD-1&p=+218900000000"
        );
        // A single-brace placeholder is accepted too.
        assert_eq!(
            render_context_template("{attempt.reference}", &value, &direct),
            "ORD-1"
        );
        // Unknown paths render empty, never the literal placeholder.
        assert_eq!(render_context_template("x={{nope}}", &value, &direct), "x=");
    }

    #[test]
    fn value_stringification_matches_js() {
        assert_eq!(stringify_value(&Value::Null), "");
        assert_eq!(stringify_value(&json!(true)), "true");
        assert_eq!(stringify_value(&json!(12)), "12");
        assert_eq!(stringify_value(&json!([1, 2])), "1,2");
        assert_eq!(stringify_value(&json!({"a": 1})), "{\"a\":1}");
    }

    #[test]
    fn assertions_use_loose_string_equality() {
        let source =
            json!({"status": "SUCCESS", "approved": true, "code": "00", "text": "APPROVED-1"});
        let assertion = Assertion::equals("approved", json!(true));
        assert!(evaluate_assertion(&assertion, &source).expect("equals"));
        let assertion = Assertion::new("code", AssertionOp::In, Some(json!(["00", "99"])));
        assert!(evaluate_assertion(&assertion, &source).expect("in"));
        let assertion =
            Assertion::new("text", AssertionOp::Matches, Some(json!("^APPROVED-\\d+$")));
        assert!(evaluate_assertion(&assertion, &source).expect("matches"));
        let assertion = Assertion::exists("status");
        assert!(evaluate_assertion(&assertion, &source).expect("exists"));
        let assertion = Assertion::exists("missing");
        assert!(!evaluate_assertion(&assertion, &source).expect("exists"));
        let assertion = Assertion::new("text", AssertionOp::Matches, Some(json!("[")));
        assert_eq!(
            evaluate_assertion(&assertion, &source)
                .expect_err("bad pattern")
                .code,
            "INVALID_STATUS_PATTERN"
        );
    }

    #[test]
    fn encode_uri_component_matches_the_js_set() {
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("x/y?z"), "x%2Fy%3Fz");
        assert_eq!(encode_uri_component("!'()*-._~"), "!'()*-._~");
        assert_eq!(
            encode_uri_component("مرحبا"),
            "%D9%85%D8%B1%D8%AD%D8%A8%D8%A7"
        );
    }

    #[test]
    fn compile_url_substitutes_path_and_query() {
        let mut query = Map::new();
        query.insert("amount".to_owned(), json!("12.5000"));
        query.insert("nested".to_owned(), json!({"a": "b c"}));
        query.insert("tags".to_owned(), json!(["x", "y"]));
        let mut path = Map::new();
        path.insert("id".to_owned(), json!("a b"));
        let url = compile_url(
            "https://api.example.ly/pay/{id}",
            &query,
            &path,
            &UrlOptions {
                allowed_hosts: Some(vec!["api.example.ly".to_owned()]),
                require_https: true,
                ..UrlOptions::default()
            },
        )
        .expect("url");
        assert!(url.starts_with("https://api.example.ly/pay/a%20b?"));
        assert!(url.contains("amount=12.5000"));
        assert!(url.contains("nested[a]=b%20c"));
        assert!(url.contains("tags[0]=x"));
        assert!(url.contains("tags[1]=y"));
    }

    #[test]
    fn compile_url_enforces_https_allowlist_and_traversal() {
        let options = UrlOptions {
            allowed_hosts: Some(vec!["api.example.ly".to_owned()]),
            require_https: true,
            ..UrlOptions::default()
        };
        assert_eq!(
            compile_url(
                "http://api.example.ly/x",
                &Map::new(),
                &Map::new(),
                &options
            )
            .expect_err("https")
            .code,
            "INSECURE_URL_BLOCKED"
        );
        assert_eq!(
            compile_url("https://evil.example/x", &Map::new(), &Map::new(), &options)
                .expect_err("host")
                .code,
            "HOST_NOT_ALLOWED"
        );
        assert_eq!(
            compile_url(
                "https://api.example.ly/a/../b",
                &Map::new(),
                &Map::new(),
                &options
            )
            .expect_err("traversal")
            .code,
            "INVALID_URL_PATH"
        );
        assert_eq!(
            compile_url(
                "https://api.example.ly/{missing}",
                &Map::new(),
                &Map::new(),
                &options
            )
            .expect_err("placeholder")
            .code,
            "MISSING_URL_PARAMETER"
        );
        let mut path = Map::new();
        path.insert("id".to_owned(), json!("a/b"));
        assert_eq!(
            compile_url("https://api.example.ly/{id}", &Map::new(), &path, &options)
                .expect_err("separator")
                .code,
            "INVALID_URL_PATH"
        );
    }

    #[test]
    fn private_hosts_are_refused_unless_relaxed() {
        let mut options = UrlOptions {
            allowed_hosts: Some(vec!["fake-rails.local".to_owned()]),
            require_https: false,
            allow_insecure_http: true,
            ..UrlOptions::default()
        };
        assert_eq!(
            compile_url(
                "http://fake-rails.local:4003/x",
                &Map::new(),
                &Map::new(),
                &options
            )
            .expect_err("private")
            .code,
            "SSRF_PRIVATE_ADDRESS_BLOCKED"
        );
        options.allow_private_hosts = true;
        assert!(compile_url(
            "http://fake-rails.local:4003/x",
            &Map::new(),
            &Map::new(),
            &options
        )
        .is_ok());
    }

    #[test]
    fn xml_escape_matches_the_transform() {
        assert_eq!(
            xml_escape(&json!("a & b < c > \"d\" 'e'")),
            "a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;"
        );
    }
}
