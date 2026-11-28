//! [`SlotStore`] over `payment_links`.
//!
//! Port of `engine/runtime/slotStore.ts` (reserve / release / commit) including the SUSPENSE
//! overflow path: a settlement that would push a non-infinite link past `use_count` is parked in
//! SUSPENSE, an automatic refund adjustment is drafted and one P1 `LATE_SUCCESS` case is opened, all
//! inside the caller's transaction.
//!
//! The database rules copied exactly:
//!
//! - reserve: `SELECT … FOR UPDATE` on a link with a free slot, then
//!   `active_locked_count = active_locked_count + 1`;
//! - release: `GREATEST(0, active_locked_count - 1)` plus the reason as the attempt substatus;
//! - commit: one conditional `UPDATE` that settles the counters against the old row and completes
//!   the link at `use_count`; no row moved means SUSPENSE.

use std::sync::Arc;

use async_trait::async_trait;
use pg_domain_ledger::LedgerScenario;
use pg_ledger::AccountCache;
use rust_decimal::Decimal;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::adapters::ledger::post_scenario_in_tx;
use crate::adapters::parse_uuid;
use crate::engine::SUSPENSE_SETTLEMENT_SUBSTATUS;
use crate::ports::{
    Attempt, CasePriority, Environment, OwnershipMode, ScenarioPosting, SlotCommit, SlotOutcome,
    SlotReservation, SlotStore, StoreError,
};

/// [`SlotStore`] on the core database.
#[derive(Clone)]
pub struct PgSlotStore {
    pool: PgPool,
    account_cache: Option<Arc<AccountCache>>,
}

impl std::fmt::Debug for PgSlotStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgSlotStore")
            .finish_non_exhaustive()
    }
}

