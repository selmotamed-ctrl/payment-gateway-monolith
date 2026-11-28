//! Fire-and-forget sinks: operator cases and the transition bus.
//!
//! `CaseSink` and `TransitionSink` are synchronous by contract (`ports.rs`): the engine calls them
//! from a finalize step that already holds its transaction. The database sink therefore accepts the
//! input and writes it on the runtime (the TS `PrismaOperatorCaseSink` is awaited, but the port
//! narrowed it), capturing failures instead of blocking the rail loop.

use std::sync::{Arc, Mutex};

use sqlx::PgPool;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::adapters::{naive, parse_uuid};
use crate::error::EngineError;
use crate::ports::{AttemptTransitionEvent, CaseSink, OperatorCaseInput, TransitionSink};

/// `OperatorCaseSink.open` on the core database.
#[derive(Clone)]
pub struct PgCaseSink {
    pool: PgPool,
    errors: Arc<Mutex<Vec<String>>>,
}

impl std::fmt::Debug for PgCaseSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgCaseSink")
            .field(
                "errors",
                &self.errors.lock().map(|errors| errors.len()).unwrap_or(0),
            )
            .finish_non_exhaustive()
    }
}

impl PgCaseSink {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            errors: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// The latest accepted-but-failed writes (bounded), for a health probe or a test.
    #[must_use]
    pub fn errors(&self) -> Vec<String> {
        self.errors
            .lock()
            .map(|errors| errors.clone())
            .unwrap_or_default()
    }

    /// Writes one case in the caller's transaction.
    pub async fn open_on(
        &self,
        conn: &mut sqlx::PgConnection,
        input: &OperatorCaseInput,
    ) -> Result<Uuid, EngineError> {
        let attempt_id = parse_uuid(&input.attempt_id, "attempt id")
            .map_err(|error| EngineError::with_code(500, "CASE_ATTEMPT_INVALID", error))?;
        let kind = case_kind(&input.kind);
        let id = Uuid::now_v7();
        sqlx::query(
            r#"
INSERT INTO operator_cases
    (id, updated_at, attempt_id, kind, case_type, source, domain, title_text, summary,
     priority, sla_due_at, state, resolution_notes)
VALUES ($1, now(), $2, $3::text::"OperatorCaseKind", $3, 'RAIL_ENGINE', 'PAYMENTS', $4, $5,
        $6::text::"OperatorCasePriority", $7, 'OPEN'::"OperatorCaseState", $5)
"#,
        )
        .bind(id)
        .bind(attempt_id)
        .bind(kind)
        .bind(&input.title)
        .bind(&input.detail)
        .bind(input.priority.as_str())
        .bind(naive(input.sla_due_at))
        .execute(&mut *conn)
        .await
        .map_err(|error| {
            EngineError::with_code(
                500,
                "CASE_INSERT_FAILED",
                format!("database error: {error}"),
            )
        })?;
        let details = serde_json::json!({
            "kind": input.kind,
            "attemptId": input.attempt_id,
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
        .bind(&input.title)
        .bind(details)
        .execute(&mut *conn)
        .await
        .map_err(|error| {
            EngineError::with_code(
                500,
                "CASE_EVENT_INSERT_FAILED",
                format!("database error: {error}"),
            )
        })?;
        Ok(id)
    }
}

impl CaseSink for PgCaseSink {
    fn open(&self, input: OperatorCaseInput) {
        let sink = self.clone();
        tokio::spawn(async move {
            let result = async {
                let mut tx = sink.pool.begin().await.map_err(|error| error.to_string())?;
                sink.open_on(&mut tx, &input)
                    .await
                    .map_err(|error| error.message)?;
                tx.commit().await.map_err(|error| error.to_string())?;
                Ok::<(), String>(())
            }
            .await;
            if let Err(error) = result {
                if let Ok(mut errors) = sink.errors.lock() {
                    if errors.len() >= 100 {
                        errors.remove(0);
                    }
                    errors.push(error);
                }
            }
        });
    }
}

/// The `OperatorCaseKind` the engine's label maps onto.
fn case_kind(kind: &str) -> &'static str {
    match kind {
        "UNKNOWN" => "UNKNOWN",
        "HELD" => "HELD",
        "CONFLICT" => "CONFLICT",
        "MISMATCH" => "MISMATCH",
        "LATE_SUCCESS" => "LATE_SUCCESS",
        "UNMATCHED_STATEMENT" => "UNMATCHED_STATEMENT",
        _ => "MANUAL_REVIEW",
    }
}

/// The `attempt:transition` invalidation bus.
///
/// The TypeScript bus is Redis-backed (`lib/invalidationBus.ts`); a process-wide broadcast channel
/// keeps the same fan-out semantics for the Rust core, and the storage layer can bridge it to Redis
/// without touching the engine.
#[derive(Debug, Clone)]
pub struct PgTransitionSink {
    sender: broadcast::Sender<AttemptTransitionEvent>,
    errors: Arc<Mutex<Vec<String>>>,
}

impl PgTransitionSink {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let (sender, _receiver) = broadcast::channel(capacity.max(1));
        Self {
            sender,
            errors: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Subscribes to the transition events.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AttemptTransitionEvent> {
        self.sender.subscribe()
    }

    /// The latest delivery failures (bounded).
    #[must_use]
    pub fn errors(&self) -> Vec<String> {
        self.errors
            .lock()
            .map(|errors| errors.clone())
            .unwrap_or_default()
    }
}

impl Default for PgTransitionSink {
    fn default() -> Self {
        Self::new(1024)
    }
}

impl TransitionSink for PgTransitionSink {
    fn publish(&self, event: AttemptTransitionEvent) {
        if self.sender.send(event).is_err() {
            if let Ok(mut errors) = self.errors.lock() {
                if errors.len() >= 100 {
                    errors.remove(0);
                }
                errors.push("no transition subscriber is listening".to_owned());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::CasePriority;
    use pg_domain_flow::PaymentStatus;

    #[test]
    fn case_kinds_match_the_prisma_enum() {
        assert_eq!(case_kind("LATE_SUCCESS"), "LATE_SUCCESS");
        assert_eq!(case_kind("WHATEVER"), "MANUAL_REVIEW");
        assert_eq!(case_kind("UNMATCHED_STATEMENT"), "UNMATCHED_STATEMENT");
    }

    #[test]
    fn transition_sink_hands_the_event_to_every_subscriber() {
        let sink = PgTransitionSink::new(8);
        let mut first = sink.subscribe();
        let mut second = sink.subscribe();
        sink.publish(AttemptTransitionEvent {
            attempt_id: "a1".to_owned(),
            status: PaymentStatus::Succeeded,
            substatus: None,
            merchant_id: None,
        });
        assert_eq!(first.try_recv().expect("first").attempt_id, "a1");
        assert_eq!(second.try_recv().expect("second").attempt_id, "a1");
        assert!(sink.errors().is_empty());
        assert_eq!(CasePriority::P1.as_str(), "P1");
    }
}
