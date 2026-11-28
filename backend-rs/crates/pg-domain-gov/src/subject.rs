//! Approval subject taxonomy and checker roles.
//!
//! Port of `core-back/lib/approvalQueue.ts` (`APPROVAL_DOMAIN_SUBJECT_TYPES`,
//! `APPROVAL_SUBJECT_TYPE_ALIASES`, `normalizeApprovalSubjectType`, `approvalDomain`,
//! `approvalSubjectRequiresConfidentialAmlAccess`) and the `DOMAIN_CHECKER_ROLES` table of
//! `core-back/engine/governance/GovernanceExecution.ts:4154-4192`.
//!
//! The coordinator's brief listed `MERCHANT_EDIT`, `PAYOUT_ACCOUNT_CHANGE`, `USER_CREATE`,
//! `USER_STATUS` and `CASH_OUT` as subject types. They are **not** approval subject types in the
//! TS tree: they are audit actions or domain concepts. The enum below is the real catalogue:
//! every approval domain entry, plus `REPORT_AML_BYPASS` (its own route in
//! `api/internal/adminReportEngine.ts`) and `BENEFICIAL_OWNER` (checker role only).

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Staff roles that can check an approval (the ten design roles plus the merchant roles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Role {
    GatewayAdmin,
    SecurityAdmin,
    Finance,
    Operator,
    Compliance,
    Mlro,
    Support,
    MerchantAdmin,
    MerchantStaff,
    MerchantCashier,
}

impl Role {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GatewayAdmin => "GATEWAY_ADMIN",
            Self::SecurityAdmin => "SECURITY_ADMIN",
            Self::Finance => "FINANCE",
            Self::Operator => "OPERATOR",
            Self::Compliance => "COMPLIANCE",
            Self::Mlro => "MLRO",
            Self::Support => "SUPPORT",
            Self::MerchantAdmin => "MERCHANT_ADMIN",
            Self::MerchantStaff => "MERCHANT_STAFF",
            Self::MerchantCashier => "MERCHANT_CASHIER",
        }
    }

    /// Parse an exact wire role. Unknown roles are `None` (the TS keeps them as strings and lets
    /// the domain table reject them).
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value.trim() {
            "GATEWAY_ADMIN" => Self::GatewayAdmin,
            "SECURITY_ADMIN" => Self::SecurityAdmin,
            "FINANCE" => Self::Finance,
            "OPERATOR" => Self::Operator,
            "COMPLIANCE" => Self::Compliance,
            "MLRO" => Self::Mlro,
            "SUPPORT" => Self::Support,
            "MERCHANT_ADMIN" => Self::MerchantAdmin,
            "MERCHANT_STAFF" => Self::MerchantStaff,
            "MERCHANT_CASHIER" => Self::MerchantCashier,
            _ => return None,
        })
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `APPROVAL_DOMAIN_SUBJECT_TYPES` keys, plus `OTHER` for an unknown subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalDomain {
    Onboarding,
    Merchant,
    Finance,
    Compliance,
    Operations,
    Gateway,
    Security,
    Settings,
    Other,
}

impl ApprovalDomain {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Onboarding => "ONBOARDING",
            Self::Merchant => "MERCHANT",
            Self::Finance => "FINANCE",
            Self::Compliance => "COMPLIANCE",
            Self::Operations => "OPERATIONS",
            Self::Gateway => "GATEWAY",
            Self::Security => "SECURITY",
            Self::Settings => "SETTINGS",
            Self::Other => "OTHER",
        }
    }
}

