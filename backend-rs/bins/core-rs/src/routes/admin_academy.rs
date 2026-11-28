//! Admin Academy read routes (P4-T05 / P8-T08 read slice).
//!
//! Port of the `GET` handlers of `core-back/api/internal/academy.ts` (mounted at
//! `/internal/admin/academy`). The router applies `requireStaffPrincipal` and nothing else; the
//! back-office rule and the `SECURITY_ADMIN` team rule live in the handlers, exactly as in the TS
//! `academyUser()` / role checks.
//!
//! | Rust handler | TS source |
//! | :--- | :--- |
//! | [`progress`] | `academy.ts:116` |
//! | [`eligibility`] | `academy.ts:127` |
//! | [`certificate_verification`] | `academy.ts:165` |
//! | [`team`] | `academy.ts:205` |
//! | [`team_export`] | `academy.ts:220` |
//!
//! Deviations of this read slice (see the module report):
//!
//! - `GET /progress` never persists the first empty record (`isNew`) and writes no
//!   `ACADEMY_PROGRESS` audit row; the TS `mutate()` saves it. Creation and the audit trail are
//!   part of the Academy write slice (P7-T08).
//! - Certificate verification issues the certificate row like the TS route
//!   (`ensureAcademyCertificateForBadge`) but writes no `ACADEMY_CERTIFICATE_LINK_CREATED` audit
//!   row for the same reason.
//! - The catalogue and exam bank are embedded from `core-back/content/academy/` until P9-T08 moves
//!   them; the scoring/badge rules used here come from `pg-domain-academy`.
//! - Nothing logs a progress record, an email address or a certificate identifier.

#![forbid(unsafe_code)]

mod catalog;
mod progress;

#[cfg(test)]
mod tests;

use chrono::{DateTime, SecondsFormat, Utc};
use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_domain_academy::{CertificateIdentity, UtcMillis};
use pg_domain_auth::{Principal, PrincipalKind};
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use super::common::{self, Query};
use super::{CustomHandler, Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;
use catalog::{build_team, compute_eligibility, TeamUser};
use progress::parse_stored_progress;

/// `{"checklist":[<allowed>]}` of `team.ts` export.
const EXPORT_CHECKLIST: &[&str] = &[
    "TEAM_SCOPE_VERIFIED",
    "PERSONAL_DATA_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
];

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/academy/progress",
            "core-back/api/internal/academy.ts:116",
            progress,
        ),
        route(
            "/internal/admin/academy/exams/:examId/eligibility",
            "core-back/api/internal/academy.ts:127",
            eligibility,
        ),
        route(
            "/internal/admin/academy/certificates/:trackId/verification",
            "core-back/api/internal/academy.ts:165",
            certificate_verification,
        ),
        route(
            "/internal/admin/academy/team",
            "core-back/api/internal/academy.ts:205",
            team,
        ),
        route(
            "/internal/admin/academy/team/export",
            "core-back/api/internal/academy.ts:220",
            team_export,
        ),
    ]
}

fn route(path: &str, ts_origin: &str, handler: CustomHandler) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, ts_origin)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

/// `academyUser()`: a staff session (never a merchant user or an API token).
fn academy_user(principal: Option<&Principal>) -> Result<(&str, &str), ApiError> {
    let principal = principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })?;
    let user_id = principal
        .user_id
        .as_deref()
        .filter(|_| principal.kind == PrincipalKind::Session && principal.merchant_id.is_none())
        .ok_or_else(|| {
            ApiError::new(
                403,
                "ACADEMY_BACK_OFFICE_ONLY",
                "The Academy is available to back-office users only",
            )
        })?;
    Ok((user_id, principal.role.as_deref().unwrap_or("UNKNOWN")))
}

/// `role !== "SECURITY_ADMIN"` → `ACADEMY_TEAM_FORBIDDEN`.
fn require_security_admin(role: &str, message: &str) -> Result<(), ApiError> {
    if role == "SECURITY_ADMIN" {
        Ok(())
    } else {
        Err(ApiError::new(
            403,
            "ACADEMY_TEAM_FORBIDDEN",
            message.to_owned(),
        ))
    }
}

