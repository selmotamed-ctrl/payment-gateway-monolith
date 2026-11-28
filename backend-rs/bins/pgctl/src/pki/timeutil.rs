//! Date arithmetic without a calendar dependency.
//!
//! `rcgen` expresses validity as `time::OffsetDateTime`. We only need day precision for issued
//! certificates and epoch seconds for comparisons/inventory, so a small civil-date conversion
//! (Howard Hinnant's algorithm) is enough and keeps the dependency list to the approved crates.

/// Seconds in one day.
pub const DAY_SECONDS: i64 = 86_400;

/// Convert days since the Unix epoch to a civil `(year, month, day)`.
#[must_use]
pub fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (year as i32, month as u8, day as u8)
}

/// Convert epoch seconds to the `(year, month, day)` at midnight UTC of that instant.
#[must_use]
pub fn ymd_from_unix(unix: i64) -> (i32, u8, u8) {
    civil_from_days(unix.div_euclid(DAY_SECONDS))
}

/// Format epoch seconds as RFC 3339 UTC (`2026-11-28T09:15:00Z`).
#[must_use]
pub fn format_unix_rfc3339(unix: i64) -> String {
    let (year, month, day) = ymd_from_unix(unix);
    let seconds = unix.rem_euclid(DAY_SECONDS);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
}

/// Whole days from `now` until `timestamp`, rounded down (`0` inside the same day, negative when
/// the timestamp is in the past). Port of the TypeScript `Math.floor((expires - now) / 86400000)`.
#[must_use]
pub fn days_until(timestamp: i64, now: i64) -> i64 {
    (timestamp - now).div_euclid(DAY_SECONDS)
}

/// Convert a 20-byte serial to lowercase hex without separators.
#[must_use]
pub fn serial_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_and_known_dates_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-11-28 = 20,785 days after the epoch.
        assert_eq!(civil_from_days(20_785), (2026, 11, 28));
        assert_eq!(format_unix_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_unix_rfc3339(20_785 * DAY_SECONDS + 3_723),
            "2026-11-28T01:02:03Z"
        );
        assert_eq!(ymd_from_unix(-1), (1969, 12, 31));
    }

    #[test]
    fn day_differences_are_floored() {
        assert_eq!(days_until(0, 0), 0);
        assert_eq!(days_until(DAY_SECONDS, 0), 1);
        assert_eq!(days_until(DAY_SECONDS - 1, 0), 0);
        assert_eq!(days_until(-1, 0), -1);
        assert_eq!(days_until(0, DAY_SECONDS / 2), -1);
    }

    #[test]
    fn serial_hex_is_lowercase_and_unseparated() {
        assert_eq!(serial_hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