impl std::fmt::Display for ApprovalDomain {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Every `approval_requests.subject_type` value the code base writes or documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalSubjectType {
    // ONBOARDING
    JoinRequest,
    KybDocument,
    // MERCHANT
    Merchant,
    Application,
    Wallet,
    PosTerminal,
    // FINANCE
    Adjustment,
    CashoutRequest,
    CommissionProfile,
    VelocityRule,
    GlShardRepair,
    // COMPLIANCE
    AmlCase,
    AmlRule,
    ReportingRule,
    ReportingRuleSchemaBinding,
    RegulatoryReport,
    RegulatoryReportSchema,
    FilingAdapter,
    // OPERATIONS
    OperatorCase,
    // GATEWAY
    GatewayVersion,
    Gateway,
    CredentialSet,
    RouteHealthOverride,
    // SECURITY
    User,
    BackupPolicy,
    StorageLegalHold,
    // SETTINGS
    PlatformSetting,
    // Outside the domain map but real approval subjects / checker rules.
    ReportAmlBypass,
    BeneficialOwner,
}

impl ApprovalSubjectType {
    /// The catalogue in `APPROVAL_DOMAIN_SUBJECT_TYPES` order, then the two extra subjects.
    pub const ALL: &'static [Self] = &[
        Self::JoinRequest,
        Self::KybDocument,
        Self::Merchant,
        Self::Application,
        Self::Wallet,
        Self::PosTerminal,
        Self::Adjustment,
        Self::CashoutRequest,
        Self::CommissionProfile,
        Self::VelocityRule,
        Self::GlShardRepair,
        Self::AmlCase,
        Self::AmlRule,
        Self::ReportingRule,
        Self::ReportingRuleSchemaBinding,
        Self::RegulatoryReport,
        Self::RegulatoryReportSchema,
        Self::FilingAdapter,
        Self::OperatorCase,
        Self::GatewayVersion,
        Self::Gateway,
        Self::CredentialSet,
        Self::RouteHealthOverride,
        Self::User,
        Self::BackupPolicy,
        Self::StorageLegalHold,
        Self::PlatformSetting,
        Self::ReportAmlBypass,
        Self::BeneficialOwner,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::JoinRequest => "JOIN_REQUEST",
            Self::KybDocument => "KYB_DOCUMENT",
            Self::Merchant => "MERCHANT",
            Self::Application => "APPLICATION",
            Self::Wallet => "WALLET",
            Self::PosTerminal => "POS_TERMINAL",
            Self::Adjustment => "ADJUSTMENT",
            Self::CashoutRequest => "CASHOUT_REQUEST",
            Self::CommissionProfile => "COMMISSION_PROFILE",
            Self::VelocityRule => "VELOCITY_RULE",
            Self::GlShardRepair => "GL_SHARD_REPAIR",
            Self::AmlCase => "AML_CASE",
            Self::AmlRule => "AML_RULE",
            Self::ReportingRule => "REPORTING_RULE",
            Self::ReportingRuleSchemaBinding => "REPORTING_RULE_SCHEMA_BINDING",
            Self::RegulatoryReport => "REGULATORY_REPORT",
            Self::RegulatoryReportSchema => "REGULATORY_REPORT_SCHEMA",
            Self::FilingAdapter => "FILING_ADAPTER",
            Self::OperatorCase => "OPERATOR_CASE",
            Self::GatewayVersion => "GATEWAY_VERSION",
            Self::Gateway => "GATEWAY",
            Self::CredentialSet => "CREDENTIAL_SET",
            Self::RouteHealthOverride => "ROUTE_HEALTH_OVERRIDE",
            Self::User => "USER",
            Self::BackupPolicy => "BACKUP_POLICY",
            Self::StorageLegalHold => "STORAGE_LEGAL_HOLD",
            Self::PlatformSetting => "PLATFORM_SETTING",
            Self::ReportAmlBypass => "REPORT_AML_BYPASS",
            Self::BeneficialOwner => "BENEFICIAL_OWNER",
        }
    }

    /// `approvalDomain(subjectType)`.
    #[must_use]
    pub const fn domain(self) -> ApprovalDomain {
        match self {
            Self::JoinRequest | Self::KybDocument => ApprovalDomain::Onboarding,
            Self::Merchant | Self::Application | Self::Wallet | Self::PosTerminal => {
                ApprovalDomain::Merchant
            }
            Self::Adjustment
            | Self::CashoutRequest
            | Self::CommissionProfile
            | Self::VelocityRule
            | Self::GlShardRepair => ApprovalDomain::Finance,
            Self::AmlCase
            | Self::AmlRule
            | Self::ReportingRule
            | Self::ReportingRuleSchemaBinding
            | Self::RegulatoryReport
            | Self::RegulatoryReportSchema
            | Self::FilingAdapter => ApprovalDomain::Compliance,
            Self::OperatorCase => ApprovalDomain::Operations,
            Self::GatewayVersion
            | Self::Gateway
            | Self::CredentialSet
            | Self::RouteHealthOverride => ApprovalDomain::Gateway,
            Self::User | Self::BackupPolicy | Self::StorageLegalHold => ApprovalDomain::Security,
            Self::PlatformSetting => ApprovalDomain::Settings,
            Self::ReportAmlBypass | Self::BeneficialOwner => ApprovalDomain::Other,
        }
    }

    /// `approvalSubjectRequiresConfidentialAmlAccess`: only the AML case row carries AML metadata.
    #[must_use]
    pub const fn requires_confidential_aml_access(self) -> bool {
        matches!(self, Self::AmlCase)
    }

    /// `DOMAIN_CHECKER_ROLES`. `None` means "no domain rule: the generic approval authority governs".
    #[must_use]
    pub const fn domain_checker_roles(self) -> Option<&'static [Role]> {
        const FINANCE: &[Role] = &[Role::Finance];
        const MLRO: &[Role] = &[Role::Mlro];
        const COMPLIANCE_MLRO: &[Role] = &[Role::Mlro, Role::Compliance];
        const SECURITY_FINANCE: &[Role] = &[Role::SecurityAdmin, Role::Finance];
        match self {
            Self::Adjustment | Self::GlShardRepair | Self::Wallet => Some(FINANCE),
            Self::AmlCase | Self::AmlRule | Self::RegulatoryReport | Self::FilingAdapter => {
                Some(MLRO)
            }
            Self::ReportingRule
            | Self::ReportingRuleSchemaBinding
            | Self::RegulatoryReportSchema => Some(COMPLIANCE_MLRO),
            Self::OperatorCase => Some(&[
                Role::Finance,
                Role::Operator,
                Role::Compliance,
                Role::SecurityAdmin,
            ]),
            Self::JoinRequest => Some(&[Role::Operator, Role::Compliance, Role::Mlro]),
            Self::Merchant => Some(&[Role::Compliance, Role::Finance, Role::Mlro]),
            Self::CommissionProfile | Self::VelocityRule => Some(SECURITY_FINANCE),
            Self::Application | Self::PosTerminal => {
                Some(&[Role::Operator, Role::Compliance, Role::Finance])
            }
            Self::User | Self::GatewayVersion | Self::RouteHealthOverride => {
                Some(&[Role::SecurityAdmin])
            }
            Self::StorageLegalHold => Some(&[Role::SecurityAdmin, Role::Compliance]),
            Self::BackupPolicy => Some(SECURITY_FINANCE),
            Self::PlatformSetting => Some(&[Role::Mlro, Role::SecurityAdmin, Role::Compliance]),
            Self::BeneficialOwner => Some(&[Role::Compliance]),
            // The dedicated `/report-engine/aml-bypass/:id/*` routes accept MLRO and Security Admin.
            Self::ReportAmlBypass => Some(&[Role::Mlro, Role::SecurityAdmin]),
            // No domain rule in `DOMAIN_CHECKER_ROLES`.
            Self::KybDocument | Self::CashoutRequest | Self::Gateway | Self::CredentialSet => None,
        }
    }

    /// Whether `executeApprovalSubject` has a branch for the subject.
    ///
    /// `BACKUP_POLICY` and `REPORT_AML_BYPASS` are executed by their own approve routes, not by the
    /// dispatcher; they are reported separately by [`Self::is_executed_outside_dispatcher`].
    #[must_use]
    pub const fn is_executable_by_dispatcher(self) -> bool {
        matches!(
            self,
            Self::AmlCase
                | Self::OperatorCase
                | Self::Adjustment
                | Self::RegulatoryReport
                | Self::FilingAdapter
                | Self::ReportingRuleSchemaBinding
                | Self::ReportingRule
                | Self::RegulatoryReportSchema
                | Self::AmlRule
                | Self::JoinRequest
                | Self::Merchant
                | Self::CommissionProfile
                | Self::VelocityRule
                | Self::GlShardRepair
                | Self::Wallet
                | Self::Application
                | Self::PosTerminal
                | Self::User
                | Self::StorageLegalHold
                | Self::RouteHealthOverride
                | Self::GatewayVersion
        )
    }

    /// Executed by a dedicated route instead of `executeApprovalSubject`.
    #[must_use]
    pub const fn is_executed_outside_dispatcher(self) -> bool {
        matches!(self, Self::BackupPolicy | Self::ReportAmlBypass)
    }
}

