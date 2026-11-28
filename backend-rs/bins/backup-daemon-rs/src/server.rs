//! HTTP contract of the backup daemon: `/health`, `/v1/overview`, trigger, policy, runs, drills and
//! `PUT /v1/wal/:target/:file`. Port of `deploy/backup-daemon/src/server.ts`.
//!
//! The router is a pure function over [`RouteRequest`] so every route is unit-testable without a
//! socket, exactly like the TypeScript `handler(req, res)` bundle. The mTLS front classifies the
//! peer certificate into a role (control or WAL) before any routing happens; the WAL role can only
//! upload WAL and the control role can do everything except upload WAL.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, SecondsFormat, Utc};
use ntex::http::StatusCode;
use ntex::web::{App, HttpRequest, HttpResponse, HttpServer};
use ntex::SharedCfg;
use ntex_tls::PeerCertDer;
use serde_json::{json, Value};

use crate::catalog::{BackupRun, CatalogStore, RunPatch};
use crate::command_runner::BoxFuture;
use crate::config::{parse_csv, Config};
use crate::cron::is_valid_cron_expression;
use crate::drill::{sign_drill_report, DrillReport, DrillRunOptions, DrillRunner};
use crate::engine::{engine_failure_health, BackupEngine, BackupKind, BackupTarget, EngineError};
use crate::job_queue::{JobKind, JobQueue, JobSpec, QueueFullError};
use crate::scheduler::BackupScheduler;

const MAX_JSON_BODY_BYTES: usize = 256 * 1024;
const IDEMPOTENCY_KEY_MAX: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerRole {
    /// `backup-client`: every route except WAL ingest.
    Control,
    /// `wal-archive-client`: ONLY `PUT /v1/wal/...`.
    Wal,
    /// Plain-HTTP development mode (no identity, every route reachable).
    Open,
}

