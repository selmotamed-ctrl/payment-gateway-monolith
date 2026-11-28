//! The P3 authenticated sample: `GET /internal/admin/auth/me`.
//!
//! TS shape (`core-back/api/internal/admin.ts:1104`): `{platformName, version, suspended,
//! communication}`. `communication` is the public communication status, which the P3 shell does
//! not read yet, so it is `null` — exactly what the TS handler returns when the status query fails.
//!
//! The authenticated principal is added under `principal` so the double check is observable. This
//! route is a P3 probe (see `bins/core-rs/README.md`): the real admin auth module lands in P7-T02
//! and keeps the TS route public.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_domain_auth::{Principal, PrincipalKind};
use serde_json::json;

use crate::state::AppState;

/// Split apparatus: keep the TS version derivation in one place (`GIT_COMMIT.slice(0, 12)`).
#[must_use]
pub fn version_label(commit: Option<&str>) -> String {
    match commit.filter(|value| !value.is_empty()) {
        Some(commit) => commit.chars().take(12).collect(),
        None => "dev".to_owned(),
    }
}

/// The principal view exposed by the probe (never includes the token or the raw claims).
#[must_use]
pub fn principal_json(principal: &Principal) -> serde_json::Value {
    json!({
        "kind": match principal.kind {
            PrincipalKind::Session => "session",
            PrincipalKind::ApiToken => "apiToken",
        },
        "userId": principal.user_id,
        "role": principal.role,
        "merchantId": principal.merchant_id,
        "applicationId": principal.application_id,
        "authorities": principal.authorities,
        "scopes": principal.scopes,
        "appScopeIds": principal.app_scope_ids,
        "sessionChannel": principal.session_channel.map(pg_domain_auth::Channel::as_str),
    })
}

/// `GET /internal/admin/auth/me`.
#[must_use]
pub fn me(state: &AppState, principal: &Principal) -> HttpResponse {
    let body = json!({
        "platformName": "Payment Gateway",
        "version": version_label(state.config.commit.as_deref()),
        "suspended": false,
        "communication": serde_json::Value::Null,
        "principal": principal_json(principal),
    });
    HttpResponse::Ok()
        .content_type("application/json; charset=utf-8")
        .body(body.to_string())
}

/// Keep the request parameter available for future headers without an unused-import warning.
pub fn has_request_id(request: &HttpRequest) -> bool {
    request.headers().contains_key("x-request-id")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_first_twelve_commit_characters() {
        assert_eq!(version_label(Some("0123456789abcdef")), "0123456789ab");
        assert_eq!(version_label(Some("abc")), "abc");
        assert_eq!(version_label(None), "dev");
        assert_eq!(version_label(Some("")), "dev");
    }
}
