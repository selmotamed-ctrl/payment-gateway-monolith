//! `checkout-edge` — the Rust port of `checkout-back`.
//!
//! The library is the whole edge: configuration, route table, request validation, inbound
//! translation, the mTLS core client, the ntex HTTP adapter and the integration-test harness
//! ([`server::init_test_pipeline`]).

#![forbid(unsafe_code)]
#![allow(clippy::result_large_err)] // the edge envelope is status+code+message+details by design

pub mod body;
pub mod config;
pub mod core;
pub mod error;
pub mod inbound;
pub mod logging;
pub mod monetary;
pub mod routes;
pub mod server;
pub mod service;
pub mod validation;

pub use config::CheckoutConfig;
pub use error::EdgeFailure;
pub use service::EdgeService;
