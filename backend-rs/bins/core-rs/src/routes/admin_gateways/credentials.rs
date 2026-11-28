//! Credential-set metadata reads.
//!
//! Ports `admin.ts:13778-13859`: the shared `credentialSetView` projection and the two GET routes.
//! The ciphertext columns (`entries_ciphertext`, `mtls_cert_ciphertext`) are never selected in a
//! response; the detail route maps each entry to a write-only placeholder, exactly like TS.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_http::ApiError;
use serde_json::{Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use super::super::common;
use super::{
    build_page, col_opt_date, col_opt_text, col_opt_uuid, col_text, col_uuid, get_json, list_body,
    not_found, object, uuid_param,
};
use crate::state::AppState;

/// `credentialSetView`: the only shape credential sets leave the API in.
pub(super) fn credential_set_view(
    row: &PgRow,
    gateway_code: Option<&str>,
) -> Result<Value, ApiError> {
    let mut map = Map::new();
    map.insert("id".to_owned(), Value::String(col_uuid(row, "id")?));
    map.insert(
        "gatewayCode".to_owned(),
        gateway_code.map_or(Value::Null, |code| Value::String(code.to_owned())),
    );
    map.insert("env".to_owned(), Value::String(col_text(row, "env")?));
    map.insert(
        "ownerType".to_owned(),
        Value::String(col_text(row, "owner_type")?),
    );
    map.insert(
        "ownerMerchantId".to_owned(),
        col_opt_uuid(row, "owner_merchant_id")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "externalMerchantId".to_owned(),
        col_opt_text(row, "external_merchant_id")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "settlementTarget".to_owned(),
        Value::String(col_text(row, "settlement_target")?),
    );
    map.insert("status".to_owned(), Value::String(col_text(row, "status")?));
    map.insert(
        "lastVerifiedAt".to_owned(),
        col_opt_date(row, "last_verified_at")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "expiresAt".to_owned(),
        col_opt_date(row, "expires_at")?.map_or(Value::Null, Value::String),
    );
    Ok(Value::Object(map))
}

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "c.id", ColumnKind::Uuid)
        .with("status", "c.status::text", ColumnKind::Text)
        .with("env", "c.env::text", ColumnKind::Text)
        .with("ownerType", "c.owner_type::text", ColumnKind::Text)
        .with("gateway.code", "g.code", ColumnKind::Text)
        .with("gatewayId", "c.gateway_id", ColumnKind::Uuid)
        .with(
            "externalMerchantId",
            "c.external_merchant_id",
            ColumnKind::Text,
        )
        .with("createdAt", "c.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "c.updated_at", ColumnKind::Timestamp)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["externalMerchantId", "gateway.code"])
        .with_in("status", "status")
        .with_equals("gatewayCode", "gateway.code")
        .with_equals("env", "env")
        .with_equals("ownerType", "ownerType")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("gatewayCode", "gatewayId")
        .with_sortable("env", "env")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
}

const FROM: &str = "credential_sets c LEFT JOIN gateways g ON g.id = c.gateway_id";

get_json!(list, credential_list);
async fn credential_list(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let built = build_page(request, &spec(), &columns())?;
    let sql = built.select_sql(
        FROM,
        &[
            "c.id",
            "g.code AS gateway_code",
            "c.env::text AS env",
            "c.owner_type::text AS owner_type",
            "c.owner_merchant_id",
            "c.external_merchant_id",
            "c.settlement_target::text AS settlement_target",
            "c.status::text AS status",
            "c.last_verified_at",
            "c.expires_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let total: i64 = built
        .bind_count(&built.count_sql(FROM))
        .fetch_one(&state.pools.main)
        .await
        .map(|row| sqlx::Row::get::<i64, _>(&row, 0))
        .map_err(common::database_error)?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let gateway_code = col_opt_text(row, "gateway_code")?;
        items.push(credential_set_view(row, gateway_code.as_deref())?);
    }
    Ok(list_body("credentialSets", items, total, &built))
}

get_json!(detail, credential_detail);
async fn credential_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 0)?;
    let row = sqlx::query(
        "SELECT c.id, g.code AS gateway_code, c.env::text AS env, c.owner_type::text AS owner_type,
                c.owner_merchant_id, c.external_merchant_id,
                c.settlement_target::text AS settlement_target, c.status::text AS status,
                c.last_verified_at, c.expires_at, c.entries_ciphertext
           FROM credential_sets c
           JOIN gateways g ON g.id = c.gateway_id
          WHERE c.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| {
        not_found(
            "CREDENTIAL_SET_NOT_FOUND",
            "The credential set does not exist",
        )
    })?;

    let view = credential_set_view(&row, Some(&col_text(&row, "gateway_code")?))?;
    // `entriesCiphertext` is a JSON array of {key,type,value,isSecret,secretVersion}. Only the
    // key names and flags are exposed; values are never read back (admin.ts:13850).
    let entries = row
        .try_get::<Value, _>("entries_ciphertext")
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut mapped = Vec::with_capacity(entries.len());
    for entry in &entries {
        let entry = entry.as_object().cloned().unwrap_or_default();
        let is_secret = entry
            .get("isSecret")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        mapped.push(object(vec![
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
                "type",
                Value::String(
                    entry
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                ),
            ),
            ("isSecret", Value::Bool(is_secret)),
            (
                "value",
                Value::String(if is_secret {
                    "[REDACTED]".to_owned()
                } else {
                    "[WRITE_ONLY]".to_owned()
                }),
            ),
        ]));
    }
    let mut map = view.as_object().cloned().unwrap_or_default();
    map.insert("entries".to_owned(), Value::Array(mapped));
    Ok(Value::Object(map))
}
