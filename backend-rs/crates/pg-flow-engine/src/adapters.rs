//! Database, egress and ledger adapters for the flow-engine ports.
//!
//! The engine in [`crate::engine`] owns no I/O: this module implements the ports of
//! [`crate::ports`] on the real PostgreSQL schema (`payment_attempts`, `payment_links`, `flows`,
//! `credential_sets`, `outbox_events`, ...), on the `pg-egress` HTTP executor and on the
//! `pg-ledger` poster.
//!
//! | Adapter | Trait | TypeScript source |
//! | :--- | :--- | :--- |
//! | [`store::PgFlowStore`] | [`FlowStore`](crate::ports::FlowStore) | `runtime/attemptRepository.ts`, `checkout.ts` (`claimAttemptForConfirm`, `cancelAttemptAtomically`) |
//! | [`provider::PgFlowProvider`] | [`FlowProvider`](crate::ports::FlowProvider) | `runtime/flowProvider.ts` |
//! | [`slots::PgSlotStore`] | [`SlotStore`](crate::ports::SlotStore) | `runtime/slotStore.ts` |
//! | [`egress::PgEgressAdapter`] / [`egress::BoundEgress`] | [`EgressPort`](crate::ports::EgressPort), [`CredentialResolver`](crate::ports::CredentialResolver) | `apiConsumer/ApiConsumer.ts`, `runtime/platform.ts` (`loadConsumerConfig`) |
//! | [`ledger::PgLedgerAdapter`] | [`LedgerPort`](crate::ports::LedgerPort) | `ledger/LedgerPoster.ts` |
//! | [`vault::PgVaultAdapter`] | [`VaultPort`](crate::ports::VaultPort) | `runtime/contextCipher.ts` |
//! | [`sinks::PgCaseSink`] | [`CaseSink`](crate::ports::CaseSink) | `compliance/OperatorCaseSink.ts` |
//!
//! ## Threading and transactions
//!
//! The port traits are `&self` and carry no transaction object, so each adapter holds a
//! [`sqlx::PgPool`]. Every write helper also has an explicit `*_on(&mut PgConnection, ...)` form:
//! a caller that already owns a transaction (the checkout confirm path, a worker) calls that form
//! directly and the write joins its transaction. The trait implementation opens a short
//! single-writer transaction around the same statements.
//!
//! ## Deliberate scoping
//!
//! - `ReportEngine`/reporting evaluation and the inbound callback verifier need either a large
//!   service (the reporting compiler) or channel-specific crypto; they are left to the core wiring
//!   and are not implemented here (see the README section).
//! - `FlowStore::load_cursor` / `save_cursor` have no TypeScript table. The Rust engine added the
//!   cursor port, so the adapter persists it in the existing `worker_cursors` key/value table under a
//!   `flow-cursor:` prefix (a schema migration was out of scope).
//! - Money is [`rust_decimal::Decimal`] everywhere; the wire types (`JsNumber`, `JsDate`) are not
//!   used by this engine surface, which reads/writes Prisma `numeric` and `timestamp` columns.

#![forbid(unsafe_code)]

pub mod egress;
pub mod ledger;
pub mod provider;
pub mod sinks;
pub mod slots;
pub mod store;
pub mod vault;

use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

pub use egress::{BoundEgress, EgressAdapterConfig, PgCredentialResolver, PgEgressAdapter};
pub use ledger::{PgLedgerAdapter, ScenarioTemplate};
pub use provider::PgFlowProvider;
pub use sinks::{PgCaseSink, PgTransitionSink};
pub use slots::PgSlotStore;
pub use store::{PgFlowStore, FLOW_CURSOR_PREFIX};
pub use vault::PgVaultAdapter;

/// A PostgreSQL read of a Prisma `timestamp without time zone`.
///
/// Prisma stores `DateTime` as `timestamp(3)` in UTC; the port's public records use
/// `DateTime<Utc>`, so the adapter converts at the boundary.
#[must_use]
pub(crate) fn utc(naive: NaiveDateTime) -> DateTime<Utc> {
    DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc)
}

/// The inverse of [`utc`] for a bind against a `timestamp` column.
#[must_use]
pub(crate) fn naive(instant: DateTime<Utc>) -> NaiveDateTime {
    instant.naive_utc()
}

/// Parses a Prisma UUID text column; a malformed id is a data defect, never a silent `nil`.
pub(crate) fn parse_uuid(value: &str, label: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|error| format!("{label} '{value}' is not a UUID: {error}"))
}

/// A JSON object read from a nullable `jsonb` column.
#[must_use]
pub(crate) fn json_object(value: Option<Value>) -> serde_json::Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}
