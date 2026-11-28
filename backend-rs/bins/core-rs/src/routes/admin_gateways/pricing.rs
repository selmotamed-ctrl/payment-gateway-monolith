//! Commission-profile and velocity-rule reads.
//!
//! Ports `admin.ts:18758-18893` and `:18955-19072`. Neither collection is paged in TypeScript
//! (the tables are small operator configuration) and both attach the pending approval id of their
//! maker-checker lifecycle. Audit history reads the compatibility `audit_log` rows plus the actor
//! identity, exactly like the Prisma `include`.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use pg_http::ApiError;
use serde_json::{Map, Value};

use super::super::common;
use super::{
    col_date, col_opt_date, col_opt_decimal, col_opt_text, col_opt_uuid, col_text, col_uuid,
    decimal_json, get_json, not_found, object, pending_approval_ids, uuid_param,
};
use crate::state::AppState;

const COMMISSION_COLUMNS: &str = "id, created_at, updated_at, merchant_id, application_id,
    rail_code, calc_type::text AS calc_type, flat_fee, percentage_rate, tiers_json, min_fee,
    max_fee, fee_bearer_default::text AS fee_bearer_default, rounding_mode, effective_from,
    effective_to, version, approval_request_id, seed_key";

fn commission_row(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("createdAt", Value::String(col_date(row, "created_at")?)),
        ("updatedAt", Value::String(col_date(row, "updated_at")?)),
        (
            "merchantId",
            col_opt_uuid(row, "merchant_id")?.map_or(Value::Null, Value::String),
        ),
        (
            "applicationId",
            col_opt_uuid(row, "application_id")?.map_or(Value::Null, Value::String),
        ),
        ("railCode", Value::String(col_text(row, "rail_code")?)),
        ("calcType", Value::String(col_text(row, "calc_type")?)),
        (
            "flatFee",
            decimal_json(Some(super::col_decimal(row, "flat_fee")?)),
        ),
        (
            "percentageRate",
            decimal_json(Some(super::col_decimal(row, "percentage_rate")?)),
        ),
        (
            "tiersJson",
            super::col_opt_json(row, "tiers_json")?.unwrap_or(Value::Null),
        ),
        (
            "minFee",
            decimal_json(Some(super::col_decimal(row, "min_fee")?)),
        ),
        ("maxFee", decimal_json(col_opt_decimal(row, "max_fee")?)),
        (
            "feeBearerDefault",
            Value::String(col_text(row, "fee_bearer_default")?),
        ),
        (
            "roundingMode",
            Value::String(col_text(row, "rounding_mode")?),
        ),
        (
            "effectiveFrom",
            Value::String(col_date(row, "effective_from")?),
        ),
        (
            "effectiveTo",
            col_opt_date(row, "effective_to")?.map_or(Value::Null, Value::String),
        ),
        ("version", Value::from(super::col_i32(row, "version")?)),
        (
            "approvalRequestId",
            col_opt_uuid(row, "approval_request_id")?.map_or(Value::Null, Value::String),
        ),
        (
            "seedKey",
            col_opt_text(row, "seed_key")?.map_or(Value::Null, Value::String),
        ),
    ]))
}

get_json!(commission_profiles, commission_list);
async fn commission_list(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let sql = format!("SELECT {COMMISSION_COLUMNS} FROM commission_profiles ORDER BY rail_code ASC, created_at ASC, id ASC");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let pending = pending_approval_ids(state, "COMMISSION_PROFILE").await?;
    let mut profiles = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = col_uuid(row, "id")?;
        let mut profile = commission_row(row)?;
        if let Some(map) = profile.as_object_mut() {
            map.insert(
                "pendingApprovalId".to_owned(),
                pending
                    .get(&id)
                    .map_or(Value::Null, |approval| Value::String(approval.clone())),
            );
        }
        profiles.push(profile);
    }
    Ok(object(vec![("profiles", Value::Array(profiles))]))
}

