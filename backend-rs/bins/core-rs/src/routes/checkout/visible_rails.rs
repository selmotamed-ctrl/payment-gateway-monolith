//! Visible-rails resolution for the checkout pay-link read.
//!
//! Port of:
//! - `core-back/engine/flow/VisibleRailsCatalog.ts:loadRailCatalog` (the five catalog reads and
//!   the per-route processed volume of the business day);
//! - `core-back/engine/flow/VisibleRailsResolver.ts:VisibleRailsResolver` (whitelists, commission
//!   profile hierarchy, credential policy, health/canary, limits, daily cap, maintenance windows,
//!   scope, ranking and the exclusion reasons);
//! - `core-back/engine/flow/DailyRouteVolume.ts` (the business-day window; the timezone is read
//!   from `gateway_settings.gateway_timezone`, default `Africa/Tripoli`; the window arithmetic is
//!   done by PostgreSQL so the IANA database is the single source of truth);
//! - `core-back/engine/routeHealth/{policy,decision}.ts` (the policy subset routing needs and the
//!   UTF-16 FNV-1a canary cohort).
//!
//! Money stays `rust_decimal::Decimal`; no float is used for an amount. The resolver is pure so
//! the route module can unit-test it without a database.

#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDateTime, Utc};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::super::common::database_error;
use pg_http::ApiError;

/// Default business-day timezone (`DailyRouteVolume.ts:9`).
pub(super) const DEFAULT_GATEWAY_TIMEZONE: &str = "Africa/Tripoli";
/// `ROUTE_HEALTH_POLICY_KEY` (`engine/routeHealth/policy.ts:6`).
pub(super) const ROUTE_HEALTH_POLICY_KEY: &str = "route_health.policy";
/// Default canary share of a DEGRADED route (`DEFAULT_ROUTE_HEALTH_POLICY.canaryPercent`).
const DEFAULT_CANARY_PERCENT: &str = "5";

/// One `rails` row projected for the resolver.
#[derive(Debug, Clone)]
pub(super) struct RailRecord {
    pub id: Uuid,
    pub code: String,
    pub name_ar: Option<String>,
    pub name_en: Option<String>,
    pub currency: String,
    pub blocked: bool,
    pub display_order: i32,
    pub collection_mode: Option<String>,
    pub help_guide: Option<Value>,
}

/// One `rail_routes` row projected for the resolver.
#[derive(Debug, Clone)]
pub(super) struct RouteRecord {
    pub id: Uuid,
    pub rail_id: Uuid,
    pub gateway_id: Uuid,
    pub credential_policy: String,
    pub priority: i32,
    pub routing_strategy: String,
    pub weight: i32,
    pub cost_model: Value,
    pub min_amount: Decimal,
    pub max_amount: Option<Decimal>,
    pub daily_cap_amount: Option<Decimal>,
    pub status: String,
    pub health_state: String,
    pub health_computed_state: Option<String>,
    pub health_override_state: Option<String>,
    pub health_override_expires_at: Option<NaiveDateTime>,
    pub maintenance_windows: Option<Value>,
    pub scope: Value,
    /// `SUM(total_charged_amount)` of the succeeded attempts of the business day.
    pub daily_processed: Decimal,
}

/// One verified `credential_sets` row (only the columns routing reads).
#[derive(Debug, Clone)]
pub(super) struct CredentialSetRecord {
    pub id: Uuid,
    pub gateway_id: Uuid,
    pub env: String,
    pub owner_type: String,
    pub owner_merchant_id: Option<Uuid>,
}

/// One `commission_profiles` row (the catalog selects the hierarchy columns only).
#[derive(Debug, Clone)]
pub(super) struct CommissionProfileRecord {
    pub id: Uuid,
    pub merchant_id: Option<Uuid>,
    pub application_id: Option<Uuid>,
    pub rail_code: String,
    pub effective_from: NaiveDateTime,
    pub effective_to: Option<NaiveDateTime>,
}

/// `loadRailCatalog` output.
#[derive(Debug, Clone, Default)]
pub(super) struct Catalog {
    pub rails: Vec<RailRecord>,
    pub routes: Vec<RouteRecord>,
    pub credential_sets: Vec<CredentialSetRecord>,
    pub commission_profiles: Vec<CommissionProfileRecord>,
}

/// A ranked route with the credential set that made it eligible.
#[derive(Debug, Clone)]
pub(super) struct RankedRoute {
    pub route: RouteRecord,
    pub credential_set: CredentialSetRecord,
    pub effective_cost: Decimal,
    pub rank: usize,
}

/// A visible rail and its eligible routes.
#[derive(Debug, Clone)]
pub(super) struct VisibleRail {
    pub rail: RailRecord,
    pub commission_profile: CommissionProfileRecord,
    pub routes: Vec<RankedRoute>,
}

/// `VisibleRailsResult` (the evaluated instant is the caller's `now`).
#[derive(Debug, Clone, Default)]
pub(super) struct VisibleResult {
    pub rails: Vec<VisibleRail>,
    pub excluded: Vec<Value>,
}

