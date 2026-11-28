//! `GET /internal/admin/merchants` and `GET /internal/admin/merchants/:id`.
//!
//! Port of `core-back/api/internal/admin.ts:5253` (`/merchants`) and `:5597` (`/merchants/:id`),
//! including `merchantListSelect` (`:4692`), `merchantOperationalFlags` (`:4741`) and
//! `serializeMerchantSummary` (`:4756`).
//!
//! Deliberate lines kept from TS: the support role never sees balances or sensitive fields; the
//! `hasOpenAmlCase` filter returns an empty page (not a 403) for a caller without AML access;
//! `latestJoinRequest` is the newest join request of the page's merchants.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::NaiveDateTime;
use pg_db::{
    build_list_query, count_unless_skipped, ColumnKind, ColumnMap, ColumnMap as Columns,
    DateFilter, ListSpec, SortDirection, SqlBind,
};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::PgPool;

use super::common::{self, Flags};
use super::wallets;

const FROM: &str = "merchants m";

/// `merchantListSelect` (`admin.ts:4692`).
const COLUMNS: &[&str] = &[
    "m.id AS id",
    "m.version AS version",
    "m.created_at AS created_at",
    "m.updated_at AS updated_at",
    "m.legal_name AS legal_name",
    "m.trade_name AS trade_name",
    "m.display_name AS display_name",
    "m.logo_url AS logo_url",
    "m.support_email AS support_email",
    "m.support_phone AS support_phone",
    "m.country::text AS country",
    "m.status::text AS status",
    "m.onboarding_channel AS onboarding_channel",
    "m.contact_email AS contact_email",
    "m.contact_phone AS contact_phone",
    "m.activated_at AS activated_at",
    "m.suspended_at AS suspended_at",
    "m.closed_at AS closed_at",
    "m.suspension_reason_code AS suspension_reason_code",
    "m.closed_reason_code AS closed_reason_code",
    "m.suspension_notes AS suspension_notes",
    "m.closed_notes AS closed_notes",
    "m.tax_id AS tax_id",
    "m.registration_no AS registration_no",
    "m.business_category AS business_category",
    "m.risk_tier::text AS risk_tier",
    "m.kyb_status::text AS kyb_status",
    "m.next_kyb_review_at AS next_kyb_review_at",
    "m.payout_bank_details_json AS payout_bank_details_json",
    "m.commission_receivable_ceiling AS commission_receivable_ceiling",
    "m.negative_balance_ceiling AS negative_balance_ceiling",
    "(SELECT count(*) FROM wallets w WHERE w.merchant_id = m.id) AS wallet_count",
    "(SELECT count(*) FROM applications a WHERE a.merchant_id = m.id) AS application_count",
    "(SELECT count(*) FROM users u WHERE u.merchant_id = m.id) AS user_count",
    "(SELECT count(*) FROM access_tokens t WHERE t.merchant_id = m.id) AS token_count",
    "(SELECT count(*) FROM join_requests jr WHERE jr.merchant_id = m.id) AS join_request_count",
    "(SELECT count(*) FROM kyb_documents kd WHERE kd.merchant_id = m.id) AS kyb_document_count",
];

const OPEN_JOIN_STATUSES: &[&str] = &[
    "DRAFT",
    "SUBMITTED",
    "IN_REVIEW",
    "INFO_REQUESTED",
    "PENDING_CHECKER",
];
const OPEN_AML_STATUSES: &[&str] = &[
    "OPEN",
    "IN_REVIEW",
    "PENDING_CHECKER",
    "FROZEN",
    "ESCALATED_STR",
];

/// One row of `merchantListSelect`.
struct MerchantRow {
    id: String,
    version: i32,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    legal_name: String,
    trade_name: String,
    display_name: Option<String>,
    logo_url: Option<String>,
    support_email: Option<String>,
    support_phone: Option<String>,
    country: String,
    status: String,
    onboarding_channel: String,
    contact_email: Option<String>,
    contact_phone: Option<String>,
    activated_at: Option<NaiveDateTime>,
    suspended_at: Option<NaiveDateTime>,
    closed_at: Option<NaiveDateTime>,
    suspension_reason_code: Option<String>,
    closed_reason_code: Option<String>,
    suspension_notes: Option<String>,
    closed_notes: Option<String>,
    tax_id: Option<String>,
    registration_no: Option<String>,
    business_category: Option<String>,
    risk_tier: String,
    kyb_status: String,
    next_kyb_review_at: Option<NaiveDateTime>,
    payout_bank_details_json: Option<Value>,
    commission_receivable_ceiling: Option<Decimal>,
    negative_balance_ceiling: Decimal,
    wallet_count: i64,
    application_count: i64,
    user_count: i64,
    token_count: i64,
    join_request_count: i64,
    kyb_document_count: i64,
}

