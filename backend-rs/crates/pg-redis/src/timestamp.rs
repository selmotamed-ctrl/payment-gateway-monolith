//! JavaScript-compatible timestamps for bus envelopes.
//!
//! Port of `new Date().toISOString()` in
//! `core-back/lib/invalidationBus/index.ts` and `core-back/lib/realtimeBus.ts`: always three
//! fraction digits and a `Z` suffix.

#![forbid(unsafe_code)]

use chrono::{SecondsFormat, TimeZone, Utc};

/// Milliseconds since the Unix epoch as `Date#toISOString()` renders it.
#[must_use]
pub fn iso_from_millis(millis: i64) -> String {
    match Utc.timestamp_millis_opt(millis).single() {
        Some(value) => value.to_rfc3339_opts(SecondsFormat::Millis, true),
        // Only reachable for an out-of-range instant (year > 262143). The Unix epoch keeps the
        // function total instead of panicking.
        None => "1970-01-01T00:00:00.000Z".to_owned(),
    }
}

/// The current instant in the same format.
#[must_use]
pub fn iso_now() -> String {
    iso_from_millis(Utc::now().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millisecond_precision_and_z_suffix() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
    }

    #[test]
    fn now_has_the_javascript_shape() {
        let now = iso_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z'));
        assert_eq!(&now[19..20], ".");
    }
}