/// The alias table of `normalizeApprovalSubjectType`, keyed by the underscore-free token.
const SUBJECT_ALIASES: &[(&str, &str)] = &[
    ("JOINREQUEST", "JOIN_REQUEST"),
    ("KYBDOCUMENT", "KYB_DOCUMENT"),
    ("OPERATORCASE", "OPERATOR_CASE"),
    ("GATEWAYVERSION", "GATEWAY_VERSION"),
    ("AMLCASE", "AML_CASE"),
    ("AMLRULE", "AML_RULE"),
    ("REPORTINGRULE", "REPORTING_RULE"),
    ("REGULATORYREPORT", "REGULATORY_REPORT"),
    ("REGULATORYREPORTSCHEMA", "REGULATORY_REPORT_SCHEMA"),
    (
        "REPORTINGRULESCHEMABINDING",
        "REPORTING_RULE_SCHEMA_BINDING",
    ),
    ("FILINGADAPTER", "FILING_ADAPTER"),
    ("PLATFORMSETTING", "PLATFORM_SETTING"),
    ("COMMISSIONPROFILE", "COMMISSION_PROFILE"),
    ("VELOCITYRULE", "VELOCITY_RULE"),
    ("CASHOUTREQUEST", "CASHOUT_REQUEST"),
    ("CREDENTIALSET", "CREDENTIAL_SET"),
    ("POSTERMINAL", "POS_TERMINAL"),
];

