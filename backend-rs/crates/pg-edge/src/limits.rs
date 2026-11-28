//! Edge body limits and upload pre-checks.
//!
//! Port of `{admin,merchant,checkout}-back/lib/env/index.ts` (`MAX_JSON_BODY_BYTES` defaults),
//! `{admin,merchant}-back/api/upload.ts` (`MULTIPART_OVERHEAD_BYTES`, the `Content-Length`
//! pre-check and the 10-per-window upload budget) and the Express body-parser error branch
//! (`413 PAYLOAD_TOO_LARGE` / message "The request body exceeds the size limit").
//!
//! Sizes are binary MiB because the `bytes` package Express uses parses `4mb` as 4 × 1024 × 1024.

#![forbid(unsafe_code)]

use crate::error::{EdgeError, UploadKind};

pub const MIB: u64 = 1024 * 1024;

/// Admin edge `MAX_JSON_BODY_BYTES` default.
pub const ADMIN_JSON_LIMIT: u64 = 4 * MIB;
/// Merchant edge `MAX_JSON_BODY_BYTES` default.
pub const MERCHANT_JSON_LIMIT: u64 = 2 * MIB;
/// Checkout edge `MAX_JSON_BODY_BYTES` default.
pub const CHECKOUT_JSON_LIMIT: u64 = MIB;

/// Admin `MAX_UPLOAD_BYTES` default.
pub const ADMIN_MAX_UPLOAD_BYTES: u64 = 20 * MIB;
/// Merchant `MAX_UPLOAD_BYTES` default.
pub const MERCHANT_MAX_UPLOAD_BYTES: u64 = 10 * MIB;

/// Multipart framing tolerated on top of the file limit (`256 * 1024` in both upload helpers).
pub const MULTIPART_OVERHEAD_BYTES: u64 = 256 * 1024;

/// Admin uploads per client address per rate window (`admin-back` `UPLOAD_RATE_LIMIT_MAX`
/// default 20; chapter 2 §9 "uploads 20").
pub const ADMIN_UPLOAD_RATE_LIMIT_PER_MINUTE: u32 = 20;

/// Merchant uploads per client address per rate window (`merchant-back` `UPLOAD_RATE_LIMIT_MAX`
/// default 10; chapter 2 §9 "upload 10").
pub const MERCHANT_UPLOAD_RATE_LIMIT_PER_MINUTE: u32 = 10;

/// Fixed upload rate window (`ADMIN_RATE_LIMIT_WINDOW_MS` / `API_RATE_LIMIT_WINDOW_MS` default).
pub const UPLOAD_RATE_LIMIT_WINDOW_MS: u64 = 60_000;

/// Which edge is serving the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Admin,
    Merchant,
    Checkout,
}

impl EdgeKind {
    /// The edge's `express.json({ limit })` value.
    #[must_use]
    pub fn json_limit(self) -> u64 {
        match self {
            Self::Admin => ADMIN_JSON_LIMIT,
            Self::Merchant => MERCHANT_JSON_LIMIT,
            Self::Checkout => CHECKOUT_JSON_LIMIT,
        }
    }

    /// The noun used by upload errors.
    #[must_use]
    pub fn upload_kind(self) -> UploadKind {
        match self {
            Self::Admin => UploadKind::Statement,
            Self::Merchant | Self::Checkout => UploadKind::Document,
        }
    }

    /// Session audience required before a multipart body is buffered. Checkout has no session
    /// cookie/upload route, so it has no audience.
    #[must_use]
    pub fn session_audience(self) -> Option<&'static str> {
        match self {
            Self::Admin => Some(crate::session_cookie::ADMIN_SESSION_AUDIENCE),
            Self::Merchant => Some(crate::session_cookie::MERCHANT_SESSION_AUDIENCE),
            Self::Checkout => None,
        }
    }

    /// Default `MAX_UPLOAD_BYTES`.
    #[must_use]
    pub fn max_upload_bytes(self) -> u64 {
        match self {
            Self::Admin => ADMIN_MAX_UPLOAD_BYTES,
            Self::Merchant => MERCHANT_MAX_UPLOAD_BYTES,
            Self::Checkout => MERCHANT_MAX_UPLOAD_BYTES,
        }
    }

    /// Uploads per client address per 60 s window (`UPLOAD_RATE_LIMIT_MAX`).
    ///
    /// Admin keeps its own 20/min budget (`admin-back`), merchant 10/min (`merchant-back`).
    /// Checkout has no upload route today; it follows the merchant default so a future route is
    /// bounded from the start.
    #[must_use]
    pub fn upload_rate_limit_per_minute(self) -> u32 {
        match self {
            Self::Admin => ADMIN_UPLOAD_RATE_LIMIT_PER_MINUTE,
            Self::Merchant | Self::Checkout => MERCHANT_UPLOAD_RATE_LIMIT_PER_MINUTE,
        }
    }
}

