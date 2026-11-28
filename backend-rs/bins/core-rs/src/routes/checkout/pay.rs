//! `GET /internal/checkout/pay/:linkKey` — the payer summary.
//!
//! Port of `core-back/api/internal/checkout.ts:1158-1283` plus the helpers it uses:
//! `loadCatalog`/`VisibleRailsResolver` (`visible_rails.rs`), `buildBreakdown`,
//! `commissionForProfile`, `commissionTiers`, `splitRatio`, `fieldInputType`, `fieldOptions` and
//! `buildCheckoutSupportConfig`.
//!
//! Money rules copied from the TS code: the commission is computed once and rounded once to the
//! money scale with the profile's `roundingMode`; every other figure is exact subtraction, so
//! `commission + merchant == amount` (or `amount + surcharge == total`) with no residue.
//! `Decimal` throughout; no float.
//!
//! Deviation (review marker): the TS top-level `fee` uses `profiles[0]` of an unordered
//! `findMany(where id in …)`. This port uses the commission profile of the first visible rail,
//! which is deterministic. With one effective profile per rail (the seeded shape) the two agree.

#![forbid(unsafe_code)]

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::visible_rails::{self, evaluate_daily_cap, rounding_mode, VisibleRail, VisibleResult};
use super::{assert_plane_matches, load_link, path_param, PAY_PATH};
use crate::http;
use crate::routes::common::{database_error, json_ok, money4};
use crate::routes::HandlerFuture;
use crate::state::AppState;
use pg_http::ApiError;

const MONEY_SCALE: u32 = 4;

/// One commission profile with the pricing columns `buildBreakdown` reads.
struct ProfileFees {
    calc_type: String,
    flat_fee: Decimal,
    percentage_rate: Decimal,
    min_fee: Decimal,
    max_fee: Option<Decimal>,
    tiers_json: Option<Value>,
    rounding_mode: Option<String>,
}

/// `CommissionBreakdown`.
struct Breakdown {
    commission: String,
    payer_surcharge: String,
    total_charged: String,
    merchant_credited: String,
    fee_bearer: String,
}

impl Breakdown {
    fn json(&self) -> Value {
        json!({
            "commission": self.commission,
            "payerSurcharge": self.payer_surcharge,
            "totalCharged": self.total_charged,
            "merchantCredited": self.merchant_credited,
            "feeBearer": self.fee_bearer,
        })
    }
}

