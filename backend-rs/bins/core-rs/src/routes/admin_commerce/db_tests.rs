//! DB-gated tests of the admin commerce read routes (schema 46).
//!
//! Each test creates a private merchant graph, exercises a list and a detail (where TS has one),
//! checks filters/pagination/redaction/404 and always deletes its rows. PostgreSQL unreachable →
//! the test prints a skip line and returns.

#![cfg(test)]

use serde_json::Value;
use uuid::Uuid;

use super::test_support;
use super::{applications, catalog, merchants, transactions, wallets};

fn ok<T>(context: &str, result: Result<T, pg_http::ApiError>) -> Result<T, String> {
    result.map_err(|error| {
        format!(
            "{context}: {} {} {}",
            error.status, error.code, error.message
        )
    })
}

fn rows(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(-1)
}

/// Error-returning assertions: a failure unwinds through `with_fixture` so the rows are deleted
/// even when an expectation is wrong (a panic would skip the cleanup).
macro_rules! check {
    ($condition:expr $(,)?) => {{
        if !$condition {
            return Err(format!("assertion failed: {}", stringify!($condition)));
        }
    }};
    ($condition:expr, $message:expr $(,)?) => {{
        if !$condition {
            return Err(format!("{}: {}", $message, stringify!($condition)));
        }
    }};
}

macro_rules! check_eq {
    ($left:expr, $right:expr $(,)?) => {{
        let left = $left;
        let right = $right;
        if left != right {
            return Err(format!(
                "assertion failed: {} == {}\n  left: {left:?}\n right: {right:?}",
                stringify!($left),
                stringify!($right)
            ));
        }
    }};
}

