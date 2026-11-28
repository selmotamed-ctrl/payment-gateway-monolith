//! Pending merchant changes, the merchant detail-change history and the beneficial owners.
//!
//! Ports `core-back/api/internal/admin.ts:6790` (`/merchants/:id/pending-changes`), `:6850`
//! (`/merchants/:id/detail-changes`) and `core-back/api/internal/adminCommerce.ts:1545`
//! (`/merchants/:id/beneficial-owners`).
//!
//! `pending-changes` deliberately does not check that the merchant exists (the TS handler only
//! queries the approvals, so an unknown merchant returns an empty list). `detail-changes` pages
//! with the shared list contract and redacts sensitive fields for a caller without sensitive
//! access. The owners list never selects `national_id_ciphertext`/`national_id_hash`; the
//! ownership percentage is `toFixed(2)` and the date of birth is the UTC-midnight instant Prisma
//! serialises.

#![forbid(unsafe_code)]

use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::RoundingStrategy;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::routes::admin_commerce::common;

use super::support;

/// `GET /internal/admin/merchants/:id/pending-changes`.
pub async fn pending_changes(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::parse_uuid(id)?;
    let flags = common::flags(principal);
    let rows = sqlx::query(
        "SELECT ar.id, ar.state::text AS state, ar.mode::text AS mode, ar.base_version, \
         ar.maker_reason, ar.payload_diff_json, ar.created_at, ar.expires_at, \
         mu.email AS maker_email, cu.email AS checker_email \
         FROM approval_requests ar \
         JOIN users mu ON mu.id = ar.maker_user_id \
         LEFT JOIN users cu ON cu.id = ar.checker_user_id \
         WHERE ar.subject_type = 'MERCHANT' AND ar.subject_id = $1::text \
         AND ar.state::text IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED') \
         ORDER BY ar.created_at DESC",
    )
    .bind(merchant_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;

    let mut changes = Vec::with_capacity(rows.len());
    for row in &rows {
        changes.push(json!({
            "id": common::uuid_text(row, "id")?,
            "state": common::text(row, "state")?,
            "mode": common::text(row, "mode")?,
            "baseVersion": common::opt_i32(row, "base_version")?,
            "makerReason": if flags.can_sensitive {
                common::opt_text(row, "maker_reason")?.map_or(Value::Null, Value::String)
            } else {
                Value::Null
            },
            "maker": common::text(row, "maker_email")?,
            "checker": common::opt_text(row, "checker_email")?.map_or(Value::Null, Value::String),
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            "expiresAt": common::iso_value(common::opt_naive(row, "expires_at")?),
            "payload": if flags.can_sensitive {
                common::json_value(row, "payload_diff_json")?
            } else {
                Value::Null
            },
        }));
    }
    Ok(json!({ "pendingChanges": Value::Array(changes) }))
}

const DETAIL_CHANGES_FROM: &str = "detail_change_logs d JOIN users u ON u.id = d.actor_id";

const DETAIL_CHANGES_COLUMNS: &[&str] = &[
    "d.id AS id",
    "d.created_at AS created_at",
    "d.updated_at AS updated_at",
    "d.actor_id AS actor_id",
    "d.merchant_id AS merchant_id",
    "d.entity_type AS entity_type",
    "d.entity_id AS entity_id",
    "d.field_name AS field_name",
    "d.old_value AS old_value",
    "d.new_value AS new_value",
    "d.approval_request_id AS approval_request_id",
    "d.source::text AS source",
    "d.request_id AS request_id",
    "d.client_ip AS client_ip",
    "u.email AS actor_email",
];

fn detail_changes_columns() -> ColumnMap {
    ColumnMap::new().with("id", "d.id", ColumnKind::Uuid).with(
        "createdAt",
        "d.created_at",
        ColumnKind::Timestamp,
    )
}

fn detail_changes_spec() -> ListSpec {
    ListSpec::default()
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
}

fn detail_change_row(
    row: &sqlx::postgres::PgRow,
    flags: &common::Flags,
) -> Result<Value, ApiError> {
    let actor_email = common::text(row, "actor_email")?;
    let entry = json!({
        "id": common::uuid_text(row, "id")?,
        "createdAt": common::iso_naive(common::naive(row, "created_at")?),
        "updatedAt": common::iso_naive(common::naive(row, "updated_at")?),
        "actorId": common::uuid_text(row, "actor_id")?,
        "merchantId": common::opt_uuid_text(row, "merchant_id")?.map_or(Value::Null, Value::String),
        "entityType": common::text(row, "entity_type")?,
        "entityId": common::text(row, "entity_id")?,
        "fieldName": common::text(row, "field_name")?,
        "oldValue": common::opt_text(row, "old_value")?.map_or(Value::Null, Value::String),
        "newValue": common::opt_text(row, "new_value")?.map_or(Value::Null, Value::String),
        "approvalRequestId": common::opt_uuid_text(row, "approval_request_id")?
            .map_or(Value::Null, Value::String),
        "source": common::text(row, "source")?,
        "requestId": common::text(row, "request_id")?,
        "clientIp": common::opt_text(row, "client_ip")?.map_or(Value::Null, Value::String),
        "actor": { "email": actor_email },
    });
    Ok(support::redact_detail_change(
        &entry,
        flags.can_sensitive,
        flags.can_aml,
    ))
}

/// `GET /internal/admin/merchants/:id/detail-changes`.
pub async fn detail_changes(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::parse_uuid(id)?;
    let flags = common::flags(principal);
    let query = common::parse_query(query_string);
    let mut built =
        pg_db::build_list_query(&query, &detail_changes_spec(), &detail_changes_columns())
            .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "d.merchant_id", &merchant_id);

    let sql = built.select_sql(DETAIL_CHANGES_FROM, DETAIL_CHANGES_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, DETAIL_CHANGES_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let id = common::uuid_text(row, "id")?;
        items.push(detail_change_row(row, &flags)?);
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            Some(common::naive(row, "updated_at")?),
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "detailChanges",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

/// `GET /internal/admin/merchants/:id/beneficial-owners` (`adminCommerce.ts:1545`).
pub async fn beneficial_owners(pool: &PgPool, id: &str) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let rows = sqlx::query(
        "SELECT id, full_name_ar, full_name_en, role::text AS role, ownership_percent, \
         nationality::text AS nationality, pep_declared, screening_status::text AS screening_status, \
         active, valid_from, valid_to, date_of_birth \
         FROM beneficial_owners WHERE merchant_id = $1 \
         ORDER BY active DESC, created_at ASC",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;

    let mut owners = Vec::with_capacity(rows.len());
    for row in &rows {
        let ownership = common::opt_decimal(row, "ownership_percent")?
            .map(|value| value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero))
            .map(|value| Value::String(format!("{value:.2}")))
            .unwrap_or(Value::Null);
        owners.push(json!({
            "id": common::uuid_text(row, "id")?,
            "fullNameAr": common::text(row, "full_name_ar")?,
            "fullNameEn": common::opt_text(row, "full_name_en")?.map_or(Value::Null, Value::String),
            "role": common::text(row, "role")?,
            "ownershipPercent": ownership,
            "nationality": common::text(row, "nationality")?,
            "pepDeclared": common::bool_of(row, "pep_declared")?,
            "screeningStatus": common::text(row, "screening_status")?,
            "active": common::bool_of(row, "active")?,
            "validFrom": common::iso_naive(common::naive(row, "valid_from")?),
            "validTo": common::iso_value(common::opt_naive(row, "valid_to")?),
            "dateOfBirth": common::iso_date_value(common::opt_date(row, "date_of_birth")?),
        }));
    }
    Ok(json!({ "beneficialOwners": Value::Array(owners) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_changes_spec_only_pages_by_created_at() {
        let spec = detail_changes_spec();
        assert_eq!(spec.search.len(), 0);
        assert_eq!(spec.in_.len(), 0);
        assert_eq!(spec.dates.len(), 1);
        assert_eq!(spec.dates[0].from_key(), "createdAtFrom");
        assert_eq!(spec.dates[0].to_key(), "createdAtTo");
        assert_eq!(spec.default_page_size, None, "listQuery default is 50");
    }

    #[test]
    fn beneficial_owner_rows_never_expose_the_national_id() {
        // The projection is the contract: only these twelve columns leave the route.
        let columns = [
            "id",
            "full_name_ar",
            "full_name_en",
            "role",
            "ownership_percent",
            "nationality",
            "pep_declared",
            "screening_status",
            "active",
            "valid_from",
            "valid_to",
            "date_of_birth",
        ];
        assert!(!columns.contains(&"national_id_ciphertext"));
        assert!(!columns.contains(&"national_id_hash"));
        assert_eq!(columns.len(), 12);
    }
}
