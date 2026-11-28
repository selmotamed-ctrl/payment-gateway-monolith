//! Upload guards: session shape, declared length and the per-address budget, before any file is
//! buffered.
//!
//! Port of `{admin,merchant}-back/api/upload.ts` (`uploadGuards`, `uploadLimiter`, `uploadSingle`)
//! and the `LIMIT_*` error mapping.
//!
//! The TypeScript order is: rate limiter → session plausibility (merchant; the admin route relies
//! on its session middleware) → `Content-Length` pre-check → multipart parser. This guard keeps
//! that order and applies the session-shape check on both edges (it is advisory either way; core
//! verifies the token). The counter itself is `pg_http::FixedWindowLimiter`, keyed by
//! [`upload_rate_key`] with a 60 s window and the **per-edge** budget from
//! [`EdgeKind::upload_rate_limit_per_minute`] (admin 20, merchant 10).

#![forbid(unsafe_code)]

use crate::error::{EdgeError, UploadKind};
use crate::limits::{check_upload_length, EdgeKind, MULTIPART_OVERHEAD_BYTES};
use crate::session_cookie::assert_session_shape;

/// The pre-multipart gate of one edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadGuard {
    pub edge: EdgeKind,
    pub max_upload_bytes: u64,
    pub rate_limit_per_minute: u32,
}

impl UploadGuard {
    /// Build a guard with an explicit budget (a deployment may override the TS defaults).
    #[must_use]
    pub fn new(edge: EdgeKind, max_upload_bytes: u64, rate_limit_per_minute: u32) -> Self {
        Self {
            edge,
            max_upload_bytes,
            rate_limit_per_minute,
        }
    }

    /// The per-edge defaults: admin 20 uploads/min, merchant 10 uploads/min, `MAX_UPLOAD_BYTES`
    /// 20 MiB / 10 MiB.
    #[must_use]
    pub fn for_edge(edge: EdgeKind) -> Self {
        Self::new(
            edge,
            edge.max_upload_bytes(),
            edge.upload_rate_limit_per_minute(),
        )
    }

    /// Refuse a malformed/expired session and an explicitly oversized body.
    ///
    /// A chunked upload has no `Content-Length`; the streaming multipart scanner still enforces the
    /// byte limit in that case.
    pub fn admit(
        &self,
        authorization: Option<&str>,
        declared_content_length: Option<u64>,
        now_ms: i64,
    ) -> Result<(), EdgeError> {
        let audience = self.edge.session_audience().ok_or(EdgeError::AuthInvalid)?;
        assert_session_shape(authorization, audience, now_ms)?;
        check_upload_length(
            declared_content_length,
            self.max_upload_bytes,
            self.edge.upload_kind(),
        )
    }

    /// Rate-limit bucket of one upload: `<client ip>|upload`, the TS `rateLimitKey(req, "upload")`.
    #[must_use]
    pub fn rate_key(&self, client_ip: &str) -> String {
        upload_rate_key(client_ip)
    }

    #[must_use]
    pub fn overhead_bytes(&self) -> u64 {
        MULTIPART_OVERHEAD_BYTES
    }
}

#[must_use]
pub fn upload_rate_key(client_ip: &str) -> String {
    format!("{client_ip}|upload")
}

