//! Journal entries, GL accounts (shards + checkpoints) and posting lines.
//!
//! Port of `core-back/api/internal/{adminLedger,ledgerLines}.ts`:
//!
//! | Route | TS source |
//! | :--- | :--- |
//! | `GET /finance/journal-entries/summary` | `adminLedger.ts:127` |
//! | `GET /finance/journal-entries/summary/export` | `adminLedger.ts:132` |
//! | `GET /finance/journal-entries` | `adminLedger.ts:153` |
//! | `GET /finance/journal-entries/:id` | `adminLedger.ts:218` |
//! | `GET /finance/gl-accounts/:id/lines` | `adminLedger.ts:336` + `ledgerLines.ts:46` |
//! | `GET /finance/gl-accounts/:id` | `adminLedger.ts:279-350` |
//! | `GET /finance/gl-accounts/:id/shards/:shardId/repair-plan` | `adminLedger.ts:478` |
//!
//! `journal_lines` is monthly range-partitioned: every statement addresses it by `gl_account_id` or
//! `entry_id` plus a `created_at` window derived from the parent entry, exactly like the TS
//! handlers, so PostgreSQL prunes the partitions outside the window.
//!
//! These handlers never write the ledger. `summary/export` appends one audit row (the TS handler
//! does the same); the two export routes are otherwise read-only.

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{
    build_list_query, count_unless_skipped, list_response, ColumnKind, ColumnMap, DateFilter,
    ListSpec, SortDirection,
};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::state::AppState;

use super::support::{
    self, bind_text, bind_uuid, checklist, created_at_cursor, db_error, gl_account_id,
    gl_account_shard, iso_naive, iso_utc, journal_entry_id, load_checkpoint_summary,
    load_live_balances, money4, money4_text, money_dec, natural_balance, push_condition, query_map,
    reference_route, scalar_trimmed, sqlx_error, uuid_list_filter, CheckpointSummary, LineTotals,
    JOURNAL_REF_TYPES,
};

const UNBALANCED_WINDOW_DAYS: i64 = 7;

/// `totalsOf`: line count, both sides and the mixed-currency marker.
fn totals_json(totals: &LineTotals) -> Value {
    json!({
        "lineCount": totals.count,
        "totalDebit": money4(totals.debit),
        "totalCredit": money4(totals.credit),
        "balanced": totals.balanced(),
        "currency": totals.currency(),
    })
}

async fn journal_entry_summary(state: &AppState) -> Result<Value, ApiError> {
    let now = Utc::now();
    let since_24h = now - chrono::Duration::hours(24);
    let since_window = now - chrono::Duration::days(UNBALANCED_WINDOW_DAYS);
    let pool = &state.pools.main;

    let total_entries: i64 = sqlx::query_scalar("SELECT count(*) FROM journal_entries")
        .fetch_one(pool)
        .await
        .map_err(sqlx_error)?;
    let entries_24h: i64 =
        sqlx::query_scalar("SELECT count(*) FROM journal_entries WHERE created_at >= $1")
            .bind(since_24h.naive_utc())
            .fetch_one(pool)
            .await
            .map_err(sqlx_error)?;
    let volume_rows = sqlx::query(
        "SELECT g.currency::text AS currency, SUM(jl.amount)::text AS total
         FROM journal_lines jl
         INNER JOIN gl_accounts g ON g.id = jl.gl_account_id
         WHERE jl.direction::text = 'DEBIT' AND jl.created_at >= $1
         GROUP BY g.currency ORDER BY g.currency",
    )
    .bind(since_24h.naive_utc())
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut volume = Vec::with_capacity(volume_rows.len());
    for row in &volume_rows {
        let total = row.try_get::<String, _>("total").map_err(sqlx_error)?;
        volume.push(json!({
            "currency": row.try_get::<String, _>("currency").map_err(sqlx_error)?,
            "total": money4_text(Some(total.as_str())),
        }));
    }
    let unbalanced: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint AS count
         FROM journal_entries je
         LEFT JOIN (
           SELECT entry_id, SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS diff
           FROM journal_lines
           WHERE created_at >= $1
           GROUP BY entry_id
         ) l ON l.entry_id = je.id
         WHERE je.created_at >= $1
           AND (l.entry_id IS NULL OR l.diff <> 0)",
    )
    .bind(since_window.naive_utc())
    .fetch_one(pool)
    .await
    .map_err(sqlx_error)?;

    Ok(json!({
        "totalEntries": total_entries,
        "entries24h": entries_24h,
        "volume24hByCurrency": volume,
        "unbalancedEntries": unbalanced,
        "window": format!("{UNBALANCED_WINDOW_DAYS}d"),
    }))
}