/// The link/application facts the formula reads.
pub(super) struct VisibleInput<'a> {
    pub application_id: Uuid,
    pub merchant_id: Uuid,
    pub risk_tier: &'a str,
    pub application_rail_whitelist: Option<&'a Value>,
    pub amount: Decimal,
    pub currency: &'a str,
    pub link_rail_whitelist: Option<&'a Value>,
    pub canary_key: &'a str,
    /// The process execution plane (`getExecutionPlane()`).
    pub environment: &'a str,
}

/// The routing subset of the route-health policy.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct RouteHealthRouting {
    pub enabled: bool,
    pub canary_percent: Decimal,
    pub canary_max_amount: Option<Decimal>,
}

impl Default for RouteHealthRouting {
    fn default() -> Self {
        Self {
            enabled: true,
            canary_percent: Decimal::from_str_exact(DEFAULT_CANARY_PERCENT)
                .unwrap_or(Decimal::from(5)),
            canary_max_amount: None,
        }
    }
}

/// `dailyProcessedAmountByRoute` + `loadRailCatalog`.
///
/// The four catalog reads run concurrently; the business-day window is computed by PostgreSQL
/// (`date_trunc('day', now() AT TIME ZONE zone) AT TIME ZONE zone`) after reading the gateway
/// timezone, exactly the two steps of `DailyRouteVolume.ts`.
pub(super) async fn load_catalog(pool: &PgPool, now: DateTime<Utc>) -> Result<Catalog, ApiError> {
    let (rails, routes, credential_sets, commission_profiles, timezone) = tokio::try_join!(
        load_rails(pool),
        load_routes(pool),
        load_credential_sets(pool),
        load_commission_profiles(pool),
        load_gateway_timezone(pool),
    )?;
    let processed = load_daily_processed(pool, now, &timezone).await?;
    let routes = routes
        .into_iter()
        .map(|mut route| {
            route.daily_processed = processed.get(&route.id).copied().unwrap_or_default();
            route
        })
        .collect();
    Ok(Catalog {
        rails,
        routes,
        credential_sets,
        commission_profiles,
    })
}

async fn load_rails(pool: &PgPool) -> Result<Vec<RailRecord>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, code, name_ar, name_en, currency::text AS currency, blocked, display_order,
                collection_mode::text AS collection_mode, help_guide_json
           FROM rails
          ORDER BY display_order ASC, code ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            Ok(RailRecord {
                id: read_uuid(&row, "id")?,
                code: read_string(&row, "code")?,
                name_ar: read_opt_string(&row, "name_ar")?,
                name_en: read_opt_string(&row, "name_en")?,
                currency: read_string(&row, "currency")?,
                blocked: read_bool(&row, "blocked")?,
                display_order: read_i32(&row, "display_order")?,
                collection_mode: read_opt_string(&row, "collection_mode")?,
                help_guide: read_opt_json(&row, "help_guide_json")?,
            })
        })
        .collect()
}

async fn load_routes(pool: &PgPool) -> Result<Vec<RouteRecord>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, rail_id, gateway_id, credential_policy::text AS credential_policy, priority,
                routing_strategy::text AS routing_strategy, weight, cost_model, min_amount,
                max_amount, daily_cap_amount, status::text AS status,
                health_state::text AS health_state,
                health_computed_state::text AS health_computed_state,
                health_override_state::text AS health_override_state,
                health_override_expires_at, maintenance_windows, scope
           FROM rail_routes
          ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            Ok(RouteRecord {
                id: read_uuid(&row, "id")?,
                rail_id: read_uuid(&row, "rail_id")?,
                gateway_id: read_uuid(&row, "gateway_id")?,
                credential_policy: read_string(&row, "credential_policy")?,
                priority: read_i32(&row, "priority")?,
                routing_strategy: read_string(&row, "routing_strategy")?,
                weight: read_i32(&row, "weight")?,
                cost_model: read_json(&row, "cost_model")?,
                min_amount: read_decimal(&row, "min_amount")?,
                max_amount: read_opt_decimal(&row, "max_amount")?,
                daily_cap_amount: read_opt_decimal(&row, "daily_cap_amount")?,
                status: read_string(&row, "status")?,
                health_state: read_string(&row, "health_state")?,
                health_computed_state: read_opt_string(&row, "health_computed_state")?,
                health_override_state: read_opt_string(&row, "health_override_state")?,
                health_override_expires_at: read_opt_naive(&row, "health_override_expires_at")?,
                maintenance_windows: read_opt_json(&row, "maintenance_windows")?,
                scope: read_json(&row, "scope")?,
                daily_processed: Decimal::ZERO,
            })
        })
        .collect()
}

async fn load_credential_sets(pool: &PgPool) -> Result<Vec<CredentialSetRecord>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, gateway_id, env::text AS env, owner_type::text AS owner_type,
                owner_merchant_id
           FROM credential_sets
          WHERE status = 'VERIFIED'
          ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            Ok(CredentialSetRecord {
                id: read_uuid(&row, "id")?,
                gateway_id: read_uuid(&row, "gateway_id")?,
                env: read_string(&row, "env")?,
                owner_type: read_string(&row, "owner_type")?,
                owner_merchant_id: read_opt_uuid(&row, "owner_merchant_id")?,
            })
        })
        .collect()
}

