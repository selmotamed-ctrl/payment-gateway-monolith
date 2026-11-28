//! Merchant commerce reads: applications, links, payments, disputes and the external API reads.
//!
//! Port of `core-back/api/internal/merchant.ts:1403-1458` (options) and `2201-2908`
//! (applications, links, payments, disputes, attachments). Ownership is always the authenticated
//! merchant (the application relation for links/terminals, `merchant_id` for attempts), narrowed by
//! the principal's `app_scope_ids`/token application exactly like `withAppScope`/`appScopeOf`.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_db::list_query::{
    build_list_query, count_unless_skipped, list_response, ColumnKind, ColumnMap, DateFilter,
    ListSpec, RangeFilter, RangeKind, SortDirection,
};
use pg_domain_auth::Principal;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common::{json_ok, money4};
use super::super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use super::{
    application_scope, assert_application_in_scope, assert_merchant_authority, cursor_rows, f,
    path_segment, path_uuid, query_map, query_scalar, require_merchant_principal,
    require_merchant_session, row_json, rows_json, set_filter, set_in_filter, CursorColumn,
    FieldKind, Fields,
};
use crate::http::error_response;
use crate::routes::common::database_error;
use crate::state::AppState;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, ScopeRule};

const ORIGIN_OPTIONS: &str = "core-back/api/internal/merchant.ts:1403";
const ORIGIN_APPLICATIONS: &str = "core-back/api/internal/merchant.ts:2201";
const ORIGIN_APPLICATION: &str = "core-back/api/internal/merchant.ts:2261";
const ORIGIN_LINKS: &str = "core-back/api/internal/merchant.ts:2525";
const ORIGIN_LINK: &str = "core-back/api/internal/merchant.ts:2579";
const ORIGIN_LINK_ATTEMPTS: &str = "core-back/api/internal/merchant.ts:2607";
const ORIGIN_PAYMENTS: &str = "core-back/api/internal/merchant.ts:2627";
const ORIGIN_DISPUTES: &str = "core-back/api/internal/merchant.ts:2667";
const ORIGIN_DISPUTE: &str = "core-back/api/internal/merchant.ts:2693";
const ORIGIN_DISPUTE_ATTACHMENTS: &str = "core-back/api/internal/merchant.ts:2771";
const ORIGIN_ATTACHMENT_CONTENT: &str = "core-back/api/internal/merchant.ts:2852";
const ORIGIN_EXTERNAL_LINK: &str = "core-back/api/internal/merchant.ts:4124";
const ORIGIN_EXTERNAL_PAYMENT: &str = "core-back/api/internal/merchant.ts:4162";

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let read_write = super::policy_authorities(&["merchant:read", "merchant:write"]);
    let link_read = super::policy_authorities(&["link:read"]);
    let payment_read = super::policy_authorities(&["payment:read"]);
    let disputes = super::policy_authorities(&["payment:read", "dispute:respond"]);
    let options = super::policy_authorities(&[
        "merchant:read",
        "merchant:write",
        "link:read",
        "payment:read",
    ]);
    let external_link_authorities = super::policy_authorities(&["link:read", "link:write"]);
    vec![
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/options/:kind",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_OPTIONS,
            )
            .authorities(&options.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(options_kind),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/applications",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_APPLICATIONS,
            )
            .authorities(&read_write.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_applications),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/applications/:id",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_APPLICATION,
            )
            .authorities(&read_write.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_application),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/links",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_LINKS,
            )
            .authorities(&link_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_links),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/links/:id",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_LINK,
            )
            .authorities(&link_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_link),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/links/:id/attempts",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_LINK_ATTEMPTS,
            )
            .authorities(&link_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_link_attempts),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/payments",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_PAYMENTS,
            )
            .authorities(&payment_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_payments),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/disputes",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_DISPUTES,
            )
            .authorities(&disputes.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_disputes),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/disputes/:id",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_DISPUTE,
            )
            .authorities(&disputes.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_dispute),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/disputes/:id/attachments",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_DISPUTE_ATTACHMENTS,
            )
            .authorities(&disputes.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_dispute_attachments),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/disputes/:id/attachments/:attachmentId/content",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_ATTACHMENT_CONTENT,
            )
            .authorities(&disputes.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(dispute_attachment_content),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/external/links/:key",
                Channel::Merchant,
                Authn::SessionOrApiToken,
                ORIGIN_EXTERNAL_LINK,
            )
            .authorities(
                &external_link_authorities
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(external_link),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/external/payments/:reference",
                Channel::Merchant,
                Authn::SessionOrApiToken,
                ORIGIN_EXTERNAL_PAYMENT,
            )
            .authorities(&payment_read.iter().map(String::as_str).collect::<Vec<_>>())
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(external_payment),
            guard: PrincipalGuard::Merchant,
        },
    ]
}

// ---------------------------------------------------------------------------------------------
// Field tables
// ---------------------------------------------------------------------------------------------

const APPLICATION_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("name", "name", FieldKind::Text),
    f(
        "business_use_description",
        "businessUseDescription",
        FieldKind::Text,
    ),
    f(
        "expected_monthly_volume",
        "expectedMonthlyVolume",
        FieldKind::Decimal,
    ),
    f("assigned_wallet_id", "assignedWalletId", FieldKind::Uuid),
    f("rail_whitelist", "railWhitelist", FieldKind::Json),
    f(
        "redirect_domain_allowlist",
        "redirectDomainAllowlist",
        FieldKind::Json,
    ),
    f("status", "status", FieldKind::Text),
];

const APPLICATION_COLUMNS: &str = "a.id, a.created_at, a.updated_at, a.merchant_id, a.name, \
     a.business_use_description, a.expected_monthly_volume, a.assigned_wallet_id, \
     a.rail_whitelist, a.redirect_domain_allowlist, a.status::text AS status";

