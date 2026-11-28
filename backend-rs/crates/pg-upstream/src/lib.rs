//! Edge → core upstream pool, path confinement and request-header hygiene.
//!
//! Port of `{admin,merchant,checkout}-back/lib/coreInternalClient.ts`,
//! `{admin,merchant,checkout}-back/lib/corePools.ts`,
//! `{admin,merchant,checkout}-back/lib/mtlsClient/index.ts`,
//! `admin-back/api/forward.ts` and chapter 2 §10 of the Rust port plan.
//!
//! The crate deliberately performs no I/O: it owns the rules that are identical in all three TS
//! edges (node selection, passive health, retry classification, path confinement, header
//! construction and pool configuration) plus [`AttemptLoop`], the state machine an HTTP executor
//! drives. Every rule is covered by an in-file test without opening a socket.
//!
//! ## Examples
//!
//! ```
//! use pg_upstream::{assert_core_path, EdgeChannel, HealthPolicy, UpstreamPool, Exclusions, now_millis};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! assert_core_path(EdgeChannel::Admin, "/internal/admin/merchants")?;
//! let pool = UpstreamPool::new(vec!["https://core-a:4000".to_owned()], HealthPolicy::default());
//! let node = pool.select(&Exclusions::new(), now_millis()).expect("one node");
//! assert_eq!(node.url(), "https://core-a:4000");
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]

pub mod attempt;
pub mod config;
pub mod consistency;
pub mod error;
pub mod headers;
pub mod limits;
pub mod node;
pub mod path;
pub mod pool;
pub mod retry;

pub use attempt::{AttemptDecision, AttemptLoop, LoopFinish};
pub use config::{
    parse_core_back_urls, sandbox_headers, CorePoolConfig, Plane, PoolConfigError,
    SANDBOX_LINK_PREFIX, SANDBOX_TOKEN_PREFIX,
};
pub use consistency::{min_lsn_header, valid_min_lsn, ReadConsistency};
pub use error::{PoolError, TransportFailure};
pub use headers::{
    build_core_headers, prepare_request_headers, relay_from_header_map, relay_headers,
    sanitize_user_agent, valid_header_name, valid_header_value, valid_idempotency_key,
    CoreRequestMeta, HeaderSet, HOP_BY_HOP_HEADERS, RELAYED_RESPONSE_HEADERS,
};
pub use limits::Limits;
pub use node::{HealthPolicy, UpstreamNode};
pub use path::{assert_core_path, resolve_core_url, EdgeChannel, QueryValue};
pub use pool::{has_selectable, now_millis, select_node, Exclusions, UpstreamPool};
pub use retry::{CoreMethod, RetryOptions, RetryPolicy};