impl MerchantRow {
    fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            version: common::i32_of(row, "version")?,
            created_at: common::naive(row, "created_at")?,
            updated_at: common::naive(row, "updated_at")?,
            legal_name: common::text(row, "legal_name")?,
            trade_name: common::text(row, "trade_name")?,
            display_name: common::opt_text(row, "display_name")?,
            logo_url: common::opt_text(row, "logo_url")?,
            support_email: common::opt_text(row, "support_email")?,
            support_phone: common::opt_text(row, "support_phone")?,
            country: common::text(row, "country")?,
            status: common::text(row, "status")?,
            onboarding_channel: common::text(row, "onboarding_channel")?,
            contact_email: common::opt_text(row, "contact_email")?,
            contact_phone: common::opt_text(row, "contact_phone")?,
            activated_at: common::opt_naive(row, "activated_at")?,
            suspended_at: common::opt_naive(row, "suspended_at")?,
            closed_at: common::opt_naive(row, "closed_at")?,
            suspension_reason_code: common::opt_text(row, "suspension_reason_code")?,
            closed_reason_code: common::opt_text(row, "closed_reason_code")?,
            suspension_notes: common::opt_text(row, "suspension_notes")?,
            closed_notes: common::opt_text(row, "closed_notes")?,
            tax_id: common::opt_text(row, "tax_id")?,
            registration_no: common::opt_text(row, "registration_no")?,
            business_category: common::opt_text(row, "business_category")?,
            risk_tier: common::text(row, "risk_tier")?,
            kyb_status: common::text(row, "kyb_status")?,
            next_kyb_review_at: common::opt_naive(row, "next_kyb_review_at")?,
            payout_bank_details_json: common::opt_json(row, "payout_bank_details_json")?,
            commission_receivable_ceiling: common::opt_decimal(
                row,
                "commission_receivable_ceiling",
            )?,
            negative_balance_ceiling: common::decimal(row, "negative_balance_ceiling")?,
            wallet_count: common::i64_of(row, "wallet_count")?,
            application_count: common::i64_of(row, "application_count")?,
            user_count: common::i64_of(row, "user_count")?,
            token_count: common::i64_of(row, "token_count")?,
            join_request_count: common::i64_of(row, "join_request_count")?,
            kyb_document_count: common::i64_of(row, "kyb_document_count")?,
        })
    }

    /// `merchantStatusReasonVisible` (`admin.ts:4751`).
    fn status_reason_visible(&self, flags: &Flags) -> bool {
        self.suspension_reason_code.is_some()
            && flags.can_sensitive
            && (flags.can_aml || self.suspension_reason_code.as_deref() != Some("AML"))
    }

    /// `serializeMerchantSummary`.
    fn to_summary(&self, flags: &Flags, pending_approval_count: i64, latest_join: Value) -> Value {
        let mut out = Map::new();
        out.insert("id".to_owned(), Value::String(self.id.clone()));
        out.insert("version".to_owned(), Value::from(self.version));
        out.insert(
            "createdAt".to_owned(),
            Value::String(common::iso_naive(self.created_at)),
        );
        out.insert(
            "updatedAt".to_owned(),
            Value::String(common::iso_naive(self.updated_at)),
        );
        out.insert(
            "legalName".to_owned(),
            Value::String(self.legal_name.clone()),
        );
        out.insert(
            "tradeName".to_owned(),
            Value::String(self.trade_name.clone()),
        );
        out.insert(
            "displayName".to_owned(),
            Value::String(
                self.display_name
                    .clone()
                    .unwrap_or_else(|| self.trade_name.clone()),
            ),
        );
        out.insert(
            "logoUrl".to_owned(),
            self.logo_url.clone().map_or(Value::Null, Value::String),
        );
        out.insert(
            "supportEmail".to_owned(),
            self.support_email
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert(
            "supportPhone".to_owned(),
            self.support_phone
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert("country".to_owned(), Value::String(self.country.clone()));
        out.insert("status".to_owned(), Value::String(self.status.clone()));
        out.insert(
            "onboardingChannel".to_owned(),
            Value::String(self.onboarding_channel.clone()),
        );
        out.insert(
            "contactEmail".to_owned(),
            self.contact_email
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert(
            "contactPhone".to_owned(),
            self.contact_phone
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert(
            "activatedAt".to_owned(),
            common::iso_value(self.activated_at),
        );
        out.insert(
            "suspendedAt".to_owned(),
            common::iso_value(self.suspended_at),
        );
        out.insert("closedAt".to_owned(), common::iso_value(self.closed_at));

        let reason_visible = self.status_reason_visible(flags);
        out.insert(
            "suspensionReasonCode".to_owned(),
            if reason_visible {
                self.suspension_reason_code
                    .clone()
                    .map_or(Value::Null, Value::String)
            } else {
                Value::Null
            },
        );
        out.insert(
            "suspensionReasonRedacted".to_owned(),
            Value::Bool(self.suspension_reason_code.is_some() && !reason_visible),
        );
        out.insert(
            "closedReasonCode".to_owned(),
            if flags.can_sensitive {
                self.closed_reason_code
                    .clone()
                    .map_or(Value::Null, Value::String)
            } else {
                Value::Null
            },
        );

        let mut redacted: Vec<Value> = Vec::new();
        if flags.can_sensitive {
            out.insert(
                "taxId".to_owned(),
                self.tax_id.clone().map_or(Value::Null, Value::String),
            );
            out.insert(
                "registrationNo".to_owned(),
                self.registration_no
                    .clone()
                    .map_or(Value::Null, Value::String),
            );
            out.insert(
                "businessCategory".to_owned(),
                self.business_category
                    .clone()
                    .map_or(Value::Null, Value::String),
            );
            out.insert("riskTier".to_owned(), Value::String(self.risk_tier.clone()));
            out.insert(
                "kybStatus".to_owned(),
                Value::String(self.kyb_status.clone()),
            );
            out.insert(
                "nextKybReviewAt".to_owned(),
                common::iso_value(self.next_kyb_review_at),
            );
            out.insert(
                "suspensionNotes".to_owned(),
                self.suspension_notes
                    .clone()
                    .map_or(Value::Null, Value::String),
            );
            out.insert(
                "closedNotes".to_owned(),
                self.closed_notes.clone().map_or(Value::Null, Value::String),
            );
        } else {
            for field in [
                "taxId",
                "registrationNo",
                "businessCategory",
                "riskTier",
                "kybStatus",
                "nextKybReviewAt",
                "suspensionNotes",
                "closedReasonCode",
                "closedNotes",
            ] {
                redacted.push(Value::String(field.to_owned()));
            }
        }

        if flags.can_financial {
            out.insert(
                "payoutBankDetailsJson".to_owned(),
                self.payout_bank_details_json.clone().unwrap_or(Value::Null),
            );
            out.insert(
                "commissionReceivableCeiling".to_owned(),
                self.commission_receivable_ceiling
                    .map_or(Value::Null, common::decimal_js),
            );
            out.insert(
                "negativeBalanceCeiling".to_owned(),
                common::decimal_js(self.negative_balance_ceiling),
            );
        } else {
            for field in [
                "payoutBankDetailsJson",
                "commissionReceivableCeiling",
                "negativeBalanceCeiling",
            ] {
                redacted.push(Value::String(field.to_owned()));
            }
        }

        if self.suspension_reason_code.is_some() && !reason_visible {
            redacted.push(Value::String("suspensionReasonCode".to_owned()));
        }

        out.insert("walletCount".to_owned(), Value::from(self.wallet_count));
        out.insert(
            "applicationCount".to_owned(),
            Value::from(self.application_count),
        );
        out.insert("userCount".to_owned(), Value::from(self.user_count));
        out.insert("tokenCount".to_owned(), Value::from(self.token_count));
        out.insert(
            "joinRequestCount".to_owned(),
            Value::from(self.join_request_count),
        );
        out.insert(
            "kybDocumentCount".to_owned(),
            Value::from(self.kyb_document_count),
        );
        out.insert("latestJoinRequest".to_owned(), latest_join);
        out.insert(
            "pendingApprovalCount".to_owned(),
            Value::from(pending_approval_count),
        );
        out.insert("redactedFields".to_owned(), Value::Array(redacted));
        Value::Object(out)
    }
}

fn columns() -> ColumnMap {
    Columns::new()
        // search
        .with("legalName", "m.legal_name", ColumnKind::Text)
        .with("tradeName", "m.trade_name", ColumnKind::Text)
        .with("contactEmail", "m.contact_email", ColumnKind::Text)
        .with("contactPhone", "m.contact_phone", ColumnKind::Text)
        .with("taxId", "m.tax_id", ColumnKind::Text)
        .with("registrationNo", "m.registration_no", ColumnKind::Text)
        .with("displayName", "m.display_name", ColumnKind::Text)
        // filters
        .with("statusFilter", "m.status::text", ColumnKind::Text)
        .with("kybFilter", "m.kyb_status::text", ColumnKind::Text)
        .with("riskFilter", "m.risk_tier::text", ColumnKind::Text)
        .with(
            "onboardingChannel",
            "m.onboarding_channel",
            ColumnKind::Text,
        )
        .with("country", "m.country::text", ColumnKind::Text)
        // dates and sort
        .with("createdAt", "m.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "m.updated_at", ColumnKind::Timestamp)
        .with("activatedAt", "m.activated_at", ColumnKind::Timestamp)
        .with(
            "nextKybReviewAt",
            "m.next_kyb_review_at",
            ColumnKind::Timestamp,
        )
        .with("status", "m.status", ColumnKind::Text)
        .with("riskTier", "m.risk_tier", ColumnKind::Text)
        .with("kybStatus", "m.kyb_status", ColumnKind::Text)
        .with("id", "m.id", ColumnKind::Uuid)
}

fn spec(can_sensitive: bool) -> ListSpec {
    let search: Vec<&str> = if can_sensitive {
        vec![
            "legalName",
            "tradeName",
            "contactEmail",
            "contactPhone",
            "taxId",
            "registrationNo",
        ]
    } else {
        vec!["legalName", "tradeName", "contactEmail", "contactPhone"]
    };
    ListSpec::default()
        .with_search(&search)
        .with_contains("merchantName", &["displayName", "tradeName"])
        .with_contains("businessName", &["legalName"])
        .with_in("status", "statusFilter")
        .with_in("kybStatus", "kybFilter")
        .with_in("riskTier", "riskFilter")
        .with_in("onboardingChannel", "onboardingChannel")
        .with_equals("country", "country")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(
            DateFilter::new("activatedAt", "activatedAt").with_keys("activatedFrom", "activatedTo"),
        )
        .with_date(
            DateFilter::new("nextKybReviewAt", "nextKybReviewAt")
                .with_keys("reviewFrom", "reviewTo"),
        )
        .with_sortable("legalName", "legalName")
        .with_sortable("tradeName", "tradeName")
        .with_sortable("status", "status")
        .with_sortable("riskTier", "riskTier")
        .with_sortable("kybStatus", "kybStatus")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("activatedAt", "activatedAt")
        .with_sortable("nextKybReviewAt", "nextKybReviewAt")
        .with_default_sort("createdAt", SortDirection::Desc)
}

async fn load_latest_join_requests(
    pool: &PgPool,
    ids: &[String],
) -> Result<BTreeMap<String, Value>, ApiError> {
    let mut map = BTreeMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT DISTINCT ON (merchant_id) merchant_id, id, status::text AS status, submitted_at, \
         proposed_risk_tier::text AS proposed_risk_tier, created_at \
         FROM join_requests WHERE merchant_id = ANY($1::uuid[]) \
         ORDER BY merchant_id, created_at DESC",
    )
    .bind(common::uuid_values(ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        let merchant_id = common::uuid_text(row, "merchant_id")?;
        let value = json!({
            "id": common::uuid_text(row, "id")?,
            "status": common::text(row, "status")?,
            "submittedAt": common::iso_value(common::opt_naive(row, "submitted_at")?),
            "proposedRiskTier": common::text(row, "proposed_risk_tier")?,
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
        });
        map.insert(merchant_id, value);
    }
    Ok(map)
}

async fn load_pending_approval_counts(
    pool: &PgPool,
    ids: &[String],
) -> Result<BTreeMap<String, i64>, ApiError> {
    let mut map = BTreeMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT subject_id, count(*) AS count FROM approval_requests \
         WHERE subject_type = 'MERCHANT' AND state::text = 'PENDING_REVIEW' \
         AND subject_id = ANY($1::text[]) GROUP BY subject_id",
    )
    .bind(ids)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.insert(
            common::text(row, "subject_id")?,
            common::i64_of(row, "count")?,
        );
    }
    Ok(map)
}

/// `GET /internal/admin/merchants`.
pub async fn list(
    pool: &PgPool,
    principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    let flags = common::flags(principal);
    let mut built = build_list_query(&query, &spec(flags.can_sensitive), &columns())
        .map_err(common::list_error)?;

    let request_ref = common::query_text(&query, "requestRef");
    if let Some(request_ref) = request_ref.as_deref() {
        built.binds.push(SqlBind::Text(format!("%{request_ref}%")));
        let placeholder = built.binds.len();
        common::add_condition(
            &mut built,
            &format!(
                "EXISTS (SELECT 1 FROM join_requests jr WHERE jr.merchant_id = m.id \
                 AND jr.id::text ILIKE ${placeholder}::text)"
            ),
        );
    }
    if common::query_raw(&query, "hasOpenJoinRequest") == Some("true") {
        common::add_condition(
            &mut built,
            &format!(
                "EXISTS (SELECT 1 FROM join_requests jr WHERE jr.merchant_id = m.id \
                 AND jr.status::text IN ({}))",
                quoted(OPEN_JOIN_STATUSES)
            ),
        );
    }
    if common::query_raw(&query, "hasOpenAmlCase") == Some("true") {
        if !flags.can_aml {
            let page = built.page;
            let page_size = built.page_size;
            return Ok(json!({
                "merchants": [],
                "total": 0,
                "page": number(page),
                "pageSize": number(page_size),
            }));
        }
        common::add_condition(
            &mut built,
            &format!(
                "EXISTS (SELECT 1 FROM aml_cases ac WHERE ac.subject_type::text = 'MERCHANT' \
                 AND ac.subject_id = m.id::text AND ac.status::text IN ({}))",
                quoted(OPEN_AML_STATUSES)
            ),
        );
    }

    let sql = built.select_sql(FROM, COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = count_unless_skipped(&built, FROM, pool)
        .await
        .map_err(common::list_error)?;

    let ids: Vec<String> = rows
        .iter()
        .map(|row| common::uuid_text(row, "id"))
        .collect::<Result<_, _>>()?;
    let pending = load_pending_approval_counts(pool, &ids).await?;
    let latest = load_latest_join_requests(pool, &ids).await?;

    let mut output = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let merchant = MerchantRow::from_row(row)?;
        output.push(merchant.to_summary(
            &flags,
            pending.get(&merchant.id).copied().unwrap_or(0),
            latest.get(&merchant.id).cloned().unwrap_or(Value::Null),
        ));
        if let Some(plan) = &built.keyset {
            let values = common::cursor_values(
                plan,
                merchant.created_at,
                Some(merchant.updated_at),
                &merchant.id,
            );
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
    }

    Ok(pg_db::list_response(
        "merchants",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ))
}

/// `GET /internal/admin/merchants/:id`.
pub async fn detail(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
) -> Result<Value, ApiError> {
    let merchant_id = parse_uuid(id)?;
    let flags = common::flags(principal);

    let sql = format!("SELECT {} FROM {FROM} WHERE m.id = $1", COLUMNS.join(", "));
    let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(merchant_id)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?
        .ok_or_else(|| ApiError::new(404, "MERCHANT_NOT_FOUND", "The merchant does not exist"))?;
    let merchant = MerchantRow::from_row(&row)?;

    let pending_approvals = if flags.can_sensitive {
        load_pending_changes(pool, merchant_id).await?
    } else {
        Vec::new()
    };
    let pending_count = if flags.can_sensitive {
        pending_approvals.len() as i64
    } else {
        count_pending_approvals(pool, merchant_id).await?
    };
    let latest = load_latest_join_requests(pool, std::slice::from_ref(&merchant.id))
        .await?
        .remove(&merchant.id)
        .unwrap_or(Value::Null);
    let summary = merchant.to_summary(&flags, pending_count, latest);

    let field_history = load_field_history(pool, merchant_id, &flags).await?;

    let mut out = match summary {
        Value::Object(map) => map,
        other => return Ok(other),
    };

    if flags.can_sensitive {
        out.insert(
            "joinRequests".to_owned(),
            Value::Array(load_join_requests(pool, merchant_id).await?),
        );
        out.insert(
            "kybDocuments".to_owned(),
            Value::Array(load_kyb_documents(pool, merchant_id).await?),
        );
        out.insert(
            "beneficialOwners".to_owned(),
            Value::Array(load_beneficial_owners(pool, merchant_id).await?),
        );
        out.insert(
            "revalidations".to_owned(),
            Value::Array(load_revalidations(pool, merchant_id).await?),
        );
        out.insert(
            "amlCases".to_owned(),
            Value::Array(load_aml_cases(pool, merchant_id, flags.can_aml).await?),
        );
        out.insert("pendingChanges".to_owned(), Value::Array(pending_approvals));
    }

    if flags.can_sensitive || flags.can_financial {
        out.insert(
            "wallets".to_owned(),
            Value::Array(load_wallets(pool, merchant_id).await?),
        );
        out.insert(
            "applications".to_owned(),
            Value::Array(load_applications(pool, merchant_id).await?),
        );
    }

    if flags.can_sensitive {
        out.insert(
            "users".to_owned(),
            Value::Array(load_users(pool, merchant_id).await?),
        );
        out.insert(
            "accessTokens".to_owned(),
            Value::Array(load_access_tokens(pool, merchant_id).await?),
        );
        out.insert(
            "credentialSets".to_owned(),
            Value::Array(load_credential_sets(pool, merchant_id).await?),
        );
    }

    out.insert("fieldHistory".to_owned(), Value::Array(field_history));

    if flags.can_financial {
        out.insert(
            "walletBalance".to_owned(),
            wallets::merchant_wallet_balance(pool, &merchant.id).await?,
        );
        out.insert(
            "metrics".to_owned(),
            Value::Array(load_metrics(pool, merchant_id).await?),
        );
        out.insert(
            "openDisputes".to_owned(),
            Value::from(count_open_disputes(pool, merchant_id).await?),
        );
        out.insert(
            "pendingCashouts".to_owned(),
            Value::from(count_pending_cashouts(pool, merchant_id).await?),
        );
    }

    Ok(json!({ "merchant": Value::Object(out) }))
}

// ---------------------------------------------------------------- detail sections

async fn load_join_requests(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, status::text AS status, onboarding_channel, \
         proposed_risk_tier::text AS proposed_risk_tier, submitted_at, sla_due_at, sla_paused_at, \
         created_at, decision, decision_reason_code, four_eyes_required \
         FROM join_requests WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 10",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "status": common::text(row, "status")?,
                "onboardingChannel": common::text(row, "onboarding_channel")?,
                "proposedRiskTier": common::text(row, "proposed_risk_tier")?,
                "submittedAt": common::iso_value(common::opt_naive(row, "submitted_at")?),
                "slaDueAt": common::iso_value(common::opt_naive(row, "sla_due_at")?),
                "slaPausedAt": common::iso_value(common::opt_naive(row, "sla_paused_at")?),
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
                "decision": common::opt_text(row, "decision")?,
                "decisionReasonCode": common::opt_text(row, "decision_reason_code")?,
                "fourEyesRequired": common::bool_of(row, "four_eyes_required")?,
            }))
        })
        .collect()
}