const APPLICATION_WALLET_FIELDS: Fields = &[
    f("w_id", "id", FieldKind::Uuid),
    f("w_created_at", "createdAt", FieldKind::Timestamp),
    f("w_updated_at", "updatedAt", FieldKind::Timestamp),
    f("w_merchant_id", "merchantId", FieldKind::Uuid),
    f("w_gl_account_id", "glAccountId", FieldKind::Uuid),
    f("w_currency", "currency", FieldKind::Text),
    f("w_name", "name", FieldKind::Text),
    f("w_status", "status", FieldKind::Text),
];

const APPLICATION_WALLET_COLUMNS: &str = "w.id AS w_id, w.created_at AS w_created_at, \
     w.updated_at AS w_updated_at, w.merchant_id AS w_merchant_id, \
     w.gl_account_id AS w_gl_account_id, w.currency AS w_currency, w.name AS w_name, \
     w.status::text AS w_status";

const LINK_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("key", "key", FieldKind::Text),
    f("title", "title", FieldKind::Text),
    f("description", "description", FieldKind::Text),
    f("application_id", "applicationId", FieldKind::Uuid),
    f("wallet_id", "walletId", FieldKind::Uuid),
    f("amount", "amount", FieldKind::Decimal),
    f("currency", "currency", FieldKind::Text),
    f("fee_bearer", "feeBearer", FieldKind::Text),
    f("split_ratio_json", "splitRatioJson", FieldKind::Json),
    f("infinite_use", "infiniteUse", FieldKind::Bool),
    f("use_count", "useCount", FieldKind::Int),
    f("confirmed_count", "confirmedCount", FieldKind::Int),
    f("active_locked_count", "activeLockedCount", FieldKind::Int),
    f("redirect_url", "redirectUrl", FieldKind::Text),
    f("rail_whitelist", "railWhitelist", FieldKind::Json),
    f("env", "env", FieldKind::Text),
    f("state", "state", FieldKind::Text),
    f("expires_at", "expiresAt", FieldKind::Timestamp),
];

const LINK_COLUMNS: &str = "l.id, l.created_at, l.updated_at, l.key, l.title, l.description, \
     l.application_id, l.wallet_id, l.amount, l.currency, l.fee_bearer::text AS fee_bearer, \
     l.split_ratio_json, l.infinite_use, l.use_count, l.confirmed_count, l.active_locked_count, \
     l.redirect_url, l.rail_whitelist, l.env::text AS env, l.state::text AS state, l.expires_at";

const DISPUTE_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("attempt_id", "attemptId", FieldKind::Uuid),
    f("gateway_id", "gatewayId", FieldKind::Uuid),
    f("rail_id", "railId", FieldKind::Uuid),
    f(
        "external_dispute_ref",
        "externalDisputeRef",
        FieldKind::Text,
    ),
    f("source", "source", FieldKind::Text),
    f("reason_code", "reasonCode", FieldKind::Text),
    f("amount", "amount", FieldKind::Decimal),
    f("currency", "currency", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("opened_at", "openedAt", FieldKind::Timestamp),
    f("evidence_due_at", "evidenceDueAt", FieldKind::Timestamp),
    f("outcome_at", "outcomeAt", FieldKind::Timestamp),
    f("adjustment_id", "adjustmentId", FieldKind::Text),
    f("evidence_json", "evidenceJson", FieldKind::Json),
];

const DISPUTE_COLUMNS: &str = "d.id, d.created_at, d.updated_at, d.attempt_id, d.gateway_id, \
     d.rail_id, d.external_dispute_ref, d.source::text AS source, d.reason_code, d.amount, \
     d.currency, d.status::text AS status, d.opened_at, d.evidence_due_at, d.outcome_at, \
     d.adjustment_id, d.evidence_json";

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

const OPTION_LIMIT: u32 = 100;

fn option_item(
    value: impl Into<String>,
    title: impl Into<String>,
    subtitle: Option<String>,
) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("value".to_owned(), Value::String(value.into()));
    map.insert("title".to_owned(), Value::String(title.into()));
    if let Some(subtitle) = subtitle {
        map.insert("subtitle".to_owned(), Value::String(subtitle));
    }
    Value::Object(map)
}

