//! Background loops: automatic async-rail approval and expired-hold sweeping.
//! Ported from `engine/chaos/AutoApprovalScheduler.ts` and the `releaseExpiredHolds` interval in
//! `index.ts`.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::accounts::{capture_hold, release_expired_holds};
use crate::chaos::get_scenario;
use crate::db::{now_iso, update_transaction, Transaction};
use crate::state::AppState;
use crate::webhook::{DispatchInput, WebhookBehavior};

/// Approves every pending async rail whose scenario delay has elapsed.
pub fn run_auto_approval_tick(state: &AppState, now_ms: i64) -> crate::error::ApiResult<usize> {
    let rows = state.db.query_json(
        "SELECT * FROM fake_transactions WHERE status IN ('AWAITING_ACTION','INITIATED')
         ORDER BY created_at ASC LIMIT 200",
        vec![],
    )?;
    let mut approved = 0usize;
    for row in rows {
        let Some(rail_code) = row.get("rail_code").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let scenario = get_scenario(&state.db, rail_code)?;
        let Some(delay_seconds) = scenario.auto_approve_async_after_sec else {
            continue;
        };
        if delay_seconds <= 0.0 {
            continue;
        }
        let Some(created_at) = row.get("created_at").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Ok(created) = chrono::DateTime::parse_from_rfc3339(created_at) else {
            continue;
        };
        if now_ms < created.timestamp_millis() + (delay_seconds * 1000.0) as i64 {
            continue;
        }
        let Some(transaction) = transaction_from_row(&row) else {
            continue;
        };
        let _ = capture_hold(
            &state.db,
            &transaction.id,
            Some(&transaction.normalized_amount_lyd),
        );
        update_transaction(
            &state.db,
            &transaction.id,
            &[
                ("status", json!("PAID")),
                (
                    "settled_amount_lyd",
                    json!(transaction.normalized_amount_lyd),
                ),
            ],
        )?;
        let updated = Transaction {
            status: "PAID".to_owned(),
            settled_amount_lyd: Some(transaction.normalized_amount_lyd.clone()),
            updated_at: now_iso(),
            ..transaction
        };
        state.webhooks.dispatch(&DispatchInput {
            transaction: &updated,
            event: "payment.paid",
            payload: json!({
                "reference": updated.our_reference,
                "our_reference": updated.our_reference,
                "provider_reference": updated.provider_reference,
                "transaction_id": updated.provider_reference,
                "amount": updated.settled_amount_lyd.clone().unwrap_or_else(|| updated.normalized_amount_lyd.clone()),
                "currency": updated.currency,
                "status": "PAID",
            }),
            url: None,
            behavior: WebhookBehavior {
                delay_seconds: scenario.webhook_behavior.delay_seconds,
                ..WebhookBehavior::default()
            },
            headers: std::collections::BTreeMap::new(),
        })?;
        approved += 1;
    }
    Ok(approved)
}

fn transaction_from_row(row: &serde_json::Value) -> Option<Transaction> {
    let text = |field: &str| row.get(field).and_then(serde_json::Value::as_str);
    Some(Transaction {
        id: text("id")?.to_owned(),
        gateway_code: text("gateway_code")?.to_owned(),
        rail_code: text("rail_code")?.to_owned(),
        env: text("env").unwrap_or("SANDBOX").to_owned(),
        our_reference: text("our_reference")?.to_owned(),
        provider_reference: text("provider_reference")?.to_owned(),
        network_reference: text("network_reference").map(str::to_owned),
        idempotency_key: text("idempotency_key").map(str::to_owned),
        requested_amount_wire: text("requested_amount_wire").unwrap_or_default().to_owned(),
        normalized_amount_lyd: text("normalized_amount_lyd").unwrap_or_default().to_owned(),
        settled_amount_lyd: text("settled_amount_lyd").map(str::to_owned),
        gateway_fee_lyd: text("gateway_fee_lyd").unwrap_or("0.0000").to_owned(),
        currency: text("currency").unwrap_or("LYD").to_owned(),
        collection_mode: text("collection_mode").unwrap_or("OTP_PULL").to_owned(),
        customer_identifier_masked: text("customer_identifier_masked").map(str::to_owned),
        expected_otp: text("expected_otp").map(str::to_owned),
        merchant_id: text("merchant_id").map(str::to_owned),
        qr_payload: text("qr_payload").map(str::to_owned),
        deep_link_url: text("deep_link_url").map(str::to_owned),
        redirect_url: text("redirect_url").map(str::to_owned),
        account_id: text("account_id").map(str::to_owned),
        held_amount_lyd: text("held_amount_lyd").map(str::to_owned),
        status: text("status")?.to_owned(),
        assigned_fail_phase: text("assigned_fail_phase").map(str::to_owned),
        assigned_failure_mode: text("assigned_failure_mode").map(str::to_owned),
        inquiry_override_status: text("inquiry_override_status").map(str::to_owned),
        return_url: text("return_url").map(str::to_owned),
        cancel_url: text("cancel_url").map(str::to_owned),
        webhook_url: text("webhook_url").map(str::to_owned),
        is_seeded_historical: row
            .get("is_seeded_historical")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        created_at: text("created_at").unwrap_or_default().to_owned(),
        updated_at: text("updated_at").unwrap_or_default().to_owned(),
    })
}