async fn load_kyb_documents(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, doc_type::text AS doc_type, status::text AS status, av_status::text AS av_status, \
         original_file_name, expires_on, reviewed_at, created_at \
         FROM kyb_documents WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 30",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "docType": common::text(row, "doc_type")?,
                "status": common::text(row, "status")?,
                "avStatus": common::text(row, "av_status")?,
                "originalFileName": common::opt_text(row, "original_file_name")?,
                "expiresOn": common::iso_date_value(common::opt_date(row, "expires_on")?),
                "reviewedAt": common::iso_value(common::opt_naive(row, "reviewed_at")?),
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_beneficial_owners(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, full_name_ar, full_name_en, nationality::text AS nationality, \
         ownership_percent, role::text AS role, pep_declared, screening_status::text AS screening_status, active \
         FROM beneficial_owners WHERE merchant_id = $1 ORDER BY active DESC, created_at ASC",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "fullNameAr": common::text(row, "full_name_ar")?,
                "fullNameEn": common::opt_text(row, "full_name_en")?,
                "nationality": common::text(row, "nationality")?,
                "ownershipPercent": common::opt_decimal(row, "ownership_percent")?
                    .map_or(Value::Null, common::decimal_js),
                "role": common::text(row, "role")?,
                "pepDeclared": common::bool_of(row, "pep_declared")?,
                "screeningStatus": common::text(row, "screening_status")?,
                "active": common::bool_of(row, "active")?,
            }))
        })
        .collect()
}