pub struct RouteRequest {
    pub role: CallerRole,
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl RouteRequest {
    #[must_use]
    pub fn new(method: &str, path: &str) -> Self {
        Self {
            role: CallerRole::Open,
            method: method.to_owned(),
            path: path.to_owned(),
            query: String::new(),
            headers: BTreeMap::new(),
            body: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_role(mut self, role: CallerRole) -> Self {
        self.role = role;
        self
    }

    #[must_use]
    pub fn with_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    #[must_use]
    pub fn with_query(mut self, query: &str) -> Self {
        self.query = query.to_owned();
        self
    }

    #[must_use]
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers
            .insert(name.to_ascii_lowercase(), value.to_owned());
        self
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub struct RouteResponse {
    pub status: StatusCode,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RouteResponse {
    fn json(status: StatusCode, value: Value) -> Self {
        Self {
            status,
            headers: vec![(
                "content-type".to_owned(),
                "application/json; charset=utf-8".to_owned(),
            )],
            body: value.to_string().into_bytes(),
        }
    }

    #[must_use]
    pub fn json_value(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }

    #[must_use]
    pub fn into_http(self) -> HttpResponse {
        let mut builder = HttpResponse::builder(self.status);
        for (name, value) in self.headers {
            builder.header(name, value);
        }
        builder.body(self.body)
    }
}

pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;
pub type SyncObjectStorage = Arc<dyn Fn() -> BoxFuture<'static, Vec<String>> + Send + Sync>;

pub struct ServerOptions {
    pub config: Arc<Config>,
    pub engine: Arc<dyn BackupEngine>,
    pub drill_runner: Arc<dyn DrillRunner>,
    pub catalog: Arc<CatalogStore>,
    pub jobs: Arc<JobQueue>,
    pub scheduler: Option<Arc<BackupScheduler>>,
    pub clock: Clock,
    pub id_factory: Arc<dyn Fn() -> String + Send + Sync>,
    pub version: String,
    pub sync_object_storage: Option<SyncObjectStorage>,
}

impl ServerOptions {
    #[must_use]
    pub fn new(
        config: Arc<Config>,
        engine: Arc<dyn BackupEngine>,
        drill_runner: Arc<dyn DrillRunner>,
        catalog: Arc<CatalogStore>,
        jobs: Arc<JobQueue>,
        clock: Clock,
    ) -> Self {
        Self {
            config,
            engine,
            drill_runner,
            catalog,
            jobs,
            scheduler: None,
            clock,
            id_factory: Arc::new(|| uuid::Uuid::new_v4().to_string()),
            version: crate::DAEMON_VERSION.to_owned(),
            sync_object_storage: None,
        }
    }
}

struct HttpError {
    status: StatusCode,
    code: String,
    message: String,
}

impl HttpError {
    fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "validation_error", message)
    }
}

pub struct HandlerState {
    pub options: ServerOptions,
    issued_ids: Mutex<BTreeSet<String>>,
    secret_values: Vec<String>,
    require_mtls: bool,
    /// Per-idempotency-key serialization: lookup + catalog insert + enqueue must be atomic.
    idempotency_locks: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl HandlerState {
    #[must_use]
    pub fn new(options: ServerOptions) -> Self {
        let snapshot = options.catalog.snapshot();
        let mut issued_ids = BTreeSet::new();
        for run in snapshot.runs {
            issued_ids.insert(run.id);
        }
        for drill in snapshot.drills {
            issued_ids.insert(drill.id);
        }
        let secret_values = options.config.secret_values();
        // Fail closed: a broken/incomplete TLS configuration must never look like plain HTTP.
        let require_mtls = match options.config.tls_paths() {
            Ok(paths) => paths.is_some(),
            Err(_) => true,
        };
        Self {
            options,
            issued_ids: Mutex::new(issued_ids),
            secret_values,
            require_mtls,
            idempotency_locks: Mutex::new(BTreeMap::new()),
        }
    }

    fn config(&self) -> &Arc<Config> {
        &self.options.config
    }

    pub async fn when_idle(&self) {
        self.options.jobs.when_idle().await;
    }

    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.options.jobs.queued_count() + usize::from(self.options.jobs.active_job().is_some())
    }

    fn reserve_id(&self) -> Result<String, HttpError> {
        let mut issued = self
            .issued_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for _attempt in 0..20 {
            let id = (self.options.id_factory)();
            if !id.is_empty() && !issued.contains(&id) {
                issued.insert(id.clone());
                return Ok(id);
            }
        }
        Err(HttpError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "id_generation_failed",
            "unable to allocate a unique identifier",
        ))
    }

    fn idempotency_guard(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .idempotency_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Bound the map: completed keys have no waiter left (strong_count == 1).
        if locks.len() >= 2048 {
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        Arc::clone(
            locks
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    fn safe_message(&self, message: &str) -> String {
        crate::config::redact_text(message, &self.secret_values)
            .chars()
            .take(2000)
            .collect()
    }

    fn respond(
        &self,
        request_id: &str,
        data: Value,
        status: StatusCode,
        extra: Vec<(String, String)>,
    ) -> RouteResponse {
        let redacted = crate::config::redact_sensitive_data(&data, &self.secret_values);
        let mut headers = vec![
            (
                "content-type".to_owned(),
                "application/json; charset=utf-8".to_owned(),
            ),
            ("x-request-id".to_owned(), request_id.to_owned()),
            ("cache-control".to_owned(), "no-store".to_owned()),
        ];
        headers.extend(extra);
        RouteResponse {
            status,
            headers,
            body: redacted.to_string().into_bytes(),
        }
    }
}

pub struct BackupDaemonHandler {
    state: Arc<HandlerState>,
}

impl BackupDaemonHandler {
    #[must_use]
    pub fn new(options: ServerOptions) -> Self {
        Self {
            state: Arc::new(HandlerState::new(options)),
        }
    }

    #[must_use]
    pub fn state(&self) -> Arc<HandlerState> {
        Arc::clone(&self.state)
    }

    pub async fn handle(&self, request: RouteRequest) -> RouteResponse {
        handle(&self.state, request).await
    }
}

fn ok_status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn request_id(request: &RouteRequest) -> String {
    match request.header("x-request-id") {
        Some(value) if valid_request_id(value) => value.trim().to_owned(),
        _ => uuid::Uuid::new_v4().to_string(),
    }
}

fn valid_request_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 128
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn idempotency_key_of(request: &RouteRequest) -> Result<Option<String>, HttpError> {
    let Some(raw) = request.header("idempotency-key").map(str::trim) else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > IDEMPOTENCY_KEY_MAX
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_idempotency_key",
            "Idempotency-Key must be 1-128 characters of [A-Za-z0-9._:-]",
        ));
    }
    Ok(Some(raw.to_owned()))
}

fn read_json_body(request: &RouteRequest) -> Result<Value, HttpError> {
    if let Some(declared) = request
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
    {
        if declared > MAX_JSON_BODY_BYTES as u64 {
            return Err(HttpError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "request body exceeds the maximum size",
            ));
        }
    }
    if request.body.len() > MAX_JSON_BODY_BYTES {
        return Err(HttpError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "request body exceeds the maximum size",
        ));
    }
    let text = std::str::from_utf8(&request.body).map_err(|_| {
        HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "request body could not be read",
        )
    })?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(text).map_err(|_| {
        HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "request body must be valid JSON",
        )
    })
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(value.to_owned());
        }
    }
    None
}