/// `GET /internal/merchant/options/:kind` — the autocomplete option lists of the portal.
pub fn options_kind<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(
                principal,
                &[
                    "merchant:read",
                    "merchant:write",
                    "link:read",
                    "payment:read",
                ],
            )?;
            let kind = path_segment(request, 3)
                .ok_or_else(|| ApiError::new(400, "UNKNOWN_OPTION_KIND", "Unknown option kind"))?
                .to_owned();
            Ok((principal, merchant_id, kind))
        })();
        let (principal, merchant_id, kind) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let search = query_scalar(request, "search")
            .unwrap_or_default()
            .trim()
            .to_owned();
        let limit =
            super::positive_int(query_scalar(request, "limit").as_deref(), 50, OPTION_LIMIT);
        let scope = application_scope(principal);

        let items: Result<Vec<Value>, ApiError> = async {
            match kind.as_str() {
                "applications" => {
                    let mut sql = String::from(
                        "SELECT a.id, a.name, a.status::text AS status FROM applications a \
                         WHERE a.merchant_id = $1",
                    );
                    let mut next = 2;
                    if !search.is_empty() {
                        sql.push_str(&format!(" AND a.name ILIKE ${next}"));
                        next += 1;
                    }
                    let scoped = scope.as_deref().filter(|entries| !entries.is_empty());
                    if scoped.is_some() {
                        sql.push_str(&format!(" AND a.id = ANY(${next}::uuid[])"));
                        next += 1;
                    }
                    sql.push_str(&format!(" ORDER BY a.name ASC LIMIT ${next}"));
                    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(merchant_id);
                    if !search.is_empty() {
                        query = query.bind(format!("%{search}%"));
                    }
                    if let Some(scope) = scoped {
                        query = query.bind(scope.to_vec());
                    }
                    let rows = query
                        .bind(i64::from(limit))
                        .fetch_all(&state.pools.main)
                        .await
                        .map_err(database_error)?;
                    Ok(rows
                        .iter()
                        .map(|row| {
                            option_item(
                                row.get::<Uuid, _>("id").to_string(),
                                row.get::<String, _>("name"),
                                Some(row.get::<String, _>("status")),
                            )
                        })
                        .collect())
                }
                "wallets" => {
                    let rows = sqlx::query(
                        "SELECT id, currency, status::text AS status FROM wallets \
                          WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2",
                    )
                    .bind(merchant_id)
                    .bind(i64::from(limit))
                    .fetch_all(&state.pools.main)
                    .await
                    .map_err(database_error)?;
                    Ok(rows
                        .iter()
                        .map(|row| {
                            let id: Uuid = row.get("id");
                            let currency: String = row.get("currency");
                            option_item(
                                id.to_string(),
                                format!("{currency} · {}", &id.to_string()[..8]),
                                Some(row.get::<String, _>("status")),
                            )
                        })
                        .collect())
                }
                "users" => {
                    let rows = sqlx::query(
                        "SELECT id, email, role::text AS role FROM users \
                          WHERE merchant_id = $1 AND ($2 = '' OR email ILIKE $3 OR phone ILIKE $3) \
                          ORDER BY email ASC LIMIT $4",
                    )
                    .bind(merchant_id)
                    .bind(&search)
                    .bind(format!("%{search}%"))
                    .bind(i64::from(limit))
                    .fetch_all(&state.pools.main)
                    .await
                    .map_err(database_error)?;
                    Ok(rows
                        .iter()
                        .map(|row| {
                            option_item(
                                row.get::<Uuid, _>("id").to_string(),
                                row.get::<String, _>("email"),
                                Some(row.get::<String, _>("role")),
                            )
                        })
                        .collect())
                }
                "rails" => {
                    let mut sql = String::from(
                        "SELECT DISTINCT pa.rail_id, r.code, r.name_en FROM payment_attempts pa \
                         JOIN rails r ON r.id = pa.rail_id WHERE pa.merchant_id = $1",
                    );
                    let scoped = scope.as_deref().is_some_and(|entries| !entries.is_empty());
                    if scoped {
                        sql.push_str(" AND pa.application_id = ANY($2::uuid[])");
                    }
                    sql.push_str(" LIMIT 200");
                    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(merchant_id);
                    if let Some(scope) = scope.as_deref() {
                        if scoped {
                            query = query.bind(scope.to_vec());
                        }
                    }
                    let rows = query
                        .fetch_all(&state.pools.main)
                        .await
                        .map_err(database_error)?;
                    let mut items = Vec::new();
                    let mut seen = std::collections::BTreeSet::new();
                    let lowered = search.to_lowercase();
                    for row in &rows {
                        let rail_id: Uuid = row.get("rail_id");
                        let code: String = row.get("code");
                        let name: Option<String> = row.get("name_en");
                        if code.is_empty() || seen.contains(&code) {
                            continue;
                        }
                        if !lowered.is_empty()
                            && !code.to_lowercase().contains(&lowered)
                            && !name
                                .as_deref()
                                .unwrap_or_default()
                                .to_lowercase()
                                .contains(&lowered)
                        {
                            continue;
                        }
                        seen.insert(code.clone());
                        items.push(option_item(
                            rail_id.to_string(),
                            format!("{} ({code})", name.as_deref().unwrap_or(&code)),
                            None,
                        ));
                        if items.len() >= limit as usize {
                            break;
                        }
                    }
                    Ok(items)
                }
                "gateways" => {
                    let rows = sqlx::query(
                        "SELECT DISTINCT c.gateway_id, g.code, g.name FROM credential_sets c \
                         JOIN gateways g ON g.id = c.gateway_id \
                          WHERE c.owner_type = 'MERCHANT' AND c.owner_merchant_id = $1 LIMIT 100",
                    )
                    .bind(merchant_id)
                    .fetch_all(&state.pools.main)
                    .await
                    .map_err(database_error)?;
                    let lowered = search.to_lowercase();
                    let mut items = Vec::new();
                    for row in &rows {
                        let gateway_id: Uuid = row.get("gateway_id");
                        let code: String = row.get("code");
                        let name: String = row.get("name");
                        if !lowered.is_empty()
                            && !code.to_lowercase().contains(&lowered)
                            && !name.to_lowercase().contains(&lowered)
                        {
                            continue;
                        }
                        items.push(option_item(
                            gateway_id.to_string(),
                            format!("{name} ({code})"),
                            None,
                        ));
                        if items.len() >= limit as usize {
                            break;
                        }
                    }
                    Ok(items)
                }
                "credential-sets" => {
                    let rows = sqlx::query(
                        "SELECT c.id, c.env::text AS env, g.code FROM credential_sets c \
                         JOIN gateways g ON g.id = c.gateway_id \
                          WHERE c.owner_type = 'MERCHANT' AND c.owner_merchant_id = $1 \
                          ORDER BY c.created_at DESC LIMIT $2",
                    )
                    .bind(merchant_id)
                    .bind(i64::from(limit))
                    .fetch_all(&state.pools.main)
                    .await
                    .map_err(database_error)?;
                    Ok(rows
                        .iter()
                        .map(|row| {
                            option_item(
                                row.get::<Uuid, _>("id").to_string(),
                                format!(
                                    "{} · {}",
                                    row.get::<String, _>("code"),
                                    row.get::<String, _>("env")
                                ),
                                None,
                            )
                        })
                        .collect())
                }
                _ => Err(ApiError::new(
                    400,
                    "UNKNOWN_OPTION_KIND",
                    "Unknown option kind",
                )),
            }
        }
        .await;
        match items {
            Ok(items) => {
                let total = items.len();
                json_ok(&json!({ "items": items, "total": total }))
            }
            Err(error) => error_response(request, error),
        }
    })
}