async fn load_revalidations(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, created_at, updated_at, merchant_id, join_request_id, document_id, \
         doc_type::text AS doc_type, reason_code, message, status::text AS status, requested_by, \
         requested_at, due_at, fulfilled_at, fulfilled_document_id, resolution_notes \
         FROM kyb_revalidation_requests \
         WHERE merchant_id = $1 AND status::text IN ('OPEN', 'EXPIRED') ORDER BY requested_at DESC",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
                "updatedAt": common::iso_naive(common::naive(row, "updated_at")?),
                "merchantId": common::uuid_text(row, "merchant_id")?,
                "joinRequestId": common::opt_uuid_text(row, "join_request_id")?,
                "documentId": common::opt_uuid_text(row, "document_id")?,
                "docType": common::text(row, "doc_type")?,
                "reasonCode": common::text(row, "reason_code")?,
                "message": common::text(row, "message")?,
                "status": common::text(row, "status")?,
                "requestedById": common::uuid_text(row, "requested_by")?,
                "requestedAt": common::iso_naive(common::naive(row, "requested_at")?),
                "dueAt": common::iso_value(common::opt_naive(row, "due_at")?),
                "fulfilledAt": common::iso_value(common::opt_naive(row, "fulfilled_at")?),
                "fulfilledDocumentId": common::opt_uuid_text(row, "fulfilled_document_id")?,
                "resolutionNotes": common::opt_text(row, "resolution_notes")?,
            }))
        })
        .collect()
}

