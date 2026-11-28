//! Live PostgreSQL tests for `pg-db` (P3-T01/T03/T04/T09).
//!
//! They run against the development database named by `PG_TEST_DATABASE_URL`, `DATABASE_URL` or
//! the project default (`postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`,
//! schema 46). When the server is unreachable each test prints a skip line and returns, so a
//! checkout without PostgreSQL does not fail the suite.

use pg_db::{
    build_list_query, connect_pool, ColumnKind, ColumnMap, DateFilter, ListSpec, PgLeaderElection,
    PoolKind, PoolSpec, PoolTuning, SortDirection,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use uuid::Uuid;

const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

fn spec(kind: PoolKind, url: &str) -> PoolSpec {
    PoolSpec {
        kind,
        url: url.to_owned(),
        tuning: PoolTuning {
            max_connections: 4,
            ..PoolTuning::default()
        },
    }
}

/// Connect or return `None` after printing the skip reason.
async fn pool_or_skip() -> Option<PgPool> {
    let url = database_url();
    match connect_pool(&spec(PoolKind::Main, &url)).await {
        Ok(pool) => Some(pool),
        Err(error) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            None
        }
    }
}

#[tokio::test]
async fn pool_pins_utc_and_carries_the_application_name() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let timezone: String = sqlx::query_scalar("SHOW TimeZone")
        .fetch_one(&pool)
        .await
        .expect("timezone");
    assert_eq!(timezone, "UTC", "every connection is pinned to UTC");
    let application: String = sqlx::query_scalar("SHOW application_name")
        .fetch_one(&pool)
        .await
        .expect("application_name");
    assert_eq!(application, "pg-core-back");
    // The pool reused a connection: a second checkout keeps the same settings.
    let again: String = sqlx::query_scalar("SHOW TimeZone")
        .fetch_one(&pool)
        .await
        .expect("timezone");
    assert_eq!(again, "UTC");
}

#[tokio::test]
async fn leader_election_is_exclusive_and_the_session_probe_passes() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let leader_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url())
        .await
        .expect("leader pool");
    let first = PgLeaderElection::connect_with_url(leader_pool, &database_url())
        .await
        .expect("leader client");
    first.probe_session_safety().await.expect("session-safe");
    assert_eq!(first.probe_ok(), Some(true));
    assert!(first.last_probe_at().is_some());

    let worker = format!("IntegrationProbe-{}", Uuid::new_v4());
    assert!(first.try_acquire(&worker).await.expect("acquire"));
    // One acquisition per process: PostgreSQL advisory locks are re-entrant inside a session, so
    // a second attempt is reported as "not acquired" and never raises the unlock count.
    assert!(!first.try_acquire(&worker).await.expect("already held"));
    assert!(first.verify(&worker).await.expect("verify"));
    assert_eq!(first.lost_count(), 0);
    assert_eq!(first.held(), vec![worker.clone()]);

    let second = PgLeaderElection::connect(pool)
        .await
        .expect("second client");
    assert!(
        !second.try_acquire(&worker).await.expect("contend"),
        "only one process may lead a singleton worker"
    );

    first.release(&worker).await.expect("release");
    assert!(
        second.try_acquire(&worker).await.expect("handover"),
        "a released lock is available to the next node"
    );
    second.release(&worker).await.expect("cleanup release");
    assert!(first.held().is_empty());
    assert!(second.held().is_empty());
}

