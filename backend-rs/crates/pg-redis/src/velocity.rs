//! Velocity counters: the Lua script, sorted-set member format, failure policy and decision rules.
//!
//! Port of `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts:11-97,195-232,352-447`.
//!
//! Key `pgcache:vel:<ruleId>:<scopeKey>:<windowSeconds>`, ZSET score = `nowMs`, member
//! `<amountMinor>:<nowMs>:<seq>`. `VELOCITY_LUA_SCRIPT` is copied byte-for-byte from the TS
//! source; the digest test below fails if a single byte changes, because the TypeScript and Rust
//! services share the same Redis instance during the migration.
//!
//! Failure policy (`REDIS_VELOCITY_FAILURE_POLICY`):
//! - `local-fallback` (default): count the remaining descriptors in this node's memory and carry
//!   on degraded; limits still apply but per node and are lost on restart.
//! - `fail-open`: allow without counting.
//! - `fail-closed`: throw [`VelocityUnavailableError`] so the caller refuses the attempt.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use thiserror::Error;

use crate::commands::RedisReply;
use crate::keys::velocity_key;

/// Environment key read outside the zod schema (`core-back/lib/env/index.ts`, chapter 2 §21).
pub const VELOCITY_FAILURE_POLICY_ENV: &str = "REDIS_VELOCITY_FAILURE_POLICY";

/// Per-command budget for the velocity script so a hung Redis cannot stall payments.
pub const VELOCITY_COMMAND_TIMEOUT_MS: u64 = 250;

/// Byte-for-byte copy of `VELOCITY_LUA_SCRIPT` (781 bytes including the leading and trailing
/// newline of the TS template literal).
///
/// `KEYS[1]` is the velocity key, `ARGV` is
/// `[nowMs, windowMs, amountMinor, maxCount, maxAmount(-1 = none), member]`, and the reply is
/// `{count, sum, countViolation, amountViolation}`.
pub const VELOCITY_LUA_SCRIPT: &str = r"
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])
local maxCount = tonumber(ARGV[4])
local maxAmount = tonumber(ARGV[5])
local member = ARGV[6]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
redis.call('ZADD', key, now, member)
local entries = redis.call('ZRANGE', key, 0, -1)
local count = #entries
local sum = 0
for i = 1, #entries do
  local parsed = string.match(entries[i], '^(%-?%d+):')
  if parsed then sum = sum + tonumber(parsed) end
end
redis.call('PEXPIRE', key, windowMs)
local countViolation = 1
if count <= maxCount then countViolation = 0 end
local amountViolation = 0
if maxAmount >= 0 and sum > maxAmount then amountViolation = 1 end
return {count, sum, countViolation, amountViolation}
";

/// `ZSET` member `<amountMinor>:<nowMs>:<seq>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VelocityMember {
    pub amount_minor: i128,
    pub now_ms: i64,
    pub sequence: u64,
}

impl VelocityMember {
    #[must_use]
    pub fn new(amount_minor: i128, now_ms: i64, sequence: u64) -> Self {
        Self {
            amount_minor,
            now_ms,
            sequence,
        }
    }

    /// The exact string appended to the sorted set.
    #[must_use]
    pub fn format(&self) -> String {
        format!("{}:{}:{}", self.amount_minor, self.now_ms, self.sequence)
    }

    /// Parse a member; `None` when any of the three parts is missing or not a number.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let mut parts = raw.splitn(3, ':');
        let amount_minor = parts.next()?.parse::<i128>().ok()?;
        let now_ms = parts.next()?.parse::<i64>().ok()?;
        let sequence = parts.next()?.parse::<u64>().ok()?;
        Some(Self {
            amount_minor,
            now_ms,
            sequence,
        })
    }
}

impl fmt::Display for VelocityMember {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.format())
    }
}

/// Monotonic per-process sequence used to keep two members in the same millisecond distinct.
#[derive(Debug, Default)]
pub struct VelocitySequence(AtomicU64);

impl VelocitySequence {
    /// The counter starts at 0 and increments after each use, like `this.sequence++`.
    pub fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::Relaxed)
    }
}

/// `VelocityFailurePolicy` from the adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VelocityFailurePolicy {
    #[default]
    LocalFallback,
    FailOpen,
    FailClosed,
}

/// Every accepted value, used by the parser and by configuration tests.
pub const VELOCITY_FAILURE_POLICIES: [VelocityFailurePolicy; 3] = [
    VelocityFailurePolicy::LocalFallback,
    VelocityFailurePolicy::FailOpen,
    VelocityFailurePolicy::FailClosed,
];