fn parse_limit(query: &str, fallback: usize) -> Result<usize, HttpError> {
    let Some(raw) = query_param(query, "limit") else {
        return Ok(fallback);
    };
    match raw.parse::<i64>() {
        Ok(value) if (1..=500).contains(&value) => Ok(value as usize),
        _ => Err(HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_limit",
            "limit must be an integer between 1 and 500",
        )),
    }
}

fn require_method(request: &RouteRequest, allowed: &str) -> Result<(), HttpError> {
    if request.method.eq_ignore_ascii_case(allowed) {
        return Ok(());
    }
    Err(HttpError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        format!(
            "{} is not allowed for {}",
            request.method,
            normalized_path(request)
        ),
    ))
}

fn normalized_path(request: &RouteRequest) -> String {
    let path = request.path.as_str();
    if path.is_empty() {
        return "/".to_owned();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `/v1/wal/<target>/<file>` (the TS `WAL_ROUTE` regex).
fn wal_route(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/v1/wal/")?;
    let (target, file) = rest.split_once('/')?;
    if target.is_empty() || file.is_empty() || file.contains('/') {
        return None;
    }
    if !target
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return None;
    }
    Some((target.to_owned(), percent_decode(file)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(decoded) = u8::from_str_radix(hex, 16) {
                    output.push(decoded);
                    index += 3;
                    continue;
                }
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn validate_trigger(
    value: &Value,
) -> Result<(BackupTarget, BackupKind, Option<String>), HttpError> {
    let target = value
        .get("target")
        .and_then(Value::as_str)
        .and_then(BackupTarget::parse)
        .ok_or_else(|| HttpError::validation("target: Invalid option"))?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .and_then(BackupKind::parse)
        .ok_or_else(|| HttpError::validation("kind: Invalid option"))?;
    let requested_by = match value.get("requestedBy") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.len() > 200 {
                return Err(HttpError::validation(
                    "requestedBy: must be 1-200 characters",
                ));
            }
            Some(trimmed.to_owned())
        }
        Some(_) => return Err(HttpError::validation("requestedBy: must be a string")),
    };
    Ok((target, kind, requested_by))
}

type DrillValidation = (Option<DateTime<Utc>>, bool, Option<String>);

fn validate_drill(value: &Value, now: DateTime<Utc>) -> Result<DrillValidation, HttpError> {
    let requested_by = match value.get("requestedBy") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.len() > 200 {
                return Err(HttpError::validation(
                    "requestedBy: must be 1-200 characters",
                ));
            }
            Some(trimmed.to_owned())
        }
        Some(_) => return Err(HttpError::validation("requestedBy: must be a string")),
    };
    let latest = match value.get("latest") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(HttpError::validation("latest: must be a boolean")),
    };
    let target_time = match value.get("targetTime") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.len() > 40 {
                return Err(HttpError::validation("targetTime: must be 1-40 characters"));
            }
            let parsed = DateTime::parse_from_rfc3339(trimmed)
                .map_err(|_| HttpError::validation("targetTime must be an ISO-8601 timestamp"))?;
            Some(parsed.with_timezone(&Utc))
        }
        Some(_) => return Err(HttpError::validation("targetTime: must be a string")),
    };
    if latest && target_time.is_some() {
        return Err(HttpError::validation(
            "latest and targetTime are mutually exclusive",
        ));
    }
    if let Some(target_time) = target_time {
        if target_time > now {
            return Err(HttpError::validation("targetTime cannot be in the future"));
        }
    }
    Ok((target_time, latest, requested_by))
}