/// Count the placeholders already in a SQL string (`$1`, …) to pick the next one.
#[cfg(test)]
fn query_count(sql: &str) -> i64 {
    let mut highest = 0_i64;
    let bytes = sql.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end > start {
                if let Ok(value) = sql[start..end].parse::<i64>() {
                    highest = highest.max(value);
                }
                index = end;
                continue;
            }
        }
        index += 1;
    }
    highest
}

// ---------------------------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/applications`.
pub fn list_applications<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:read", "merchant:write"])?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        if let Some(scope) = application_scope(principal) {
            set_in_filter(&mut map, "applications", &scope);
        }
        let columns = ColumnMap::new()
            .with("id", "a.id", ColumnKind::Uuid)
            .with("name", "a.name", ColumnKind::Text)
            .with(
                "businessUseDescription",
                "a.business_use_description",
                ColumnKind::Text,
            )
            .with("status", "a.status::text", ColumnKind::Text)
            .with(
                "assignedWalletId",
                "a.assigned_wallet_id::text",
                ColumnKind::Text,
            )
            .with("createdAt", "a.created_at", ColumnKind::Timestamp)
            .with("merchant", "a.merchant_id::text", ColumnKind::Text)
            .with("applications", "a.id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["name", "businessUseDescription"])
            .with_in("status", "status")
            .with_equals("assignedWalletId", "assignedWalletId")
            .with_equals("__merchant", "merchant")
            .with_in("__applications", "applications")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("name", "name")
            .with_sortable("status", "status")
            .with_sortable("createdAt", "createdAt")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT {APPLICATION_COLUMNS}, {APPLICATION_WALLET_COLUMNS} FROM applications a \
             JOIN wallets w ON w.id = a.assigned_wallet_id {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(
            &built,
            "applications a JOIN wallets w ON w.id = a.assigned_wallet_id",
            &state.pools.main,
        )
        .await
        {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let mut applications = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut application = match row_json(row, APPLICATION_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            let wallet = match row_json(row, APPLICATION_WALLET_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            if let Value::Object(map) = &mut application {
                map.insert("assignedWallet".to_owned(), wallet);
            }
            applications.push(application);
        }
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "applications",
            Value::Array(applications),
            total,
            &built,
            &cursors,
        ))
    })
}

fn application_not_found() -> ApiError {
    ApiError::new(
        404,
        "APPLICATION_NOT_FOUND",
        "The application does not exist",
    )
}

