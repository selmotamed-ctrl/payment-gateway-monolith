//! Object-storage SDK policy (namespaces, paths, GC and retention).
//!
//! Port of `core-back/lib/objectStorageSdk/{types,index}.ts` pure parts. Database and blob I/O
//! stay in the services; these rules are shared and unit-tested here.

#![forbid(unsafe_code)]

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::blob_store::BucketTier;

pub const NAMESPACE_COUNT: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StorageNamespace {
    KybDocuments,
    ReconStatements,
    RegulatoryReports,
    ReportStudioAssets,
    MerchantStatements,
    DisputeEvidence,
    AmlCaseAttachments,
    SystemBrandAssets,
    BackupArtifacts,
}

impl StorageNamespace {
    #[must_use]
    pub fn all() -> [Self; NAMESPACE_COUNT] {
        [
            Self::KybDocuments,
            Self::ReconStatements,
            Self::RegulatoryReports,
            Self::ReportStudioAssets,
            Self::MerchantStatements,
            Self::DisputeEvidence,
            Self::AmlCaseAttachments,
            Self::SystemBrandAssets,
            Self::BackupArtifacts,
        ]
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KybDocuments => "KYB_DOCUMENTS",
            Self::ReconStatements => "RECON_STATEMENTS",
            Self::RegulatoryReports => "REGULATORY_REPORTS",
            Self::ReportStudioAssets => "REPORT_STUDIO_ASSETS",
            Self::MerchantStatements => "MERCHANT_STATEMENTS",
            Self::DisputeEvidence => "DISPUTE_EVIDENCE",
            Self::AmlCaseAttachments => "AML_CASE_ATTACHMENTS",
            Self::SystemBrandAssets => "SYSTEM_BRAND_ASSETS",
            Self::BackupArtifacts => "BACKUP_ARTIFACTS",
        }
    }

    #[must_use]
    pub fn path_segment(self) -> &'static str {
        // TS: `namespace.toLowerCase()`.
        match self {
            Self::KybDocuments => "kyb_documents",
            Self::ReconStatements => "recon_statements",
            Self::RegulatoryReports => "regulatory_reports",
            Self::ReportStudioAssets => "report_studio_assets",
            Self::MerchantStatements => "merchant_statements",
            Self::DisputeEvidence => "dispute_evidence",
            Self::AmlCaseAttachments => "aml_case_attachments",
            Self::SystemBrandAssets => "system_brand_assets",
            Self::BackupArtifacts => "backup_artifacts",
        }
    }

    #[must_use]
    pub fn policy(self) -> &'static NamespacePolicy {
        match self {
            Self::KybDocuments => &KYB_DOCUMENTS,
            Self::ReconStatements => &RECON_STATEMENTS,
            Self::RegulatoryReports => &REGULATORY_REPORTS,
            Self::ReportStudioAssets => &REPORT_STUDIO_ASSETS,
            Self::MerchantStatements => &MERCHANT_STATEMENTS,
            Self::DisputeEvidence => &DISPUTE_EVIDENCE,
            Self::AmlCaseAttachments => &AML_CASE_ATTACHMENTS,
            Self::SystemBrandAssets => &SYSTEM_BRAND_ASSETS,
            Self::BackupArtifacts => &BACKUP_ARTIFACTS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidentialityTier {
    PublicBrand,
    Internal,
    Confidential,
    RestrictedPii,
}

#[derive(Debug, Clone)]
pub struct NamespacePolicy {
    pub namespace: StorageNamespace,
    pub default_bucket: BucketTier,
    pub allowed_mime_types: &'static [&'static str],
    pub max_byte_size: u64,
    pub requires_async_av_scan: bool,
    pub default_retention_days: i64,
    pub required_authority: &'static str,
    pub required_authorities: &'static [&'static str],
    pub confidentiality_tier: ConfidentialityTier,
}

static KYB_DOCUMENTS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::KybDocuments,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &["application/pdf", "image/png", "image/jpeg", "image/webp"],
    max_byte_size: 25 * 1024 * 1024,
    requires_async_av_scan: true,
    default_retention_days: 365 * 7,
    required_authority: "kyb:read",
    required_authorities: &["kyb:read", "compliance:read"],
    confidentiality_tier: ConfidentialityTier::RestrictedPii,
};

