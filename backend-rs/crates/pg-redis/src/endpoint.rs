//! Redis endpoint resolution.
//!
//! Port of `core-back/lib/storageEngine/index.ts:84-90` and `core-back/index.ts:249`:
//! `REDIS_URL` wins; otherwise the first non-empty `REDIS_NODES` entry is prefixed with
//! `redis://`. An absent endpoint means "no Redis" (the TS services fall back to memory or skip
//! the transport), which is an error only when the caller requires Redis.

#![forbid(unsafe_code)]

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RedisEndpointError {
    /// `REDIS_URL` was absent/blank and `REDIS_NODES` had no entry.
    #[error("REDIS_URL and REDIS_NODES are both empty")]
    MissingEndpoint,
}

/// The resolved Redis URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedisEndpoint;

impl RedisEndpoint {
    /// Resolve `REDIS_URL` else the first entry of `REDIS_NODES`.
    ///
    /// Port of the TS expression
    /// `env.REDIS_URL ?? (firstRedisNode ? \`redis://${firstRedisNode}\` : null)`.
    /// A blank `REDIS_URL` is treated as absent (the TS zod schema rejects an empty URL at boot,
    /// so this only differs for a hand-built environment).
    pub fn resolve(
        redis_url: Option<&str>,
        redis_nodes: Option<&str>,
    ) -> Result<String, RedisEndpointError> {
        if let Some(url) = redis_url.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(url.to_owned());
        }

        if let Some(node) = redis_nodes
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .find(|node| !node.is_empty())
        {
            return Ok(format!("redis://{node}"));
        }

        Err(RedisEndpointError::MissingEndpoint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_wins_over_nodes() {
        let resolved = RedisEndpoint::resolve(Some("redis://cache:6379"), Some("10.0.0.1:6390"));
        assert_eq!(resolved, Ok("redis://cache:6379".to_owned()));
    }

    #[test]
    fn first_node_is_prefixed_and_trimmed() {
        let resolved = RedisEndpoint::resolve(None, Some(" 10.0.0.1:6390 , 10.0.0.2:6390"));
        assert_eq!(resolved, Ok("redis://10.0.0.1:6390".to_owned()));
    }

    #[test]
    fn blank_entries_are_skipped() {
        let resolved = RedisEndpoint::resolve(None, Some(" , ,10.0.0.9:6379"));
        assert_eq!(resolved, Ok("redis://10.0.0.9:6379".to_owned()));
    }

    #[test]
    fn blank_url_falls_back_to_nodes() {
        let resolved = RedisEndpoint::resolve(Some("   "), Some("cache:6379"));
        assert_eq!(resolved, Ok("redis://cache:6379".to_owned()));
    }

    #[test]
    fn missing_endpoint_is_an_error() {
        assert_eq!(
            RedisEndpoint::resolve(None, None),
            Err(RedisEndpointError::MissingEndpoint)
        );
        assert_eq!(
            RedisEndpoint::resolve(Some(""), Some(" , ")),
            Err(RedisEndpointError::MissingEndpoint)
        );
    }
}
