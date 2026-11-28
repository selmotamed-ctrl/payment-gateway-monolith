//! List-query declarations and execution for the AML admin reads.
//!
//! Every list here is the `buildListQuery` / `listResponse` contract of
//! `core-back/lib/listQuery.ts` applied to the same columns the TypeScript handlers name. The SQL
//! builder lives in `pg-db` (`list_query`); this module only declares the per-endpoint filters,
//! the column aliases of the joined queries, and the cursor/list envelope helpers.
//!
//! Enum columns are mapped twice: a `::text` expression for filters and a `CASE` expression for
//! sorting. Prisma orders a PostgreSQL enum by its declaration order, not alphabetically, so the
//! ordinal expression is what keeps `sortKey=status` identical to the TS output.

#![forbid(unsafe_code)]

use chrono::NaiveDateTime;
use ntex::web::HttpRequest;
use pg_db::list_query::{
    build_list_query, list_response, BuiltListQuery, ColumnKind, ColumnMap, CursorValue,
    DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection, SqlBind,
};
use serde_json::{Map, Value};
use sqlx::postgres::PgRow;
use sqlx::PgPool;
use uuid::Uuid;

use pg_http::ApiError;

/// The built plan type (re-exported for the handlers).
pub(super) type Built = BuiltListQuery;

/// Parsed query values in Express `req.query` shape: first occurrence wins.
pub(super) fn request_map(request: &HttpRequest) -> Map<String, Value> {
    let mut map = Map::new();
    let raw = request.query_string();
    if !raw.is_empty() {
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            map.entry(key.into_owned())
                .or_insert_with(|| Value::String(value.into_owned()));
        }
    }
    map
}

/// Build the SQL plan, mapping a filter failure to the TS generic 500 (the TS builder throws a
/// plain `Error` for a malformed number and Express answers `SERVER_ERROR`).
pub(super) fn build(
    raw: &Map<String, Value>,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, ApiError> {
    build_list_query(raw, spec, columns).map_err(|error| {
        tracing::error!(error = %error, "AML list query could not be built");
        ApiError::server_error()
    })
}

/// Fetch the page rows of a built query.
pub(super) async fn fetch_rows(
    pool: &PgPool,
    built: &BuiltListQuery,
    table: &str,
    projection: &[&str],
) -> Result<Vec<PgRow>, ApiError> {
    let sql = built.select_sql(table, projection);
    built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)
}

/// Count every matching row. The TS AML handlers always issue the COUNT (they never use
/// `countUnlessSkipped`), so `includeTotal=false` does not skip it here either.
pub(super) async fn fetch_total(
    pool: &PgPool,
    built: &BuiltListQuery,
    table: &str,
) -> Result<i64, ApiError> {
    let sql = built.count_sql(table);
    built
        .bind_count(&sql)
        .fetch_one(pool)
        .await
        .map(|row| sqlx::Row::get::<i64, _>(&row, 0))
        .map_err(crate::routes::common::database_error)
}

/// The `nextCursor` source row of a keyset-eligible list. Only `createdAt`/`id` sorts occur on the
/// AML lists (chapter 2 §13); anything else cannot be a keyset field in the first place.
pub(super) fn cursor_row(
    built: &BuiltListQuery,
    created_at: Option<NaiveDateTime>,
    id: Uuid,
) -> Vec<CursorValue> {
    let Some(plan) = &built.keyset else {
        return Vec::new();
    };
    plan.fields
        .iter()
        .map(|field| match field.path.as_str() {
            "createdAt" => CursorValue::Date(
                created_at
                    .map(super::view::iso_naive)
                    .unwrap_or_else(|| super::view::iso_naive(chrono::Utc::now().naive_utc())),
            ),
            "id" => CursorValue::Text(id.to_string()),
            _ => CursorValue::Text(String::new()),
        })
        .collect()
}

/// The standard list envelope.
pub(super) fn envelope(
    key: &str,
    rows: Value,
    total: i64,
    built: &BuiltListQuery,
    source_rows: &[Vec<CursorValue>],
) -> Value {
    list_response(key, rows, Some(total), built, source_rows)
}

