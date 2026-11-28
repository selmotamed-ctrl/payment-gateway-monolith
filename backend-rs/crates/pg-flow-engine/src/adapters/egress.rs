//! [`EgressPort`] and [`CredentialResolver`] on `pg-egress`.
//!
//! Port of `apiConsumer/ApiConsumer.ts` + `runtime/platform.ts:loadConsumerConfig`:
//!
//! - the consumer configuration is resolved from the **pinned** gateway version (`gateway_auth`,
//!   `gateway_environments.allowed_hosts`, `gateway_settings.timeout_ms`) and the pinned credential
//!   set (`credential_sets.entries_ciphertext`, decrypted with the Vault under `credential-set`);
//! - one [`pg_egress::EgressClient`] is cached per `(gateway version, environment)` so the token
//!   cache and the per-destination TLS clients survive across attempts;
//! - every gateway answer, including 4xx/5xx, is returned as an engine [`EgressResponse`] so the
//!   declarative status rules map it (the documented executor contract); only a transport or
//!   response-validation failure becomes an [`EgressError`], and `money_uncertain` is preserved.
//!
//! The ports are `&self` and the engine's egress request carries no attempt id, so the pool-backed
//! [`PgEgressAdapter`] is a factory: [`PgEgressAdapter::bind`] resolves the attempt's pinned
//! configuration and returns a [`BoundEgress`] that implements both ports for that attempt. The core
//! wiring builds the step executor per attempt (or uses [`PgEgressAdapter::prefetch`] with the
//! cached [`PgCredentialResolver`]).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use pg_egress::body::{MultipartBody, RequestBody};
use pg_egress::credentials::{GatewayAuthConfig, GatewayCredentials};
use pg_egress::error::GatewayError;
use pg_egress::executor::{
    CallContext, EgressClient, EgressConfig, EgressRequest as GatewayRequest,
    EgressResponse as GatewayResponse,
};
use pg_egress::executor::{RetryPolicy as GatewayRetryPolicy, SideEffect as GatewaySideEffect};
use pg_egress::target::{EgressPolicy, HostAllowlist, SystemResolver};
use pg_egress::token_cache::TokenKey;
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::adapters::vault::{PgVaultAdapter, CREDENTIAL_SET_KEY};
use crate::error::{codes, EngineError};
use crate::ports::{
    Attempt, CredentialResolver, EgressBody, EgressError, EgressPort, EgressRequest,
    EgressResponse, Environment,
};
use crate::schema::{HttpMethod, RetryPolicy, SideEffect};

/// The process egress policy inputs that are deployment configuration, not database rows.
#[derive(Clone)]
pub struct EgressAdapterConfig {
    /// `FAKE_RAILS_ALLOW_INSECURE_HTTP` / development Fake Rails.
    pub allow_insecure_http: bool,
    /// The scoped Fake Rails private-host relaxation. Never enable in production.
    pub allow_private_hosts: bool,
    /// Extra ports (the Fake Rails emulator listens off 443).
    pub extra_ports: Vec<u16>,
    /// `ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST` (`allowAnyHost`).
    pub allow_any_host: bool,
    /// Deployment trust roots (PEM), never tenant input.
    pub trust_roots_pem: Vec<String>,
    /// Injected resolver; `None` uses the OS resolver.
    pub resolver: Option<Arc<dyn pg_egress::target::Resolver + Send + Sync>>,
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    pub total_timeout: Duration,
}

impl std::fmt::Debug for EgressAdapterConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EgressAdapterConfig")
            .field("allow_insecure_http", &self.allow_insecure_http)
            .field("allow_private_hosts", &self.allow_private_hosts)
            .field("extra_ports", &self.extra_ports)
            .field("allow_any_host", &self.allow_any_host)
            .field("trust_roots", &self.trust_roots_pem.len())
            .finish_non_exhaustive()
    }
}