#[tokio::test]
async fn list_query_filters_sort_and_total_against_merchants() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let columns = ColumnMap::new()
        .with("id", "m.id", ColumnKind::Uuid)
        .with("legalName", "m.legal_name", ColumnKind::Text)
        .with("tradeName", "m.trade_name", ColumnKind::Text)
        .with("status", "m.status::text", ColumnKind::Text)
        .with("riskTier", "m.risk_tier::text", ColumnKind::Text)
        .with("createdAt", "m.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "m.updated_at", ColumnKind::Timestamp);
    let spec = ListSpec::default()
        .with_search(&["legalName", "tradeName"])
        .with_equals("status", "status")
        .with_in("riskTier", "riskTier")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc);

    let mut raw = serde_json::Map::new();
    raw.insert("status".into(), serde_json::json!("ACTIVE"));
    raw.insert("pageSize".into(), serde_json::json!("5"));
    raw.insert("sortKey".into(), serde_json::json!("createdAt"));
    raw.insert("sortDirection".into(), serde_json::json!("asc"));

    let built = build_list_query(&raw, &spec, &columns).expect("build");
    let sql = built.select_sql(
        "merchants m",
        &[
            "m.id",
            "m.legal_name",
            "m.status::text AS status",
            "m.created_at",
        ],
    );
    let rows = built.bind_rows(&sql).fetch_all(&pool).await.expect("rows");
    assert_eq!(rows.len(), 5, "one page of five ACTIVE merchants");
    let mut previous = None;
    for row in &rows {
        assert_eq!(row.get::<String, _>("status"), "ACTIVE");
        let created_at: chrono::NaiveDateTime = row.get("created_at");
        if let Some(previous) = previous {
            assert!(created_at >= previous, "ascending sort");
        }
        previous = Some(created_at);
    }

    let total = pg_db::count_unless_skipped(&built, "merchants m", &pool)
        .await
        .expect("count")
        .expect("includeTotal defaults to true");
    let direct: i64 =
        sqlx::query_scalar("SELECT count(*) FROM merchants m WHERE m.status = 'ACTIVE'")
            .fetch_one(&pool)
            .await
            .expect("direct count");
    assert_eq!(total, direct, "the count uses the same filters as the page");

    // `includeTotal=false` skips the COUNT entirely.
    raw.insert("includeTotal".into(), serde_json::json!("false"));
    let built = build_list_query(&raw, &spec, &columns).expect("build");
    assert_eq!(
        pg_db::count_unless_skipped(&built, "merchants m", &pool)
            .await
            .expect("count"),
        None
    );
}

