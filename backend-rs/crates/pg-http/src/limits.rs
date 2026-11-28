//! Body limits (chapter 2 §2).
//!
//! Core raw-body routes are matched before JSON parsing; report-engine JSON routes get 24 MB and
//! every other JSON route 1 MB. Limits are decimal MB like Express `bytes` defaults written by TS.

#![forbid(unsafe_code)]

pub const MB: u64 = 1_000_000;

pub const MAX_JSON_BODY_BYTES_DEFAULT: u64 = MB;
pub const REPORT_ENGINE_JSON_LIMIT: u64 = 24 * MB;
pub const URLENCODED_LIMIT: u64 = MB;

pub const RAW_RECONCILIATION_UPLOAD: u64 = 100 * MB;
pub const RAW_ASSET_UPLOAD: u64 = 5 * MB;
pub const RAW_KYB_DOCUMENT: u64 = 25 * MB;
pub const RAW_CHECKOUT_INBOUND: u64 = 25 * MB;
pub const RAW_AML_EVIDENCE: u64 = 50 * MB;
pub const RAW_DISPUTE_ATTACHMENT: u64 = 25 * MB;
pub const RAW_DEFAULT: u64 = 25 * MB;

/// Edge JSON limits.
pub const ADMIN_EDGE_JSON_LIMIT: u64 = 4 * MB;
pub const MERCHANT_EDGE_JSON_LIMIT: u64 = 2 * MB;
pub const CHECKOUT_EDGE_JSON_LIMIT: u64 = MB;

/// Core JSON limit for a path.
#[must_use]
pub fn json_limit_for(path: &str) -> u64 {
    if path.starts_with("/internal/admin/report-engine")
        || path.starts_with("/internal/merchant/report-engine")
    {
        REPORT_ENGINE_JSON_LIMIT
    } else {
        MAX_JSON_BODY_BYTES_DEFAULT
    }
}

/// Core raw-body limit for a path, or `None` when the route is not a raw-body route.
#[must_use]
pub fn raw_body_limit_for(path: &str) -> Option<u64> {
    if path == "/internal/admin/reconciliation/upload" {
        return Some(RAW_RECONCILIATION_UPLOAD);
    }
    if path == "/internal/admin/assets/upload" {
        return Some(RAW_ASSET_UPLOAD);
    }
    if path == "/internal/merchant/onboarding/kyb-documents" {
        return Some(RAW_KYB_DOCUMENT);
    }
    if path == "/internal/checkout/inbound" || path.starts_with("/internal/checkout/inbound/") {
        return Some(RAW_CHECKOUT_INBOUND);
    }
    if matches_dynamic(path, "/internal/admin/join-requests/", "/kyb-documents") {
        return Some(RAW_KYB_DOCUMENT);
    }
    if matches_dynamic(path, "/internal/admin/aml/cases/", "/evidence") {
        return Some(RAW_AML_EVIDENCE);
    }
    if matches_dynamic(path, "/internal/admin/disputes/", "/attachments")
        || matches_dynamic(path, "/internal/merchant/disputes/", "/attachments")
    {
        return Some(RAW_DISPUTE_ATTACHMENT);
    }
    None
}

/// `/prefix/<one segment><suffix>` with exactly one segment.
fn matches_dynamic(path: &str, prefix: &str, suffix: &str) -> bool {
    let Some(rest) = path.strip_prefix(prefix) else {
        return false;
    };
    let Some(segment) = rest.strip_suffix(suffix) else {
        return false;
    };
    !segment.is_empty() && !segment.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_engine_gets_24mb() {
        assert_eq!(
            json_limit_for("/internal/admin/report-engine/specs"),
            REPORT_ENGINE_JSON_LIMIT
        );
        assert_eq!(json_limit_for("/internal/admin/merchants"), MB);
    }

    #[test]
    fn raw_limits_match_the_table() {
        assert_eq!(
            raw_body_limit_for("/internal/admin/reconciliation/upload"),
            Some(100 * MB)
        );
        assert_eq!(
            raw_body_limit_for("/internal/admin/join-requests/abc/kyb-documents"),
            Some(25 * MB)
        );
        assert_eq!(
            raw_body_limit_for("/internal/admin/aml/cases/abc/evidence"),
            Some(50 * MB)
        );
        assert_eq!(raw_body_limit_for("/internal/admin/merchants"), None);
    }
}
