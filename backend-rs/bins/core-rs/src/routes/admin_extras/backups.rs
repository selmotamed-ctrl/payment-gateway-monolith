//! Admin backup overview and catalog reads.
//!
//! Ports `core-back/api/internal/backups.ts:236` (`GET /overview`) and `:580` (`GET /catalog`).
//! The overview asks the backup daemon (`GET /v1/overview`) and, when it answers, upserts the run
//! and drill rows into the local catalog exactly like `syncDaemonCatalog`; when the daemon is
//! absent the route still answers with the local catalog and the TS fallbacks (`engineMode:"none"`,
//! empty WAL, default policy). The catalog route only reads the local tables.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};

use pg_http::ApiError;

use crate::state::AppState;

use super::backup_client;
use super::support::{col_i32, col_opt_i32, col_opt_text, database_error, date_iso, object};

const DEFAULT_POLICY: &str = "{\"fullCron\":\"0 2 * * 0\",\"deltaCron\":\"0 2 * * 1-6\",\"drillCron\":\"0 4 * * 0\",\"fullRetentionDays\":56,\"walRetentionDays\":14,\"alertLagSeconds\":300}";

fn default_policy() -> Value {
    serde_json::from_str(DEFAULT_POLICY).unwrap_or(Value::Null)
}

fn empty_wal() -> Value {
    json!({
        "archiveLagSeconds": 0,
        "currentLsn": "",
        "lastArchivedLsn": "",
        "lagBytes": 0,
    })
}

fn parse_instant(value: &Value) -> Option<DateTime<Utc>> {
    value
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn local_run(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let mut map = Map::new();
    map.insert(
        "id".to_owned(),
        Value::String(super::support::col_uuid(row, "id")?),
    );
    map.insert(
        "target".to_owned(),
        Value::String(super::support::col_text(row, "target")?),
    );
    map.insert(
        "kind".to_owned(),
        Value::String(super::support::col_text(row, "kind")?),
    );
    map.insert(
        "engine".to_owned(),
        Value::String(super::support::col_text(row, "engine")?),
    );
    map.insert(
        "status".to_owned(),
        Value::String(super::support::col_text(row, "status")?),
    );
    map.insert(
        "startedAt".to_owned(),
        Value::String(super::support::col_timestamptz(row, "started_at")?),
    );
    if let Some(value) = super::support::col_opt_timestamptz(row, "completed_at")? {
        map.insert("completedAt".to_owned(), Value::String(value));
    }
    if let Some(value) = col_opt_i32(row, "duration_ms")? {
        map.insert("durationMs".to_owned(), Value::from(value));
    }
    if let Some(value) = super::support::col_opt_i64(row, "size_bytes")? {
        map.insert("sizeBytes".to_owned(), pg_db::js_number_value(value as f64));
    }
    if let Some(value) = col_opt_text(row, "start_lsn")? {
        if !value.is_empty() {
            map.insert("startLsn".to_owned(), Value::String(value));
        }
    }
    if let Some(value) = col_opt_text(row, "end_lsn")? {
        if !value.is_empty() {
            map.insert("endLsn".to_owned(), Value::String(value));
        }
    }
    if let Some(value) = col_opt_text(row, "error_message")? {
        if !value.is_empty() {
            map.insert("errorMessage".to_owned(), Value::String(value));
        }
    }
    Ok(Value::Object(map))
}

fn local_drill(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let status = super::support::col_text(row, "status")?;
    let started_at = super::support::col_timestamptz(row, "started_at")?;
    let completed_at = super::support::col_opt_timestamptz(row, "completed_at")?
        .unwrap_or_else(|| started_at.clone());
    let target_time = super::support::col_opt_timestamptz(row, "target_time")?
        .unwrap_or_else(|| started_at.clone());
    let checkpoints: Value = super::support::col_json(row, "checkpoints_json")?;
    let checks = checkpoints
        .get("checks")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| {
            let ok = status == "PASSED";
            json!({
                "doubleEntry": { "ok": ok, "detail": "" },
                "balanceParity": { "ok": ok, "detail": "" },
                "auditChain": { "ok": ok, "detail": "" },
            })
        });
    let drift = super::support::col_decimal(row, "double_entry_drift")?;
    let mut map = Map::new();
    map.insert(
        "id".to_owned(),
        Value::String(super::support::col_uuid(row, "id")?),
    );
    map.insert("status".to_owned(), Value::String(status));
    map.insert("startedAt".to_owned(), Value::String(started_at));
    map.insert("completedAt".to_owned(), Value::String(completed_at));
    map.insert(
        "durationMs".to_owned(),
        Value::from(col_opt_i32(row, "duration_ms")?.unwrap_or(0)),
    );
    map.insert("targetTime".to_owned(), Value::String(target_time));
    map.insert(
        "replayedLsn".to_owned(),
        Value::String(col_opt_text(row, "replayed_lsn")?.unwrap_or_default()),
    );
    map.insert(
        "doubleEntryDrift".to_owned(),
        Value::String(pg_types::DecimalJs(drift).to_string()),
    );
    map.insert(
        "balanceMismatches".to_owned(),
        Value::from(col_i32(row, "balance_mismatches")?),
    );
    map.insert(
        "auditBrokenLinks".to_owned(),
        Value::from(col_i32(row, "audit_broken_links")?),
    );
    map.insert(
        "journalLineCount".to_owned(),
        pg_db::js_number_value(super::support::col_i64(row, "journal_line_count")? as f64),
    );
    map.insert("checks".to_owned(), checks);
    if let Some(value) = col_opt_text(row, "error_message")? {
        if !value.is_empty() {
            map.insert("errorMessage".to_owned(), Value::String(value));
        }
    }
    if let Some(value) = col_opt_text(row, "report_signature")? {
        if !value.is_empty() {
            map.insert("reportSignature".to_owned(), Value::String(value));
        }
    }
    Ok(Value::Object(map))
}

