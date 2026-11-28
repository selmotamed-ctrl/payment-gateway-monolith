//! The request principal and the channel guards.
//!
//! Port of `core-back/api/middleware/authDoubleCheck.ts:12-33` (`Principal`), `:385-460`
//! (`isStaffPrincipal`, `isMerchantPrincipal`, `requireStaffPrincipal`, `requireMerchantPrincipal`,
//! `requireAuthorities`, `requireMerchantScope`).
//!
//! Two parity quirks are reproduced deliberately and documented where the fix lands
//! (S-SEC-02/S-SEC-04):
//!
//! 1. [`Principal::require_merchant_scope`] returns the principal **unchecked** when the requested
//!    merchant id is `None` (`authDoubleCheck.ts:450-452`).
//! 2. The `mfa` claim is not re-checked after login; a principal built from a session carries the
//!    claim but no guard enforces it.

#![forbid(unsafe_code)]

use crate::api_token::{ApiToken, ExecutionPlane};
use crate::authorities::{self, MerchantPrincipal, PrincipalKind};
use crate::channel::Channel;
use crate::error::AuthError;
use crate::session::VerifiedSession;

/// The authenticated caller of a core request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub kind: PrincipalKind,
    pub user_id: Option<String>,
    pub role: Option<String>,
    pub merchant_id: Option<String>,
    pub application_id: Option<String>,
    /// Granted authorities, re-read from the database for sessions and the token scopes for API
    /// tokens (`parseAuthorities(user.authoritiesMap)`).
    pub authorities: Vec<String>,
    /// API-token scopes (equal to `authorities` for a token).
    pub scopes: Vec<String>,
    pub token_id: Option<String>,
    /// The execution plane an API token was minted for; `None` for sessions (the session audience
    /// names the channel instead).
    pub token_plane: Option<ExecutionPlane>,
    /// `jti` of a session (the revoke-list handle).
    pub session_jti: Option<String>,
    /// `exp` of a session.
    pub session_exp: Option<i64>,
    /// Channel the session audience belongs to.
    pub session_channel: Option<Channel>,
    /// `users.app_scope_ids`, read on every request so a change applies without a new login.
    pub app_scope_ids: Vec<String>,
}

impl Principal {
    /// Build the principal of a verified session.
    ///
    /// `authorities` and `app_scope_ids` come from the user row (not the token) for Live; the
    /// Sandbox mirror stores the signed claims, and either way the caller passes the effective list.
    #[must_use]
    pub fn from_session(
        session: &VerifiedSession,
        user_id: impl Into<String>,
        role: impl Into<String>,
        merchant_id: Option<String>,
        authorities: Vec<String>,
        app_scope_ids: Vec<String>,
    ) -> Self {
        Self {
            kind: PrincipalKind::Session,
            user_id: Some(user_id.into()),
            role: Some(role.into()),
            merchant_id,
            application_id: None,
            scopes: authorities.clone(),
            authorities,
            token_id: None,
            token_plane: None,
            session_jti: session.jti().map(str::to_owned),
            session_exp: session.expires_at(),
            session_channel: session.channel,
            app_scope_ids,
        }
    }

    /// Build the principal of a validated API token.
    #[must_use]
    pub fn from_api_token(
        token: &ApiToken,
        token_id: impl Into<String>,
        merchant_id: Option<String>,
        application_id: Option<String>,
        scopes: Vec<String>,
    ) -> Self {
        Self {
            kind: PrincipalKind::ApiToken,
            user_id: None,
            role: Some("MERCHANT_API".to_owned()),
            merchant_id,
            application_id,
            authorities: scopes.clone(),
            scopes,
            token_id: Some(token_id.into()),
            token_plane: Some(token.plane()),
            session_jti: None,
            session_exp: None,
            session_channel: None,
            app_scope_ids: Vec::new(),
        }
    }