/// `GET /internal/merchant/applications/:id`.
pub fn get_application<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:read", "merchant:write"])?;
            let id = path_uuid(
                request,
                4,
                "APPLICATION_NOT_FOUND",
                "The application does not exist",
            )?;
            Ok((principal, merchant_id, id))
        })();
        let (principal, merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let sql = format!(
            "SELECT {APPLICATION_COLUMNS} FROM applications a WHERE a.id = $1 AND a.merchant_id = $2"
        );
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .bind(merchant_id)
            .fetch_optional(&state.pools.main)
            .await;
        match row {
            Ok(Some(row)) => {
                if let Err(error) =
                    assert_application_in_scope(application_scope(principal).as_deref(), Some(id))
                {
                    return error_response(request, error);
                }
                match row_json(&row, APPLICATION_FIELDS) {
                    Ok(application) => json_ok(&json!({ "application": application })),
                    Err(error) => error_response(request, error),
                }
            }
            Ok(None) => error_response(request, application_not_found()),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/links`.
pub fn list_links<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["link:read"])?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        // The portal still sends the old `ACTIVE` filter; the link lifecycle state is PENDING.
        let raw_state = query_scalar(request, "state").filter(|value| !value.is_empty());
        let link_state = raw_state.map(|value| {
            if value == "ACTIVE" {
                "PENDING".to_owned()
            } else {
                value
            }
        });
        if let Some(link_state) = &link_state {
            set_filter(&mut map, "state", link_state.clone());
        }
        if let Some(scope) = application_scope(principal) {
            set_in_filter(&mut map, "applications", &scope);
        }
        let columns = ColumnMap::new()
            .with("id", "l.id", ColumnKind::Uuid)
            .with("key", "l.key", ColumnKind::Text)
            .with("linkKey", "l.key", ColumnKind::Text)
            .with("applicationId", "l.application_id::text", ColumnKind::Text)
            .with("walletId", "l.wallet_id::text", ColumnKind::Text)
            .with("amount", "l.amount", ColumnKind::Decimal)
            .with("useCount", "l.use_count", ColumnKind::Integer)
            .with("state", "l.state::text", ColumnKind::Text)
            .with("status", "l.state::text", ColumnKind::Text)
            .with("expiresAt", "l.expires_at", ColumnKind::Timestamp)
            .with("createdAt", "l.created_at", ColumnKind::Timestamp)
            .with("merchant", "ap.merchant_id::text", ColumnKind::Text)
            .with("applications", "l.application_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["key"])
            .with_equals("applicationId", "applicationId")
            .with_equals("walletId", "walletId")
            .with_equals("__merchant", "merchant")
            .with_equals("__state", "state")
            .with_in("__applications", "applications")
            .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_date(DateFilter::new("expiresAt", "expiresAt").with_keys("dateFrom", "dateTo"))
            .with_sortable("linkKey", "linkKey")
            .with_sortable("amount", "amount")
            .with_sortable("useCount", "useCount")
            .with_sortable("status", "status")
            .with_sortable("expiresAt", "expiresAt")
            .with_sortable("createdAt", "createdAt")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT {LINK_COLUMNS} FROM payment_links l \
             JOIN applications ap ON ap.id = l.application_id {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(
            &built,
            "payment_links l JOIN applications ap ON ap.id = l.application_id",
            &state.pools.main,
        )
        .await
        {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let links = match rows_json(&rows, LINK_FIELDS) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let cursors = match cursor_rows(
            built.keyset.as_ref(),
            &rows,
            &[
                CursorColumn {
                    path: "createdAt",
                    column: "created_at",
                    kind: FieldKind::Timestamp,
                },
                CursorColumn {
                    path: "id",
                    column: "id",
                    kind: FieldKind::Uuid,
                },
            ],
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "links",
            Value::Array(links),
            total,
            &built,
            &cursors,
        ))
    })
}

fn link_not_found() -> ApiError {
    ApiError::new(
        404,
        "PAYMENT_LINK_NOT_FOUND",
        "The payment link does not exist",
    )
}

/// `GET /internal/merchant/links/:id`.
pub fn get_link<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["link:read"])?;
            let id = path_uuid(
                request,
                4,
                "PAYMENT_LINK_NOT_FOUND",
                "The payment link does not exist",
            )?;
            Ok((principal, merchant_id, id))
        })();
        let (principal, merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let sql = format!(
            "SELECT {LINK_COLUMNS} FROM payment_links l \
             JOIN applications ap ON ap.id = l.application_id \
              WHERE l.id = $1 AND ap.merchant_id = $2"
        );
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .bind(merchant_id)
            .fetch_optional(&state.pools.main)
            .await;
        match row {
            Ok(Some(row)) => {
                let application_id: Uuid = row.get("application_id");
                if let Err(error) = assert_application_in_scope(
                    application_scope(principal).as_deref(),
                    Some(application_id),
                ) {
                    return error_response(request, error);
                }
                match row_json(&row, LINK_FIELDS) {
                    Ok(link) => json_ok(&json!({ "link": link })),
                    Err(error) => error_response(request, error),
                }
            }
            Ok(None) => error_response(request, link_not_found()),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

/// `GET /internal/merchant/links/:id/attempts`.
pub fn list_link_attempts<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["link:read"])?;
            let id = path_uuid(
                request,
                4,
                "PAYMENT_LINK_NOT_FOUND",
                "The payment link does not exist",
            )?;
            Ok((principal, merchant_id, id))
        })();
        let (principal, merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let link = sqlx::query(
            "SELECT l.id, l.application_id FROM payment_links l \
             JOIN applications ap ON ap.id = l.application_id \
              WHERE l.id = $1 AND ap.merchant_id = $2",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let link = match link {
            Ok(Some(row)) => row,
            Ok(None) => return error_response(request, link_not_found()),
            Err(error) => return error_response(request, database_error(error)),
        };
        let application_id: Uuid = link.get("application_id");
        if let Err(error) = assert_application_in_scope(
            application_scope(principal).as_deref(),
            Some(application_id),
        ) {
            return error_response(request, error);
        }
        let sql = format!(
            "SELECT {attempt} FROM payment_attempts pa WHERE pa.link_id = $1 \
              ORDER BY pa.created_at DESC, pa.id DESC LIMIT 500",
            attempt = super::ATTEMPT_COLUMNS
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .fetch_all(&state.pools.main)
            .await;
        match rows {
            Ok(rows) => match rows_json(&rows, super::ATTEMPT_FIELDS) {
                Ok(attempts) => json_ok(&json!({ "attempts": attempts })),
                Err(error) => error_response(request, error),
            },
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/payments`.
pub fn list_payments<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["payment:read"])?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        if let Some(scope) = application_scope(principal) {
            set_in_filter(&mut map, "applications", &scope);
        }
        let columns = ColumnMap::new()
            .with("id", "pa.id", ColumnKind::Uuid)
            .with("reference", "pa.reference", ColumnKind::Text)
            .with("status", "pa.status::text", ColumnKind::Text)
            .with("railId", "pa.rail_id::text", ColumnKind::Text)
            .with("applicationId", "pa.application_id::text", ColumnKind::Text)
            .with(
                "totalChargedAmount",
                "pa.total_charged_amount",
                ColumnKind::Decimal,
            )
            .with(
                "platformCommissionAmount",
                "pa.platform_commission_amount",
                ColumnKind::Decimal,
            )
            .with(
                "netMerchantAmount",
                "pa.net_merchant_amount",
                ColumnKind::Decimal,
            )
            .with("createdAt", "pa.created_at", ColumnKind::Timestamp)
            .with("terminalAt", "pa.terminal_at", ColumnKind::Timestamp)
            .with("merchant", "pa.merchant_id::text", ColumnKind::Text)
            .with("applications", "pa.application_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            .with_search(&["reference"])
            .with_in("status", "status")
            .with_equals("railId", "railId")
            .with_equals("applicationId", "applicationId")
            .with_equals("__merchant", "merchant")
            .with_in("__applications", "applications")
            .with_range(RangeFilter::new(
                "amount",
                "totalChargedAmount",
                RangeKind::Decimal,
            ))
            .with_range(RangeFilter::new(
                "commission",
                "platformCommissionAmount",
                RangeKind::Decimal,
            ))
            .with_range(RangeFilter::new(
                "net",
                "netMerchantAmount",
                RangeKind::Decimal,
            ))
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_date(DateFilter::new("confirmedAt", "terminalAt").with_keys("dateFrom", "dateTo"))
            .with_sortable("reference", "reference")
            .with_sortable("amount", "totalChargedAmount")
            .with_sortable("status", "status")
            .with_sortable("createdAt", "createdAt")
            .with_sortable("confirmedAt", "terminalAt")
            .with_default_sort("createdAt", SortDirection::Desc)
            .with_keyset_field("reference")
            .with_keyset_field("totalChargedAmount")
            .with_keyset_field("status");
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT {} FROM payment_attempts pa {} ORDER BY {} LIMIT ${} OFFSET ${}",
            super::ATTEMPT_COLUMNS,
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total =
            match count_unless_skipped(&built, "payment_attempts pa", &state.pools.main).await {
                Ok(total) => total,
                Err(error) => return error_response(request, crate::auth::db_error(error)),
            };
        let payments = match rows_json(&rows, super::ATTEMPT_FIELDS) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let cursors = match cursor_rows(built.keyset.as_ref(), &rows, super::ATTEMPT_CURSORS) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&list_response(
            "payments",
            Value::Array(payments),
            total,
            &built,
            &cursors,
        ))
    })
}

