//! `core-rs` library: the P3 core shell (pools, auth double check, HTTP pipeline, list queries).
//!
//! The binary (`src/main.rs`) is a thin CLI around [`app::dispatch`] and [`state::AppState`];
//! everything testable lives here so integration tests can drive the same code the server runs.
//!
//! Port map:
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`config`] | `core-back/lib/env/index.ts`, `engine/workers/productionRuntime.ts` |
//! | [`state`] | `core-back/index.ts:294-390`, `lib/storageEngine/index.ts` |
//! | [`auth`] | `core-back/api/middleware/authDoubleCheck.ts`, `lib/auth/revocation.ts`, `mtlsGuard.ts` |
//! | [`http`] | `core-back/index.ts:40-191`, `lib/error/index.ts`, `lib/rawBody/index.ts` |
//! | [`logging`] | `core-back/lib/requestLogger/index.ts` |
//! | [`health`] | `core-back/index.ts:111-153` and the channel health handlers |
//! | [`routes`] | `core-back/api/index.ts` router mounts and every route policy |
//!
//! Not ported in P3 (see `bins/core-rs/README.md`): domain routes, workers, the Sandbox user
//! mirror, the communication bootstrap, the plane-fence boot check and the report chrome
//! reconciliation.

#![forbid(unsafe_code)]
#![recursion_limit = "512"]
// The error that crosses the HTTP boundary is `pg_http::ApiError` (the wire envelope with its
// `code`/`message`/`details` strings). Boxing it at every handler would obscure the call sites for
// no runtime benefit: a request produces at most one error and the value is moved into the
// response.
#![allow(clippy::result_large_err)]

pub mod app;
pub mod auth;
pub mod config;
pub mod health;
pub mod http;
pub mod logging;
pub mod routes;
pub mod state;
pub mod workers;