get_json!(commission_summary, commission_summary_handler);
async fn commission_summary_handler(
    state: &AppState,
    _request: &HttpRequest,
) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT id, rail_code, calc_type::text AS calc_type, merchant_id, application_id, max_fee
           FROM commission_profiles",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let pending = pending_approval_ids(state, "COMMISSION_PROFILE").await?;

    let mut by_calc_type = Map::new();
    let mut by_rail = Map::new();
    let mut merchant_scoped = 0_i64;
    let mut application_scoped = 0_i64;
    let mut global_scoped = 0_i64;
    let mut with_max_fee = 0_i64;
    let mut pending_lifecycle = 0_i64;
    for row in &rows {
        let calc_type = col_text(row, "calc_type")?;
        let rail = col_text(row, "rail_code")?;
        increment(&mut by_calc_type, &calc_type);
        increment(&mut by_rail, &rail);
        let merchant = col_opt_uuid(row, "merchant_id")?;
        let application = col_opt_uuid(row, "application_id")?;
        if merchant.is_some() {
            merchant_scoped += 1;
        }
        if application.is_some() {
            application_scoped += 1;
        }
        if merchant.is_none() && application.is_none() {
            global_scoped += 1;
        }
        if col_opt_decimal(row, "max_fee")?.is_some() {
            with_max_fee += 1;
        }
        if pending.contains_key(&col_uuid(row, "id")?) {
            pending_lifecycle += 1;
        }
    }
    Ok(object(vec![(
        "summary",
        object(vec![
            ("total", Value::from(rows.len() as i64)),
            ("merchantScoped", Value::from(merchant_scoped)),
            ("applicationScoped", Value::from(application_scoped)),
            ("globalScoped", Value::from(global_scoped)),
            ("withMaxFee", Value::from(with_max_fee)),
            ("pendingLifecycle", Value::from(pending_lifecycle)),
            ("byCalcType", Value::Object(by_calc_type)),
            ("byRail", Value::Object(by_rail)),
        ]),
    )]))
}

get_json!(commission_history, commission_history_handler);
async fn commission_history_handler(
    state: &AppState,
    request: &HttpRequest,
) -> Result<Value, ApiError> {
    commission_history_body(
        state,
        request,
        "COMMISSION_PROFILE",
        "COMMISSION_PROFILE_NOT_FOUND",
    )
    .await
}

get_json!(velocity_rules, velocity_list);
async fn velocity_list(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT id, created_at, updated_at, scope_type::text AS scope_type, scope_value,
                window_seconds, max_count, max_amount, action::text AS action, active, version,
                effective_from, effective_to, approval_request_id
           FROM velocity_rules
          ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let pending = pending_approval_ids(state, "VELOCITY_RULE").await?;
    let mut rules = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = col_uuid(row, "id")?;
        let mut rule = object(vec![
            ("id", Value::String(id.clone())),
            ("createdAt", Value::String(col_date(row, "created_at")?)),
            ("updatedAt", Value::String(col_date(row, "updated_at")?)),
            ("scopeType", Value::String(col_text(row, "scope_type")?)),
            (
                "scopeValue",
                col_opt_text(row, "scope_value")?.map_or(Value::Null, Value::String),
            ),
            (
                "windowSeconds",
                Value::from(super::col_i32(row, "window_seconds")?),
            ),
            ("maxCount", Value::from(super::col_i32(row, "max_count")?)),
            (
                "maxAmount",
                decimal_json(col_opt_decimal(row, "max_amount")?),
            ),
            ("action", Value::String(col_text(row, "action")?)),
            ("active", Value::Bool(super::col_bool(row, "active")?)),
            ("version", Value::from(super::col_i32(row, "version")?)),
            (
                "effectiveFrom",
                Value::String(col_date(row, "effective_from")?),
            ),
            (
                "effectiveTo",
                col_opt_date(row, "effective_to")?.map_or(Value::Null, Value::String),
            ),
            (
                "approvalRequestId",
                col_opt_uuid(row, "approval_request_id")?.map_or(Value::Null, Value::String),
            ),
        ]);
        if let Some(map) = rule.as_object_mut() {
            map.insert(
                "pendingApprovalId".to_owned(),
                pending
                    .get(&id)
                    .map_or(Value::Null, |approval| Value::String(approval.clone())),
            );
        }
        rules.push(rule);
    }
    Ok(object(vec![("rules", Value::Array(rules))]))
}