// ---------------------------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/disputes`.
pub fn list_disputes<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["payment:read", "dispute:respond"])?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        if let Some(scope) = application_scope(principal) {
            set_in_filter(&mut map, "applications", &scope);
        }
        let columns = ColumnMap::new()
            .with("id", "d.id", ColumnKind::Uuid)
            .with("disputeRef", "d.external_dispute_ref", ColumnKind::Text)
            .with("reasonCode", "d.reason_code", ColumnKind::Text)
            .with("status", "d.status::text", ColumnKind::Text)
            .with("amount", "d.amount", ColumnKind::Decimal)
            .with("openedAt", "d.opened_at", ColumnKind::Timestamp)
            .with("evidenceDueAt", "d.evidence_due_at", ColumnKind::Timestamp)
            .with("merchant", "a.merchant_id::text", ColumnKind::Text)
            .with("applications", "a.application_id::text", ColumnKind::Text);
        let spec = ListSpec::default()
            // TS passes the non-existent Prisma field `disputeRef` (the model is
            // `externalDisputeRef`); the port maps it to the real column instead of failing.
            .with_search(&["disputeRef", "reasonCode"])
            .with_in("status", "status")
            .with_equals("__merchant", "merchant")
            .with_in("__applications", "applications")
            .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
            .with_date(DateFilter::new("createdAt", "openedAt"))
            .with_date(
                DateFilter::new("evidenceDueAt", "evidenceDueAt").with_keys("dateFrom", "dateTo"),
            )
            .with_sortable("disputeRef", "disputeRef")
            .with_sortable("status", "status")
            .with_sortable("amount", "amount")
            .with_sortable("evidenceDueAt", "evidenceDueAt")
            .with_default_sort("openedAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT {DISPUTE_COLUMNS} FROM disputes d \
             JOIN payment_attempts a ON a.id = d.attempt_id {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(
            &built,
            "disputes d JOIN payment_attempts a ON a.id = d.attempt_id",
            &state.pools.main,
        )
        .await
        {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let mut disputes = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut dispute = match row_json(row, DISPUTE_FIELDS) {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
            let state_value = dispute.get("status").cloned().unwrap_or(Value::Null);
            if let Value::Object(map) = &mut dispute {
                map.insert("state".to_owned(), state_value);
            }
            disputes.push(dispute);
        }
        json_ok(&list_response(
            "disputes",
            Value::Array(disputes),
            total,
            &built,
            &[],
        ))
    })
}

fn dispute_not_found() -> ApiError {
    ApiError::new(404, "DISPUTE_NOT_FOUND", "The dispute does not exist")
}

async fn load_dispute(
    state: &AppState,
    merchant_id: Uuid,
    scope: Option<&[Uuid]>,
    id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, ApiError> {
    let scoped = scope.is_some_and(|entries| !entries.is_empty());
    let mut sql = format!(
        "SELECT {DISPUTE_COLUMNS} FROM disputes d \
         JOIN payment_attempts a ON a.id = d.attempt_id \
          WHERE d.id = $1 AND a.merchant_id = $2"
    );
    if scoped {
        sql.push_str(" AND a.application_id = ANY($3::uuid[])");
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(merchant_id);
    if let Some(scope) = scope {
        if scoped {
            query = query.bind(scope.to_vec());
        }
    }
    query
        .fetch_optional(&state.pools.main)
        .await
        .map_err(database_error)
}

/// `GET /internal/merchant/disputes/:id`.
pub fn get_dispute<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["payment:read", "dispute:respond"])?;
            let id = path_uuid(
                request,
                4,
                "DISPUTE_NOT_FOUND",
                "The dispute does not exist",
            )?;
            Ok((principal, merchant_id, id))
        })();
        let (principal, merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let scope = application_scope(principal);
        match load_dispute(state, merchant_id, scope.as_deref(), id).await {
            Ok(Some(row)) => match row_json(&row, DISPUTE_FIELDS) {
                Ok(dispute) => json_ok(&json!({ "dispute": dispute })),
                Err(error) => error_response(request, error),
            },
            Ok(None) => error_response(request, dispute_not_found()),
            Err(error) => error_response(request, error),
        }
    })
}

const ATTACHMENT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("dispute_id", "disputeId", FieldKind::Uuid),
    f("label", "label", FieldKind::Text),
    f("uploaded_by_id", "uploadedById", FieldKind::Text),
    f("created_at", "createdAt", FieldKind::Timestamptz),
    f("original_filename", "fileName", FieldKind::Text),
    f("detected_mime_type", "mimeType", FieldKind::Text),
    f("byte_size", "byteSize", FieldKind::BigIntText),
    f("sha256_hex", "sha256", FieldKind::Text),
    f("storage_status", "status", FieldKind::Text),
    f("av_scan_status", "avScanStatus", FieldKind::Text),
];

