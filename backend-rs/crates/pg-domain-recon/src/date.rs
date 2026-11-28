//! Statement date parsing.
//!
//! Port of `core-back/engine/reconciliation/StatementIngestor.ts:170-204`
//! (`parseStatementDate`) and the `timezone` default of `parseConfig` (`Africa/Tripoli`).
//!
//! The TS builds a regular expression from the `dateFormat` tokens
//! (`YYYY|MM|DD|HH|mm|ss`, each `\d{2,4}`), reads the named groups, defaults a missing component
//! (`1970`, month `1`, day `1`, time `0`), and calls `Date.UTC`, whose semantics are reproduced
//! here: two-digit years map to `19xx`, out-of-range months/days/times roll over, and `NaiveDate`
//! is the calendar date the statement wrote.
//!
//! Intentional differences:
//!
//! - literal characters of the format are matched literally. The TS feeds them into `RegExp`, so a
//!   `.` matches any character; every real format uses `-`, `/`, `.`, `:` or a space as literals
//!   and the literal reading is the intended one.
//! - a repeated token (`YYYY-YYYY`) is rejected (`InvalidDateFormat`). The TS `new RegExp` throws a
//!   `SyntaxError` for a duplicate named group, which escapes the route as a 500.
//! - without a format, only ISO-8601 forms are accepted (`YYYY-MM-DD`, optional time and offset,
//!   and `/`-separated dates). Node's `new Date(string)` accepts more implementation-defined
//!   shapes; the statement ingestor is configured with a format in every seeded source.
//! - the returned `NaiveDate` keeps the written calendar date. A `+02:00` timestamp is not
//!   converted to its UTC instant (the TS returns an instant).

#![forbid(unsafe_code)]

use chrono::{DateTime, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use crate::amount::ReconError;

/// The default statement timezone (`StatementParserConfig.timezone`).
pub const DEFAULT_STATEMENT_TIMEZONE: &str = "Africa/Tripoli";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Segment {
    Token(Token),
    Literal(char),
}

/// The groups `parseStatementDate` reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Groups {
    year: Option<u32>,
    month: Option<u32>,
    day: Option<u32>,
    hour: Option<u32>,
    minute: Option<u32>,
    second: Option<u32>,
}

impl Groups {
    fn slot(&mut self, token: Token) -> &mut Option<u32> {
        match token {
            Token::Year => &mut self.year,
            Token::Month => &mut self.month,
            Token::Day => &mut self.day,
            Token::Hour => &mut self.hour,
            Token::Minute => &mut self.minute,
            Token::Second => &mut self.second,
        }
    }
}

/// Resolve the statement timezone; `None`/empty means [`DEFAULT_STATEMENT_TIMEZONE`].
pub fn statement_timezone(name: Option<&str>) -> Result<Tz, ReconError> {
    let name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_STATEMENT_TIMEZONE);
    name.parse::<Tz>()
        .map_err(|_| ReconError::UnknownTimezone(name.to_owned()))
}

/// Convert a statement calendar date to the UTC instant of local midnight.
pub fn midnight_in_timezone(date: NaiveDate, timezone: Tz) -> Result<DateTime<Utc>, ReconError> {
    let naive = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| ReconError::UnparsableDate(date.to_string()))?;
    match timezone.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        // Node resolves an ambiguous local time to the first (earlier) offset.
        LocalResult::Ambiguous(earlier, _) => Ok(earlier.with_timezone(&Utc)),
        LocalResult::None => Err(ReconError::UnparsableDate(format!(
            "{naive} does not exist in {timezone}"
        ))),
    }
}

/// `parseStatementDate` as a fallible `NaiveDate` (blank input is `EmptyDate`).
pub fn parse_statement_date(raw: &str, format: Option<&str>) -> Result<NaiveDate, ReconError> {
    let datetime = parse_statement_datetime(raw, format)?;
    Ok(datetime.date())
}

/// Like [`parse_statement_date`] but blank input is `Ok(None)` (the TS returns `null`).
pub fn parse_statement_date_opt(
    raw: &str,
    format: Option<&str>,
) -> Result<Option<NaiveDate>, ReconError> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    parse_statement_date(raw, format).map(Some)
}

/// Parse a statement timestamp. A format without time tokens yields midnight.
pub fn parse_statement_datetime(
    raw: &str,
    format: Option<&str>,
) -> Result<NaiveDateTime, ReconError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ReconError::EmptyDate);
    }
    match format {
        Some(format) => {
            let segments = tokenize(format)?;
            let mut groups = Groups::default();
            if !match_at(&segments, trimmed, 0, &mut groups) {
                return Err(ReconError::UnparsableDate(trimmed.to_owned()));
            }
            build_datetime(&groups)
        }
        None => parse_iso_datetime(trimmed),
    }
}

