//! A deliberately small five-field cron implementation. Port of
//! `deploy/backup-daemon/src/cron.ts`.
//!
//! Supported field syntax: `*`, `a`, `a-b`, lists, `*/n`, `a-b/n`, `a/n`. There are no macros and
//! no seconds field. Times are evaluated in UTC so the schedule is deterministic regardless of the
//! host timezone.

use chrono::{DateTime, Datelike, Duration, Timelike, Utc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCron {
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub days_of_month: Vec<u32>,
    pub months: Vec<u32>,
    pub days_of_week: Vec<u32>,
    pub days_of_month_wildcard: bool,
    pub days_of_week_wildcard: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct FieldBounds {
    pub min: u32,
    pub max: u32,
    pub name: &'static str,
}

const FIELD_BOUNDS: [FieldBounds; 5] = [
    FieldBounds {
        min: 0,
        max: 59,
        name: "minute",
    },
    FieldBounds {
        min: 0,
        max: 23,
        name: "hour",
    },
    FieldBounds {
        min: 1,
        max: 31,
        name: "day-of-month",
    },
    FieldBounds {
        min: 1,
        max: 12,
        name: "month",
    },
    FieldBounds {
        min: 0,
        max: 7,
        name: "day-of-week",
    },
];

fn fail(message: impl std::fmt::Display) -> String {
    format!("invalid cron expression: {message}")
}

fn parse_value(value: &str, bounds: FieldBounds, field: &str) -> Result<u32, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(fail(format!(
            "{} field \"{field}\" contains a non-numeric value",
            bounds.name
        )));
    }
    let parsed: u32 = value
        .parse()
        .map_err(|_| fail(format!("{} value {value} is not a number", bounds.name)))?;
    if parsed < bounds.min || parsed > bounds.max {
        return Err(fail(format!(
            "{} value {value} is outside {}-{}",
            bounds.name, bounds.min, bounds.max
        )));
    }
    Ok(parsed)
}

pub fn parse_cron_field(field: &str, bounds: FieldBounds) -> Result<Vec<u32>, String> {
    let trimmed = field.trim();
    if trimmed.is_empty() {
        return Err(fail("empty field"));
    }
    let mut values: Vec<u32> = Vec::new();

    for part in trimmed.split(',') {
        if part.is_empty() {
            return Err(fail(format!("empty list entry in \"{field}\"")));
        }
        let pieces: Vec<&str> = part.split('/').collect();
        if pieces.len() > 2 {
            return Err(fail(format!("too many step separators in \"{part}\"")));
        }
        let mut step = 1_u32;
        if let Some(step_part) = pieces.get(1) {
            if step_part.is_empty() || !step_part.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(fail(format!(
                    "step \"{step_part}\" is not a positive integer"
                )));
            }
            step = step_part
                .parse()
                .map_err(|_| fail(format!("step \"{step_part}\" is not a positive integer")))?;
            if step < 1 {
                return Err(fail(format!(
                    "step \"{step_part}\" is not a positive integer"
                )));
            }
        }

        let range_part = pieces[0];
        let (start, end) = if range_part == "*" {
            (bounds.min, bounds.max)
        } else if range_part.contains('-') {
            let range_pieces: Vec<&str> = range_part.split('-').collect();
            if range_pieces.len() != 2 {
                return Err(fail(format!("malformed range \"{range_part}\"")));
            }
            let start = parse_value(range_pieces[0], bounds, field)?;
            let end = parse_value(range_pieces[1], bounds, field)?;
            if start > end {
                return Err(fail(format!("range \"{range_part}\" is descending")));
            }
            (start, end)
        } else {
            let start = parse_value(range_part, bounds, field)?;
            let end = if pieces.len() > 1 { bounds.max } else { start };
            (start, end)
        };

        let mut value = start;
        while value <= end {
            if !values.contains(&value) {
                values.push(value);
            }
            value += step;
        }
    }

    values.sort_unstable();
    Ok(values)
}

pub fn parse_cron_expression(expression: &str) -> Result<ParsedCron, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(fail(
            "expected five fields (minute hour day-of-month month day-of-week)",
        ));
    }
    let minutes = parse_cron_field(fields[0], FIELD_BOUNDS[0])?;
    let hours = parse_cron_field(fields[1], FIELD_BOUNDS[1])?;
    let days_of_month = parse_cron_field(fields[2], FIELD_BOUNDS[2])?;
    let months = parse_cron_field(fields[3], FIELD_BOUNDS[3])?;
    let raw_days_of_week = parse_cron_field(fields[4], FIELD_BOUNDS[4])?;
    // Both 0 and 7 mean Sunday.
    let mut days_of_week: Vec<u32> = raw_days_of_week
        .iter()
        .map(|value| if *value == 7 { 0 } else { *value })
        .collect();
    days_of_week.sort_unstable();
    days_of_week.dedup();

    Ok(ParsedCron {
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        days_of_month_wildcard: fields[2].starts_with('*'),
        days_of_week_wildcard: fields[4].starts_with('*'),
    })
}

