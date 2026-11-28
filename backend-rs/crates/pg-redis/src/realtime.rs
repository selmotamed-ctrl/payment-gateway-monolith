//! Realtime fan-out topics and payloads.
//!
//! Port of `core-back/lib/realtimeBus.ts` and the `attempt:transition` bridge in
//! `core-back/lib/invalidationBus/index.ts`.
//!
//! Transitions are published on `attempt:transition`; the bus also re-publishes the same payload
//! on `realtime:attempt`, which is the topic the checkout status and merchant POS SSE streams
//! subscribe to. Every realtime payload carries `emittedAt` (the envelope timestamp is
//! `publishedAt`). Fan-out is best-effort: a publish failure is swallowed because the streams keep
//! their database-poll fallback.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::invalidation::{InvalidationEnvelope, NAMESPACE};
use crate::timestamp::iso_now;

pub const ATTEMPT_TRANSITION_TOPIC: &str = "attempt:transition";
pub const REALTIME_ATTEMPT_TOPIC: &str = "realtime:attempt";
pub const REALTIME_POS_TOPIC: &str = "realtime:pos";

/// Port of `AttemptTransitionEvent` (`engine/flow/DynamicRailEngine.ts:249`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptTransitionEvent {
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub substatus: Option<String>,
    #[serde(
        rename = "merchantId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub merchant_id: Option<String>,
}

impl AttemptTransitionEvent {
    #[must_use]
    pub fn new(
        attempt_id: impl Into<String>,
        status: impl Into<String>,
        merchant_id: Option<&str>,
    ) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            status: status.into(),
            substatus: None,
            merchant_id: merchant_id.map(str::to_owned),
        }
    }

    #[must_use]
    pub fn with_substatus(mut self, substatus: Option<&str>) -> Self {
        self.substatus = substatus.map(str::to_owned);
        self
    }
}

/// Port of `RealtimeAttemptEvent`: a transition plus `emittedAt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealtimeAttemptEvent {
    #[serde(flatten)]
    pub transition: AttemptTransitionEvent,
    #[serde(rename = "emittedAt")]
    pub emitted_at: String,
}

impl RealtimeAttemptEvent {
    #[must_use]
    pub fn from_transition(
        transition: AttemptTransitionEvent,
        emitted_at: impl Into<String>,
    ) -> Self {
        Self {
            transition,
            emitted_at: emitted_at.into(),
        }
    }

    /// Same as [`Self::from_transition`] with the current time.
    #[must_use]
    pub fn now(transition: AttemptTransitionEvent) -> Self {
        Self::from_transition(transition, iso_now())
    }
}

/// Port of `RealtimePosEvent` (`lib/realtimeBus.ts:19-27`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealtimePosEvent {
    #[serde(rename = "merchantId")]
    pub merchant_id: String,
    #[serde(
        rename = "applicationId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub application_id: Option<String>,
    #[serde(
        rename = "terminalId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub terminal_id: Option<String>,
    #[serde(
        rename = "screenCode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub screen_code: Option<String>,
    #[serde(rename = "linkId", default, skip_serializing_if = "Option::is_none")]
    pub link_id: Option<String>,
    #[serde(rename = "linkKey", default, skip_serializing_if = "Option::is_none")]
    pub link_key: Option<String>,
    #[serde(rename = "emittedAt")]
    pub emitted_at: String,
}

impl RealtimePosEvent {
    #[must_use]
    pub fn new(merchant_id: impl Into<String>) -> Self {
        Self {
            merchant_id: merchant_id.into(),
            application_id: None,
            terminal_id: None,
            screen_code: None,
            link_id: None,
            link_key: None,
            emitted_at: iso_now(),
        }
    }
}

/// An envelope whose payload also carries `emittedAt`.
///
/// The TS wire format puts `emittedAt` inside `payload` and `publishedAt` on the envelope; this
/// type models both halves together for consumers that need the complete timestamped event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RealtimeEnvelope<T = Value> {
    pub id: String,
    pub namespace: String,
    pub topic: String,
    pub payload: T,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "emittedAt")]
    pub emitted_at: String,
}

