//! `fake-rails-rs` — the standalone Fake Payment Rails emulator (P9-T01).
//!
//! Byte-level contract: `design/14-rust-port/02_contracts_reference.md` §30 and the TypeScript
//! service in `fake-rails-back/`. See the crate README for routes, environment, implemented rails
//! and deviations.

#![forbid(unsafe_code)]
// ApiError carries a code/message/details envelope; boxing it would change every signature of the
// ported TS contract for a micro-optimisation on an exceptional path.
#![allow(clippy::result_large_err)]

pub mod accounts;
pub mod automation;
pub mod chaos;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod events;
pub mod http;
pub mod money;
pub mod portal;
pub mod rails;
pub mod sdk;
pub mod state;
pub mod statements;
pub mod webhook;

pub use config::Config;
pub use error::{ApiError, ApiResult};
pub use state::AppState;

/// Builds the process state from a validated configuration (opens/migrates SQLite and seeds the
/// default scenarios, the five test personas per rail and the clearing pools).
pub fn build_state(config: Config) -> ApiResult<AppState> {
    AppState::new(config)
}
