//! Read consistency and the `x-pg-min-lsn` contract.
//!
//! Port of `admin-back/api/forward.ts:9-19` (`LSN_PATTERN`, `minLsnOf`) and the
//! `ReadConsistency` plan type (chapter 3 §4). Only the admin edge validates an inbound
//! `x-pg-min-lsn`; merchant and checkout never forward one, so the TS asymmetry is preserved.

#![forbid(unsafe_code)]

use crate::error::PoolError;
use crate::path::EdgeChannel;

/// How a read must be routed.
///
/// `AtLeastLsn` carries a PostgreSQL LSN in the `x-pg-min-lsn` form (`<hex>/<hex>`). The header is
/// forwarded verbatim; the database layer waits up to `max_wait_ms` for the replica to catch up.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ReadConsistency {
    /// Read from the primary.
    #[default]
    Primary,
    /// Read from any replica.
    Replica,
    /// Read from a replica that has applied at least `lsn`.
    AtLeastLsn { lsn: String, max_wait_ms: u64 },
}

impl ReadConsistency {
    /// The `x-pg-min-lsn` value this consistency requires, if any.
    #[must_use]
    pub fn min_lsn(&self) -> Option<&str> {
        match self {
            Self::AtLeastLsn { lsn, .. } => Some(lsn),
            Self::Primary | Self::Replica => None,
        }
    }
}

/// `^[0-9A-Fa-f]{1,16}/[0-9A-Fa-f]{1,16}$`.
///
/// Port of `LSN_PATTERN` (`admin-back/api/forward.ts:10`).
#[must_use]
pub fn valid_min_lsn(value: &str) -> bool {
    let Some((high, low)) = value.split_once('/') else {
        return false;
    };
    let hex = |part: &str| {
        !part.is_empty() && part.len() <= 16 && part.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    hex(high) && hex(low)
}

/// Validate and normalise an inbound `x-pg-min-lsn` for one edge.
///
/// Port of `minLsnOf` (`admin-back/api/forward.ts:12-19`): an absent or empty header means "no
/// requirement"; the admin edge rejects a malformed value with `400 INVALID_MIN_LSN`. Merchant
/// and checkout do not validate (and never set) the header in TS, so a value supplied by their
/// own code is passed through unchanged.
pub fn min_lsn_header(
    channel: EdgeChannel,
    value: Option<&str>,
) -> Result<Option<String>, PoolError> {
    let Some(raw) = value else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    if channel == EdgeChannel::Admin && !valid_min_lsn(raw) {
        return Err(PoolError::invalid_min_lsn());
    }
    Ok(Some(raw.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsn_pattern_requires_one_to_sixteen_hex_digits_each_side() {
        assert!(valid_min_lsn("0/16B6C50"));
        assert!(valid_min_lsn("16B6C50/16B6C50"));
        assert!(valid_min_lsn("a/b"));
        assert!(valid_min_lsn("0123456789ABCDEF/0123456789abcdef"));
        assert!(!valid_min_lsn(""));
        assert!(!valid_min_lsn("/"));
        assert!(!valid_min_lsn("0/"));
        assert!(!valid_min_lsn("/0"));
        assert!(!valid_min_lsn("0/16B6C5Z"));
        assert!(!valid_min_lsn("0/1/2"));
        assert!(!valid_min_lsn("0123456789ABCDEF0/1"));
        assert!(!valid_min_lsn(" 0/1"));
    }

    #[test]
    fn admin_rejects_a_malformed_header() {
        let error = min_lsn_header(EdgeChannel::Admin, Some("garbage")).expect_err("invalid");
        assert_eq!(error.status(), 400);
        assert_eq!(error.code(), "INVALID_MIN_LSN");
        assert_eq!(error.message(), "x-pg-min-lsn must look like <hex>/<hex>");
        assert_eq!(
            min_lsn_header(EdgeChannel::Admin, Some("0/16B6C50")).expect("valid"),
            Some("0/16B6C50".to_owned())
        );
    }

    #[test]
    fn absent_and_empty_headers_add_no_requirement() {
        assert_eq!(
            min_lsn_header(EdgeChannel::Admin, None).expect("none"),
            None
        );
        assert_eq!(
            min_lsn_header(EdgeChannel::Admin, Some("")).expect("empty"),
            None
        );
    }

    #[test]
    fn merchant_and_checkout_pass_values_through() {
        assert_eq!(
            min_lsn_header(EdgeChannel::Merchant, Some("not-an-lsn")).expect("passthrough"),
            Some("not-an-lsn".to_owned())
        );
        assert_eq!(
            min_lsn_header(EdgeChannel::Checkout, Some("0/1")).expect("passthrough"),
            Some("0/1".to_owned())
        );
    }

    #[test]
    fn consistency_exposes_its_lsn() {
        assert_eq!(ReadConsistency::default(), ReadConsistency::Primary);
        assert_eq!(ReadConsistency::Primary.min_lsn(), None);
        assert_eq!(ReadConsistency::Replica.min_lsn(), None);
        assert_eq!(
            ReadConsistency::AtLeastLsn {
                lsn: "0/16B6C50".to_owned(),
                max_wait_ms: 2_000,
            }
            .min_lsn(),
            Some("0/16B6C50")
        );
    }
}