/* --------------------------------------------------------------- screenings */

pub(super) fn screenings_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["subjectId", "providerCode", "providerRequestRef"])
        .with_in("result", "result")
        .with_in("subjectType", "subjectType")
        .with_in("trigger", "trigger")
        .with_equals("providerCode", "providerCode")
        .with_range(RangeFilter::new(
            "score",
            "highestScore",
            RangeKind::Decimal,
        ))
        .with_date(DateFilter::new("createdAt", "requestedAt"))
        .with_date(
            DateFilter::new("requestedAt", "requestedAt").with_keys("requestedFrom", "requestedTo"),
        )
        .with_sortable("result", "resultOrdinal")
        .with_sortable("requestedAt", "requestedAt")
        .with_sortable("score", "highestScore")
        .with_sortable("matchCount", "matchCount")
        .with_default_sort("requestedAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

pub(super) fn screenings_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "id", ColumnKind::Uuid)
        .with("subjectType", "subject_type::text", ColumnKind::Text)
        .with("subjectId", "subject_id", ColumnKind::Text)
        .with("trigger", "trigger::text", ColumnKind::Text)
        .with("providerCode", "provider_code", ColumnKind::Text)
        .with(
            "providerRequestRef",
            "provider_request_ref",
            ColumnKind::Text,
        )
        .with("result", "result::text", ColumnKind::Text)
        .with("resultOrdinal", result_ordinal(), ColumnKind::Integer)
        .with("matchCount", "match_count", ColumnKind::Integer)
        .with("highestScore", "highest_score", ColumnKind::Decimal)
        .with("requestedAt", "requested_at", ColumnKind::Timestamp)
}

/// Prisma orders `AmlScreeningResult` by declaration order.
fn result_ordinal() -> &'static str {
    "CASE result WHEN 'CLEAR' THEN 0 WHEN 'POTENTIAL_MATCH' THEN 1 WHEN 'CONFIRMED_MATCH' THEN 2 WHEN 'ERROR' THEN 3 ELSE 4 END"
}

/* ------------------------------------------------------------------- cases */

pub(super) fn cases_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "triggerReason",
            "subjectId",
            "rule.code",
            "rule.name",
            "assignedReviewer.email",
        ])
        .with_in("status", "status")
        .with_in("severity", "severity")
        .with_in("subjectType", "subjectType")
        .with_equals("ruleCode", "rule.code")
        .with_equals("assignedReviewerId", "assignedReviewerId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("slaDueAt", "slaDueAt").with_keys("dateFrom", "dateTo"))
        .with_sortable("status", "statusOrdinal")
        .with_sortable("severity", "severityOrdinal")
        .with_sortable("openedAt", "createdAt")
        .with_sortable("slaDueAt", "slaDueAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

pub(super) fn cases_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "c.id", ColumnKind::Uuid)
        .with("subjectType", "c.subject_type::text", ColumnKind::Text)
        .with("subjectId", "c.subject_id", ColumnKind::Text)
        .with("triggerReason", "c.trigger_reason", ColumnKind::Text)
        .with("status", "c.status::text", ColumnKind::Text)
        .with("statusOrdinal", case_status_ordinal(), ColumnKind::Integer)
        .with("severity", "c.severity::text", ColumnKind::Text)
        .with(
            "severityOrdinal",
            severity_ordinal("c.severity"),
            ColumnKind::Integer,
        )
        .with(
            "assignedReviewerId",
            "c.assigned_reviewer_id",
            ColumnKind::Uuid,
        )
        .with("rule.code", "ar.code", ColumnKind::Text)
        .with("rule.name", "ar.name", ColumnKind::Text)
        .with("assignedReviewer.email", "u.email", ColumnKind::Text)
        .with("createdAt", "c.created_at", ColumnKind::Timestamp)
        .with("slaDueAt", "c.sla_due_at", ColumnKind::Timestamp)
}

