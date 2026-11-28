//! Academy progress parsing, sanitisation and the public projection.
//!
//! Port of `core-back/engine/academy/progress.ts` (`parseStoredProgress`, `emptyProgress`,
//! `publicProgress`) and of the field limits of `api/internal/academy.ts`.
//!
//! The stored column is `users.academy_progress_json`. `_server` (open exam sessions and used
//! question ids) never leaves the process; an expired open session is dropped, exactly like
//! `publicProgress`. Legacy rows (no `schema: 1`) become a fresh record that keeps only
//! `guideRead`, so a hand-edited or pre-v1 row can never surface arbitrary keys.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use pg_domain_academy::UtcMillis;
use serde_json::{json, Map, Number, Value};

use super::catalog::Catalog;

/// `PROGRESS_MAX_BYTES` (enforced by the write route; kept here for the shared contract).
#[allow(dead_code, reason = "the write slice enforces the same constant")]
pub const PROGRESS_MAX_BYTES: usize = 64 * 1024;

/// `guideRead[id]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuideEntry {
    pub v: String,
    pub at: String,
}

/// `lessons[id]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonEntry {
    pub at: String,
    pub v: String,
    pub check_score: i64,
}

/// `labs[id]`.
#[derive(Debug, Clone, PartialEq)]
pub struct LabEntry {
    pub best_score: f64,
    pub attempts: i64,
    pub passed_at: Option<String>,
    pub critical_errors: i64,
    pub v: String,
}

/// One stored exam attempt summary.
#[derive(Debug, Clone, PartialEq)]
pub struct ExamAttempt {
    pub at: String,
    pub score_percent: f64,
    pub passed: bool,
    pub critical_missed: f64,
    pub module_scores: BTreeMap<String, f64>,
    pub duration_seconds: f64,
}

/// One stored exam entry (`exams[examId]`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExamEntry {
    pub attempts: Vec<ExamAttempt>,
    pub open: Option<OpenSession>,
    pub passed_at: Option<String>,
    pub v: String,
}

/// An open exam session (from `_server.open`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSession {
    pub session_id: String,
    pub started_at: String,
    pub expires_at: String,
}

/// A stored badge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Badge {
    pub id: String,
    pub track: String,
    pub earned_at: String,
    pub expires_at: String,
    pub v: String,
}

impl Badge {
    /// `isBadgeValid`: not expired and not older (by major version) than `recertifyFrom`.
    #[must_use]
    pub fn valid(&self, catalog: &Catalog, now: DateTime<Utc>) -> bool {
        let Some(expires) = UtcMillis::parse_iso(&self.expires_at) else {
            return false;
        };
        let now_ms = UtcMillis::from_millis(now.timestamp_millis());
        expires > now_ms
            && super::catalog::major_version(Some(&self.v))
                >= super::catalog::major_version(Some(&catalog.recertify_from))
    }
}

/// The parsed stored record.
#[derive(Debug, Clone)]
pub struct StoredProgress {
    pub rev: i64,
    pub started_at: String,
    pub updated_at: String,
    pub content_version: String,
    pub active_track: Option<String>,
    pub integrity_accepted_at: Option<String>,
    pub guide_read: BTreeMap<String, GuideEntry>,
    pub lessons: BTreeMap<String, LessonEntry>,
    pub labs: BTreeMap<String, LabEntry>,
    pub exams: BTreeMap<String, ExamEntry>,
    /// `_server.open`: the trusted live-session map (never serialised).
    pub server_open: BTreeMap<String, OpenSession>,
    pub badges: Vec<Badge>,
    /// True when the stored value was not a `schema: 1` record (TS `isNew`).
    pub is_new: bool,
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    if text.chars().count() <= max {
        Some(text.to_owned())
    } else {
        None
    }
}

fn time_at(value: Option<&Value>) -> Option<String> {
    let candidate = text(value, 40)?;
    UtcMillis::parse_iso(&candidate)?;
    Some(candidate)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|number| number.is_finite())
}

