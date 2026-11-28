//! `Date#toISOString()` compatible timestamp.
//!
//! Every timestamp the API emits has exactly three fraction digits and a `Z` suffix, matching
//! JavaScript. Columns are stored as `timestamp(3)` without time zone holding UTC, so values are
//! truncated to milliseconds before they leave the boundary.

#![forbid(unsafe_code)]

use chrono::{DateTime, SecondsFormat, Utc};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct JsDate(pub DateTime<Utc>);

impl JsDate {
    #[must_use]
    pub fn now() -> Self {
        Self(Utc::now())
    }

    #[must_use]
    pub fn to_iso_string(self) -> String {
        self.0.to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    /// Truncate to whole milliseconds, as PostgreSQL `timestamp(3)` does.
    #[must_use]
    pub fn truncated(self) -> Self {
        let nanos = self.0.timestamp_subsec_nanos();
        let millis = (nanos / 1_000_000) * 1_000_000;
        Self(self.0.with_nanosecond(millis).unwrap_or(self.0))
    }
}

use chrono::Timelike;

impl fmt::Display for JsDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_iso_string())
    }
}

impl Serialize for JsDate {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_iso_string())
    }
}

impl<'de> Deserialize<'de> for JsDate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DateVisitor;
        impl Visitor<'_> for DateVisitor {
            type Value = JsDate;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an ISO-8601 timestamp")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                DateTime::parse_from_rfc3339(value)
                    .map(|value| JsDate(value.with_timezone(&Utc)))
                    .map_err(E::custom)
            }
        }
        deserializer.deserialize_str(DateVisitor)
    }
}

impl FromStr for JsDate {
    type Err = chrono::ParseError;
    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        DateTime::parse_from_rfc3339(raw).map(|value| Self(value.with_timezone(&Utc)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_string_always_has_three_fraction_digits() {
        let date = JsDate::from_str("2026-11-28T10:20:30Z").expect("valid");
        assert_eq!(date.to_iso_string(), "2026-11-28T10:20:30.000Z");
        let date = JsDate::from_str("2026-11-28T10:20:30.1Z").expect("valid");
        assert_eq!(date.to_iso_string(), "2026-11-28T10:20:30.100Z");
    }

    #[test]
    fn truncates_microseconds() {
        let date = JsDate::from_str("2026-11-28T10:20:30.123456Z").expect("valid");
        assert_eq!(date.truncated().to_iso_string(), "2026-11-28T10:20:30.123Z");
    }
}