impl Default for EgressAdapterConfig {
    fn default() -> Self {
        Self {
            allow_insecure_http: false,
            allow_private_hosts: false,
            extra_ports: Vec::new(),
            allow_any_host: false,
            trust_roots_pem: Vec::new(),
            resolver: None,
            connect_timeout: Duration::from_millis(pg_egress::DEFAULT_CONNECT_TIMEOUT_MS),
            read_timeout: Duration::from_millis(pg_egress::DEFAULT_TIMEOUT_MS),
            total_timeout: Duration::from_millis(pg_egress::DEFAULT_TIMEOUT_MS),
        }
    }
}

type CredentialMap = Arc<Map<String, Value>>;

/// The shared, bounded credential cache the sync [`CredentialResolver`] reads.
#[derive(Clone, Default)]
struct CredentialCache {
    entries: Arc<RwLock<HashMap<String, CredentialMap>>>,
}

impl CredentialCache {
    fn get(&self, credential_set_id: &str) -> Option<CredentialMap> {
        self.entries
            .read()
            .ok()
            .and_then(|entries| entries.get(credential_set_id).cloned())
    }

    fn insert(&self, credential_set_id: &str, values: CredentialMap) {
        if let Ok(mut entries) = self.entries.write() {
            if entries.len() > 4096 {
                entries.clear();
            }
            entries.insert(credential_set_id.to_owned(), values);
        }
    }
}

/// [`CredentialResolver`] over the credential cache filled by [`PgEgressAdapter::prefetch`].
///
/// The port is synchronous, so a miss returns an empty map instead of blocking the runtime. The
/// route layer must call `prefetch` before the engine runs a step (the bind path does it
/// automatically for the egress call itself).
#[derive(Clone, Default)]
pub struct PgCredentialResolver {
    cache: CredentialCache,
}

impl std::fmt::Debug for PgCredentialResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgCredentialResolver")
            .finish_non_exhaustive()
    }
}

impl CredentialResolver for PgCredentialResolver {
    fn credentials(&self, attempt: &Attempt) -> Map<String, Value> {
        attempt
            .credential_set_id
            .as_deref()
            .and_then(|credential_set_id| self.cache.get(credential_set_id))
            .map(|values| values.as_ref().clone())
            .unwrap_or_default()
    }
}

/// The resolved per-attempt gateway configuration.
struct LoadedCall {
    client: Arc<EgressClient>,
    auth: GatewayAuthConfig,
    credentials: GatewayCredentials,
    credential_map: CredentialMap,
    token_key: TokenKey,
    timeout_ms: u64,
}

/// Resolves the pinned gateway/credential configuration and runs one attempt's calls.
pub struct PgEgressAdapter {
    pool: PgPool,
    vault: Arc<PgVaultAdapter>,
    config: EgressAdapterConfig,
    clients: RwLock<HashMap<String, Arc<EgressClient>>>,
    credentials: PgCredentialResolver,
}

impl std::fmt::Debug for PgEgressAdapter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgEgressAdapter")
            .field("config", &self.config)
            .field(
                "clients",
                &self
                    .clients
                    .read()
                    .map(|clients| clients.len())
                    .unwrap_or(0),
            )
            .finish_non_exhaustive()
    }
}

impl PgEgressAdapter {
    #[must_use]
    pub fn new(pool: PgPool, vault: Arc<PgVaultAdapter>, config: EgressAdapterConfig) -> Self {
        Self {
            pool,
            vault,
            config,
            clients: RwLock::new(HashMap::new()),
            credentials: PgCredentialResolver::default(),
        }
    }

    /// The shared resolver (for `RailEngineOptions::credentials`).
    #[must_use]
    pub fn resolver(&self) -> PgCredentialResolver {
        self.credentials.clone()
    }