static RECON_STATEMENTS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::ReconStatements,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &[
        "text/csv",
        "text/plain",
        "application/xml",
        "application/json",
    ],
    max_byte_size: 100 * 1024 * 1024,
    requires_async_av_scan: false,
    default_retention_days: 365 * 7,
    required_authority: "reconciliation:read",
    required_authorities: &["reconciliation:read"],
    confidentiality_tier: ConfidentialityTier::Confidential,
};

static REGULATORY_REPORTS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::RegulatoryReports,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &[
        "application/pdf",
        "text/csv",
        "application/xml",
        "application/json",
        "text/plain",
        "application/zip",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    max_byte_size: 100 * 1024 * 1024,
    requires_async_av_scan: false,
    default_retention_days: 365 * 10,
    required_authority: "compliance:reports:read",
    required_authorities: &[
        "compliance:reports:read",
        "report:review",
        "report:approve",
        "compliance:write",
        "aml:write",
    ],
    confidentiality_tier: ConfidentialityTier::RestrictedPii,
};

static REPORT_STUDIO_ASSETS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::ReportStudioAssets,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &[
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/svg+xml",
        "font/ttf",
        "font/woff",
        "font/woff2",
        "application/zip",
    ],
    max_byte_size: 10 * 1024 * 1024,
    requires_async_av_scan: false,
    default_retention_days: 365 * 5,
    required_authority: "reports.studio.read",
    required_authorities: &[
        "reports.studio.read",
        "report_engine:run",
        "report_engine:author",
        "report:review",
    ],
    confidentiality_tier: ConfidentialityTier::Internal,
};

static MERCHANT_STATEMENTS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::MerchantStatements,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &["application/pdf", "text/csv", "application/json"],
    max_byte_size: 50 * 1024 * 1024,
    requires_async_av_scan: false,
    default_retention_days: 365 * 7,
    required_authority: "reports:read",
    required_authorities: &["reports:read"],
    confidentiality_tier: ConfidentialityTier::Confidential,
};

static DISPUTE_EVIDENCE: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::DisputeEvidence,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &["application/pdf", "image/png", "image/jpeg", "image/webp"],
    max_byte_size: 25 * 1024 * 1024,
    requires_async_av_scan: true,
    default_retention_days: 365 * 7,
    required_authority: "disputes:read",
    required_authorities: &["disputes:read", "dispute:read", "dispute:respond"],
    confidentiality_tier: ConfidentialityTier::Confidential,
};

static AML_CASE_ATTACHMENTS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::AmlCaseAttachments,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &[
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/csv",
        "application/json",
    ],
    max_byte_size: 50 * 1024 * 1024,
    requires_async_av_scan: true,
    default_retention_days: 365 * 10,
    required_authority: "compliance:aml:read",
    required_authorities: &[
        "compliance:aml:read",
        "aml.read_confidential",
        "aml:read",
        "aml:write",
    ],
    confidentiality_tier: ConfidentialityTier::RestrictedPii,
};

static SYSTEM_BRAND_ASSETS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::SystemBrandAssets,
    default_bucket: BucketTier::Hot,
    allowed_mime_types: &["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
    max_byte_size: 5 * 1024 * 1024,
    requires_async_av_scan: false,
    default_retention_days: 365,
    required_authority: "system:assets:read",
    required_authorities: &["system:assets:read", "gateway:read", "gateway:write"],
    confidentiality_tier: ConfidentialityTier::PublicBrand,
};

static BACKUP_ARTIFACTS: NamespacePolicy = NamespacePolicy {
    namespace: StorageNamespace::BackupArtifacts,
    default_bucket: BucketTier::Cold,
    allowed_mime_types: &[
        "application/octet-stream",
        "application/gzip",
        "application/json",
    ],
    max_byte_size: 1024 * 1024 * 1024,
    requires_async_av_scan: false,
    default_retention_days: 90,
    required_authority: "system:storage:admin",
    required_authorities: &["system:storage:admin"],
    confidentiality_tier: ConfidentialityTier::RestrictedPii,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageObjectStatus {
    Staging,
    QuarantinePendingAv,
    QuarantineRejected,
    Active,
    Purged,
}

impl StorageObjectStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "STAGING",
            Self::QuarantinePendingAv => "QUARANTINE_PENDING_AV",
            Self::QuarantineRejected => "QUARANTINE_REJECTED",
            Self::Active => "ACTIVE",
            Self::Purged => "PURGED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageHolderType {
    KybDocument,
    ReconRun,
    RegReportSchema,
    RegReportOutput,
    ReportAssetEntry,
    CatalogAsset,
    RailLogo,
    DisputeAttachment,
    AmlCaseEvidence,
}