/// `GET /internal/checkout/pay/:linkKey`.
pub(super) fn pay_link<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let link_key =
            match super::link_key_parameter(path_param(PAY_PATH, request.path(), "linkKey")) {
                Ok(link_key) => link_key,
                Err(error) => return http::error_response(request, error),
            };
        let link = match load_link(&state.pools.main, &link_key).await {
            Ok(Some(link)) => link,
            Ok(None) => {
                return http::error_response(
                    request,
                    ApiError::new(
                        404,
                        "PAYMENT_LINK_NOT_FOUND",
                        "The payment link does not exist",
                    ),
                )
            }
            Err(error) => return http::error_response(request, error),
        };
        if let Err(error) = assert_plane_matches(state, &link) {
            return http::error_response(request, error);
        }
        let env = state.config.execution_plane.as_str();
        let now = chrono::Utc::now();
        let catalog = match visible_rails::load_catalog(&state.pools.main, now).await {
            Ok(catalog) => catalog,
            Err(error) => return http::error_response(request, error),
        };
        let policy = match visible_rails::load_routing_policy(&state.pools.main).await {
            Ok(policy) => policy,
            Err(error) => return http::error_response(request, error),
        };
        let input = visible_rails::VisibleInput {
            application_id: link.application_id,
            merchant_id: link.merchant_id,
            risk_tier: &link.merchant_risk_tier,
            application_rail_whitelist: link.application_rail_whitelist.as_ref(),
            amount: link.amount,
            currency: &link.currency,
            link_rail_whitelist: link.rail_whitelist.as_ref(),
            canary_key: &link.key,
            environment: env,
        };
        let visible = visible_rails::resolve(&input, &catalog, &policy, now);
        let rail_ids: Vec<Uuid> = visible.rails.iter().map(|rail| rail.rail.id).collect();
        let rail_fields = match load_rail_fields(&state.pools.main, &rail_ids).await {
            Ok(fields) => fields,
            Err(error) => return http::error_response(request, error),
        };
        let profile_fees = match load_profile_fees(&state.pools.main, &visible).await {
            Ok(fees) => fees,
            Err(error) => return http::error_response(request, error),
        };
        let support_setting = match load_support_setting(&state.pools.main).await {
            Ok(setting) => setting,
            Err(error) => return http::error_response(request, error),
        };
        let support_config = build_checkout_support_config(support_setting.as_ref(), &link);

        let rails = visible
            .rails
            .iter()
            .map(|rail| visible_rail_json(rail, &rail_fields, &profile_fees, &link))
            .collect::<Vec<_>>();
        let default_fee = visible
            .rails
            .first()
            .and_then(|rail| profile_fees.get(&rail.commission_profile.id))
            .map_or_else(
                || fallback_breakdown(&link),
                |fees| build_breakdown(&link, fees),
            );

        let split_percent = if link.fee_bearer == "SPLIT" {
            let ratio = split_ratio(link.split_ratio_json.as_ref());
            Value::String(
                (ratio * Decimal::from(100))
                    .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
                    .to_string(),
            )
        } else {
            Value::Null
        };
        let allowlisted_hosts: Vec<String> = link
            .application_redirect_allowlist
            .as_ref()
            .and_then(Value::as_array)
            .map(|entries| entries.iter().map(json_string).collect())
            .unwrap_or_default();
        let expires_at = link
            .expires_at
            .map_or(Value::Null, |value| Value::String(super::iso_naive(value)));

        let mut body = Map::new();
        // Field order is the TS object literal (`checkout.ts:1253`).
        body.insert("supportConfig".to_owned(), support_config);
        body.insert("env".to_owned(), Value::String(env.to_owned()));
        body.insert("linkKey".to_owned(), Value::String(link.key.clone()));
        body.insert(
            "merchantTradeName".to_owned(),
            Value::String(link.merchant_trade_name.clone()),
        );
        body.insert("merchantLogoUrl".to_owned(), Value::Null);
        body.insert(
            "title".to_owned(),
            link.title.clone().map_or(Value::Null, Value::String),
        );
        body.insert(
            "description".to_owned(),
            link.description.clone().map_or(Value::Null, Value::String),
        );
        body.insert(
            "amount".to_owned(),
            Value::String(money4(Some(link.amount))),
        );
        body.insert("currency".to_owned(), Value::String(link.currency.clone()));
        body.insert(
            "feeBearerMode".to_owned(),
            Value::String(link.fee_bearer.clone()),
        );
        body.insert(
            "baseAmount".to_owned(),
            Value::String(money4(Some(link.amount))),
        );
        body.insert(
            "feeAmount".to_owned(),
            Value::String(default_fee.commission.clone()),
        );
        body.insert(
            "totalAmount".to_owned(),
            Value::String(default_fee.total_charged.clone()),
        );
        body.insert(
            "merchantAmount".to_owned(),
            Value::String(default_fee.merchant_credited.clone()),
        );
        body.insert("splitPercent".to_owned(), split_percent);
        body.insert("visibleRails".to_owned(), Value::Array(rails));
        body.insert(
            "excludedRails".to_owned(),
            Value::Array(visible.excluded.clone()),
        );
        body.insert("expiresAt".to_owned(), expires_at);
        body.insert("status".to_owned(), Value::String(link.state.clone()));
        body.insert(
            "redirectUrl".to_owned(),
            link.redirect_url.clone().map_or(Value::Null, Value::String),
        );
        body.insert(
            "allowlistedRedirectHosts".to_owned(),
            Value::Array(allowlisted_hosts.into_iter().map(Value::String).collect()),
        );
        if env == "SANDBOX" {
            let inspector = sandbox_inspector(&link).await;
            body.insert("sandboxInspector".to_owned(), inspector);
        }
        json_ok(&Value::Object(body))
    })
}