#[tokio::test]
async fn merchants_list_and_detail() {
    let outcome = test_support::with_fixture("merchants", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let query = format!("search={}", fixture.unique);

        let list = ok(
            "merchant list",
            merchants::list(&pool, Some(&reader), &query).await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let merchant = rows(&list, "merchants")
            .into_iter()
            .next()
            .ok_or("merchant row missing")?;
        check_eq!(
            test_support::text(&merchant, "id"),
            fixture.merchant.to_string()
        );
        check_eq!(test_support::text(&merchant, "country"), "LY");
        check!(
            merchant.get("riskTier").is_none(),
            "support-level redaction"
        );
        let redacted = rows(&merchant, "redactedFields");
        check!(redacted.iter().any(|value| value == "riskTier"));
        check!(redacted
            .iter()
            .any(|value| value == "payoutBankDetailsJson"));

        let full = test_support::staff("GATEWAY_ADMIN", &["*"]);
        let list = ok(
            "merchant list full",
            merchants::list(&pool, Some(&full), &query).await,
        )?;
        let merchant = rows(&list, "merchants")
            .into_iter()
            .next()
            .ok_or("merchant row missing")?;
        check_eq!(test_support::text(&merchant, "riskTier"), "HIGH");
        check_eq!(
            test_support::text(&merchant, "taxId"),
            format!("TAX-{}", fixture.unique)
        );
        check_eq!(number(&merchant, "walletCount"), 1);
        check_eq!(number(&merchant, "applicationCount"), 3);
        check_eq!(number(&merchant, "tokenCount"), 1);
        check!(merchant
            .get("latestJoinRequest")
            .is_some_and(Value::is_null));
        check_eq!(number(&merchant, "pendingApprovalCount"), 0);

        let detail = ok(
            "merchant detail",
            merchants::detail(&pool, Some(&full), &fixture.merchant.to_string()).await,
        )?;
        let merchant = detail.get("merchant").ok_or("merchant key")?;
        check_eq!(rows(merchant, "applications").len(), 3);
        check_eq!(rows(merchant, "wallets").len(), 1);
        check_eq!(rows(merchant, "users").len(), 0);
        let balance = merchant.get("walletBalance").ok_or("walletBalance")?;
        check_eq!(test_support::text(balance, "balance"), "25.0000");
        check_eq!(rows(merchant, "fieldHistory").len(), 0);
        check_eq!(number(merchant, "openDisputes"), 0);
        check_eq!(number(merchant, "pendingCashouts"), 1);

        let missing = merchants::detail(&pool, Some(&full), &Uuid::new_v4().to_string())
            .await
            .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "MERCHANT_NOT_FOUND");
        let invalid = merchants::detail(&pool, Some(&full), "not-a-uuid")
            .await
            .expect_err("invalid merchant id");
        check_eq!(invalid.status, 400);
        check_eq!(invalid.code, "INVALID_BODY");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn applications_list_pagination_and_detail() {
    let outcome = test_support::with_fixture("applications", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let query = format!(
            "merchantId={}&status=ACTIVE&search={}",
            fixture.merchant, fixture.unique
        );
        let list = ok(
            "application list",
            applications::list(&pool, Some(&reader), &query).await,
        )?;
        check_eq!(number(&list, "total"), 3);
        let application = rows(&list, "applications")
            .into_iter()
            .find(|row| test_support::text(row, "id") == fixture.application.to_string())
            .ok_or("fixture application row")?;
        check_eq!(
            test_support::text(&application, "expectedMonthlyVolume"),
            "1234.5000"
        );
        check_eq!(rows(&application, "redirectDomains").len(), 0);
        check_eq!(
            test_support::text(&application, "railWhitelistMode"),
            "NONE"
        );
        check_eq!(number(&application, "accessTokenCount"), 1);
        check_eq!(number(&application, "tokenActiveCount"), 1);
        check_eq!(number(&application, "tokenIpRestrictedCount"), 1);
        check_eq!(number(&application, "tokenCidrCount"), 1);
        check_eq!(number(&application, "paymentLinkCount"), 1);
        check_eq!(number(&application, "posTerminalCount"), 1);
        let redacted = rows(&application, "redactedFields");
        check_eq!(redacted.len(), 1);
        check!(redacted.iter().any(|value| value == "redirectDomains"));

        let support = test_support::staff("SUPPORT", &["merchant:read"]);
        let support_view = ok(
            "application list support",
            applications::list(
                &pool,
                Some(&support),
                &format!("merchantId={}&search={}", fixture.merchant, fixture.unique),
            )
            .await,
        )?;
        let support_row = rows(&support_view, "applications")
            .into_iter()
            .next()
            .ok_or("support application row")?;
        check!(support_row
            .get("expectedMonthlyVolume")
            .is_some_and(Value::is_null));
        check_eq!(rows(&support_row, "redactedFields").len(), 2);

        let page = format!(
            "merchantId={}&search={}&page=1&pageSize=2",
            fixture.merchant, fixture.unique
        );
        let first = ok(
            "application page 1",
            applications::list(&pool, Some(&reader), &page).await,
        )?;
        check_eq!(number(&first, "total"), 3);
        check_eq!(rows(&first, "applications").len(), 2);
        check!(
            first.get("nextCursor").is_some(),
            "full page carries a cursor"
        );
        let second_query = format!(
            "merchantId={}&search={}&page=2&pageSize=2",
            fixture.merchant, fixture.unique
        );
        let second = ok(
            "application page 2",
            applications::list(&pool, Some(&reader), &second_query).await,
        )?;
        check_eq!(rows(&second, "applications").len(), 1);

        let full = test_support::staff("GATEWAY_ADMIN", &["*"]);
        let detail = ok(
            "application detail",
            applications::detail(&pool, Some(&full), &fixture.application.to_string()).await,
        )?;
        let application = detail.get("application").ok_or("application key")?;
        check_eq!(
            test_support::text(application, "expectedMonthlyVolume"),
            "1234.5000"
        );
        check_eq!(rows(application, "accessTokens").len(), 1);
        let token = rows(application, "accessTokens")
            .into_iter()
            .next()
            .ok_or("token")?;
        check_eq!(test_support::text(&token, "status"), "ACTIVE");
        check_eq!(rows(&token, "cidrs").len(), 1);
        check_eq!(rows(application, "paymentLinks").len(), 1);
        check_eq!(rows(application, "posTerminals").len(), 1);
        check_eq!(rows(application, "pendingApprovals").len(), 0);

        let missing = applications::detail(&pool, Some(&full), &Uuid::new_v4().to_string())
            .await
            .expect_err("missing application");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "APPLICATION_NOT_FOUND");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn wallets_list_and_detail() {
    let outcome = test_support::with_fixture("wallets", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let query = format!("merchantId={}", fixture.merchant);
        let list = ok(
            "wallet list",
            wallets::list(&pool, Some(&reader), &query).await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let wallet = rows(&list, "wallets")
            .into_iter()
            .next()
            .ok_or("wallet row")?;
        check_eq!(
            test_support::text(&wallet, "id"),
            fixture.wallet.to_string()
        );
        check!(wallet.get("liveBalance").is_some_and(Value::is_null));
        check!(wallet.get("checkpointBalance").is_some_and(Value::is_null));
        check_eq!(number(&wallet, "pendingCashoutCount"), 1);
        check_eq!(number(&wallet, "applicationCount"), 3);

        let full = test_support::staff("FINANCE", &["finance:read"]);
        let list = ok(
            "wallet list finance",
            wallets::list(&pool, Some(&full), &query).await,
        )?;
        let wallet = rows(&list, "wallets")
            .into_iter()
            .next()
            .ok_or("wallet row")?;
        check_eq!(test_support::text(&wallet, "liveBalance"), "25.0000");
        check_eq!(test_support::text(&wallet, "checkpointBalance"), "25.0000");
        check_eq!(rows(&wallet, "redactedFields").len(), 0);

        let detail = ok(
            "wallet detail",
            wallets::detail(&pool, Some(&full), &fixture.wallet.to_string()).await,
        )?;
        let wallet = detail.get("wallet").ok_or("wallet key")?;
        let account = wallet.get("glAccount").ok_or("glAccount")?;
        check_eq!(number(account, "shardCount"), 1);
        check_eq!(test_support::text(account, "checkpointBalance"), "25.0000");
        check_eq!(test_support::text(account, "pendingLines"), "2");
        let shards = rows(wallet, "shards");
        check_eq!(shards.len(), 1);
        check_eq!(test_support::text(&shards[0], "lineSeq"), "5");
        check_eq!(test_support::text(&shards[0], "checkpointSeq"), "3");
        check_eq!(test_support::text(&shards[0], "pendingLines"), "2");
        check_eq!(test_support::text(&shards[0], "currentBalance"), "-25.0000");
        check_eq!(rows(wallet, "applications").len(), 3);
        check_eq!(rows(wallet, "cashouts").len(), 1);
        check_eq!(rows(wallet, "pendingApprovals").len(), 1);
        check_eq!(
            test_support::text(&rows(wallet, "pendingApprovals")[0], "state"),
            "PENDING_REVIEW"
        );

        let missing = wallets::detail(&pool, Some(&full), &Uuid::new_v4().to_string())
            .await
            .expect_err("missing wallet");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "WALLET_NOT_FOUND");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn transactions_list_and_attempt_detail() {
    let outcome = test_support::with_fixture("transactions", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["attempt:read"]);
        let query = format!("merchantId={}&status=UNKNOWN", fixture.merchant);
        let list = ok(
            "transaction list",
            transactions::list(&pool, Some(&reader), &query).await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let attempt = rows(&list, "transactions")
            .into_iter()
            .next()
            .ok_or("transaction row")?;
        check_eq!(
            test_support::text(&attempt, "id"),
            fixture.attempt.to_string()
        );
        check_eq!(test_support::text(&attempt, "status"), "UNKNOWN");
        check_eq!(test_support::text(&attempt, "requestedAmount"), "150.7500");
        check_eq!(
            test_support::text(&attempt, "reference"),
            format!("ref-{}", fixture.unique)
        );
        check_eq!(
            test_support::text(&attempt, "merchantId"),
            fixture.merchant.to_string()
        );
        check_eq!(
            test_support::text(&attempt, "gatewayId"),
            fixture.gateway.to_string()
        );
        check!(attempt
            .get("hasOpenCase")
            .and_then(Value::as_bool)
            .unwrap_or(false));
        check!(attempt
            .get("inquiryEligible")
            .and_then(Value::as_bool)
            .unwrap_or(false));
        check_eq!(rows(&attempt, "redactedFields").len(), 0);

        let empty = ok(
            "transaction filter",
            transactions::list(
                &pool,
                Some(&reader),
                &format!("merchantId={}&status=FAILED", fixture.merchant),
            )
            .await,
        )?;
        check_eq!(number(&empty, "total"), 0);
        let invalid = transactions::list(
            &pool,
            Some(&reader),
            &format!("merchantId={}&status=BOGUS", fixture.merchant),
        )
        .await
        .expect_err("unknown status");
        check_eq!(invalid.status, 400);
        check_eq!(invalid.code, "INVALID_FILTER");

        let support = test_support::staff("SUPPORT", &["attempt:read"]);
        let list = ok(
            "transaction list support",
            transactions::list(&pool, Some(&support), &query).await,
        )?;
        let attempt = rows(&list, "transactions")
            .into_iter()
            .next()
            .ok_or("transaction row")?;
        check!(attempt.get("requestedAmount").is_some_and(Value::is_null));
        check_eq!(rows(&attempt, "redactedFields").len(), 5);

        let detail = ok(
            "attempt detail",
            transactions::attempt_detail(&pool, Some(&reader), &fixture.attempt.to_string()).await,
        )?;
        let attempt = detail.get("attempt").ok_or("attempt key")?;
        check_eq!(
            test_support::text(attempt, "reference"),
            format!("ref-{}", fixture.unique)
        );
        check!(attempt.get("contextCiphertext").is_none());
        check_eq!(test_support::text(attempt, "env"), "LIVE");
        check_eq!(test_support::text(attempt, "requestedAmount"), "150.7500");
        check_eq!(test_support::text(attempt, "netMerchantAmount"), "150.7500");
        check_eq!(
            test_support::text(attempt.get("link").ok_or("link")?, "id"),
            fixture.link.to_string()
        );
        check_eq!(
            test_support::text(detail.get("gateway").ok_or("gateway")?, "id"),
            fixture.gateway.to_string()
        );
        check!(detail
            .get("gatewaySupportsStatusCheck")
            .and_then(Value::as_bool)
            .unwrap_or(false));
        check!(detail
            .get("inquiryEligibility")
            .and_then(|value| value.get("eligible"))
            .and_then(Value::as_bool)
            .unwrap_or(false));
        check_eq!(rows(&detail, "stepLogs").len(), 0);
        check_eq!(rows(&detail, "inboundEvents").len(), 0);
        let group = detail.get("attemptGroup").ok_or("attemptGroup")?;
        check_eq!(rows(group, "attempts").len(), 1);
        check_eq!(number(group, "successCount"), 0);
        check_eq!(rows(&detail, "operatorCases").len(), 1);
        check_eq!(rows(&detail, "disputes").len(), 0);
        check_eq!(rows(&detail, "adjustments").len(), 0);

        let missing =
            transactions::attempt_detail(&pool, Some(&reader), &Uuid::new_v4().to_string())
                .await
                .expect_err("missing attempt");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "PAYMENT_ATTEMPT_NOT_FOUND");
        let invalid = transactions::attempt_detail(&pool, Some(&reader), "nope")
            .await
            .expect_err("invalid attempt id");
        check_eq!(invalid.status, 404);
        check_eq!(invalid.code, "PAYMENT_ATTEMPT_NOT_FOUND");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn payment_links_list_filters() {
    let outcome = test_support::with_fixture("payment-links", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let query = format!("applicationId={}&state=PENDING", fixture.application);
        let list = ok(
            "payment link list",
            catalog::payment_links(&pool, Some(&reader), &query).await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let link = rows(&list, "paymentLinks")
            .into_iter()
            .next()
            .ok_or("payment link row")?;
        check_eq!(test_support::text(&link, "id"), fixture.link.to_string());
        check_eq!(
            test_support::text(&link, "key"),
            format!("pl_{}", fixture.unique)
        );
        check_eq!(test_support::text(&link, "amount"), "100.5000");
        check_eq!(test_support::text(&link, "state"), "PENDING");
        check_eq!(
            test_support::text(link.get("application").ok_or("application")?, "id"),
            fixture.application.to_string()
        );
        check_eq!(
            test_support::text(link.get("merchant").ok_or("merchant")?, "id"),
            fixture.merchant.to_string()
        );
        let empty = ok(
            "payment link state filter",
            catalog::payment_links(
                &pool,
                Some(&reader),
                &format!("applicationId={}&state=CANCELLED", fixture.application),
            )
            .await,
        )?;
        check_eq!(number(&empty, "total"), 0);
        let invalid = catalog::payment_links(&pool, Some(&reader), "state=NOPE")
            .await
            .expect_err("unknown state");
        check_eq!(invalid.code, "INVALID_FILTER");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn pos_terminals_list_filters() {
    let outcome = test_support::with_fixture("pos", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let list = ok(
            "pos list",
            catalog::pos_terminals(
                &pool,
                Some(&reader),
                &format!("applicationId={}&status=ACTIVE", fixture.application),
            )
            .await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let terminal = rows(&list, "posTerminals")
            .into_iter()
            .next()
            .ok_or("pos row")?;
        check_eq!(test_support::text(&terminal, "id"), fixture.pos.to_string());
        check_eq!(number(&terminal, "screenCount"), 1);
        check!(terminal
            .get("lastActiveAt")
            .and_then(Value::as_str)
            .is_some());
        check_eq!(test_support::text(&terminal, "status"), "ACTIVE");
        let empty = ok(
            "pos status filter",
            catalog::pos_terminals(
                &pool,
                Some(&reader),
                &format!("applicationId={}&status=BLOCKED", fixture.application),
            )
            .await,
        )?;
        check_eq!(number(&empty, "total"), 0);
        let invalid = catalog::pos_terminals(&pool, Some(&reader), "status=NOPE")
            .await
            .expect_err("unknown status");
        check_eq!(invalid.code, "INVALID_FILTER");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn access_tokens_list_filters() {
    let outcome = test_support::with_fixture("tokens", |pool, fixture| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let list = ok(
            "token list",
            catalog::access_tokens(
                &pool,
                Some(&reader),
                &format!(
                    "applicationId={}&status=ACTIVE&env=LIVE",
                    fixture.application
                ),
            )
            .await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let token = rows(&list, "accessTokens")
            .into_iter()
            .next()
            .ok_or("token row")?;
        check_eq!(test_support::text(&token, "id"), fixture.token.to_string());
        check_eq!(test_support::text(&token, "status"), "ACTIVE");
        check_eq!(test_support::text(&token, "env"), "LIVE");
        check_eq!(number(&token, "ipCount"), 1);
        check_eq!(rows(&token, "cidrs").len(), 1);
        check_eq!(
            test_support::text(token.get("application").ok_or("application")?, "id"),
            fixture.application.to_string()
        );
        check_eq!(
            test_support::text(token.get("merchant").ok_or("merchant")?, "id"),
            fixture.merchant.to_string()
        );
        check!(token.get("tokenHash").is_none());

        let empty = ok(
            "token revoked filter",
            catalog::access_tokens(
                &pool,
                Some(&reader),
                &format!("applicationId={}&status=REVOKED", fixture.application),
            )
            .await,
        )?;
        check_eq!(number(&empty, "total"), 0);
        let strict = catalog::access_tokens(
            &pool,
            Some(&reader),
            &format!(
                "applicationId={}&ipWhitelistEnabled=maybe",
                fixture.application
            ),
        )
        .await
        .expect_err("bad boolean");
        check_eq!(strict.code, "INVALID_FILTER");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn assets_list_and_detail() {
    let outcome = test_support::with_fixture("assets", |pool, fixture| async move {
        let list = ok("asset list", catalog::assets(&pool).await)?;
        let asset = rows(&list, "assets")
            .into_iter()
            .find(|row| test_support::text(row, "id") == fixture.asset.to_string())
            .ok_or("created asset missing from the list")?;
        check_eq!(test_support::text(&asset, "mime"), "IMAGE_PNG");
        check_eq!(number(&asset, "sizeBytes"), 1234);

        let detail = ok(
            "asset detail",
            catalog::asset_detail(&pool, &fixture.asset.to_string()).await,
        )?;
        let asset = detail.get("asset").ok_or("asset key")?;
        check_eq!(
            test_support::text(asset, "name"),
            format!("{}.png", fixture.unique)
        );
        check!(asset.get("storageObjectId").is_some_and(Value::is_null));

        let missing = catalog::asset_detail(&pool, &Uuid::new_v4().to_string())
            .await
            .expect_err("missing asset");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "ASSET_NOT_FOUND");
        let invalid = catalog::asset_detail(&pool, "nope")
            .await
            .expect_err("invalid asset id");
        check_eq!(invalid.status, 404);
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}