fn validate_policy(value: &Value) -> Result<PolicyUpdate, HttpError> {
    let cron = |field: &str| -> Result<String, HttpError> {
        let text = value
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| {
                HttpError::validation(format!("{field}: must be a five-field cron expression"))
            })?;
        if !is_valid_cron_expression(text) {
            return Err(HttpError::validation(format!(
                "{field}: must be a five-field cron expression"
            )));
        }
        Ok(text.to_owned())
    };
    let integer = |field: &str, max: i64| -> Result<u32, HttpError> {
        let number = value
            .get(field)
            .and_then(|entry| {
                entry
                    .as_i64()
                    .or_else(|| entry.as_str().and_then(|text| text.trim().parse().ok()))
            })
            .ok_or_else(|| HttpError::validation(format!("{field}: must be an integer")))?;
        if !(1..=max).contains(&number) {
            return Err(HttpError::validation(format!(
                "{field}: must be between 1 and {max}"
            )));
        }
        Ok(number as u32)
    };
    let updated_by = match value.get("updatedBy") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.len() > 200 {
                return Err(HttpError::validation("updatedBy: must be 1-200 characters"));
            }
            Some(trimmed.to_owned())
        }
        Some(_) => return Err(HttpError::validation("updatedBy: must be a string")),
    };
    Ok(PolicyUpdate {
        full_cron: cron("fullCron")?,
        delta_cron: cron("deltaCron")?,
        drill_cron: cron("drillCron")?,
        full_retention_days: integer("fullRetentionDays", 3650)?,
        wal_retention_days: integer("walRetentionDays", 3650)?,
        alert_lag_seconds: integer("alertLagSeconds", 86_400)?,
        updated_by,
    })
}

struct PolicyUpdate {
    full_cron: String,
    delta_cron: String,
    drill_cron: String,
    full_retention_days: u32,
    wal_retention_days: u32,
    alert_lag_seconds: u32,
    updated_by: Option<String>,
}