async fn load_rail_fields(
    pool: &PgPool,
    rail_ids: &[Uuid],
) -> Result<Vec<(Uuid, Value)>, ApiError> {
    if rail_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT rail_id, key, type::text AS type, label_ar, label_en, placeholder_ar,
                placeholder_en, regex, min_length, max_length, required, options_json,
                sensitivity::text AS sensitivity
           FROM rail_fields
          WHERE rail_id = ANY($1)
          ORDER BY order_index ASC",
    )
    .bind(rail_ids.to_vec())
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            let rail_id: Uuid = row.try_get("rail_id").map_err(|_| field_decode_error())?;
            let options = row
                .try_get::<Option<Value>, _>("options_json")
                .map_err(|_| field_decode_error())?
                .as_ref()
                .and_then(Value::as_array)
                .map(|entries| {
                    Value::Array(entries.iter().map(|entry| Value::String(json_string(entry))).collect())
                })
                .unwrap_or(Value::Null);
            let field = json!({
                "key": row.try_get::<String, _>("key").map_err(|_| field_decode_error())?,
                "inputType": field_input_type(
                    &row.try_get::<String, _>("type").map_err(|_| field_decode_error())?,
                ),
                "labelAr": row.try_get::<String, _>("label_ar").map_err(|_| field_decode_error())?,
                "labelEn": row.try_get::<String, _>("label_en").map_err(|_| field_decode_error())?,
                "placeholderAr": row.try_get::<Option<String>, _>("placeholder_ar").map_err(|_| field_decode_error())?,
                "placeholderEn": row.try_get::<Option<String>, _>("placeholder_en").map_err(|_| field_decode_error())?,
                "regex": row.try_get::<Option<String>, _>("regex").map_err(|_| field_decode_error())?,
                "minLength": row.try_get::<Option<i32>, _>("min_length").map_err(|_| field_decode_error())?,
                "maxLength": row.try_get::<Option<i32>, _>("max_length").map_err(|_| field_decode_error())?,
                "required": row.try_get::<bool, _>("required").map_err(|_| field_decode_error())?,
                "options": options,
                "sensitivity": row.try_get::<String, _>("sensitivity").map_err(|_| field_decode_error())?,
            });
            Ok((rail_id, field))
        })
        .collect()
}

async fn load_profile_fees(
    pool: &PgPool,
    visible: &VisibleResult,
) -> Result<std::collections::HashMap<Uuid, ProfileFees>, ApiError> {
    let ids: Vec<Uuid> = visible
        .rails
        .iter()
        .map(|rail| rail.commission_profile.id)
        .collect();
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT id, calc_type::text AS calc_type, flat_fee, percentage_rate, min_fee, max_fee,
                tiers_json, rounding_mode
           FROM commission_profiles
          WHERE id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    let mut fees = std::collections::HashMap::new();
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(|_| field_decode_error())?;
        fees.insert(
            id,
            ProfileFees {
                calc_type: row.try_get("calc_type").map_err(|_| field_decode_error())?,
                flat_fee: row.try_get("flat_fee").map_err(|_| field_decode_error())?,
                percentage_rate: row
                    .try_get("percentage_rate")
                    .map_err(|_| field_decode_error())?,
                min_fee: row.try_get("min_fee").map_err(|_| field_decode_error())?,
                max_fee: row.try_get("max_fee").map_err(|_| field_decode_error())?,
                tiers_json: row
                    .try_get("tiers_json")
                    .map_err(|_| field_decode_error())?,
                rounding_mode: row
                    .try_get("rounding_mode")
                    .map_err(|_| field_decode_error())?,
            },
        );
    }
    Ok(fees)
}