fn respond<'a, F>(request: &'a HttpRequest, future: F) -> HandlerFuture<'a>
where
    F: std::future::Future<Output = Result<Value, ApiError>> + 'a,
{
    Box::pin(async move {
        match future.await {
            Ok(value) => common::json_ok(&value),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

fn database(error: sqlx::Error) -> ApiError {
    common::database_error(error)
}

fn user_not_found() -> ApiError {
    ApiError::new(404, "USER_NOT_FOUND", "The user does not exist")
}

/// Load `users.academy_progress_json` for a back-office user (the Prisma select).
async fn load_progress(state: &AppState, user_id: Uuid) -> Result<Option<Option<Value>>, ApiError> {
    sqlx::query("SELECT academy_progress_json FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pools.main)
        .await
        .map_err(database)?
        .map(|row| row.try_get::<Option<Value>, _>("academy_progress_json"))
        .transpose()
        .map_err(database)
}

/// `academyUser` + `USER_NOT_FOUND`.
async fn require_progress<'p>(
    state: &AppState,
    principal: Option<&'p Principal>,
) -> Result<(Uuid, &'p str, Option<Value>), ApiError> {
    let (user_id, role) = academy_user(principal)?;
    let parsed_id = Uuid::parse_str(user_id)
        .map_err(|_| ApiError::new(401, "AUTH_REQUIRED", "The session subject is invalid"))?;
    let Some(raw) = load_progress(state, parsed_id).await? else {
        return Err(user_not_found());
    };
    Ok((parsed_id, role, raw))
}

/// `GET /academy/progress`.
pub fn progress<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    respond(request, async move {
        let (_, _, raw) = require_progress(state, principal).await?;
        let catalog = catalog::catalog();
        let now = Utc::now();
        let parsed = parse_stored_progress(raw.as_ref(), catalog, now);
        let public = parsed.public_json(now);
        Ok(json!({ "progress": public, "rev": parsed.rev }))
    })
}

/// Extract a single path segment (`/prefix/<segment>/suffix`).
fn segment<'p>(path: &'p str, prefix: &str, suffix: &str) -> Option<&'p str> {
    path.strip_prefix(prefix)?.strip_suffix(suffix)
}

/// `GET /academy/exams/:examId/eligibility`.
pub fn eligibility<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    respond(request, async move {
        academy_user(principal)?;
        let exam_id = segment(
            request.path(),
            "/internal/admin/academy/exams/",
            "/eligibility",
        )
        .unwrap_or_default();
        if exam_id.is_empty() || exam_id.chars().count() > 64 {
            return Err(ApiError::new(400, "INVALID_BODY", "Invalid request data"));
        }
        let Some(blueprint) = catalog::blueprint(exam_id) else {
            return Err(ApiError::new(
                404,
                "ACADEMY_EXAM_NOT_FOUND",
                "The exam does not exist",
            ));
        };
        let (_, _, raw) = require_progress(state, principal).await?;
        let now = Utc::now();
        let catalog = catalog::catalog();
        let parsed = parse_stored_progress(raw.as_ref(), catalog, now);
        // A live session can always be resumed.
        if parsed.live_session(exam_id, now).is_some() {
            return Ok(json!({ "eligible": true, "missing": [] }));
        }
        Ok(compute_eligibility(&parsed, blueprint, catalog, now))
    })
}

/// The identity of an issued certificate.
struct CertificateRow {
    public_id: String,
    display_id: String,
    status: String,
}