async fn journal_summary_inner(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    journal_entry_summary(state).await
}

async fn journal_summary_export_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = journal_entry_summary(state).await?;
    let query = query_map(request);
    let checklist = checklist(
        &query,
        &[
            "JOURNAL_SCOPE_VERIFIED",
            "BALANCE_AND_VOLUME_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    let mut after = snapshot.clone();
    if let Value::Object(map) = &mut after {
        map.insert("checklist".to_owned(), json!(checklist));
    }
    support::write_audit_row(
        state,
        principal,
        "JOURNAL_ENTRY_SUMMARY_EXPORTED",
        "JOURNAL_ENTRY",
        "summary",
        json!({}),
        after,
    )
    .await?;
    let mut response = snapshot;
    if let Value::Object(map) = &mut response {
        map.insert("exportedAt".to_owned(), json!(iso_utc(Utc::now())));
    }
    Ok(response)
}

/// The journal-entries list spec of `adminLedger.ts:158-163`.
fn journal_list_spec() -> ListSpec {
    ListSpec::default()
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("refType", "refType")
        .with_sortable("refId", "refId")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

fn journal_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "je.id", ColumnKind::Uuid)
        .with("createdAt", "je.created_at", ColumnKind::Timestamp)
        .with("refType", "je.ref_type", ColumnKind::Text)
        .with("refId", "je.ref_id", ColumnKind::Text)
        .with("description", "je.description", ColumnKind::Text)
}

