//! Admin reconciliation reads: statement sources, ingestion runs, summaries and run exports.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/reconciliation/sources`, `/reconciliation/runs`,
//! `/reconciliation/runs/:id`, `/reconciliation/summary` and exports). The original statement
//! download (`GET /reconciliation/runs/:id/statement`) reads the shared object-storage vault and
//! belongs to P4-T05; the metadata and item views are database reads and are ported here.

#![forbid(unsafe_code)]

use chrono::Duration;
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    build_list, count_always, fetch_list, jsonb, jsonb_or_empty_object, list_envelope, money,
    query_string, require_uuid_param, source_display_name, text, ts_json, uuid_json,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/reconciliation/sources",
            "core-back/api/internal/admin.ts:17077",
            &["reconciliation:read"],
            sources_handler,
        ),
        route(
            "/internal/admin/reconciliation/runs",
            "core-back/api/internal/admin.ts:17258",
            &["reconciliation:read"],
            runs_handler,
        ),
        route(
            "/internal/admin/reconciliation/summary",
            "core-back/api/internal/admin.ts:17329",
            &["reconciliation:read"],
            summary_handler,
        ),
        route(
            "/internal/admin/reconciliation/summary/export",
            "core-back/api/internal/admin.ts:17334",
            &["reconciliation:read"],
            summary_export_handler,
        ),
        route(
            "/internal/admin/reconciliation/runs/:id/export",
            "core-back/api/internal/admin.ts:17464",
            &["reconciliation:read"],
            run_export_handler,
        ),
        route(
            "/internal/admin/reconciliation/runs/:id",
            "core-back/api/internal/admin.ts:17370",
            &["reconciliation:read"],
            run_detail_handler,
        ),
    ]
}

fn route(
    path: &str,
    origin: &str,
    authorities: &[&str],
    handler: crate::routes::CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

// ---------------------------------------------------------------- sources

fn source_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "ss.id", ColumnKind::Uuid)
        .with("createdAt", "ss.created_at", ColumnKind::Timestamp)
        .with("gatewayId", "ss.gateway_id", ColumnKind::Uuid)
        .with("gatewayCode", "g.code", ColumnKind::Text)
        .with("gatewayName", "g.name", ColumnKind::Text)
}

fn source_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["gatewayCode", "gatewayName"])
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("name", "gatewayId")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
}

const SOURCE_FROM: &str = "statement_sources ss JOIN gateways g ON g.id = ss.gateway_id";
const SOURCE_PROJECTION: &str =
    "ss.id, ss.created_at, ss.updated_at, ss.gateway_id, ss.type::text AS type,
    ss.parser_config, ss.currency, ss.env, ss.credential_set_id, ss.schedule_cron,
    ss.settlement_lag_days, ss.dedupe_key_template,
    g.code AS gateway_code, g.name AS gateway_name";