/// `ensureAcademyCertificateForBadge`.
async fn ensure_certificate(
    state: &AppState,
    user_id: Uuid,
    track_id: &str,
    badge: &progress::Badge,
    holder_name: &str,
) -> Result<CertificateRow, ApiError> {
    let earned_ms = UtcMillis::parse_iso(&badge.earned_at).ok_or_else(|| {
        ApiError::new(
            400,
            "INVALID_BODY",
            "The badge has no valid earned timestamp",
        )
    })?;
    let expires_ms = UtcMillis::parse_iso(&badge.expires_at).ok_or_else(|| {
        ApiError::new(
            400,
            "INVALID_BODY",
            "The badge has no valid expiry timestamp",
        )
    })?;
    let earned_at =
        DateTime::<Utc>::from_timestamp_millis(earned_ms.as_millis()).ok_or_else(|| {
            ApiError::new(400, "INVALID_BODY", "The badge earned time is out of range")
        })?;
    let expires_at = DateTime::<Utc>::from_timestamp_millis(expires_ms.as_millis())
        .ok_or_else(|| ApiError::new(400, "INVALID_BODY", "The badge expiry is out of range"))?;

    if let Some(row) = find_certificate(state, user_id, track_id, earned_at).await? {
        return Ok(row);
    }

    let identity =
        CertificateIdentity::from_bytes(&certificate_public_bytes(), &certificate_display_bytes());
    identity.validate().map_err(|_| {
        ApiError::new(
            500,
            "SERVER_ERROR",
            "Could not allocate a unique Academy certificate identifier",
        )
    })?;
    let holder = holder_name.chars().take(120).collect::<String>();
    let content_version = badge.v.chars().take(20).collect::<String>();

    let mut transaction = state.pools.main.begin().await.map_err(database)?;
    sqlx::query(
        "UPDATE academy_certificates
            SET status = 'SUPERSEDED'::\"AcademyCertificateStatus\", updated_at = now()
          WHERE user_id = $1 AND track_id = $2
            AND status = 'ACTIVE'::\"AcademyCertificateStatus\"",
    )
    .bind(user_id)
    .bind(track_id)
    .execute(&mut *transaction)
    .await
    .map_err(database)?;
    let inserted = sqlx::query(
        "INSERT INTO academy_certificates
           (id, public_id, display_id, user_id, track_id, badge_code, holder_name, earned_at,
            expires_at, content_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, track_id, earned_at) DO NOTHING
         RETURNING public_id, display_id, status::text AS status",
    )
    .bind(Uuid::now_v7())
    .bind(&identity.public_id)
    .bind(&identity.display_id)
    .bind(user_id)
    .bind(track_id)
    .bind(&badge.id)
    .bind(&holder)
    .bind(earned_at)
    .bind(expires_at)
    .bind(&content_version)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database)?;
    let row = match inserted {
        Some(row) => row,
        None => sqlx::query(
            "SELECT public_id, display_id, status::text AS status
               FROM academy_certificates
              WHERE user_id = $1 AND track_id = $2 AND earned_at = $3",
        )
        .bind(user_id)
        .bind(track_id)
        .bind(earned_at)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database)?,
    };
    transaction.commit().await.map_err(database)?;
    Ok(CertificateRow {
        public_id: row.try_get("public_id").map_err(database)?,
        display_id: row.try_get("display_id").map_err(database)?,
        status: row.try_get("status").map_err(database)?,
    })
}

fn certificate_public_bytes() -> [u8; 24] {
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let mut bytes = [0_u8; 24];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(&second.as_bytes()[..8]);
    bytes
}

fn certificate_display_bytes() -> [u8; 4] {
    let uuid = Uuid::new_v4();
    [
        uuid.as_bytes()[0],
        uuid.as_bytes()[1],
        uuid.as_bytes()[2],
        uuid.as_bytes()[3],
    ]
}

async fn find_certificate(
    state: &AppState,
    user_id: Uuid,
    track_id: &str,
    earned_at: DateTime<Utc>,
) -> Result<Option<CertificateRow>, ApiError> {
    let row = sqlx::query(
        "SELECT public_id, display_id, status::text AS status
           FROM academy_certificates
          WHERE user_id = $1 AND track_id = $2 AND earned_at = $3",
    )
    .bind(user_id)
    .bind(track_id)
    .bind(earned_at)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database)?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(CertificateRow {
        public_id: row.try_get("public_id").map_err(database)?,
        display_id: row.try_get("display_id").map_err(database)?,
        status: row.try_get("status").map_err(database)?,
    }))
}