/// `GET /internal/merchant/disputes/:id/attachments`.
pub fn list_dispute_attachments<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["payment:read", "dispute:respond"])?;
            let id = path_uuid(
                request,
                4,
                "DISPUTE_NOT_FOUND",
                "The dispute does not exist",
            )?;
            Ok((principal, merchant_id, id))
        })();
        let (principal, merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let scope = application_scope(principal);
        match load_dispute(state, merchant_id, scope.as_deref(), id).await {
            Ok(None) => return error_response(request, dispute_not_found()),
            Err(error) => return error_response(request, error),
            Ok(Some(_)) => {}
        }
        let rows = sqlx::query(
            "SELECT da.id, da.dispute_id, da.label, da.uploaded_by_id, da.created_at, \
                    s.original_filename, s.detected_mime_type, s.byte_size, s.sha256_hex, \
                    s.status::text AS storage_status, s.av_scan_status::text AS av_scan_status \
               FROM dispute_attachments da \
               JOIN storage_objects s ON s.id = da.storage_object_id \
              WHERE da.dispute_id = $1 AND da.merchant_id = $2 \
              ORDER BY da.created_at DESC",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_all(&state.pools.main)
        .await;
        match rows {
            Ok(rows) => match rows_json(&rows, ATTACHMENT_FIELDS) {
                Ok(attachments) => json_ok(&json!({ "attachments": attachments })),
                Err(error) => error_response(request, error),
            },
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

/// `GET /internal/merchant/disputes/:id/attachments/:attachmentId/content`.
///
/// The bytes are read and decrypted through the shared object-storage SDK (`pg-objstore`); the
/// storage key never reaches the response, the audit row or a log. The checks follow
/// `readAuthorized` (`objectStorageSdk/index.ts:492`): object status, GC claim, holder lock, tenant
/// and the `DISPUTE_EVIDENCE` authority list.
pub fn dispute_attachment_content<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["payment:read", "dispute:respond"])?;
            let dispute_id = path_uuid(
                request,
                4,
                "DISPUTE_NOT_FOUND",
                "The dispute does not exist",
            )?;
            let attachment_id = path_uuid(
                request,
                6,
                "DISPUTE_ATTACHMENT_NOT_FOUND",
                "The dispute attachment does not exist",
            )?;
            Ok((principal, merchant_id, dispute_id, attachment_id))
        })();
        let (principal, merchant_id, dispute_id, attachment_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let scope = application_scope(principal);
        match load_dispute(state, merchant_id, scope.as_deref(), dispute_id).await {
            Ok(Some(_)) => {}
            Ok(None) => return error_response(request, dispute_not_found()),
            Err(error) => return error_response(request, error),
        }
        let attachment = sqlx::query(
            "SELECT id, storage_object_id FROM dispute_attachments               WHERE id = $1 AND dispute_id = $2 AND merchant_id = $3",
        )
        .bind(attachment_id)
        .bind(dispute_id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let attachment = match attachment {
            Ok(Some(row)) => row,
            Ok(None) => {
                return error_response(
                    request,
                    ApiError::new(
                        404,
                        "DISPUTE_ATTACHMENT_NOT_FOUND",
                        "The dispute attachment does not exist",
                    ),
                )
            }
            Err(error) => return error_response(request, database_error(error)),
        };
        let attachment_id_value: Uuid = attachment.get("id");
        let object_id: Uuid = attachment.get("storage_object_id");
        let actor_id = principal
            .user_id
            .clone()
            .unwrap_or_else(|| merchant_id.to_string());
        let ip = crate::http::peer_ip(request);
        let holder_id = attachment_id_value.to_string();
        let object = match super::object_storage::load_object(state, object_id).await {
            Ok(Some(object)) => object,
            Ok(None) => {
                return error_response(
                    request,
                    ApiError::new(
                        404,
                        "STORAGE_OBJECT_NOT_FOUND",
                        format!("Object {object_id} not found"),
                    ),
                )
            }
            Err(error) => return error_response(request, error),
        };
        struct DenyContext<'a> {
            state: &'a AppState,
            request: &'a HttpRequest,
            object_id: Uuid,
            actor_id: &'a str,
            holder_id: &'a str,
            ip: Option<&'a str>,
        }
        async fn deny(
            context: &DenyContext<'_>,
            action: &'static str,
            error: ApiError,
        ) -> HttpResponse {
            super::object_storage::write_access_log(
                context.state,
                &super::object_storage::AccessLogEntry {
                    object_id: context.object_id,
                    actor_type: "MERCHANT_USER",
                    actor_id: context.actor_id,
                    action,
                    allowed: false,
                    denial_reason: Some(&error.message),
                    holder_type: Some("DISPUTE_ATTACHMENT"),
                    holder_id: Some(context.holder_id),
                    ip_address: context.ip,
                    request_id: None,
                    bytes_served: None,
                },
            )
            .await;
            error_response(context.request, error)
        }
        let context = DenyContext {
            state,
            request,
            object_id,
            actor_id: &actor_id,
            holder_id: &holder_id,
            ip: ip.as_deref(),
        };
        if let Some(error) = super::object_storage::status_error(&object.status, object_id) {
            let action = if object.status.contains("QUARANTINE") {
                "READ_DENIED_QUARANTINE"
            } else {
                "READ_DENIED_STATUS"
            };
            return deny(&context, action, error).await;
        }
        if object.gc_claim_token.is_some() {
            let error = ApiError::new(
                409,
                "STORAGE_OBJECT_GC_IN_PROGRESS",
                format!("Object {object_id} is being collected"),
            );
            return deny(&context, "READ_DENIED_GC_CLAIM", error).await;
        }
        match super::object_storage::has_active_lock(
            state,
            object_id,
            "DISPUTE_ATTACHMENT",
            &holder_id,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => {
                let error = ApiError::new(
                    403,
                    "STORAGE_ACCESS_DENIED",
                    "Requested object is not bound to the specified domain record",
                );
                return deny(&context, "READ_DENIED_HOLDER_MISMATCH", error).await;
            }
            Err(error) => return error_response(request, error),
        }
        if object.owner_merchant_id != Some(merchant_id) {
            let error = ApiError::new(
                403,
                "STORAGE_TENANT_MISMATCH",
                "Cross-tenant access to storage object is forbidden",
            );
            return deny(&context, "READ_DENIED_TENANT_MISMATCH", error).await;
        }
        let held: Vec<String> = pg_domain_auth::authorities::effective_merchant_authorities(
            &principal.as_merchant_principal(),
        )
        .into_iter()
        .collect();
        if !super::object_storage::allowed_for_merchant(&held, &object.confidentiality_tier) {
            let error = ApiError::new(
                403,
                "STORAGE_ACCESS_DENIED",
                format!(
                    "Actor lacks required authority \"{}\" to read object {object_id}",
                    object.required_authority
                ),
            );
            return deny(&context, "READ_DENIED_AUTHORITY", error).await;
        }
        let bytes = match super::object_storage::read_object(state, &object).await {
            Ok(bytes) => bytes,
            Err(error) => return error_response(request, error),
        };
        super::object_storage::write_access_log(
            state,
            &super::object_storage::AccessLogEntry {
                object_id,
                actor_type: "MERCHANT_USER",
                actor_id: &actor_id,
                action: "READ_AUTHORIZED",
                allowed: true,
                denial_reason: None,
                holder_type: Some("DISPUTE_ATTACHMENT"),
                holder_id: Some(&holder_id),
                ip_address: ip.as_deref(),
                request_id: None,
                bytes_served: Some(object.byte_size),
            },
        )
        .await;
        let disposition = super::object_storage::content_disposition(
            "attachment",
            object.original_filename.as_deref(),
            "evidence",
        );
        HttpResponse::Ok()
            .content_type(object.detected_mime_type)
            .header("content-disposition", disposition)
            .header("content-security-policy", "sandbox; default-src 'none'")
            .header("cache-control", "private, no-store")
            .header("x-content-type-options", "nosniff")
            .body(bytes)
    })
}