async fn load_support_setting(pool: &PgPool) -> Result<Option<Value>, ApiError> {
    let row = sqlx::query(
        "SELECT value_json FROM platform_settings
          WHERE key = 'checkout.support_config'
          ORDER BY version DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(database_error)?;
    Ok(match row {
        Some(row) => row
            .try_get::<Option<Value>, _>("value_json")
            .map_err(|_| field_decode_error())?,
        None => None,
    })
}

fn field_decode_error() -> ApiError {
    tracing::error!("checkout pay-link row could not be decoded");
    ApiError::server_error()
}

fn visible_rail_json(
    rail: &VisibleRail,
    rail_fields: &[(Uuid, Value)],
    profile_fees: &std::collections::HashMap<Uuid, ProfileFees>,
    link: &super::LoadedLink,
) -> Value {
    let fee = profile_fees.get(&rail.commission_profile.id).map_or_else(
        || fallback_breakdown(link),
        |fees| build_breakdown(link, fees),
    );
    let fields: Vec<Value> = rail_fields
        .iter()
        .filter(|(rail_id, _)| *rail_id == rail.rail.id)
        .map(|(_, field)| field.clone())
        .collect();
    let routes: Vec<Value> = rail
        .routes
        .iter()
        .map(|ranked| {
            let cap = evaluate_daily_cap(&ranked.route, link.amount);
            json!({
                "routeId": ranked.route.id.to_string(),
                "rank": ranked.rank,
                "dailyCapAmount": cap.cap.map_or(Value::Null, |value| Value::String(money4(Some(value)))),
                "dailyProcessedAmount": money4(Some(cap.processed)),
                "dailyCapRemaining": cap.remaining.map_or(Value::Null, |value| Value::String(money4(Some(value)))),
                "withinDailyCap": cap.within_cap,
            })
        })
        .collect();
    json!({
        "code": rail.rail.code,
        "displayNameAr": rail.rail.name_ar.clone().unwrap_or_else(|| rail.rail.code.clone()),
        "displayNameEn": rail.rail.name_en.clone().unwrap_or_else(|| rail.rail.code.clone()),
        "collectionMode": rail.rail.collection_mode.clone().unwrap_or_else(|| "HYBRID".to_owned()),
        "minAmount": null,
        "maxAmount": null,
        "currency": link.currency,
        "icon": null,
        "fields": fields,
        "routes": routes,
        "fee": fee.json(),
        "helpGuide": rail
            .rail
            .help_guide
            .as_ref()
            .map(pg_types::js_object_order)
            .unwrap_or(Value::Null),
    })
}

fn fallback_breakdown(link: &super::LoadedLink) -> Breakdown {
    let amount = money4(Some(link.amount));
    Breakdown {
        commission: "0.0000".to_owned(),
        payer_surcharge: "0.0000".to_owned(),
        total_charged: amount.clone(),
        merchant_credited: amount,
        fee_bearer: link.fee_bearer.clone(),
    }
}

/// `buildBreakdown` (`checkout.ts:479`).
fn build_breakdown(link: &super::LoadedLink, fees: &ProfileFees) -> Breakdown {
    let amount = link
        .amount
        .round_dp_with_strategy(MONEY_SCALE, RoundingStrategy::MidpointAwayFromZero);
    let mode = rounding_mode(fees.rounding_mode.as_deref());
    let commission =
        commission_for_profile(fees, link.amount).round_dp_with_strategy(MONEY_SCALE, mode);
    match link.fee_bearer.as_str() {
        "MERCHANT_ABSORBS" => Breakdown {
            commission: money4(Some(commission)),
            payer_surcharge: "0.0000".to_owned(),
            total_charged: money4(Some(amount)),
            merchant_credited: money4(Some(amount - commission)),
            fee_bearer: link.fee_bearer.clone(),
        },
        "PAYER_SURCHARGE" => Breakdown {
            commission: money4(Some(commission)),
            payer_surcharge: money4(Some(commission)),
            total_charged: money4(Some(amount + commission)),
            merchant_credited: money4(Some(amount)),
            fee_bearer: link.fee_bearer.clone(),
        },
        _ => {
            let platform_share = split_ratio(link.split_ratio_json.as_ref());
            let payer_share =
                (commission * platform_share).round_dp_with_strategy(MONEY_SCALE, mode);
            Breakdown {
                commission: money4(Some(commission)),
                payer_surcharge: money4(Some(payer_share)),
                total_charged: money4(Some(amount + payer_share)),
                merchant_credited: money4(Some(amount - (commission - payer_share))),
                fee_bearer: link.fee_bearer.clone(),
            }
        }
    }
}

/// `commissionForProfile` (`checkout.ts:409`).
fn commission_for_profile(profile: &ProfileFees, amount: Decimal) -> Decimal {
    let mut value = Decimal::ZERO;
    if matches!(profile.calc_type.as_str(), "FLAT" | "HYBRID") {
        value += profile.flat_fee;
    }
    if matches!(profile.calc_type.as_str(), "PERCENTAGE" | "HYBRID") {
        value += amount * profile.percentage_rate;
    }
    if profile.calc_type == "TIERED" {
        for tier in commission_tiers(profile.tiers_json.as_ref()) {
            let up_to = tier
                .get("up_to")
                .or_else(|| tier.get("upTo"))
                .and_then(visible_rails::json_decimal);
            if up_to.is_none_or(|limit| amount <= limit) {
                if let Some(flat) = tier.get("flat").and_then(visible_rails::json_decimal) {
                    value += flat;
                }
                if let Some(percent) = tier.get("percent").and_then(visible_rails::json_decimal) {
                    value += amount * percent;
                }
                break;
            }
        }
    }
    if value < profile.min_fee {
        value = profile.min_fee;
    }
    if let Some(max_fee) = profile.max_fee {
        if value > max_fee {
            value = max_fee;
        }
    }
    value
}

/// `commissionTiers`: array, or the legacy index-keyed object sorted numerically.
fn commission_tiers(tiers_json: Option<&Value>) -> Vec<Map<String, Value>> {
    match tiers_json {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_object)
            .cloned()
            .collect(),
        Some(Value::Object(object)) => {
            let mut keyed: Vec<(u64, Map<String, Value>)> = object
                .iter()
                .filter_map(|(key, value)| {
                    let index = key.parse::<u64>().ok()?;
                    Some((index, value.as_object()?.clone()))
                })
                .collect();
            keyed.sort_by_key(|(index, _)| *index);
            keyed.into_iter().map(|(_, tier)| tier).collect()
        }
        _ => Vec::new(),
    }
}