/// Starts the process-local background loops (never used by the in-process tests).
pub fn spawn_background(state: Arc<AppState>) {
    state.webhooks.resume_queued();
    let approval_state = state.clone();
    tokio::spawn(async move {
        let interval_ms: u64 = std::env::var("FAKE_RAILS_AUTO_APPROVE_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1000)
            .max(250);
        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            let _ = run_auto_approval_tick(&approval_state, chrono::Utc::now().timestamp_millis());
        }
    });
    let hold_state = state;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let now = now_iso();
            let _ = release_expired_holds(&hold_state.db, &now);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::reserve_account_funds;
    use crate::accounts::Reserve;
    use crate::chaos::save_scenario;
    use crate::config::Config;
    use crate::db::insert_transaction;

    fn transaction(state: &AppState, reference: &str) -> Transaction {
        let now = now_iso();
        let row = Transaction {
            id: crate::db::uuid_v7(),
            gateway_code: "mobicash".to_owned(),
            rail_code: "mobicash".to_owned(),
            env: "SANDBOX".to_owned(),
            our_reference: reference.to_owned(),
            provider_reference: format!("FK-{reference}"),
            network_reference: None,
            idempotency_key: None,
            requested_amount_wire: "10.00".to_owned(),
            normalized_amount_lyd: "10.0000".to_owned(),
            settled_amount_lyd: None,
            gateway_fee_lyd: "0.0000".to_owned(),
            currency: "LYD".to_owned(),
            collection_mode: "QR_DISPLAY".to_owned(),
            customer_identifier_masked: None,
            expected_otp: Some("123456".to_owned()),
            merchant_id: None,
            qr_payload: None,
            deep_link_url: None,
            redirect_url: None,
            account_id: None,
            held_amount_lyd: None,
            status: "AWAITING_ACTION".to_owned(),
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            inquiry_override_status: None,
            return_url: None,
            cancel_url: None,
            webhook_url: None,
            is_seeded_historical: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        insert_transaction(&state.db, &row).expect("insert");
        row
    }

    #[tokio::test]
    async fn auto_approval_settles_after_the_configured_delay() {
        let config = Config::test_config("/tmp/auto-approval.sqlite");
        let state = AppState::new(config).expect("state");
        let transaction = transaction(&state, "AUTO-1");
        let rich = crate::accounts::get_account(
            &state.db,
            state
                .db
                .query_json(
                    "SELECT id FROM fake_accounts WHERE rail_code = 'mobicash' AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1",
                    vec![],
                )
                .expect("account")
                .first()
                .and_then(|row| row.get("id"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
        )
        .expect("get")
        .expect("account");
        reserve_account_funds(
            &state.db,
            &Reserve {
                rail_code: "mobicash",
                gateway_code: "mobicash",
                identifier: Some(&rich.identifier),
                transaction_id: &transaction.id,
                amount_lyd: "10.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        let mut scenario = crate::chaos::get_scenario(&state.db, "mobicash").expect("scenario");
        scenario.auto_approve_async_after_sec = Some(0.0);
        save_scenario(&state.db, &scenario).expect("save");
        // A zero delay is deliberately ignored (TS `<= 0` means off).
        assert_eq!(
            run_auto_approval_tick(&state, chrono::Utc::now().timestamp_millis() + 60_000)
                .expect("tick"),
            0
        );
        let mut scenario = crate::chaos::get_scenario(&state.db, "mobicash").expect("scenario");
        scenario.auto_approve_async_after_sec = Some(1.0);
        save_scenario(&state.db, &scenario).expect("save");
        let approved =
            run_auto_approval_tick(&state, chrono::Utc::now().timestamp_millis() + 60_000)
                .expect("tick");
        assert_eq!(approved, 1);
        let row = crate::db::find_transaction_by_id(&state.db, &transaction.id)
            .expect("query")
            .expect("row");
        assert_eq!(row.status, "PAID");
        assert_eq!(row.settled_amount_lyd.as_deref(), Some("10.0000"));
    }
}