// ---------------------------------------------------------------------------------------------
// External API reads
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/external/links/:key`.
pub fn external_link<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_principal(principal)?;
            assert_merchant_authority(principal, &["link:read", "link:write"])?;
            let key = path_segment(request, 4)
                .ok_or_else(link_not_found)?
                .to_owned();
            Ok((principal, merchant_id, key))
        })();
        let (principal, merchant_id, key) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let scoped = application_scope(principal);
        let mut sql = String::from(
            "SELECT l.key, l.amount, l.currency, l.state::text AS state, l.confirmed_count, \
                    l.use_count, l.application_id \
               FROM payment_links l JOIN applications ap ON ap.id = l.application_id \
              WHERE l.key = $1 AND ap.merchant_id = $2",
        );
        let scoped_bind = scoped.as_deref().is_some_and(|entries| !entries.is_empty());
        if scoped_bind {
            sql.push_str(" AND l.application_id = ANY($3::uuid[])");
        }
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(&key)
            .bind(merchant_id);
        if let Some(scope) = scoped.as_deref() {
            if scoped_bind {
                query = query.bind(scope.to_vec());
            }
        }
        let row = query.fetch_optional(&state.pools.main).await;
        match row {
            Ok(Some(row)) => {
                let amount: rust_decimal::Decimal = row.get("amount");
                json_ok(&json!({
                    "key": row.get::<String, _>("key"),
                    "amount": money4(Some(amount)),
                    "currency": row.get::<String, _>("currency"),
                    "state": row.get::<String, _>("state"),
                    "confirmedCount": row.get::<i32, _>("confirmed_count"),
                    "useCount": row.get::<i32, _>("use_count"),
                }))
            }
            Ok(None) => error_response(request, link_not_found()),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

/// `GET /internal/merchant/external/payments/:reference`.
pub fn external_payment<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_principal(principal)?;
            assert_merchant_authority(principal, &["payment:read"])?;
            let reference = path_segment(request, 4)
                .ok_or_else(|| {
                    ApiError::new(
                        404,
                        "PAYMENT_ATTEMPT_NOT_FOUND",
                        "The payment attempt does not exist",
                    )
                })?
                .to_owned();
            Ok((principal, merchant_id, reference))
        })();
        let (principal, merchant_id, reference) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let scoped = application_scope(principal);
        let scoped_bind = scoped.as_deref().is_some_and(|entries| !entries.is_empty());
        let mut sql = String::from(
            "SELECT pa.reference, pa.status::text AS status, pa.total_charged_amount, \
                    pa.currency, pa.created_at \
               FROM payment_attempts pa WHERE pa.reference = $1 AND pa.merchant_id = $2",
        );
        if scoped_bind {
            sql.push_str(" AND pa.application_id = ANY($3::uuid[])");
        }
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(&reference)
            .bind(merchant_id);
        if let Some(scope) = scoped.as_deref() {
            if scoped_bind {
                query = query.bind(scope.to_vec());
            }
        }
        let row = query.fetch_optional(&state.pools.main).await;
        match row {
            Ok(Some(row)) => {
                let amount: rust_decimal::Decimal = row.get("total_charged_amount");
                let created_at: chrono::NaiveDateTime = row.get("created_at");
                json_ok(&json!({
                    "reference": row.get::<String, _>("reference"),
                    "status": row.get::<String, _>("status"),
                    "amount": money4(Some(amount)),
                    "currency": row.get::<String, _>("currency"),
                    "createdAt": pg_types::JsDate(created_at.and_utc()).to_iso_string(),
                }))
            }
            Ok(None) => error_response(
                request,
                ApiError::new(
                    404,
                    "PAYMENT_ATTEMPT_NOT_FOUND",
                    "The payment attempt does not exist",
                ),
            ),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_items_omit_an_absent_subtitle() {
        let item = option_item("id-1", "Name", None);
        assert!(item.get("subtitle").is_none());
        let item = option_item("id-1", "Name", Some("ACTIVE".to_owned()));
        assert_eq!(item["subtitle"], "ACTIVE");
    }

    #[test]
    fn placeholder_counter_finds_the_highest_number() {
        assert_eq!(query_count("WHERE a = $1 AND b = $2"), 2);
        assert_eq!(query_count("WHERE a = $1 AND b = $11"), 11);
        assert_eq!(query_count("no placeholders"), 0);
    }
}
