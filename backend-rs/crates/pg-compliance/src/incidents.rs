//! Incident lifecycle.
//!
//! Port of `core-back/engine/compliance/incidents.ts` and of the transition rules in
//! `core-back/api/internal/admin.ts` (`POST /incidents/:id/transition`).
//!
//! The state machine is small and strict: only the listed edges are allowed, the status change
//! stamps one timestamp, and a postmortem-required incident cannot be closed without a root cause
//! or a postmortem summary. A postmortem is required for SEV1/SEV2 and for SECURITY /
//! DATA_INTEGRITY incidents, and its due date is 5/7/14 days after resolution.

#![forbid(unsafe_code)]

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// `IncidentStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IncidentStatus {
    Detected,
    Triaged,
    Declared,
    Contained,
    Monitoring,
    Resolved,
    Postmortem,
    Closed,
}

impl IncidentStatus {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Detected => "DETECTED",
            Self::Triaged => "TRIAGED",
            Self::Declared => "DECLARED",
            Self::Contained => "CONTAINED",
            Self::Monitoring => "MONITORING",
            Self::Resolved => "RESOLVED",
            Self::Postmortem => "POSTMORTEM",
            Self::Closed => "CLOSED",
        }
    }

    /// Every status in lifecycle order.
    #[must_use]
    pub const fn all() -> &'static [Self] {
        &ALL_STATUSES
    }
}

const ALL_STATUSES: [IncidentStatus; 8] = [
    IncidentStatus::Detected,
    IncidentStatus::Triaged,
    IncidentStatus::Declared,
    IncidentStatus::Contained,
    IncidentStatus::Monitoring,
    IncidentStatus::Resolved,
    IncidentStatus::Postmortem,
    IncidentStatus::Closed,
];

/// `IncidentSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IncidentSeverity {
    Sev1,
    Sev2,
    Sev3,
    Sev4,
}

impl IncidentSeverity {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sev1 => "SEV1",
            Self::Sev2 => "SEV2",
            Self::Sev3 => "SEV3",
            Self::Sev4 => "SEV4",
        }
    }
}

/// `IncidentCategory`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IncidentCategory {
    Availability,
    DataIntegrity,
    Security,
    Fraud,
    Compliance,
    ThirdParty,
    PaymentProcessing,
    Other,
}

impl IncidentCategory {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Availability => "AVAILABILITY",
            Self::DataIntegrity => "DATA_INTEGRITY",
            Self::Security => "SECURITY",
            Self::Fraud => "FRAUD",
            Self::Compliance => "COMPLIANCE",
            Self::ThirdParty => "THIRD_PARTY",
            Self::PaymentProcessing => "PAYMENT_PROCESSING",
            Self::Other => "OTHER",
        }
    }
}

/// `INCIDENT_TRANSITIONS`.
#[must_use]
pub const fn allowed_transitions(from: IncidentStatus) -> &'static [IncidentStatus] {
    match from {
        IncidentStatus::Detected => &FROM_DETECTED,
        IncidentStatus::Triaged => &FROM_TRIAGED,
        IncidentStatus::Declared => &FROM_DECLARED,
        IncidentStatus::Contained => &FROM_CONTAINED,
        IncidentStatus::Monitoring => &FROM_MONITORING,
        IncidentStatus::Resolved => &FROM_RESOLVED,
        IncidentStatus::Postmortem => &FROM_POSTMORTEM,
        IncidentStatus::Closed => &FROM_CLOSED,
    }
}

const FROM_DETECTED: [IncidentStatus; 2] = [IncidentStatus::Triaged, IncidentStatus::Declared];
const FROM_TRIAGED: [IncidentStatus; 2] = [IncidentStatus::Declared, IncidentStatus::Monitoring];
const FROM_DECLARED: [IncidentStatus; 1] = [IncidentStatus::Contained];
const FROM_CONTAINED: [IncidentStatus; 2] = [IncidentStatus::Monitoring, IncidentStatus::Resolved];
const FROM_MONITORING: [IncidentStatus; 2] = [IncidentStatus::Resolved, IncidentStatus::Contained];
const FROM_RESOLVED: [IncidentStatus; 2] = [IncidentStatus::Postmortem, IncidentStatus::Closed];
const FROM_POSTMORTEM: [IncidentStatus; 1] = [IncidentStatus::Closed];
const FROM_CLOSED: [IncidentStatus; 0] = [];

/// `canTransitionIncident`.
#[must_use]
pub fn can_transition_incident(from: IncidentStatus, to: IncidentStatus) -> bool {
    allowed_transitions(from).contains(&to)
}