/// The FROM clause of every case list/count query (one row per case; both joins are 1:1).
pub(super) const CASES_TABLE: &str =
    "aml_cases c LEFT JOIN aml_rules ar ON ar.id = c.rule_id LEFT JOIN users u ON u.id = c.assigned_reviewer_id";

fn case_status_ordinal() -> &'static str {
    "CASE c.status WHEN 'OPEN' THEN 0 WHEN 'IN_REVIEW' THEN 1 WHEN 'PENDING_CHECKER' THEN 2 WHEN 'RELEASED' THEN 3 WHEN 'REJECTED_VOID' THEN 4 WHEN 'FROZEN' THEN 5 WHEN 'ESCALATED_STR' THEN 6 ELSE 7 END"
}

fn severity_ordinal(column: &str) -> &'static str {
    match column {
        "c.severity" => {
            "CASE c.severity WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'CRITICAL' THEN 3 ELSE 4 END"
        }
        _ => {
            "CASE base_severity WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'CRITICAL' THEN 3 ELSE 4 END"
        }
    }
}

/* ------------------------------------------------------------------- rules */

pub(super) fn rules_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["code", "name"])
        .with_equals("ruleType", "ruleType")
        .with_equals("action", "action")
        .with_equals("baseSeverity", "baseSeverity")
        .with_boolean("active", "active")
        .with_range(RangeFilter::new("version", "version", RangeKind::Number))
        .with_date(DateFilter::new("effectiveFrom", "effectiveFrom"))
        .with_sortable("code", "code")
        .with_sortable("name", "name")
        .with_sortable("ruleType", "ruleTypeOrdinal")
        .with_sortable("baseSeverity", "baseSeverityOrdinal")
        .with_sortable("active", "active")
        .with_sortable("effectiveFrom", "effectiveFrom")
        .with_default_sort("code", SortDirection::Asc)
}

pub(super) fn rules_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "id", ColumnKind::Uuid)
        .with("code", "code", ColumnKind::Text)
        .with("name", "name", ColumnKind::Text)
        .with("ruleType", "rule_type::text", ColumnKind::Text)
        .with(
            "ruleTypeOrdinal",
            "CASE rule_type WHEN 'SINGLE_AMOUNT' THEN 0 WHEN 'CUMULATIVE_WINDOW' THEN 1 WHEN 'STRUCTURING' THEN 2 WHEN 'RISK_TIER' THEN 3 WHEN 'COUNTERPARTY_COUNTRY' THEN 4 WHEN 'RAIL' THEN 5 WHEN 'MERCHANT_DIRECT_AMOUNT' THEN 6 ELSE 7 END",
            ColumnKind::Integer,
        )
        .with("action", "action::text", ColumnKind::Text)
        .with("baseSeverity", "base_severity::text", ColumnKind::Text)
        .with(
            "baseSeverityOrdinal",
            "CASE base_severity WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'CRITICAL' THEN 3 ELSE 4 END",
            ColumnKind::Integer,
        )
        .with("active", "active", ColumnKind::Bool)
        .with("version", "version", ColumnKind::Integer)
        .with("effectiveFrom", "effective_from", ColumnKind::Timestamp)
}

/* ----------------------------------------------------------------- reports */