fn number_in(value: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    finite(value).filter(|number| *number >= min && *number <= max)
}

fn integer_in(value: Option<&Value>, min: f64, max: f64) -> Option<i64> {
    number_in(value, min, max).map(|number| number.trunc() as i64)
}

fn guide_entry(value: &Value) -> Option<GuideEntry> {
    let entry = value.as_object()?;
    Some(GuideEntry {
        v: text(entry.get("v"), 20)?,
        at: time_at(entry.get("at"))?,
    })
}

fn lesson_entry(value: &Value) -> Option<LessonEntry> {
    let entry = value.as_object()?;
    let score = entry.get("checkScore")?.as_i64()?;
    if !(0..=2).contains(&score) {
        return None;
    }
    Some(LessonEntry {
        at: time_at(entry.get("at"))?,
        v: text(entry.get("v"), 20)?,
        check_score: score,
    })
}

fn lab_entry(value: &Value) -> Option<LabEntry> {
    let entry = value.as_object()?;
    Some(LabEntry {
        best_score: number_in(entry.get("bestScore"), 0.0, 100.0)?,
        attempts: integer_in(entry.get("attempts"), 0.0, 100_000.0)?,
        critical_errors: integer_in(entry.get("criticalErrors"), 0.0, 10_000.0)?,
        v: text(entry.get("v"), 20)?,
        passed_at: entry.get("passedAt").and_then(|value| time_at(Some(value))),
    })
}

fn attempt_entry(value: &Value) -> Option<ExamAttempt> {
    let entry = value.as_object()?;
    let mut module_scores = BTreeMap::new();
    if let Some(scores) = entry.get("moduleScores").and_then(Value::as_object) {
        for (module, score) in scores {
            if module.chars().count() > 120 {
                continue;
            }
            if let Some(parsed) = number_in(Some(score), 0.0, 100.0) {
                module_scores.insert(module.clone(), parsed);
            }
        }
    }
    Some(ExamAttempt {
        at: time_at(entry.get("at"))?,
        score_percent: number_in(entry.get("scorePercent"), 0.0, 100.0)?,
        passed: entry.get("passed").and_then(Value::as_bool) == Some(true),
        critical_missed: number_in(entry.get("criticalMissed"), 0.0, 10_000.0)?,
        module_scores,
        duration_seconds: number_in(entry.get("durationSeconds"), 0.0, 10_000_000.0)?,
    })
}

fn badge_entry(value: &Value, catalog: &Catalog) -> Option<Badge> {
    let entry = value.as_object()?;
    let track = text(entry.get("track"), 120)?;
    if !catalog.has_track(&track) {
        return None;
    }
    Some(Badge {
        id: text(entry.get("id"), 120)?,
        track,
        earned_at: time_at(entry.get("earnedAt"))?,
        expires_at: time_at(entry.get("expiresAt"))?,
        v: text(entry.get("v"), 20)?,
    })
}

fn record_of<T>(value: Option<&Value>, parse: impl Fn(&Value) -> Option<T>) -> BTreeMap<String, T> {
    let mut out = BTreeMap::new();
    if let Some(entries) = value.and_then(Value::as_object) {
        for (key, entry) in entries {
            if key.chars().count() > 120 {
                continue;
            }
            if let Some(parsed) = parse(entry) {
                out.insert(key.clone(), parsed);
            }
        }
    }
    out
}

fn server_open(value: Option<&Value>) -> BTreeMap<String, OpenSession> {
    let mut out = BTreeMap::new();
    let Some(open) = value
        .and_then(Value::as_object)
        .and_then(|server| server.get("open"))
        .and_then(Value::as_object)
    else {
        return out;
    };
    for (exam_id, entry) in open {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(session_id) = text(entry.get("sessionId"), 80) else {
            continue;
        };
        let Some(started_at) = time_at(entry.get("startedAt")) else {
            continue;
        };
        let Some(expires_at) = time_at(entry.get("expiresAt")) else {
            continue;
        };
        if integer_in(entry.get("attemptNumber"), 1.0, 1_000_000.0).is_none() {
            continue;
        }
        out.insert(
            exam_id.clone(),
            OpenSession {
                session_id,
                started_at,
                expires_at,
            },
        );
    }
    out
}