async fn load_aml_cases(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
    can_aml: bool,
) -> Result<Vec<Value>, ApiError> {
    if !can_aml {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id, trigger_reason, severity::text AS severity, status::text AS status, \
         sla_due_at, created_at, confidential \
         FROM aml_cases WHERE subject_type::text = 'MERCHANT' AND subject_id = $1::text \
         ORDER BY created_at DESC LIMIT 20",
    )
    .bind(merchant_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "triggerReason": common::text(row, "trigger_reason")?,
                "severity": common::text(row, "severity")?,
                "status": common::text(row, "status")?,
                "slaDueAt": common::iso_value(common::opt_naive(row, "sla_due_at")?),
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
                "confidential": common::bool_of(row, "confidential")?,
            }))
        })
        .collect()
}

async fn load_pending_changes(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT ar.id, ar.state::text AS state, ar.mode::text AS mode, ar.base_version, \
         ar.maker_user_id, ar.maker_reason, ar.payload_diff_json, ar.created_at, ar.expires_at, \
         u.email AS maker_email \
         FROM approval_requests ar JOIN users u ON u.id = ar.maker_user_id \
         WHERE ar.subject_type = 'MERCHANT' AND ar.subject_id = $1::text \
         AND ar.state::text IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED') \
         ORDER BY ar.created_at DESC",
    )
    .bind(merchant_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "state": common::text(row, "state")?,
                "mode": common::text(row, "mode")?,
                "baseVersion": common::opt_i32(row, "base_version")?,
                "makerUserId": common::uuid_text(row, "maker_user_id")?,
                "makerReason": common::opt_text(row, "maker_reason")?,
                "payloadDiffJson": common::json_value(row, "payload_diff_json")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
                "expiresAt": common::iso_value(common::opt_naive(row, "expires_at")?),
                "maker": { "email": common::text(row, "maker_email")? },
            }))
        })
        .collect()
}

