//! PostgreSQL WAL file naming and archiver arithmetic. Port of
//! `deploy/backup-daemon/src/walNames.ts`.
//!
//! `pg_stat_archiver.last_archived_wal` is a 24-hex-character segment FILE NAME
//! (`00000001000000000000001A`), not an LSN, so it can never be passed to `pg_wal_lsn_diff()`
//! (that raised "function pg_wal_lsn_diff(pg_lsn, text) does not exist" on every poll and left the
//! lag reported as 0 forever).

use chrono::{DateTime, Utc};

pub const DEFAULT_WAL_SEGMENT_BYTES: u64 = 16 * 1024 * 1024;

fn is_uppercase_hex(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

pub fn is_wal_segment_name(name: &str) -> bool {
    name.len() == 24 && is_uppercase_hex(name)
}

fn is_history_name(name: &str) -> bool {
    match name.strip_suffix(".history") {
        Some(stem) => stem.len() == 8 && is_uppercase_hex(stem),
        None => false,
    }
}

fn is_backup_label_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".backup") else {
        return false;
    };
    let Some((segment, timeline)) = stem.split_once('.') else {
        return false;
    };
    segment.len() == 24
        && is_uppercase_hex(segment)
        && timeline.len() == 8
        && is_uppercase_hex(timeline)
}

/// Everything `archive_command` may push: segments, timeline history files, backup labels.
#[must_use]
pub fn is_archivable_wal_file(name: &str) -> bool {
    is_wal_segment_name(name) || is_history_name(name) || is_backup_label_name(name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WalTarget {
    PostgresCore,
    AuditDb,
}

impl WalTarget {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PostgresCore => "postgres_core",
            Self::AuditDb => "audit_db",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "postgres_core" => Some(Self::PostgresCore),
            "audit_db" => Some(Self::AuditDb),
            _ => None,
        }
    }
}

/// Absolute segment number (timeline ignored): `logId * segmentsPerLog + segId`.
#[must_use]
pub fn wal_segment_number(name: &str, segment_bytes: u64) -> Option<u64> {
    if !is_wal_segment_name(name) {
        return None;
    }
    let segments_per_log = 0x1_0000_0000_u64 / segment_bytes;
    let log_id = u64::from_str_radix(&name[8..16], 16).ok()?;
    let seg_id = u64::from_str_radix(&name[16..24], 16).ok()?;
    Some(log_id * segments_per_log + seg_id)
}

#[must_use]
pub fn wal_segment_name(timeline: u32, segment_number: u64, segment_bytes: u64) -> String {
    let segments_per_log = 0x1_0000_0000_u64 / segment_bytes;
    format!(
        "{:08X}{:08X}{:08X}",
        timeline,
        segment_number / segments_per_log,
        segment_number % segments_per_log
    )
}

