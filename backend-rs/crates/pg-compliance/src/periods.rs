//! Reporting periods, filing due dates and the Libyan business week.
//!
//! Port of `core-back/engine/workers/regulatory/periods.ts` and
//! `core-back/engine/workers/deadlines/businessTime.ts`.
//!
//! Boundaries are local midnights of `Africa/Tripoli` (`UTC+2`, no daylight saving since 2013),
//! expressed as UTC instants; a period is the half-open range `[start, end)`. `chrono-tz` is not a
//! dependency of this crate, so the fixed offset is used directly. If Libya ever reinstates DST,
//! the offset must become a real time-zone lookup (recorded as an open question).

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, Offset, TimeZone, Utc};
use serde::{Deserialize, Serialize};

/// `DEFAULT_BUSINESS_TIME_ZONE`.
pub const DEFAULT_BUSINESS_TIME_ZONE: &str = "Africa/Tripoli";
/// `Africa/Tripoli` is `UTC+2` with no daylight saving.
pub const LIBYA_UTC_OFFSET_SECONDS: i32 = 2 * 60 * 60;
/// The most periods a single `closed_periods` call may return.
pub const MAX_PERIODS: usize = 120;

/// `ReturnPeriod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReturnPeriod {
    Monthly,
    Quarterly,
    Annual,
}

impl ReturnPeriod {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "MONTHLY",
            Self::Quarterly => "QUARTERLY",
            Self::Annual => "ANNUAL",
        }
    }

    /// Periods per year (12 / 4 / 1).
    #[must_use]
    pub const fn per_year(self) -> i64 {
        match self {
            Self::Monthly => 12,
            Self::Quarterly => 4,
            Self::Annual => 1,
        }
    }
}

/// `ReportPeriod` — the stable key and its UTC bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportPeriod {
    /// `2026-10`, `2026-Q3`, `2026`, or `2026-11-04` for a business-day batch.
    pub key: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// The `Africa/Tripoli` offset.
#[must_use]
pub fn libya_offset() -> FixedOffset {
    FixedOffset::east_opt(LIBYA_UTC_OFFSET_SECONDS).unwrap_or_else(|| Utc.fix())
}