async fn journal_entries_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let mut query = query_map(request);
    let ref_types = support::enum_list_filter(&query, "refType", &JOURNAL_REF_TYPES)?;
    let gl_account_ids = uuid_list_filter(&query, "glAccountId")?;
    let search = scalar_trimmed(&query, "search");
    for key in ["search", "refType", "glAccountId"] {
        query.remove(key);
    }
    let mut built =
        build_list_query(&query, &journal_list_spec(), &journal_columns()).map_err(db_error)?;

    if let Some(ref_types) = &ref_types {
        let placeholders: Vec<String> = ref_types
            .iter()
            .map(|ref_type| bind_text(&mut built, ref_type.clone()))
            .collect();
        push_condition(
            &mut built,
            format!("je.ref_type::text IN ({})", placeholders.join(", ")),
        );
    }
    if let Some(ids) = &gl_account_ids {
        let placeholders: Vec<String> = ids.iter().map(|id| bind_uuid(&mut built, *id)).collect();
        push_condition(
            &mut built,
            format!(
                "EXISTS (SELECT 1 FROM journal_lines jl_filter
                          WHERE jl_filter.entry_id = je.id
                            AND jl_filter.gl_account_id IN ({}))",
                placeholders.join(", ")
            ),
        );
    }
    if let Some(search) = &search {
        let pattern = bind_text(&mut built, format!("%{search}%"));
        let mut branches = vec![
            format!("je.ref_id ILIKE {pattern}"),
            format!("je.description ILIKE {pattern}"),
        ];
        if support::is_uuid_pattern(search) {
            let parsed = Uuid::parse_str(search.trim()).ok();
            if let Some(id) = parsed {
                let placeholder = bind_uuid(&mut built, id);
                branches.push(format!("je.id = {placeholder}"));
            }
        }
        push_condition(&mut built, format!("({})", branches.join(" OR ")));
    }

    let pool = &state.pools.main;
    let sql = built.select_sql(
        "journal_entries je",
        &[
            "je.id",
            "je.created_at",
            "je.ref_type::text",
            "je.ref_id",
            "je.description",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let total = count_unless_skipped(&built, "journal_entries je", pool)
        .await
        .map_err(db_error)?;

    let mut entries = Vec::with_capacity(rows.len());
    for row in &rows {
        entries.push((
            row.try_get::<Uuid, _>("id").map_err(sqlx_error)?,
            row.try_get::<NaiveDateTime, _>("created_at")
                .map_err(sqlx_error)?,
            row.try_get::<String, _>("ref_type").map_err(sqlx_error)?,
            row.try_get::<String, _>("ref_id").map_err(sqlx_error)?,
            row.try_get::<String, _>("description")
                .map_err(sqlx_error)?,
        ));
    }

    let mut totals: HashMap<Uuid, LineTotals> = HashMap::new();
    if !entries.is_empty() {
        let ids: Vec<Uuid> = entries.iter().map(|entry| entry.0).collect();
        let times: Vec<NaiveDateTime> = entries.iter().map(|entry| entry.1).collect();
        let min = times
            .iter()
            .copied()
            .min()
            .unwrap_or_else(|| Utc::now().naive_utc())
            - chrono::Duration::minutes(5);
        let max = times
            .iter()
            .copied()
            .max()
            .unwrap_or_else(|| Utc::now().naive_utc())
            + chrono::Duration::minutes(5);
        let lines = sqlx::query(
            "SELECT jl.entry_id, jl.direction::text AS direction, jl.amount::text AS amount,
                    g.currency::text AS currency
             FROM journal_lines jl
             INNER JOIN gl_accounts g ON g.id = jl.gl_account_id
             WHERE jl.entry_id = ANY($1::uuid[])
               AND jl.created_at >= $2 AND jl.created_at <= $3",
        )
        .bind(&ids)
        .bind(min)
        .bind(max)
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
        for line in &lines {
            let entry_id = line.try_get::<Uuid, _>("entry_id").map_err(sqlx_error)?;
            let direction = line.try_get::<String, _>("direction").map_err(sqlx_error)?;
            let amount = money_dec(&line.try_get::<String, _>("amount").map_err(sqlx_error)?);
            let currency = line.try_get::<String, _>("currency").map_err(sqlx_error)?;
            totals
                .entry(entry_id)
                .or_default()
                .add(&direction, amount, Some(&currency));
        }
    }

    let mut items = Vec::with_capacity(entries.len());
    let mut source_rows = Vec::with_capacity(entries.len());
    for (id, created_at, ref_type, ref_id, description) in entries {
        let entry_totals = totals.get(&id).cloned().unwrap_or_default();
        let totals_json = totals_json(&entry_totals);
        items.push(json!({
            "id": id,
            "refType": ref_type,
            "refId": ref_id,
            "description": description,
            "createdAt": iso_naive(created_at),
            "lineCount": totals_json["lineCount"],
            "totalDebit": totals_json["totalDebit"],
            "totalCredit": totals_json["totalCredit"],
            "balanced": totals_json["balanced"],
            "currency": totals_json["currency"],
        }));
        source_rows.push(created_at_cursor(&built, iso_naive(created_at), id));
    }

    Ok(list_response(
        "journalEntries",
        Value::Array(items),
        total,
        &built,
        &source_rows,
    ))
}

async fn journal_entry_detail_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = journal_entry_id(request)?;
    let pool = &state.pools.main;
    let entry = sqlx::query(
        "SELECT id, created_at, ref_type::text AS ref_type, ref_id, description
         FROM journal_entries WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(sqlx_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "JOURNAL_ENTRY_NOT_FOUND",
            "The journal entry does not exist",
        )
    })?;
    let created_at: NaiveDateTime = entry.try_get("created_at").map_err(sqlx_error)?;
    let ref_type: String = entry.try_get("ref_type").map_err(sqlx_error)?;
    let ref_id: String = entry.try_get("ref_id").map_err(sqlx_error)?;
    let description: String = entry.try_get("description").map_err(sqlx_error)?;

    // Partition pruning: `entry_id` plus a ±5 min `created_at` window around the parent.
    let lines = sqlx::query(
        "SELECT jl.id, jl.created_at, jl.direction::text AS direction, jl.amount::text AS amount,
                g.id AS gl_account_id, g.account_type::text AS account_type,
                g.currency::text AS currency, g.owner_id
         FROM journal_lines jl
         INNER JOIN gl_accounts g ON g.id = jl.gl_account_id
         WHERE jl.entry_id = $1::uuid
           AND jl.created_at >= $2 AND jl.created_at <= $3
         ORDER BY jl.created_at ASC, jl.id ASC",
    )
    .bind(id)
    .bind(created_at - chrono::Duration::minutes(5))
    .bind(created_at + chrono::Duration::minutes(5))
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;

    let mut totals = LineTotals::default();
    let mut lines_json = Vec::with_capacity(lines.len());
    for line in &lines {
        let direction: String = line.try_get("direction").map_err(sqlx_error)?;
        let amount = money_dec(&line.try_get::<String, _>("amount").map_err(sqlx_error)?);
        let currency: String = line.try_get("currency").map_err(sqlx_error)?;
        totals.add(&direction, amount, Some(&currency));
        lines_json.push(json!({
            "lineId": line.try_get::<Uuid, _>("id").map_err(sqlx_error)?,
            "direction": direction,
            "amount": money4(amount),
            "glAccount": {
                "id": line.try_get::<Uuid, _>("gl_account_id").map_err(sqlx_error)?,
                "accountType": line.try_get::<String, _>("account_type").map_err(sqlx_error)?,
                "currency": currency,
                "ownerId": line.try_get::<Option<String>, _>("owner_id").map_err(sqlx_error)?,
            },
            "createdAt": iso_naive(line.try_get::<NaiveDateTime, _>("created_at").map_err(sqlx_error)?),
        }));
    }

    Ok(json!({
        "id": id,
        "refType": ref_type,
        "refId": ref_id,
        "description": description,
        "createdAt": iso_naive(created_at),
        "balanced": totals.balanced(),
        "totalDebit": money4(totals.debit),
        "totalCredit": money4(totals.credit),
        "currency": totals.currency(),
        "lines": lines_json,
        "reference": {
            "type": ref_type.clone(),
            "id": ref_id.clone(),
            "route": reference_route(&ref_type),
        },
    }))
}