async fn local_runs(state: &AppState) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, target, kind, engine, status, started_at, completed_at, duration_ms,
                size_bytes, start_lsn, end_lsn, error_message
           FROM backup_catalog_runs ORDER BY started_at DESC LIMIT 30",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    rows.iter().map(local_run).collect()
}

async fn local_drills(state: &AppState) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, status, started_at, completed_at, duration_ms, target_time, replayed_lsn,
                double_entry_drift, balance_mismatches, audit_broken_links, journal_line_count,
                checkpoints_json, error_message, report_signature
           FROM backup_restore_drills ORDER BY started_at DESC LIMIT 10",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    rows.iter().map(local_drill).collect()
}

/// `syncDaemonCatalog`: mirror the daemon's runs and drills into the local catalog.
async fn sync_daemon_catalog(state: &AppState, overview: &Value) -> Result<(), ApiError> {
    if let Some(runs) = overview.get("backups").and_then(Value::as_array) {
        for run in runs {
            let Some(id) = run.get("id").and_then(Value::as_str) else {
                return Err(ApiError::server_error());
            };
            let started_at = run
                .get("startedAt")
                .and_then(parse_instant)
                .ok_or_else(ApiError::server_error)?;
            let completed_at = run.get("completedAt").and_then(parse_instant);
            let storage_targets = run
                .get("storageTargets")
                .cloned()
                .unwrap_or_else(|| json!([]));
            sqlx::query(
                "INSERT INTO backup_catalog_runs
                   (id, target, kind, engine, status, started_at, completed_at, duration_ms,
                    size_bytes, start_lsn, end_lsn, storage_targets, error_message, created_at)
                 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, now())
                 ON CONFLICT (id) DO UPDATE SET
                   target = EXCLUDED.target, kind = EXCLUDED.kind, engine = EXCLUDED.engine,
                   status = EXCLUDED.status, started_at = EXCLUDED.started_at,
                   completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms,
                   size_bytes = EXCLUDED.size_bytes, start_lsn = EXCLUDED.start_lsn,
                   end_lsn = EXCLUDED.end_lsn, storage_targets = EXCLUDED.storage_targets,
                   error_message = EXCLUDED.error_message",
            )
            .bind(id)
            .bind(required_text(run, "target")?)
            .bind(required_text(run, "kind")?)
            .bind(required_text(run, "engine")?)
            .bind(required_text(run, "status")?)
            .bind(started_at)
            .bind(completed_at)
            .bind(
                run.get("durationMs")
                    .and_then(Value::as_i64)
                    .map(|value| value as i32),
            )
            .bind(run.get("sizeBytes").and_then(Value::as_i64))
            .bind(run.get("startLsn").and_then(Value::as_str))
            .bind(run.get("endLsn").and_then(Value::as_str))
            .bind(storage_targets)
            .bind(run.get("errorMessage").and_then(Value::as_str))
            .execute(&state.pools.main)
            .await
            .map_err(database_error)?;
        }
    }
    if let Some(drills) = overview.get("drills").and_then(Value::as_array) {
        for drill in drills {
            let Some(id) = drill.get("id").and_then(Value::as_str) else {
                return Err(ApiError::server_error());
            };
            let started_at = drill
                .get("startedAt")
                .and_then(parse_instant)
                .ok_or_else(ApiError::server_error)?;
            let completed_at = drill
                .get("completedAt")
                .and_then(parse_instant)
                .unwrap_or(started_at);
            let target_time = drill
                .get("targetTime")
                .and_then(parse_instant)
                .unwrap_or(started_at);
            let drift = drill
                .get("doubleEntryDrift")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<rust_decimal::Decimal>().ok())
                .unwrap_or_default();
            let checks = json!({ "checks": drill.get("checks").cloned().unwrap_or(Value::Null) });
            sqlx::query(
                "INSERT INTO backup_restore_drills
                   (id, status, started_at, completed_at, duration_ms, target_time, replayed_lsn,
                    double_entry_drift, balance_mismatches, audit_broken_links, journal_line_count,
                    checkpoints_json, error_message, report_signature, created_at)
                 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, now())
                 ON CONFLICT (id) DO UPDATE SET
                   status = EXCLUDED.status, started_at = EXCLUDED.started_at,
                   completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms,
                   target_time = EXCLUDED.target_time, replayed_lsn = EXCLUDED.replayed_lsn,
                   double_entry_drift = EXCLUDED.double_entry_drift,
                   balance_mismatches = EXCLUDED.balance_mismatches,
                   audit_broken_links = EXCLUDED.audit_broken_links,
                   journal_line_count = EXCLUDED.journal_line_count,
                   checkpoints_json = EXCLUDED.checkpoints_json,
                   error_message = EXCLUDED.error_message,
                   report_signature = EXCLUDED.report_signature",
            )
            .bind(id)
            .bind(required_text(drill, "status")?)
            .bind(started_at)
            .bind(completed_at)
            .bind(drill.get("durationMs").and_then(Value::as_i64).map(|value| value as i32).unwrap_or(0))
            .bind(target_time)
            .bind(drill.get("replayedLsn").and_then(Value::as_str))
            .bind(drift)
            .bind(drill.get("balanceMismatches").and_then(Value::as_i64).unwrap_or(0) as i32)
            .bind(drill.get("auditBrokenLinks").and_then(Value::as_i64).unwrap_or(0) as i32)
            .bind(drill.get("journalLineCount").and_then(Value::as_i64).unwrap_or(0))
            .bind(checks)
            .bind(drill.get("errorMessage").and_then(Value::as_str))
            .bind(drill.get("reportSignature").and_then(Value::as_str))
            .execute(&state.pools.main)
            .await
            .map_err(database_error)?;
        }
    }
    Ok(())
}