fn source_row(row: &sqlx::postgres::PgRow) -> Value {
    let parser = match jsonb(row, "parser_config") {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    let source_type = text(row, "type");
    let format = parser
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or(&source_type)
        .to_owned();
    let delimiter = parser
        .get("delimiter")
        .and_then(Value::as_str)
        .unwrap_or(",")
        .to_owned();
    let currency = super::support::opt_text(row, "currency")
        .or_else(|| {
            parser
                .get("currency")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "LYD".to_owned());
    let active = parser.get("active").and_then(Value::as_bool) != Some(false);
    let columns = parser
        .get("columns")
        .or_else(|| parser.get("columnMapping"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "id": uuid_json(row, "id"),
        "name": source_display_name(super::support::opt_text(row, "gateway_name").as_deref(), &source_type),
        "gatewayId": uuid_json(row, "gateway_id"),
        "gatewayCode": text(row, "gateway_code"),
        "type": source_type,
        "format": format,
        "delimiter": delimiter,
        "currency": currency,
        "env": super::support::text_value(row, "env"),
        "credentialSetId": uuid_json(row, "credential_set_id"),
        "scheduleCron": super::support::text_value(row, "schedule_cron"),
        "settlementLagDays": super::support::int_json(row, "settlement_lag_days"),
        "dedupeKeyTemplate": super::support::text_value(row, "dedupe_key_template"),
        "active": active,
        "columnMapping": columns,
        "parserConfig": parser,
        "createdAt": ts_json(row, "created_at"),
        "updatedAt": ts_json(row, "updated_at"),
    })
}

async fn sources(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &source_spec(), &source_columns())?;
    let rows = fetch_list(
        &state.pools.main,
        &built,
        SOURCE_PROJECTION,
        SOURCE_FROM,
        None,
    )
    .await?;
    let total = count_always(&state.pools.main, &built, SOURCE_FROM, None).await?;
    let items: Vec<Value> = rows.iter().map(source_row).collect();
    let response = list_envelope("sources", Value::Array(items), Some(total), &built);
    Ok(super::support::with_cursor(
        response,
        &built,
        &rows,
        "created_at",
    ))
}

// ---------------------------------------------------------------- runs

fn run_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "r.id", ColumnKind::Uuid)
        .with("createdAt", "r.created_at", ColumnKind::Timestamp)
        .with("ingestedAt", "r.ingested_at", ColumnKind::Timestamp)
        .with("fileName", "r.file_name", ColumnKind::Text)
        .with(
            "statementSourceId",
            "r.statement_source_id",
            ColumnKind::Uuid,
        )
}