get_json!(velocity_summary, velocity_summary_handler);
async fn velocity_summary_handler(
    state: &AppState,
    _request: &HttpRequest,
) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT id, scope_type::text AS scope_type, action::text AS action, window_seconds, max_amount
           FROM velocity_rules",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let pending = pending_approval_ids(state, "VELOCITY_RULE").await?;

    let mut by_scope = Map::new();
    let mut by_action = Map::new();
    let mut reject = 0_i64;
    let mut flag = 0_i64;
    let mut with_amount_cap = 0_i64;
    let mut pending_lifecycle = 0_i64;
    let mut longest_window = 0_i32;
    for row in &rows {
        let scope = col_text(row, "scope_type")?;
        let action = col_text(row, "action")?;
        increment(&mut by_scope, &scope);
        increment(&mut by_action, &action);
        match action.as_str() {
            "REJECT" => reject += 1,
            "FLAG" => flag += 1,
            _ => {}
        }
        if col_opt_decimal(row, "max_amount")?.is_some() {
            with_amount_cap += 1;
        }
        if pending.contains_key(&col_uuid(row, "id")?) {
            pending_lifecycle += 1;
        }
        longest_window = longest_window.max(super::col_i32(row, "window_seconds")?);
    }
    Ok(object(vec![(
        "summary",
        object(vec![
            ("total", Value::from(rows.len() as i64)),
            ("reject", Value::from(reject)),
            ("flag", Value::from(flag)),
            ("withAmountCap", Value::from(with_amount_cap)),
            ("pendingLifecycle", Value::from(pending_lifecycle)),
            ("longestWindowSeconds", Value::from(longest_window)),
            ("byScopeType", Value::Object(by_scope)),
            ("byAction", Value::Object(by_action)),
        ]),
    )]))
}

get_json!(velocity_history, velocity_history_handler);
async fn velocity_history_handler(
    state: &AppState,
    request: &HttpRequest,
) -> Result<Value, ApiError> {
    velocity_history_body(state, request).await
}

fn increment(map: &mut Map<String, Value>, key: &str) {
    let count = map.get(key).and_then(Value::as_i64).unwrap_or(0) + 1;
    map.insert(key.to_owned(), Value::from(count));
}

async fn commission_history_body(
    state: &AppState,
    request: &HttpRequest,
    entity_type: &str,
    not_found_code: &str,
) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 1)?;
    let table = if entity_type == "COMMISSION_PROFILE" {
        "commission_profiles"
    } else {
        "velocity_rules"
    };
    let exists = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM {table} WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let message = if entity_type == "COMMISSION_PROFILE" {
        "The commission profile does not exist"
    } else {
        "The velocity rule does not exist"
    };
    if exists.is_none() {
        return Err(not_found(not_found_code, message));
    }
    let history = history_rows(state, entity_type, id).await?;
    Ok(object(vec![("history", Value::Array(history))]))
}

async fn velocity_history_body(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    commission_history_body(state, request, "VELOCITY_RULE", "VELOCITY_RULE_NOT_FOUND").await
}

async fn history_rows(
    state: &AppState,
    entity_type: &str,
    id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT a.id, a.created_at, a.role, a.action, a.before_json, a.after_json,
                a.approval_request_id, u.id AS actor_user_id, u.email AS actor_email
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = $1 AND a.entity_id = $2
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 100",
    )
    .bind(entity_type)
    .bind(id.to_string())
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let mut history = Vec::with_capacity(rows.len());
    for row in &rows {
        let actor = match col_opt_uuid(row, "actor_user_id")? {
            Some(actor_id) => object(vec![
                ("id", Value::String(actor_id)),
                (
                    "email",
                    col_opt_text(row, "actor_email")?.map_or(Value::Null, Value::String),
                ),
            ]),
            None => Value::Null,
        };
        history.push(object(vec![
            ("id", Value::String(col_uuid(row, "id")?)),
            ("createdAt", Value::String(col_date(row, "created_at")?)),
            ("action", Value::String(col_text(row, "action")?)),
            ("role", Value::String(col_text(row, "role")?)),
            ("beforeJson", super::col_json(row, "before_json")?),
            ("afterJson", super::col_json(row, "after_json")?),
            (
                "approvalRequestId",
                col_opt_uuid(row, "approval_request_id")?.map_or(Value::Null, Value::String),
            ),
            ("actor", actor),
        ]));
    }
    Ok(history)
}
