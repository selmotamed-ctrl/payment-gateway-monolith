//! Invalidation bus envelope, topics, wildcard matching and the 2048-entry de-duplicator.
//!
//! Port of `core-back/lib/invalidationBus/index.ts`.
//!
//! Published message (JSON):
//! `{"id":"<uuid>","namespace":"payment-gateway","topic":"<topic>","payload":{…},"publishedAt":"<iso>"}`.
//! A subscriber ignores a foreign namespace, a message without an id and an id it has already
//! seen (LRU of 2048 ids). Wildcard subscriptions (`credential:*`) use `PSUBSCRIBE`; only a
//! trailing `*` is supported.

#![forbid(unsafe_code)]

use std::collections::{HashSet, VecDeque};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::keys::{invalidation_channel, KeyError};
use crate::timestamp::iso_now;

/// Namespace every message must carry; a foreign namespace is dropped on receipt.
pub const NAMESPACE: &str = "payment-gateway";

/// Number of event ids remembered for cross-node de-duplication.
pub const DEFAULT_DEDUPE_CAPACITY: usize = 2048;

pub const CREDENTIAL_TOPIC_PREFIX: &str = "credential:";
pub const GATEWAY_TOPIC_PREFIX: &str = "gateway:";
pub const CONFIGURATION_TOPIC_PREFIX: &str = "configuration:";

/// Wildcard patterns subscribed with `PSUBSCRIBE`.
pub const CREDENTIAL_TOPIC_PATTERN: &str = "credential:*";
pub const GATEWAY_TOPIC_PATTERN: &str = "gateway:*";
pub const CONFIGURATION_TOPIC_PATTERN: &str = "configuration:*";
pub const REALTIME_TOPIC_PATTERN: &str = "realtime:*";

pub const CREDENTIAL_INVALIDATED_REASON: &str = "credential-invalidated";
pub const GATEWAY_INVALIDATED_REASON: &str = "gateway-invalidated";
pub const CONFIGURATION_INVALIDATED_REASON: &str = "configuration-invalidated";

/// Port of `InvalidationEvent<T>`; field names are the exact JSON names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvalidationEnvelope<T = Value> {
    pub id: String,
    pub namespace: String,
    pub topic: String,
    pub payload: T,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
}

impl<T> InvalidationEnvelope<T> {
    /// Build an event with a fresh v4 id and the current `toISOString()` timestamp.
    #[must_use]
    pub fn new(topic: impl Into<String>, payload: T) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            namespace: NAMESPACE.to_owned(),
            topic: topic.into(),
            payload,
            published_at: iso_now(),
        }
    }

    /// The Redis channel this event is published on.
    pub fn channel(&self) -> Result<String, KeyError> {
        invalidation_channel(&self.topic)
    }

    #[must_use]
    pub fn belongs_to_namespace(&self) -> bool {
        self.namespace == NAMESPACE
    }
}

/// Parse a message from the wire. An unreadable message is dropped, exactly like the TS
/// subscriber which ignores a `JSON.parse` failure.
#[must_use]
pub fn parse_envelope<T: DeserializeOwned>(raw: &str) -> Option<InvalidationEnvelope<T>> {
    serde_json::from_str(raw).ok()
}

#[must_use]
pub fn credential_topic(credential_set_id: &str) -> String {
    format!("{CREDENTIAL_TOPIC_PREFIX}{credential_set_id}")
}

#[must_use]
pub fn gateway_topic(gateway_id: &str) -> String {
    format!("{GATEWAY_TOPIC_PREFIX}{gateway_id}")
}

#[must_use]
pub fn configuration_topic(scope: &str) -> String {
    format!("{CONFIGURATION_TOPIC_PREFIX}{scope}")
}

/// Port of `topicMatchesPattern`: an exact match, or a prefix match when the pattern ends in `*`.
#[must_use]
pub fn topic_matches_pattern(topic: &str, pattern: &str) -> bool {
    if pattern == topic {
        return true;
    }
    let Some(prefix) = pattern.strip_suffix('*') else {
        return false;
    };
    topic.starts_with(prefix)
}

