//! Route policy registry (AD-11).
//!
//! Every route must be registered with a policy. The registry refuses duplicates and can export
//! the policy table so CI can diff it against `routes.json` from the TS inventory (P3-T10).
//!
//! During Track P each policy reproduces the TS guards exactly, including permissive ones.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Admin,
    Merchant,
    Checkout,
    Sandbox,
    Internal,
    Public,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authn {
    None,
    Session,
    ApiToken,
    SessionOrApiToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeRule {
    NotApplicable,
    Required,
    FromPath(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MfaRule {
    NotRequired,
    RequiredSinceLogin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RateClass {
    Default,
    Auth,
    External,
    Search,
    Academy,
    Upload,
    BackupJobs,
    Public,
    Sse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BodyRule {
    None,
    Json { limit: u64 },
    Raw { limit: u64 },
    Urlencoded { limit: u64 },
    Multipart { limit: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditRule {
    None,
    Read,
    Write,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub method: String,
    pub path: String,
    pub channel: Channel,
    pub authn: Authn,
    /// OR semantics, exactly like `requireAuthorities`.
    pub authorities: Vec<String>,
    pub merchant_scope: ScopeRule,
    pub mfa: MfaRule,
    pub maker_checker: Option<String>,
    pub rate_class: RateClass,
    pub body: BodyRule,
    pub audit: AuditRule,
    pub ts_origin: String,
}

impl Policy {
    #[must_use]
    pub fn new(method: &str, path: &str, channel: Channel, authn: Authn, ts_origin: &str) -> Self {
        Self {
            method: method.to_owned(),
            path: path.to_owned(),
            channel,
            authn,
            authorities: Vec::new(),
            merchant_scope: ScopeRule::NotApplicable,
            mfa: MfaRule::NotRequired,
            maker_checker: None,
            rate_class: RateClass::Default,
            body: BodyRule::None,
            audit: AuditRule::None,
            ts_origin: ts_origin.to_owned(),
        }
    }

    #[must_use]
    pub fn authorities(mut self, authorities: &[&str]) -> Self {
        self.authorities = authorities
            .iter()
            .map(|value| (*value).to_owned())
            .collect();
        self
    }

    #[must_use]
    pub fn body(mut self, body: BodyRule) -> Self {
        self.body = body;
        self
    }

    #[must_use]
    pub fn rate_class(mut self, rate_class: RateClass) -> Self {
        self.rate_class = rate_class;
        self
    }

    #[must_use]
    pub fn audit(mut self, audit: AuditRule) -> Self {
        self.audit = audit;
        self
    }

    #[must_use]
    pub fn merchant_scope(mut self, scope: ScopeRule) -> Self {
        self.merchant_scope = scope;
        self
    }

    #[must_use]
    pub fn maker_checker(mut self, subject: &str) -> Self {
        self.maker_checker = Some(subject.to_owned());
        self
    }

    #[must_use]
    pub fn key(&self) -> String {
        format!("{} {}", self.method.to_ascii_uppercase(), self.path)
    }
}

#[derive(Debug, Default)]
pub struct RouteRegistry {
    policies: Vec<Policy>,
    keys: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    Duplicate(String),
    EmptyOrigin(String),
    MissingPolicy(String),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Duplicate(key) => write!(f, "duplicate route policy: {key}"),
            Self::EmptyOrigin(key) => write!(f, "route policy has no TS origin: {key}"),
            Self::MissingPolicy(key) => write!(f, "route has no policy: {key}"),
        }
    }
}

impl std::error::Error for RegistryError {}

impl RouteRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, policy: Policy) -> Result<(), RegistryError> {
        let key = policy.key();
        if policy.ts_origin.trim().is_empty() {
            return Err(RegistryError::EmptyOrigin(key));
        }
        if !self.keys.insert(key.clone()) {
            return Err(RegistryError::Duplicate(key));
        }
        self.policies.push(policy);
        Ok(())
    }

    /// Register a route handler descriptor. A handler must be paired with a policy; this method
    /// is the only blessed way to add a route in the skeleton, keeping the invariant explicit.
    pub fn register_route(
        &mut self,
        policy: Policy,
        handler_present: bool,
    ) -> Result<(), RegistryError> {
        if !handler_present {
            return Err(RegistryError::MissingPolicy(policy.key()));
        }
        self.register(policy)
    }

    #[must_use]
    pub fn policies(&self) -> &[Policy] {
        &self.policies
    }

    /// Deterministic JSON used by `routes-policy.json`.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(
            &self
                .policies
                .iter()
                .map(|policy| {
                    serde_json::json!({
                        "method": policy.method,
                        "path": policy.path,
                        "channel": policy.channel,
                        "authn": policy.authn,
                        "authorities": policy.authorities,
                        "merchantScope": policy.merchant_scope,
                        "mfa": policy.mfa,
                        "makerChecker": policy.maker_checker,
                        "rateClass": policy.rate_class,
                        "body": policy.body,
                        "audit": policy.audit,
                        "tsOrigin": policy.ts_origin,
                    })
                })
                .collect::<Vec<_>>(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy::new(
            "POST",
            "/internal/merchant/cashouts",
            Channel::Merchant,
            Authn::Session,
            "core-back/api/internal/merchant.ts:2974",
        )
        .authorities(&["cashout:write"])
        .merchant_scope(ScopeRule::Required)
        .body(BodyRule::Json { limit: 1_000_000 })
        .audit(AuditRule::Write)
    }

    #[test]
    fn duplicate_routes_are_rejected() {
        let mut registry = RouteRegistry::new();
        registry.register(policy()).expect("first");
        assert!(matches!(
            registry.register(policy()),
            Err(RegistryError::Duplicate(_))
        ));
    }

    #[test]
    fn origin_is_mandatory() {
        let mut registry = RouteRegistry::new();
        let mut policy = policy();
        policy.ts_origin = String::new();
        assert!(matches!(
            registry.register(policy),
            Err(RegistryError::EmptyOrigin(_))
        ));
    }

    #[test]
    fn exports_camel_case_policy_json() {
        let mut registry = RouteRegistry::new();
        registry.register(policy()).expect("register");
        let json: serde_json::Value =
            serde_json::from_str(&registry.to_json().expect("json")).expect("parse");
        assert_eq!(json[0]["merchantScope"], "required");
        assert_eq!(
            json[0]["tsOrigin"],
            "core-back/api/internal/merchant.ts:2974"
        );
    }
}