pub fn parse_cron(expression: &str) -> Result<ParsedCron, String> {
    parse_cron_expression(expression)
}

fn utc_day_matches(date: DateTime<Utc>, cron: &ParsedCron) -> bool {
    let day_of_month = cron.days_of_month.contains(&date.day());
    let day_of_week = cron
        .days_of_week
        .contains(&date.weekday().num_days_from_sunday());
    if cron.days_of_month_wildcard && cron.days_of_week_wildcard {
        return true;
    }
    if cron.days_of_month_wildcard {
        return day_of_week;
    }
    if cron.days_of_week_wildcard {
        return day_of_month;
    }
    day_of_month || day_of_week
}

/// First matching instant strictly after `from`, in UTC.
pub fn next_cron_run(expression: &str, from: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    let cron = parse_cron_expression(expression)?;
    let base = from
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .ok_or_else(|| fail("base date is invalid"))?;
    let mut candidate = base + Duration::minutes(1);
    let limit = from
        .with_year(from.year() + 5)
        .ok_or_else(|| fail("base date is invalid"))?;

    while candidate <= limit {
        if !cron.months.contains(&candidate.month()) {
            candidate = first_of_next_month(candidate);
            continue;
        }
        if !utc_day_matches(candidate, &cron) {
            candidate = start_of_next_day(candidate);
            continue;
        }
        if !cron.hours.contains(&candidate.hour()) {
            candidate = start_of_next_hour(candidate);
            continue;
        }
        if !cron.minutes.contains(&candidate.minute()) {
            candidate = start_of_next_minute(candidate);
            continue;
        }
        return Ok(candidate);
    }

    Err(fail(format!(
        "no matching run within five years for \"{expression}\""
    )))
}

fn first_of_next_month(value: DateTime<Utc>) -> DateTime<Utc> {
    let (year, month) = if value.month() == 12 {
        (value.year() + 1, 1)
    } else {
        (value.year(), value.month() + 1)
    };
    chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc())
        .unwrap_or(value)
}

fn start_of_next_day(value: DateTime<Utc>) -> DateTime<Utc> {
    value
        .date_naive()
        .succ_opt()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc())
        .unwrap_or(value)
}

fn start_of_next_hour(value: DateTime<Utc>) -> DateTime<Utc> {
    value
        .with_minute(0)
        .and_then(|entry| entry.with_second(0))
        .and_then(|entry| entry.with_nanosecond(0))
        .map(|entry| entry + Duration::hours(1))
        .unwrap_or(value)
}

fn start_of_next_minute(value: DateTime<Utc>) -> DateTime<Utc> {
    value
        .with_second(0)
        .and_then(|entry| entry.with_nanosecond(0))
        .map(|entry| entry + Duration::minutes(1))
        .unwrap_or(value)
}

pub fn get_next_cron_run(expression: &str, from: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    next_cron_run(expression, from)
}

pub fn is_valid_cron_expression(expression: &str) -> bool {
    parse_cron_expression(expression).is_ok()
}

pub fn cron_matches(expression: &str, date: DateTime<Utc>) -> Result<bool, String> {
    let cron = parse_cron_expression(expression)?;
    Ok(cron.minutes.contains(&date.minute())
        && cron.hours.contains(&date.hour())
        && utc_day_matches(date, &cron)
        && cron.months.contains(&date.month()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_syntax_and_ranges() {
        let bounds = FieldBounds {
            min: 0,
            max: 59,
            name: "minute",
        };
        assert_eq!(
            parse_cron_field("*/15", bounds).expect("valid"),
            vec![0, 15, 30, 45]
        );
        assert_eq!(
            parse_cron_field("1,3,5", bounds).expect("valid"),
            vec![1, 3, 5]
        );
        assert_eq!(
            parse_cron_field("5-11/3", bounds).expect("valid"),
            vec![5, 8, 11]
        );
        assert!(parse_cron_field("60", bounds).is_err());
        assert!(parse_cron_field("*/0", bounds).is_err());
        assert!(parse_cron_field("10-5", bounds).is_err());
    }
}
