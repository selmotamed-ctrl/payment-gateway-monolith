//! [`FlowProvider`] over the declarative flow tables.
//!
//! Port of `engine/runtime/flowProvider.ts`. The database rows (`flows`, `flow_steps`,
//! `step_parameters`, `step_outputs`, `status_rules`, `gateway_environments`) are projected into
//! [`StoredFlow`] and materialised through [`crate::materialize::materialize_flow`], so the runtime
//! vocabulary is validated by exactly one compiler instead of a second hand-written projection.
//!
//! A flow bound to the attempt's rail wins over a generic flow, and a flow bound to its sub mode
//! wins over one that serves every sub mode. A version without a flow for a phase yields no steps,
//! which the engine treats as a no-op phase.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::error::{codes, EngineError};
use crate::materialize::{
    materialize_flow, StoredAssertion, StoredFlow, StoredFlowStep, StoredIdempotency,
    StoredStatusRule, StoredStepOutput, StoredStepParameter,
};
use crate::ports::{Attempt, FlowProvider};
use crate::schema::{FlowPhase, FlowStep};

/// A cache key: the pinned version, environment, phase and the rail/sub-mode binding.
type StepCacheKey = (String, String, &'static str, Option<String>, Option<String>);

/// [`FlowProvider`] on the core database.
pub struct PgFlowProvider {
    pool: PgPool,
    cache: RwLock<HashMap<StepCacheKey, Arc<Vec<FlowStep>>>>,
    cache_enabled: bool,
}

impl std::fmt::Debug for PgFlowProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgFlowProvider")
            .field("cache_enabled", &self.cache_enabled)
            .finish_non_exhaustive()
    }
}

