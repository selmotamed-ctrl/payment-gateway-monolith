//! Public academy-certificate verification used by the checkout portal.
//!
//! Port of `core-back/api/internal/checkout.ts:57-101` and the parts of
//! `core-back/engine/academy/{catalog,progress,certificate}.ts` it reads:
//!
//! - the certificate is looked up by its opaque `publicId` (never a user id);
//! - the answer is `valid` only for an `ACTIVE` certificate of an `ACTIVE` holder whose stored
//!   progress still carries the badge for that track and earning instant, whose badge has not
//!   expired and whose major content version is at least the catalog's `recertifyFrom` major;
//! - otherwise the stored certificate is `revoked`; an active certificate with an expired or
//!   outdated badge is `expired`.
//!
//! The academy catalog is generated TS content (`core-back/content/academy/catalog.json`,
//! committed and versioned). It is embedded at compile time so the recertification floor and the
//! track badge codes cannot drift from the TS reader. P9-T08 moves the content under
//! `backend-rs/content/academy/`; the path below then changes once, and a missing file is a build
//! error (intentional: verification must never silently fall back to "valid").

#![forbid(unsafe_code)]

use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use super::super::common::database_error;
use pg_http::ApiError;

const CATALOG_JSON: &str = include_str!("../../../../../../core-back/content/academy/catalog.json");

/// `ACADEMY_TRACK_TITLES` (`checkout.ts:46`).
const ACADEMY_TRACK_TITLES: [(&str, &str); 8] = [
    ("FOUNDATION", "Foundation (everyone)"),
    ("OPERATOR", "Operator"),
    ("SUPPORT", "Support agent"),
    ("FINANCE", "Finance officer"),
    ("COMPLIANCE", "Compliance analyst"),
    ("MLRO", "Money Laundering Reporting Officer"),
    ("GATEWAY_ADMIN", "Gateway administrator"),
    ("SECURITY_ADMIN", "Security administrator"),
];

struct CatalogFacts {
    track_ids: Vec<String>,
    track_badges: Vec<(String, String)>,
    recertify_major: u64,
}

fn catalog_facts() -> &'static CatalogFacts {
    static FACTS: OnceLock<CatalogFacts> = OnceLock::new();
    FACTS.get_or_init(|| {
        let catalog: Value = serde_json::from_str(CATALOG_JSON).unwrap_or(Value::Null);
        let tracks = catalog
            .get("tracks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut track_ids = Vec::new();
        let mut track_badges = Vec::new();
        for track in tracks {
            let Some(id) = track.get("id").and_then(Value::as_str) else {
                continue;
            };
            track_ids.push(id.to_owned());
            if let Some(badge) = track.get("badge").and_then(Value::as_str) {
                track_badges.push((id.to_owned(), badge.to_owned()));
            }
        }
        CatalogFacts {
            track_ids,
            track_badges,
            recertify_major: major_of(
                catalog
                    .get("recertifyFrom")
                    .and_then(Value::as_str)
                    .unwrap_or("1.0.0"),
            ),
        }
    })
}

/// `majorOf` (`engine/academy/catalog.ts:33`): leading integer, `0` when unparseable.
#[must_use]
fn major_of(version: &str) -> u64 {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u64>().ok())
        .unwrap_or(0)
}

/// `GET /internal/checkout/academy/certificates/:publicId`.
pub(super) async fn certificate(pool: &PgPool, public_id: &str) -> Result<Value, ApiError> {
    let row = sqlx::query(
        "SELECT c.public_id, c.display_id, c.track_id, c.badge_code, c.holder_name,
                c.earned_at, c.expires_at, c.content_version, c.status::text AS status,
                u.status::text AS user_status, u.academy_progress_json
           FROM academy_certificates c
           JOIN users u ON u.id = c.user_id
          WHERE c.public_id = $1",
    )
    .bind(public_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "CERTIFICATE_NOT_FOUND",
            "The certificate could not be verified",
        )
    })?;

    let facts = catalog_facts();
    let track_id: String = row.try_get("track_id").map_err(|_| decode_error())?;
    let earned_at: DateTime<Utc> = row.try_get("earned_at").map_err(|_| decode_error())?;
    let expires_at: DateTime<Utc> = row.try_get("expires_at").map_err(|_| decode_error())?;
    let status: String = row.try_get("status").map_err(|_| decode_error())?;
    let user_status: String = row.try_get("user_status").map_err(|_| decode_error())?;
    let progress: Option<Value> = row.try_get("academy_progress_json").ok().flatten();

    let badge = progress
        .as_ref()
        .and_then(|raw| badge_for(raw, &track_id, earned_at, facts));
    let active = status == "ACTIVE" && user_status == "ACTIVE";
    let verification = if !active || badge.is_none() {
        "revoked"
    } else if badge
        .as_ref()
        .is_some_and(|badge| is_badge_valid(badge, facts, Utc::now()))
    {
        "valid"
    } else {
        "expired"
    };

    let track_badge = facts
        .track_badges
        .iter()
        .find(|(id, _)| id == &track_id)
        .map(|(_, badge)| badge.clone())
        .or_else(|| row.try_get::<String, _>("badge_code").ok());

    Ok(json!({
        "certificateId": row.try_get::<String, _>("display_id").map_err(|_| decode_error())?,
        "publicId": row.try_get::<String, _>("public_id").map_err(|_| decode_error())?,
        "status": verification,
        "holderName": row.try_get::<String, _>("holder_name").map_err(|_| decode_error())?,
        "trackId": track_id,
        "trackTitle": track_title(&track_id),
        "badgeCode": track_badge,
        "earnedAt": iso(earned_at),
        "expiresAt": iso(expires_at),
        "contentVersion": row.try_get::<String, _>("content_version").map_err(|_| decode_error())?,
    }))
}

