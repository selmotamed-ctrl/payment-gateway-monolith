//! Redis contracts: endpoint resolution, key builders, the invalidation/realtime bus envelopes,
//! the velocity Lua script, auth throttles and the session revoke list.
//!
//! Port of:
//! - `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts`
//! - `core-back/lib/auth/sharedState.ts`
//! - `core-back/lib/auth/throttle.ts`
//! - `core-back/lib/auth/revocation.ts`
//! - `core-back/lib/invalidationBus/index.ts`
//! - `core-back/lib/realtimeBus.ts`
//!
//! This crate never opens a connection. Redis access is expressed through [`RedisCommands`] so the
//! wire values, key names and failure decisions can be tested without a server; the real client
//! adapter belongs to a binary (chapter 3 §3 keeps I/O out of the contract crates). `redis` stays a
//! declared dependency for that adapter.
//!
//! Rust and the TypeScript services must interoperate on the same Redis while both run, so every
//! key, channel and JSON field here is byte-compatible with the TS sources above.

#![forbid(unsafe_code)]

pub mod auth_state;
pub mod cache;
pub mod commands;
pub mod endpoint;
pub mod invalidation;
pub mod keys;
pub mod realtime;
pub mod revocation;
pub mod sha256;
pub mod timestamp;
pub mod velocity;

pub use auth_state::{
    pair_value, retry_after_seconds, MemoryAuthState, ThrottlePolicy, INCR_WINDOW_LUA,
    LOGIN_IDENTIFIER_POLICY, LOGIN_IP_POLICY, LOGIN_PAIR_POLICY, MEMORY_MAX_ENTRIES, MFA_IP_POLICY,
    SCOPE_LOGIN_ID, SCOPE_LOGIN_IP, SCOPE_LOGIN_PAIR, SCOPE_MFA_IP, THROTTLE_WINDOW_MS,
};
pub use cache::{
    l1_ttl_ms, normalize_ttl_seconds, CACHE_L1_TTL_SECONDS, SETTINGS_CACHE_TTL,
    SETTINGS_CACHE_TTL_MS,
};
pub use commands::{eval_with_fallback, RedisCommands, RedisReply};
pub use endpoint::{RedisEndpoint, RedisEndpointError};
pub use invalidation::{
    configuration_topic, credential_topic, gateway_topic, is_wildcard_topic, parse_envelope,
    topic_matches_pattern, InvalidationEnvelope, LruDedupe, CREDENTIAL_TOPIC_PATTERN,
    DEFAULT_DEDUPE_CAPACITY, GATEWAY_TOPIC_PATTERN, NAMESPACE, REALTIME_TOPIC_PATTERN,
};
pub use keys::{
    auth_count_key, auth_digest, auth_key, auth_lock_key, cache_key, invalidation_channel,
    revocation_key, velocity_key, KeyError, AUTH_PREFIX, CACHE_PREFIX, INVALIDATION_CHANNEL_PREFIX,
    REVOCATION_PREFIX, VELOCITY_PREFIX,
};
pub use realtime::{
    bridge_topic, AttemptTransitionEvent, RealtimeAttemptEvent, RealtimeEnvelope, RealtimePosEvent,
    ATTEMPT_TRANSITION_TOPIC, REALTIME_ATTEMPT_TOPIC, REALTIME_POS_TOPIC,
};
pub use revocation::{
    decide, should_prune, ttl_ms_for, RevocationDecision, RevocationEntry, MIN_REVOCATION_TTL_MS,
    PRUNE_ONE_IN,
};
pub use timestamp::{iso_from_millis, iso_now};
pub use velocity::{
    VelocityDegrade, VelocityDescriptor, VelocityEvaluation, VelocityFailurePolicy, VelocityMember,
    VelocityScriptOutcome, VelocitySequence, VelocityUnavailableError, VELOCITY_COMMAND_TIMEOUT_MS,
    VELOCITY_FAILURE_POLICIES, VELOCITY_FAILURE_POLICY_ENV, VELOCITY_LUA_SCRIPT,
};
