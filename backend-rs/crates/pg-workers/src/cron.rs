//! Five-field cron in the Tripoli business clock (`core-back/lib/cron.ts`).
//!
//! Ports the small cron used by the statement-schedule worker (AUTO-07). The TypeScript version
//! evaluates the fields with `Intl.DateTimeFormat` in `Africa/Tripoli`; Libya has observed a fixed
//! UTC+2 offset with no daylight saving since 2013, so this port resolves the same wall-clock times
//! with a fixed offset (`TRIPOLI_UTC_OFFSET_MINUTES`). That is exact for the production time zone and
//! keeps the crate free of a time-zone database dependency. `UTC` is supported as well. Any other
//! IANA name is refused with [`CronError::UnsupportedTimeZone`] instead of silently using the wrong
//! offset; `chrono-tz` is not a dependency of `pg-workers` yet.
//!
//! Syntax per field: `*`, `a`, `a-b`, `a,b,c`, a step after a star or a range (`*/n`, `a-b/n`) and
//! `a/n` (from `a` to the field maximum). Day-of-week `0` and `7` are Sunday. When both day-of-month
//! and day-of-week are restricted a day matches if EITHER does (standard cron).

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, NaiveDate, NaiveDateTime, Timelike, Utc,
};
use thiserror::Error;

/// `DEFAULT_BUSINESS_TIME_ZONE` (`engine/workers/deadlines/businessTime.ts:6`).
pub const DEFAULT_TIME_ZONE: &str = "Africa/Tripoli";

/// `Africa/Tripoli` is UTC+2 all year (no daylight saving since 2013).
pub const TRIPOLI_UTC_OFFSET_MINUTES: i32 = 120;

/// The default look-back bound of [`last_scheduled_at_or_before`] (`maxDays`).
pub const DEFAULT_MAX_LOOKBACK_DAYS: u32 = 400;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CronError {
    #[error("a cron expression has five fields, got {0}")]
    FieldCount(usize),
    #[error("invalid cron {field} field \"{value}\"")]
    InvalidField { field: &'static str, value: String },
    #[error("invalid cron {field} step in \"{value}\"")]
    InvalidStep { field: &'static str, value: String },
    #[error("cron {field} value out of range in \"{value}\"")]
    OutOfRange { field: &'static str, value: String },
    #[error("unsupported time zone \"{0}\" (supported: Africa/Tripoli, UTC)")]
    UnsupportedTimeZone(String),
}

impl From<CronError> for crate::runtime::WorkerError {
    fn from(error: CronError) -> Self {
        crate::runtime::WorkerError::Failed(format!("cron: {error}"))
    }
}

/// The parsed sets of a five-field expression (`ParsedCron` in `cron.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCron {
    pub minutes: BTreeSet<u32>,
    pub hours: BTreeSet<u32>,
    pub days_of_month: BTreeSet<u32>,
    pub months: BTreeSet<u32>,
    /// 0 = Sunday … 6 = Saturday (7 is folded into 0).
    pub days_of_week: BTreeSet<u32>,
    pub dom_restricted: bool,
    pub dow_restricted: bool,
}

/// The local wall clock of an instant (`LocalClock` in `businessTime.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalClock {
    pub date: NaiveDate,
    /// 0 = Sunday … 6 = Saturday.
    pub weekday: u32,
    /// Minutes since local midnight, 0..1439.
    pub minutes: u32,
    pub seconds: u32,
}

const FIELD_BOUNDS: [(u32, u32, &str); 5] = [
    (0, 59, "minute"),
    (0, 23, "hour"),
    (1, 31, "day-of-month"),
    (1, 12, "month"),
    (0, 7, "day-of-week"),
];

fn parse_field(
    field: &str,
    (min, max, name): (u32, u32, &'static str),
) -> Result<BTreeSet<u32>, CronError> {
    let mut values = BTreeSet::new();
    for part in field.split(',') {
        let (range_text, step_text) = match part.split_once('/') {
            Some((range, step)) => (range, Some(step)),
            None => (part, None),
        };
        let step = match step_text {
            None => 1,
            Some(step) => {
                let parsed = step.parse::<u32>().map_err(|_| CronError::InvalidStep {
                    field: name,
                    value: field.to_owned(),
                })?;
                if parsed < 1 {
                    return Err(CronError::InvalidStep {
                        field: name,
                        value: field.to_owned(),
                    });
                }
                parsed
            }
        };
        let (from, to) = if range_text == "*" {
            (min, max)
        } else if let Some((from, to)) = range_text.split_once('-') {
            let from = from.parse::<u32>().map_err(|_| CronError::InvalidField {
                field: name,
                value: field.to_owned(),
            })?;
            let to = to.parse::<u32>().map_err(|_| CronError::InvalidField {
                field: name,
                value: field.to_owned(),
            })?;
            (from, to)
        } else {
            let from = range_text
                .parse::<u32>()
                .map_err(|_| CronError::InvalidField {
                    field: name,
                    value: field.to_owned(),
                })?;
            // `a/n` runs from `a` to the field maximum, exactly like `parseField` in `cron.ts`.
            let to = if step_text.is_some() { max } else { from };
            (from, to)
        };
        if from < min || to > max || from > to {
            return Err(CronError::OutOfRange {
                field: name,
                value: field.to_owned(),
            });
        }
        let mut value = from;
        while value <= to {
            values.insert(value);
            match value.checked_add(step) {
                Some(next) => value = next,
                None => break,
            }
        }
    }
    Ok(values)
}

/// Parses a five-field expression (`parseCron`).
pub fn parse_cron(expression: &str) -> Result<ParsedCron, CronError> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(CronError::FieldCount(fields.len()));
    }
    let minutes = parse_field(fields[0], FIELD_BOUNDS[0])?;
    let hours = parse_field(fields[1], FIELD_BOUNDS[1])?;
    let days_of_month = parse_field(fields[2], FIELD_BOUNDS[2])?;
    let months = parse_field(fields[3], FIELD_BOUNDS[3])?;
    let mut days_of_week = parse_field(fields[4], FIELD_BOUNDS[4])?;
    if days_of_week.remove(&7) {
        days_of_week.insert(0);
    }
    Ok(ParsedCron {
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        dom_restricted: fields[2] != "*",
        dow_restricted: fields[4] != "*",
    })
}