/// `ACADEMY_TRACK_TITLES[...]` then the `SOME_TRACK` → `Some Track` fallback.
#[must_use]
fn track_title(track_id: &str) -> String {
    ACADEMY_TRACK_TITLES
        .iter()
        .find(|(id, _)| *id == track_id)
        .map(|(_, title)| (*title).to_owned())
        .unwrap_or_else(|| {
            track_id
                .to_lowercase()
                .split('_')
                .map(|part| {
                    let mut chars = part.chars();
                    match chars.next() {
                        None => String::new(),
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
}

/// The minimal badge projection `parseStoredProgress` keeps.
struct Badge {
    expires_at: Option<DateTime<Utc>>,
    version_major: u64,
}

/// `parseStoredProgress` badge filter + `badges.find(track && earnedAt === certificate.earnedAt)`.
fn badge_for(
    progress: &Value,
    track_id: &str,
    earned_at: DateTime<Utc>,
    facts: &CatalogFacts,
) -> Option<Badge> {
    let object = progress.as_object()?;
    // A non-`schema: 1` record yields fresh progress with no badges (`parseStoredProgress:153`).
    if object.get("schema").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let badges = object.get("badges").and_then(Value::as_array)?;
    for entry in badges {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
        let earned = entry
            .get("earnedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let expires = entry
            .get("expiresAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version = entry.get("v").and_then(Value::as_str).unwrap_or_default();
        let track = entry
            .get("track")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if id.is_empty()
            || id.len() > 120
            || earned.is_empty()
            || earned.len() > 40
            || expires.is_empty()
            || expires.len() > 40
            || version.len() > 20
            || !facts.track_ids.iter().any(|known| known == track)
        {
            continue;
        }
        let parsed_earned = DateTime::parse_from_rfc3339(earned)
            .ok()
            .map(|instant| instant.with_timezone(&Utc));
        if track != track_id || parsed_earned != Some(earned_at) {
            continue;
        }
        return Some(Badge {
            expires_at: DateTime::parse_from_rfc3339(expires)
                .ok()
                .map(|instant| instant.with_timezone(&Utc)),
            version_major: major_of(version),
        });
    }
    None
}

/// `isBadgeValid`: `expiresAt > now` (strict) and major version at least `recertifyFrom`.
fn is_badge_valid(badge: &Badge, facts: &CatalogFacts, now: DateTime<Utc>) -> bool {
    badge.expires_at.is_some_and(|expires| expires > now)
        && badge.version_major >= facts.recertify_major
}

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn decode_error() -> ApiError {
    tracing::error!("academy certificate row could not be decoded");
    ApiError::server_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_facts_match_the_committed_content() {
        let facts = catalog_facts();
        assert_eq!(facts.recertify_major, 1);
        assert_eq!(facts.track_ids.len(), 8);
        assert!(facts
            .track_badges
            .iter()
            .any(|(track, badge)| track == "FOUNDATION" && badge == "FOUNDATION_CERTIFIED"));
    }

    #[test]
    fn track_titles_match_the_ts_map_and_fall_back() {
        assert_eq!(track_title("MLRO"), "Money Laundering Reporting Officer");
        assert_eq!(track_title("CUSTOM_TRACK"), "Custom Track");
    }

    #[test]
    fn badges_are_read_only_from_schema_one_progress() {
        let facts = catalog_facts();
        let earned = "2026-11-01T10:00:00.000Z";
        let progress = serde_json::json!({
            "schema": 1,
            "badges": [{
                "id": "FOUNDATION_CERTIFIED",
                "track": "FOUNDATION",
                "earnedAt": earned,
                "expiresAt": "2027-11-01T10:00:00.000Z",
                "v": "1.0.0"
            }]
        });
        let timestamp = DateTime::parse_from_rfc3339(earned)
            .expect("time")
            .with_timezone(&Utc);
        let badge = badge_for(&progress, "FOUNDATION", timestamp, facts).expect("badge");
        assert!(is_badge_valid(&badge, facts, Utc::now()));

        let mut legacy = progress.clone();
        legacy["schema"] = serde_json::json!(2);
        assert!(badge_for(&legacy, "FOUNDATION", timestamp, facts).is_none());
        assert!(badge_for(&progress, "MLRO", timestamp, facts).is_none());
    }

    #[test]
    fn expired_and_old_badges_are_not_valid() {
        let facts = catalog_facts();
        let expired = Badge {
            expires_at: Some("2020-01-01T00:00:00Z".parse().expect("time")),
            version_major: 1,
        };
        assert!(!is_badge_valid(&expired, facts, Utc::now()));
        let old_version = Badge {
            expires_at: Some("2999-01-01T00:00:00Z".parse().expect("time")),
            version_major: 0,
        };
        assert!(!is_badge_valid(&old_version, facts, Utc::now()));
    }
}