pub(super) fn reports_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["subjectId", "submissionRef", "amlCaseIdText"])
        .with_in("status", "status")
        .with_in("reportType", "reportType")
        .with_equals("authority", "authority")
        .with_equals("amlCaseId", "amlCaseId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("submittedAt", "submittedAt").with_keys("dateFrom", "dateTo"))
        .with_date(
            DateFilter::new("periodStart", "periodStart").with_keys("periodFrom", "periodTo"),
        )
        .with_sortable("reportType", "reportTypeOrdinal")
        .with_sortable("authority", "authority")
        .with_sortable("status", "statusOrdinal")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("submittedAt", "submittedAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

pub(super) fn reports_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "r.id", ColumnKind::Uuid)
        .with("subjectId", "r.subject_id", ColumnKind::Text)
        .with("submissionRef", "r.submission_ref", ColumnKind::Text)
        .with("amlCaseIdText", "r.aml_case_id::text", ColumnKind::Text)
        .with("amlCaseId", "r.aml_case_id", ColumnKind::Uuid)
        .with("authority", "r.authority", ColumnKind::Text)
        .with("reportType", "r.report_type::text", ColumnKind::Text)
        .with(
            "reportTypeOrdinal",
            "CASE r.report_type WHEN 'LARGE_TRANSACTION' THEN 0 WHEN 'SUSPICIOUS_ACTIVITY' THEN 1 WHEN 'PERIODIC_RETURN' THEN 2 WHEN 'INCIDENT' THEN 3 ELSE 4 END",
            ColumnKind::Integer,
        )
        .with("status", "r.status::text", ColumnKind::Text)
        .with(
            "statusOrdinal",
            "CASE r.status WHEN 'DRAFT' THEN 0 WHEN 'PENDING_CHECKER' THEN 1 WHEN 'APPROVED' THEN 2 WHEN 'SUBMITTED' THEN 3 WHEN 'ACKNOWLEDGED' THEN 4 WHEN 'REJECTED_BY_AUTHORITY' THEN 5 ELSE 6 END",
            ColumnKind::Integer,
        )
        .with("createdAt", "r.created_at", ColumnKind::Timestamp)
        .with("submittedAt", "r.submitted_at", ColumnKind::Timestamp)
        .with("periodStart", "r.period_start", ColumnKind::Timestamp)
}

pub(super) const REPORTS_TABLE: &str = "regulatory_reports r";

/// `includeIncidentSearch`: the TS handler appends `subjectId IN (<incident ids>)` to the first
/// (search) OR branch. This appends an equivalent OR term to the whole search condition, keeping
/// every existing bind position intact (`$n` renumbering is unnecessary because the new binds
/// are appended after the built ones).
pub(super) fn merge_incident_search(
    mut built: BuiltListQuery,
    search: &str,
    incident_ids: &[String],
    search_columns: &[&str],
) -> BuiltListQuery {
    if search.trim().is_empty() || search_columns.is_empty() {
        return built;
    }
    let mut binds = built.binds.clone();
    binds.push(SqlBind::Text(format!("%{search}%")));
    let pattern = binds.len();
    let mut branches: Vec<String> = search_columns
        .iter()
        .map(|column| format!("{column} ILIKE ${pattern}::text"))
        .collect();
    for id in incident_ids {
        binds.push(SqlBind::Text(id.clone()));
        branches.push(format!("{} = ${}::text", search_columns[0], binds.len()));
    }
    let base = built
        .where_sql
        .strip_prefix("WHERE ")
        .unwrap_or_default()
        .to_owned();
    built.where_sql = if base.is_empty() {
        format!("WHERE ({})", branches.join(" OR "))
    } else {
        format!("WHERE {base} AND ({})", branches.join(" OR "))
    };
    built.binds = binds;
    built
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incident_search_keeps_existing_binds() {
        let mut raw = Map::new();
        raw.insert("search".into(), Value::String("acme".into()));
        raw.insert("status".into(), Value::String("DRAFT".into()));
        let built = build(&raw, &reports_spec(), &reports_columns()).expect("build");
        assert_eq!(built.binds.len(), 2);
        let merged = merge_incident_search(
            built,
            "acme",
            &["00000000-0000-4000-8000-000000000001".into()],
            &["r.subject_id", "r.submission_ref", "r.aml_case_id::text"],
        );
        assert_eq!(merged.binds.len(), 4);
        assert!(merged.where_sql.contains("r.subject_id = $4::text"));
    }

    #[test]
    fn enum_sort_uses_declaration_order() {
        let mut raw = Map::new();
        raw.insert("sortKey".into(), Value::String("status".into()));
        let built = build(&raw, &cases_spec(), &cases_columns()).expect("build");
        assert!(built.order_by_sql.starts_with("CASE c.status"));
    }
}