/// The fixed offset of a supported time zone, in minutes east of UTC.
pub fn time_zone_offset_minutes(time_zone: &str) -> Result<i32, CronError> {
    match time_zone {
        "Africa/Tripoli" => Ok(TRIPOLI_UTC_OFFSET_MINUTES),
        "UTC" | "Etc/UTC" | "Z" => Ok(0),
        other => Err(CronError::UnsupportedTimeZone(other.to_owned())),
    }
}

/// `localClock`: the wall clock of `instant` in the time zone.
pub fn local_clock(instant: DateTime<Utc>, time_zone: &str) -> Result<LocalClock, CronError> {
    let offset = time_zone_offset_minutes(time_zone)?;
    let local = instant.naive_utc() + ChronoDuration::minutes(i64::from(offset));
    Ok(LocalClock {
        date: local.date(),
        weekday: local.weekday().num_days_from_sunday(),
        minutes: local.hour() * 60 + local.minute(),
        seconds: local.second(),
    })
}

fn day_matches(cron: &ParsedCron, date: NaiveDate) -> bool {
    if !cron.months.contains(&date.month()) {
        return false;
    }
    let weekday = date.weekday().num_days_from_sunday();
    let dom = cron.days_of_month.contains(&date.day());
    let dow = cron.days_of_week.contains(&weekday);
    if cron.dom_restricted && cron.dow_restricted {
        dom || dow
    } else {
        dom && dow
    }
}

fn minutes_of_day(cron: &ParsedCron) -> Vec<u32> {
    let mut out = Vec::with_capacity(cron.hours.len() * cron.minutes.len());
    for hour in &cron.hours {
        for minute in &cron.minutes {
            out.push(hour * 60 + minute);
        }
    }
    out
}

fn start_of_local_day(date: NaiveDate, offset_minutes: i32) -> DateTime<Utc> {
    let midnight = NaiveDateTime::new(date, chrono::NaiveTime::MIN);
    DateTime::<Utc>::from_naive_utc_and_offset(midnight, Utc)
        - ChronoDuration::minutes(i64::from(offset_minutes))
}