/// `GET /academy/certificates/:trackId/verification`.
pub fn certificate_verification<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    respond(request, async move {
        academy_user(principal)?;
        let track_id = segment(
            request.path(),
            "/internal/admin/academy/certificates/",
            "/verification",
        )
        .unwrap_or_default();
        if track_id.is_empty() || track_id.chars().count() > 64 {
            return Err(ApiError::new(400, "INVALID_BODY", "Invalid request data"));
        }
        let catalog = catalog::catalog();
        if !catalog.has_track(track_id) {
            return Err(ApiError::new(
                404,
                "ACADEMY_TRACK_NOT_FOUND",
                "The Academy track does not exist",
            ));
        }
        let (user_id, _, raw) = require_progress(state, principal).await?;
        let email: String = sqlx::query("SELECT email FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(database)?
            .map(|row| row.try_get::<String, _>("email"))
            .transpose()
            .map_err(database)?
            .ok_or_else(user_not_found)?;
        let now = Utc::now();
        let parsed = parse_stored_progress(raw.as_ref(), catalog, now);
        let Some(badge) = parsed
            .badges
            .iter()
            .find(|badge| badge.track == track_id)
            .cloned()
        else {
            return Err(ApiError::new(
                404,
                "CERTIFICATE_NOT_FOUND",
                "You have not earned a certificate for this track yet",
            ));
        };
        let holder_name = email
            .split('@')
            .next()
            .unwrap_or("Certified operator")
            .trim()
            .to_owned();
        let holder_name = if holder_name.is_empty() {
            "Certified operator".to_owned()
        } else {
            holder_name
        };
        let certificate =
            ensure_certificate(state, user_id, track_id, &badge, &holder_name).await?;
        Ok(json!({
            "certificateId": certificate.display_id,
            "displayId": certificate.display_id,
            "publicId": certificate.public_id,
            "status": certificate.status,
        }))
    })
}

/// The team rows (shared by the list and export).
async fn load_team(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT id, email, role::text AS role, is_maker, is_checker, academy_progress_json
           FROM users
          WHERE merchant_id IS NULL AND status::text <> 'DISABLED'
          ORDER BY email ASC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database)?;
    let now = Utc::now();
    let catalog = catalog::catalog();
    let users: Vec<TeamUser> = rows
        .iter()
        .map(|row| -> Result<TeamUser, sqlx::Error> {
            let raw: Option<Value> = row.try_get("academy_progress_json")?;
            Ok(TeamUser {
                id: row.try_get::<Uuid, _>("id")?.to_string(),
                email: row.try_get("email")?,
                role: row.try_get("role")?,
                is_maker: row.try_get("is_maker")?,
                is_checker: row.try_get("is_checker")?,
                progress: parse_stored_progress(raw.as_ref(), catalog, now),
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)?;
    Ok(build_team(&users, catalog, now))
}

/// `GET /academy/team`.
pub fn team<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    respond(request, async move {
        let (_, role) = academy_user(principal)?;
        require_security_admin(role, "Only security administrators can open the team view")?;
        load_team(state).await
    })
}

/// `GET /academy/team/export`.
pub fn team_export<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    respond(request, async move {
        let (_, role) = academy_user(principal)?;
        require_security_admin(
            role,
            "Only security administrators can export the team view",
        )?;
        let query = Query::parse(request.query_string());
        let checklist: Vec<&str> = query
            .get("checklist")
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| EXPORT_CHECKLIST.contains(entry))
                    .collect()
            })
            .unwrap_or_default();
        let mut body = load_team(state).await?;
        if let Some(object) = body.as_object_mut() {
            object.insert(
                "exportedAt".to_owned(),
                json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
            );
            object.insert("checklist".to_owned(), json!(checklist));
        }
        Ok(body)
    })
}