impl PgSlotStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            account_cache: None,
        }
    }

    #[must_use]
    pub fn with_account_cache(mut self, cache: Arc<AccountCache>) -> Self {
        self.account_cache = Some(cache);
        self
    }

    /// `reserveSlot` in the caller's transaction.
    pub async fn reserve_on(
        &self,
        conn: &mut PgConnection,
        attempt: &Attempt,
    ) -> Result<SlotReservation, StoreError> {
        let link_id = link_id_of(&mut *conn, attempt).await?;
        let link_id = link_id.ok_or_else(|| {
            StoreError::Backend("The attempt is not bound to a payment link".to_owned())
        })?;
        let locked: Option<(Uuid,)> = sqlx::query_as(
            r#"
SELECT id FROM payment_links
 WHERE id = $1::uuid
   AND (infinite_use = true OR confirmed_count + active_locked_count < use_count)
 FOR UPDATE
"#,
        )
        .bind(link_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(backend)?;
        if locked.is_none() {
            return Err(StoreError::Backend(
                "The payment link has no available slot".to_owned(),
            ));
        }
        let updated = sqlx::query(
            r#"
UPDATE payment_links
   SET active_locked_count = active_locked_count + 1, updated_at = now()
 WHERE id = $1::uuid
   AND (infinite_use = true OR confirmed_count + active_locked_count < use_count)
"#,
        )
        .bind(link_id)
        .execute(&mut *conn)
        .await
        .map_err(backend)?
        .rows_affected();
        if updated == 0 {
            return Err(StoreError::Backend(
                "The payment link has no available slot".to_owned(),
            ));
        }
        Ok(SlotReservation {
            reservation_id: crate::ports::slot_reservation_id(&link_id.to_string(), &attempt.id),
            link_id: Some(link_id.to_string()),
        })
    }

    /// `releaseSlot` in the caller's transaction.
    pub async fn release_on(
        &self,
        conn: &mut PgConnection,
        attempt: &Attempt,
        reason: &str,
    ) -> Result<(), StoreError> {
        let Some(link_id) = link_id_of(&mut *conn, attempt).await? else {
            return Ok(());
        };
        sqlx::query(
            "UPDATE payment_links SET active_locked_count = GREATEST(0, active_locked_count - 1), \
             updated_at = now() WHERE id = $1::uuid",
        )
        .bind(link_id)
        .execute(&mut *conn)
        .await
        .map_err(backend)?;
        let attempt_id = parse_uuid(&attempt.id, "attempt id").map_err(StoreError::Backend)?;
        sqlx::query("UPDATE payment_attempts SET substatus = $2, updated_at = now() WHERE id = $1")
            .bind(attempt_id)
            .bind(reason)
            .execute(&mut *conn)
            .await
            .map_err(backend)?;
        Ok(())
    }

    /// `commitSlot` in the caller's transaction.
    pub async fn commit_on(
        &self,
        conn: &mut PgConnection,
        attempt: &Attempt,
    ) -> Result<SlotCommit, StoreError> {
        let Some(link_id) = link_id_of(&mut *conn, attempt).await? else {
            return Ok(SlotCommit::committed());
        };
        let updated = sqlx::query(
            r#"
UPDATE payment_links
   SET state = CASE WHEN infinite_use = false AND confirmed_count + 1 >= use_count THEN 'COMPLETED' ELSE state END,
       confirmed_count = confirmed_count + 1,
       active_locked_count = GREATEST(0, active_locked_count - 1),
       updated_at = now()
 WHERE id = $1::uuid
   AND (infinite_use = true OR confirmed_count + 1 <= use_count)
"#,
        )
        .bind(link_id)
        .execute(&mut *conn)
        .await
        .map_err(backend)?
        .rows_affected();
        if updated > 0 {
            return Ok(SlotCommit::committed());
        }
        let link: Option<(i32, i32, i32, bool)> = sqlx::query_as(
            r#"
SELECT confirmed_count, active_locked_count, use_count, infinite_use
  FROM payment_links
 WHERE id = $1::uuid
 FOR UPDATE
"#,
        )
        .bind(link_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(backend)?;
        let (confirmed_count, use_count) = match link {
            Some((confirmed, _locked, use_count, _infinite)) => (confirmed, use_count),
            // The link vanished between the attempt and the commit: there is no capacity to rely
            // on, so the money goes to SUSPENSE rather than being reported as a merchant credit.
            None => (0, 1),
        };
        self.route_to_suspense(&mut *conn, attempt, link_id, confirmed_count, use_count)
            .await
    }

    async fn route_to_suspense(
        &self,
        conn: &mut PgConnection,
        attempt: &Attempt,
        link_id: Uuid,
        confirmed_count: i32,
        use_count: i32,
    ) -> Result<SlotCommit, StoreError> {
        sqlx::query(
            r#"
UPDATE payment_links
   SET state = CASE WHEN infinite_use = false AND confirmed_count >= use_count THEN 'COMPLETED' ELSE state END,
       active_locked_count = GREATEST(0, active_locked_count - 1),
       updated_at = now()
 WHERE id = $1::uuid
"#,
        )
        .bind(link_id)
        .execute(&mut *conn)
        .await
        .map_err(backend)?;

        let amount = attempt.charged_amount();
        let posting = ScenarioPosting {
            scenario: LedgerScenario::SuspenseSettlement,
            stage: None,
            ref_id: attempt.id.clone(),
            amount,
            commission_amount: Decimal::ZERO,
            merchant_amount: Decimal::ZERO,
            merchant_id: attempt.merchant_id.clone(),
            gateway_id: attempt.gateway_id.clone(),
            credential_set_id: attempt.credential_set_id.clone(),
            wallet_gl_account_id: attempt.wallet_gl_account_id.clone(),
            currency: attempt.currency.clone(),
            env: attempt.env,
        };
        let posted = post_scenario_in_tx(&mut *conn, &posting, self.account_cache.as_deref())
            .await
            .map_err(|error| StoreError::Backend(error.message))?;

        let suspense = suspense_account_id(&mut *conn, &attempt.currency).await?;
        let adjustment = ensure_refund_adjustment(
            &mut *conn,
            attempt,
            amount,
            suspense,
            link_id,
            confirmed_count,
            use_count,
        )
        .await?;
        let operator_case = ensure_operator_case(&mut *conn, attempt, amount, link_id).await?;

        Ok(SlotCommit {
            outcome: SlotOutcome::Suspense,
            journal_entry_id: Some(posted.entry_id),
            adjustment_id: Some(adjustment.to_string()),
            operator_case_id: Some(operator_case.to_string()),
            reason: Some("SLOT_ALREADY_SETTLED".to_owned()),
        })
    }
}

async fn link_id_of(
    conn: &mut PgConnection,
    attempt: &Attempt,
) -> Result<Option<Uuid>, StoreError> {
    if let Some(link_id) = attempt.link_id.as_deref() {
        return parse_uuid(link_id, "link id")
            .map(Some)
            .map_err(StoreError::Backend);
    }
    let attempt_id = parse_uuid(&attempt.id, "attempt id").map_err(StoreError::Backend)?;
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT link_id FROM payment_attempts WHERE id = $1")
        .bind(attempt_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(backend)?;
    Ok(row.map(|(link_id,)| link_id))
}

async fn suspense_account_id(conn: &mut PgConnection, currency: &str) -> Result<Uuid, StoreError> {
    let scoped: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM gl_accounts WHERE account_type = 'SUSPENSE' AND currency = $1 \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(currency)
    .fetch_optional(&mut *conn)
    .await
    .map_err(backend)?;
    if let Some((id,)) = scoped {
        return Ok(id);
    }
    let fallback: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM gl_accounts WHERE account_type = 'SUSPENSE' ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(backend)?;
    fallback.map(|(id,)| id).ok_or_else(|| {
        StoreError::Backend(
            "GL_ACCOUNT_NOT_FOUND: No SUSPENSE account matched the posting context".to_owned(),
        )
    })
}

async fn ensure_refund_adjustment(
    conn: &mut PgConnection,
    attempt: &Attempt,
    amount: Decimal,
    suspense_account_id: Uuid,
    link_id: Uuid,
    confirmed_count: i32,
    use_count: i32,
) -> Result<Uuid, StoreError> {
    let attempt_id = parse_uuid(&attempt.id, "attempt id").map_err(StoreError::Backend)?;
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM adjustments WHERE source_attempt_id = $1 AND type = 'REFUND' LIMIT 1",
    )
    .bind(attempt_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(backend)?;
    if let Some((id,)) = existing {
        return Ok(id);
    }
    let id = Uuid::now_v7();
    let reason = format!(
        "Automatic refund draft: the settlement of attempt {} was routed to SUSPENSE because \
         payment link {} already used {} of {} slot(s).",
        attempt.id, link_id, confirmed_count, use_count
    );
    sqlx::query(
        r#"
INSERT INTO adjustments
    (id, updated_at, type, target_gl_account_id, source_attempt_id, drafted_by_system,
     amount, reverse_commission, reason, state)
VALUES ($1, now(), 'REFUND'::"AdjustmentType", $2, $3, true, $4, false, $5,
        'PENDING_REVIEW'::"AdjustmentState")
"#,
    )
    .bind(id)
    .bind(suspense_account_id)
    .bind(attempt_id)
    .bind(amount)
    .bind(reason)
    .execute(&mut *conn)
    .await
    .map_err(backend)?;
    Ok(id)
}

async fn ensure_operator_case(
    conn: &mut PgConnection,
    attempt: &Attempt,
    amount: Decimal,
    link_id: Uuid,
) -> Result<Uuid, StoreError> {
    let attempt_id = parse_uuid(&attempt.id, "attempt id").map_err(StoreError::Backend)?;
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM operator_cases WHERE attempt_id = $1 AND kind = 'LATE_SUCCESS' LIMIT 1",
    )
    .bind(attempt_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(backend)?;
    if let Some((id,)) = existing {
        return Ok(id);
    }
    let notes = format!(
        "Settlement of {amount} on link {link_id} was routed to SUSPENSE; an automatic refund \
         adjustment is waiting for review."
    );
    let id = Uuid::now_v7();
    let title = "Late payment success";
    sqlx::query(
        r#"
INSERT INTO operator_cases
    (id, updated_at, attempt_id, kind, case_type, source, domain, title_text, priority,
     sla_due_at, state, resolution_notes)
VALUES ($1, now(), $2, 'LATE_SUCCESS'::"OperatorCaseKind", 'LATE_SUCCESS', 'RAIL_ENGINE',
        'PAYMENTS', $3, 'P1'::"OperatorCasePriority", now() + interval '4 hours',
        'OPEN'::"OperatorCaseState", $4)
"#,
    )
    .bind(id)
    .bind(attempt_id)
    .bind(title)
    .bind(&notes)
    .execute(&mut *conn)
    .await
    .map_err(backend)?;
    let details = serde_json::json!({
        "attemptId": attempt.id,
        "linkId": link_id.to_string(),
        "amount": amount.to_string(),
        "reason": "SLOT_ALREADY_SETTLED",
    });
    sqlx::query(
        r#"
INSERT INTO operator_case_events
    (id, created_at, case_id, event_type, actor_type, summary, details_json)
VALUES ($1, now(), $2, 'OPENED', 'SYSTEM', $3, $4)
"#,
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(title)
    .bind(details)
    .execute(&mut *conn)
    .await
    .map_err(backend)?;
    Ok(id)
}

fn backend(error: sqlx::Error) -> StoreError {
    StoreError::Backend(format!("database error: {error}"))
}

#[async_trait]
impl SlotStore for PgSlotStore {
    async fn reserve(&self, attempt: &Attempt) -> Result<SlotReservation, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let reservation = self.reserve_on(&mut tx, attempt).await?;
        tx.commit().await.map_err(backend)?;
        Ok(reservation)
    }

    async fn release(&self, attempt: &Attempt, reason: &str) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        self.release_on(&mut tx, attempt, reason).await?;
        tx.commit().await.map_err(backend)?;
        Ok(())
    }

    async fn commit(&self, attempt: &Attempt) -> Result<SlotCommit, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let commit = self.commit_on(&mut tx, attempt).await?;
        tx.commit().await.map_err(backend)?;
        Ok(commit)
    }
}