/// The latest scheduled instant at or before `instant` (`lastScheduledAtOrBefore`).
/// Scheduled times are local clock times: `0 6 * * *` is 06:00 in the zone. `max_days` bounds the
/// look-back (400 in the TypeScript default).
pub fn last_scheduled_at_or_before(
    cron: &ParsedCron,
    instant: DateTime<Utc>,
    time_zone: &str,
    max_days: Option<u32>,
) -> Result<Option<DateTime<Utc>>, CronError> {
    let offset = time_zone_offset_minutes(time_zone)?;
    let local = local_clock(instant, time_zone)?;
    let times = minutes_of_day(cron);
    if times.is_empty() {
        return Ok(None);
    }
    let mut date = local.date;
    for back in 0..=max_days.unwrap_or(DEFAULT_MAX_LOOKBACK_DAYS) {
        if day_matches(cron, date) {
            let limit = if back == 0 { local.minutes } else { 1_439 };
            for minute in times.iter().rev() {
                if *minute <= limit {
                    return Ok(Some(
                        start_of_local_day(date, offset)
                            + ChronoDuration::minutes(i64::from(*minute)),
                    ));
                }
            }
        }
        match date.pred_opt() {
            Some(previous) => date = previous,
            None => break,
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(value: &str) -> DateTime<Utc> {
        chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
            .expect("timestamp")
            .and_utc()
    }

    #[test]
    fn parses_ranges_lists_and_steps() {
        let cron = parse_cron("*/15 8-10 1,15 * 1-5").expect("cron");
        assert_eq!(
            cron.minutes.iter().copied().collect::<Vec<_>>(),
            vec![0, 15, 30, 45]
        );
        assert_eq!(
            cron.hours.iter().copied().collect::<Vec<_>>(),
            vec![8, 9, 10]
        );
        assert_eq!(
            cron.days_of_month.iter().copied().collect::<Vec<_>>(),
            vec![1, 15]
        );
        assert_eq!(cron.months.len(), 12);
        assert_eq!(
            cron.days_of_week.iter().copied().collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
        assert!(cron.dom_restricted);
        assert!(cron.dow_restricted);
    }

    #[test]
    fn a_step_without_a_range_runs_to_the_maximum() {
        let cron = parse_cron("5/20 * * * *").expect("cron");
        assert_eq!(
            cron.minutes.iter().copied().collect::<Vec<_>>(),
            vec![5, 25, 45]
        );
    }

    #[test]
    fn sunday_is_both_zero_and_seven() {
        let zero = parse_cron("0 6 * * 0").expect("cron");
        let seven = parse_cron("0 6 * * 7").expect("cron");
        assert_eq!(zero.days_of_week, seven.days_of_week);
        assert_eq!(
            zero.days_of_week.iter().copied().collect::<Vec<_>>(),
            vec![0]
        );
    }

    #[test]
    fn rejects_invalid_expressions() {
        assert!(matches!(
            parse_cron("0 6 * *"),
            Err(CronError::FieldCount(4))
        ));
        assert!(matches!(
            parse_cron("60 6 * * *"),
            Err(CronError::OutOfRange { .. })
        ));
        assert!(matches!(
            parse_cron("0 24 * * *"),
            Err(CronError::OutOfRange { .. })
        ));
        assert!(matches!(
            parse_cron("0 6 0 * *"),
            Err(CronError::OutOfRange { .. })
        ));
        assert!(matches!(
            parse_cron("0 6 * 13 *"),
            Err(CronError::OutOfRange { .. })
        ));
        assert!(matches!(
            parse_cron("0 6 * * 8"),
            Err(CronError::OutOfRange { .. })
        ));
        assert!(matches!(
            parse_cron("0 6 * * mon"),
            Err(CronError::InvalidField { .. })
        ));
        assert!(matches!(
            parse_cron("*/0 * * * *"),
            Err(CronError::InvalidStep { .. })
        ));
        assert!(matches!(
            parse_cron("5-1 * * * *"),
            Err(CronError::OutOfRange { .. })
        ));
    }

    #[test]
    fn tripoli_is_a_fixed_utc_plus_two_clock() {
        // Winter and summer resolve to the same offset: no daylight saving.
        let winter = local_clock(utc("2026-01-15T06:00:00"), DEFAULT_TIME_ZONE).expect("clock");
        let summer = local_clock(utc("2026-07-15T06:00:00"), DEFAULT_TIME_ZONE).expect("clock");
        assert_eq!((winter.minutes, summer.minutes), (480, 480));
        assert_eq!(winter.weekday, 4); // Thursday
        assert_eq!(summer.weekday, 3); // Wednesday
    }

    #[test]
    fn scheduled_times_are_local_wall_clock_times() {
        let cron = parse_cron("0 6 * * *").expect("cron");
        // 06:00 Tripoli is 04:00 UTC.
        let slot =
            last_scheduled_at_or_before(&cron, utc("2026-11-28T12:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        assert_eq!(slot, utc("2026-11-28T04:00:00"));
    }

    #[test]
    fn a_slot_before_the_local_time_rolls_back_one_day() {
        let cron = parse_cron("0 6 * * *").expect("cron");
        // 05:00 UTC = 07:00 Tripoli, so 06:00 local today is already past; 12:00 UTC = 14:00
        // Tripoli keeps today. Just before 04:00 UTC it must be yesterday.
        let early =
            last_scheduled_at_or_before(&cron, utc("2026-11-28T03:59:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        assert_eq!(early, utc("2026-11-27T04:00:00"));
    }

    #[test]
    fn weekend_days_are_skipped_by_a_weekday_expression() {
        let cron = parse_cron("30 9 * * 1-5").expect("cron");
        // 2026-11-28 is a Saturday, 2026-11-29 a Sunday, 2026-11-30 a Monday.
        let saturday =
            last_scheduled_at_or_before(&cron, utc("2026-11-28T12:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        assert_eq!(saturday, utc("2026-11-27T07:30:00"));
        let sunday =
            last_scheduled_at_or_before(&cron, utc("2026-11-29T12:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        assert_eq!(sunday, utc("2026-11-27T07:30:00"));
        let monday =
            last_scheduled_at_or_before(&cron, utc("2026-11-30T12:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        assert_eq!(monday, utc("2026-11-30T07:30:00"));
    }

    #[test]
    fn a_sunday_only_expression_fires_on_sunday() {
        let cron = parse_cron("0 0 * * 0").expect("cron");
        let slot =
            last_scheduled_at_or_before(&cron, utc("2026-11-30T00:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        // Local midnight Sunday 2026-11-29 is 2026-11-28T22:00Z.
        assert_eq!(slot, utc("2026-11-28T22:00:00"));
    }

    #[test]
    fn a_restricted_dom_and_dow_match_either_field() {
        // Day 15 OR Monday.
        let cron = parse_cron("0 6 15 * 1").expect("cron");
        assert!(cron.dom_restricted && cron.dow_restricted);
        let slot =
            last_scheduled_at_or_before(&cron, utc("2026-12-16T12:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        // 2026-12-15 is a Tuesday (matches the day-of-month), later than Monday the 14th.
        assert_eq!(slot, utc("2026-12-15T04:00:00"));
    }

    #[test]
    fn multiple_times_a_day_are_ordered() {
        let cron = parse_cron("0 8,12,18 * * *").expect("cron");
        let slot =
            last_scheduled_at_or_before(&cron, utc("2026-11-28T13:00:00"), DEFAULT_TIME_ZONE, None)
                .expect("schedule")
                .expect("slot");
        // 13:00 UTC = 15:00 Tripoli, so 12:00 local (10:00 UTC) is the latest.
        assert_eq!(slot, utc("2026-11-28T10:00:00"));
    }

    #[test]
    fn no_matching_day_returns_none() {
        let cron = parse_cron("0 6 30 2 *").expect("cron");
        assert!(last_scheduled_at_or_before(
            &cron,
            utc("2026-11-28T12:00:00"),
            DEFAULT_TIME_ZONE,
            Some(10)
        )
        .expect("schedule")
        .is_none());
    }

    #[test]
    fn an_unsupported_zone_is_refused() {
        let cron = parse_cron("0 6 * * *").expect("cron");
        assert!(matches!(
            last_scheduled_at_or_before(&cron, utc("2026-11-28T12:00:00"), "Europe/Paris", None),
            Err(CronError::UnsupportedTimeZone(_))
        ));
        assert_eq!(time_zone_offset_minutes("UTC").expect("utc offset"), 0);
        // Sanity: the fixed offset is exactly two hours.
        assert_eq!(
            local_clock(utc("2026-11-28T00:00:00"), DEFAULT_TIME_ZONE)
                .expect("clock")
                .date,
            NaiveDate::from_ymd_opt(2026, 11, 28).expect("date")
        );
        assert_eq!(Utc.timestamp_opt(0, 0).unwrap().timestamp(), 0);
    }
}