fn required_text(value: &Value, key: &str) -> Result<String, ApiError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(ApiError::server_error)
}

/// `GET /internal/admin/system/backups/overview` (`backups.ts:236`).
pub(crate) async fn overview(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let configured = backup_client::is_configured();
    let daemon = if configured {
        Some(match backup_client::overview().await {
            Ok(overview) => Ok(overview),
            Err(error) => Err(error),
        })
    } else {
        None
    };
    let (daemon_value, daemon_error) = match daemon {
        Some(Ok(value)) => (Some(value), None),
        Some(Err(error)) => (None, Some(error)),
        None => (None, Some("BACKUP_DAEMON_NOT_CONFIGURED".to_owned())),
    };
    if let Some(value) = &daemon_value {
        sync_daemon_catalog(state, value).await?;
    }
    let daemon_reachable = daemon_value.is_some();
    let runs = local_runs(state).await?;
    let drills = local_drills(state).await?;

    let now = date_iso(Utc::now());
    let overview = daemon_value.unwrap_or(Value::Null);
    let policy = overview
        .get("policy")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(default_policy);
    let alert_lag = policy
        .get("alertLagSeconds")
        .and_then(Value::as_f64)
        .unwrap_or(300.0);
    let healthy = overview
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let archive_lag = overview
        .get("wal")
        .and_then(|wal| wal.get("archiveLagSeconds"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let wal = overview
        .get("wal")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(empty_wal);
    let latest_drill = overview
        .get("latestDrill")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| drills.first().cloned())
        .unwrap_or(Value::Null);
    let mut response = Map::new();
    response.insert("configured".to_owned(), Value::Bool(configured));
    response.insert("daemonReachable".to_owned(), Value::Bool(daemon_reachable));
    if let Some(error) = daemon_error {
        response.insert("daemonError".to_owned(), Value::String(error));
    }
    response.insert(
        "generatedAt".to_owned(),
        overview
            .get("generatedAt")
            .filter(|value| value.is_string())
            .cloned()
            .unwrap_or(Value::String(now)),
    );
    response.insert(
        "engineMode".to_owned(),
        overview
            .get("engineMode")
            .cloned()
            .unwrap_or_else(|| Value::String("none".to_owned())),
    );
    response.insert("healthy".to_owned(), Value::Bool(healthy));
    response.insert("wal".to_owned(), wal);
    response.insert(
        "walArchiveHealthy".to_owned(),
        Value::Bool(healthy && archive_lag <= alert_lag),
    );
    response.insert(
        "targets".to_owned(),
        overview
            .get("targets")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    response.insert(
        "schedule".to_owned(),
        overview
            .get("schedule")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(default_policy),
    );
    response.insert("policy".to_owned(), policy);
    response.insert(
        "backups".to_owned(),
        overview
            .get("backups")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(runs.clone())),
    );
    response.insert("latestDrill".to_owned(), latest_drill);
    response.insert(
        "drills".to_owned(),
        overview
            .get("drills")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(drills.clone())),
    );
    response.insert(
        "localCatalog".to_owned(),
        object(vec![
            ("backups", Value::Array(runs)),
            ("drills", Value::Array(drills)),
        ]),
    );
    Ok(Value::Object(response))
}

/// `GET /internal/admin/system/backups/catalog` (`backups.ts:580`).
pub(crate) async fn catalog(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let runs = local_runs(state).await?;
    let drills = local_drills(state).await?;
    Ok(object(vec![
        ("runs", Value::Array(runs)),
        ("drills", Value::Array(drills)),
    ]))
}