/// `normalizeApprovalSubjectType`: trim, collapse `[\s-]+` to `_`, upper-case, then apply aliases.
#[must_use]
pub fn normalize_approval_subject_type(value: &str) -> String {
    let trimmed = value.trim();
    let mut token = String::with_capacity(trimmed.len());
    let mut in_run = false;
    for character in trimmed.chars() {
        if character.is_whitespace() || character == '-' {
            if !in_run {
                token.push('_');
            }
            in_run = true;
            continue;
        }
        in_run = false;
        for upper in character.to_uppercase() {
            token.push(upper);
        }
    }
    let key: String = token
        .chars()
        .filter(|character| *character != '_')
        .collect();
    for (alias, canonical) in SUBJECT_ALIASES {
        if *alias == key {
            return (*canonical).to_owned();
        }
    }
    token
}

impl ApprovalSubjectType {
    /// Parse tolerant input exactly like `normalizeApprovalSubjectType` + the catalogue lookup.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        let normalized = normalize_approval_subject_type(value);
        Self::ALL
            .iter()
            .copied()
            .find(|subject| subject.as_str() == normalized)
    }

    /// `approvalDomain` for untrusted input: unknown subjects map to [`ApprovalDomain::Other`].
    #[must_use]
    pub fn domain_of_wire(value: &str) -> ApprovalDomain {
        Self::from_wire(value).map_or(ApprovalDomain::Other, Self::domain)
    }

    /// `approvalSubjectTypeVariants`: normalized, PascalCase and lower-case forms.
    #[must_use]
    pub fn wire_variants(value: &str) -> Vec<String> {
        let normalized = normalize_approval_subject_type(value);
        if normalized.is_empty() {
            return Vec::new();
        }
        let pascal: String = normalized
            .to_lowercase()
            .split('_')
            .map(|part| {
                let mut characters = part.chars();
                match characters.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                    None => String::new(),
                }
            })
            .collect();
        let mut variants = vec![normalized.clone(), pascal, normalized.to_lowercase()];
        variants.dedup();
        variants
    }
}

impl std::fmt::Display for ApprovalSubjectType {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_aliases_and_separators() {
        assert_eq!(
            normalize_approval_subject_type("  kyb-document "),
            "KYB_DOCUMENT"
        );
        assert_eq!(
            normalize_approval_subject_type("posterminal"),
            "POS_TERMINAL"
        );
        assert_eq!(
            normalize_approval_subject_type("Reporting Rule Schema Binding"),
            "REPORTING_RULE_SCHEMA_BINDING"
        );
        assert_eq!(
            normalize_approval_subject_type("cashout-request"),
            "CASHOUT_REQUEST"
        );
        // A run of separators becomes exactly one underscore.
        assert_eq!(
            normalize_approval_subject_type("MERCHANT  -  EDIT"),
            "MERCHANT_EDIT"
        );
        assert_eq!(normalize_approval_subject_type(""), "");
    }

    #[test]
    fn unknown_subjects_are_other() {
        assert_eq!(
            ApprovalSubjectType::from_wire("MERCHANT_EDIT"),
            None,
            "MERCHANT_EDIT is an audit action, not an approval subject"
        );
        assert_eq!(
            ApprovalSubjectType::domain_of_wire("MERCHANT_EDIT"),
            ApprovalDomain::Other
        );
        assert_eq!(
            ApprovalSubjectType::from_wire("gateway_version"),
            Some(ApprovalSubjectType::GatewayVersion)
        );
    }

