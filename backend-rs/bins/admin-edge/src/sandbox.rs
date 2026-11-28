//! `/api/v1/admin/sandbox/*`: staff inspection of the isolated Sandbox plane.
//!
//! Port of `admin-back/api/sandboxProxy.ts`. Every request targets the Sandbox pool and carries
//! `x-execution-plane: SANDBOX` plus `x-sandbox-proxy: admin-back`. There is no Live fallback: an
//! unconfigured Sandbox pool is `503 SANDBOX_NODE_UNAVAILABLE`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::error::{ApiError, EdgeResult};
use crate::schema::{is_uuid, parse_or_throw, uuid};

/// The Studio control path → core path mapping (`targetPath`).
pub fn target_path(path: &str, body: Option<&Value>) -> EdgeResult<TargetPath> {
    let path = path.trim_start_matches('/');
    let path = format!("/{path}");
    if path == "/mirror/reconciliation/runs/summary" {
        return Ok(TargetPath::new("/internal/admin/reconciliation/summary"));
    }
    if path == "/mirror/reconciliation/runs/summary/export" {
        return Ok(TargetPath::new(
            "/internal/admin/reconciliation/summary/export",
        ));
    }
    if path == "/mirror" || path.starts_with("/mirror/") {
        let suffix = path.strip_prefix("/mirror").unwrap_or("/");
        let suffix = if suffix.is_empty() { "/" } else { suffix };
        return Ok(TargetPath::new(format!("/internal/admin{suffix}")));
    }
    if path == "/overview" {
        return Ok(TargetPath::new("/internal/sandbox/admin/overview"));
    }
    if path == "/global-reset" {
        return Ok(TargetPath::new("/internal/sandbox/admin/reset"));
    }
    if let Some(merchant_id) = path
        .strip_prefix("/merchants/")
        .and_then(|rest| rest.strip_suffix("/overview"))
    {
        let merchant_id = valid_uuid(merchant_id)?;
        return Ok(TargetPath::new(format!(
            "/internal/sandbox/admin/merchants/{}/overview",
            encode_uri_component(&merchant_id)
        )));
    }
    if path == "/reset" {
        let body = body.ok_or_else(missing_merchant_id)?;
        let parsed = parse_or_throw(&merchant_body(), body)?;
        let merchant_id = parsed
            .get("merchantId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        return Ok(TargetPath::query(
            "/internal/sandbox/merchant/reset",
            vec![("merchantId".to_owned(), merchant_id)],
        ));
    }
    if let Some(wallet_id) = path.strip_prefix("/wallet-balance/") {
        if wallet_id.is_empty() || wallet_id.contains('/') {
            return Ok(TargetPath::new(format!("/internal/sandbox/admin{path}")));
        }
        return Ok(TargetPath::new(format!(
            "/internal/sandbox/merchant/wallets/{}/balance",
            encode_uri_component(wallet_id)
        )));
    }
    let fake_rails_admin = [
        "/fake-rails/scenarios",
        "/fake-rails/transactions",
        "/fake-rails/webhooks",
        "/fake-rails/statements",
        "/fake-rails/accounts/summary",
    ]
    .iter()
    .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    if fake_rails_admin {
        return Ok(TargetPath::new(format!("/internal/sandbox/admin{path}")));
    }
    if path.starts_with("/fake-rails/") {
        return Ok(TargetPath::new(format!("/internal/sandbox{path}")));
    }
    if let Some(merchant_id) = path
        .strip_prefix("/merchants/")
        .and_then(|rest| rest.strip_suffix("/seed"))
    {
        let merchant_id = valid_uuid(merchant_id)?;
        return Ok(TargetPath::query(
            "/internal/sandbox/merchant/seed-demo",
            vec![("merchantId".to_owned(), merchant_id)],
        ));
    }
    if let Some(merchant_id) = path
        .strip_prefix("/merchants/")
        .and_then(|rest| rest.strip_suffix("/seed-history"))
    {
        let merchant_id = valid_uuid(merchant_id)?;
        return Ok(TargetPath::query(
            "/internal/sandbox/merchant/seed-history",
            vec![("merchantId".to_owned(), merchant_id)],
        ));
    }
    if path == "/audits" || path.starts_with("/audits/") {
        return Ok(TargetPath::new(format!("/internal/sandbox/admin{path}")));
    }
    if path.starts_with("/merchants") {
        return Ok(TargetPath::new(format!("/internal/sandbox/admin{path}")));
    }
    Ok(TargetPath::new(format!("/internal/sandbox/admin{path}")))
}