fn parse_date(date: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

/// `YYYY-MM-DD` plus `days` calendar days (negative allowed).
#[must_use]
pub fn add_local_days(date: &str, days: i64) -> Option<String> {
    let parsed = parse_date(date)?;
    let shifted = parsed.checked_add_signed(Duration::days(days))?;
    Some(shifted.format("%Y-%m-%d").to_string())
}

/// The UTC instant at which local day `date` starts.
#[must_use]
pub fn start_of_local_day(date: &str) -> Option<DateTime<Utc>> {
    let naive = parse_date(date)?.and_hms_opt(0, 0, 0)?;
    libya_offset()
        .from_local_datetime(&naive)
        .single()
        .map(|local| local.with_timezone(&Utc))
}

/// Today's local date.
#[must_use]
pub fn local_date(instant: DateTime<Utc>) -> String {
    instant
        .with_timezone(&libya_offset())
        .format("%Y-%m-%d")
        .to_string()
}

/// The local `(year, month)` of an instant.
#[must_use]
pub fn local_year_month(instant: DateTime<Utc>) -> (i32, u32) {
    let local = instant.with_timezone(&libya_offset());
    (local.year(), local.month())
}

fn period_bounds(period: ReturnPeriod, year: i32, index: i64) -> Option<(String, String, String)> {
    let first_month = match period {
        ReturnPeriod::Monthly => index + 1,
        ReturnPeriod::Quarterly => index * 3 + 1,
        ReturnPeriod::Annual => 1,
    };
    let span = match period {
        ReturnPeriod::Monthly => 1,
        ReturnPeriod::Quarterly => 3,
        ReturnPeriod::Annual => 12,
    };
    if !(1..=12).contains(&first_month) {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(year, u32::try_from(first_month).ok()?, 1)?;
    let end_month = first_month + span;
    let end = if end_month > 12 {
        NaiveDate::from_ymd_opt(year + 1, u32::try_from(end_month - 12).ok()?, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, u32::try_from(end_month).ok()?, 1)?
    };
    let key = match period {
        ReturnPeriod::Monthly => format!("{year}-{:02}", first.month()),
        ReturnPeriod::Quarterly => format!("{year}-Q{}", index + 1),
        ReturnPeriod::Annual => year.to_string(),
    };
    Some((
        first.format("%Y-%m-%d").to_string(),
        end.format("%Y-%m-%d").to_string(),
        key,
    ))
}

/// The `count` most recent CLOSED periods (end at or before `now`), newest first.
#[must_use]
pub fn closed_periods(period: ReturnPeriod, now: DateTime<Utc>, count: usize) -> Vec<ReportPeriod> {
    let (year, month) = local_year_month(now);
    let per_year = period.per_year();
    let current = match period {
        ReturnPeriod::Monthly => i64::from(month) - 1,
        ReturnPeriod::Quarterly => i64::from(month - 1) / 3,
        ReturnPeriod::Annual => 0,
    };
    let mut result = Vec::new();
    let count = count.min(MAX_PERIODS);
    for back in 1..=count as i64 {
        let absolute = i64::from(year) * per_year + current - back;
        let period_year = absolute.div_euclid(per_year);
        let index = absolute.rem_euclid(per_year);
        let Ok(period_year) = i32::try_from(period_year) else {
            continue;
        };
        let Some((start_date, end_date, key)) = period_bounds(period, period_year, index) else {
            continue;
        };
        let (Some(start), Some(end)) = (
            start_of_local_day(&start_date),
            start_of_local_day(&end_date),
        ) else {
            continue;
        };
        if end > now {
            continue;
        }
        result.push(ReportPeriod { key, start, end });
    }
    result
}

/// The filing due instant: `dueDays` local days after the period end (at local midnight).
#[must_use]
pub fn due_after_period(end: DateTime<Utc>, due_days: i64) -> Option<DateTime<Utc>> {
    let end_date = local_date(end);
    let shifted = add_local_days(&end_date, due_days.max(0))?;
    start_of_local_day(&shifted)
}

/// `BusinessCalendar`: Sunday..Thursday are business days; holidays remove more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessCalendar {
    /// `YYYY-MM-DD` dates that are not business days.
    pub holidays: BTreeSet<String>,
    /// Index 0 = Sunday ... 6 = Saturday.
    pub business_weekdays: [bool; 7],
}

impl Default for BusinessCalendar {
    fn default() -> Self {
        // Libyan weekend: Friday and Saturday.
        Self {
            holidays: BTreeSet::new(),
            business_weekdays: [true, true, true, true, true, false, false],
        }
    }
}

impl BusinessCalendar {
    /// A calendar with no holidays.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `parseHolidays`: keeps only well-formed `YYYY-MM-DD` values.
    #[must_use]
    pub fn with_holidays<S: AsRef<str>>(mut self, holidays: impl IntoIterator<Item = S>) -> Self {
        for holiday in holidays {
            let value = holiday.as_ref();
            if parse_date(value).is_some() {
                self.holidays.insert(value.to_owned());
            }
        }
        self
    }

    /// `isBusinessDay`: the configured weekday and not a holiday.
    #[must_use]
    pub fn is_business_day(&self, date: &str) -> bool {
        let Some(parsed) = parse_date(date) else {
            return false;
        };
        let weekday = parsed.weekday().num_days_from_sunday() as usize;
        self.business_weekdays
            .get(weekday)
            .copied()
            .unwrap_or(false)
            && !self.holidays.contains(date)
    }
}

/// `isBusinessDay` with the default calendar.
#[must_use]
pub fn is_business_day(date: &str, calendar: &BusinessCalendar) -> bool {
    calendar.is_business_day(date)
}

/// Business-day batches (the large-transaction report), newest first.
///
/// The batch of business day B covers B's local midnight up to the midnight of the NEXT business
/// day (so a Thursday batch also holds the Friday and Saturday weekend) and is complete once that
/// instant has passed.
#[must_use]
pub fn business_day_batches(
    now: DateTime<Utc>,
    count: usize,
    calendar: &BusinessCalendar,
) -> Vec<ReportPeriod> {
    let mut result = Vec::new();
    let mut cursor = local_date(now);
    let count = count.min(MAX_PERIODS);
    for _scanned in 0..90 {
        if result.len() >= count {
            break;
        }
        let Some(previous) = add_local_days(&cursor, -1) else {
            break;
        };
        cursor = previous;
        if !calendar.is_business_day(&cursor) {
            continue;
        }
        let Some(mut next) = add_local_days(&cursor, 1) else {
            break;
        };
        for _guard in 0..30 {
            if calendar.is_business_day(&next) {
                break;
            }
            let Some(advanced) = add_local_days(&next, 1) else {
                break;
            };
            next = advanced;
        }
        let (Some(start), Some(end)) = (start_of_local_day(&cursor), start_of_local_day(&next))
        else {
            continue;
        };
        if end > now {
            continue;
        }
        result.push(ReportPeriod {
            key: cursor.clone(),
            start,
            end,
        });
    }
    result
}

/// Due date of a business-day batch: the end of the first business day after the batch closes.
#[must_use]
pub fn due_after_batch(end: DateTime<Utc>, calendar: &BusinessCalendar) -> Option<DateTime<Utc>> {
    let mut date = local_date(end);
    for _guard in 0..30 {
        if calendar.is_business_day(&date) {
            break;
        }
        date = add_local_days(&date, 1)?;
    }
    let due_date = add_local_days(&date, 1)?;
    start_of_local_day(&due_date)
}

/// Subtracts `days` BUSINESS days from `instant`, landing on local midnight.
#[must_use]
pub fn minus_business_days(
    instant: DateTime<Utc>,
    days: u32,
    calendar: &BusinessCalendar,
) -> Option<DateTime<Utc>> {
    let mut date = local_date(instant);
    let mut remaining = days;
    for _guard in 0..400 {
        if remaining == 0 {
            break;
        }
        date = add_local_days(&date, -1)?;
        if calendar.is_business_day(&date) {
            remaining -= 1;
        }
    }
    start_of_local_day(&date)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("instant fixture")
            .with_timezone(&Utc)
    }

    #[test]
    fn local_midnight_is_utc_plus_two() {
        assert_eq!(
            start_of_local_day("2026-11-01").map(|instant| instant.to_rfc3339()),
            Some("2026-10-31T22:00:00+00:00".to_owned())
        );
        assert_eq!(
            local_date(utc("2026-10-31T22:00:00Z")),
            "2026-11-01".to_owned()
        );
        assert_eq!(
            local_date(utc("2026-10-31T21:59:59Z")),
            "2026-10-31".to_owned()
        );
        assert_eq!(
            add_local_days("2026-01-31", 1).as_deref(),
            Some("2026-02-01")
        );
        assert_eq!(
            add_local_days("2026-03-01", -1).as_deref(),
            Some("2026-02-28")
        );
        assert_eq!(start_of_local_day("not-a-date"), None);
    }

    #[test]
    fn monthly_quarterly_and_annual_keys() {
        let now = utc("2026-11-15T10:00:00Z");
        let monthly = closed_periods(ReturnPeriod::Monthly, now, 2);
        assert_eq!(
            monthly
                .iter()
                .map(|period| period.key.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-10", "2026-09"]
        );
        assert_eq!(monthly[0].start.to_rfc3339(), "2026-09-30T22:00:00+00:00");
        assert_eq!(monthly[0].end.to_rfc3339(), "2026-10-31T22:00:00+00:00");

        let quarterly = closed_periods(ReturnPeriod::Quarterly, now, 2);
        assert_eq!(
            quarterly
                .iter()
                .map(|period| period.key.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-Q3", "2026-Q2"]
        );
        assert_eq!(quarterly[0].start.to_rfc3339(), "2026-06-30T22:00:00+00:00");
        assert_eq!(quarterly[0].end.to_rfc3339(), "2026-09-30T22:00:00+00:00");

        let annual = closed_periods(ReturnPeriod::Annual, utc("2026-01-15T00:00:00Z"), 1);
        assert_eq!(annual[0].key, "2025");
        assert_eq!(
            format_period(&annual[0]),
            "2025:2024-12-31T22:00:00+00:00..2025-12-31T22:00:00+00:00"
        );
    }

    fn format_period(period: &ReportPeriod) -> String {
        format!(
            "{}:{}..{}",
            period.key,
            period.start.to_rfc3339(),
            period.end.to_rfc3339()
        )
    }

    #[test]
    fn a_period_is_only_closed_after_its_end() {
        let last_moment = utc("2026-10-31T21:59:59Z");
        assert!(closed_periods(ReturnPeriod::Monthly, last_moment, 1)[0].key == "2026-09");
        let at_boundary = utc("2026-10-31T22:00:00Z");
        assert_eq!(
            closed_periods(ReturnPeriod::Monthly, at_boundary, 1)[0].key,
            "2026-10"
        );
    }

    #[test]
    fn due_dates_count_local_days_from_the_period_end() {
        let end = start_of_local_day("2026-11-01").expect("end");
        assert_eq!(
            due_after_period(end, 20).map(|instant| instant.to_rfc3339()),
            Some("2026-11-20T22:00:00+00:00".to_owned())
        );
        // Never before the period end.
        assert_eq!(
            due_after_period(end, -5).map(|instant| instant.to_rfc3339()),
            Some("2026-10-31T22:00:00+00:00".to_owned())
        );
    }

    #[test]
    fn the_libyan_business_week_is_sunday_to_thursday() {
        let calendar = BusinessCalendar::new();
        assert!(calendar.is_business_day("2026-11-15")); // Sunday
        assert!(calendar.is_business_day("2026-11-19")); // Thursday
        assert!(!calendar.is_business_day("2026-11-20")); // Friday
        assert!(!calendar.is_business_day("2026-11-21")); // Saturday
        assert!(!calendar.is_business_day("not-a-date"));

        let with_holiday =
            BusinessCalendar::new().with_holidays(["2026-11-16", "malformed", "2026-13-01"]);
        assert!(!with_holiday.is_business_day("2026-11-16"));
        assert_eq!(with_holiday.holidays.len(), 1);
        assert!(with_holiday.is_business_day("2026-11-17"));
    }

    #[test]
    fn business_day_batches_end_on_the_next_business_day() {
        let now = utc("2026-11-15T10:00:00Z"); // Sunday noon local
        let batches = business_day_batches(now, 2, &BusinessCalendar::new());
        assert_eq!(
            batches
                .iter()
                .map(|period| period.key.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-11-12", "2026-11-11"]
        );
        // Thursday's batch runs to Sunday midnight (the Friday/Saturday weekend is included).
        assert_eq!(batches[0].start.to_rfc3339(), "2026-11-11T22:00:00+00:00");
        assert_eq!(batches[0].end.to_rfc3339(), "2026-11-14T22:00:00+00:00");

        let with_holiday = BusinessCalendar::new().with_holidays(["2026-11-12"]);
        let batches = business_day_batches(now, 1, &with_holiday);
        assert_eq!(batches[0].key, "2026-11-11");
    }

    #[test]
    fn batch_due_dates_and_reminder_leads_skip_the_weekend() {
        let calendar = BusinessCalendar::new();
        let batch = business_day_batches(utc("2026-11-15T10:00:00Z"), 1, &calendar);
        assert_eq!(
            due_after_batch(batch[0].end, &calendar).map(|instant| instant.to_rfc3339()),
            Some("2026-11-15T22:00:00+00:00".to_owned())
        );
        let due = utc("2026-11-19T22:00:00Z"); // Friday local midnight
        assert_eq!(
            minus_business_days(due, 3, &calendar).map(|instant| instant.to_rfc3339()),
            Some("2026-11-16T22:00:00+00:00".to_owned())
        );
        assert_eq!(
            minus_business_days(due, 0, &calendar).map(|instant| instant.to_rfc3339()),
            Some("2026-11-19T22:00:00+00:00".to_owned())
        );
    }

    #[test]
    fn period_keys_serialise_on_the_wire() {
        assert_eq!(ReturnPeriod::Monthly.as_str(), "MONTHLY");
        assert_eq!(ReturnPeriod::Monthly.per_year(), 12);
        let period = ReportPeriod {
            key: "2026-11".to_owned(),
            start: start_of_local_day("2026-11-01").expect("start"),
            end: start_of_local_day("2026-12-01").expect("end"),
        };
        let mut periods = closed_periods(ReturnPeriod::Monthly, utc("2026-12-15T00:00:00Z"), 1);
        periods.push(period);
        assert_eq!(periods.len(), 2);
        assert_eq!(DEFAULT_BUSINESS_TIME_ZONE, "Africa/Tripoli");
    }

    #[test]
    fn closed_periods_are_bounded() {
        let now = utc("2026-11-15T10:00:00Z");
        assert!(closed_periods(ReturnPeriod::Monthly, now, 0).is_empty());
        assert_eq!(
            closed_periods(ReturnPeriod::Monthly, now, 500).len(),
            MAX_PERIODS
        );
    }
}
