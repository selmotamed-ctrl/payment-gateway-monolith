//! `toISOString()` vectors.

use std::str::FromStr;

use chrono::DateTime;
use pg_types::JsDate;
use serde::Deserialize;

const DATES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden-vectors/js-dates.json"
));

#[derive(Deserialize)]
struct File {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    kind: String,
    #[serde(default)]
    input: Option<serde_json::Value>,
    #[serde(default)]
    epoch_ms: Option<i64>,
    #[serde(default)]
    iso: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[test]
fn iso_strings_match_javascript() {
    let file: File = serde_json::from_str(DATES).expect("date vectors");
    let mut checked = 0;
    for case in file.cases {
        match case.kind.as_str() {
            "epochMs" => {
                let millis = case
                    .input
                    .as_ref()
                    .and_then(serde_json::Value::as_i64)
                    .expect("epochMs input");
                match DateTime::from_timestamp_millis(millis) {
                    Some(date) => {
                        assert_eq!(
                            JsDate(date).to_iso_string(),
                            case.iso.as_deref().expect("iso"),
                            "{}",
                            case.id
                        );
                        assert_eq!(date.timestamp_millis(), case.epoch_ms.expect("epochMs"));
                        checked += 1;
                    }
                    None => {
                        // The JS maximum date (year 275760) is outside chrono's range (§0.7).
                        assert_eq!(case.id, "max-date");
                    }
                }
            }
            "iso" => {
                let raw = case
                    .input
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .expect("iso input");
                let normalized = if raw.len() == 10 {
                    format!("{raw}T00:00:00Z")
                } else {
                    raw.to_owned()
                };
                let date = JsDate::from_str(&normalized).expect("parse");
                assert_eq!(
                    date.to_iso_string(),
                    case.iso.as_deref().expect("iso"),
                    "{}",
                    case.id
                );
                checked += 1;
            }
            "invalid" => {
                assert_eq!(case.error.as_deref(), Some("RangeError"));
                assert!(JsDate::from_str("NaN").is_err());
            }
            other => panic!("unknown kind {other}"),
        }
    }
    assert!(checked >= 11);
}