/// `splitRatio` (`checkout.ts:457`): `platformShare`/`platform_share`/`share`, 0..1, 0.5 default.
fn split_ratio(value: Option<&Value>) -> Decimal {
    let fallback = Decimal::new(5, 1);
    let Some(object) = value.and_then(Value::as_object) else {
        return fallback;
    };
    let raw = object
        .get("platformShare")
        .or_else(|| object.get("platform_share"))
        .or_else(|| object.get("share"));
    let Some(parsed) = raw.and_then(visible_rails::json_decimal) else {
        return fallback;
    };
    if parsed < Decimal::ZERO || parsed > Decimal::ONE {
        return fallback;
    }
    parsed
}

/// `fieldInputType` (`checkout.ts:528`).
fn field_input_type(field_type: &str) -> &'static str {
    match field_type {
        "PHONE" => "phone",
        "NUMBER" | "CARD_NUMBER" | "PAN" => "numeric",
        "OTP" => "otp",
        "WALLET_ID" => "wallet_id",
        "FROM_LIST" => "select",
        _ => "text",
    }
}

/// `buildCheckoutSupportConfig` (`checkout.ts:1109`).
fn build_checkout_support_config(raw: Option<&Value>, link: &super::LoadedLink) -> Value {
    let Some(config) = raw.and_then(Value::as_object) else {
        return Value::Null;
    };
    if config.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Value::Null;
    }
    let show_platform = config.get("show_platform_contact").and_then(Value::as_bool) != Some(false);
    let show_merchant = config.get("show_merchant_contact").and_then(Value::as_bool) != Some(false);
    let faq_items: Vec<Value> = config
        .get("faq_items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_object)
                .map(|item| {
                    json!({
                        "q_ar": item.get("q_ar").cloned().unwrap_or(Value::Null),
                        "a_ar": item.get("a_ar").cloned().unwrap_or(Value::Null),
                        "q_en": item.get("q_en").cloned().unwrap_or(Value::Null),
                        "a_en": item.get("a_en").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let channels: Vec<String> = ["support_whatsapp", "support_phone", "support_email"]
        .iter()
        .filter_map(|key| config.get(*key))
        .filter(|value| json_truthy(value))
        .map(json_string)
        .collect();
    let mut object = Map::new();
    object.insert("enabled".to_owned(), Value::Bool(true));
    object.insert(
        "working_hours_ar".to_owned(),
        config
            .get("working_hours_ar")
            .cloned()
            .unwrap_or(Value::Null),
    );
    object.insert(
        "working_hours_en".to_owned(),
        config
            .get("working_hours_en")
            .cloned()
            .unwrap_or(Value::Null),
    );
    object.insert(
        "platform".to_owned(),
        if show_platform {
            json!({
                "phone": config.get("support_phone").cloned().unwrap_or(Value::Null),
                "whatsapp": config.get("support_whatsapp").cloned().unwrap_or(Value::Null),
                "email": config.get("support_email").cloned().unwrap_or(Value::Null),
            })
        } else {
            Value::Null
        },
    );
    object.insert(
        "merchant".to_owned(),
        if show_merchant {
            json!({
                "phone": link.merchant_contact_phone,
                "email": link.merchant_contact_email,
                "tradeName": link.merchant_trade_name,
            })
        } else {
            Value::Null
        },
    );
    object.insert("faq_items".to_owned(), Value::Array(faq_items));
    object.insert(
        "channels".to_owned(),
        Value::Array(channels.into_iter().map(Value::String).collect()),
    );
    Value::Object(object)
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn json_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `loadSandboxInspector` (`checkout.ts:298`); only called on the Sandbox plane.
async fn sandbox_inspector(link: &super::LoadedLink) -> Value {
    let client = super::fake_rails::ControlClient::from_env();
    let (rail_accounts, unavailable) = match client
        .list_accounts(Some(&link.merchant_id.to_string()), None)
        .await
    {
        Ok(accounts) => (
            accounts
                .iter()
                .map(super::sandbox_account_payload)
                .collect::<Vec<_>>(),
            Value::Null,
        ),
        Err(error) => (Vec::new(), Value::String(error.message)),
    };
    json!({
        "enabled": true,
        "mode": "OPEN_IN_SANDBOX",
        "unlocked": true,
        "unavailable": unavailable,
        "railAccounts": rail_accounts,
        "activeAttemptSecrets": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(fee_bearer: &str) -> super::super::LoadedLink {
        super::super::LoadedLink {
            key: "pl_test".to_owned(),
            application_id: Uuid::nil(),
            merchant_id: Uuid::nil(),
            title: None,
            description: None,
            redirect_url: None,
            application_redirect_allowlist: None,
            amount: Decimal::from(100),
            currency: "LYD".to_owned(),
            fee_bearer: fee_bearer.to_owned(),
            split_ratio_json: None,
            state: "PENDING".to_owned(),
            env: "LIVE".to_owned(),
            expires_at: None,
            rail_whitelist: None,
            application_rail_whitelist: None,
            merchant_trade_name: "Test".to_owned(),
            merchant_risk_tier: "STANDARD".to_owned(),
            merchant_contact_phone: None,
            merchant_contact_email: None,
        }
    }

    fn profile(calc_type: &str, flat: i64, rate: i64, min: i64, max: Option<i64>) -> ProfileFees {
        ProfileFees {
            calc_type: calc_type.to_owned(),
            flat_fee: Decimal::new(flat, 4),
            percentage_rate: Decimal::new(rate, 6),
            min_fee: Decimal::new(min, 4),
            max_fee: max.map(|value| Decimal::new(value, 4)),
            tiers_json: None,
            rounding_mode: None,
        }
    }

    #[test]
    fn merchant_absorbs_keeps_the_journal_balanced() {
        let breakdown = build_breakdown(
            &link("MERCHANT_ABSORBS"),
            &profile("HYBRID", 50000, 25000, 0, None),
        );
        // 5.0000 flat + 100 * 0.025 = 7.5000.
        assert_eq!(breakdown.commission, "7.5000");
        assert_eq!(breakdown.total_charged, "100.0000");
        assert_eq!(breakdown.merchant_credited, "92.5000");
        assert_eq!(breakdown.payer_surcharge, "0.0000");
    }

    #[test]
    fn payer_surcharge_adds_the_commission() {
        let breakdown =
            build_breakdown(&link("PAYER_SURCHARGE"), &profile("FLAT", 500, 0, 0, None));
        assert_eq!(breakdown.payer_surcharge, "0.0500");
        assert_eq!(breakdown.total_charged, "100.0500");
        assert_eq!(breakdown.merchant_credited, "100.0000");
    }

    #[test]
    fn split_uses_the_platform_share_and_stays_balanced() {
        let mut link = link("SPLIT");
        link.split_ratio_json = Some(serde_json::json!({ "platformShare": "0.5" }));
        let breakdown = build_breakdown(&link, &profile("FLAT", 1000, 0, 0, None));
        assert_eq!(breakdown.payer_surcharge, "0.0500");
        assert_eq!(breakdown.total_charged, "100.0500");
        assert_eq!(breakdown.merchant_credited, "99.9500");
        // commission + merchant == total charged (the payer covers the surcharge).
        assert_eq!(
            Decimal::from_str_exact(&breakdown.commission).expect("commission")
                + Decimal::from_str_exact(&breakdown.merchant_credited).expect("merchant"),
            Decimal::from_str_exact(&breakdown.total_charged).expect("total")
        );
    }

    #[test]
    fn tiered_legacy_object_and_min_max_apply() {
        let mut fees = profile("TIERED", 0, 0, 100, Some(50_000));
        fees.tiers_json = Some(serde_json::json!({
            "0": { "up_to": "50", "flat": "1" },
            "1": { "up_to": "500", "flat": "3" }
        }));
        let breakdown = build_breakdown(&link("MERCHANT_ABSORBS"), &fees);
        assert_eq!(breakdown.commission, "3.0000");
    }

    #[test]
    fn support_config_hides_what_the_setting_hides() {
        let setting = serde_json::json!({
            "enabled": true,
            "support_phone": "0910000000",
            "support_whatsapp": "",
            "support_email": "help@example.com",
            "show_platform_contact": false,
            "show_merchant_contact": true,
            "faq_items": [{ "q_en": "Q", "a_en": "A" }]
        });
        let config = build_checkout_support_config(Some(&setting), &link("SPLIT"));
        assert!(config["platform"].is_null());
        assert_eq!(config["merchant"]["tradeName"], "Test");
        assert_eq!(
            config["channels"],
            serde_json::json!(["0910000000", "help@example.com"])
        );
        assert_eq!(config["faq_items"][0]["q_en"], "Q");
        assert!(build_checkout_support_config(
            Some(&serde_json::json!({ "enabled": false })),
            &link("SPLIT")
        )
        .is_null());
    }
}
