//! Merchant edge (`merchant-back`) — Rust/ntex port.
//!
//! Phase P2-T04. The library exposes the dispatcher, the route table, the canonical contract
//! translation and the core transport so the ported `merchant-back/test/**` suites can run without
//! PostgreSQL/Redis (a fake core implements [`upstream::CoreTransport`]).
//!
//! Deviations from the TypeScript service are listed in `bins/merchant-edge/README.md`.

#![forbid(unsafe_code)]
// The error envelope (`code`/`message`/`details`/`reference`) is intentionally a small owned
// struct; boxing every `Result` would obscure the request handlers for a 152-byte value.
#![allow(clippy::result_large_err)]
#![warn(missing_debug_implementations)]

pub mod app;
pub mod config;
pub mod contract;
pub mod error;
pub mod forward;
pub mod handlers;
pub mod http;
pub mod limits;
pub mod multipart;
pub mod routes;
pub mod schemas;
pub mod server;
pub mod upstream;
pub mod validate;