    /// Drops the cached clients and credentials of a gateway version (a credential rotation or a
    /// version activation).
    pub fn invalidate_version(&self, gateway_version_id: &str) {
        if let Ok(mut clients) = self.clients.write() {
            clients.retain(|key, _| !key.starts_with(&format!("{gateway_version_id}|")));
        }
    }

    /// Drops every cached client and credential entry.
    pub fn invalidate_all(&self) {
        if let Ok(mut clients) = self.clients.write() {
            clients.clear();
        }
        if let Ok(mut entries) = self.credentials.cache.entries.write() {
            entries.clear();
        }
    }

    /// Loads the attempt's credential entries into the shared cache.
    pub async fn prefetch(&self, attempt: &Attempt) -> Result<(), EngineError> {
        let _ = self.credentials_for(attempt).await?;
        Ok(())
    }

    /// Resolves the pinned configuration and returns an executor bound to that attempt.
    pub async fn bind(&self, attempt: &Attempt) -> Result<BoundEgress, EngineError> {
        let loaded = self.load_call(attempt).await?;
        Ok(BoundEgress {
            client: loaded.client,
            auth: loaded.auth,
            credentials: loaded.credentials,
            credential_map: loaded.credential_map,
            token_key: loaded.token_key,
            timeout_ms: loaded.timeout_ms,
            attempt_id: attempt.id.clone(),
        })
    }

    async fn load_call(&self, attempt: &Attempt) -> Result<LoadedCall, EngineError> {
        let credential_set_id = attempt.credential_set_id.as_deref().ok_or_else(|| {
            EngineError::new(
                500,
                "EGRESS_CONTEXT_MISSING",
                "The attempt has no credential set; the outbound consumer cannot be resolved",
            )
        })?;
        let gateway_version_id = attempt.gateway_version_id.as_deref().ok_or_else(|| {
            EngineError::new(
                500,
                "EGRESS_CONTEXT_MISSING",
                "The attempt has no gateway version; the outbound consumer cannot be resolved",
            )
        })?;
        let credentials = self.credentials_for(attempt).await?;

        let row = sqlx::query_as::<_, VersionRow>(
            r#"
SELECT gv.gateway_id::text                       AS gateway_id,
       gv.id::text                               AS gateway_version_id,
       ga.method::text                           AS auth_method,
       ga.auth_apply::text                       AS auth_apply,
       ga.refresh_config_json                    AS refresh_config,
       ge.env::text                              AS env,
       ge.allowed_hosts                          AS allowed_hosts,
       gs.timeout_ms                             AS timeout_ms
  FROM gateway_versions gv
  LEFT JOIN LATERAL (
       SELECT * FROM gateway_auth a
        WHERE a.gateway_version_id = gv.id AND a.env = $2
        ORDER BY a.created_at ASC LIMIT 1
  ) ga ON true
  LEFT JOIN LATERAL (
       SELECT * FROM gateway_environments e
        WHERE e.gateway_version_id = gv.id AND e.env = $2
        ORDER BY e.created_at ASC LIMIT 1
  ) ge ON true
  LEFT JOIN gateway_settings gs ON gs.gateway_version_id = gv.id
 WHERE gv.id = $1::uuid
"#,
        )
        .bind(uuid(gateway_version_id)?)
        .bind(attempt.env.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| database_error(&error))?;
        let row = row.ok_or_else(|| {
            EngineError::new(
                500,
                "EGRESS_CONTEXT_MISSING",
                format!("Gateway version '{gateway_version_id}' does not exist"),
            )
        })?;

        // `loadConsumerConfig` falls back to the first auth recipe when the environment has none.
        let auth_method = match row.auth_method.clone() {
            Some(method) => Some(method),
            None => {
                self.any_auth_method(&row.gateway_version_id, attempt.env.as_str())
                    .await?
            }
        };
        let auth = build_auth(
            auth_method.as_deref(),
            row.auth_apply.as_deref(),
            row.refresh_config.as_ref(),
        )?;

        let allowed_hosts: Vec<String> = match row.allowed_hosts.as_ref() {
            Some(Value::Array(entries)) => entries
                .iter()
                .filter_map(|entry| entry.as_str())
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        };
        let client = self.client_for(
            gateway_version_id,
            attempt.env.as_str(),
            &allowed_hosts,
            row.timeout_ms.unwrap_or(15_000),
        )?;
        let credential_map = Arc::new(credentials_as_map(&credentials));
        self.credentials
            .cache
            .insert(credential_set_id, credential_map.clone());
        Ok(LoadedCall {
            client,
            auth,
            credentials,
            credential_map,
            token_key: TokenKey::new(
                row.gateway_id,
                credential_set_id.to_owned(),
                attempt.env.as_str().to_owned(),
            ),
            timeout_ms: row
                .timeout_ms
                .and_then(|value| u64::try_from(value).ok())
                .unwrap_or(15_000),
        })
    }

