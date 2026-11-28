//! Minimal UTC clock arithmetic for the Academy (no `chrono` dependency).
//!
//! The TS Academy uses `Date` millisecond instants and `addMonthsUtc`
//! (`core-back/engine/academy/catalog.ts:42-47`). This crate carries only `serde`, `serde_json`
//! and `thiserror`, so the few calendar operations it needs are implemented here with the public
//! domain civil-date algorithms (Howard Hinnant): exact, dependency-free and testable.
//!
//! Supported range: years 0-9999 (ISO-8601). Values outside it return `None`; the database stores
//! timestamptz values in that range.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

pub const MILLIS_PER_DAY: i64 = 86_400_000;
pub const MILLIS_PER_SECOND: i64 = 1_000;

/// A UTC instant in milliseconds since the Unix epoch (`Date#getTime()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UtcMillis(pub i64);

/// The broken-down UTC components of an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millisecond: u32,
}

impl UtcMillis {
    #[must_use]
    pub const fn from_millis(millis: i64) -> Self {
        Self(millis)
    }

    #[must_use]
    pub const fn as_millis(self) -> i64 {
        self.0
    }

    /// Build an instant from UTC components (year 0-9999, valid calendar fields only).
    #[must_use]
    pub fn from_civil(civil: Civil) -> Option<Self> {
        if !(0..=9_999).contains(&civil.year)
            || !(1..=12).contains(&civil.month)
            || civil.day == 0
            || civil.day > days_in_month(civil.year, civil.month)
            || civil.hour > 23
            || civil.minute > 59
            || civil.second > 59
            || civil.millisecond > 999
        {
            return None;
        }
        let days = days_from_civil(i64::from(civil.year), civil.month, civil.day);
        let time = i64::from(civil.hour) * 3_600_000
            + i64::from(civil.minute) * 60_000
            + i64::from(civil.second) * 1_000
            + i64::from(civil.millisecond);
        days.checked_mul(MILLIS_PER_DAY)?
            .checked_add(time)
            .map(Self)
    }

    /// The UTC components of the instant.
    #[must_use]
    pub fn civil(self) -> Option<Civil> {
        let days = self.0.div_euclid(MILLIS_PER_DAY);
        let time = self.0.rem_euclid(MILLIS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        let year = i32::try_from(year).ok()?;
        if !(0..=9_999).contains(&year) {
            return None;
        }
        Some(Civil {
            year,
            month,
            day,
            hour: u32::try_from(time / 3_600_000).ok()?,
            minute: u32::try_from((time / 60_000) % 60).ok()?,
            second: u32::try_from((time / 1_000) % 60).ok()?,
            millisecond: u32::try_from(time % 1_000).ok()?,
        })
    }

    /// `addMonthsUtc`: month arithmetic with the day clamped to the shorter month, time kept.
    #[must_use]
    pub fn add_months(self, months: i32) -> Option<Self> {
        let civil = self.civil()?;
        let total = i64::from(civil.year) * 12 + i64::from(civil.month) - 1 + i64::from(months);
        let year = total.div_euclid(12);
        let month = u32::try_from(total.rem_euclid(12) + 1).ok()?;
        let year = i32::try_from(year).ok()?;
        if !(0..=9_999).contains(&year) {
            return None;
        }
        let day = civil.day.min(days_in_month(year, month));
        Self::from_civil(Civil {
            year,
            month,
            day,
            ..civil
        })
    }

    /// `toISOString()` with three fraction digits: `2026-11-28T10:20:30.000Z`.
    #[must_use]
    pub fn to_iso_string(self) -> Option<String> {
        let civil = self.civil()?;
        Some(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            civil.year,
            civil.month,
            civil.day,
            civil.hour,
            civil.minute,
            civil.second,
            civil.millisecond
        ))
    }