    /// `isStaffPrincipal`: a session that is not bound to a merchant and does not hold a
    /// `MERCHANT_*` role.
    #[must_use]
    pub fn is_staff(&self) -> bool {
        self.kind == PrincipalKind::Session
            && self.merchant_id.is_none()
            && self
                .role
                .as_deref()
                .is_some_and(|role| !role.starts_with("MERCHANT_"))
    }

    /// `isMerchantPrincipal`: a merchant-bound session or API token.
    #[must_use]
    pub fn is_merchant(&self) -> bool {
        self.merchant_id.is_some()
            && (self.kind == PrincipalKind::ApiToken
                || self
                    .role
                    .as_deref()
                    .is_some_and(|role| role.starts_with("MERCHANT_")))
    }

    /// `requireStaffPrincipal`: staff only, and the session must be an admin session.
    pub fn require_staff(&self) -> Result<(), AuthError> {
        if !self.is_staff() {
            return Err(AuthError::staff_principal_required());
        }
        if self.kind == PrincipalKind::Session && self.session_channel != Some(Channel::Admin) {
            return Err(Channel::Admin.audience_error());
        }
        Ok(())
    }

    /// `requireMerchantPrincipal`: merchant sessions and API tokens only.
    pub fn require_merchant(&self) -> Result<(), AuthError> {
        if !self.is_merchant() {
            return Err(AuthError::merchant_principal_required());
        }
        if self.kind == PrincipalKind::Session && self.session_channel != Some(Channel::Merchant) {
            return Err(Channel::Merchant.audience_error());
        }
        Ok(())
    }

    /// `requireAuthorities`: OR semantics, deny by default, and `*` only for staff.
    pub fn require_authorities(&self, required: &[&str]) -> Result<(), AuthError> {
        if required.is_empty() {
            return Ok(());
        }
        let wildcard = self.authorities.iter().any(|authority| authority == "*") && self.is_staff();
        if wildcard
            || required
                .iter()
                .any(|authority| self.authorities.iter().any(|held| held == authority))
        {
            Ok(())
        } else {
            Err(AuthError::authority_required(required))
        }
    }

    /// `requireMerchantScope`.
    ///
    /// **Parity:** when the requested merchant id is `None`, the principal is returned unchecked
    /// (`authDoubleCheck.ts:450-452`). S-SEC-02 changes this; the call site must pass a merchant id
    /// obtained from the resource, not from the request.
    pub fn require_merchant_scope(&self, merchant_id: Option<&str>) -> Result<(), AuthError> {
        let Some(merchant_id) = merchant_id else {
            return Ok(());
        };
        if self.kind == PrincipalKind::ApiToken && self.merchant_id.as_deref() != Some(merchant_id)
        {
            return Err(AuthError::token_merchant_scope_violation());
        }
        if self
            .merchant_id
            .as_deref()
            .is_some_and(|bound| bound != merchant_id)
        {
            return Err(AuthError::principal_merchant_scope_violation());
        }
        Ok(())
    }

    /// Refuse when `application_id` is set and the principal is restricted to other applications
    /// (`app_scope_ids`). An empty scope list means "the whole merchant" and an API token is bound
    /// by `applicationId` instead.
    pub fn require_application_scope(&self, application_id: Option<&str>) -> Result<(), AuthError> {
        let Some(application_id) = application_id else {
            return Ok(());
        };
        if self.app_scope_ids.is_empty() {
            return Ok(());
        }
        if self
            .app_scope_ids
            .iter()
            .any(|scope| scope == application_id)
        {
            Ok(())
        } else {
            Err(AuthError::new(
                403,
                "APP_SCOPE_VIOLATION",
                "The principal is restricted to other applications",
            ))
        }
    }

    /// The merchant view of this principal, for the catalogue helpers in
    /// [`crate::authorities`].
    #[must_use]
    pub fn as_merchant_principal(&self) -> MerchantPrincipal {
        MerchantPrincipal {
            kind: self.kind,
            role: self.role.clone().unwrap_or_default(),
            authorities: self.authorities.clone(),
        }
    }

