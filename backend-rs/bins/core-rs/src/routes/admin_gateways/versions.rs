//! The gateway-version authoring projection (`GET /gateway-versions/:vid`).
//!
//! Ports `admin.ts:14141-14436`. The wizard reads one version as a single draft document assembled
//! from the relational rows: identity, environments, auth, credential-set metadata, rails and their
//! fields, crypto profiles, flows/steps, client actions, confirmation channels, poll policies,
//! status rules, error maps, amount pipeline, cost model and statement mapping.
//!
//! Secrets never appear: credential sets are projected to label/status only and crypto profiles
//! carry the *reference* of the key, not its value.

#![forbid(unsafe_code)]

use std::collections::HashMap;

use ntex::web::HttpRequest;
use pg_http::ApiError;
use serde_json::{Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common;
use super::{
    as_number_array, as_record, as_record_array, as_string_array, col_bool, col_i32, col_opt_json,
    col_opt_text, col_opt_uuid, col_text, col_uuid, decimal_json, get_json, not_found, object,
    uuid_param,
};
use crate::state::AppState;

get_json!(detail, version_detail);
async fn version_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "vid", 0)?;
    let version = sqlx::query(
        "SELECT v.id, v.gateway_id, v.version_number, v.state::text AS state, v.rollback_version_id,
                g.code, g.name, g.operator, g.country::text AS country, g.aliases,
                g.kind::text AS kind, g.verification_state::text AS verification_state,
                g.risk_class::text AS risk_class
           FROM gateway_versions v
           JOIN gateways g ON g.id = v.gateway_id
          WHERE v.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| {
        not_found(
            "GATEWAY_VERSION_NOT_FOUND",
            "The gateway version does not exist",
        )
    })?;
    let gateway_id = col_uuid(&version, "gateway_id")?;

    let environments = sqlx::query(
        "SELECT env::text AS env, base_urls, allowed_hosts, inbound_ip_allowlist, enabled
           FROM gateway_environments
          WHERE gateway_version_id = $1
          ORDER BY env ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let auth_rows = sqlx::query(
        "SELECT env, method::text AS method, auth_apply::text AS auth_apply, refresh_config_json
           FROM gateway_auth
          WHERE gateway_version_id = $1
          ORDER BY env ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let setting = sqlx::query(
        "SELECT amount_scale, amount_precision, amount_rounding
           FROM gateway_settings
          WHERE gateway_version_id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let crypto_profiles = sqlx::query(
        "SELECT id, name, purpose::text AS purpose, algorithm::text AS algorithm,
                secret_key_encoding::text AS secret_key_encoding,
                canonicalization_mode::text AS canonicalization_mode, secret_key_ref,
                included_fields
           FROM crypto_profiles
          WHERE gateway_version_id = $1
          ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let flows = sqlx::query(
        "SELECT id, phase::text AS phase
           FROM flows
          WHERE gateway_version_id = $1
          ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let flow_ids: Vec<Uuid> = flows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("id").ok())
        .collect();
    let steps = if flow_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "SELECT id, flow_id, order_index, type::text AS type, method, url_template,
                    side_effect::text AS side_effect, retry_policy::text AS retry_policy,
                    point_of_no_return
               FROM flow_steps
              WHERE flow_id = ANY($1)
              ORDER BY flow_id, order_index ASC, id ASC",
        )
        .bind(&flow_ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?
    };
    let status_rules = sqlx::query(
        "SELECT id, selector, canonical_status::text AS canonical_status, canonical_error,
                canonical_substatus
           FROM status_rules
          WHERE gateway_version_id = $1
          ORDER BY order_index ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let error_maps = sqlx::query(
        "SELECT id, gateway_code, canonical_error, retryable, classification::text AS classification,
                customer_message_ar, customer_message_en
           FROM error_maps
          WHERE gateway_version_id = $1
          ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let channels = sqlx::query(
        "SELECT id, type::text AS type, path_token, event_map, crypto_profile_id, ip_allowlist,
                must_inquire, timestamp_tolerance_sec
           FROM confirmation_channels
          WHERE gateway_version_id = $1
          ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let credential_rows = sqlx::query(
        "SELECT id, env::text AS env, owner_type::text AS owner_type, external_merchant_id,
                settlement_target::text AS settlement_target, status::text AS status
           FROM credential_sets
          WHERE gateway_id = $1
          ORDER BY created_at ASC, id ASC",
    )
    .bind(Uuid::parse_str(&gateway_id).unwrap_or_default())
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;

    let routes = sqlx::query(
        "SELECT rr.id, rr.priority, rr.cost_model, rr.rail_id,
                r.code AS rail_code, r.name_ar, r.name_en,
                r.collection_mode::text AS collection_mode, r.currency::text AS currency,
                r.min_amount, r.max_amount, r.capabilities
           FROM rail_routes rr
           JOIN rails r ON r.id = rr.rail_id
          WHERE rr.gateway_id = $1
          ORDER BY rr.priority DESC, rr.id ASC",
    )
    .bind(Uuid::parse_str(&gateway_id).unwrap_or_default())
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let route_ids: Vec<Uuid> = routes
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("id").ok())
        .collect();
    let rail_ids: Vec<Uuid> = routes
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("rail_id").ok())
        .collect();
    let field_rows = if rail_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "SELECT id, rail_id, key, type::text AS type, label_ar, label_en, required, regex,
                    min_length, max_length, sensitivity::text AS sensitivity, options_json
               FROM rail_fields
              WHERE rail_id = ANY($1)
              ORDER BY rail_id, order_index ASC, id ASC",
        )
        .bind(&rail_ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?
    };
    let widget_rows = if route_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "SELECT id, route_id, script_urls, script_sri_hashes, allowed_origins, iframe_sandbox_attrs
               FROM widget_definitions
              WHERE route_id = ANY($1)
              ORDER BY route_id, created_at ASC, id ASC",
        )
        .bind(&route_ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?
    };
    let redirect_rows = if route_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "SELECT id, route_id, method::text AS method, url_source_output
               FROM redirect_definitions
              WHERE route_id = ANY($1)
              ORDER BY route_id, created_at ASC, id ASC",
        )
        .bind(&route_ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?
    };
    let poll_rows = if route_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "SELECT id, route_id, first_after_seconds, backoff_seconds, max_duration_seconds
               FROM poll_policies
              WHERE route_id = ANY($1)
              ORDER BY route_id, created_at ASC, id ASC",
        )
        .bind(&route_ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?
    };

    let mut fields_by_rail: HashMap<String, Vec<Value>> = HashMap::new();
    for row in &field_rows {
        let rail_id = col_uuid(row, "rail_id")?;
        fields_by_rail.entry(rail_id).or_default().push(object(vec![
            ("id", Value::String(col_uuid(row, "id")?)),
            ("fieldKey", Value::String(col_text(row, "key")?)),
            ("labelAr", Value::String(col_text(row, "label_ar")?)),
            ("labelEn", Value::String(col_text(row, "label_en")?)),
            (
                "inputType",
                Value::String(wizard_field_type(&col_text(row, "type")?)),
            ),
            ("required", Value::Bool(col_bool(row, "required")?)),
            (
                "regex",
                col_opt_text(row, "regex")?.map_or(Value::Null, Value::String),
            ),
            (
                "minLength",
                super::col_opt_i32(row, "min_length")?.map_or(Value::Null, Value::from),
            ),
            (
                "maxLength",
                super::col_opt_i32(row, "max_length")?.map_or(Value::Null, Value::from),
            ),
            ("normalizer", Value::String("NONE".to_owned())),
            ("sensitivity", Value::String(col_text(row, "sensitivity")?)),
            (
                "options",
                match col_opt_json(row, "options_json")? {
                    Some(value) if value.is_array() => Value::Array(as_string_array(&value)),
                    Some(value) => Value::Array(as_string_array(
                        &value
                            .get("options")
                            .cloned()
                            .unwrap_or(Value::Array(Vec::new())),
                    )),
                    None => Value::Array(Vec::new()),
                },
            ),
        ]));
    }
    let mut widgets_by_route: HashMap<String, Vec<Value>> = HashMap::new();
    for row in &widget_rows {
        let route_id = col_uuid(row, "route_id")?;
        let sandbox =
            as_string_array(&col_opt_json(row, "iframe_sandbox_attrs")?.unwrap_or(Value::Null))
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
        widgets_by_route
            .entry(route_id)
            .or_default()
            .push(object(vec![
                ("id", Value::String(col_uuid(row, "id")?)),
                (
                    "script_urls",
                    col_opt_json(row, "script_urls")?.unwrap_or(Value::Null),
                ),
                (
                    "script_sri_hashes",
                    col_opt_json(row, "script_sri_hashes")?.unwrap_or(Value::Null),
                ),
                (
                    "allowed_origins",
                    col_opt_json(row, "allowed_origins")?.unwrap_or(Value::Null),
                ),
                ("iframe_sandbox", Value::String(sandbox)),
            ]));
    }
    let mut redirects_by_route: HashMap<String, Vec<Value>> = HashMap::new();
    for row in &redirect_rows {
        let route_id = col_uuid(row, "route_id")?;
        redirects_by_route
            .entry(route_id)
            .or_default()
            .push(object(vec![
                ("id", Value::String(col_uuid(row, "id")?)),
                ("method", Value::String(col_text(row, "method")?)),
                (
                    "urlSourceOutput",
                    Value::String(col_text(row, "url_source_output")?),
                ),
            ]));
    }
    let mut polls_by_route: HashMap<String, Vec<Value>> = HashMap::new();
    for row in &poll_rows {
        let route_id = col_uuid(row, "route_id")?;
        polls_by_route
            .entry(route_id)
            .or_default()
            .push(object(vec![
                ("id", Value::String(col_uuid(row, "id")?)),
                (
                    "firstAfterSeconds",
                    Value::from(col_i32(row, "first_after_seconds")?),
                ),
                (
                    "backoffSeconds",
                    col_opt_json(row, "backoff_seconds")?.unwrap_or(Value::Null),
                ),
                (
                    "maxDurationSeconds",
                    Value::from(col_i32(row, "max_duration_seconds")?),
                ),
            ]));
    }

    let mut environment_items = Vec::with_capacity(environments.len());
    for environment in &environments {
        let env = col_text(environment, "env")?;
        let base_urls = col_opt_json(environment, "base_urls")?.unwrap_or(Value::Null);
        let record = as_record(&base_urls);
        let base_url = record
            .get(&env)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                record
                    .values()
                    .find_map(|value| value.as_str().map(str::to_owned))
            })
            .unwrap_or_default();
        environment_items.push(object(vec![
            ("env", Value::String(env)),
            ("baseUrl", Value::String(base_url)),
            ("baseUrls", base_urls),
            (
                "allowedHosts",
                Value::Array(as_string_array(
                    &col_opt_json(environment, "allowed_hosts")?.unwrap_or(Value::Null),
                )),
            ),
            (
                "inboundIpAllowlist",
                Value::Array(as_string_array(
                    &col_opt_json(environment, "inbound_ip_allowlist")?.unwrap_or(Value::Null),
                )),
            ),
            ("enabled", Value::Bool(col_bool(environment, "enabled")?)),
        ]));
    }

    let mut auth_values = auth_rows.iter();
    let selected_auth = auth_rows
        .iter()
        .find(|row| {
            row.try_get::<String, _>("env")
                .map(|env| env == "LIVE")
                .unwrap_or(false)
        })
        .or_else(|| auth_values.next());
    let (auth_method, auth_apply, auth_config) = match selected_auth {
        Some(row) => (
            col_text(row, "method")?,
            col_text(row, "auth_apply")?,
            as_record(&col_opt_json(row, "refresh_config_json")?.unwrap_or(Value::Null)),
        ),
        None => ("API_KEY".to_owned(), "HEADER".to_owned(), Map::new()),
    };
    let string_key = |key: &str| {
        auth_config
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let extra_headers = as_record_array(auth_config.get("extraHeaders").unwrap_or(&Value::Null))
        .into_iter()
        .map(|entry| {
            object(vec![
                (
                    "key",
                    Value::String(
                        entry
                            .get("key")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                ),
                (
                    "value",
                    Value::String(
                        entry
                            .get("value")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                ),
            ])
        })
        .collect::<Vec<_>>();
    let auth = object(vec![
        ("method", Value::String(auth_method)),
        ("authApply", Value::String(auth_apply)),
        ("username", Value::String(string_key("username"))),
        ("keyRef", Value::String(string_key("keyRef"))),
        (
            "tokenUrl",
            Value::String(
                auth_config
                    .get("tokenUrl")
                    .and_then(Value::as_str)
                    .or_else(|| auth_config.get("token_endpoint").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_owned(),
            ),
        ),
        ("clientIdRef", Value::String(string_key("clientIdRef"))),
        (
            "clientSecretRef",
            Value::String(string_key("clientSecretRef")),
        ),
        ("extraHeaders", Value::Array(extra_headers)),
    ]);

    let mut credential_items = Vec::with_capacity(credential_rows.len());
    for credential in &credential_rows {
        let credential_id = col_uuid(credential, "id")?;
        let label = col_opt_text(credential, "external_merchant_id")?
            .unwrap_or_else(|| credential_id.chars().take(8).collect());
        credential_items.push(object(vec![
            ("id", Value::String(credential_id)),
            ("label", Value::String(label)),
            (
                "ownerType",
                Value::String(col_text(credential, "owner_type")?),
            ),
            (
                "settlementTarget",
                Value::String(col_text(credential, "settlement_target")?),
            ),
            ("env", Value::String(col_text(credential, "env")?)),
            ("secret", Value::String(String::new())),
            ("secretRef", Value::String(String::new())),
            ("status", Value::String(col_text(credential, "status")?)),
        ]));
    }

    let crypto_items = crypto_profiles
        .iter()
        .map(|profile| {
            let encoding = match col_text(profile, "secret_key_encoding")?.as_str() {
                "UTF8" => "utf8",
                "HEX" => "hex",
                _ => "base64",
            };
            Ok(object(vec![
                ("id", Value::String(col_uuid(profile, "id")?)),
                ("name", Value::String(col_text(profile, "name")?)),
                ("direction", Value::String(col_text(profile, "purpose")?)),
                ("algorithm", Value::String(col_text(profile, "algorithm")?)),
                ("keyEncoding", Value::String(encoding.to_owned())),
                (
                    "canonicalization",
                    Value::String(col_text(profile, "canonicalization_mode")?),
                ),
                (
                    "secretRef",
                    col_opt_text(profile, "secret_key_ref")?
                        .unwrap_or_default()
                        .into(),
                ),
                (
                    "fields",
                    Value::Array(as_string_array(
                        &col_opt_json(profile, "included_fields")?.unwrap_or(Value::Null),
                    )),
                ),
                ("toleranceSeconds", Value::from(300)),
            ]))
        })
        .collect::<Result<Vec<Value>, ApiError>>()?;
    let mut crypto_items = crypto_items;
    for item in &mut crypto_items {
        if let Some(map) = item.as_object_mut() {
            if let Some(secret_ref) = map.get("secretRef").cloned() {
                if secret_ref.is_null() {
                    map.insert("secretRef".to_owned(), Value::String(String::new()));
                }
            }
        }
    }

    let mut flow_items = Vec::with_capacity(flows.len());
    for flow in &flows {
        let flow_id = col_uuid(flow, "id")?;
        let flow_phase = col_text(flow, "phase")?;
        let mut step_items = Vec::new();
        for step in steps.iter().filter(|step| {
            step.try_get::<Uuid, _>("flow_id")
                .map(|id| id.to_string() == flow_id)
                .unwrap_or(false)
        }) {
            let step_type = col_text(step, "type")?;
            let method = col_opt_text(step, "method")?;
            step_items.push(object(vec![
                ("id", Value::String(col_uuid(step, "id")?)),
                ("phase", Value::String(flow_phase.clone())),
                ("order", Value::from(col_i32(step, "order_index")?)),
                ("type", Value::String(step_type.clone())),
                (
                    "name",
                    Value::String(method.clone().unwrap_or_else(|| step_type.clone())),
                ),
                ("method", Value::String(method.unwrap_or_default())),
                (
                    "url",
                    Value::String(col_opt_text(step, "url_template")?.unwrap_or_default()),
                ),
                ("sideEffect", Value::String(col_text(step, "side_effect")?)),
                (
                    "retryPolicy",
                    Value::String(col_text(step, "retry_policy")?),
                ),
                ("idempotencyConfig", Value::String(String::new())),
                (
                    "pointOfNoReturn",
                    Value::Bool(col_bool(step, "point_of_no_return")?),
                ),
                ("transforms", Value::Array(Vec::new())),
                ("assertExpression", Value::String(String::new())),
                ("outputName", Value::String(String::new())),
            ]));
        }
        flow_items.push(object(vec![
            ("id", Value::String(flow_id)),
            ("phase", Value::String(flow_phase)),
            ("steps", Value::Array(step_items)),
        ]));
    }

    let status_items = status_rules
        .iter()
        .map(|rule| {
            let canonical = col_text(rule, "canonical_status")?;
            Ok(object(vec![
                ("id", Value::String(col_uuid(rule, "id")?)),
                ("gatewayCode", Value::String(col_text(rule, "selector")?)),
                ("canonicalStatus", Value::String(canonical.clone())),
                (
                    "messageAr",
                    Value::String(col_opt_text(rule, "canonical_error")?.unwrap_or_default()),
                ),
                (
                    "messageEn",
                    Value::String(col_opt_text(rule, "canonical_substatus")?.unwrap_or_default()),
                ),
                (
                    "terminal",
                    Value::Bool(canonical == "SUCCEEDED" || canonical == "FAILED"),
                ),
            ]))
        })
        .collect::<Result<Vec<Value>, ApiError>>()?;
    let error_items = error_maps
        .iter()
        .map(|entry| {
            Ok(object(vec![
                ("id", Value::String(col_uuid(entry, "id")?)),
                (
                    "gatewayCode",
                    Value::String(col_text(entry, "gateway_code")?),
                ),
                (
                    "canonicalStatus",
                    Value::String(col_text(entry, "canonical_error")?),
                ),
                ("retryable", Value::Bool(col_bool(entry, "retryable")?)),
                (
                    "otpRetryable",
                    Value::Bool(col_text(entry, "classification")? == "RETRYABLE_OTP"),
                ),
                (
                    "messageAr",
                    Value::String(col_opt_text(entry, "customer_message_ar")?.unwrap_or_default()),
                ),
                (
                    "messageEn",
                    Value::String(col_opt_text(entry, "customer_message_en")?.unwrap_or_default()),
                ),
            ]))
        })
        .collect::<Result<Vec<Value>, ApiError>>()?;
    let channel_items = channels
        .iter()
        .map(|channel| {
            let kind = match col_text(channel, "type")?.as_str() {
                "POLL" => "INQUIRY_POLL".to_owned(),
                other => other.to_owned(),
            };
            let event_map =
                as_record_array(&col_opt_json(channel, "event_map")?.unwrap_or(Value::Null))
                    .into_iter()
                    .map(|entry| {
                        object(vec![
                            (
                                "event",
                                Value::String(
                                    entry
                                        .get("event")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                ),
                            ),
                            (
                                "canonical",
                                Value::String(
                                    entry
                                        .get("canonical")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                ),
                            ),
                        ])
                    })
                    .collect::<Vec<_>>();
            Ok(object(vec![
                ("id", Value::String(col_uuid(channel, "id")?)),
                ("kind", Value::String(kind)),
                ("name", Value::String(col_text(channel, "path_token")?)),
                ("eventMap", Value::Array(event_map)),
                (
                    "secretRef",
                    col_opt_uuid(channel, "crypto_profile_id")?
                        .unwrap_or_default()
                        .into(),
                ),
                (
                    "ipAllowlist",
                    Value::Array(as_string_array(
                        &col_opt_json(channel, "ip_allowlist")?.unwrap_or(Value::Null),
                    )),
                ),
                (
                    "mustInquire",
                    Value::Bool(col_bool(channel, "must_inquire")?),
                ),
                (
                    "timestampToleranceSeconds",
                    Value::from(col_i32(channel, "timestamp_tolerance_sec")?),
                ),
            ]))
        })
        .collect::<Result<Vec<Value>, ApiError>>()?;
    let mut channel_items = channel_items;
    for item in &mut channel_items {
        if let Some(map) = item.as_object_mut() {
            if map.get("secretRef").is_some_and(Value::is_null) {
                map.insert("secretRef".to_owned(), Value::String(String::new()));
            }
        }
    }

    let mut rails: Vec<Value> = Vec::new();
    let mut seen_rails: HashMap<String, usize> = HashMap::new();
    let mut client_actions: Vec<Value> = Vec::new();
    let mut poll_policies: Vec<Value> = Vec::new();
    let mut cost_model = Map::new();
    let mut cost_model_set = false;
    for route in &routes {
        let rail_id = col_uuid(route, "rail_id")?;
        let rail_code = col_text(route, "rail_code")?;
        let route_id = col_uuid(route, "id")?;
        if !seen_rails.contains_key(&rail_id) {
            let capabilities =
                as_record(&col_opt_json(route, "capabilities")?.unwrap_or(Value::Null))
                    .into_iter()
                    .filter_map(|(key, value)| (value == Value::Bool(true)).then_some(key))
                    .map(Value::String)
                    .collect::<Vec<_>>();
            seen_rails.insert(rail_id.clone(), rails.len());
            rails.push(object(vec![
                ("id", Value::String(rail_id.clone())),
                ("routeId", Value::String(route_id.clone())),
                ("code", Value::String(rail_code.clone())),
                ("nameAr", Value::String(col_text(route, "name_ar")?)),
                ("nameEn", Value::String(col_text(route, "name_en")?)),
                (
                    "collectionMode",
                    Value::String(col_text(route, "collection_mode")?),
                ),
                ("currency", Value::String(col_text(route, "currency")?)),
                (
                    "minAmount",
                    decimal_json(Some(super::col_decimal(route, "min_amount")?)),
                ),
                (
                    "maxAmount",
                    match super::col_opt_decimal(route, "max_amount")? {
                        Some(amount) => Value::String(super::decimal_text(amount)),
                        None => Value::String(String::new()),
                    },
                ),
                ("capabilities", Value::Array(capabilities)),
                (
                    "fields",
                    Value::Array(fields_by_rail.remove(&rail_id).unwrap_or_default()),
                ),
            ]));
        }
        if !cost_model_set {
            cost_model = as_record(&col_opt_json(route, "cost_model")?.unwrap_or(Value::Null));
            cost_model_set = true;
        }
        for widget in widgets_by_route.get(&route_id).cloned().unwrap_or_default() {
            let id = widget.get("id").cloned().unwrap_or(Value::Null);
            client_actions.push(object(vec![
                ("id", id),
                ("kind", Value::String("RENDER_EMBEDDED".to_owned())),
                ("name", Value::String(rail_code.clone())),
                (
                    "scriptUrls",
                    Value::Array(as_string_array(
                        widget.get("script_urls").unwrap_or(&Value::Null),
                    )),
                ),
                (
                    "scriptSriHashes",
                    Value::Array(as_string_array(
                        widget.get("script_sri_hashes").unwrap_or(&Value::Null),
                    )),
                ),
                (
                    "allowedOrigins",
                    Value::Array(as_string_array(
                        widget.get("allowed_origins").unwrap_or(&Value::Null),
                    )),
                ),
                (
                    "iframeSandbox",
                    widget.get("iframe_sandbox").cloned().unwrap_or(Value::Null),
                ),
                ("otpLength", Value::from(6)),
                ("maxOtpAttempts", Value::from(3)),
                ("resendCooldownSeconds", Value::from(30)),
                ("redirectMethod", Value::String("GET".to_owned())),
                ("redirectUrl", Value::String(String::new())),
                ("qrPayload", Value::String(String::new())),
                ("payCode", Value::String(String::new())),
                ("instructionsAr", Value::String(String::new())),
                ("instructionsEn", Value::String(String::new())),
                ("deepLinkUrl", Value::String(String::new())),
                ("walletHint", Value::String(String::new())),
                ("destinationAccount", Value::String(String::new())),
            ]));
        }
        for redirect in redirects_by_route
            .get(&route_id)
            .cloned()
            .unwrap_or_default()
        {
            let method = redirect
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_owned();
            client_actions.push(object(vec![
                ("id", redirect.get("id").cloned().unwrap_or(Value::Null)),
                ("kind", Value::String("HTTP_REDIRECT".to_owned())),
                ("name", Value::String(rail_code.clone())),
                ("scriptUrls", Value::Array(Vec::new())),
                ("scriptSriHashes", Value::Array(Vec::new())),
                ("allowedOrigins", Value::Array(Vec::new())),
                ("iframeSandbox", Value::String(String::new())),
                ("otpLength", Value::from(6)),
                ("maxOtpAttempts", Value::from(3)),
                ("resendCooldownSeconds", Value::from(30)),
                (
                    "redirectMethod",
                    Value::String(if method == "POST_FORM" {
                        "POST_FORM".to_owned()
                    } else {
                        "GET".to_owned()
                    }),
                ),
                (
                    "redirectUrl",
                    redirect
                        .get("urlSourceOutput")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                ("qrPayload", Value::String(String::new())),
                ("payCode", Value::String(String::new())),
                ("instructionsAr", Value::String(String::new())),
                ("instructionsEn", Value::String(String::new())),
                ("deepLinkUrl", Value::String(String::new())),
                ("walletHint", Value::String(String::new())),
                ("destinationAccount", Value::String(String::new())),
            ]));
        }
        for policy in polls_by_route.get(&route_id).cloned().unwrap_or_default() {
            let schedule = policy.get("backoffSeconds").cloned().unwrap_or(Value::Null);
            let numbers = as_number_array(&schedule);
            poll_policies.push(object(vec![
                ("id", policy.get("id").cloned().unwrap_or(Value::Null)),
                ("name", Value::String(rail_code.clone())),
                (
                    "intervalSeconds",
                    policy
                        .get("firstAfterSeconds")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                ("backoffSchedule", Value::Array(numbers.clone())),
                ("maxAttempts", Value::from(numbers.len() as i64)),
                (
                    "timeoutSeconds",
                    policy
                        .get("maxDurationSeconds")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
            ]));
        }
    }

    let (scale, precision, rounding) = match &setting {
        Some(row) => (
            col_i32(row, "amount_scale")?,
            col_i32(row, "amount_precision")?,
            col_text(row, "amount_rounding")?,
        ),
        None => (1, 3, "NONE".to_owned()),
    };
    let cost_value = |key: &str| {
        cost_model
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("0")
            .to_owned()
    };
    let cost_currency = cost_model
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("LYD")
        .to_owned();

    Ok(object(vec![
        ("id", Value::String(id.to_string())),
        ("versionId", Value::String(id.to_string())),
        (
            "gatewayId",
            Value::String(col_uuid(&version, "gateway_id")?),
        ),
        (
            "versionNumber",
            Value::from(col_i32(&version, "version_number")?),
        ),
        ("state", Value::String(col_text(&version, "state")?)),
        (
            "rollbackVersionId",
            col_opt_uuid(&version, "rollback_version_id")?.map_or(Value::Null, Value::String),
        ),
        (
            "identity",
            object(vec![
                ("code", Value::String(col_text(&version, "code")?)),
                ("name", Value::String(col_text(&version, "name")?)),
                ("operator", Value::String(col_text(&version, "operator")?)),
                ("country", Value::String(col_text(&version, "country")?)),
                (
                    "aliases",
                    Value::Array(as_string_array(
                        &col_opt_json(&version, "aliases")?.unwrap_or(Value::Null),
                    )),
                ),
                ("kind", Value::String(col_text(&version, "kind")?)),
                (
                    "verificationState",
                    Value::String(col_text(&version, "verification_state")?),
                ),
                (
                    "riskClass",
                    Value::String(col_text(&version, "risk_class")?),
                ),
            ]),
        ),
        ("environments", Value::Array(environment_items)),
        ("auth", auth),
        ("credentialSets", Value::Array(credential_items)),
        ("rails", Value::Array(rails)),
        ("cryptoProfiles", Value::Array(crypto_items)),
        ("flows", Value::Array(flow_items)),
        ("clientActions", Value::Array(client_actions)),
        ("confirmationChannels", Value::Array(channel_items)),
        ("pollPolicies", Value::Array(poll_policies)),
        ("statusRules", Value::Array(status_items)),
        ("errorMaps", Value::Array(error_items)),
        (
            "amountPipeline",
            object(vec![
                ("scale", Value::from(scale)),
                ("precision", Value::from(precision)),
                ("rounding", Value::String(rounding)),
                ("currency", Value::String("LYD".to_owned())),
            ]),
        ),
        (
            "costModel",
            object(vec![
                ("model", Value::String("FLAT".to_owned())),
                ("flatFee", Value::String(cost_value("flatFee"))),
                ("percentFee", Value::String(cost_value("percentFee"))),
                ("minFee", Value::String(cost_value("minFee"))),
                ("maxFee", Value::String(cost_value("maxFee"))),
                ("currency", Value::String(cost_currency)),
            ]),
        ),
        (
            "statementMapping",
            object(vec![
                ("sourceId", Value::String(String::new())),
                ("format", Value::String("CSV".to_owned())),
                ("delimiter", Value::String(",".to_owned())),
                ("columnMapping", Value::Array(Vec::new())),
            ]),
        ),
    ]))
}

fn wizard_field_type(field_type: &str) -> String {
    match field_type {
        "NUMBER" => "numeric",
        "PHONE" => "phone",
        "WALLET_ID" => "wallet_id",
        "OTP" => "otp",
        "FROM_LIST" => "select",
        _ => "text",
    }
    .to_owned()
}