    /// Parse `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, an optional `.fff` and an optional `Z`.
    #[must_use]
    pub fn parse_iso(raw: &str) -> Option<Self> {
        let text = raw.trim();
        let (date, time) = match text.split_once(['T', ' ']) {
            Some((date, time)) => (date, Some(time)),
            None => (text, None),
        };
        let mut date_parts = date.split('-');
        let year = date_parts.next()?.parse::<i32>().ok()?;
        let month = date_parts.next()?.parse::<u32>().ok()?;
        let day = date_parts.next()?.parse::<u32>().ok()?;
        if date_parts.next().is_some() {
            return None;
        }
        let (hour, minute, second, millisecond) = match time {
            None => (0, 0, 0, 0),
            Some(time) => {
                let time = time.strip_suffix('Z').unwrap_or(time);
                let (clock, fraction) = match time.split_once('.') {
                    Some((clock, fraction)) => (clock, Some(fraction)),
                    None => (time, None),
                };
                let mut clock_parts = clock.split(':');
                let hour = clock_parts.next()?.parse::<u32>().ok()?;
                let minute = clock_parts.next()?.parse::<u32>().ok()?;
                let second = clock_parts.next()?.parse::<u32>().ok()?;
                if clock_parts.next().is_some() {
                    return None;
                }
                let millisecond = match fraction {
                    None => 0,
                    Some(fraction) => {
                        if fraction.is_empty()
                            || fraction.len() > 3
                            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
                        {
                            return None;
                        }
                        let padded = format!("{fraction:0<3}");
                        padded.parse::<u32>().ok()?
                    }
                };
                (hour, minute, second, millisecond)
            }
        };
        Self::from_civil(Civil {
            year,
            month,
            day,
            hour,
            minute,
            second,
            millisecond,
        })
    }
}

const fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Days in a month (1-based month).
#[must_use]
pub const fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 (Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = i64::from((month + 9) % 12);
    let day_of_year = (153 * month_prime + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn civil(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> UtcMillis {
        UtcMillis::from_civil(Civil {
            year,
            month,
            day,
            hour,
            minute,
            second,
            millisecond: 0,
        })
        .expect("valid civil")
    }

    #[test]
    fn epoch_and_known_instants() {
        assert_eq!(civil(1970, 1, 1, 0, 0, 0).as_millis(), 0);
        assert_eq!(
            civil(2026, 11, 28, 0, 0, 0).to_iso_string().as_deref(),
            Some("2026-11-28T00:00:00.000Z")
        );
        assert_eq!(
            UtcMillis::from_millis(1_700_000_000_123)
                .to_iso_string()
                .as_deref(),
            Some("2023-11-14T22:13:20.123Z")
        );
        assert_eq!(
            UtcMillis::parse_iso("2026-11-28T10:20:30.5Z")
                .expect("parse")
                .to_iso_string()
                .as_deref(),
            Some("2026-11-28T10:20:30.500Z")
        );
        assert_eq!(
            UtcMillis::parse_iso("2026-11-28")
                .expect("parse")
                .as_millis(),
            civil(2026, 11, 28, 0, 0, 0).as_millis()
        );
    }

    #[test]
    fn add_months_clamps_the_day() {
        let january_31 = civil(2026, 1, 31, 12, 30, 45);
        assert_eq!(
            january_31
                .add_months(1)
                .expect("feb")
                .to_iso_string()
                .as_deref(),
            Some("2026-02-28T12:30:45.000Z")
        );
        // 2024 is a leap year.
        assert_eq!(
            civil(2024, 1, 31, 0, 0, 0)
                .add_months(1)
                .expect("feb")
                .to_iso_string()
                .as_deref(),
            Some("2024-02-29T00:00:00.000Z")
        );
        assert_eq!(
            civil(2026, 11, 30, 8, 0, 0)
                .add_months(12)
                .expect("year")
                .to_iso_string()
                .as_deref(),
            Some("2027-11-30T08:00:00.000Z")
        );
        assert_eq!(
            civil(2024, 2, 29, 0, 0, 0)
                .add_months(12)
                .expect("year")
                .to_iso_string()
                .as_deref(),
            Some("2025-02-28T00:00:00.000Z")
        );
        // Negative months cross the year boundary.
        assert_eq!(
            civil(2026, 1, 15, 0, 0, 0)
                .add_months(-1)
                .expect("dec")
                .to_iso_string()
                .as_deref(),
            Some("2025-12-15T00:00:00.000Z")
        );
    }

    #[test]
    fn rejects_invalid_fields() {
        assert!(UtcMillis::from_civil(Civil {
            year: 2026,
            month: 2,
            day: 29,
            hour: 0,
            minute: 0,
            second: 0,
            millisecond: 0
        })
        .is_none());
        assert!(UtcMillis::parse_iso("2026-13-01").is_none());
        assert!(UtcMillis::parse_iso("2026-01-01T24:00:00Z").is_none());
        assert!(UtcMillis::parse_iso("not a date").is_none());
        assert!(UtcMillis::parse_iso("2026-01-01T00:00:00.1234Z").is_none());
    }

    #[test]
    fn round_trips_a_range_of_instants() {
        for millis in [
            0,
            1,
            -1,
            951_782_400_000,
            1_800_000_000_000,
            253_402_300_799_999,
        ] {
            let instant = UtcMillis::from_millis(millis);
            let iso = instant.to_iso_string().expect("iso");
            assert_eq!(UtcMillis::parse_iso(&iso), Some(instant), "{millis} {iso}");
        }
    }
}