async fn count_pending_approvals(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<i64, ApiError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval_requests \
         WHERE subject_type = 'MERCHANT' AND subject_id = $1::text \
         AND state::text IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED')",
    )
    .bind(merchant_id.to_string())
    .fetch_one(pool)
    .await
    .map_err(common::database_error)?;
    Ok(count)
}

const SENSITIVE_HISTORY_FIELDS: &[&str] = &[
    "legalName",
    "taxId",
    "registrationNo",
    "businessCategory",
    "riskTier",
    "kybStatus",
    "payoutBankDetailsJson",
    "commissionReceivableCeiling",
    "negativeBalanceCeiling",
    "contactEmail",
    "contactPhone",
    "suspensionReasonCode",
    "suspensionNotes",
    "closedReasonCode",
    "closedNotes",
];

async fn load_field_history(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
    flags: &Flags,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT d.id, d.created_at, d.updated_at, d.actor_id, d.merchant_id, d.entity_type, \
         d.entity_id, d.field_name, d.old_value, d.new_value, d.approval_request_id, \
         d.source::text AS source, d.request_id, d.client_ip, u.email AS actor_email \
         FROM detail_change_logs d JOIN users u ON u.id = d.actor_id \
         WHERE d.merchant_id = $1 ORDER BY d.created_at DESC LIMIT 25",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;

    let mut output = Vec::with_capacity(rows.len());
    for row in &rows {
        let field_name = common::text(row, "field_name")?;
        let field = field_name
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or_default()
            .to_owned();
        let new_value = common::opt_text(row, "new_value")?;
        let sensitive = SENSITIVE_HISTORY_FIELDS.contains(&field.as_str());
        let aml_reason = field == "suspensionReasonCode" && new_value.as_deref() == Some("AML");
        let redact = (!flags.can_sensitive && sensitive) || (aml_reason && !flags.can_aml);

        let mut entry = Map::new();
        entry.insert(
            "id".to_owned(),
            Value::String(common::uuid_text(row, "id")?),
        );
        entry.insert(
            "createdAt".to_owned(),
            Value::String(common::iso_naive(common::naive(row, "created_at")?)),
        );
        entry.insert(
            "updatedAt".to_owned(),
            Value::String(common::iso_naive(common::naive(row, "updated_at")?)),
        );
        entry.insert(
            "actorId".to_owned(),
            Value::String(common::uuid_text(row, "actor_id")?),
        );
        entry.insert(
            "merchantId".to_owned(),
            common::opt_uuid_text(row, "merchant_id")?.map_or(Value::Null, Value::String),
        );
        entry.insert(
            "entityType".to_owned(),
            Value::String(common::text(row, "entity_type")?),
        );
        entry.insert(
            "entityId".to_owned(),
            Value::String(common::text(row, "entity_id")?),
        );
        entry.insert("fieldName".to_owned(), Value::String(field_name));
        let old_value = common::opt_text(row, "old_value")?;
        entry.insert(
            "oldValue".to_owned(),
            if redact {
                Value::String("[REDACTED]".to_owned())
            } else {
                old_value.map_or(Value::Null, Value::String)
            },
        );
        entry.insert(
            "newValue".to_owned(),
            if redact {
                Value::String("[REDACTED]".to_owned())
            } else {
                new_value.map_or(Value::Null, Value::String)
            },
        );
        entry.insert(
            "approvalRequestId".to_owned(),
            common::opt_uuid_text(row, "approval_request_id")?.map_or(Value::Null, Value::String),
        );
        entry.insert(
            "source".to_owned(),
            Value::String(common::text(row, "source")?),
        );
        entry.insert(
            "requestId".to_owned(),
            Value::String(common::text(row, "request_id")?),
        );
        entry.insert(
            "clientIp".to_owned(),
            common::opt_text(row, "client_ip")?.map_or(Value::Null, Value::String),
        );
        entry.insert(
            "actor".to_owned(),
            json!({ "email": common::text(row, "actor_email")? }),
        );
        entry.insert(
            "actorEmail".to_owned(),
            Value::String(common::text(row, "actor_email")?),
        );
        entry.insert("redacted".to_owned(), Value::Bool(redact));
        output.push(Value::Object(entry));
    }
    Ok(output)
}