fn run_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["fileName"])
        .with_equals("statementSourceId", "statementSourceId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("fileName", "fileName")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("ingestedAt", "ingestedAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

const RUN_FROM: &str = "reconciliation_runs r
    LEFT JOIN statement_sources ss ON ss.id = r.statement_source_id
    LEFT JOIN gateways g ON g.id = ss.gateway_id";

const RUN_PROJECTION: &str =
    "r.id, r.created_at, r.ingested_at, r.statement_source_id, r.file_name,
    r.file_hash, r.storage_object_id, r.stats_json, r.window_start, r.window_end, r.currency,
    ss.type::text AS source_type, g.name AS gateway_name";

fn numeric_stat(stats: &Value, keys: &[&str]) -> i64 {
    for key in keys {
        match stats.get(*key) {
            Some(Value::Number(number)) => {
                if let Some(value) = number.as_i64() {
                    return value;
                }
                if let Some(value) = number.as_f64() {
                    return value as i64;
                }
            }
            Some(Value::String(value)) => {
                if let Ok(parsed) = value.parse::<i64>() {
                    return parsed;
                }
            }
            _ => {}
        }
    }
    0
}

fn run_stats(row: &sqlx::postgres::PgRow) -> (i64, i64, i64, i64, i64, i64, i64, i64) {
    let stats = jsonb_or_empty_object(row, "stats_json");
    let total_rows = numeric_stat(&stats, &["totalRows", "statementLines"]);
    let matched = numeric_stat(&stats, &["matched"]);
    let amount_mismatch = numeric_stat(&stats, &["amountMismatch"]);
    let missing_at_gateway = numeric_stat(&stats, &["missingAtGateway"]);
    let missing_locally = numeric_stat(&stats, &["missingLocally"]);
    let duplicates = numeric_stat(&stats, &["duplicates"]);
    let fee_variances = numeric_stat(&stats, &["feeVariances"]);
    let unmatched = if stats.get("mismatched").is_some() || stats.get("amountMismatch").is_some() {
        numeric_stat(&stats, &["mismatched", "amountMismatch"])
    } else {
        amount_mismatch + missing_at_gateway + missing_locally + duplicates
    };
    (
        total_rows,
        matched,
        unmatched,
        amount_mismatch,
        missing_at_gateway,
        missing_locally,
        duplicates,
        fee_variances,
    )
}

fn match_rate(matched: i64, total: i64) -> String {
    if total == 0 {
        return "0.0000".to_owned();
    }
    let rate = Decimal::from(matched) * Decimal::from(100) / Decimal::from(total);
    pg_types::Money4(rate).to_string()
}

fn run_row(row: &sqlx::postgres::PgRow) -> Value {
    let stats = jsonb_or_empty_object(row, "stats_json");
    let (
        total_rows,
        matched,
        unmatched,
        amount_mismatch,
        missing_at_gateway,
        missing_locally,
        duplicates,
        fee_variances,
    ) = run_stats(row);
    let source_type = super::support::opt_text(row, "source_type").unwrap_or_default();
    let ingested_at = super::support::timestamp(row, "ingested_at");
    let mut object = json!({
        "id": uuid_json(row, "id"),
        "sourceId": uuid_json(row, "statement_source_id"),
        "sourceName": source_display_name(super::support::opt_text(row, "gateway_name").as_deref(), &source_type),
        "fileName": super::support::opt_text(row, "file_name").unwrap_or_else(|| "—".to_owned()),
        "fileHash": super::support::text_value(row, "file_hash"),
        "storageObjectId": uuid_json(row, "storage_object_id"),
        "state": if ingested_at.is_some() { "COMPLETED" } else { "PROCESSING" },
        "totalRows": total_rows,
        "matchedRows": matched,
        "unmatchedRows": unmatched,
        "amountMismatch": amount_mismatch,
        "missingAtGateway": missing_at_gateway,
        "missingLocally": missing_locally,
        "duplicates": duplicates,
        "feeVariances": fee_variances,
        "matchRate": match_rate(matched, total_rows),
        "drift": amount_mismatch + missing_at_gateway + missing_locally,
        "stats": stats,
        "startedAt": ts_json(row, "created_at"),
        "createdAt": ts_json(row, "created_at"),
        "finishedAt": ts_json(row, "ingested_at"),
        "ingestedAt": ts_json(row, "ingested_at"),
    });
    if let Some(map) = object.as_object_mut() {
        map.insert("windowStart".to_owned(), ts_json(row, "window_start"));
        map.insert("windowEnd".to_owned(), ts_json(row, "window_end"));
        map.insert(
            "currency".to_owned(),
            super::support::text_value(row, "currency"),
        );
    }
    object
}

async fn runs(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &run_spec(), &run_columns())?;
    let extra_sql = match query_string(request, "state").as_deref() {
        Some("COMPLETED") => "r.ingested_at IS NOT NULL".to_owned(),
        Some("PROCESSING") => "r.ingested_at IS NULL".to_owned(),
        _ => String::new(),
    };
    let mut where_sql = built.where_sql.clone();
    if !extra_sql.is_empty() {
        where_sql = if where_sql.is_empty() {
            format!("WHERE {extra_sql}")
        } else {
            format!("{where_sql} AND {extra_sql}")
        };
    }
    let sql = format!(
        "SELECT {RUN_PROJECTION} FROM {RUN_FROM} {where_sql} ORDER BY {} LIMIT ${} OFFSET ${}",
        built.order_by_sql,
        built.binds.len() + 1,
        built.binds.len() + 2
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in &built.binds {
        query = match bind {
            pg_db::SqlBind::Text(value) => query.bind(value.as_str()),
            pg_db::SqlBind::Bool(value) => query.bind(*value),
        };
    }
    let rows = query
        .bind(built.take)
        .bind(built.skip)
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let total = match extra_sql.as_str() {
        "" => super::support::count_always(&state.pools.main, &built, RUN_FROM, None).await?,
        _ => {
            let count_sql = format!("SELECT count(*) FROM {RUN_FROM} {where_sql}");
            let mut count_query = sqlx::query(sqlx::AssertSqlSafe(count_sql));
            for bind in &built.binds {
                count_query = match bind {
                    pg_db::SqlBind::Text(value) => count_query.bind(value.as_str()),
                    pg_db::SqlBind::Bool(value) => count_query.bind(*value),
                };
            }
            count_query
                .fetch_one(&state.pools.main)
                .await
                .map_err(super::support::database_error)?
                .get::<i64, _>(0)
        }
    };
    let items: Vec<Value> = rows.iter().map(run_row).collect();
    let mut response = list_envelope("runs", Value::Array(items), Some(total), &built);
    response = super::support::with_cursor(response, &built, &rows, "created_at");
    Ok(response)
}

pub(super) async fn run_detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "RECONCILIATION_RUN_NOT_FOUND",
        "The reconciliation run does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {RUN_PROJECTION} FROM {RUN_FROM} WHERE r.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "RECONCILIATION_RUN_NOT_FOUND",
            "The reconciliation run does not exist",
        ));
    };
    let result_filter = query_string(request, "result").unwrap_or_default();
    let items = items_for(state, &id, &result_filter, 200).await?;
    let items_total = items_total(state, &id, &result_filter).await?;
    let result_counts = result_counts(state, &id).await?;
    let mut run = run_row(&row);
    if let Some(object) = run.as_object_mut() {
        object.insert(
            "items".to_owned(),
            Value::Array(items.iter().map(item_row).collect()),
        );
        object.insert("itemResultCounts".to_owned(), result_counts);
        object.insert("itemsTotal".to_owned(), Value::from(items_total));
        object.insert(
            "itemsTruncated".to_owned(),
            Value::Bool(items_total > i64::try_from(items.len()).unwrap_or(0)),
        );
        object.insert(
            "itemResultFilter".to_owned(),
            if result_filter.is_empty() {
                Value::Null
            } else {
                Value::String(result_filter.clone())
            },
        );
    }
    Ok(json!({ "run": run }))
}