    async fn any_auth_method(
        &self,
        gateway_version_id: &str,
        env: &str,
    ) -> Result<Option<String>, EngineError> {
        let method: Option<String> = sqlx::query_scalar(
            "SELECT method::text FROM gateway_auth WHERE gateway_version_id = $1::uuid \
             AND env = $2 ORDER BY created_at ASC LIMIT 1",
        )
        .bind(uuid(gateway_version_id)?)
        .bind(env)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| database_error(&error))?;
        Ok(method)
    }

    fn client_for(
        &self,
        gateway_version_id: &str,
        env: &str,
        allowed_hosts: &[String],
        _timeout_ms: i32,
    ) -> Result<Arc<EgressClient>, EngineError> {
        let key = format!("{gateway_version_id}|{env}");
        if let Ok(clients) = self.clients.read() {
            if let Some(client) = clients.get(&key) {
                return Ok(client.clone());
            }
        }
        let hosts: Vec<&str> = allowed_hosts.iter().map(String::as_str).collect();
        let mut allowlist = HostAllowlist::new(&hosts);
        if self.config.allow_any_host {
            allowlist = allowlist.with_allow_any();
        }
        let mut policy = EgressPolicy::new(allowlist);
        policy.allow_insecure_http = self.config.allow_insecure_http;
        policy.allow_private_hosts = self.config.allow_private_hosts;
        policy.extra_ports = self.config.extra_ports.clone();
        let resolver: Arc<dyn pg_egress::target::Resolver + Send + Sync> = self
            .config
            .resolver
            .clone()
            .unwrap_or_else(|| Arc::new(SystemResolver));
        let config = EgressConfig::new(policy, resolver).with_timeouts(
            self.config.connect_timeout,
            self.config.read_timeout,
            self.config.total_timeout,
        );
        let mut config = config;
        config.trust_roots_pem = self.config.trust_roots_pem.clone();
        let client = EgressClient::new(config).map_err(|error| {
            EngineError::new(
                500,
                "EGRESS_CLIENT_INVALID",
                format!("The outbound gateway client could not be built: {error}"),
            )
        })?;
        let client = Arc::new(client);
        if let Ok(mut clients) = self.clients.write() {
            clients.insert(key, client.clone());
        }
        Ok(client)
    }

    async fn credentials_for(&self, attempt: &Attempt) -> Result<GatewayCredentials, EngineError> {
        let credential_set_id = attempt.credential_set_id.as_deref().ok_or_else(|| {
            EngineError::new(
                500,
                "EGRESS_CONTEXT_MISSING",
                "The attempt has no credential set",
            )
        })?;
        let rows: Option<(Value,)> =
            sqlx::query_as("SELECT entries_ciphertext FROM credential_sets WHERE id = $1::uuid")
                .bind(uuid(credential_set_id)?)
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| database_error(&error))?;
        let (entries,) = rows.ok_or_else(|| {
            EngineError::new(
                500,
                "CREDENTIAL_SET_NOT_FOUND",
                format!("Credential set '{credential_set_id}' does not exist"),
            )
        })?;
        let entries = match entries {
            Value::Array(entries) => entries,
            _ => Vec::new(),
        };
        let mut credentials = GatewayCredentials::new();
        let mut values = Map::new();
        for entry in entries {
            let Value::Object(entry) = entry else {
                continue;
            };
            let Some(key) = entry.get("key").and_then(Value::as_str) else {
                continue;
            };
            if key.is_empty() {
                continue;
            }
            let Some(value) = entry.get("value").and_then(Value::as_str) else {
                continue;
            };
            let is_secret = entry
                .get("isSecret")
                .or_else(|| entry.get("is_secret"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let plaintext = if is_secret {
                self.vault
                    .open_with(value, CREDENTIAL_SET_KEY)
                    .map_err(|error| {
                        EngineError::new(
                            500,
                            "CREDENTIAL_DECRYPT_FAILED",
                            format!("Credential '{key}' could not be decrypted: {error}"),
                        )
                    })?
            } else {
                value.to_owned()
            };
            values.insert(key.to_owned(), Value::String(plaintext.clone()));
            credentials.insert(key, plaintext);
        }
        let cache = Arc::new(values);
        self.credentials.cache.insert(credential_set_id, cache);
        Ok(credentials)
    }
}