/// `incidentTimestampField`: the column stamped by entering `status`.
#[must_use]
pub const fn incident_timestamp_field(status: IncidentStatus) -> Option<&'static str> {
    match status {
        IncidentStatus::Declared => Some("declared_at"),
        IncidentStatus::Contained => Some("contained_at"),
        IncidentStatus::Resolved => Some("resolved_at"),
        IncidentStatus::Closed => Some("closed_at"),
        IncidentStatus::Detected
        | IncidentStatus::Triaged
        | IncidentStatus::Monitoring
        | IncidentStatus::Postmortem => None,
    }
}

/// `incidentRequiresPostmortem`.
#[must_use]
pub fn incident_requires_postmortem(
    severity: IncidentSeverity,
    category: IncidentCategory,
) -> bool {
    matches!(severity, IncidentSeverity::Sev1 | IncidentSeverity::Sev2)
        || matches!(
            category,
            IncidentCategory::Security | IncidentCategory::DataIntegrity
        )
}

/// `incidentPostmortemDueAt`: 5 days for SEV1, 7 for SEV2, 14 otherwise.
#[must_use]
pub fn incident_postmortem_due_at(
    resolved_at: DateTime<Utc>,
    severity: IncidentSeverity,
) -> DateTime<Utc> {
    let days = match severity {
        IncidentSeverity::Sev1 => 5,
        IncidentSeverity::Sev2 => 7,
        IncidentSeverity::Sev3 | IncidentSeverity::Sev4 => 14,
    };
    resolved_at + Duration::days(days)
}

/// A transition request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IncidentTransition<'a> {
    pub from: IncidentStatus,
    pub to: IncidentStatus,
    pub severity: IncidentSeverity,
    pub category: IncidentCategory,
    pub root_cause: Option<&'a str>,
    pub postmortem_summary: Option<&'a str>,
    /// When the transition is recorded (server clock).
    pub at: DateTime<Utc>,
}

/// What the transition writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionPlan {
    pub to: IncidentStatus,
    pub timestamp_field: Option<&'static str>,
    pub postmortem_required: bool,
    pub postmortem_due_at: Option<DateTime<Utc>>,
    pub closed: bool,
}

/// A refused transition.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IncidentError {
    /// The edge is not in the state machine.
    #[error("Cannot move an incident from {} to {}", .from.as_str(), .to.as_str())]
    InvalidTransition {
        /// The current status.
        from: IncidentStatus,
        /// The requested status.
        to: IncidentStatus,
    },
    /// A required postmortem is missing.
    #[error("A required postmortem must be recorded before closing the incident")]
    PostmortemRequired,
    /// An empty responder name.
    #[error("A responder needs a name")]
    EmptyResponderName,
    /// An empty or over-long responder role.
    #[error("A responder role must be 1..=120 characters")]
    InvalidResponderRole,
}

impl IncidentError {
    /// The API code (`409` for the state machine, `400` for a responder).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidTransition { .. } => "INCIDENT_TRANSITION_INVALID",
            Self::PostmortemRequired => "INCIDENT_POSTMORTEM_REQUIRED",
            Self::EmptyResponderName => "INCIDENT_RESPONDER_NAME_REQUIRED",
            Self::InvalidResponderRole => "INCIDENT_RESPONDER_ROLE_INVALID",
        }
    }

    /// The HTTP status.
    #[must_use]
    pub const fn status(&self) -> u16 {
        match self {
            Self::InvalidTransition { .. } | Self::PostmortemRequired => 409,
            Self::EmptyResponderName | Self::InvalidResponderRole => 400,
        }
    }
}

fn has_text(value: Option<&str>) -> bool {
    value.is_some_and(|text| !text.trim().is_empty())
}

/// `POST /incidents/:id/transition`: validates and describes the write.
///
/// # Errors
/// [`IncidentError::InvalidTransition`] or [`IncidentError::PostmortemRequired`].
pub fn validate_transition(
    transition: &IncidentTransition<'_>,
) -> Result<TransitionPlan, IncidentError> {
    if !can_transition_incident(transition.from, transition.to) {
        return Err(IncidentError::InvalidTransition {
            from: transition.from,
            to: transition.to,
        });
    }
    let requires_postmortem =
        incident_requires_postmortem(transition.severity, transition.category);
    if transition.to == IncidentStatus::Closed
        && requires_postmortem
        && !has_text(transition.root_cause)
        && !has_text(transition.postmortem_summary)
    {
        return Err(IncidentError::PostmortemRequired);
    }
    let resolved = transition.to == IncidentStatus::Resolved;
    Ok(TransitionPlan {
        to: transition.to,
        timestamp_field: incident_timestamp_field(transition.to),
        postmortem_required: if resolved { requires_postmortem } else { false },
        postmortem_due_at: if resolved && requires_postmortem {
            Some(incident_postmortem_due_at(
                transition.at,
                transition.severity,
            ))
        } else {
            None
        },
        closed: transition.to == IncidentStatus::Closed,
    })
}