#[tokio::test]
async fn list_query_cursor_walks_a_real_table_without_overlap() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let columns = ColumnMap::new().with("id", "m.id", ColumnKind::Uuid).with(
        "createdAt",
        "m.created_at",
        ColumnKind::Timestamp,
    );
    let spec = ListSpec::default().with_default_sort("createdAt", SortDirection::Desc);
    let table = "merchants m";
    let projection = &["m.id", "m.created_at"];

    let mut first_raw = serde_json::Map::new();
    first_raw.insert("pageSize".into(), serde_json::json!("3"));
    let first = build_list_query(&first_raw, &spec, &columns).expect("build");
    let first_sql = first.select_sql(table, projection);
    let first_rows = first
        .bind_rows(&first_sql)
        .fetch_all(&pool)
        .await
        .expect("page 1");
    assert_eq!(first_rows.len(), 3);
    let plan = first
        .keyset
        .clone()
        .expect("createdAt+id are keyset columns");

    let values: Vec<pg_db::CursorValue> = first_rows
        .last()
        .map(|row| {
            vec![
                pg_db::CursorValue::Date(
                    row.get::<chrono::NaiveDateTime, _>("created_at")
                        .and_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
                pg_db::CursorValue::Text(row.get::<Uuid, _>("id").to_string()),
            ]
        })
        .expect("last row");
    let cursor = pg_db::encode_cursor(&plan, &values).expect("cursor");

    let mut second_raw = serde_json::Map::new();
    second_raw.insert("pageSize".into(), serde_json::json!("3"));
    second_raw.insert("cursor".into(), serde_json::json!(cursor));
    let second = build_list_query(&second_raw, &spec, &columns).expect("build");
    assert!(second.cursor_applied);
    assert_eq!(second.skip, 0);
    let second_sql = second.select_sql(table, projection);
    let second_rows = second
        .bind_rows(&second_sql)
        .fetch_all(&pool)
        .await
        .expect("page 2");

    let first_ids: Vec<Uuid> = first_rows.iter().map(|row| row.get("id")).collect();
    for row in &second_rows {
        assert!(
            !first_ids.contains(&row.get::<Uuid, _>("id")),
            "a cursor page never repeats a row"
        );
    }
    if let (Some(last_first), Some(first_second)) = (first_rows.last(), second_rows.first()) {
        assert!(
            first_second.get::<chrono::NaiveDateTime, _>("created_at")
                <= last_first.get::<chrono::NaiveDateTime, _>("created_at"),
            "descending order continues across the cursor"
        );
    }

    // The envelope carries the next cursor only for a full page.
    let last_values: Vec<Vec<pg_db::CursorValue>> = second_rows
        .iter()
        .map(|row| {
            vec![
                pg_db::CursorValue::Date(
                    row.get::<chrono::NaiveDateTime, _>("created_at")
                        .and_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
                pg_db::CursorValue::Text(row.get::<Uuid, _>("id").to_string()),
            ]
        })
        .collect();
    let response = pg_db::list_response(
        "merchants",
        serde_json::json!([]),
        Some(42),
        &second,
        &last_values,
    );
    assert_eq!(response["total"], serde_json::json!(42));
    if second_rows.len() == 3 {
        assert!(response["nextCursor"].is_string());
    }
}

#[tokio::test]
async fn unit_of_work_flushes_outbox_and_audit_atomically() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let marker = format!("integration-{}", Uuid::new_v4());
    let actor = Uuid::new_v4();
    let result = pg_db::uow::run(
        &pool,
        pg_db::UowOptions::default().with_timeout_ms(5_000),
        |connection, buffers| {
            let marker = marker.clone();
            pg_db::boxed(async move {
                // A real write inside the transaction: prove the buffers commit with it.
                sqlx::query("SELECT 1").execute(&mut *connection).await?;
                buffers.enqueue_outbox(pg_db::OutboxEnvelope::new(
                    "integration.test",
                    "test",
                    marker.clone(),
                    serde_json::json!({"ok": true}),
                ));
                let audit_id = buffers.record_audit(
                    pg_db::AuditEnvelope::new(actor, "COMPLIANCE", "INTEGRATION_TEST")
                        .entity("test", marker.clone()),
                );
                Ok(audit_id)
            })
        },
    )
    .await
    .expect("uow");

    assert!(!result.commit_lsn.is_empty());
    assert!(result.commit_lsn.contains('/'), "an LSN like 0/16B6C50");
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox_events WHERE topic = 'integration.test' AND aggregate_id = $1",
    )
    .bind(&marker)
    .fetch_one(&pool)
    .await
    .expect("outbox");
    assert_eq!(outbox, 1);
    let audit: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_outbox WHERE id = $1 AND entity_id = $2")
            .bind(result.data)
            .bind(&marker)
            .fetch_one(&pool)
            .await
            .expect("audit");
    assert_eq!(audit, 1);

    // Cleanup: the rows were only there to prove the flush.
    sqlx::query("DELETE FROM outbox_events WHERE topic = 'integration.test' AND aggregate_id = $1")
        .bind(&marker)
        .execute(&pool)
        .await
        .expect("cleanup outbox");
    sqlx::query("DELETE FROM audit_outbox WHERE id = $1")
        .bind(result.data)
        .execute(&pool)
        .await
        .expect("cleanup audit");
}

#[tokio::test]
async fn unit_of_work_rolls_back_on_error() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let marker = format!("rollback-{}", Uuid::new_v4());
    let result: Result<pg_db::UowResult<()>, _> = pg_db::uow::run(
        &pool,
        pg_db::UowOptions::default(),
        |_connection, buffers| {
            let marker = marker.clone();
            pg_db::boxed(async move {
                buffers.enqueue_outbox(pg_db::OutboxEnvelope::new(
                    "integration.rollback",
                    "test",
                    marker,
                    serde_json::json!({}),
                ));
                Err(pg_db::DbError::InvalidCursor)
            })
        },
    )
    .await;
    assert!(result.is_err());
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox_events WHERE topic = 'integration.rollback'",
    )
    .fetch_one(&pool)
    .await
    .expect("outbox");
    assert_eq!(outbox, 0, "a failed unit of work writes nothing");
}