/// Port of the multer error branch shared by both upload helpers.
#[must_use]
pub fn upload_error(code: Option<&str>, kind: UploadKind) -> EdgeError {
    match code {
        Some("LIMIT_FILE_SIZE") => EdgeError::UploadTooLarge(kind),
        Some("LIMIT_UNEXPECTED_FILE") => EdgeError::UploadUnexpectedField,
        _ => EdgeError::UploadInvalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_cookie::{ADMIN_SESSION_AUDIENCE, MERCHANT_SESSION_AUDIENCE};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use serde_json::json;

    fn session_token(audience: &str, now_ms: i64) -> String {
        let header = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&json!({ "alg": "HS256", "typ": "JWT" })).expect("header"));
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "typ": "session",
                "aud": audience,
                "exp": now_ms / 1000 + 3600,
            }))
            .expect("payload"),
        );
        format!("Bearer {header}.{payload}.signature")
    }

    #[test]
    fn defaults_match_the_edges() {
        let guard = UploadGuard::for_edge(EdgeKind::Admin);
        assert_eq!(guard.max_upload_bytes, 20 * 1024 * 1024);
        assert_eq!(guard.rate_limit_per_minute, 20);
        assert_eq!(guard.rate_key("203.0.113.9"), "203.0.113.9|upload");
        assert_eq!(guard.overhead_bytes(), 262_144);

        let merchant = UploadGuard::for_edge(EdgeKind::Merchant);
        assert_eq!(merchant.max_upload_bytes, 10 * 1024 * 1024);
        assert_eq!(merchant.rate_limit_per_minute, 10);

        // A caller may override the per-edge defaults explicitly.
        let custom = UploadGuard::new(EdgeKind::Admin, 1_000, 3);
        assert_eq!(custom.max_upload_bytes, 1_000);
        assert_eq!(custom.rate_limit_per_minute, 3);
    }

    #[test]
    fn session_shape_is_required_before_the_length_check() {
        let guard = UploadGuard::for_edge(EdgeKind::Merchant);
        assert_eq!(
            guard.admit(None, Some(u64::MAX), 1_000),
            Err(EdgeError::AuthInvalid)
        );
        assert_eq!(
            guard.admit(Some("Bearer pg_live_x"), None, 1_000),
            Err(EdgeError::AuthInvalid)
        );
    }

    #[test]
    fn a_valid_session_reaches_the_length_check() {
        let now_ms = 1_700_000_000_000;
        let merchant = UploadGuard::for_edge(EdgeKind::Merchant);
        let token = session_token(MERCHANT_SESSION_AUDIENCE, now_ms);
        assert_eq!(
            merchant.admit(Some(token.as_str()), Some(10), now_ms),
            Ok(())
        );
        assert_eq!(
            merchant.admit(Some(token.as_str()), Some(11 * 1024 * 1024), now_ms),
            Err(EdgeError::UploadTooLarge(UploadKind::Document))
        );

        let admin = UploadGuard::for_edge(EdgeKind::Admin);
        let admin_token = session_token(ADMIN_SESSION_AUDIENCE, now_ms);
        assert_eq!(
            admin.admit(Some(admin_token.as_str()), Some(10), now_ms),
            Ok(())
        );
        assert_eq!(
            admin.admit(Some(admin_token.as_str()), Some(21 * 1024 * 1024), now_ms),
            Err(EdgeError::UploadTooLarge(UploadKind::Statement))
        );
    }

    #[test]
    fn wrong_channel_session_is_refused() {
        let now_ms = 1_700_000_000_000;
        let admin_token = session_token(ADMIN_SESSION_AUDIENCE, now_ms);
        let merchant = UploadGuard::for_edge(EdgeKind::Merchant);
        assert_eq!(
            merchant.admit(Some(admin_token.as_str()), None, now_ms),
            Err(EdgeError::AuthInvalid)
        );
    }

    #[test]
    fn checkout_has_no_upload_session() {
        assert_eq!(
            UploadGuard::for_edge(EdgeKind::Checkout).admit(None, None, 0),
            Err(EdgeError::AuthInvalid)
        );
    }

    #[test]
    fn multer_error_mapping() {
        assert_eq!(
            upload_error(Some("LIMIT_FILE_SIZE"), UploadKind::Document),
            EdgeError::UploadTooLarge(UploadKind::Document)
        );
        assert_eq!(
            upload_error(Some("LIMIT_UNEXPECTED_FILE"), UploadKind::Statement),
            EdgeError::UploadUnexpectedField
        );
        assert_eq!(
            upload_error(Some("LIMIT_FIELD_COUNT"), UploadKind::Statement),
            EdgeError::UploadInvalid
        );
        assert_eq!(
            upload_error(None, UploadKind::Statement),
            EdgeError::UploadInvalid
        );
    }
}