pub async fn handle(state: &Arc<HandlerState>, request: RouteRequest) -> RouteResponse {
    let request_id = request_id(&request);
    let path = normalized_path(&request);
    let wal_match = wal_route(&path);
    let method = request.method.to_ascii_uppercase();

    let outcome: Result<RouteResponse, HttpError> = async {
        // Role gating happens before routing, exactly like the TS gateway's two inner servers.
        if request.role == CallerRole::Wal && wal_match.is_none() {
            return Err(HttpError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "this client certificate may only upload WAL",
            ));
        }
        if request.role == CallerRole::Control && wal_match.is_some() {
            return Err(HttpError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "WAL upload requires the WAL archive client certificate",
            ));
        }

        if path == "/health" {
            require_method(&request, "GET")?;
            return Ok(state.respond(
                &request_id,
                json!({
                    "status": "ok",
                    "engineMode": state.config().engine_mode,
                    "version": state.options.version,
                }),
                StatusCode::OK,
                Vec::new(),
            ));
        }

        if let Some((target, file)) = wal_match {
            require_method(&request, "PUT")?;
            if !state.options.engine.supports_wal_ingest() {
                return Err(HttpError::new(
                    StatusCode::NOT_IMPLEMENTED,
                    "wal_push_not_supported",
                    format!(
                        "engine {} does not accept WAL uploads",
                        state.config().engine_mode
                    ),
                ));
            }
            if request.body.is_empty() {
                return Err(HttpError::new(
                    StatusCode::BAD_REQUEST,
                    "empty_wal_file",
                    "empty WAL upload",
                ));
            }
            let declared = request
                .header("content-length")
                .filter(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                })
                .and_then(|value| value.parse::<u64>().ok());
            return match state
                .options
                .engine
                .ingest_wal(&target, &file, request.body.clone(), declared)
                .await
            {
                Ok(outcome) => Ok(state.respond(
                    &request_id,
                    json!({
                        "status": outcome.status,
                        "key": outcome.key,
                        "bytes": outcome.bytes,
                    }),
                    StatusCode::OK,
                    Vec::new(),
                )),
                Err(EngineError::Wal(error)) => Err(HttpError::new(
                    ok_status(error.status),
                    error.code,
                    error.message,
                )),
                Err(error) => Err(HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    state.safe_message(&error.to_string()),
                )),
            };
        }

        if path == "/v1/overview" {
            require_method(&request, "GET")?;
            let health = match state.options.engine.overview_health().await {
                Ok(health) => health,
                Err(error) => engine_failure_health(&state.safe_message(&error.to_string())),
            };
            let policy = state.options.catalog.get_policy();
            let backups = state.options.catalog.list_runs(30);
            let drills = state.options.catalog.list_drills(10);
            let latest_drill = state.options.catalog.latest_drill();
            let scheduler = state
                .options
                .scheduler
                .as_ref()
                .map(|scheduler| scheduler.get_state())
                .unwrap_or(crate::scheduler::SchedulerState {
                    enabled: false,
                    next_full_at: None,
                    next_delta_at: None,
                    next_drill_at: None,
                });
            let active = state
                .options
                .jobs
                .active_job()
                .map(|(id, kind)| json!({"id": id, "kind": kind.as_str()}));
            let mut body = json!({
                "generatedAt": (state.options.clock)().to_rfc3339_opts(SecondsFormat::Millis, true),
                "engineMode": state.config().engine_mode,
                "healthy": health.healthy,
                "wal": health.wal,
                "targets": health.targets,
                "schedule": {
                    "fullCron": policy.full_cron,
                    "deltaCron": policy.delta_cron,
                    "drillCron": policy.drill_cron,
                    "fullRetentionDays": policy.full_retention_days,
                    "walRetentionDays": policy.wal_retention_days,
                    "alertLagSeconds": policy.alert_lag_seconds,
                },
                "policy": policy,
                "scheduler": scheduler,
                "backups": backups,
                "latestDrill": latest_drill,
                "drills": drills,
                "jobs": {
                    "active": active,
                    "queued": state.options.jobs.queued_count(),
                },
            });
            if let Some(wal_status) = state.options.engine.wal_status() {
                if let Value::Object(map) = &mut body {
                    map.insert("walArchive".to_owned(), wal_status);
                }
            }
            return Ok(state.respond(&request_id, body, StatusCode::OK, Vec::new()));
        }

        if path == "/v1/backups/trigger" {
            require_method(&request, "POST")?;
            let value = read_json_body(&request)?;
            let (target, kind, _requested_by) = validate_trigger(&value)?;
            let idempotency_key = idempotency_key_of(&request)?;
            // Hold the same-key guard across the catalog write and the enqueue, so two concurrent
            // retries cannot both allocate a run.
            let guard = idempotency_key
                .as_ref()
                .map(|key| state.idempotency_guard(key));
            let _guard = match &guard {
                Some(guard) => Some(guard.lock().await),
                None => None,
            };
            if let Some(key) = &idempotency_key {
                if let Some((id, accepted_at)) = state.options.jobs.lookup_key("backup", key) {
                    return Ok(state.respond(
                        &request_id,
                        json!({
                            "backupJobId": id,
                            "acceptedAt": accepted_at,
                            "deduplicated": true,
                        }),
                        StatusCode::ACCEPTED,
                        Vec::new(),
                    ));
                }
            }
            let accepted_at = (state.options.clock)().to_rfc3339_opts(SecondsFormat::Millis, true);
            let id = state.reserve_id()?;
            state
                .options
                .catalog
                .add_run(BackupRun {
                    id: id.clone(),
                    target: target.as_str().to_owned(),
                    kind: kind.as_str().to_owned(),
                    engine: state.config().engine_mode.clone(),
                    status: "QUEUED".to_owned(),
                    started_at: accepted_at.clone(),
                    completed_at: None,
                    duration_ms: None,
                    size_bytes: None,
                    start_lsn: None,
                    end_lsn: None,
                    storage_targets: Vec::new(),
                    error_message: None,
                })
                .await;

            // Two requests with the same key can never both get past the lookup above: nothing awaits
            // between it and `enqueue`.
            let job_id = id.clone();
            let response_id = job_id.clone();
            let catalog = Arc::clone(&state.options.catalog);
            let engine = Arc::clone(&state.options.engine);
            let clock = Arc::clone(&state.options.clock);
            let sync = state.options.sync_object_storage.clone();
            let secrets = state.secret_values.clone();
            let ticket = state.options.jobs.enqueue(JobSpec {
                id,
                kind: JobKind::Backup,
                scope: Some("backup".to_owned()),
                idempotency_key: idempotency_key.clone(),
                run: Box::pin(async move {
                    let started_ms = (clock)().timestamp_millis();
                    let _ = catalog
                        .update_run(
                            &job_id,
                            RunPatch {
                                status: Some("RUNNING".to_owned()),
                                ..RunPatch::default()
                            },
                        )
                        .await;
                    match engine.trigger_backup(target, kind).await {
                        Ok(mut result) => {
                            if let Some(sync) = sync {
                                result.storage_targets.extend(sync().await);
                            }
                            let completed = (clock)();
                            let _ = catalog
                                .update_run(
                                    &job_id,
                                    RunPatch {
                                        status: Some("PASSED".to_owned()),
                                        completed_at: Some(
                                            completed.to_rfc3339_opts(SecondsFormat::Millis, true),
                                        ),
                                        duration_ms: Some(
                                            completed
                                                .timestamp_millis()
                                                .saturating_sub(started_ms)
                                                .max(0)
                                                as u64,
                                        ),
                                        size_bytes: result.size_bytes,
                                        start_lsn: result.start_lsn,
                                        end_lsn: result.end_lsn,
                                        storage_targets: Some(result.storage_targets),
                                        error_message: None,
                                    },
                                )
                                .await;
                        }
                        Err(error) => {
                            let completed = (clock)();
                            let message = crate::config::redact_text(&error.to_string(), &secrets)
                                .chars()
                                .take(2000)
                                .collect::<String>();
                            let _ = catalog
                                .update_run(
                                    &job_id,
                                    RunPatch {
                                        status: Some("FAILED".to_owned()),
                                        completed_at: Some(
                                            completed.to_rfc3339_opts(SecondsFormat::Millis, true),
                                        ),
                                        duration_ms: Some(
                                            completed
                                                .timestamp_millis()
                                                .saturating_sub(started_ms)
                                                .max(0)
                                                as u64,
                                        ),
                                        storage_targets: Some(Vec::new()),
                                        error_message: Some(message),
                                        ..RunPatch::default()
                                    },
                                )
                                .await;
                        }
                    }
                }),
            });
            let ticket = match ticket {
                Ok(ticket) => ticket,
                Err(QueueFullError { limit }) => {
                    let _ = state
                        .options
                        .catalog
                        .update_run(
                            &response_id,
                            RunPatch {
                                status: Some("FAILED".to_owned()),
                                completed_at: Some(
                                    (state.options.clock)()
                                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                                ),
                                error_message: Some(format!(
                                    "the job queue is full ({limit} jobs waiting); retry later"
                                )),
                                ..RunPatch::default()
                            },
                        )
                        .await;
                    return Err(HttpError::new(
                        StatusCode::TOO_MANY_REQUESTS,
                        "queue_full",
                        format!("the job queue is full ({limit} jobs waiting); retry later"),
                    ));
                }
            };
            return Ok(state.respond(
                &request_id,
                json!({
                    "backupJobId": response_id,
                    "acceptedAt": accepted_at,
                    "queuePosition": ticket.position,
                }),
                StatusCode::ACCEPTED,
                Vec::new(),
            ));
        }

        if path == "/v1/drills/run" {
            require_method(&request, "POST")?;
            let value = read_json_body(&request)?;
            let (target_time, latest, requested_by) =
                validate_drill(&value, (state.options.clock)())?;
            let idempotency_key = idempotency_key_of(&request)?;
            let accepted_at = (state.options.clock)().to_rfc3339_opts(SecondsFormat::Millis, true);
            let id = match &idempotency_key {
                Some(key) => state
                    .options
                    .jobs
                    .lookup_key("drill", key)
                    .map(|(id, _)| id)
                    .unwrap_or(state.reserve_id()?),
                None => state.reserve_id()?,
            };
            let job_id = id.clone();
            let response_id = job_id.clone();
            let drill_runner = Arc::clone(&state.options.drill_runner);
            let catalog = Arc::clone(&state.options.catalog);
            let clock = Arc::clone(&state.options.clock);
            let config = Arc::clone(&state.options.config);
            let secrets = state.secret_values.clone();
            let ticket = state.options.jobs.enqueue(JobSpec {
                id,
                kind: JobKind::Drill,
                scope: Some("drill".to_owned()),
                idempotency_key: idempotency_key.clone(),
                run: Box::pin(async move {
                    let started_at_date = (clock)();
                    let started_at = started_at_date.to_rfc3339_opts(SecondsFormat::Millis, true);
                    let started_ms = started_at_date.timestamp_millis();
                    match drill_runner
                        .run(DrillRunOptions {
                            id: Some(job_id.clone()),
                            requested_by,
                            target_time,
                            latest,
                        })
                        .await
                    {
                        Ok(report) => {
                            let _ = catalog.add_drill(report).await;
                        }
                        Err(error) => {
                            let completed = (clock)();
                            let message = crate::config::redact_text(&error, &secrets)
                                .chars()
                                .take(2000)
                                .collect::<String>();
                            let target = target_time
                                .unwrap_or(started_at_date - chrono::Duration::minutes(5))
                                .to_rfc3339_opts(SecondsFormat::Millis, true);
                            let mut failed = DrillReport::failed(
                                &job_id,
                                &started_at,
                                &completed.to_rfc3339_opts(SecondsFormat::Millis, true),
                                completed
                                    .timestamp_millis()
                                    .saturating_sub(started_ms)
                                    .max(0) as u64,
                                &target,
                                &message,
                            );
                            failed.report_signature =
                                sign_drill_report(&failed, &config.encryption_key_hex).ok();
                            let _ = catalog.add_drill(failed).await;
                        }
                    }
                }),
            });
            let ticket = ticket.map_err(|error: QueueFullError| {
                HttpError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "queue_full",
                    error.to_string(),
                )
            })?;
            if ticket.deduplicated {
                return Ok(state.respond(
                    &request_id,
                    json!({
                        "drillId": ticket.id,
                        "acceptedAt": ticket.accepted_at,
                        "deduplicated": true,
                    }),
                    StatusCode::ACCEPTED,
                    Vec::new(),
                ));
            }
            return Ok(state.respond(
                &request_id,
                json!({
                    "drillId": response_id,
                    "acceptedAt": accepted_at,
                    "queuePosition": ticket.position,
                }),
                StatusCode::ACCEPTED,
                Vec::new(),
            ));
        }

        if path == "/v1/policy" {
            require_method(&request, "PUT")?;
            let value = read_json_body(&request)?;
            let update = validate_policy(&value)?;
            let policy = state
                .options
                .catalog
                .update_policy(
                    Some(update.full_cron),
                    Some(update.delta_cron),
                    Some(update.drill_cron),
                    Some(update.full_retention_days),
                    Some(update.wal_retention_days),
                    Some(update.alert_lag_seconds),
                    update.updated_by,
                    Some((state.options.clock)().to_rfc3339_opts(SecondsFormat::Millis, true)),
                )
                .await;
            return Ok(state.respond(
                &request_id,
                json!({"policy": policy}),
                StatusCode::OK,
                Vec::new(),
            ));
        }

        if path == "/v1/runs" {
            require_method(&request, "GET")?;
            let limit = parse_limit(&request.query, 30)?;
            let runs = state.options.catalog.list_runs(limit);
            return Ok(state.respond(
                &request_id,
                json!({"runs": runs}),
                StatusCode::OK,
                Vec::new(),
            ));
        }

        if path == "/v1/drills" {
            require_method(&request, "GET")?;
            let limit = parse_limit(&request.query, 30)?;
            let drills = state.options.catalog.list_drills(limit);
            return Ok(state.respond(
                &request_id,
                json!({"drills": drills}),
                StatusCode::OK,
                Vec::new(),
            ));
        }

        Err(HttpError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("no route for {method} {path}"),
        ))
    }
    .await;

    match outcome {
        Ok(response) => response,
        Err(error) => {
            let message = state.safe_message(&error.message);
            state.respond(
                &request_id,
                json!({
                    "error": {
                        "code": error.code,
                        "message": message,
                        "requestId": request_id,
                    }
                }),
                error.status,
                Vec::new(),
            )
        }
    }
}