impl PgFlowProvider {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            cache: RwLock::new(HashMap::new()),
            cache_enabled: true,
        }
    }

    /// Disables the per-version step cache (tests, and a process that edits flows online).
    #[must_use]
    pub fn without_cache(mut self) -> Self {
        self.cache_enabled = false;
        self
    }

    /// Forgets every cached flow (a gateway version was activated or edited).
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.write() {
            cache.clear();
        }
    }

    /// Loads and materialises one flow phase.
    pub async fn load_steps(
        &self,
        phase: FlowPhase,
        attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError> {
        if let Some(version) = attempt.gateway_version_id.as_deref() {
            let key: StepCacheKey = (
                version.to_owned(),
                attempt.env_str().to_owned(),
                phase.as_str(),
                attempt.rail_id.clone(),
                attempt.sub_mode.clone(),
            );
            if self.cache_enabled {
                if let Ok(cache) = self.cache.read() {
                    if let Some(steps) = cache.get(&key) {
                        return Ok(steps.as_ref().clone());
                    }
                }
            }
            let mut conn = self.pool.acquire().await.map_err(database_error)?;
            let steps = self.load_steps_on(&mut conn, phase, attempt).await?;
            if self.cache_enabled {
                if let Ok(mut cache) = self.cache.write() {
                    if cache.len() > 2048 {
                        cache.clear();
                    }
                    cache.insert(key, Arc::new(steps.clone()));
                }
            }
            return Ok(steps);
        }
        Ok(Vec::new())
    }

    /// Loads and materialises one flow phase in the caller's connection/transaction.
    pub async fn load_steps_on(
        &self,
        conn: &mut PgConnection,
        phase: FlowPhase,
        attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError> {
        let Some(gateway_version_id) = attempt.gateway_version_id.as_deref() else {
            return Ok(Vec::new());
        };
        let version_uuid = Uuid::parse_str(gateway_version_id).map_err(|error| {
            EngineError::with_code(
                500,
                codes::STEP_REQUEST_INVALID,
                format!(
                    "Attempt '{}' has an invalid gateway version id: {error}",
                    attempt.id
                ),
            )
        })?;
        self.load_uncached(conn, phase, version_uuid, attempt).await
    }

    async fn load_uncached(
        &self,
        conn: &mut PgConnection,
        phase: FlowPhase,
        gateway_version_id: Uuid,
        attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError> {
        let flow_rows = sqlx::query(
            r#"
SELECT id, rail_id::text AS rail_id, sub_mode
  FROM flows
 WHERE gateway_version_id = $1
   AND phase = $2::text::"FlowPhase"
   AND (rail_id IS NULL OR rail_id = $3::uuid)
 ORDER BY rail_id NULLS LAST, sub_mode NULLS LAST, created_at ASC
"#,
        )
        .bind(gateway_version_id)
        .bind(phase.as_str())
        .bind(
            attempt
                .rail_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok()),
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(database_error)?;

        let candidates: Vec<StoredFlowId> = flow_rows
            .iter()
            .map(|row| StoredFlowId {
                id: row.get::<Uuid, _>("id"),
                rail_id: row.get::<Option<String>, _>("rail_id"),
                sub_mode: row.get::<Option<String>, _>("sub_mode"),
            })
            .collect();
        let Some(flow) = select_flow(
            &candidates,
            attempt.rail_id.as_deref(),
            attempt.sub_mode.as_deref(),
        ) else {
            return Ok(Vec::new());
        };

        let step_rows = sqlx::query(
            r#"
SELECT id, order_index, type::text AS step_type, method, url_template,
       content_type::text AS content_type, xml_template, timeout_ms, success_check,
       side_effect::text AS side_effect, retry_policy::text AS retry_policy,
       idempotency_config, point_of_no_return
  FROM flow_steps
 WHERE flow_id = $1
 ORDER BY order_index ASC
"#,
        )
        .bind(flow.id)
        .fetch_all(&mut *conn)
        .await
        .map_err(database_error)?;

        let step_ids: Vec<Uuid> = step_rows.iter().map(|row| row.get("id")).collect();

        let parameter_rows = if step_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query(
                r#"
SELECT step_id, place::text AS place, key, source::text AS source, selector,
       constant_value, crypto_profile_id::text AS crypto_profile_id, transforms
  FROM step_parameters
 WHERE step_id = ANY($1::uuid[])
 ORDER BY created_at ASC
"#,
            )
            .bind(&step_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(database_error)?
        };

        let output_rows = if step_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query(
                r#"
SELECT step_id, name, selector, transforms, store_as::text AS store_as, required
  FROM step_outputs
 WHERE step_id = ANY($1::uuid[])
 ORDER BY created_at ASC
"#,
            )
            .bind(&step_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(database_error)?
        };

        let rule_rows = sqlx::query(
            r#"
SELECT phase, selector, op::text AS op, value_json,
       canonical_status::text AS canonical_status, canonical_substatus, canonical_error
  FROM status_rules
 WHERE gateway_version_id = $1 AND phase = $2
 ORDER BY order_index ASC
"#,
        )
        .bind(gateway_version_id)
        .bind(phase.as_str())
        .fetch_all(&mut *conn)
        .await
        .map_err(database_error)?;

        let status_rules: Vec<StoredStatusRule> = rule_rows
            .iter()
            .map(|row| StoredStatusRule {
                phase: row.get("phase"),
                selector: row.get("selector"),
                op: row.get("op"),
                value_json: row.get("value_json"),
                canonical_status: row.get("canonical_status"),
                canonical_substatus: row.get("canonical_substatus"),
                canonical_error: row.get("canonical_error"),
            })
            .collect();

        let base_urls = self
            .base_urls(conn, gateway_version_id, attempt.env_str())
            .await?;

        let mut stored_steps = Vec::with_capacity(step_rows.len());
        for row in &step_rows {
            let step_id: Uuid = row.get("id");
            let parameters = parameter_rows
                .iter()
                .filter(|parameter| parameter.get::<Uuid, _>("step_id") == step_id)
                .map(|parameter| StoredStepParameter {
                    place: parameter.get("place"),
                    key: parameter.get("key"),
                    source: parameter.get("source"),
                    selector: parameter.get("selector"),
                    constant_value: parameter
                        .get::<Option<String>, _>("constant_value")
                        .map(Value::String),
                    crypto_profile_id: parameter.get("crypto_profile_id"),
                    transforms: serde_json::from_value(parameter.get("transforms"))
                        .unwrap_or_default(),
                })
                .collect();
            let outputs = output_rows
                .iter()
                .filter(|output| output.get::<Uuid, _>("step_id") == step_id)
                .map(|output| StoredStepOutput {
                    name: output.get("name"),
                    selector: output.get("selector"),
                    transforms: serde_json::from_value(output.get("transforms"))
                        .unwrap_or_default(),
                    store_as: output.get("store_as"),
                    required: output.get("required"),
                })
                .collect();
            stored_steps.push(StoredFlowStep {
                id: step_id.to_string(),
                order_index: i64::from(row.get::<i32, _>("order_index")),
                step_type: row.get("step_type"),
                method: row.get("method"),
                url_template: row.get("url_template"),
                content_type: row.get("content_type"),
                xml_template: row.get("xml_template"),
                timeout_ms: row
                    .get::<Option<i32>, _>("timeout_ms")
                    .and_then(|value| u64::try_from(value).ok()),
                side_effect: row.get("side_effect"),
                retry_policy: row.get("retry_policy"),
                point_of_no_return: Some(row.get::<bool, _>("point_of_no_return")),
                idempotency_config: row
                    .try_get::<Option<Value>, _>("idempotency_config")
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null)
                    .as_object()
                    .map(|object| StoredIdempotency {
                        mode: object
                            .get("mode")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        key_name: object
                            .get("key_name")
                            .or_else(|| object.get("keyName"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        source_template: object
                            .get("source_template")
                            .or_else(|| object.get("sourceTemplate"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    }),
                parameters,
                outputs,
                success_check: optional_json::<Vec<StoredAssertion>>(
                    row.try_get::<Option<Value>, _>("success_check")
                        .ok()
                        .flatten()
                        .unwrap_or(Value::Null),
                ),
                compute: None,
                render: None,
                wait: None,
                assertions: None,
                branch: None,
                max_attempts: None,
                retry_delay_ms: None,
            });
        }

        let stored = StoredFlow {
            id: Some(flow.id.to_string()),
            rail_id: flow.rail_id.clone(),
            sub_mode: flow.sub_mode.clone(),
            phase: phase.as_str().to_owned(),
            steps: stored_steps,
        };
        let materialised =
            materialize_flow(&stored, &status_rules, &base_urls).map_err(|errors| {
                let details: Vec<Value> = errors
                    .iter()
                    .map(|diagnostic| {
                        serde_json::json!({
                            "path": diagnostic.path,
                            "code": diagnostic.code,
                            "message": diagnostic.message,
                            "hint": diagnostic.ai_fix_hint,
                        })
                    })
                    .collect();
                EngineError::with_code(
                    500,
                    "INVALID_STORED_FLOW",
                    format!(
                    "The stored flow of gateway version {gateway_version_id} phase {} is invalid.",
                    phase.as_str()
                ),
                )
                .with_details(Value::Array(details))
            })?;
        Ok(materialised.steps)
    }

    async fn base_urls(
        &self,
        conn: &mut PgConnection,
        gateway_version_id: Uuid,
        env: &str,
    ) -> Result<BTreeMap<String, String>, EngineError> {
        let rows = sqlx::query(
            r#"
SELECT env::text AS env, base_urls
  FROM gateway_environments
 WHERE gateway_version_id = $1
 ORDER BY created_at ASC
"#,
        )
        .bind(gateway_version_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(database_error)?;
        let selected = rows
            .iter()
            .find(|row| row.get::<String, _>("env").eq_ignore_ascii_case(env))
            .or_else(|| rows.first());
        let mut urls = BTreeMap::new();
        if let Some(row) = selected {
            if let Value::Object(base_urls) = row.get::<Value, _>("base_urls") {
                for (key, value) in base_urls {
                    if let Value::String(value) = value {
                        if !value.is_empty() {
                            urls.insert(key, value);
                        }
                    }
                }
            }
        }
        Ok(urls)
    }
}

#[derive(Debug, Clone)]
struct StoredFlowId {
    id: Uuid,
    rail_id: Option<String>,
    sub_mode: Option<String>,
}

/// `selectFlow` (`flowProvider.ts:225-238`): rail-specific beats generic, sub-mode-specific beats
/// any.
fn select_flow<'a>(
    flows: &'a [StoredFlowId],
    rail_id: Option<&str>,
    sub_mode: Option<&str>,
) -> Option<&'a StoredFlowId> {
    let candidates: Vec<&StoredFlowId> = flows
        .iter()
        .filter(|flow| flow.rail_id.as_deref() == rail_id || flow.rail_id.is_none())
        .collect();
    candidates
        .iter()
        .find(|flow| flow.rail_id.as_deref() == rail_id && flow.sub_mode.as_deref() == sub_mode)
        .or_else(|| {
            candidates
                .iter()
                .find(|flow| flow.rail_id.as_deref() == rail_id && flow.sub_mode.is_none())
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|flow| flow.rail_id.is_none() && flow.sub_mode.as_deref() == sub_mode)
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|flow| flow.rail_id.is_none() && flow.sub_mode.is_none())
        })
        .copied()
}

fn optional_json<T: serde::de::DeserializeOwned>(value: Value) -> Option<T> {
    if value.is_null() {
        None
    } else {
        serde_json::from_value(value).ok()
    }
}

fn database_error(error: sqlx::Error) -> EngineError {
    EngineError::with_code(
        500,
        codes::STEP_REQUEST_INVALID,
        format!("The stored flow could not be read: {error}"),
    )
}

#[async_trait]
impl FlowProvider for PgFlowProvider {
    async fn get_steps(
        &self,
        phase: FlowPhase,
        attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError> {
        self.load_steps(phase, attempt).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow(id: u128, rail: Option<&str>, sub_mode: Option<&str>) -> StoredFlowId {
        StoredFlowId {
            id: Uuid::from_u128(id),
            rail_id: rail.map(str::to_owned),
            sub_mode: sub_mode.map(str::to_owned),
        }
    }

    #[test]
    fn rail_specific_flow_wins_over_the_generic_one() {
        let flows = vec![flow(1, None, None), flow(2, Some("otp"), None)];
        assert_eq!(
            select_flow(&flows, Some("otp"), None).map(|value| value.id),
            Some(Uuid::from_u128(2))
        );
        assert_eq!(
            select_flow(&flows, Some("card"), None).map(|value| value.id),
            Some(Uuid::from_u128(1))
        );
    }

    #[test]
    fn sub_mode_specific_flow_wins_within_the_rail() {
        let flows = vec![
            flow(1, None, None),
            flow(2, Some("otp"), None),
            flow(3, Some("otp"), Some("HOSTED")),
            flow(4, None, Some("HOSTED")),
        ];
        assert_eq!(
            select_flow(&flows, Some("otp"), Some("HOSTED")).map(|value| value.id),
            Some(Uuid::from_u128(3))
        );
        // A rail-specific flow that serves every sub mode still wins over a generic sub-mode
        // flow, exactly like `selectFlow` in `flowProvider.ts`.
        assert_eq!(
            select_flow(&flows, Some("otp"), Some("QR")).map(|value| value.id),
            Some(Uuid::from_u128(2))
        );
        assert_eq!(
            select_flow(&flows, Some("card"), Some("QR")).map(|value| value.id),
            Some(Uuid::from_u128(1))
        );
    }
}
