//! The narrow Redis command surface used by the contracts.
//!
//! Port of the client calls in
//! `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts` and
//! `core-back/lib/auth/sharedState.ts`. The trait exists so the contract values can be exercised
//! without a Redis server; the real connection (connection manager, reconnect, timeouts) belongs
//! to the binary that owns the socket.

#![forbid(unsafe_code)]

/// A Redis reply reduced to the shapes the TS client reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedisReply {
    Nil,
    Status(String),
    Integer(i64),
    Bulk(Option<String>),
    Array(Vec<RedisReply>),
}

impl RedisReply {
    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Integer(value) => Some(*value),
            Self::Bulk(Some(text)) => text.parse().ok(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Bulk(Some(text)) | Self::Status(text) => Some(text),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_array(&self) -> Option<&[RedisReply]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    #[must_use]
    pub fn is_nil(&self) -> bool {
        matches!(self, Self::Nil | Self::Bulk(None))
    }
}

/// The commands the cache, velocity, throttle and revocation paths issue.
///
/// `async fn` in a trait is deliberate: ntex handlers are single-threaded per worker, so the
/// future does not need to be boxed or `Send`, and no `async-trait` dependency is required.
#[allow(async_fn_in_trait)]
pub trait RedisCommands {
    type Error: std::error::Error + Send + Sync + 'static;

    /// `GET key` (`nil` when absent).
    async fn get(&mut self, key: &str) -> Result<Option<String>, Self::Error>;

    /// `SET key value EX ttl`; the cache clamps the TTL to at least one second.
    async fn set_ex(&mut self, key: &str, value: &str, ttl_seconds: u64)
        -> Result<(), Self::Error>;

    /// `SET key value PX ttl`: value and expiry are written atomically (revoke flags, locks).
    async fn set_px(&mut self, key: &str, value: &str, ttl_ms: u64) -> Result<(), Self::Error>;

    /// `DEL <keys...>`; an empty slice is a no-op.
    async fn del(&mut self, keys: &[String]) -> Result<(), Self::Error>;

    /// `PTTL key`: remaining milliseconds, `-2` when absent and `-1` when it has no expiry.
    async fn pttl(&mut self, key: &str) -> Result<i64, Self::Error>;

    /// `KEYS <pattern>` used by the prefix invalidation (bounded deployments, parity with TS).
    async fn keys(&mut self, pattern: &str) -> Result<Vec<String>, Self::Error>;

    /// `PUBLISH <channel> <message>`.
    async fn publish(&mut self, channel: &str, message: &str) -> Result<(), Self::Error>;

    /// `SCRIPT LOAD <script>`, returning the SHA-1 handle.
    async fn script_load(&mut self, script: &str) -> Result<String, Self::Error>;

    /// `EVAL <script> <keys...> <args...>`.
    async fn eval(
        &mut self,
        script: &str,
        keys: &[String],
        args: &[String],
    ) -> Result<RedisReply, Self::Error>;

    /// `EVALSHA <sha> <keys...> <args...>`.
    async fn eval_sha(
        &mut self,
        sha: &str,
        keys: &[String],
        args: &[String],
    ) -> Result<RedisReply, Self::Error>;
}

/// `EVALSHA` first, `EVAL` when the cached script is missing (or any command fails, matching the
/// TS `catch` that re-runs the script). The caller may pass `None` when no SHA is cached yet.
pub async fn eval_with_fallback<C: RedisCommands>(
    client: &mut C,
    script: &str,
    cached_sha: Option<&str>,
    keys: &[String],
    args: &[String],
) -> Result<RedisReply, C::Error> {
    let cached = match cached_sha {
        Some(sha) => client.eval_sha(sha, keys, args).await.ok(),
        None => None,
    };
    if let Some(reply) = cached {
        return Ok(reply);
    }
    client.eval(script, keys, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Debug, thiserror::Error)]
    #[error("fake redis failure")]
    struct FakeError;

    #[derive(Debug, Default)]
    struct FakeRedis {
        values: HashMap<String, String>,
        loaded_sha: Option<String>,
        sha_calls: usize,
    }

    impl RedisCommands for FakeRedis {
        type Error = FakeError;

        async fn get(&mut self, key: &str) -> Result<Option<String>, Self::Error> {
            Ok(self.values.get(key).cloned())
        }

        async fn set_ex(
            &mut self,
            key: &str,
            value: &str,
            _ttl_seconds: u64,
        ) -> Result<(), Self::Error> {
            self.values.insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        async fn set_px(
            &mut self,
            key: &str,
            value: &str,
            _ttl_ms: u64,
        ) -> Result<(), Self::Error> {
            self.values.insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        async fn del(&mut self, keys: &[String]) -> Result<(), Self::Error> {
            for key in keys {
                self.values.remove(key);
            }
            Ok(())
        }

        async fn pttl(&mut self, _key: &str) -> Result<i64, Self::Error> {
            Ok(42)
        }

        async fn keys(&mut self, _pattern: &str) -> Result<Vec<String>, Self::Error> {
            Ok(self.values.keys().cloned().collect())
        }

        async fn publish(&mut self, _channel: &str, _message: &str) -> Result<(), Self::Error> {
            Ok(())
        }

        async fn script_load(&mut self, _script: &str) -> Result<String, Self::Error> {
            self.loaded_sha = Some("sha".to_owned());
            Ok("sha".to_owned())
        }

        async fn eval(
            &mut self,
            _script: &str,
            _keys: &[String],
            _args: &[String],
        ) -> Result<RedisReply, Self::Error> {
            Ok(RedisReply::Integer(7))
        }

        async fn eval_sha(
            &mut self,
            sha: &str,
            _keys: &[String],
            _args: &[String],
        ) -> Result<RedisReply, Self::Error> {
            self.sha_calls += 1;
            if sha == "sha" {
                Ok(RedisReply::Integer(9))
            } else {
                Err(FakeError)
            }
        }
    }

    #[tokio::test]
    async fn cached_sha_is_used_when_it_works() {
        let mut client = FakeRedis::default();
        let reply = eval_with_fallback(&mut client, "script", Some("sha"), &[], &[])
            .await
            .expect("reply");
        assert_eq!(reply, RedisReply::Integer(9));
        assert_eq!(client.sha_calls, 1);
    }

    #[tokio::test]
    async fn a_failed_sha_falls_back_to_eval() {
        let mut client = FakeRedis::default();
        let reply = eval_with_fallback(&mut client, "script", Some("missing"), &[], &[])
            .await
            .expect("reply");
        assert_eq!(reply, RedisReply::Integer(7));
        assert_eq!(client.sha_calls, 1);
    }

    #[test]
    fn reply_accessors() {
        assert_eq!(RedisReply::Integer(3).as_i64(), Some(3));
        assert_eq!(RedisReply::Bulk(Some("12".to_owned())).as_i64(), Some(12));
        assert_eq!(RedisReply::Bulk(Some("x".to_owned())).as_str(), Some("x"));
        assert!(RedisReply::Bulk(None).is_nil());
        assert_eq!(
            RedisReply::Array(vec![RedisReply::Integer(1)])
                .as_array()
                .map(<[RedisReply]>::len),
            Some(1)
        );
    }
}