/// TLS peer role resolution: control planes first, then the WAL plane, otherwise unauthorized.
#[must_use]
pub fn caller_role_for_identity(
    identity: Option<&pg_mtls::PeerIdentity>,
    control_allowed: &[String],
    wal_allowed: &[String],
    require_mtls: bool,
) -> Option<CallerRole> {
    if !require_mtls {
        return Some(CallerRole::Open);
    }
    let identity = identity?;
    if identity.allowed_by_cn_or_san(control_allowed) {
        return Some(CallerRole::Control);
    }
    if identity.allowed_by_cn_or_san(wal_allowed) {
        return Some(CallerRole::Wal);
    }
    None
}

const FORBIDDEN_BODY: &str =
    r#"{"error":{"code":"forbidden","message":"client certificate is not authorized"}}"#;

async fn dispatch(state: Arc<HandlerState>, request: HttpRequest, body: Vec<u8>) -> HttpResponse {
    let require_mtls = state.require_mtls;
    let identity = peer_identity(&request);
    let control_allowed = parse_csv(&state.options.config.allowed_client_cns);
    let wal_allowed = parse_csv(&state.options.config.wal_client_cns);
    let role = caller_role_for_identity(
        identity.as_ref(),
        &control_allowed,
        &wal_allowed,
        require_mtls,
    );
    let Some(role) = role else {
        tracing::warn!("rejected mTLS client: certificate identity is not authorized for any role");
        return HttpResponse::builder(StatusCode::FORBIDDEN)
            .content_type("application/json; charset=utf-8")
            .body(FORBIDDEN_BODY.to_owned().into_bytes());
    };
    let mut headers = BTreeMap::new();
    for (name, value) in request.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), value.to_owned());
        }
    }
    let route = RouteRequest {
        role,
        method: request.method().as_str().to_owned(),
        path: request.path().to_owned(),
        query: request.query_string().to_owned(),
        headers,
        body,
    };
    handle(&state, route).await.into_http()
}