/// One attempt's resolved outbound configuration. Implements both ports so the engine can use it as
/// the egress executor and as the credential resolver of the same attempt.
pub struct BoundEgress {
    client: Arc<EgressClient>,
    auth: GatewayAuthConfig,
    credentials: GatewayCredentials,
    credential_map: CredentialMap,
    token_key: TokenKey,
    timeout_ms: u64,
    attempt_id: String,
}

impl BoundEgress {
    /// A resolved executor. The factory ([`PgEgressAdapter::bind`]) is the normal constructor; this
    /// one exists for the core wiring and the tests that already hold the resolved configuration.
    #[must_use]
    pub fn new(
        client: Arc<EgressClient>,
        auth: GatewayAuthConfig,
        credentials: GatewayCredentials,
        token_key: TokenKey,
        timeout_ms: u64,
        attempt_id: impl Into<String>,
    ) -> Self {
        let credential_map = Arc::new(credentials_as_map(&credentials));
        Self {
            client,
            auth,
            credentials,
            credential_map,
            token_key,
            timeout_ms,
            attempt_id: attempt_id.into(),
        }
    }
}

impl std::fmt::Debug for BoundEgress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundEgress")
            .field("attempt_id", &self.attempt_id)
            .field("token_key", &self.token_key)
            .finish_non_exhaustive()
    }
}

impl CredentialResolver for BoundEgress {
    fn credentials(&self, _attempt: &Attempt) -> Map<String, Value> {
        self.credential_map.as_ref().clone()
    }
}

#[async_trait]
impl EgressPort for BoundEgress {
    async fn send(&self, request: EgressRequest) -> Result<EgressResponse, EgressError> {
        let method = request
            .method
            .as_str()
            .parse()
            .map_err(|_| EgressError::blocked("The gateway request method is invalid"))?;
        let request_url = request.url.clone();
        let mut gateway = GatewayRequest::new(method, request_url.clone())
            .with_side_effect(map_side_effect(request.side_effect))
            .with_retry_policy(map_retry_policy(request.retry_policy))
            .with_point_of_no_return(request.point_of_no_return)
            .with_timeout(Duration::from_millis(if request.timeout_ms == 0 {
                self.timeout_ms.max(1)
            } else {
                request.timeout_ms
            }));
        let multipart = matches!(&request.body, Some(EgressBody::Multipart(_)));
        for (name, value) in &request.headers {
            if multipart && name.eq_ignore_ascii_case("content-type") {
                // The adapter owns the multipart boundary (`EgressBody::Multipart` contract).
                continue;
            }
            gateway = gateway.with_header(name.clone(), value.clone());
        }
        if let Some(body) = request.body {
            gateway = gateway.with_body(map_body(body, &request.headers)?);
        }
        let context = CallContext::new(&self.auth, &self.credentials, self.token_key.clone());
        match self.client.request(&context, gateway).await {
            Ok(response) => Ok(map_response(response)),
            Err(GatewayError::Http {
                status,
                raw_text,
                data,
            }) => Ok(EgressResponse {
                status,
                headers: BTreeMap::new(),
                raw_text,
                data,
                url: request_url,
            }),
            Err(error) => Err(map_error(error)),
        }
    }
}