/// A pattern ending in `*` must be subscribed with `PSUBSCRIBE`.
#[must_use]
pub fn is_wildcard_topic(pattern: &str) -> bool {
    pattern.ends_with('*')
}

/// The payload of `invalidateCredential`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialInvalidation {
    #[serde(rename = "credentialSetId")]
    pub credential_set_id: String,
    pub reason: String,
}

impl CredentialInvalidation {
    #[must_use]
    pub fn new(credential_set_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            credential_set_id: credential_set_id.into(),
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn default_reason(credential_set_id: impl Into<String>) -> Self {
        Self::new(credential_set_id, CREDENTIAL_INVALIDATED_REASON)
    }

    #[must_use]
    pub fn topic(&self) -> String {
        credential_topic(&self.credential_set_id)
    }
}

/// The payload of `invalidateGateway`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayInvalidation {
    #[serde(rename = "gatewayId")]
    pub gateway_id: String,
    pub reason: String,
}

impl GatewayInvalidation {
    #[must_use]
    pub fn new(gateway_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            gateway_id: gateway_id.into(),
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn default_reason(gateway_id: impl Into<String>) -> Self {
        Self::new(gateway_id, GATEWAY_INVALIDATED_REASON)
    }

    #[must_use]
    pub fn topic(&self) -> String {
        gateway_topic(&self.gateway_id)
    }
}

/// The payload of `invalidateConfiguration`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigurationInvalidation {
    pub scope: String,
    pub reason: String,
}

impl ConfigurationInvalidation {
    #[must_use]
    pub fn new(scope: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            scope: scope.into(),
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn default_reason(scope: impl Into<String>) -> Self {
        Self::new(scope, CONFIGURATION_INVALIDATED_REASON)
    }

    #[must_use]
    pub fn topic(&self) -> String {
        configuration_topic(&self.scope)
    }
}

/// Bounded id memory for cross-node de-duplication.
///
/// The TS implementation is a `Set` used as an insertion-ordered FIFO (not a true LRU): the
/// oldest inserted id is evicted once 2048 ids are remembered. `VecDeque` + `HashSet` reproduces
/// that order while keeping membership checks O(1).
#[derive(Debug, Clone)]
pub struct LruDedupe {
    capacity: usize,
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl Default for LruDedupe {
    fn default() -> Self {
        Self::new(DEFAULT_DEDUPE_CAPACITY)
    }
}

impl LruDedupe {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity.min(1024)),
            seen: HashSet::with_capacity(capacity.min(1024)),
        }
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    #[must_use]
    pub fn contains(&self, id: &str) -> bool {
        self.seen.contains(id)
    }

    /// Remember an id. Returns `true` when it was not present before.
    pub fn remember(&mut self, id: &str) -> bool {
        if !self.seen.insert(id.to_owned()) {
            return false;
        }
        self.order.push_back(id.to_owned());
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }

    /// Accept a received message id: non-empty, in our namespace (checked by the caller) and new.
    pub fn accept(&mut self, id: &str) -> bool {
        !id.is_empty() && self.remember(id)
    }