fn tokenize(format: &str) -> Result<Vec<Segment>, ReconError> {
    let mut segments = Vec::with_capacity(format.len());
    let mut seen: Vec<Token> = Vec::new();
    let mut index = 0;
    while index < format.len() {
        let rest = &format[index..];
        let token = [
            ("YYYY", Token::Year),
            ("MM", Token::Month),
            ("DD", Token::Day),
            ("HH", Token::Hour),
            ("mm", Token::Minute),
            ("ss", Token::Second),
        ]
        .iter()
        .find(|(name, _)| rest.starts_with(name))
        .map(|(name, token)| (*name, *token));
        if let Some((name, token)) = token {
            if seen.contains(&token) {
                return Err(ReconError::InvalidDateFormat(format.to_owned()));
            }
            seen.push(token);
            segments.push(Segment::Token(token));
            index += name.len();
            continue;
        }
        let character = rest
            .chars()
            .next()
            .ok_or_else(|| ReconError::InvalidDateFormat(format.to_owned()))?;
        segments.push(Segment::Literal(character));
        index += character.len_utf8();
    }
    if segments.is_empty() {
        return Err(ReconError::InvalidDateFormat(format.to_owned()));
    }
    Ok(segments)
}

fn match_at(segments: &[Segment], text: &str, index: usize, groups: &mut Groups) -> bool {
    let Some((segment, rest)) = segments.split_first() else {
        return index == text.len();
    };
    match segment {
        Segment::Literal(expected) => {
            match text.get(index..).and_then(|tail| tail.chars().next()) {
                Some(character) if character == *expected => {
                    match_at(rest, text, index + character.len_utf8(), groups)
                }
                _ => false,
            }
        }
        Segment::Token(token) => {
            // The TS group is `\d{2,4}` and the regex engine is greedy: try 4, then 3, then 2.
            for digits in (2..=4).rev() {
                let end = index + digits;
                if end > text.len() || !text.is_char_boundary(end) {
                    continue;
                }
                let slice = &text[index..end];
                if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
                    continue;
                }
                let Ok(value) = slice.parse::<u32>() else {
                    continue;
                };
                let slot = groups.slot(*token);
                let previous = *slot;
                *slot = Some(value);
                if match_at(rest, text, end, groups) {
                    return true;
                }
                *groups.slot(*token) = previous;
            }
            false
        }
    }
}

fn build_datetime(groups: &Groups) -> Result<NaiveDateTime, ReconError> {
    // `Date.UTC` maps years 0-99 to 1900-1999.
    let mut year = i64::from(groups.year.unwrap_or(1970));
    if (0..=99).contains(&year) {
        year += 1900;
    }
    let month = i64::from(groups.month.unwrap_or(1));
    let day = i64::from(groups.day.unwrap_or(1));
    let total_months = year
        .checked_mul(12)
        .and_then(|value| value.checked_add(month - 1))
        .ok_or_else(|| ReconError::UnparsableDate("year out of range".to_owned()))?;
    let normal_year = total_months.div_euclid(12);
    let normal_month = total_months.rem_euclid(12) + 1;
    let year = i32::try_from(normal_year)
        .map_err(|_| ReconError::UnparsableDate("year out of range".to_owned()))?;
    let month = u32::try_from(normal_month)
        .map_err(|_| ReconError::UnparsableDate("month out of range".to_owned()))?;
    let base = NaiveDate::from_ymd_opt(year, month, 1)
        .ok_or_else(|| ReconError::UnparsableDate("year out of range".to_owned()))?;
    let date = base
        .checked_add_signed(chrono::Duration::days(day - 1))
        .ok_or_else(|| ReconError::UnparsableDate("day out of range".to_owned()))?;
    let seconds = i64::from(groups.hour.unwrap_or(0)) * 3_600
        + i64::from(groups.minute.unwrap_or(0)) * 60
        + i64::from(groups.second.unwrap_or(0));
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| ReconError::UnparsableDate("date out of range".to_owned()))?;
    midnight
        .checked_add_signed(chrono::Duration::seconds(seconds))
        .ok_or_else(|| ReconError::UnparsableDate("time out of range".to_owned()))
}