    #[test]
    fn domain_map_matches_the_ts_table() {
        let expected = [
            ("JOIN_REQUEST", ApprovalDomain::Onboarding),
            ("KYB_DOCUMENT", ApprovalDomain::Onboarding),
            ("MERCHANT", ApprovalDomain::Merchant),
            ("APPLICATION", ApprovalDomain::Merchant),
            ("WALLET", ApprovalDomain::Merchant),
            ("POS_TERMINAL", ApprovalDomain::Merchant),
            ("ADJUSTMENT", ApprovalDomain::Finance),
            ("CASHOUT_REQUEST", ApprovalDomain::Finance),
            ("COMMISSION_PROFILE", ApprovalDomain::Finance),
            ("VELOCITY_RULE", ApprovalDomain::Finance),
            ("GL_SHARD_REPAIR", ApprovalDomain::Finance),
            ("AML_CASE", ApprovalDomain::Compliance),
            ("AML_RULE", ApprovalDomain::Compliance),
            ("REPORTING_RULE", ApprovalDomain::Compliance),
            ("REPORTING_RULE_SCHEMA_BINDING", ApprovalDomain::Compliance),
            ("REGULATORY_REPORT", ApprovalDomain::Compliance),
            ("REGULATORY_REPORT_SCHEMA", ApprovalDomain::Compliance),
            ("FILING_ADAPTER", ApprovalDomain::Compliance),
            ("OPERATOR_CASE", ApprovalDomain::Operations),
            ("GATEWAY_VERSION", ApprovalDomain::Gateway),
            ("GATEWAY", ApprovalDomain::Gateway),
            ("CREDENTIAL_SET", ApprovalDomain::Gateway),
            ("ROUTE_HEALTH_OVERRIDE", ApprovalDomain::Gateway),
            ("USER", ApprovalDomain::Security),
            ("BACKUP_POLICY", ApprovalDomain::Security),
            ("STORAGE_LEGAL_HOLD", ApprovalDomain::Security),
            ("PLATFORM_SETTING", ApprovalDomain::Settings),
        ];
        for (wire, domain) in expected {
            let subject = ApprovalSubjectType::from_wire(wire).expect("catalogue subject");
            assert_eq!(subject.domain(), domain, "{wire}");
        }
        assert_eq!(ApprovalSubjectType::ALL.len(), 29);
    }

    #[test]
    fn checker_roles_match_the_dispatch_table() {
        assert_eq!(
            ApprovalSubjectType::Adjustment.domain_checker_roles(),
            Some(&[Role::Finance][..])
        );
        assert_eq!(
            ApprovalSubjectType::AmlCase.domain_checker_roles(),
            Some(&[Role::Mlro][..])
        );
        assert_eq!(
            ApprovalSubjectType::ReportingRule.domain_checker_roles(),
            Some(&[Role::Mlro, Role::Compliance][..])
        );
        assert_eq!(
            ApprovalSubjectType::CommissionProfile.domain_checker_roles(),
            Some(&[Role::SecurityAdmin, Role::Finance][..])
        );
        assert_eq!(
            ApprovalSubjectType::RouteHealthOverride.domain_checker_roles(),
            Some(&[Role::SecurityAdmin][..])
        );
        assert_eq!(
            ApprovalSubjectType::KybDocument.domain_checker_roles(),
            None
        );
        assert!(ApprovalSubjectType::AmlCase.requires_confidential_aml_access());
        assert!(!ApprovalSubjectType::Merchant.requires_confidential_aml_access());
    }

    #[test]
    fn dispatcher_coverage() {
        // The 21 dispatcher branches, plus the two dedicated routes, are exactly the catalogue's
        // executable subjects.
        let executable = ApprovalSubjectType::ALL
            .iter()
            .filter(|subject| subject.is_executable_by_dispatcher())
            .count();
        assert_eq!(executable, 21);
        assert!(ApprovalSubjectType::Application.is_executable_by_dispatcher());
        assert!(ApprovalSubjectType::Wallet.is_executable_by_dispatcher());
        assert!(ApprovalSubjectType::PosTerminal.is_executable_by_dispatcher());
        assert!(ApprovalSubjectType::BackupPolicy.is_executed_outside_dispatcher());
        assert!(ApprovalSubjectType::ReportAmlBypass.is_executed_outside_dispatcher());
        assert!(!ApprovalSubjectType::PlatformSetting.is_executable_by_dispatcher());
        assert!(!ApprovalSubjectType::CashoutRequest.is_executable_by_dispatcher());
    }

    #[test]
    fn variants_are_the_database_filter_forms() {
        assert_eq!(
            ApprovalSubjectType::wire_variants("regulatory_report"),
            vec![
                "REGULATORY_REPORT".to_owned(),
                "RegulatoryReport".to_owned(),
                "regulatory_report".to_owned()
            ]
        );
        assert!(ApprovalSubjectType::wire_variants("  ").is_empty());
    }
}
