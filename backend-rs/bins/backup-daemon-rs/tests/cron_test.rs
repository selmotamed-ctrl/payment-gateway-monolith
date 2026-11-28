//! Port of `deploy/backup-daemon/test/cron.test.ts`.

use backup_daemon::cron::{
    is_valid_cron_expression, next_cron_run, parse_cron, parse_cron_field, FieldBounds,
};
use chrono::{DateTime, Utc};

fn instant(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("timestamp")
        .with_timezone(&Utc)
}

fn next(expression: &str, from: &str) -> String {
    next_cron_run(expression, instant(from))
        .expect("valid expression")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[test]
fn supports_wildcards_steps_ranges_lists_and_range_steps() {
    let bounds = FieldBounds {
        min: 0,
        max: 59,
        name: "minute",
    };
    assert_eq!(
        parse_cron_field("*", bounds).expect("valid"),
        (0..60).collect::<Vec<u32>>()
    );
    assert_eq!(
        parse_cron_field("*/15", bounds).expect("valid"),
        vec![0, 15, 30, 45]
    );
    assert_eq!(
        parse_cron_field("1,3,5", bounds).expect("valid"),
        vec![1, 3, 5]
    );
    assert_eq!(
        parse_cron_field("5-10", bounds).expect("valid"),
        vec![5, 6, 7, 8, 9, 10]
    );
    assert_eq!(
        parse_cron_field("5-11/3", bounds).expect("valid"),
        vec![5, 8, 11]
    );
    assert_eq!(
        parse_cron_field("50/5", bounds).expect("valid"),
        vec![50, 55]
    );
}

#[test]
fn normalizes_day_of_week_seven_to_sunday_zero() {
    assert_eq!(
        parse_cron("0 2 * * 0").expect("valid").days_of_week,
        vec![0]
    );
    assert_eq!(
        parse_cron("0 2 * * 7").expect("valid").days_of_week,
        vec![0]
    );
    assert_eq!(
        parse_cron("0 2 * * 1-7").expect("valid").days_of_week,
        vec![0, 1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn rejects_malformed_or_out_of_range_expressions() {
    for expression in [
        "60 * * * *",
        "* 24 * * *",
        "* * 0 * *",
        "* * * 13 *",
        "* * * * 8",
        "*/0 * * * *",
        "10-5 * * * *",
        "0 2 * *",
    ] {
        assert!(
            parse_cron(expression).is_err(),
            "{expression} must be refused"
        );
    }
    assert!(is_valid_cron_expression("0 2 * * 0"));
    assert!(!is_valid_cron_expression("0 2 * * nope"));
}

#[test]
fn steps_through_minutes_and_is_strictly_after_the_base_time() {
    assert_eq!(
        next("*/15 * * * *", "2026-11-03T12:07:45.000Z"),
        "2026-11-03T12:15:00.000Z"
    );
    assert_eq!(
        next("*/15 * * * *", "2026-11-03T12:15:00.000Z"),
        "2026-11-03T12:30:00.000Z"
    );
}

#[test]
fn handles_lists_of_hours_and_minutes() {
    assert_eq!(
        next("5,10 1,2 * * *", "2026-11-03T01:07:00.000Z"),
        "2026-11-03T01:10:00.000Z"
    );
    assert_eq!(
        next("5,10 1,2 * * *", "2026-11-03T01:10:00.000Z"),
        "2026-11-03T02:05:00.000Z"
    );
}

#[test]
fn skips_weekends_for_weekday_ranges() {
    assert_eq!(
        next("0 9-17 * * 1-5", "2026-11-06T18:00:00.000Z"),
        "2026-11-09T09:00:00.000Z"
    );
}

#[test]
fn treats_both_zero_and_seven_as_sunday() {
    assert_eq!(
        next("0 2 * * 0", "2026-10-31T12:00:00.000Z"),
        "2026-11-01T02:00:00.000Z"
    );
    assert_eq!(
        next("0 2 * * 7", "2026-10-31T12:00:00.000Z"),
        "2026-11-01T02:00:00.000Z"
    );
    assert_eq!(
        next("0 2 * * 0", "2026-11-01T03:00:00.000Z"),
        "2026-11-08T02:00:00.000Z"
    );
}

#[test]
fn crosses_month_and_year_boundaries() {
    assert_eq!(
        next("0 0 1 * *", "2026-01-31T23:59:30.000Z"),
        "2026-02-01T00:00:00.000Z"
    );
    assert_eq!(
        next("30 23 31 12 *", "2026-12-31T23:00:00.000Z"),
        "2026-12-31T23:30:00.000Z"
    );
    assert_eq!(
        next("30 23 31 12 *", "2026-12-31T23:31:00.000Z"),
        "2027-12-31T23:30:00.000Z"
    );
}