impl StorageHolderType {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KybDocument => "KYB_DOCUMENT",
            Self::ReconRun => "RECON_RUN",
            Self::RegReportSchema => "REG_REPORT_SCHEMA",
            Self::RegReportOutput => "REG_REPORT_OUTPUT",
            Self::ReportAssetEntry => "REPORT_ASSET_ENTRY",
            Self::CatalogAsset => "CATALOG_ASSET",
            Self::RailLogo => "RAIL_LOGO",
            Self::DisputeAttachment => "DISPUTE_ATTACHMENT",
            Self::AmlCaseEvidence => "AML_CASE_EVIDENCE",
        }
    }
}

/// `buildStorageKey`: `{namespace}/{tenant|shared}/{yyyy}/{mm}/{objectId}.v1.enc`.
#[must_use]
pub fn build_storage_key(
    namespace: StorageNamespace,
    owner_merchant_id: Option<Uuid>,
    object_id: Uuid,
    now: DateTime<Utc>,
) -> String {
    let tenant = owner_merchant_id.map_or_else(|| "shared".to_owned(), |id| id.to_string());
    format!(
        "{}/{}/{}/{}/{}.v1.enc",
        namespace.path_segment(),
        tenant,
        now.format("%Y"),
        now.format("%m"),
        object_id
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageError {
    EmptyPayload,
    TooLarge {
        size: u64,
        max: u64,
    },
    MimeNotAllowed {
        detected: String,
        namespace: &'static str,
    },
    AuthorityRequired(&'static str),
}

/// Validate a stage upload before any bytes are written.
pub fn validate_stage(
    namespace: StorageNamespace,
    detected_mime: &str,
    byte_size: u64,
    authorities: &[String],
) -> Result<(), StageError> {
    let policy = namespace.policy();
    if byte_size == 0 {
        return Err(StageError::EmptyPayload);
    }
    if byte_size > policy.max_byte_size {
        return Err(StageError::TooLarge {
            size: byte_size,
            max: policy.max_byte_size,
        });
    }
    if !policy.allowed_mime_types.contains(&detected_mime) {
        return Err(StageError::MimeNotAllowed {
            detected: detected_mime.to_owned(),
            namespace: namespace.as_str(),
        });
    }
    if !policy
        .required_authorities
        .iter()
        .any(|authority| authorities.iter().any(|held| held == authority))
    {
        return Err(StageError::AuthorityRequired(policy.required_authority));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcDecision {
    Eligible,
    KeepActiveLock,
    KeepLegalHold,
    KeepRetention,
    KeepNotDue,
    KeepClaimed,
    KeepPurged,
}

/// A row snapshot needed to decide garbage collection (the TS re-reads under `FOR UPDATE`).
#[derive(Debug, Clone)]
pub struct GcCandidate {
    pub status: StorageObjectStatus,
    pub legal_hold: bool,
    pub active_locks: u32,
    pub retain_until: Option<DateTime<Utc>>,
    pub staging_expires_at: Option<DateTime<Utc>>,
    pub gc_eligible_at: Option<DateTime<Utc>>,
    pub gc_claim_token: Option<String>,
}

#[must_use]
pub fn gc_decision(candidate: &GcCandidate, now: DateTime<Utc>) -> GcDecision {
    if candidate.status == StorageObjectStatus::Purged {
        return GcDecision::KeepPurged;
    }
    if candidate.legal_hold {
        return GcDecision::KeepLegalHold;
    }
    if candidate.active_locks > 0 {
        return GcDecision::KeepActiveLock;
    }
    if candidate
        .retain_until
        .is_some_and(|retain_until| retain_until > now)
    {
        return GcDecision::KeepRetention;
    }
    if candidate.gc_claim_token.is_some() {
        return GcDecision::KeepClaimed;
    }
    let staging_eligible = matches!(
        candidate.status,
        StorageObjectStatus::Staging
            | StorageObjectStatus::QuarantinePendingAv
            | StorageObjectStatus::QuarantineRejected
    ) && candidate
        .staging_expires_at
        .is_some_and(|expires| expires <= now);
    let active_eligible = candidate.status == StorageObjectStatus::Active
        && candidate
            .gc_eligible_at
            .is_some_and(|eligible| eligible <= now);
    if staging_eligible || active_eligible {
        GcDecision::Eligible
    } else {
        GcDecision::KeepNotDue
    }
}

/// Retention end applied at `promote()` time, never at stage time.
#[must_use]
pub fn retention_until(activated_at: DateTime<Utc>, namespace: StorageNamespace) -> DateTime<Utc> {
    activated_at + Duration::days(namespace.policy().default_retention_days)
}

/// After the last lock is released, GC waits for the grace period or the retention end.
#[must_use]
pub fn gc_eligible_after_release(
    now: DateTime<Utc>,
    retain_until: Option<DateTime<Utc>>,
    grace_ms: i64,
) -> DateTime<Utc> {
    let grace_time = now + Duration::milliseconds(grace_ms);
    match retain_until {
        Some(retain_until) if retain_until > grace_time => retain_until,
        _ => grace_time,
    }
}

/// Orphan sweeping is unsafe when two control-plane databases share one vault.
#[must_use]
pub fn orphan_sweep_allowed(orphan_sweep_enabled: bool, execution_plane: &str) -> bool {
    orphan_sweep_enabled && execution_plane != "SANDBOX"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_matches_the_ts_builder() {
        let id = Uuid::parse_str("3e525d00-9bb9-40ea-9e28-9c32aa5999ba").expect("uuid");
        let now = DateTime::parse_from_rfc3339("2026-11-15T10:00:00Z")
            .expect("date")
            .with_timezone(&Utc);
        assert_eq!(
            build_storage_key(StorageNamespace::KybDocuments, None, id, now),
            "kyb_documents/shared/2026/11/3e525d00-9bb9-40ea-9e28-9c32aa5999ba.v1.enc"
        );
    }

    #[test]
    fn stage_validation_enforces_policy() {
        let authorities = vec!["kyb:read".to_owned()];
        assert!(validate_stage(
            StorageNamespace::KybDocuments,
            "application/pdf",
            1024,
            &authorities
        )
        .is_ok());
        assert_eq!(
            validate_stage(
                StorageNamespace::KybDocuments,
                "text/html",
                10,
                &authorities
            ),
            Err(StageError::MimeNotAllowed {
                detected: "text/html".to_owned(),
                namespace: "KYB_DOCUMENTS"
            })
        );
        assert_eq!(
            validate_stage(
                StorageNamespace::KybDocuments,
                "application/pdf",
                0,
                &authorities
            ),
            Err(StageError::EmptyPayload)
        );
    }

    #[test]
    fn gc_precedence_matches_the_ts_recheck() {
        let now = Utc::now();
        let base = GcCandidate {
            status: StorageObjectStatus::Active,
            legal_hold: false,
            active_locks: 0,
            retain_until: None,
            staging_expires_at: None,
            gc_eligible_at: Some(now - Duration::seconds(1)),
            gc_claim_token: None,
        };
        assert_eq!(gc_decision(&base, now), GcDecision::Eligible);
        assert_eq!(
            gc_decision(
                &GcCandidate {
                    legal_hold: true,
                    ..base.clone()
                },
                now
            ),
            GcDecision::KeepLegalHold
        );
        assert_eq!(
            gc_decision(
                &GcCandidate {
                    active_locks: 1,
                    ..base.clone()
                },
                now
            ),
            GcDecision::KeepActiveLock
        );
        assert_eq!(
            gc_decision(
                &GcCandidate {
                    retain_until: Some(now + Duration::days(1)),
                    ..base.clone()
                },
                now
            ),
            GcDecision::KeepRetention
        );
        assert_eq!(
            gc_decision(
                &GcCandidate {
                    gc_claim_token: Some("x".to_owned()),
                    ..base.clone()
                },
                now
            ),
            GcDecision::KeepClaimed
        );
    }

    #[test]
    fn orphan_sweep_is_plane_aware() {
        assert!(orphan_sweep_allowed(true, "LIVE"));
        assert!(!orphan_sweep_allowed(true, "SANDBOX"));
        assert!(!orphan_sweep_allowed(false, "LIVE"));
    }
}