/// The advisory responder-role catalogue offered by the Admin incident screen. The API accepts any
/// non-empty role string up to 120 characters (the TS schema is `z.string().min(1).max(120)`).
pub const STANDARD_RESPONDER_ROLES: &[&str] = &[
    "INCIDENT_COMMANDER",
    "TECHNICAL_LEAD",
    "COMMUNICATIONS_LEAD",
    "COMPLIANCE_OFFICER",
    "SRE",
    "SUPPORT_LEAD",
];

/// The maximum responder-role length.
pub const MAX_RESPONDER_ROLE_CHARS: usize = 120;

/// `model IncidentResponder` (the fields the API sets on create).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentResponder {
    pub name: String,
    pub role: String,
    pub is_commander: bool,
    pub user_id: Option<String>,
}

impl IncidentResponder {
    /// Validates and builds a responder (the TS schema: non-empty name, 1..=120 role).
    ///
    /// # Errors
    /// [`IncidentError::EmptyResponderName`] / [`IncidentError::InvalidResponderRole`].
    pub fn new(name: impl Into<String>, role: impl Into<String>) -> Result<Self, IncidentError> {
        let name = name.into();
        let role = role.into();
        if name.trim().is_empty() {
            return Err(IncidentError::EmptyResponderName);
        }
        let role_length = role.chars().count();
        if role_length == 0 || role_length > MAX_RESPONDER_ROLE_CHARS {
            return Err(IncidentError::InvalidResponderRole);
        }
        Ok(Self {
            name,
            role,
            is_commander: false,
            user_id: None,
        })
    }

    /// Marks the responder as the incident commander (the first commander becomes
    /// `incident.commanderUserId`).
    #[must_use]
    pub fn commander(mut self) -> Self {
        self.is_commander = true;
        self
    }

    /// Binds the responder to a staff user.
    #[must_use]
    pub fn with_user(mut self, user_id: impl Into<String>) -> Self {
        self.user_id = Some(user_id.into());
        self
    }

    /// True when the role is one of [`STANDARD_RESPONDER_ROLES`].
    #[must_use]
    pub fn is_standard_role(&self) -> bool {
        STANDARD_RESPONDER_ROLES.contains(&self.role.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-28T09:00:00Z")
            .expect("instant")
            .with_timezone(&Utc)
    }

    #[test]
    fn the_state_machine_allows_exactly_the_listed_edges() {
        assert!(can_transition_incident(
            IncidentStatus::Detected,
            IncidentStatus::Triaged
        ));
        assert!(can_transition_incident(
            IncidentStatus::Detected,
            IncidentStatus::Declared
        ));
        assert!(can_transition_incident(
            IncidentStatus::Contained,
            IncidentStatus::Resolved
        ));
        assert!(can_transition_incident(
            IncidentStatus::Monitoring,
            IncidentStatus::Contained
        ));
        assert!(can_transition_incident(
            IncidentStatus::Resolved,
            IncidentStatus::Closed
        ));
        assert!(!can_transition_incident(
            IncidentStatus::Detected,
            IncidentStatus::Contained
        ));
        assert!(!can_transition_incident(
            IncidentStatus::Closed,
            IncidentStatus::Detected
        ));
        assert!(allowed_transitions(IncidentStatus::Closed).is_empty());
        assert_eq!(IncidentStatus::all().len(), 8);
    }

    #[test]
    fn a_timestamp_is_stamped_only_by_the_listed_statuses() {
        assert_eq!(
            incident_timestamp_field(IncidentStatus::Declared),
            Some("declared_at")
        );
        assert_eq!(
            incident_timestamp_field(IncidentStatus::Contained),
            Some("contained_at")
        );
        assert_eq!(
            incident_timestamp_field(IncidentStatus::Resolved),
            Some("resolved_at")
        );
        assert_eq!(
            incident_timestamp_field(IncidentStatus::Closed),
            Some("closed_at")
        );
        assert_eq!(incident_timestamp_field(IncidentStatus::Triaged), None);
        assert_eq!(incident_timestamp_field(IncidentStatus::Monitoring), None);
        assert_eq!(incident_timestamp_field(IncidentStatus::Postmortem), None);
    }

    #[test]
    fn postmortem_rules_follow_severity_and_category() {
        assert!(incident_requires_postmortem(
            IncidentSeverity::Sev1,
            IncidentCategory::Other
        ));
        assert!(incident_requires_postmortem(
            IncidentSeverity::Sev2,
            IncidentCategory::Other
        ));
        assert!(incident_requires_postmortem(
            IncidentSeverity::Sev4,
            IncidentCategory::Security
        ));
        assert!(incident_requires_postmortem(
            IncidentSeverity::Sev3,
            IncidentCategory::DataIntegrity
        ));
        assert!(!incident_requires_postmortem(
            IncidentSeverity::Sev3,
            IncidentCategory::Availability
        ));
        assert_eq!(
            incident_postmortem_due_at(at(), IncidentSeverity::Sev1).to_rfc3339(),
            "2026-12-03T09:00:00+00:00"
        );
        assert_eq!(
            incident_postmortem_due_at(at(), IncidentSeverity::Sev2).to_rfc3339(),
            "2026-12-05T09:00:00+00:00"
        );
        assert_eq!(
            incident_postmortem_due_at(at(), IncidentSeverity::Sev4).to_rfc3339(),
            "2026-12-12T09:00:00+00:00"
        );
    }

    fn transition(to: IncidentStatus) -> IncidentTransition<'static> {
        transition_from(IncidentStatus::Contained, to)
    }