async fn load_wallets(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, currency::text AS currency, status::text AS status, created_at \
         FROM wallets WHERE merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "currency": common::text(row, "currency")?,
                "status": common::text(row, "status")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_applications(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, status::text AS status, expected_monthly_volume, assigned_wallet_id, \
         created_at FROM applications WHERE merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "name": common::text(row, "name")?,
                "status": common::text(row, "status")?,
                "expectedMonthlyVolume": common::decimal_js(common::decimal(row, "expected_monthly_volume")?),
                "assignedWalletId": common::uuid_text(row, "assigned_wallet_id")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_users(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, email, phone, role::text AS role, status::text AS status, is_maker, \
         is_checker, mfa_required, created_at FROM users WHERE merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "email": common::text(row, "email")?,
                "phone": common::opt_text(row, "phone")?,
                "role": common::text(row, "role")?,
                "status": common::text(row, "status")?,
                "isMaker": common::bool_of(row, "is_maker")?,
                "isChecker": common::bool_of(row, "is_checker")?,
                "mfaRequired": common::bool_of(row, "mfa_required")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_access_tokens(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, application_id, name, last_four, scopes, ip_whitelist_enabled, revoked_at, \
         last_used_at, created_at FROM access_tokens WHERE merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "applicationId": common::uuid_text(row, "application_id")?,
                "name": common::text(row, "name")?,
                "lastFour": common::text(row, "last_four")?,
                "scopes": common::json_value(row, "scopes")?,
                "ipWhitelistEnabled": common::bool_of(row, "ip_whitelist_enabled")?,
                "revokedAt": common::iso_value(common::opt_naive(row, "revoked_at")?),
                "lastUsedAt": common::iso_value(common::opt_naive(row, "last_used_at")?),
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_credential_sets(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, gateway_id, env::text AS env, owner_type::text AS owner_type, \
         settlement_target::text AS settlement_target, status::text AS status, \
         last_verified_at, expires_at FROM credential_sets WHERE owner_merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "gatewayId": common::uuid_text(row, "gateway_id")?,
                "env": common::text(row, "env")?,
                "ownerType": common::text(row, "owner_type")?,
                "settlementTarget": common::text(row, "settlement_target")?,
                "status": common::text(row, "status")?,
                "lastVerifiedAt": common::iso_value(common::opt_naive(row, "last_verified_at")?),
                "expiresAt": common::iso_value(common::opt_naive(row, "expires_at")?),
            }))
        })
        .collect()
}