impl VelocityFailurePolicy {
    /// Port of `parseVelocityFailurePolicy`: trim, lowercase, unknown/blank → `local-fallback`.
    #[must_use]
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
            "fail-open" => Self::FailOpen,
            "fail-closed" => Self::FailClosed,
            _ => Self::LocalFallback,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalFallback => "local-fallback",
            Self::FailOpen => "fail-open",
            Self::FailClosed => "fail-closed",
        }
    }

    /// What to do when the store failed after `remaining` descriptors were not applied.
    ///
    /// Descriptors already applied in Redis are not re-counted locally, exactly like the TS
    /// `applied` offset.
    #[must_use]
    pub fn on_store_failure(self, remaining_descriptors: usize) -> VelocityDegrade {
        match self {
            Self::FailClosed => VelocityDegrade::FailClosed,
            Self::LocalFallback if remaining_descriptors > 0 => VelocityDegrade::LocalFallback,
            Self::LocalFallback | Self::FailOpen => VelocityDegrade::AllowWithoutCounting,
        }
    }
}

/// The outcome of [`VelocityFailurePolicy::on_store_failure`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VelocityDegrade {
    /// Throw [`VelocityUnavailableError`] (caller refuses the attempt).
    FailClosed,
    /// Count the remaining descriptors in local memory and return a degraded evaluation.
    LocalFallback,
    /// Return an empty (allowed) evaluation without counting.
    AllowWithoutCounting,
}

/// Port of `VelocityUnavailableError`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Velocity store unavailable (fail-closed policy): {message}")]
pub struct VelocityUnavailableError {
    pub message: String,
}

impl VelocityUnavailableError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// One rule to evaluate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VelocityDescriptor {
    pub rule_id: String,
    pub scope_key: String,
    pub window_seconds: u64,
    /// `maxCount`; the Lua flags a violation when `count > maxCount`.
    pub max_count: i64,
    /// `maxAmountMinor`; `None` is sent as `-1` and disables the amount check.
    pub max_amount_minor: Option<i128>,
}

impl VelocityDescriptor {
    #[must_use]
    pub fn new(
        rule_id: impl Into<String>,
        scope_key: impl Into<String>,
        window_seconds: u64,
        max_count: i64,
        max_amount_minor: Option<i128>,
    ) -> Self {
        Self {
            rule_id: rule_id.into(),
            scope_key: scope_key.into(),
            window_seconds,
            max_count,
            max_amount_minor,
        }
    }

    #[must_use]
    pub fn key(&self) -> String {
        velocity_key(&self.rule_id, &self.scope_key, self.window_seconds)
    }

    #[must_use]
    pub fn window_ms(&self) -> u64 {
        self.window_seconds.saturating_mul(1_000)
    }

    /// The exact `ARGV` list of one `EVALSHA` call.
    #[must_use]
    pub fn arguments(&self, member: &VelocityMember) -> Vec<String> {
        vec![
            member.now_ms.to_string(),
            self.window_ms().to_string(),
            member.amount_minor.to_string(),
            self.max_count.to_string(),
            self.max_amount_minor
                .map_or_else(|| "-1".to_owned(), |value| value.to_string()),
            member.format(),
        ]
    }
}

/// The four values the Lua script returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VelocityScriptOutcome {
    pub count: i64,
    pub amount_minor: i128,
    pub count_violation: bool,
    pub amount_violation: bool,
}

impl VelocityScriptOutcome {
    #[must_use]
    pub fn new(
        count: i64,
        amount_minor: i128,
        count_violation: bool,
        amount_violation: bool,
    ) -> Self {
        Self {
            count,
            amount_minor,
            count_violation,
            amount_violation,
        }
    }

    /// Decode `{count, sum, countViolation, amountViolation}`. Redis integer replies are the
    /// normal shape; bulk strings are accepted because `redis.call` coerces depending on the
    /// client decoder.
    #[must_use]
    pub fn from_reply(reply: &RedisReply) -> Option<Self> {
        let items = reply.as_array()?;
        if items.len() < 4 {
            return None;
        }
        Some(Self {
            count: reply_i64(&items[0])?,
            amount_minor: reply_i128(&items[1])?,
            count_violation: reply_i64(&items[2])? == 1,
            amount_violation: reply_i64(&items[3])? == 1,
        })
    }

    #[must_use]
    pub fn is_violation(self) -> bool {
        self.count_violation || self.amount_violation
    }
}

fn reply_i64(reply: &RedisReply) -> Option<i64> {
    reply.as_i64()
}

fn reply_i128(reply: &RedisReply) -> Option<i128> {
    match reply {
        RedisReply::Integer(value) => Some(i128::from(*value)),
        RedisReply::Bulk(Some(text)) => text.parse().ok(),
        RedisReply::Nil | RedisReply::Bulk(None) => Some(0),
        _ => None,
    }
}

