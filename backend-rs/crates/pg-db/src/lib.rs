//! PostgreSQL access rules.
//!
//! Port of `core-back/lib/storageEngine/{utcSession,index,uowAdapter,auditAndLogAdapters}.ts`,
//! `core-back/lib/db/{connectionConfig,waitBudgets}.ts`, `core-back/lib/listQuery.ts`,
//! `core-back/api/middleware/authDoubleCheck.ts` (row loads) and
//! `deploy/lib/configSchema.ts` (URL generation).
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`url`] | `storageEngine/utcSession.ts`, `deploy/lib/configSchema.ts:883-928` |
//! | [`pool`] | `db/connectionConfig.ts`, `db/waitBudgets.ts`, `storageEngine/index.ts` |
//! | [`uow`] | `storageEngine/uowAdapter.ts` |
//! | [`audit`] | `storageEngine/auditAndLogAdapters.ts` |
//! | [`list_query`] | `lib/listQuery.ts` |
//! | [`repo`] | `authDoubleCheck.ts`, `productionRuntime.ts:readBackgroundJobQueueHealth` |
//! | [`leader`] / [`leader_pg`] | `storageEngine/leaderElection.ts` |
//!
//! Nothing here is executed at import time; every pool is opened explicitly so binaries and tests
//! share the same normalisation and the same observability labels.

#![forbid(unsafe_code)]

pub mod audit;
pub mod error;
pub mod leader;
pub mod leader_pg;
pub mod list_query;
pub mod meta;
pub mod pool;
pub mod replica;
pub mod repo;
pub mod sqlstate;
pub mod uow;
pub mod url;

pub use audit::{
    append_audit_record, append_audit_records, AuditAppended, AuditRecord, AUDIT_TABLE,
};
pub use error::{error_detail, DbError};
pub use leader::{
    leader_lock_key, leader_lock_sql, verify_session_safety_error, EXPECTED_SINGLETON_KEYS,
    LEADER_BOOT_PROBE_KEY,
};
pub use leader_pg::{LeaderError, PgLeaderElection, SESSION_PROBE_SQL};
pub use list_query::{
    build_list_query, count_unless_skipped, decode_cursor, encode_cursor, is_decimal_text,
    js_number, js_number_text, js_number_value, list_response, parse_date, parse_list_query,
    parse_list_query_pairs, BuiltListQuery, Column, ColumnKind, ColumnMap, Condition, CursorValue,
    DateFilter, KeysetField, KeysetPlan, ListQuery, ListSpec, RangeFilter, RangeKind,
    SortDirection, SqlBind, DEFAULT_KEYSET_FIELDS, DEFAULT_PAGE_SIZE, MAX_CURSOR_LENGTH,
    MAX_PAGE_SIZE,
};
pub use meta::{IdKind, PrismaMeta, TableMeta};
pub use pool::{
    connect_pool, parse_postgres_url_list, DatabaseConfig, EndpointIdentity, PoolKind, PoolSpec,
    PoolTuning, DEFAULT_ACQUIRE_TIMEOUT_MS, DEFAULT_AUX_MAX_CONNECTIONS, DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_MAX_CONNECTIONS, DEFAULT_STATEMENT_CACHE,
};
pub use repo::{
    find_access_token, find_session_revocation, find_user, prune_expired_revocations,
    read_background_job_queue, touch_access_token, upsert_session_revocation, AccessTokenRow,
    QueueCounts, UserRow,
};
pub use sqlstate::{classified_error, is_transient, prisma_code, ClassifiedError};
pub use uow::{
    boxed, AuditEnvelope, Buffers, Isolation, OutboxEnvelope, UowFuture, UowOptions, UowResult,
    DEFAULT_MAX_WAIT_MS, DEFAULT_TIMEOUT_MS,
};
pub use url::{
    parse_database_url, parse_pool_url, ApplicationName, DatabaseUrl, PoolSettings, SslMode,
    UrlError,
};

/// The schema version the running binaries require. Kept in lockstep with
/// `core-back/prisma/schemaVersion.ts`; parity note: TS core performs **no** boot check today,
/// so Rust also only exposes the value until S-DB-01 lands on both sides.
pub const REQUIRED_SCHEMA_VERSION: u32 = 46;

pub const APP_NAME_CORE: &str = "pg-core-back";
pub const APP_NAME_LEADER: &str = "pg-core-back-leader";
pub const APP_NAME_REPORT_READONLY: &str = "report_engine_readonly_line";