async fn load_metrics(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<Vec<Value>, ApiError> {
    let since = chrono::Utc::now().naive_utc() - chrono::Duration::days(30);
    let rows = sqlx::query(
        "SELECT status::text AS status, count(*) AS count, \
         COALESCE(sum(total_charged_amount), 0) AS charged \
         FROM payment_attempts WHERE merchant_id = $1 AND created_at >= $2 \
         GROUP BY status ORDER BY status",
    )
    .bind(merchant_id)
    .bind(since)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "status": common::text(row, "status")?,
                "count": common::i64_of(row, "count")?,
                "chargedAmount": common::decimal_js(common::decimal(row, "charged")?),
            }))
        })
        .collect()
}

async fn count_open_disputes(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM disputes d JOIN payment_attempts pa ON pa.id = d.attempt_id \
         WHERE pa.merchant_id = $1 AND d.status::text IN ('OPENED', 'EVIDENCE_REQUESTED', 'EVIDENCE_SUBMITTED')",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(common::database_error)
}

async fn count_pending_cashouts(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM cashout_requests WHERE merchant_id = $1 \
         AND state::text IN ('PENDING', 'PROCESSING')",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(common::database_error)
}

// ---------------------------------------------------------------- helpers

fn parse_uuid(raw: &str) -> Result<uuid::Uuid, ApiError> {
    uuid::Uuid::parse_str(raw).map_err(|_| {
        ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(
            json!([{ "path": ["id"], "code": "invalid_string", "message": "must be a UUID" }]),
        )
    })
}

fn quoted(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| format!("'{value}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_map_to_text_casts_and_sorts_to_the_enum() {
        let columns = columns();
        assert_eq!(
            columns
                .get("statusFilter")
                .map(|column| column.sql.as_str()),
            Some("m.status::text")
        );
        assert_eq!(
            columns.get("status").map(|column| column.sql.as_str()),
            Some("m.status")
        );
    }

    #[test]
    fn open_status_lists_match_the_ts_constants() {
        assert_eq!(OPEN_JOIN_STATUSES.len(), 5);
        assert!(OPEN_JOIN_STATUSES.contains(&"PENDING_CHECKER"));
        assert_eq!(
            quoted(OPEN_AML_STATUSES),
            "'OPEN', 'IN_REVIEW', 'PENDING_CHECKER', 'FROZEN', 'ESCALATED_STR'"
        );
    }
}