pub(super) async fn run_export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::path_segment(request, 2).as_deref(),
        "RECONCILIATION_RUN_NOT_FOUND",
        "The reconciliation run does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {RUN_PROJECTION} FROM {RUN_FROM} WHERE r.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "RECONCILIATION_RUN_NOT_FOUND",
            "The reconciliation run does not exist",
        ));
    };
    let result_filter = query_string(request, "result").unwrap_or_default();
    let items = items_for(state, &id, &result_filter, 20000).await?;
    let total = items_total(state, &id, &result_filter).await?;
    Ok(json!({
        "run": run_row(&row),
        "items": items.iter().map(item_row).collect::<Vec<_>>(),
        "total": total,
        "exported": items.len(),
        "truncated": total > i64::try_from(items.len()).unwrap_or(0),
    }))
}

async fn items_for(
    state: &AppState,
    run_id: &str,
    result_filter: &str,
    take: i64,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    let sql = if result_filter.is_empty() {
        "SELECT ri.id, ri.our_reference, ri.provider_reference, ri.batch_reference,
                ri.statement_amount, ri.statement_fee, ri.result::text AS result, ri.attempt_id,
                ri.operator_case_id, oc.state::text AS case_state, oc.priority::text AS case_priority
         FROM reconciliation_items ri
         LEFT JOIN operator_cases oc ON oc.id = NULLIF(ri.operator_case_id, '')::uuid
         WHERE ri.run_id = $1 ORDER BY ri.created_at ASC LIMIT $2"
    } else {
        "SELECT ri.id, ri.our_reference, ri.provider_reference, ri.batch_reference,
                ri.statement_amount, ri.statement_fee, ri.result::text AS result, ri.attempt_id,
                ri.operator_case_id, oc.state::text AS case_state, oc.priority::text AS case_priority
         FROM reconciliation_items ri
         LEFT JOIN operator_cases oc ON oc.id = NULLIF(ri.operator_case_id, '')::uuid
         WHERE ri.run_id = $1 AND ri.result::text = $2 ORDER BY ri.created_at ASC LIMIT $3"
    };
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(super::support::uuid_bind(run_id));
    if !result_filter.is_empty() {
        query = query.bind(result_filter);
    }
    query
        .bind(take)
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)
}

async fn items_total(state: &AppState, run_id: &str, result_filter: &str) -> Result<i64, ApiError> {
    let sql = if result_filter.is_empty() {
        "SELECT count(*) FROM reconciliation_items WHERE run_id = $1"
    } else {
        "SELECT count(*) FROM reconciliation_items WHERE run_id = $1 AND result::text = $2"
    };
    let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
        .bind(super::support::uuid_bind(run_id));
    if !result_filter.is_empty() {
        query = query.bind(result_filter);
    }
    query
        .fetch_one(&state.pools.main)
        .await
        .map_err(super::support::database_error)
}