/// Bytes between the segment being written and the last archived one (0 when unknown).
#[must_use]
pub fn archive_lag_bytes(
    current_wal_file: &str,
    last_archived_wal: &str,
    segment_bytes: u64,
) -> u64 {
    match (
        wal_segment_number(current_wal_file, segment_bytes),
        wal_segment_number(last_archived_wal, segment_bytes),
    ) {
        (Some(current), Some(last)) => current.saturating_sub(last) * segment_bytes,
        _ => 0,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalArchiveStatus {
    pub last_archived_wal: String,
    /// Alert-relevant lag: time since the last archive, but ONLY while archiving is actually behind.
    pub lag_seconds: u64,
    /// Plain time since the last archived segment, regardless of whether anything is waiting.
    pub seconds_since_last_archive: u64,
    pub archived_count: u64,
    pub failed_count: u64,
    pub current_lsn: String,
    pub current_wal_file: String,
    pub lag_bytes: u64,
    /// Completed segments PostgreSQL has moved past that are not archived yet (the segment being
    /// written does not count).
    pub completed_pending_segments: u64,
    /// The archiver's most recent attempt failed (last_failed_time newer than last_archived_time).
    pub failing: bool,
}

/// Parses the pipe-separated `psql -A -t` row of `WAL_ARCHIVE_STATUS_QUERY`:
/// `last_archived_wal|lag_seconds|archived_count|failed_count|current_lsn|current_wal_file[|failing]`.
///
/// "Time since the last archive" alone is the wrong alarm: an idle database writes no WAL, so
/// nothing is archived and the number grows forever. Lag only counts while archiving is genuinely
/// behind, i.e. a COMPLETED segment is waiting (current segment > last archived + 1) or the
/// archiver is failing. The segment currently being written is not late.
#[must_use]
pub fn parse_wal_archive_status(stdout: &str, segment_bytes: u64) -> WalArchiveStatus {
    let row = stdout.trim().split('\n').next().unwrap_or("");
    let fields: Vec<&str> = row.split('|').map(str::trim).collect();
    let field = |index: usize| fields.get(index).copied().unwrap_or("");
    let number = |value: &str| -> u64 {
        value
            .parse::<f64>()
            .map(|parsed| {
                if parsed.is_finite() {
                    parsed.max(0.0).round() as u64
                } else {
                    0
                }
            })
            .unwrap_or(0)
    };
    let last_archived_wal = field(0).to_owned();
    let seconds_since_last_archive = number(field(1));
    let archived_count = number(field(2));
    let failed_count = number(field(3));
    let current_lsn = field(4).to_owned();
    let current_wal_file = field(5).to_owned();
    let failing_text = field(6).to_ascii_lowercase();
    let failing = failing_text == "true" || failing_text == "t";
    let current = wal_segment_number(&current_wal_file, segment_bytes);
    let last = wal_segment_number(&last_archived_wal, segment_bytes);
    let completed_pending_segments = match (current, last) {
        (Some(current), Some(last)) => current.saturating_sub(last).saturating_sub(1),
        _ => 0,
    };
    WalArchiveStatus {
        lag_seconds: if completed_pending_segments > 0 || failing {
            seconds_since_last_archive
        } else {
            0
        },
        seconds_since_last_archive,
        archived_count,
        failed_count,
        current_lsn,
        current_wal_file: current_wal_file.clone(),
        lag_bytes: archive_lag_bytes(&current_wal_file, &last_archived_wal, segment_bytes),
        completed_pending_segments,
        failing,
        last_archived_wal,
    }
}

/// `0/2000028` -> absolute byte position.
#[must_use]
pub fn lsn_to_bytes(lsn: &str) -> Option<u64> {
    let (high, low) = lsn.trim().split_once('/')?;
    if high.is_empty() || low.is_empty() {
        return None;
    }
    let high = u64::from_str_radix(high, 16).ok()?;
    let low = u64::from_str_radix(low, 16).ok()?;
    Some(high * 0x1_0000_0000 + low)
}

/// The WAL segment file that contains `lsn` on `timeline`.
#[must_use]
pub fn lsn_to_segment_name(lsn: &str, timeline: u32, segment_bytes: u64) -> Option<String> {
    let bytes = lsn_to_bytes(lsn)?;
    Some(wal_segment_name(
        timeline,
        bytes / segment_bytes,
        segment_bytes,
    ))
}

/// `recovery_target_time` value PostgreSQL can parse while it is still reading its configuration.
/// An ISO string ending in `Z` is REJECTED there ("invalid value for parameter
/// recovery_target_time": the `Z` abbreviation table is not loaded yet), so use a numeric UTC
/// offset instead.
#[must_use]
pub fn pg_recovery_timestamp(date: DateTime<Utc>) -> String {
    date.format("%Y-%m-%d %H:%M:%S%.3f+00").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_archivable_files() {
        assert!(is_archivable_wal_file("00000001000000000000001A"));
        assert!(is_archivable_wal_file("00000002.history"));
        assert!(is_archivable_wal_file(
            "000000010000000000000001.00000028.backup"
        ));
        assert!(!is_archivable_wal_file("00000001000000000000001a"));
        assert!(!is_archivable_wal_file("nope"));
    }

    #[test]
    fn segment_numbers_ignore_the_timeline() {
        assert_eq!(
            wal_segment_number("00000001000000000000001A", DEFAULT_WAL_SEGMENT_BYTES),
            Some(26)
        );
        assert_eq!(
            wal_segment_number("000000010000000100000000", DEFAULT_WAL_SEGMENT_BYTES),
            Some(256)
        );
        assert_eq!(
            lsn_to_segment_name("0/2000028", 1, DEFAULT_WAL_SEGMENT_BYTES),
            Some("000000010000000000000002".to_owned())
        );
    }

    #[test]
    fn an_idle_database_does_not_alarm() {
        let status = parse_wal_archive_status(
            "000000010000000000000010|86400|10|0|0/2000028|000000010000000000000011|false",
            DEFAULT_WAL_SEGMENT_BYTES,
        );
        assert_eq!(status.lag_seconds, 0);
    }

    #[test]
    fn a_waiting_completed_segment_or_a_failing_archiver_counts() {
        let waiting = parse_wal_archive_status(
            "000000010000000000000010|120|10|0|0/2000028|000000010000000000000013|false",
            DEFAULT_WAL_SEGMENT_BYTES,
        );
        assert_eq!(waiting.lag_seconds, 120);
        assert_eq!(waiting.completed_pending_segments, 2);
        let failing = parse_wal_archive_status(
            "000000010000000000000010|90|10|1|0/2000028|000000010000000000000011|true",
            DEFAULT_WAL_SEGMENT_BYTES,
        );
        assert_eq!(failing.lag_seconds, 90);
    }

    #[test]
    fn recovery_timestamps_use_a_numeric_offset() {
        let date = DateTime::parse_from_rfc3339("2026-11-03T09:55:00.000Z")
            .expect("date")
            .with_timezone(&Utc);
        assert_eq!(pg_recovery_timestamp(date), "2026-11-03 09:55:00.000+00");
    }
}