/// The `direction` filter of the account lines: one value only (`DEBIT`/`CREDIT`).
fn direction_filter(query: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    let Some(values) = support::enum_list_filter(query, "direction", &["DEBIT", "CREDIT"])? else {
        return Ok(None);
    };
    if values.len() != 1 {
        return Err(
            ApiError::new(400, "INVALID_FILTER", "The 'direction' filter is invalid")
                .with_details(json!({ "allowed": ["DEBIT", "CREDIT"] })),
        );
    }
    Ok(values.into_iter().next())
}

/// `listAccountLines` (`ledgerLines.ts:46`): paginated posting lines of one GL account.
async fn list_account_lines(
    state: &AppState,
    account_id: Uuid,
    request: &HttpRequest,
) -> Result<Value, ApiError> {
    let mut query = query_map(request);
    let ref_types = support::enum_list_filter(&query, "refType", &JOURNAL_REF_TYPES)?;
    let direction = direction_filter(&query)?;
    let search = scalar_trimmed(&query, "search");
    for key in ["search", "refType", "direction"] {
        query.remove(key);
    }
    let spec = ListSpec::default()
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("amount", "amount")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0);
    let columns = ColumnMap::new()
        .with("id", "jl.id", ColumnKind::Uuid)
        .with("createdAt", "jl.created_at", ColumnKind::Timestamp)
        .with("amount", "jl.amount", ColumnKind::Decimal);
    let mut built = build_list_query(&query, &spec, &columns).map_err(db_error)?;

    let account = bind_uuid(&mut built, account_id);
    push_condition(&mut built, format!("jl.gl_account_id = {account}"));
    if let Some(direction) = &direction {
        let placeholder = bind_text(&mut built, direction.clone());
        push_condition(&mut built, format!("jl.direction::text = {placeholder}"));
    }
    let mut entry_clauses = Vec::new();
    if let Some(ref_types) = &ref_types {
        let placeholders: Vec<String> = ref_types
            .iter()
            .map(|ref_type| bind_text(&mut built, ref_type.clone()))
            .collect();
        entry_clauses.push(format!(
            "je.ref_type::text IN ({})",
            placeholders.join(", ")
        ));
    }
    if let Some(search) = &search {
        let pattern = bind_text(&mut built, format!("%{search}%"));
        entry_clauses.push(format!(
            "(je.description ILIKE {pattern} OR je.ref_id ILIKE {pattern})"
        ));
    }
    if !entry_clauses.is_empty() {
        push_condition(&mut built, entry_clauses.join(" AND "));
    }

    let pool = &state.pools.main;
    let sql = built.select_sql(
        "journal_lines jl INNER JOIN journal_entries je ON je.id = jl.entry_id",
        &[
            "jl.id",
            "jl.entry_id",
            "jl.created_at",
            "jl.direction::text",
            "jl.amount::text",
            "je.ref_type::text",
            "je.ref_id",
            "je.description",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let total = count_unless_skipped(
        &built,
        "journal_lines jl INNER JOIN journal_entries je ON je.id = jl.entry_id",
        pool,
    )
    .await
    .map_err(db_error)?;

    let mut lines = Vec::with_capacity(rows.len());
    let mut source_rows = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(sqlx_error)?;
        let created_at: NaiveDateTime = row.try_get("created_at").map_err(sqlx_error)?;
        lines.push(json!({
            "lineId": id,
            "entryId": row.try_get::<Uuid, _>("entry_id").map_err(sqlx_error)?,
            "direction": row.try_get::<String, _>("direction").map_err(sqlx_error)?,
            "amount": money4(money_dec(&row.try_get::<String, _>("amount").map_err(sqlx_error)?)),
            "createdAt": iso_naive(created_at),
            "refType": row.try_get::<String, _>("ref_type").map_err(sqlx_error)?,
            "refId": row.try_get::<String, _>("ref_id").map_err(sqlx_error)?,
            "description": row.try_get::<String, _>("description").map_err(sqlx_error)?,
        }));
        source_rows.push(created_at_cursor(&built, iso_naive(created_at), id));
    }

    // One covering aggregation computes the filtered line count and both side sums.
    let totals_sql = format!(
        "SELECT jl.direction::text AS direction, count(*)::bigint AS line_count,
                COALESCE(SUM(jl.amount), 0)::text AS total
         FROM journal_lines jl INNER JOIN journal_entries je ON je.id = jl.entry_id
         {} GROUP BY jl.direction",
        built.where_sql
    );
    let totals_rows = built
        .bind_count(&totals_sql)
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let mut line_count: i64 = 0;
    let mut total_debit = Decimal::ZERO;
    let mut total_credit = Decimal::ZERO;
    for row in &totals_rows {
        let direction: String = row.try_get("direction").map_err(sqlx_error)?;
        let count: i64 = row.try_get("line_count").map_err(sqlx_error)?;
        let sum = money_dec(&row.try_get::<String, _>("total").map_err(sqlx_error)?);
        line_count += count;
        if direction == "DEBIT" {
            total_debit = sum;
        } else {
            total_credit = sum;
        }
    }
    let net = total_debit - total_credit;

    let mut response = list_response("lines", Value::Array(lines), total, &built, &source_rows);
    if let Value::Object(map) = &mut response {
        map.insert(
            "totals".to_owned(),
            json!({
                "lineCount": line_count,
                "totalDebit": money4(total_debit),
                "totalCredit": money4(total_credit),
                "netDebit": money4(net),
            }),
        );
    }
    Ok(response)
}