/// One window's statistics, matching `windowStats[ruleId]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VelocityWindowStat {
    pub count: i64,
    pub amount_minor: i128,
}

/// Port of `VelocityEvaluationResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VelocityEvaluation {
    pub allowed: bool,
    pub violated_rule_ids: Vec<String>,
    pub flagged_rule_ids: Vec<String>,
    pub window_stats: BTreeMap<String, VelocityWindowStat>,
    pub degraded: bool,
}

impl Default for VelocityEvaluation {
    fn default() -> Self {
        Self {
            allowed: true,
            violated_rule_ids: Vec::new(),
            flagged_rule_ids: Vec::new(),
            window_stats: BTreeMap::new(),
            degraded: false,
        }
    }
}

impl VelocityEvaluation {
    /// `allowed` is true only when neither list has an entry, exactly like the TS return.
    #[must_use]
    pub fn from_parts(
        violated_rule_ids: Vec<String>,
        flagged_rule_ids: Vec<String>,
        window_stats: BTreeMap<String, VelocityWindowStat>,
        degraded: bool,
    ) -> Self {
        let allowed = violated_rule_ids.is_empty() && flagged_rule_ids.is_empty();
        Self {
            allowed,
            violated_rule_ids,
            flagged_rule_ids,
            window_stats,
            degraded,
        }
    }

    #[must_use]
    pub fn allowed_without_counting() -> Self {
        Self::default()
    }