    /// Convenience: the merchant authority check of [`crate::authorities::assert_authority`].
    pub fn require_merchant_authority(&self, required: &[&str]) -> Result<(), AuthError> {
        authorities::assert_authority(&self.as_merchant_principal(), required)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_token::{api_token_from_bytes, ApiToken, ExecutionPlane};
    use crate::channel::Audience;
    use crate::session::{sign_session, SessionClaims, VerifiedSession};
    use chrono::Utc;

    const MASTER: &str = "golden-master-key";

    fn session(
        channel: Channel,
        role: &str,
        merchant: Option<&str>,
        authorities: &[&str],
    ) -> VerifiedSession {
        let mut claims =
            SessionClaims::new("user-1", role).with_authorities(authorities.iter().copied());
        if let Some(merchant) = merchant {
            claims = claims.with_merchant(merchant);
        }
        let claims = claims.with_channel(channel).expect("channel");
        let token = sign_session(&claims, MASTER).expect("sign");
        crate::session::verify_session(
            &token,
            MASTER,
            Some(Audience::parse(channel.audience().expect("audience")).expect("audience")),
            Utc::now(),
        )
        .expect("verify")
    }

    fn staff() -> Principal {
        let verified = session(Channel::Admin, "COMPLIANCE", None, &["merchant:read", "*"]);
        Principal::from_session(
            &verified,
            "user-1",
            "COMPLIANCE",
            None,
            vec!["merchant:read".to_owned(), "*".to_owned()],
            vec![],
        )
    }

    fn merchant_user() -> Principal {
        let verified = session(
            Channel::Merchant,
            "MERCHANT_ADMIN",
            Some("merchant-1"),
            &["merchant:write"],
        );
        Principal::from_session(
            &verified,
            "user-2",
            "MERCHANT_ADMIN",
            Some("merchant-1".to_owned()),
            vec!["merchant:write".to_owned()],
            vec!["app-1".to_owned()],
        )
    }

    fn token_principal() -> Principal {
        let token = ApiToken::parse(&api_token_from_bytes(ExecutionPlane::Live, &[9_u8; 32]))
            .expect("token");
        Principal::from_api_token(
            &token,
            "token-1",
            Some("merchant-1".to_owned()),
            Some("app-1".to_owned()),
            vec!["link:write".to_owned()],
        )
    }

    #[test]
    fn staff_classification() {
        assert!(staff().is_staff());
        assert!(!staff().is_merchant());
        assert!(!merchant_user().is_staff());
        assert!(merchant_user().is_merchant());
        assert!(!token_principal().is_staff());
        assert!(token_principal().is_merchant());
        assert_eq!(
            merchant_user().require_staff().expect_err("merchant").code,
            "STAFF_PRINCIPAL_REQUIRED"
        );
        assert_eq!(
            staff().require_merchant().expect_err("staff").code,
            "MERCHANT_PRINCIPAL_REQUIRED"
        );
    }

    #[test]
    fn channel_guards_require_the_matching_audience() {
        // A merchant session presented as staff: staff guard first.
        assert!(merchant_user().require_merchant().is_ok());
        // An admin session cannot pass the merchant guard even without a merchant.
        assert_eq!(
            staff().require_merchant().expect_err("staff").code,
            "MERCHANT_PRINCIPAL_REQUIRED"
        );
        // A merchant-bound session on the wrong channel is refused with the audience error.
        let wrong_channel = session(
            Channel::Admin,
            "MERCHANT_ADMIN",
            Some("merchant-1"),
            &["merchant:write"],
        );
        let principal = Principal::from_session(
            &wrong_channel,
            "user-3",
            "MERCHANT_ADMIN",
            Some("merchant-1".to_owned()),
            vec!["merchant:write".to_owned()],
            vec![],
        );
        // Staff guard passes classification but refuses the admin guard's audience? The role starts
        // with MERCHANT_, so it is not staff at all.
        assert!(!principal.is_staff());
        assert_eq!(
            principal.require_merchant().expect_err("audience").code,
            "SESSION_AUDIENCE_INVALID"
        );
    }

    #[test]
    fn wildcard_is_staff_only() {
        assert!(staff().require_authorities(&["anything:write"]).is_ok());
        let merchant_with_wildcard = Principal {
            authorities: vec!["*".to_owned()],
            ..merchant_user()
        };
        assert_eq!(
            merchant_with_wildcard
                .require_authorities(&["link:write"])
                .expect_err("wildcard is staff only")
                .code,
            "AUTHORITY_REQUIRED"
        );
        // An empty requirement is always satisfied (parity).
        assert!(merchant_user().require_authorities(&[]).is_ok());
        assert!(merchant_user()
            .require_authorities(&["merchant:write", "user:manage"])
            .is_ok());
        assert_eq!(
            merchant_user()
                .require_authorities(&["token:manage"])
                .expect_err("missing")
                .code,
            "AUTHORITY_REQUIRED"
        );
    }

    #[test]
    fn merchant_scope_matches_the_ts_rules() {
        assert!(merchant_user()
            .require_merchant_scope(Some("merchant-1"))
            .is_ok());
        assert_eq!(
            merchant_user()
                .require_merchant_scope(Some("merchant-2"))
                .expect_err("scope")
                .code,
            "MERCHANT_SCOPE_VIOLATION"
        );
        assert_eq!(
            merchant_user()
                .require_merchant_scope(Some("merchant-2"))
                .expect_err("scope")
                .message,
            "The principal is not bound to this merchant"
        );
        // API tokens use the token wording.
        assert_eq!(
            token_principal()
                .require_merchant_scope(Some("merchant-2"))
                .expect_err("scope")
                .message,
            "The token is not bound to this merchant"
        );
        assert!(token_principal()
            .require_merchant_scope(Some("merchant-1"))
            .is_ok());
        // PARITY (S-SEC-02): a missing merchant id is unchecked.
        assert!(staff().require_merchant_scope(None).is_ok());
        assert!(token_principal().require_merchant_scope(None).is_ok());
        // PARITY: a staff principal has no merchant, so a requested merchant is not cross-checked
        // either (`principal.merchantId && …` is falsy in `authDoubleCheck.ts:456`).
        assert!(staff().require_merchant_scope(Some("merchant-1")).is_ok());
    }

    #[test]
    fn application_scope_restricts_scoped_users() {
        assert!(merchant_user()
            .require_application_scope(Some("app-1"))
            .is_ok());
        assert_eq!(
            merchant_user()
                .require_application_scope(Some("app-2"))
                .expect_err("scope")
                .code,
            "APP_SCOPE_VIOLATION"
        );
        assert!(merchant_user().require_application_scope(None).is_ok());
        // Unscoped principal: the whole merchant.
        let unscoped = Principal {
            app_scope_ids: vec![],
            ..merchant_user()
        };
        assert!(unscoped.require_application_scope(Some("app-9")).is_ok());
    }

    #[test]
    fn merchant_authority_helpers_use_the_implications() {
        // `merchant:write` implies `link:write` and (as MERCHANT_ADMIN) `user:manage`.
        assert!(merchant_user()
            .require_merchant_authority(&["link:write"])
            .is_ok());
        assert!(merchant_user()
            .require_merchant_authority(&["user:manage"])
            .is_ok());
        // `report_engine:author` is implied for a MERCHANT_ADMIN too.
        assert!(merchant_user()
            .require_merchant_authority(&["report_engine:author"])
            .is_ok());
        assert_eq!(
            merchant_user()
                .require_merchant_authority(&["merchant:approve", "system:write"])
                .expect_err("denied")
                .code,
            "AUTHORITY_REQUIRED"
        );
    }
}