fn parse_iso_datetime(raw: &str) -> Result<NaiveDateTime, ReconError> {
    if let Ok(value) = DateTime::parse_from_rfc3339(raw) {
        return Ok(value.naive_local());
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(value) = NaiveDateTime::parse_from_str(raw, format) {
            return Ok(value);
        }
    }
    for format in ["%Y-%m-%d", "%Y/%m/%d"] {
        if let Ok(value) = NaiveDate::parse_from_str(raw, format) {
            if let Some(value) = value.and_hms_opt(0, 0, 0) {
                return Ok(value);
            }
        }
    }
    Err(ReconError::UnparsableDate(raw.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(raw: &str, format: &str) -> NaiveDate {
        parse_statement_date(raw, Some(format)).expect("date")
    }

    fn datetime(raw: &str, format: &str) -> String {
        parse_statement_datetime(raw, Some(format))
            .expect("datetime")
            .to_string()
    }

    #[test]
    fn common_format_tokens() {
        assert_eq!(date("2026-11-01", "YYYY-MM-DD").to_string(), "2026-11-01");
        assert_eq!(date("01/11/2026", "DD/MM/YYYY").to_string(), "2026-11-01");
        assert_eq!(date("11/01/2026", "MM/DD/YYYY").to_string(), "2026-11-01");
        assert_eq!(date("01.11.2026", "DD.MM.YYYY").to_string(), "2026-11-01");
        assert_eq!(date("20261101", "YYYYMMDD").to_string(), "2026-11-01");
        // Adjacent variable-width tokens are ambiguous. The TS regex is greedy too and resolves
        // `DDMMYYYY` on "01112026" as DD=0111, MM=20, YYYY=26 (`Date.UTC(26, 19, 111)`).
        assert_eq!(date("01112026", "DDMMYYYY").to_string(), "1927-11-19");
        assert_eq!(
            datetime("2026-11-01 23:59:58", "YYYY-MM-DD HH:mm:ss"),
            "2026-11-01 23:59:58"
        );
        // `mm` is minutes, `MM` is months.
        assert_eq!(
            datetime("01/11/2026 05:30", "DD/MM/YYYY HH:mm"),
            "2026-11-01 05:30:00"
        );
    }

    #[test]
    fn js_year_and_rollover_semantics() {
        // A two-digit year group maps to 19xx (Date.UTC(26, ...)).
        assert_eq!(date("26-01-05", "YYYY-MM-DD").to_string(), "1926-01-05");
        // Out-of-range month and day roll over exactly like Date.UTC.
        assert_eq!(date("2026-13-45", "YYYY-MM-DD").to_string(), "2027-02-14");
        assert_eq!(date("2026-02-30", "YYYY-MM-DD").to_string(), "2026-03-02");
        assert_eq!(date("2026-00-10", "YYYY-MM-DD").to_string(), "2025-12-10");
        assert_eq!(date("2026-01-00", "YYYY-MM-DD").to_string(), "2025-12-31");
        // Time overflow rolls into the next day.
        assert_eq!(
            datetime("2026-11-01 24:00:00", "YYYY-MM-DD HH:mm:ss"),
            "2026-11-02 00:00:00"
        );
        // Missing components default: 1970-01-01 for a time-only format.
        assert_eq!(
            date("10", "HH"),
            NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch")
        );
    }

    #[test]
    fn invalid_values_are_rejected() {
        assert_eq!(
            parse_statement_date("2026-11-01", Some("YYYY/MM/DD")),
            Err(ReconError::UnparsableDate("2026-11-01".to_owned()))
        );
        assert!(matches!(
            parse_statement_date("2026-11-01", Some("YYYY-MM-DD-YYYY")),
            Err(ReconError::InvalidDateFormat(_))
        ));
        assert_eq!(
            parse_statement_date("  ", Some("YYYY")),
            Err(ReconError::EmptyDate)
        );
        assert_eq!(
            parse_statement_date("2026-11-01", Some("YYYY-MM-DD")).map(|value| value.to_string()),
            Ok("2026-11-01".to_owned())
        );
        assert_eq!(parse_statement_date_opt("", Some("YYYY-MM-DD")), Ok(None));
        assert_eq!(
            parse_statement_date("abc", Some("YYYY-MM-DD"))
                .expect_err("bad")
                .code(),
            "STATEMENT_PARSE_FAILED"
        );
    }

    #[test]
    fn iso_fallback_without_a_format() {
        assert_eq!(
            parse_statement_date("2026-11-01", None)
                .expect("date")
                .to_string(),
            "2026-11-01"
        );
        assert_eq!(
            parse_statement_date("2026-11-01T10:20:30Z", None)
                .expect("date")
                .to_string(),
            "2026-11-01"
        );
        // The written calendar date of an offset timestamp is kept.
        assert_eq!(
            parse_statement_date("2026-11-01T23:00:00+02:00", None)
                .expect("date")
                .to_string(),
            "2026-11-01"
        );
        assert_eq!(
            parse_statement_date("2026/11/01", None)
                .expect("date")
                .to_string(),
            "2026-11-01"
        );
        assert!(parse_statement_date("01 Nov 2026", None).is_err());
    }

    #[test]
    fn tripoli_midnight_is_utc_plus_two() {
        let timezone = statement_timezone(None).expect("default tz");
        assert_eq!(
            statement_timezone(Some("")).expect("empty").name(),
            "Africa/Tripoli"
        );
        assert!(matches!(
            statement_timezone(Some("Mars/Olympus")),
            Err(ReconError::UnknownTimezone(_))
        ));
        let date = NaiveDate::from_ymd_opt(2026, 11, 1).expect("date");
        let instant = midnight_in_timezone(date, timezone).expect("midnight");
        assert_eq!(instant.to_rfc3339(), "2026-10-31T22:00:00+00:00");
    }
}