/// The substatus the engine writes for a SUSPENSE settlement; re-exported so the sink and a test
/// cannot drift.
#[must_use]
pub fn suspense_substatus() -> &'static str {
    SUSPENSE_SETTLEMENT_SUBSTATUS
}

/// The priority of the automatic SUSPENSE case (`slotStore.ts`).
#[must_use]
pub fn suspense_case_priority() -> CasePriority {
    CasePriority::P1
}

/// The ownership mode the SUSPENSE journal defaults to when the port has no context.
#[must_use]
pub fn suspense_default_ownership() -> OwnershipMode {
    OwnershipMode::PlatformClearing
}

/// The environment a SUSPENSE posting carries when the attempt is in `LIVE`.
#[must_use]
pub fn suspense_environment_live() -> Environment {
    Environment::Live
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_id_matches_the_ts_shape() {
        assert_eq!(
            crate::ports::slot_reservation_id("link-1", "attempt-1"),
            "link-1:attempt-1"
        );
        assert_eq!(suspense_case_priority(), CasePriority::P1);
        assert_eq!(suspense_substatus(), "SUSPENSE_SETTLEMENT");
        assert_eq!(
            suspense_default_ownership(),
            OwnershipMode::PlatformClearing
        );
        assert_eq!(suspense_environment_live(), Environment::Live);
    }
}