fn json_number(value: f64) -> Value {
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn now_text(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `emptyProgress(now, contentVersion)`.
#[must_use]
pub fn empty_progress(catalog: &Catalog, now: DateTime<Utc>) -> StoredProgress {
    StoredProgress {
        rev: 0,
        started_at: now_text(now),
        updated_at: now_text(now),
        content_version: catalog.content_version.clone(),
        active_track: None,
        integrity_accepted_at: None,
        guide_read: BTreeMap::new(),
        lessons: BTreeMap::new(),
        labs: BTreeMap::new(),
        exams: BTreeMap::new(),
        server_open: BTreeMap::new(),
        badges: Vec::new(),
        is_new: true,
    }
}

/// `parseStoredProgress`: `None`/legacy becomes a fresh record (keeping `guideRead`).
#[must_use]
pub fn parse_stored_progress(
    raw: Option<&Value>,
    catalog: &Catalog,
    now: DateTime<Utc>,
) -> StoredProgress {
    let Some(record) = object(raw) else {
        return empty_progress(catalog, now);
    };
    if record.get("schema").and_then(Value::as_i64) != Some(1) {
        let mut fresh = empty_progress(catalog, now);
        fresh.guide_read = record_of(record.get("guideRead"), guide_entry);
        return fresh;
    }
    let started_at = text(record.get("startedAt"), 40).unwrap_or_else(|| now_text(now));
    let updated_at = text(record.get("updatedAt"), 40)
        .filter(|value| UtcMillis::parse_iso(value).is_some())
        .unwrap_or_else(|| started_at.clone());
    let mut exams: BTreeMap<String, ExamEntry> = BTreeMap::new();
    if let Some(entries) = record.get("exams").and_then(Value::as_object) {
        for (exam_id, entry) in entries {
            if exam_id.chars().count() > 120 {
                continue;
            }
            let Some(entry) = entry.as_object() else {
                continue;
            };
            let attempts: Vec<ExamAttempt> = entry
                .get("attempts")
                .and_then(Value::as_array)
                .map(|attempts| {
                    attempts
                        .iter()
                        .filter_map(attempt_entry)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let start = attempts.len().saturating_sub(20);
            let open = entry
                .get("open")
                .and_then(Value::as_object)
                .and_then(|open| {
                    let session_id = text(open.get("sessionId"), 80)?;
                    let started_at = time_at(open.get("startedAt"))?;
                    let expires_at = time_at(open.get("expiresAt"))?;
                    Some(OpenSession {
                        session_id,
                        started_at,
                        expires_at,
                    })
                });
            exams.insert(
                exam_id.clone(),
                ExamEntry {
                    attempts: attempts[start..].to_vec(),
                    open,
                    passed_at: entry.get("passedAt").and_then(|value| time_at(Some(value))),
                    v: text(entry.get("v"), 20).unwrap_or_else(|| catalog.content_version.clone()),
                },
            );
        }
    }
    let active_track =
        text(record.get("activeTrack"), 120).filter(|track| catalog.has_track(track));
    StoredProgress {
        rev: integer_in(record.get("rev"), 0.0, 9_007_199_254_740_991.0).unwrap_or(0),
        started_at,
        updated_at,
        content_version: text(record.get("contentVersion"), 20)
            .unwrap_or_else(|| catalog.content_version.clone()),
        active_track,
        integrity_accepted_at: record
            .get("integrityAcceptedAt")
            .and_then(|value| time_at(Some(value))),
        guide_read: record_of(record.get("guideRead"), guide_entry),
        lessons: record_of(record.get("lessons"), lesson_entry),
        labs: record_of(record.get("labs"), lab_entry),
        exams,
        server_open: server_open(record.get("_server")),
        badges: record
            .get("badges")
            .and_then(Value::as_array)
            .map(|badges| {
                badges
                    .iter()
                    .filter_map(|badge| badge_entry(badge, catalog))
                    .collect()
            })
            .unwrap_or_default(),
        is_new: false,
    }
}

impl StoredProgress {
    /// `publicProgress`: the only serializer that leaves the process.
    #[must_use]
    pub fn public_json(&self, now: DateTime<Utc>) -> Value {
        let now_ms = UtcMillis::from_millis(now.timestamp_millis());
        let guide_read: Map<String, Value> = self
            .guide_read
            .iter()
            .map(|(id, entry)| (id.clone(), json!({ "v": entry.v, "at": entry.at })))
            .collect();
        let lessons: Map<String, Value> = self
            .lessons
            .iter()
            .map(|(id, entry)| {
                (
                    id.clone(),
                    json!({ "at": entry.at, "v": entry.v, "checkScore": entry.check_score }),
                )
            })
            .collect();
        let labs: Map<String, Value> = self
            .labs
            .iter()
            .map(|(id, entry)| {
                let mut value = Map::new();
                value.insert("bestScore".to_owned(), json_number(entry.best_score));
                value.insert("attempts".to_owned(), json!(entry.attempts));
                if let Some(passed_at) = &entry.passed_at {
                    value.insert("passedAt".to_owned(), json!(passed_at));
                }
                value.insert("criticalErrors".to_owned(), json!(entry.critical_errors));
                value.insert("v".to_owned(), json!(entry.v));
                (id.clone(), Value::Object(value))
            })
            .collect();
        let mut exams: Map<String, Value> = Map::new();
        for (exam_id, entry) in &self.exams {
            let mut value = Map::new();
            let attempts: Vec<Value> = entry
                .attempts
                .iter()
                .map(|attempt| {
                    let module_scores: Map<String, Value> = attempt
                        .module_scores
                        .iter()
                        .map(|(module, score)| (module.clone(), json_number(*score)))
                        .collect();
                    json!({
                        "at": attempt.at,
                        "scorePercent": json_number(attempt.score_percent),
                        "passed": attempt.passed,
                        "criticalMissed": json_number(attempt.critical_missed),
                        "moduleScores": module_scores,
                        "durationSeconds": json_number(attempt.duration_seconds),
                    })
                })
                .collect();
            value.insert("attempts".to_owned(), Value::Array(attempts));
            if let Some(open) = &entry.open {
                if UtcMillis::parse_iso(&open.expires_at).is_some_and(|expires| expires > now_ms) {
                    value.insert(
                        "open".to_owned(),
                        json!({
                            "sessionId": open.session_id,
                            "startedAt": open.started_at,
                            "expiresAt": open.expires_at,
                        }),
                    );
                }
            }
            if let Some(passed_at) = &entry.passed_at {
                value.insert("passedAt".to_owned(), json!(passed_at));
            }
            value.insert("v".to_owned(), json!(entry.v));
            exams.insert(exam_id.clone(), Value::Object(value));
        }
        let mut output = Map::new();
        output.insert("schema".to_owned(), json!(1));
        output.insert("rev".to_owned(), json!(self.rev));
        output.insert("startedAt".to_owned(), json!(self.started_at));
        output.insert("updatedAt".to_owned(), json!(self.updated_at));
        output.insert("contentVersion".to_owned(), json!(self.content_version));
        if let Some(track) = &self.active_track {
            output.insert("activeTrack".to_owned(), json!(track));
        }
        if let Some(accepted) = &self.integrity_accepted_at {
            output.insert("integrityAcceptedAt".to_owned(), json!(accepted));
        }
        output.insert("guideRead".to_owned(), Value::Object(guide_read));
        output.insert("lessons".to_owned(), Value::Object(lessons));
        output.insert("labs".to_owned(), Value::Object(labs));
        output.insert("exams".to_owned(), Value::Object(exams));
        output.insert(
            "badges".to_owned(),
            Value::Array(
                self.badges
                    .iter()
                    .map(|badge| {
                        json!({
                            "id": badge.id,
                            "track": badge.track,
                            "earnedAt": badge.earned_at,
                            "expiresAt": badge.expires_at,
                            "v": badge.v,
                        })
                    })
                    .collect(),
            ),
        );
        Value::Object(output)
    }

    /// The live (unexpired) open session of an exam, if any (`hasLiveSession`).
    ///
    /// Only `_server.open` is trusted; an `exams[].open` value written by a client never grants a
    /// resumable session.
    #[must_use]
    pub fn live_session(&self, exam_id: &str, now: DateTime<Utc>) -> Option<&OpenSession> {
        let now_ms = UtcMillis::from_millis(now.timestamp_millis());
        let open = self.server_open.get(exam_id)?;
        let expires = UtcMillis::parse_iso(&open.expires_at)?;
        (expires > now_ms).then_some(open)
    }
}

/// True when a lesson/lab/guide entry carries a valid timestamp (used by the team activity).
#[must_use]
pub fn parsed_millis(value: &str) -> Option<UtcMillis> {
    UtcMillis::parse_iso(value)
}

/// `isLabPassed`: best score at or above the lab threshold and no critical error.
#[must_use]
pub fn is_lab_passed(lab: Option<&LabEntry>, catalog: &Catalog, lab_id: &str) -> bool {
    let Some(lab) = lab else {
        return false;
    };
    let pass_percent = catalog.lab(lab_id).map_or(80, |entry| entry.pass_percent);
    lab.best_score >= f64::from(pass_percent) && lab.critical_errors == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        // The real embedded catalogue keeps the test honest about contentVersion/tracks.
        super::super::catalog::catalog().clone()
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-28T09:00:00.000Z")
            .expect("timestamp")
            .with_timezone(&Utc)
    }

    #[test]
    fn a_null_or_legacy_record_becomes_a_fresh_one() {
        let catalog = catalog();
        let fresh = parse_stored_progress(None, &catalog, now());
        assert!(fresh.is_new);
        assert_eq!(fresh.rev, 0);
        assert_eq!(fresh.content_version, catalog.content_version);
        assert_eq!(fresh.public_json(now())["schema"], 1);

        let legacy = json!({"guideRead": {"g1": {"v": "1.0.0", "at": "2026-11-01T10:00:00Z"}}});
        let parsed = parse_stored_progress(Some(&legacy), &catalog, now());
        assert!(parsed.is_new);
        assert!(parsed.guide_read.contains_key("g1"));
        assert!(parsed.lessons.is_empty());
    }

    #[test]
    fn malformed_entries_are_dropped_not_rendered() {
        let catalog = catalog();
        let raw = json!({
            "schema": 1,
            "rev": 4.9,
            "startedAt": "2026-11-01T10:00:00Z",
            "updatedAt": "2026-11-02T10:00:00Z",
            "contentVersion": "1.0.0",
            "activeTrack": "NOT_A_TRACK",
            "guideRead": {
                "good": {"v": "1.0.0", "at": "2026-11-01T10:00:00Z"},
                "bad": {"v": "1.0.0", "at": "not-a-date"}
            },
            "lessons": {
                "l-m0-1": {"at": "2026-11-01T10:00:00Z", "v": "1.0.0", "checkScore": 2},
                "broken": {"at": "2026-11-01T10:00:00Z", "v": "1.0.0", "checkScore": 7}
            },
            "labs": {
                "lab-flow-tracer": {"bestScore": 90, "attempts": 2.8, "criticalErrors": 0, "v": "1.0.0"}
            },
            "exams": {},
            "badges": [
                {"id": "badge", "track": "FOUNDATION", "earnedAt": "2026-01-01T00:00:00Z",
                 "expiresAt": "2027-01-01T00:00:00Z", "v": "1.0.0"},
                {"id": "badge2", "track": "NOPE", "earnedAt": "2026-01-01T00:00:00Z",
                 "expiresAt": "2027-01-01T00:00:00Z", "v": "1.0.0"}
            ],
            "_server": {"open": {"exam-foundation": {"sessionId": "s1",
                "startedAt": "2026-11-01T10:00:00Z", "expiresAt": "2026-11-02T10:00:00Z",
                "attemptNumber": 1, "questions": []}}}
        });
        let parsed = parse_stored_progress(Some(&raw), &catalog, now());
        assert!(!parsed.is_new);
        assert_eq!(parsed.rev, 4);
        assert!(parsed.active_track.is_none());
        assert_eq!(parsed.guide_read.len(), 1);
        assert_eq!(parsed.lessons.len(), 1);
        assert_eq!(parsed.labs["lab-flow-tracer"].attempts, 2);
        assert_eq!(parsed.badges.len(), 1);
        let public = parsed.public_json(now());
        assert!(public.get("_server").is_none());
        assert!(public["guideRead"].get("bad").is_none());
        assert_eq!(public["lessons"]["l-m0-1"]["checkScore"], 2);
        assert!(
            parsed.live_session("exam-foundation", now()).is_none(),
            "expired"
        );
    }

    #[test]
    fn an_unexpired_open_session_survives_public_progress() {
        let catalog = catalog();
        let raw = json!({
            "schema": 1,
            "rev": 1,
            "startedAt": "2026-11-01T10:00:00Z",
            "updatedAt": "2026-11-02T10:00:00Z",
            "contentVersion": "1.0.0",
            "guideRead": {}, "lessons": {}, "labs": {}, "badges": [],
            "exams": {"exam-foundation": {"attempts": [], "v": "1.0.0",
                "open": {"sessionId": "s1", "startedAt": "2026-11-28T08:00:00Z",
                         "expiresAt": "2026-11-28T12:00:00Z"}}},
            "_server": {"open": {"exam-foundation": {"sessionId": "s1",
                "startedAt": "2026-11-28T08:00:00Z", "expiresAt": "2026-11-28T12:00:00Z",
                "attemptNumber": 1, "questions": []}}}
        });
        let parsed = parse_stored_progress(Some(&raw), &catalog, now());
        assert!(parsed.live_session("exam-foundation", now()).is_some());
        let public = parsed.public_json(now());
        assert_eq!(
            public["exams"]["exam-foundation"]["open"]["sessionId"],
            "s1"
        );
        assert!(public.get("_server").is_none());
    }

    #[test]
    fn badges_expire_and_recertify_by_major_version() {
        let catalog = catalog();
        let badge = Badge {
            id: "b".to_owned(),
            track: "FOUNDATION".to_owned(),
            earned_at: "2026-01-01T00:00:00Z".to_owned(),
            expires_at: "2027-01-01T00:00:00Z".to_owned(),
            v: catalog.recertify_from.clone(),
        };
        assert!(badge.valid(&catalog, now()));
        let mut expired = badge.clone();
        expired.expires_at = "2026-01-01T00:00:00Z".to_owned();
        assert!(!expired.valid(&catalog, now()));
        let mut old = badge;
        old.v = "0.9.0".to_owned();
        assert!(!old.valid(&catalog, now()));
    }

    #[test]
    fn lab_pass_uses_the_catalog_threshold_and_critical_errors() {
        let catalog = catalog();
        let mut lab = LabEntry {
            best_score: 100.0,
            attempts: 1,
            passed_at: Some("2026-11-01T10:00:00Z".to_owned()),
            critical_errors: 0,
            v: "1.0.0".to_owned(),
        };
        assert!(is_lab_passed(Some(&lab), &catalog, "lab-flow-tracer"));
        lab.critical_errors = 1;
        assert!(!is_lab_passed(Some(&lab), &catalog, "lab-flow-tracer"));
        lab.critical_errors = 0;
        lab.best_score = 10.0;
        assert!(!is_lab_passed(Some(&lab), &catalog, "lab-flow-tracer"));
        assert!(!is_lab_passed(None, &catalog, "lab-flow-tracer"));
    }
}