#[tokio::test]
async fn audit_append_returns_the_chain_position() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    // The dedicated audit database owns `audit_records`; create the same table in a throwaway
    // schema and point a pool at it so the helper (which uses the unqualified name) is exercised.
    let schema = format!("pgdb_audit_{}", Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&pool)
        .await
        .expect("schema");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {schema}.audit_records (
            seq_no BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE,
            id UUID PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL,
            ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            actor_id UUID NOT NULL,
            actor_email VARCHAR(191),
            role VARCHAR(64) NOT NULL,
            action VARCHAR(96) NOT NULL,
            entity_type VARCHAR(64) NOT NULL,
            entity_id VARCHAR(64) NOT NULL,
            merchant_id UUID,
            approval_request_id UUID,
            request_id VARCHAR(64),
            client_ip VARCHAR(45),
            user_agent TEXT,
            before_json JSONB NOT NULL,
            after_json JSONB NOT NULL,
            prev_hash CHAR(64) NOT NULL DEFAULT repeat('0', 64),
            row_hash CHAR(64) NOT NULL,
            CONSTRAINT row_hash_shape CHECK (row_hash ~ '^[0-9a-f]{{64}}$')
        )"
    )))
    .execute(&pool)
    .await
    .expect("table");
    // Mirror the trigger's hash so the constraint above accepts the row (the helper never hashes).
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "ALTER TABLE {schema}.audit_records ALTER COLUMN row_hash SET DEFAULT repeat('a', 64)"
    )))
    .execute(&pool)
    .await
    .expect("default");

    let audit_pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect({
            let schema = schema.clone();
            move |connection, _| {
                let statement = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(sqlx::AssertSqlSafe(statement))
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            }
        })
        .connect(&database_url())
        .await
        .expect("audit pool");

    let mut connection = audit_pool.acquire().await.expect("connection");
    let record = pg_db::AuditRecord::new(Uuid::new_v4(), "COMPLIANCE", "INTEGRATION_AUDIT")
        .entity("test", "row-1");
    let appended = pg_db::append_audit_record(&mut connection, &record)
        .await
        .expect("append");
    assert_eq!(appended.seq_no, 1);
    assert_eq!(appended.prev_hash.trim(), "0".repeat(64));
    // The same id is skipped on a replay (`appendBatch` idempotence).
    let replayed = pg_db::append_audit_records(&mut connection, std::slice::from_ref(&record))
        .await
        .expect("replay");
    assert!(replayed.is_empty());
    drop(connection);
    audit_pool.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&pool)
        .await
        .expect("cleanup schema");
}

#[tokio::test]
async fn sqlstate_mapping_against_the_server() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let table = format!("pgdb_sqlstate_{}", Uuid::new_v4().simple());
    // A temporary table keeps the development schema untouched.
    let mut connection = pool.acquire().await.expect("connection");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TEMP TABLE {table} (id integer PRIMARY KEY) ON COMMIT PRESERVE ROWS"
    )))
    .execute(&mut *connection)
    .await
    .expect("temp table");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO {table} (id) VALUES (1)"
    )))
    .execute(&mut *connection)
    .await
    .expect("insert");
    let error = sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO {table} (id) VALUES (1)"
    )))
    .execute(&mut *connection)
    .await
    .expect_err("duplicate");
    let error = pg_db::DbError::Sqlx(error);
    assert_eq!(error.prisma_code(), Some("P2002"));
    assert!(error.is_unique_violation());
    assert!(!error.is_transient());
}