async fn result_counts(state: &AppState, run_id: &str) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT result::text AS result, count(*) AS count FROM reconciliation_items
         WHERE run_id = $1 GROUP BY result",
    )
    .bind(super::support::uuid_bind(run_id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let mut map = Map::new();
    for row in &rows {
        map.insert(
            text(row, "result"),
            Value::from(row.try_get::<i64, _>("count").unwrap_or_default()),
        );
    }
    Ok(Value::Object(map))
}

fn item_row(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": uuid_json(row, "id"),
        "ourReference": text(row, "our_reference"),
        "providerReference": text(row, "provider_reference"),
        "batchReference": super::support::text_value(row, "batch_reference"),
        "statementAmount": money(row, "statement_amount"),
        "statementFee": money(row, "statement_fee"),
        "result": text(row, "result"),
        "attemptId": uuid_json(row, "attempt_id"),
        "operatorCaseId": super::support::text_value(row, "operator_case_id"),
        "operatorCase": if row.try_get::<Option<String>, _>("case_state").ok().flatten().is_some() {
            json!({
                "id": super::support::text_value(row, "operator_case_id"),
                "state": super::support::text_value(row, "case_state"),
                "priority": super::support::text_value(row, "case_priority"),
            })
        } else {
            Value::Null
        },
    })
}

// ---------------------------------------------------------------- summary

async fn summary_value(state: &AppState) -> Result<Value, ApiError> {
    let since = chrono::Utc::now().naive_utc() - Duration::days(30);
    let runs = sqlx::query(
        "SELECT ingested_at, stats_json FROM reconciliation_runs WHERE created_at >= $1",
    )
    .bind(since)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let result_rows = sqlx::query(
        "SELECT result::text AS result, count(*) AS count FROM reconciliation_items
         WHERE created_at >= $1 GROUP BY result",
    )
    .bind(since)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let source_count = sqlx::query("SELECT count(*) FROM statement_sources")
        .fetch_one(&state.pools.main)
        .await
        .map_err(super::support::database_error)?
        .get::<i64, _>(0);
    let mut result_counts = Map::new();
    for row in &result_rows {
        result_counts.insert(
            text(row, "result"),
            Value::from(row.try_get::<i64, _>("count").unwrap_or_default()),
        );
    }
    let mut total_rows = 0i64;
    let mut matched_rows = 0i64;
    let mut mismatched_rows = 0i64;
    let mut completed = 0i64;
    for row in &runs {
        let stats = jsonb_or_empty_object(row, "stats_json");
        total_rows += numeric_stat(&stats, &["totalRows", "statementLines"]);
        matched_rows += numeric_stat(&stats, &["matched"]);
        mismatched_rows +=
            if stats.get("mismatched").is_some() || stats.get("amountMismatch").is_some() {
                numeric_stat(&stats, &["mismatched", "amountMismatch"])
            } else {
                numeric_stat(
                    &stats,
                    &[
                        "amountMismatch",
                        "missingAtGateway",
                        "missingLocally",
                        "duplicates",
                    ],
                )
            };
        if super::support::timestamp(row, "ingested_at").is_some() {
            completed += 1;
        }
    }
    Ok(json!({
        "sources": source_count,
        "runs": runs.len(),
        "completedRuns": completed,
        "processingRuns": runs.len() as i64 - completed,
        "totalRows": total_rows,
        "matchedRows": matched_rows,
        "mismatchedRows": mismatched_rows,
        "matchRate": match_rate(matched_rows, total_rows),
        "resultCounts": result_counts,
    }))
}

// ---------------------------------------------------------------- handlers

fn sources_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, sources(state, request, principal).await) })
}

fn runs_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, runs(state, request, principal).await) })
}

fn summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, summary_value(state).await) })
}

fn summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = summary_value(state).await.map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "exportedAt".to_owned(),
                    super::support::iso_required(chrono::Utc::now()),
                );
            }
            value
        });
        result_response(request, result)
    })
}

fn run_detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, run_detail(state, request, principal).await) })
}

fn run_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, run_export(state, request, principal).await) })
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}