async fn gl_account_lines_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let account_id = gl_account_id(request)?;
    let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM gl_accounts WHERE id = $1::uuid")
        .bind(account_id)
        .fetch_optional(&state.pools.main)
        .await
        .map_err(sqlx_error)?;
    if exists.is_none() {
        return Err(ApiError::new(
            404,
            "GL_ACCOUNT_NOT_FOUND",
            "The GL account does not exist",
        ));
    }
    list_account_lines(state, account_id, request).await
}

async fn gl_account_snapshot(state: &AppState, id: Uuid) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let account = sqlx::query(
        "SELECT id, account_type::text AS account_type, owner_id, currency::text AS currency,
                gateway_id, shard_count, shard_scaled_at
         FROM gl_accounts WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(sqlx_error)?
    .ok_or_else(|| ApiError::new(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist"))?;

    let balances = load_live_balances(pool, Some(&[id])).await?;
    let live = balances.first();
    let summary = load_checkpoint_summary(pool, id).await?;

    let shards = sqlx::query(
        "SELECT s.shard_id, s.current_balance::text AS current_balance,
                s.line_seq::text AS line_seq, s.updated_at,
                COALESCE(c.checkpoint_balance, 0)::text AS checkpoint_balance,
                COALESCE(c.checkpoint_seq, 0)::text AS checkpoint_seq, c.checkpoint_at,
                COALESCE(c.status, 'OK') AS status, c.failure_kind,
                COALESCE(c.consecutive_failures, 0) AS consecutive_failures
         FROM gl_account_shards s
         LEFT JOIN gl_shard_checkpoints c
                ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
         WHERE s.gl_account_id = $1::uuid
         ORDER BY s.shard_id ASC",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;

    let account_type: String = account.try_get("account_type").map_err(sqlx_error)?;
    let natural = live.map_or(Decimal::ZERO, |balance| balance.balance);
    let mut shards_json = Vec::with_capacity(shards.len());
    for shard in &shards {
        let line_seq: i64 = shard
            .try_get::<String, _>("line_seq")
            .map_err(sqlx_error)?
            .parse()
            .unwrap_or_default();
        let checkpoint_seq: i64 = shard
            .try_get::<String, _>("checkpoint_seq")
            .map_err(sqlx_error)?
            .parse()
            .unwrap_or_default();
        shards_json.push(json!({
            "shardId": shard.try_get::<i16, _>("shard_id").map_err(sqlx_error)?,
            "currentBalance": money4_text(Some(&shard.try_get::<String, _>("current_balance").map_err(sqlx_error)?)),
            "lineSeq": line_seq.to_string(),
            "checkpointBalance": money4_text(Some(&shard.try_get::<String, _>("checkpoint_balance").map_err(sqlx_error)?)),
            "checkpointSeq": checkpoint_seq.to_string(),
            "checkpointAt": shard.try_get::<Option<DateTime<Utc>>, _>("checkpoint_at").map_err(sqlx_error)?.map(iso_utc),
            "pendingLines": (line_seq - checkpoint_seq).to_string(),
            "status": shard.try_get::<String, _>("status").map_err(sqlx_error)?,
            "failureKind": shard.try_get::<Option<String>, _>("failure_kind").map_err(sqlx_error)?,
            "consecutiveFailures": shard.try_get::<i32, _>("consecutive_failures").map_err(sqlx_error)?,
            "updatedAt": iso_utc(shard.try_get::<DateTime<Utc>, _>("updated_at").map_err(sqlx_error)?),
        }));
    }

    let checkpoint = summary.unwrap_or(CheckpointSummary {
        checkpoint_balance: Decimal::ZERO,
        checkpoint_at: None,
        pending_lines: "0".to_owned(),
        shards_behind: 0,
        status: "OK".to_owned(),
    });
    Ok(json!({
        "account": {
            "id": account.try_get::<Uuid, _>("id").map_err(sqlx_error)?,
            "accountType": account_type.clone(),
            "ownerId": account.try_get::<Option<String>, _>("owner_id").map_err(sqlx_error)?,
            "currency": account.try_get::<String, _>("currency").map_err(sqlx_error)?,
            "gatewayId": account.try_get::<Option<Uuid>, _>("gateway_id").map_err(sqlx_error)?,
            "checkpointBalance": money4(checkpoint.checkpoint_balance),
            "checkpointAt": checkpoint.checkpoint_at.map(iso_utc),
            "shardCount": account.try_get::<i16, _>("shard_count").map_err(sqlx_error)?,
            "shardScaledAt": account.try_get::<Option<DateTime<Utc>>, _>("shard_scaled_at").map_err(sqlx_error)?.map(iso_utc),
        },
        "liveBalance": money4(natural_balance(&account_type, natural)),
        "naturalBalance": money4(natural),
        "balanceSource": "shards",
        "checkpoint": {
            "status": checkpoint.status,
            "pendingLines": checkpoint.pending_lines,
            "shardsBehind": checkpoint.shards_behind,
        },
        "shards": shards_json,
    }))
}

async fn gl_account_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = gl_account_id(request)?;
    gl_account_snapshot(state, id).await
}

/// The frozen half of the deep read (`ShardRepair.ts:113-160`): the shard head and every line of
/// the shard in one statement, without the shard lock (a read-only preview).
const DEEP_SQL: &str = "
  SELECT sh.current_balance::text AS balance, sh.line_seq::text AS line_seq,
         COALESCE(c.checkpoint_balance, 0)::text AS cp_balance, COALESCE(c.checkpoint_seq, 0)::text AS cp_seq,
         COALESCE(c.baseline_seq, 0)::text AS baseline_seq, COALESCE(c.status, 'OK') AS status,
         COALESCE(c.consecutive_failures, 0)::int AS failures,
         j.total::text AS total, j.upto_cp::text AS upto_cp, j.after_baseline::text AS after_baseline,
         j.distinct_after::text AS distinct_after, j.max_seq::text AS max_seq
  FROM gl_account_shards sh
  LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(x.signed), 0) AS total,
           COALESCE(SUM(x.signed) FILTER (WHERE x.seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_cp,
           COUNT(*) FILTER (WHERE x.seq > COALESCE(c.baseline_seq, 0)) AS after_baseline,
           COUNT(DISTINCT x.seq) FILTER (WHERE x.seq > COALESCE(c.baseline_seq, 0)) AS distinct_after,
           COALESCE(MAX(x.seq), 0) AS max_seq
    FROM (
      SELECT l.shard_seq AS seq, CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed
      FROM journal_lines l
      WHERE l.gl_account_id = sh.gl_account_id AND l.shard_id = sh.shard_id
    ) x
  ) j
  WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint";

/// `serializeRepairPlan` (`ShardRepair.ts:618`).
fn serialize_repair_plan(plan: &serde_json::Value) -> Value {
    plan.clone()
}

async fn repair_plan_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let (account_id, shard_id) = gl_account_shard(request)?;
    let row = sqlx::query(DEEP_SQL)
        .bind(account_id)
        .bind(i16::try_from(shard_id).unwrap_or_default())
        .fetch_optional(&state.pools.main)
        .await
        .map_err(sqlx_error)?
        .ok_or_else(|| ApiError::new(404, "GL_SHARD_NOT_FOUND", "The shard does not exist"))?;

    let balance = money_dec(&row.try_get::<String, _>("balance").map_err(sqlx_error)?);
    let line_seq: i64 = parse_i64(&row.try_get::<String, _>("line_seq").map_err(sqlx_error)?);
    let checkpoint_balance =
        money_dec(&row.try_get::<String, _>("cp_balance").map_err(sqlx_error)?);
    let checkpoint_seq: i64 = parse_i64(&row.try_get::<String, _>("cp_seq").map_err(sqlx_error)?);
    let baseline_seq: i64 = parse_i64(
        &row.try_get::<String, _>("baseline_seq")
            .map_err(sqlx_error)?,
    );
    let status: String = row.try_get("status").map_err(sqlx_error)?;
    let failures: i32 = row.try_get("failures").map_err(sqlx_error)?;

    let total = money_dec(&row.try_get::<String, _>("total").map_err(sqlx_error)?);
    let upto_checkpoint = money_dec(&row.try_get::<String, _>("upto_cp").map_err(sqlx_error)?);
    let lines_after_baseline = parse_i64(
        &row.try_get::<String, _>("after_baseline")
            .map_err(sqlx_error)?,
    );
    let distinct_after = parse_i64(
        &row.try_get::<String, _>("distinct_after")
            .map_err(sqlx_error)?,
    );
    let max_seq = parse_i64(&row.try_get::<String, _>("max_seq").map_err(sqlx_error)?);

    // `buildPlan` (`ShardRepair.ts:235`).
    let expected_lines = line_seq - baseline_seq;
    let sequence_intact = lines_after_baseline == expected_lines
        && distinct_after == lines_after_baseline
        && if expected_lines == 0 {
            max_seq <= baseline_seq
        } else {
            max_seq == line_seq
        };
    let checkpoint_proven = checkpoint_balance == upto_checkpoint;
    let needs_repair =
        !(sequence_intact && balance == total && checkpoint_proven && status == "OK");
    let new_line_seq = if sequence_intact {
        line_seq
    } else {
        line_seq.max(max_seq)
    };
    let kind = if !needs_repair {
        Value::Null
    } else if sequence_intact {
        Value::String("RECOMPUTE".to_owned())
    } else {
        Value::String("REBASELINE".to_owned())
    };
    let baseline_after = if sequence_intact {
        baseline_seq
    } else {
        new_line_seq
    };
    let delta = total - balance;

    // `createHash("sha256").update(JSON.stringify({...}))`; PostgreSQL has a built-in sha256().
    let hash_input = json!({
        "glAccountId": account_id,
        "shardId": shard_id,
        "balance": money4(balance),
        "lineSeq": line_seq.to_string(),
        "cp": money4(checkpoint_balance),
        "cpSeq": checkpoint_seq.to_string(),
        "baselineSeq": baseline_seq.to_string(),
        "total": money4(total),
        "uptoCheckpoint": money4(upto_checkpoint),
        "linesAfterBaseline": lines_after_baseline.to_string(),
        "distinctAfterBaseline": distinct_after.to_string(),
        "maxSeq": max_seq.to_string(),
        "status": status.clone(),
    });
    let plan_hash: String =
        sqlx::query_scalar("SELECT encode(sha256(convert_to($1::text, 'UTF8')), 'hex')")
            .bind(hash_input.to_string())
            .fetch_one(&state.pools.main)
            .await
            .map_err(sqlx_error)?;

    Ok(serialize_repair_plan(&json!({
        "glAccountId": account_id,
        "shardId": shard_id,
        "needsRepair": needs_repair,
        "kind": kind,
        "sequenceIntact": sequence_intact,
        "status": status,
        "consecutiveFailures": failures,
        "before": {
            "balance": money4(balance),
            "lineSeq": line_seq.to_string(),
            "checkpointBalance": money4(checkpoint_balance),
            "checkpointSeq": checkpoint_seq.to_string(),
            "baselineSeq": baseline_seq.to_string(),
        },
        "journal": {
            "total": money4(total),
            "uptoCheckpoint": money4(upto_checkpoint),
            "linesAfterBaseline": lines_after_baseline.to_string(),
            "distinctAfterBaseline": distinct_after.to_string(),
            "highestSequence": max_seq.to_string(),
        },
        "after": {
            "balance": money4(total),
            "lineSeq": new_line_seq.to_string(),
            "checkpointBalance": money4(total),
            "checkpointSeq": new_line_seq.to_string(),
            "baselineSeq": baseline_after.to_string(),
        },
        "delta": money4(delta),
        "planHash": plan_hash,
    })))
}

fn parse_i64(value: &str) -> i64 {
    value.parse().unwrap_or_default()
}

super::support::custom_route!(journal_summary, journal_summary_inner);
super::support::custom_route!(journal_summary_export, journal_summary_export_inner);
super::support::custom_route!(journal_entries, journal_entries_inner);
super::support::custom_route!(journal_entry_detail, journal_entry_detail_inner);
super::support::custom_route!(gl_account_lines, gl_account_lines_inner);
super::support::custom_route!(gl_account, gl_account_inner);
super::support::custom_route!(repair_plan, repair_plan_inner);