async fn load_commission_profiles(pool: &PgPool) -> Result<Vec<CommissionProfileRecord>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, merchant_id, application_id, rail_code, effective_from, effective_to
           FROM commission_profiles
          ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            Ok(CommissionProfileRecord {
                id: read_uuid(&row, "id")?,
                merchant_id: read_opt_uuid(&row, "merchant_id")?,
                application_id: read_opt_uuid(&row, "application_id")?,
                rail_code: read_string(&row, "rail_code")?,
                effective_from: read_naive(&row, "effective_from")?,
                effective_to: read_opt_naive(&row, "effective_to")?,
            })
        })
        .collect()
}

/// `resolveGatewayTimezone`: first gateway setting ordered by `created_at`, default Tripoli.
async fn load_gateway_timezone(pool: &PgPool) -> Result<String, ApiError> {
    let row = sqlx::query(
        "SELECT gateway_timezone FROM gateway_settings ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(database_error)?;
    let timezone = match row {
        Some(row) => read_opt_string(&row, "gateway_timezone")?,
        None => None,
    };
    Ok(timezone
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|| DEFAULT_GATEWAY_TIMEZONE.to_owned()))
}

/// `sumSucceededAmountByRouteInWindow` with the window from `dayWindowInTimeZone`.
async fn load_daily_processed(
    pool: &PgPool,
    now: DateTime<Utc>,
    timezone: &str,
) -> Result<HashMap<Uuid, Decimal>, ApiError> {
    let rows = sqlx::query(
        "SELECT route_id,
                SUM(total_charged_amount) AS processed_amount
           FROM payment_attempts
          WHERE status = 'SUCCEEDED'
            AND route_id IS NOT NULL
            AND COALESCE(terminal_at, created_at)
                >= (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2)
            AND COALESCE(terminal_at, created_at)
                < ((date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day')
                    AT TIME ZONE $2)
          GROUP BY route_id",
    )
    .bind(now)
    .bind(timezone)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    let mut totals = HashMap::new();
    for row in rows {
        let route_id = read_uuid(&row, "route_id")?;
        let amount = read_opt_decimal(&row, "processed_amount")?.unwrap_or_default();
        totals.insert(route_id, amount);
    }
    Ok(totals)
}

/// `readRouteHealthPolicy` for the routing subset (missing row or malformed values fall back).
pub(super) async fn load_routing_policy(pool: &PgPool) -> Result<RouteHealthRouting, ApiError> {
    let row = sqlx::query(
        "SELECT value_json FROM platform_settings
          WHERE key = $1 AND scope = 'PLATFORM'
          ORDER BY version DESC LIMIT 1",
    )
    .bind(ROUTE_HEALTH_POLICY_KEY)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?;
    let value = match row {
        Some(row) => read_opt_json(&row, "value_json")?,
        None => None,
    };
    Ok(parse_routing_policy(value.as_ref()))
}

/// `parseRouteHealthPolicy` restricted to `enabled`, `canaryPercent`, `canaryMaxAmount`.
#[must_use]
pub(super) fn parse_routing_policy(value: Option<&Value>) -> RouteHealthRouting {
    let defaults = RouteHealthRouting::default();
    let Some(Value::Object(map)) = value else {
        return defaults;
    };
    let enabled = map
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(defaults.enabled);
    let canary_percent = map
        .get("canaryPercent")
        .and_then(json_decimal)
        .map(|percent| percent.clamp(Decimal::ZERO, Decimal::from(100)))
        .unwrap_or(defaults.canary_percent);
    let canary_max_amount = map
        .get("canaryMaxAmount")
        .and_then(json_decimal)
        .filter(|amount| amount > &Decimal::ZERO);
    RouteHealthRouting {
        enabled,
        canary_percent,
        canary_max_amount,
    }
}

/// `VisibleRailsResolver.resolve`.
#[must_use]
pub(super) fn resolve(
    input: &VisibleInput<'_>,
    catalog: &Catalog,
    policy: &RouteHealthRouting,
    now: DateTime<Utc>,
) -> VisibleResult {
    let application_whitelist = string_set(input.application_rail_whitelist);
    let link_whitelist = string_set(input.link_rail_whitelist);
    let allowed: Option<HashSet<String>> = match (application_whitelist, link_whitelist) {
        (None, None) => None,
        (Some(only), None) | (None, Some(only)) => Some(only),
        (Some(application), Some(link)) => Some(application.intersection(&link).cloned().collect()),
    };
    let mut visible = Vec::new();
    let mut excluded = Vec::new();

    for rail in &catalog.rails {
        if rail.blocked {
            excluded.push(exclusion(&rail.code, rail.id, None, "RAIL_BLOCKED", None));
            continue;
        }
        if rail.currency != input.currency {
            excluded.push(exclusion(
                &rail.code,
                rail.id,
                None,
                "CURRENCY_MISMATCH",
                Some(json!({
                    "railCurrency": rail.currency,
                    "linkCurrency": input.currency,
                })),
            ));
            continue;
        }
        if allowed
            .as_ref()
            .is_some_and(|codes| !codes.contains(&rail.code))
        {
            excluded.push(exclusion(
                &rail.code,
                rail.id,
                None,
                "RAIL_NOT_WHITELISTED",
                None,
            ));
            continue;
        }
        let Some(profile) = resolve_commission_profile(
            &catalog.commission_profiles,
            input.merchant_id,
            input.application_id,
            &rail.code,
            now,
        ) else {
            excluded.push(exclusion(
                &rail.code,
                rail.id,
                None,
                "NO_COMMISSION_PROFILE",
                None,
            ));
            continue;
        };

        let mut candidates: Vec<(RouteRecord, CredentialSetRecord)> = Vec::new();
        for route in catalog
            .routes
            .iter()
            .filter(|route| route.rail_id == rail.id)
        {
            let Some(credential_set) = resolve_credential_set(input, route, catalog) else {
                excluded.push(exclusion(
                    &rail.code,
                    rail.id,
                    Some(route.id),
                    "NO_VERIFIED_CREDENTIAL_SET",
                    None,
                ));
                continue;
            };
            if let Some((reason, detail)) = route_exclusion(route, input, policy, now) {
                excluded.push(exclusion(
                    &rail.code,
                    rail.id,
                    Some(route.id),
                    reason,
                    detail,
                ));
                continue;
            }
            candidates.push((route.clone(), credential_set));
        }
        if candidates.is_empty() {
            continue;
        }
        let ranked = rank_routes(candidates, input.amount);
        // Degraded routes are moved to the front, exactly like the TS resolver (their order
        // inside each group is preserved).
        let (mut degraded, healthy): (Vec<_>, Vec<_>) = ranked
            .into_iter()
            .partition(|entry| effective_health(&entry.route, now) == "DEGRADED");
        degraded.extend(healthy);
        visible.push(VisibleRail {
            rail: rail.clone(),
            commission_profile: profile,
            routes: degraded,
        });
    }

    visible.sort_by(|left, right| {
        left.rail
            .display_order
            .cmp(&right.rail.display_order)
            .then_with(|| left.rail.code.cmp(&right.rail.code))
    });
    VisibleResult {
        rails: visible,
        excluded,
    }
}

fn exclusion(
    rail_code: &str,
    rail_id: Uuid,
    route_id: Option<Uuid>,
    reason: &str,
    detail: Option<Value>,
) -> Value {
    let mut object = Map::new();
    object.insert("railCode".to_owned(), Value::String(rail_code.to_owned()));
    object.insert("railId".to_owned(), Value::String(rail_id.to_string()));
    object.insert(
        "routeId".to_owned(),
        route_id.map_or(Value::Null, |id| Value::String(id.to_string())),
    );
    object.insert("reason".to_owned(), Value::String(reason.to_owned()));
    if let Some(detail) = detail {
        object.insert("detail".to_owned(), detail);
    }
    Value::Object(object)
}

fn string_set(value: Option<&Value>) -> Option<HashSet<String>> {
    value.and_then(Value::as_array).map(|entries| {
        entries
            .iter()
            .map(|entry| match entry {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect()
    })
}

/// `resolveCommissionProfile`: application, merchant, platform, `default` — each newest first.
fn resolve_commission_profile(
    profiles: &[CommissionProfileRecord],
    merchant_id: Uuid,
    application_id: Uuid,
    rail_code: &str,
    now: DateTime<Utc>,
) -> Option<CommissionProfileRecord> {
    let now = now.naive_utc();
    let is_effective = |profile: &CommissionProfileRecord| {
        profile.effective_from <= now && profile.effective_to.is_none_or(|until| until > now)
    };
    let newest = |merchant: Option<Uuid>, application: Option<Uuid>, code: &str| {
        let mut best: Option<&CommissionProfileRecord> = None;
        for profile in profiles.iter().filter(|profile| {
            profile.rail_code == code
                && profile.merchant_id == merchant
                && profile.application_id == application
                && is_effective(profile)
        }) {
            // JS sorts newest-first with a stable sort, so the first row wins a tie.
            if best.is_none_or(|current| profile.effective_from > current.effective_from) {
                best = Some(profile);
            }
        }
        best.cloned()
    };
    newest(Some(merchant_id), Some(application_id), rail_code)
        .or_else(|| newest(Some(merchant_id), None, rail_code))
        .or_else(|| newest(None, None, rail_code))
        .or_else(|| newest(None, None, "default"))
}

fn resolve_credential_set(
    input: &VisibleInput<'_>,
    route: &RouteRecord,
    catalog: &Catalog,
) -> Option<CredentialSetRecord> {
    let matching: Vec<&CredentialSetRecord> = catalog
        .credential_sets
        .iter()
        .filter(|set| {
            if set.gateway_id != route.gateway_id || set.env != input.environment {
                return false;
            }
            match route.credential_policy.as_str() {
                "PLATFORM" => set.owner_type == "PLATFORM",
                "MERCHANT_REQUIRED" => {
                    set.owner_type == "MERCHANT" && set.owner_merchant_id == Some(input.merchant_id)
                }
                _ => {
                    set.owner_type == "PLATFORM"
                        || (set.owner_type == "MERCHANT"
                            && set.owner_merchant_id == Some(input.merchant_id))
                }
            }
        })
        .collect();
    matching
        .iter()
        .find(|set| set.owner_type == "PLATFORM")
        .map(|set| (*set).clone())
        .or_else(|| matching.first().map(|set| (*set).clone()))
}

/// `effectiveRouteHealth`: an unexpired override wins, then the computed state, then the column.
#[must_use]
pub(super) fn effective_health(route: &RouteRecord, now: DateTime<Utc>) -> String {
    if let Some(override_state) = &route.health_override_state {
        let active = route
            .health_override_expires_at
            .is_none_or(|expires| expires > now.naive_utc());
        if active {
            return override_state.clone();
        }
    }
    route
        .health_computed_state
        .clone()
        .unwrap_or_else(|| route.health_state.clone())
}

fn route_exclusion(
    route: &RouteRecord,
    input: &VisibleInput<'_>,
    policy: &RouteHealthRouting,
    now: DateTime<Utc>,
) -> Option<(&'static str, Option<Value>)> {
    if route.status != "ACTIVE" {
        return Some(("ROUTE_NOT_ACTIVE", Some(json!({ "status": route.status }))));
    }
    let health = effective_health(route, now);
    if health == "OPEN_BREAKER" {
        return Some(("ROUTE_NOT_HEALTHY", Some(json!({ "healthState": health }))));
    }
    if health == "DEGRADED" {
        let percent = if policy.enabled {
            policy.canary_percent
        } else {
            Decimal::ZERO
        };
        if !canary_selected(route.id, input.canary_key, percent) {
            return Some((
                if percent > Decimal::ZERO {
                    "ROUTE_DEGRADED_CANARY_EXCLUDED"
                } else {
                    "ROUTE_NOT_HEALTHY"
                },
                Some(json!({ "healthState": health })),
            ));
        }
        if let Some(max) = policy.canary_max_amount {
            if input.amount > max {
                return Some((
                    "ROUTE_DEGRADED_CANARY_EXCLUDED",
                    Some(json!({
                        "healthState": health,
                        "canaryMaxAmount": crate::routes::common::money4(Some(max)),
                    })),
                ));
            }
        }
    }
    if health != "HEALTHY" && health != "DEGRADED" {
        return Some(("ROUTE_NOT_HEALTHY", Some(json!({ "healthState": health }))));
    }
    if input.amount < route.min_amount {
        return Some((
            "AMOUNT_BELOW_MINIMUM",
            Some(json!({
                "amount": crate::routes::common::money4(Some(input.amount)),
                "minAmount": crate::routes::common::money4(Some(route.min_amount)),
            })),
        ));
    }
    if let Some(max_amount) = route.max_amount {
        if input.amount > max_amount {
            return Some((
                "AMOUNT_ABOVE_MAXIMUM",
                Some(json!({
                    "amount": crate::routes::common::money4(Some(input.amount)),
                    "maxAmount": crate::routes::common::money4(Some(max_amount)),
                })),
            ));
        }
    }
    let cap = evaluate_daily_cap(route, input.amount);
    if !cap.within_cap {
        return Some((
            "DAILY_CAP_EXCEEDED",
            Some(json!({
                "amount": crate::routes::common::money4(Some(input.amount)),
                "dailyProcessedAmount": crate::routes::common::money4(Some(cap.processed)),
                "dailyCapAmount": cap.cap.map(|value| crate::routes::common::money4(Some(value))),
                "remaining": cap.remaining.map(|value| crate::routes::common::money4(Some(value))),
            })),
        ));
    }
    if maintenance_window_active(route.maintenance_windows.as_ref(), now) {
        return Some(("MAINTENANCE_WINDOW", None));
    }
    if !in_scope(&route.scope, input) {
        return Some(("OUT_OF_SCOPE", None));
    }
    None
}

/// `evaluateRouteDailyCap`.
#[derive(Debug, Clone, Copy)]
pub(super) struct DailyCap {
    pub within_cap: bool,
    pub processed: Decimal,
    pub cap: Option<Decimal>,
    pub remaining: Option<Decimal>,
}

#[must_use]
pub(super) fn evaluate_daily_cap(route: &RouteRecord, amount: Decimal) -> DailyCap {
    let processed = route.daily_processed;
    let Some(cap) = route.daily_cap_amount else {
        return DailyCap {
            within_cap: true,
            processed,
            cap: None,
            remaining: None,
        };
    };
    DailyCap {
        within_cap: processed + amount <= cap,
        processed,
        cap: Some(cap),
        remaining: Some(cap - processed),
    }
}

fn maintenance_window_active(value: Option<&Value>, now: DateTime<Utc>) -> bool {
    let Some(Value::Array(windows)) = value else {
        return false;
    };
    let instant = now.timestamp_millis();
    windows.iter().any(|window| {
        let Some(object) = window.as_object() else {
            return false;
        };
        let start = object.get("start").and_then(parse_instant);
        let end = object.get("end").and_then(parse_instant);
        match (start, end) {
            (Some(start), Some(end)) => instant >= start && instant < end,
            _ => false,
        }
    })
}

fn parse_instant(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|instant| instant.timestamp_millis())
}

fn in_scope(scope: &Value, input: &VisibleInput<'_>) -> bool {
    let Some(object) = scope.as_object() else {
        return true;
    };
    let list = |snake: &str, camel: &str| -> Option<Vec<String>> {
        object
            .get(snake)
            .or_else(|| object.get(camel))
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| match entry {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
    };
    if let Some(merchants) = list("merchant_ids", "merchantIds") {
        if !merchants
            .iter()
            .any(|id| id == &input.merchant_id.to_string())
        {
            return false;
        }
    }
    if let Some(applications) = list("application_ids", "applicationIds") {
        if !applications
            .iter()
            .any(|id| id == &input.application_id.to_string())
        {
            return false;
        }
    }
    if let Some(tiers) = list("risk_tiers", "riskTiers") {
        if !tiers.iter().any(|tier| tier == input.risk_tier) {
            return false;
        }
    }
    if let Some(channels) = list("channels", "channels") {
        if !channels.iter().any(|channel| channel == "WEB") {
            return false;
        }
    }
    true
}

/// `canarySelected` (`engine/routeHealth/decision.ts:128`): FNV-1a over the UTF-16 code units of
/// `"<routeId>:<canaryKey>"`, modulo 100.
#[must_use]
pub(super) fn canary_selected(route_id: Uuid, canary_key: &str, percent: Decimal) -> bool {
    if canary_key.is_empty() || percent <= Decimal::ZERO {
        return false;
    }
    if percent >= Decimal::from(100) {
        return true;
    }
    let text = format!("{route_id}:{canary_key}");
    let mut hash: u32 = 2_166_136_261;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    Decimal::from(hash % 100) < percent
}

/// `rankRoutes`.
fn rank_routes(
    candidates: Vec<(RouteRecord, CredentialSetRecord)>,
    amount: Decimal,
) -> Vec<RankedRoute> {
    let mut scored: Vec<RankedRoute> = candidates
        .into_iter()
        .map(|(route, credential_set)| RankedRoute {
            effective_cost: effective_cost(&route, amount),
            route,
            credential_set,
            rank: 0,
        })
        .collect();
    scored.sort_by(|left, right| {
        // The TS comparator reads the strategy of the LEFT route for every pair.
        let mut order = match left.route.routing_strategy.as_str() {
            "STRICT_PRIORITY" => right.route.priority.cmp(&left.route.priority),
            "WEIGHTED" => right.route.weight.cmp(&left.route.weight),
            _ => left
                .effective_cost
                .cmp(&right.effective_cost)
                .then_with(|| right.route.priority.cmp(&left.route.priority)),
        };
        if order.is_eq() {
            order = left.route.gateway_id.cmp(&right.route.gateway_id);
        }
        if order.is_eq() {
            order = left.credential_set.id.cmp(&right.credential_set.id);
        }
        if order.is_eq() {
            order = left.route.id.cmp(&right.route.id);
        }
        order
    });
    for (index, entry) in scored.iter_mut().enumerate() {
        entry.rank = index + 1;
    }
    scored
}

/// `effectiveCost`: flat + percent/100, tiered/hybrid tiers, then min/max.
fn effective_cost(route: &RouteRecord, amount: Decimal) -> Decimal {
    let Some(model) = route.cost_model.as_object() else {
        return Decimal::ZERO;
    };
    let hundred = Decimal::from(100);
    let mut cost = Decimal::ZERO;
    if let Some(flat) = model.get("flat").and_then(json_decimal) {
        cost += flat;
    }
    if let Some(percent) = model.get("percent").and_then(json_decimal) {
        cost += amount * percent / hundred;
    }
    if matches!(
        model.get("calc_type").and_then(Value::as_str),
        Some("TIERED" | "HYBRID")
    ) {
        if let Some(Value::Array(tiers)) = model.get("tiers") {
            for tier in tiers {
                let Some(tier) = tier.as_object() else {
                    continue;
                };
                let up_to = tier.get("up_to").and_then(json_decimal);
                if up_to.is_none_or(|limit| amount <= limit) {
                    if let Some(flat) = tier.get("flat").and_then(json_decimal) {
                        cost += flat;
                    }
                    if let Some(percent) = tier.get("percent").and_then(json_decimal) {
                        cost += amount * percent / hundred;
                    }
                    break;
                }
            }
        }
    }
    if let Some(min) = model.get("min").and_then(json_decimal) {
        cost = cost.max(min);
    }
    if let Some(max) = model.get("max").and_then(json_decimal) {
        cost = cost.min(max);
    }
    cost
}

/// A JSON number/string as a decimal without going through `f64`.
#[must_use]
pub(super) fn json_decimal(value: &Value) -> Option<Decimal> {
    match value {
        Value::String(text) => Decimal::from_str_exact(text.trim()).ok(),
        Value::Number(number) => Decimal::from_str_exact(&number.to_string()).ok(),
        _ => None,
    }
}

/// `roundingModeOf`.
#[must_use]
pub(super) fn rounding_mode(mode: Option<&str>) -> RoundingStrategy {
    let normalized = mode
        .unwrap_or("HALF_UP")
        .trim()
        .to_ascii_uppercase()
        .trim_start_matches("ROUND_")
        .to_owned();
    match normalized.as_str() {
        "HALF_EVEN" | "BANKERS" => RoundingStrategy::MidpointNearestEven,
        "HALF_DOWN" => RoundingStrategy::MidpointTowardZero,
        "UP" => RoundingStrategy::AwayFromZero,
        "DOWN" => RoundingStrategy::ToZero,
        "CEILING" | "CEIL" => RoundingStrategy::ToPositiveInfinity,
        "FLOOR" => RoundingStrategy::ToNegativeInfinity,
        _ => RoundingStrategy::MidpointAwayFromZero,
    }
}

// ---- row helpers (kept here so every catalog read decodes the same way) --------------------

fn read_uuid(row: &sqlx::postgres::PgRow, column: &str) -> Result<Uuid, ApiError> {
    row.try_get::<Uuid, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_opt_uuid(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<Uuid>, ApiError> {
    row.try_get::<Option<Uuid>, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_string(row: &sqlx::postgres::PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<String, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_opt_string(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_bool(row: &sqlx::postgres::PgRow, column: &str) -> Result<bool, ApiError> {
    row.try_get::<bool, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<i32, ApiError> {
    row.try_get::<i32, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_decimal(row: &sqlx::postgres::PgRow, column: &str) -> Result<Decimal, ApiError> {
    row.try_get::<Decimal, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_opt_decimal(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<Decimal>, ApiError> {
    row.try_get::<Option<Decimal>, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_json(row: &sqlx::postgres::PgRow, column: &str) -> Result<Value, ApiError> {
    row.try_get::<Value, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_opt_json(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<Value>, ApiError> {
    row.try_get::<Option<Value>, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_naive(row: &sqlx::postgres::PgRow, column: &str) -> Result<NaiveDateTime, ApiError> {
    row.try_get::<NaiveDateTime, _>(column)
        .map_err(|_| decode_error(column))
}

fn read_opt_naive(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<NaiveDateTime>, ApiError> {
    row.try_get::<Option<NaiveDateTime>, _>(column)
        .map_err(|_| decode_error(column))
}

fn decode_error(column: &str) -> ApiError {
    // The column name is schema metadata, never customer data.
    tracing::error!(column, "checkout catalog row could not be decoded");
    ApiError::server_error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn route(id: Uuid, rail_id: Uuid, gateway_id: Uuid) -> RouteRecord {
        RouteRecord {
            id,
            rail_id,
            gateway_id,
            credential_policy: "PLATFORM".to_owned(),
            priority: 0,
            routing_strategy: "EFFECTIVE_COST".to_owned(),
            weight: 100,
            cost_model: Value::Null,
            min_amount: Decimal::ZERO,
            max_amount: None,
            daily_cap_amount: None,
            status: "ACTIVE".to_owned(),
            health_state: "HEALTHY".to_owned(),
            health_computed_state: Some("HEALTHY".to_owned()),
            health_override_state: None,
            health_override_expires_at: None,
            maintenance_windows: None,
            scope: Value::Object(Map::new()),
            daily_processed: Decimal::ZERO,
        }
    }

    fn credential(id: Uuid, gateway_id: Uuid) -> CredentialSetRecord {
        CredentialSetRecord {
            id,
            gateway_id,
            env: "LIVE".to_owned(),
            owner_type: "PLATFORM".to_owned(),
            owner_merchant_id: None,
        }
    }

    fn profile(id: Uuid, rail_code: &str) -> CommissionProfileRecord {
        CommissionProfileRecord {
            id,
            merchant_id: None,
            application_id: None,
            rail_code: rail_code.to_owned(),
            effective_from: NaiveDateTime::default(),
            effective_to: None,
        }
    }

    #[test]
    fn daily_cap_matches_the_formula() {
        let mut record = route(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        record.daily_cap_amount = Some(Decimal::from(100));
        record.daily_processed = Decimal::from(80);
        let cap = evaluate_daily_cap(&record, Decimal::from(20));
        assert!(cap.within_cap);
        assert_eq!(cap.remaining, Some(Decimal::from(20)));
        let cap = evaluate_daily_cap(&record, Decimal::new(200001, 4));
        assert!(!cap.within_cap);
        assert_eq!(cap.remaining, Some(Decimal::from(20)));
    }

    #[test]
    fn canary_is_the_utf16_fnv_cohort() {
        let route_id = Uuid::parse_str("018f0000-0000-7000-8000-000000000001").expect("uuid");
        assert!(!canary_selected(route_id, "pl_abc", Decimal::ZERO));
        assert!(canary_selected(route_id, "pl_abc", Decimal::from(100)));
        // Deterministic for the same cohort.
        let first = canary_selected(route_id, "pl_abc", Decimal::from(50));
        let second = canary_selected(route_id, "pl_abc", Decimal::from(50));
        assert_eq!(first, second);
    }

    #[test]
    fn commission_hierarchy_picks_the_narrowest_effective_profile() {
        let merchant = Uuid::new_v4();
        let application = Uuid::new_v4();
        let platform = profile(Uuid::new_v4(), "EDFALI");
        let merchant_wide = CommissionProfileRecord {
            merchant_id: Some(merchant),
            ..profile(Uuid::new_v4(), "EDFALI")
        };
        let merchant_app = CommissionProfileRecord {
            merchant_id: Some(merchant),
            application_id: Some(application),
            ..profile(Uuid::new_v4(), "EDFALI")
        };
        let profiles = vec![platform, merchant_wide, merchant_app.clone()];
        let resolved =
            resolve_commission_profile(&profiles, merchant, application, "EDFALI", Utc::now())
                .expect("profile");
        assert_eq!(resolved.id, merchant_app.id);
        let fallback =
            resolve_commission_profile(&profiles, Uuid::new_v4(), application, "OTHER", Utc::now());
        assert!(fallback.is_none());
    }

    #[test]
    fn expired_profiles_are_ignored_and_platform_default_is_last() {
        let merchant = Uuid::new_v4();
        let application = Uuid::new_v4();
        let expired = CommissionProfileRecord {
            effective_to: Some(NaiveDateTime::default() + chrono::Duration::days(1)),
            ..profile(Uuid::new_v4(), "EDFALI")
        };
        let default_profile = {
            let mut entry = profile(Uuid::new_v4(), "default");
            entry.effective_from = NaiveDateTime::default();
            entry
        };
        let profiles = vec![expired, default_profile.clone()];
        let resolved =
            resolve_commission_profile(&profiles, merchant, application, "EDFALI", Utc::now())
                .expect("default");
        assert_eq!(resolved.id, default_profile.id);
    }

    #[test]
    fn ranking_is_cost_then_priority_then_ids() {
        let rail_id = Uuid::new_v4();
        let gateway_a = Uuid::parse_str("018f0000-0000-7000-8000-00000000000a").expect("uuid");
        let gateway_b = Uuid::parse_str("018f0000-0000-7000-8000-00000000000b").expect("uuid");
        let mut cheap = route(Uuid::new_v4(), rail_id, gateway_b);
        cheap.cost_model = serde_json::json!({ "flat": "0.5000" });
        let mut expensive = route(Uuid::new_v4(), rail_id, gateway_a);
        expensive.cost_model = serde_json::json!({ "flat": "1.5000" });
        let ranked = rank_routes(
            vec![
                (expensive, credential(Uuid::new_v4(), gateway_a)),
                (cheap, credential(Uuid::new_v4(), gateway_b)),
            ],
            Decimal::from(10),
        );
        assert_eq!(ranked[0].effective_cost, Decimal::new(5000, 4));
        assert_eq!(ranked[0].rank, 1);
        assert_eq!(ranked[1].rank, 2);
    }

    #[test]
    fn scoped_routes_and_whitelists_filter_the_rails() {
        let merchant = Uuid::new_v4();
        let application = Uuid::new_v4();
        let rail_id = Uuid::new_v4();
        let gateway_id = Uuid::new_v4();
        let rail = RailRecord {
            id: rail_id,
            code: "EDFALI".to_owned(),
            name_ar: None,
            name_en: None,
            currency: "LYD".to_owned(),
            blocked: false,
            display_order: 0,
            collection_mode: Some("OTP_PULL".to_owned()),
            help_guide: None,
        };
        let mut eligible = route(Uuid::new_v4(), rail_id, gateway_id);
        eligible.scope = serde_json::json!({ "risk_tiers": ["STANDARD"] });
        let out_of_scope = {
            let mut entry = route(Uuid::new_v4(), rail_id, gateway_id);
            entry.scope = serde_json::json!({ "risk_tiers": ["HIGH"] });
            entry
        };
        let catalog = Catalog {
            rails: vec![rail],
            routes: vec![eligible, out_of_scope],
            credential_sets: vec![credential(Uuid::new_v4(), gateway_id)],
            commission_profiles: vec![profile(Uuid::new_v4(), "EDFALI")],
        };
        let input = VisibleInput {
            application_id: application,
            merchant_id: merchant,
            risk_tier: "STANDARD",
            application_rail_whitelist: None,
            amount: Decimal::from(10),
            currency: "LYD",
            link_rail_whitelist: None,
            canary_key: "pl_test",
            environment: "LIVE",
        };
        let result = resolve(&input, &catalog, &RouteHealthRouting::default(), Utc::now());
        assert_eq!(result.rails.len(), 1);
        assert_eq!(result.rails[0].routes.len(), 1);
        assert_eq!(result.excluded.len(), 1);
        assert_eq!(result.excluded[0]["reason"], "OUT_OF_SCOPE");
    }

    #[test]
    fn policy_parsing_clamps_and_defaults() {
        let parsed = parse_routing_policy(Some(&serde_json::json!({
            "enabled": false,
            "canaryPercent": 250,
            "canaryMaxAmount": "12.5"
        })));
        assert!(!parsed.enabled);
        assert_eq!(parsed.canary_percent, Decimal::from(100));
        assert_eq!(parsed.canary_max_amount, Some(Decimal::new(125, 1)));
        let fallback = parse_routing_policy(Some(&serde_json::json!({ "canaryPercent": "abc" })));
        assert_eq!(fallback, RouteHealthRouting::default());
    }

    #[test]
    fn timestamps_in_maintenance_windows_are_half_open() {
        let now = Utc
            .with_ymd_and_hms(2026, 11, 28, 12, 0, 0)
            .single()
            .expect("time");
        let window = serde_json::json!([{
            "start": "2026-11-28T11:00:00.000Z",
            "end": "2026-11-28T13:00:00.000Z"
        }]);
        assert!(maintenance_window_active(Some(&window), now));
        let after = serde_json::json!([{
            "start": "2026-11-28T11:00:00.000Z",
            "end": "2026-11-28T12:00:00.000Z"
        }]);
        assert!(!maintenance_window_active(Some(&after), now));
    }
}