impl<T> RealtimeEnvelope<T> {
    #[must_use]
    pub fn from_invalidation(
        envelope: InvalidationEnvelope<T>,
        emitted_at: impl Into<String>,
    ) -> Self {
        Self {
            id: envelope.id,
            namespace: envelope.namespace,
            topic: envelope.topic,
            payload: envelope.payload,
            published_at: envelope.published_at,
            emitted_at: emitted_at.into(),
        }
    }

    /// Build a realtime envelope from a payload, with the same timestamp on both fields.
    #[must_use]
    pub fn new(topic: impl Into<String>, payload: T) -> Self {
        let envelope = InvalidationEnvelope::new(topic, payload);
        let emitted_at = envelope.published_at.clone();
        Self::from_invalidation(envelope, emitted_at)
    }

    #[must_use]
    pub fn belongs_to_namespace(&self) -> bool {
        self.namespace == NAMESPACE
    }
}

/// The `attempt:transition` → `realtime:attempt` bridge performed by `InvalidationBus.publish`.
#[must_use]
pub fn bridge_topic(topic: &str) -> Option<&'static str> {
    (topic == ATTEMPT_TRANSITION_TOPIC).then_some(REALTIME_ATTEMPT_TOPIC)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transition_payload_shape() {
        let event = AttemptTransitionEvent::new("attempt-1", "AUTHORIZING", Some("merchant-1"))
            .with_substatus(Some("OTP_SENT"));
        assert_eq!(
            serde_json::to_value(&event).expect("serialises"),
            json!({
                "attemptId": "attempt-1",
                "status": "AUTHORIZING",
                "substatus": "OTP_SENT",
                "merchantId": "merchant-1",
            })
        );
    }

    #[test]
    fn optional_fields_are_omitted() {
        let event = AttemptTransitionEvent::new("attempt-1", "FAILED", None);
        assert_eq!(
            serde_json::to_value(&event).expect("serialises"),
            json!({ "attemptId": "attempt-1", "status": "FAILED" })
        );
    }

    #[test]
    fn realtime_attempt_event_flattens_the_transition() {
        let event = RealtimeAttemptEvent::from_transition(
            AttemptTransitionEvent::new("attempt-1", "SUCCEEDED", Some("merchant-1")),
            "2026-11-28T09:00:00.000Z",
        );
        assert_eq!(
            serde_json::to_value(&event).expect("serialises"),
            json!({
                "attemptId": "attempt-1",
                "status": "SUCCEEDED",
                "merchantId": "merchant-1",
                "emittedAt": "2026-11-28T09:00:00.000Z",
            })
        );
    }

    #[test]
    fn pos_event_shape() {
        let event = RealtimePosEvent {
            screen_code: Some("SCREEN-1".to_owned()),
            ..RealtimePosEvent::new("merchant-9")
        };
        let value = serde_json::to_value(&event).expect("serialises");
        assert_eq!(value["merchantId"], "merchant-9");
        assert_eq!(value["screenCode"], "SCREEN-1");
        assert!(value.get("terminalId").is_none());
        assert!(value.get("emittedAt").and_then(Value::as_str).is_some());
    }

    #[test]
    fn realtime_envelope_adds_emitted_at() {
        let envelope =
            RealtimeEnvelope::new(REALTIME_POS_TOPIC, RealtimePosEvent::new("merchant-9"));
        let value = serde_json::to_value(&envelope).expect("serialises");
        assert_eq!(value["namespace"], "payment-gateway");
        assert_eq!(value["topic"], "realtime:pos");
        assert_eq!(value["publishedAt"], value["emittedAt"]);
        assert!(envelope.belongs_to_namespace());
    }

    #[test]
    fn attempts_bridge_to_the_realtime_topic() {
        assert_eq!(
            bridge_topic(ATTEMPT_TRANSITION_TOPIC),
            Some(REALTIME_ATTEMPT_TOPIC)
        );
        assert_eq!(bridge_topic(REALTIME_ATTEMPT_TOPIC), None);
        assert_eq!(bridge_topic("credential:1"), None);
    }
}