fn peer_identity(request: &HttpRequest) -> Option<pg_mtls::PeerIdentity> {
    let io = request.io()?;
    let certificate = io.query::<PeerCertDer>().into_inner()?;
    pg_mtls::identity_from_ntex(&certificate.0).ok()
}

/// Reads the request body with a hard cap, without futures-util (ntex re-exports the `Stream`
/// trait through `ntex::util::future`).
async fn read_payload(
    mut payload: ntex::web::types::Payload,
    max: usize,
) -> Result<Vec<u8>, String> {
    use ntex::util::Stream;
    use std::future::poll_fn;
    use std::pin::Pin;

    let mut output = Vec::new();
    loop {
        let next = poll_fn(|context| Pin::new(&mut payload).poll_next(context)).await;
        match next {
            Some(Ok(chunk)) => {
                if output.len() + chunk.len() > max {
                    return Err(format!("Request body exceeds {max} bytes"));
                }
                output.extend_from_slice(&chunk);
            }
            Some(Err(error)) => return Err(format!("payload error: {error}")),
            None => break,
        }
    }
    Ok(output)
}

/// Runs the daemon's HTTP/mTLS server. The peer certificate is classified before routing; the
/// unfiltered raw 403 body matches the TS gateway.
///
/// # Errors
/// Listener, TLS material and configuration failures.
pub async fn serve(state: Arc<HandlerState>) -> std::io::Result<()> {
    let config = Arc::clone(&state.options.config);
    let tls_paths = config.tls_paths().map_err(std::io::Error::other)?;
    let tls = match &tls_paths {
        Some(paths) => Some(pg_mtls::server_config(paths).map_err(std::io::Error::other)?),
        None => {
            tracing::warn!(
                "backup daemon TLS files are not configured; serving plain HTTP (development only)"
            );
            None
        }
    };
    let bind = format!("{}:{}", config.bind_host, config.daemon_port);
    let wal_max = usize::try_from(config.wal_push_max_bytes).unwrap_or(usize::MAX);
    let server = HttpServer::new(async move |_| {
        let state = Arc::clone(&state);
        App::new().service(ntex::web::resource("/{tail:.*}").to(
            async move |request: HttpRequest, payload: ntex::web::types::Payload| {
                let state = Arc::clone(&state);
                let is_wal = request.path().starts_with("/v1/wal/");
                let cap = if is_wal {
                    wal_max.saturating_add(1024 * 1024)
                } else {
                    MAX_JSON_BODY_BYTES + 64 * 1024
                };
                let body = match read_payload(payload, cap).await {
                    Ok(body) => body,
                    Err(error) => {
                        let request_id = request
                            .headers()
                            .get("x-request-id")
                            .and_then(|value| value.to_str().ok())
                            .filter(|value| valid_request_id(value))
                            .map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
                        let mut response = RouteResponse::json(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            json!({
                                "error": {
                                    "code": "payload_too_large",
                                    "message": error,
                                    "requestId": request_id,
                                }
                            }),
                        );
                        response
                            .headers
                            .push(("x-request-id".to_owned(), request_id));
                        response
                            .headers
                            .push(("cache-control".to_owned(), "no-store".to_owned()));
                        return response.into_http();
                    }
                };
                dispatch(state, request, body).await
            },
        ))
    })
    .graceful_shutdown_timeout(ntex::time::Seconds(10));
    let server = match &tls {
        Some(tls) => server.bind_rustls(
            bind.clone(),
            &tls.config,
            SharedCfg::new("pg-backup-daemon"),
        )?,
        None => server.bind(bind.clone(), SharedCfg::new("pg-backup-daemon"))?,
    };
    tracing::info!(
        bind = bind.as_str(),
        mtls = tls.is_some(),
        engine = config.engine_mode.as_str(),
        "backup-daemon-rs listening"
    );
    let server = server.run();
    let stopper = server.clone();
    tokio::select! {
        outcome = server => outcome,
        _ = tokio::signal::ctrl_c() => {
            stopper.stop(true).await;
            Ok(())
        }
    }
}