    pub fn record(&mut self, rule_id: &str, outcome: VelocityScriptOutcome) {
        self.window_stats.insert(
            rule_id.to_owned(),
            VelocityWindowStat {
                count: outcome.count,
                amount_minor: outcome.amount_minor,
            },
        );
        if outcome.count_violation {
            self.violated_rule_ids.push(rule_id.to_owned());
        }
        if outcome.amount_violation {
            self.flagged_rule_ids.push(rule_id.to_owned());
        }
        self.allowed = self.violated_rule_ids.is_empty() && self.flagged_rule_ids.is_empty();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sha256::sha256_hex;

    #[test]
    fn lua_script_is_byte_identical_to_the_typescript_source() {
        // sha256 of the exact TS template literal content (781 bytes).
        assert_eq!(
            sha256_hex(VELOCITY_LUA_SCRIPT.as_bytes()),
            "9937299cd0bb71d7605e67cb932a5771f12518b0180ee430d5b467614d47ca30"
        );
        assert_eq!(VELOCITY_LUA_SCRIPT.len(), 781);
        assert!(VELOCITY_LUA_SCRIPT.starts_with('\n'));
        assert!(VELOCITY_LUA_SCRIPT.ends_with('\n'));
        assert!(VELOCITY_LUA_SCRIPT.contains("local key = KEYS[1]"));
        assert!(
            VELOCITY_LUA_SCRIPT.contains("return {count, sum, countViolation, amountViolation}")
        );
    }

    #[test]
    fn member_format_and_parse() {
        let member = VelocityMember::new(1_500, 1_700_000_000_123, 7);
        assert_eq!(member.format(), "1500:1700000000123:7");
        assert_eq!(member.to_string(), member.format());
        assert_eq!(VelocityMember::parse("1500:1700000000123:7"), Some(member));
        assert_eq!(
            VelocityMember::parse("-250:1:0"),
            Some(VelocityMember::new(-250, 1, 0))
        );
        assert_eq!(VelocityMember::parse("1500:1700000000123"), None);
        assert_eq!(VelocityMember::parse("x:1:2"), None);
        assert_eq!(VelocityMember::parse("1:2:x"), None);
        assert_eq!(VelocityMember::parse(""), None);
    }

    #[test]
    fn sequence_starts_at_zero_and_increments() {
        let sequence = VelocitySequence::default();
        assert_eq!(sequence.next(), 0);
        assert_eq!(sequence.next(), 1);
        assert_eq!(sequence.next(), 2);
    }

    #[test]
    fn policy_parsing_and_defaults() {
        assert_eq!(
            VelocityFailurePolicy::default(),
            VelocityFailurePolicy::LocalFallback
        );
        assert_eq!(
            VelocityFailurePolicy::parse(Some(" FAIL-OPEN ")),
            VelocityFailurePolicy::FailOpen
        );
        assert_eq!(
            VelocityFailurePolicy::parse(Some("fail-closed")),
            VelocityFailurePolicy::FailClosed
        );
        assert_eq!(
            VelocityFailurePolicy::parse(Some("local-fallback")),
            VelocityFailurePolicy::LocalFallback
        );
        assert_eq!(
            VelocityFailurePolicy::parse(Some("nonsense")),
            VelocityFailurePolicy::LocalFallback
        );
        assert_eq!(
            VelocityFailurePolicy::parse(None),
            VelocityFailurePolicy::LocalFallback
        );
        assert_eq!(VELOCITY_FAILURE_POLICIES.len(), 3);
        assert_eq!(VelocityFailurePolicy::FailOpen.as_str(), "fail-open");
    }

    #[test]
    fn failure_decisions() {
        assert_eq!(
            VelocityFailurePolicy::FailClosed.on_store_failure(3),
            VelocityDegrade::FailClosed
        );
        assert_eq!(
            VelocityFailurePolicy::FailClosed.on_store_failure(0),
            VelocityDegrade::FailClosed
        );
        assert_eq!(
            VelocityFailurePolicy::LocalFallback.on_store_failure(3),
            VelocityDegrade::LocalFallback
        );
        assert_eq!(
            VelocityFailurePolicy::LocalFallback.on_store_failure(0),
            VelocityDegrade::AllowWithoutCounting
        );
        assert_eq!(
            VelocityFailurePolicy::FailOpen.on_store_failure(3),
            VelocityDegrade::AllowWithoutCounting
        );
    }

    #[test]
    fn descriptor_arguments_match_the_script_contract() {
        let descriptor =
            VelocityDescriptor::new("velocity-1", "merchant-7", 3600, 10, Some(50_000));
        assert_eq!(descriptor.key(), "pgcache:vel:velocity-1:merchant-7:3600");
        assert_eq!(
            descriptor.arguments(&VelocityMember::new(2_500, 1_700_000_000_000, 4)),
            vec![
                "1700000000000".to_owned(),
                "3600000".to_owned(),
                "2500".to_owned(),
                "10".to_owned(),
                "50000".to_owned(),
                "2500:1700000000000:4".to_owned(),
            ]
        );
        let unbounded = VelocityDescriptor::new("velocity-2", "merchant-8", 60, 5, None);
        assert_eq!(unbounded.window_ms(), 60_000);
        assert_eq!(unbounded.arguments(&VelocityMember::new(1, 2, 3))[4], "-1");
    }

    #[test]
    fn script_reply_decoding() {
        let reply = RedisReply::Array(vec![
            RedisReply::Integer(3),
            RedisReply::Integer(2_500),
            RedisReply::Integer(0),
            RedisReply::Integer(1),
        ]);
        let outcome = VelocityScriptOutcome::from_reply(&reply).expect("decodes");
        assert_eq!(outcome.count, 3);
        assert_eq!(outcome.amount_minor, 2_500);
        assert!(!outcome.count_violation);
        assert!(outcome.amount_violation);
        assert!(outcome.is_violation());

        let strings = RedisReply::Array(vec![
            RedisReply::Bulk(Some("4".to_owned())),
            RedisReply::Bulk(Some("9000".to_owned())),
            RedisReply::Integer(1),
            RedisReply::Integer(0),
        ]);
        let outcome = VelocityScriptOutcome::from_reply(&strings).expect("decodes");
        assert_eq!(outcome.count, 4);
        assert_eq!(outcome.amount_minor, 9_000);
        assert!(outcome.count_violation);

        assert!(VelocityScriptOutcome::from_reply(&RedisReply::Nil).is_none());
        assert!(VelocityScriptOutcome::from_reply(&RedisReply::Array(vec![])).is_none());
    }

    #[test]
    fn evaluation_starts_allowed_and_flags_rules() {
        let mut evaluation = VelocityEvaluation::default();
        assert!(evaluation.allowed);
        assert!(!evaluation.degraded);

        evaluation.record("rule-1", VelocityScriptOutcome::new(2, 100, false, false));
        assert!(evaluation.allowed);
        assert_eq!(evaluation.window_stats["rule-1"].count, 2);

        evaluation.record("rule-2", VelocityScriptOutcome::new(11, 100, true, false));
        assert!(!evaluation.allowed);
        assert_eq!(evaluation.violated_rule_ids, vec!["rule-2".to_owned()]);
        assert!(VelocityEvaluation::allowed_without_counting().allowed);
    }

    #[test]
    fn unavailable_error_keeps_the_typescript_code_shape() {
        let error = VelocityUnavailableError::new("VELOCITY_TIMEOUT after 250ms");
        assert_eq!(
            error.to_string(),
            "Velocity store unavailable (fail-closed policy): VELOCITY_TIMEOUT after 250ms"
        );
        assert_eq!(VELOCITY_COMMAND_TIMEOUT_MS, 250);
    }
}