/// Refuse a declared length above the JSON limit before buffering.
pub fn check_declared_length(declared: Option<u64>, limit: u64) -> Result<(), EdgeError> {
    match declared {
        Some(length) if length > limit => Err(EdgeError::PayloadTooLarge),
        _ => Ok(()),
    }
}

/// The upload `Content-Length` pre-check.
///
/// Port of the inline guard in both `api/upload.ts` helpers: only an explicitly oversized
/// declared length is refused here (a chunked client has no length; the streaming parser still
/// enforces the byte limit).
pub fn check_upload_length(
    declared: Option<u64>,
    max_upload_bytes: u64,
    kind: UploadKind,
) -> Result<(), EdgeError> {
    let budget = max_upload_bytes.saturating_add(MULTIPART_OVERHEAD_BYTES);
    match declared {
        Some(length) if length > budget => Err(EdgeError::UploadTooLarge(kind)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_limits_match_the_edges() {
        assert_eq!(EdgeKind::Admin.json_limit(), 4_194_304);
        assert_eq!(EdgeKind::Merchant.json_limit(), 2_097_152);
        assert_eq!(EdgeKind::Checkout.json_limit(), 1_048_576);
    }

    #[test]
    fn declared_length_is_refused_only_when_oversized() {
        assert_eq!(check_declared_length(None, 100), Ok(()));
        assert_eq!(check_declared_length(Some(100), 100), Ok(()));
        assert_eq!(
            check_declared_length(Some(101), 100),
            Err(EdgeError::PayloadTooLarge)
        );
    }

    #[test]
    fn upload_length_includes_multipart_overhead() {
        let max = 1_000;
        let budget = max + MULTIPART_OVERHEAD_BYTES;
        assert_eq!(
            check_upload_length(None, max, UploadKind::Statement),
            Ok(())
        );
        assert_eq!(
            check_upload_length(Some(budget), max, UploadKind::Statement),
            Ok(())
        );
        assert_eq!(
            check_upload_length(Some(budget + 1), max, UploadKind::Document),
            Err(EdgeError::UploadTooLarge(UploadKind::Document))
        );
        assert_eq!(MULTIPART_OVERHEAD_BYTES, 262_144);
        assert_eq!(ADMIN_UPLOAD_RATE_LIMIT_PER_MINUTE, 20);
        assert_eq!(MERCHANT_UPLOAD_RATE_LIMIT_PER_MINUTE, 10);
        assert_eq!(UPLOAD_RATE_LIMIT_WINDOW_MS, 60_000);
    }

    #[test]
    fn edge_defaults() {
        assert_eq!(EdgeKind::Admin.max_upload_bytes(), 20_971_520);
        assert_eq!(EdgeKind::Merchant.max_upload_bytes(), 10_485_760);
        assert_eq!(EdgeKind::Admin.upload_rate_limit_per_minute(), 20);
        assert_eq!(EdgeKind::Merchant.upload_rate_limit_per_minute(), 10);
        assert_eq!(EdgeKind::Checkout.upload_rate_limit_per_minute(), 10);
        assert_eq!(
            EdgeKind::Admin.session_audience(),
            Some("payment-gateway-admin")
        );
        assert_eq!(
            EdgeKind::Merchant.session_audience(),
            Some("payment-gateway-merchant")
        );
        assert_eq!(EdgeKind::Checkout.session_audience(), None);
        assert_eq!(EdgeKind::Admin.upload_kind(), UploadKind::Statement);
        assert_eq!(EdgeKind::Merchant.upload_kind(), UploadKind::Document);
    }
}