    /// The full `receiveRedisMessage` decision: own namespace, non-empty id, not seen before.
    pub fn accepts<T>(&mut self, envelope: &InvalidationEnvelope<T>) -> bool {
        envelope.belongs_to_namespace() && self.accept(&envelope.id)
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.seen.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_uses_the_exact_json_field_names() {
        let event = InvalidationEnvelope::new(
            credential_topic("cs-1"),
            CredentialInvalidation::default_reason("cs-1"),
        );
        let value = serde_json::to_value(&event).expect("serialises");
        assert_eq!(
            value,
            json!({
                "id": event.id,
                "namespace": "payment-gateway",
                "topic": "credential:cs-1",
                "payload": { "credentialSetId": "cs-1", "reason": "credential-invalidated" },
                "publishedAt": event.published_at,
            })
        );
        assert!(!value
            .as_object()
            .expect("object")
            .contains_key("published_at"));
    }

    #[test]
    fn typescript_messages_round_trip() {
        let raw = r#"{"id":"3f1b7d0e-7f8e-4d6c-9f6f-2b4b0f9a1c22","namespace":"payment-gateway","topic":"gateway:gw-1","payload":{"gatewayId":"gw-1","reason":"gateway-invalidated"},"publishedAt":"2026-11-28T09:00:00.000Z"}"#;
        let parsed: InvalidationEnvelope<GatewayInvalidation> =
            parse_envelope(raw).expect("parses");
        assert!(parsed.belongs_to_namespace());
        assert_eq!(parsed.payload.gateway_id, "gw-1");
        assert_eq!(parsed.published_at, "2026-11-28T09:00:00.000Z");
        assert_eq!(
            parsed.channel().expect("channel"),
            "payment-gateway:invalidation:gateway:gw-1"
        );
    }

    #[test]
    fn unreadable_and_foreign_messages_are_rejected() {
        assert!(parse_envelope::<Value>("not json").is_none());
        let foreign = InvalidationEnvelope {
            id: "id".to_owned(),
            namespace: "another-service".to_owned(),
            topic: "credential:1".to_owned(),
            payload: Value::Null,
            published_at: "2026-11-28T09:00:00.000Z".to_owned(),
        };
        assert!(!foreign.belongs_to_namespace());
    }

    #[test]
    fn pattern_matching_matches_the_typescript_rule() {
        assert!(topic_matches_pattern("credential:abc", "credential:*"));
        assert!(topic_matches_pattern("credential:abc", "credential:abc"));
        assert!(!topic_matches_pattern("credential:abc", "gateway:*"));
        assert!(!topic_matches_pattern("credential", "credential:*"));
        assert!(!topic_matches_pattern("credential:abc", "credential"));
        assert!(!topic_matches_pattern("credential:abc", "*credential"));
        assert!(is_wildcard_topic("credential:*"));
        assert!(!is_wildcard_topic("credential:abc"));
    }

    #[test]
    fn dedupe_evicts_the_oldest_insertion() {
        let mut dedupe = LruDedupe::new(3);
        assert!(dedupe.remember("a"));
        assert!(dedupe.remember("b"));
        assert!(!dedupe.remember("a"));
        assert!(dedupe.remember("c"));
        assert!(dedupe.remember("d")); // evicts "a"
        assert!(!dedupe.contains("a"));
        assert!(dedupe.contains("b"));
        assert!(dedupe.contains("d"));
        assert_eq!(dedupe.len(), 3);

        assert!(!dedupe.accept(""));
        assert!(!dedupe.accept("b"));
        assert!(dedupe.accept("e"));
    }

    #[test]
    fn remote_messages_need_the_namespace_and_a_new_id() {
        let mut dedupe = LruDedupe::default();
        let event = InvalidationEnvelope::new(
            credential_topic("cs-1"),
            CredentialInvalidation::default_reason("cs-1"),
        );
        assert!(dedupe.accepts(&event));
        assert!(!dedupe.accepts(&event));

        let foreign = InvalidationEnvelope {
            namespace: "other".to_owned(),
            ..InvalidationEnvelope::new("credential:cs-2", Value::Null)
        };
        assert!(!dedupe.accepts(&foreign));
    }

    #[test]
    fn dedupe_default_capacity_is_2048() {
        let mut dedupe = LruDedupe::default();
        assert_eq!(dedupe.capacity(), 2048);
        for index in 0..2048 {
            assert!(dedupe.remember(&format!("id-{index}")));
        }
        assert_eq!(dedupe.len(), 2048);
        assert!(dedupe.remember("id-2048"));
        assert!(!dedupe.contains("id-0"));
        assert_eq!(dedupe.len(), 2048);
    }

    #[test]
    fn topic_builders() {
        assert_eq!(
            configuration_topic("route-health"),
            "configuration:route-health"
        );
        assert_eq!(
            CredentialInvalidation::default_reason("cs-9").topic(),
            "credential:cs-9"
        );
        assert_eq!(
            ConfigurationInvalidation::default_reason("fees").topic(),
            "configuration:fees"
        );
    }
}