/// A resolved Sandbox target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetPath {
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl TargetPath {
    fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            query: Vec::new(),
        }
    }

    fn query(path: impl Into<String>, query: Vec<(String, String)>) -> Self {
        Self {
            path: path.into(),
            query,
        }
    }
}

fn merchant_body() -> crate::schema::Schema {
    crate::schema::object()
        .req("merchantId", uuid())
        .passthrough()
        .build()
}

fn valid_uuid(value: &str) -> EdgeResult<String> {
    if is_uuid(value) {
        Ok(value.to_owned())
    } else {
        Err(ApiError::validation_failed(vec![serde_json::json!({
            "code": "invalid_format",
            "path": ["merchantId"],
            "message": "Invalid UUID",
        })]))
    }
}

fn missing_merchant_id() -> ApiError {
    ApiError::validation_failed(vec![serde_json::json!({
        "code": "invalid_type",
        "path": ["merchantId"],
        "message": "Invalid input: expected value, received undefined",
    })])
}

/// `encodeURIComponent`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    crate::upload::encode_uri_component(value)
}

/// Body of a merchant `/reset`: the sandbox router rejects unknown fields, so only `confirm`
/// (a string) and `checklist` (an array) are forwarded.
#[must_use]
pub fn reset_body(body: &Value) -> Value {
    let mut result = serde_json::Map::new();
    if let Some(confirm) = body.get("confirm").and_then(Value::as_str) {
        result.insert("confirm".to_owned(), Value::String(confirm.to_owned()));
    }
    if let Some(checklist) = body.get("checklist").and_then(Value::as_array) {
        result.insert("checklist".to_owned(), Value::Array(checklist.clone()));
    }
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn merchant() -> String {
        "0192f6a0-1111-7111-8111-111111111111".to_owned()
    }

    #[test]
    fn maps_control_paths_like_the_ts_router() {
        assert_eq!(
            target_path("/merchants", None).expect("path").path,
            "/internal/sandbox/admin/merchants"
        );
        assert_eq!(
            target_path("/merchants/summary", None).expect("path").path,
            "/internal/sandbox/admin/merchants/summary"
        );
        assert_eq!(
            target_path(&format!("/merchants/{}", merchant()), None)
                .expect("path")
                .path,
            format!("/internal/sandbox/admin/merchants/{}", merchant())
        );
        assert_eq!(
            target_path("/audits", None).expect("path").path,
            "/internal/sandbox/admin/audits"
        );
        assert_eq!(
            target_path("/mirror/reconciliation/runs/summary", None)
                .expect("path")
                .path,
            "/internal/admin/reconciliation/summary"
        );
        assert_eq!(
            target_path("/mirror/reconciliation/runs/run-1", None)
                .expect("path")
                .path,
            "/internal/admin/reconciliation/runs/run-1"
        );
        assert_eq!(
            target_path("/fake-rails/scenarios", None)
                .expect("path")
                .path,
            "/internal/sandbox/admin/fake-rails/scenarios"
        );
        assert_eq!(
            target_path("/fake-rails/accounts/summary", None)
                .expect("path")
                .path,
            "/internal/sandbox/admin/fake-rails/accounts/summary"
        );
        assert_eq!(
            target_path("/fake-rails/accounts", None)
                .expect("path")
                .path,
            "/internal/sandbox/fake-rails/accounts"
        );
    }

    #[test]
    fn reset_and_seed_carry_the_merchant_in_the_query() {
        let target = target_path("/reset", Some(&json!({"merchantId": merchant()}))).expect("path");
        assert_eq!(target.path, "/internal/sandbox/merchant/reset");
        assert_eq!(target.query, vec![("merchantId".to_owned(), merchant())]);
        let target = target_path(&format!("/merchants/{}/seed", merchant()), None).expect("path");
        assert_eq!(target.path, "/internal/sandbox/merchant/seed-demo");
        assert_eq!(target.query[0].0, "merchantId");
        let target =
            target_path(&format!("/merchants/{}/overview", merchant()), None).expect("path");
        assert_eq!(
            target.path,
            format!("/internal/sandbox/admin/merchants/{}/overview", merchant())
        );
    }

    #[test]
    fn invalid_uuid_is_a_validation_failure() {
        let error = target_path("/merchants/nope/overview", None).expect_err("error");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "VALIDATION_FAILED");
    }

    #[test]
    fn reset_body_drops_everything_but_confirm_and_checklist() {
        let body =
            reset_body(&json!({"confirm":"RESET","merchantId":"x","extra":1,"checklist":["A"]}));
        assert_eq!(body, json!({"confirm":"RESET","checklist":["A"]}));
    }
}