    fn transition_from(from: IncidentStatus, to: IncidentStatus) -> IncidentTransition<'static> {
        IncidentTransition {
            from,
            to,
            severity: IncidentSeverity::Sev2,
            category: IncidentCategory::Availability,
            root_cause: None,
            postmortem_summary: None,
            at: at(),
        }
    }

    #[test]
    fn resolving_plans_the_postmortem_deadline() {
        let plan = validate_transition(&transition(IncidentStatus::Resolved)).expect("resolves");
        assert_eq!(plan.timestamp_field, Some("resolved_at"));
        assert!(plan.postmortem_required);
        assert_eq!(
            plan.postmortem_due_at.map(|instant| instant.to_rfc3339()),
            Some("2026-12-05T09:00:00+00:00".to_owned())
        );
        assert!(!plan.closed);
    }

    #[test]
    fn closing_requires_a_root_cause_or_postmortem_for_required_incidents() {
        let mut close = transition_from(IncidentStatus::Resolved, IncidentStatus::Closed);
        assert_eq!(
            validate_transition(&close),
            Err(IncidentError::PostmortemRequired)
        );
        close.root_cause = Some("   ");
        assert_eq!(
            validate_transition(&close),
            Err(IncidentError::PostmortemRequired)
        );
        close.postmortem_summary = Some("Cache stampede on the treasury shard");
        let plan = validate_transition(&close).expect("closes");
        assert!(plan.closed);
        assert_eq!(plan.timestamp_field, Some("closed_at"));

        // A SEV4 availability incident needs no postmortem to close.
        let mut low = transition_from(IncidentStatus::Resolved, IncidentStatus::Closed);
        low.severity = IncidentSeverity::Sev4;
        low.category = IncidentCategory::Other;
        assert!(validate_transition(&low).is_ok());
    }

    #[test]
    fn an_invalid_edge_is_refused_with_the_api_code() {
        let mut invalid = transition(IncidentStatus::Detected);
        invalid.from = IncidentStatus::Closed;
        let error = validate_transition(&invalid).expect_err("invalid");
        assert_eq!(error.code(), "INCIDENT_TRANSITION_INVALID");
        assert_eq!(error.status(), 409);
        let postmortem = transition_from(IncidentStatus::Resolved, IncidentStatus::Closed);
        assert_eq!(
            validate_transition(&postmortem).map(|_| ()),
            Err(IncidentError::PostmortemRequired)
        );
    }

    #[test]
    fn responders_are_validated_and_roles_are_advisory() {
        let responder = IncidentResponder::new("Ayoub", "INCIDENT_COMMANDER")
            .expect("responder")
            .commander()
            .with_user("00000000-0000-4000-8000-000000000001");
        assert!(responder.is_commander);
        assert!(responder.is_standard_role());
        assert_eq!(
            responder.user_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000001")
        );
        let custom = IncidentResponder::new("Salem", "TREASURY_LIAISON").expect("custom role");
        assert!(!custom.is_standard_role());
        assert_eq!(
            IncidentResponder::new(" ", "SRE"),
            Err(IncidentError::EmptyResponderName)
        );
        assert_eq!(
            IncidentResponder::new("Salem", ""),
            Err(IncidentError::InvalidResponderRole)
        );
        assert_eq!(
            IncidentResponder::new("Salem", "x".repeat(121)),
            Err(IncidentError::InvalidResponderRole)
        );
        assert_eq!(STANDARD_RESPONDER_ROLES.len(), 6);
        assert_eq!(MAX_RESPONDER_ROLE_CHARS, 120);
    }
}