fn map_body(
    body: EgressBody,
    headers: &BTreeMap<String, String>,
) -> Result<RequestBody, EgressError> {
    let content_type = header(headers, "content-type");
    Ok(match body {
        EgressBody::Json(value) => RequestBody::Json(value),
        EgressBody::Text(text) => match content_type {
            Some(value) if value.contains("xml") => RequestBody::Xml(text),
            Some(value) => RequestBody::Bytes {
                content_type: Some(value),
                bytes: text.into_bytes(),
            },
            None => RequestBody::Text(text),
        },
        EgressBody::Form(fields) => RequestBody::Form(fields),
        EgressBody::Multipart(fields) => {
            let mut multipart = MultipartBody::new();
            for (name, value) in fields {
                multipart = multipart.field(name, value);
            }
            RequestBody::Multipart(multipart)
        }
        EgressBody::Bytes(bytes) => RequestBody::Bytes {
            content_type,
            bytes,
        },
    })
}

fn header(headers: &BTreeMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn map_response(response: GatewayResponse) -> EgressResponse {
    let mut headers = BTreeMap::new();
    for (name, value) in &response.headers {
        let entry = headers
            .entry(name.as_str().to_owned())
            .or_insert_with(String::new);
        if !entry.is_empty() {
            entry.push_str(", ");
        }
        entry.push_str(value.to_str().unwrap_or(""));
    }
    EgressResponse {
        status: response.status,
        headers,
        raw_text: response.raw_text,
        data: response.data,
        url: response.url,
    }
}

fn map_error(error: GatewayError) -> EgressError {
    let status = error.status();
    let retryable = error.retryable();
    let money_uncertain = error.money_uncertain();
    EgressError {
        message: error.to_string(),
        status,
        retryable,
        money_uncertain,
    }
}

fn map_side_effect(side_effect: SideEffect) -> GatewaySideEffect {
    match side_effect {
        SideEffect::ReadOnly => GatewaySideEffect::ReadOnly,
        SideEffect::SendsNotification => GatewaySideEffect::SendsNotification,
        SideEffect::MovesMoney => GatewaySideEffect::MovesMoney,
    }
}

fn map_retry_policy(policy: RetryPolicy) -> GatewayRetryPolicy {
    match policy {
        RetryPolicy::Never => GatewayRetryPolicy::Never,
        RetryPolicy::Safe => GatewayRetryPolicy::Safe,
        RetryPolicy::SafeWithCooldown => GatewayRetryPolicy::SafeWithCooldown,
    }
}

fn build_auth(
    method: Option<&str>,
    apply: Option<&str>,
    refresh: Option<&Value>,
) -> Result<GatewayAuthConfig, EngineError> {
    let mut object = Map::new();
    object.insert(
        "method".to_owned(),
        Value::String(method.unwrap_or("API_KEY").to_owned()),
    );
    object.insert(
        "apply".to_owned(),
        Value::String(apply.unwrap_or("HEADER").to_owned()),
    );
    if let Some(Value::Object(refresh)) = refresh {
        for (key, value) in refresh {
            object.insert(key.clone(), value.clone());
        }
    }
    GatewayAuthConfig::from_json(&Value::Object(object)).map_err(|error| {
        EngineError::new(
            500,
            "GATEWAY_AUTH_INVALID",
            format!("The stored gateway auth configuration is invalid: {error}"),
        )
    })
}

fn credentials_as_map(credentials: &GatewayCredentials) -> Map<String, Value> {
    let mut map = Map::new();
    for key in credentials.keys() {
        if let Some(value) = credentials.get(key) {
            map.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    map
}

fn uuid(value: &str) -> Result<uuid::Uuid, EngineError> {
    uuid::Uuid::parse_str(value).map_err(|error| {
        EngineError::with_code(
            500,
            codes::STEP_REQUEST_INVALID,
            format!("The outbound gateway context id '{value}' is invalid: {error}"),
        )
    })
}

fn database_error(error: &sqlx::Error) -> EngineError {
    EngineError::with_code(
        500,
        "DATABASE_ERROR",
        format!("The outbound gateway configuration could not be read: {error}"),
    )
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    gateway_id: String,
    gateway_version_id: String,
    auth_method: Option<String>,
    auth_apply: Option<String>,
    refresh_config: Option<Value>,
    #[allow(dead_code)]
    env: Option<String>,
    allowed_hosts: Option<Value>,
    timeout_ms: Option<i32>,
}

/// Converts the engine's `Environment` to the string `gateway_auth.env` stores.
#[must_use]
pub fn environment_str(environment: Environment) -> &'static str {
    environment.as_str()
}

/// Converts the engine's `HttpMethod` to the wire method; kept public for the tests.
#[must_use]
pub fn method_str(method: HttpMethod) -> &'static str {
    method.as_str()
}

/// `true` when the engine's request body is dropped for the method, matching `fetch`.
#[must_use]
pub fn method_sends_body(method: HttpMethod) -> bool {
    method.sends_body()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_body_drops_the_explicit_content_type() {
        let mut headers = BTreeMap::new();
        headers.insert("content-type".to_owned(), "multipart/form-data".to_owned());
        let body = map_body(
            EgressBody::Multipart(vec![("MID".to_owned(), "1".to_owned())]),
            &headers,
        )
        .expect("body");
        match body {
            RequestBody::Multipart(multipart) => {
                assert_eq!(multipart.fields, vec![("MID".to_owned(), "1".to_owned())]);
                assert!(multipart.files.is_empty());
            }
            other => panic!("expected multipart, got {other:?}"),
        }
    }

    #[test]
    fn xml_text_keeps_the_xml_body() {
        let body = map_body(
            EgressBody::Text("<a/>".to_owned()),
            &BTreeMap::from([("content-type".to_owned(), "application/xml".to_owned())]),
        )
        .expect("body");
        assert!(matches!(body, RequestBody::Xml(value) if value == "<a/>"));
    }

    #[test]
    fn transport_mapping_preserves_money_uncertainty() {
        let mapped = map_error(GatewayError::Transport {
            message: "connection reset".to_owned(),
            timeout: false,
            money_uncertain: true,
        });
        assert!(mapped.retryable);
        assert!(mapped.money_uncertain);
        assert_eq!(mapped.status, None);
    }

    #[test]
    fn methods_and_policies_map_one_to_one() {
        assert_eq!(method_str(HttpMethod::Get), "GET");
        assert!(!method_sends_body(HttpMethod::Delete));
        assert_eq!(
            map_retry_policy(RetryPolicy::SafeWithCooldown),
            GatewayRetryPolicy::SafeWithCooldown
        );
        assert_eq!(
            map_side_effect(SideEffect::MovesMoney),
            GatewaySideEffect::MovesMoney
        );
        assert_eq!(environment_str(Environment::Live), "LIVE");
    }

    #[test]
    fn auth_defaults_to_api_key_header() {
        let auth = build_auth(None, None, None).expect("auth");
        assert_eq!(
            auth.method,
            pg_egress::ApiConsumerAuth::ApiKey {
                placement: pg_egress::AuthPlacement::Header
            }
        );
    }
}
