//! Worker runtime and the concrete background workers (P6).
//!
//! Ports the shape of `core-back/engine/workers/workerRuntime.ts` and
//! `productionRuntime.ts` (jitter, single-tick execution, singleton advisory locks, cancellation,
//! `/health.workers`) plus the concrete workers of the P6 task catalogue:
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`outbox`] | `lib/storageEngine/outboxWorkers.ts` (`OutboxRelayWorker`) |
//! | [`inbox`] | `engine/workers/InboundInboxWorker.ts` |
//! | [`expiry`] | `engine/workers/ExpirySweeperWorker.ts` |
//! | [`poll`] | `engine/workers/PollWorker.ts` + `GatewayInquirySchedules.ts` |
//! | [`checkpoint`] | `engine/ledger/CheckpointService.ts` + `LedgerCheckpointWorker.ts` |
//! | [`monitor`] | `engine/workers/PlatformMonitorWorker.ts` |
//! | [`monitor_checks`] | `engine/workers/{platform,backup,communication,objectStorage,moneyPath}MonitorChecks.ts` |
//! | [`cases`] | `lib/operatorCases/{caseCatalog,caseService}.ts`, `engine/ledger/ledgerAlerts.ts` |
//! | [`remaining_workers`] | `JournalPartitionWorker`, `JoinRequestExpiryWorker`, `ExpiryHousekeepingWorker`, `StatementScheduleWorker`, `ConsistencyAuditWorker`, `RetentionWorker` |
//! | [`cron`] | `lib/cron.ts` (five-field cron in `Africa/Tripoli`) |
//! | [`notices`] | `lib/automationNotices.ts` (bilingual notice outbox) |
//!
//! Still not ported here (P6 remainder): `AuditShipperWorker`, `BackgroundJobWorker` and its handlers,
//! the notification/webhook workers, the deadline/KYB/expiry-notice families, the compliance
//! workers, `ObjectStorageMaintenance`, `GatewayHealth`, `LedgerShardScaler`, `PeriodicScreening`,
//! `CommissionNetting` and the full operator-case catalogue/API. See `README.md`.
//!
//! Money is `rust_decimal::Decimal`; no floating point type is used for money. Secrets, ciphertext
//! and webhook payload bodies are never logged.

#![forbid(unsafe_code)]

pub mod cases;
pub mod checkpoint;
pub mod cron;
pub mod db;
pub mod expiry;
pub mod health;
pub mod inbox;
pub mod leader;
pub mod monitor;
pub mod monitor_checks;
pub mod notices;
pub mod outbox;
pub mod poll;
pub mod remaining_workers;
pub mod runtime;

pub use cases::{
    CaseKind, CaseMetadata, CaseTypeDefinition, KeyedCaseInput, KeyedCaseResult, MonitorPriority,
    SystemAudit,
};
pub use checkpoint::{
    should_auto_repair, AutoRepairPolicy, AutoRepairVerdict, CheckpointCandidate, CheckpointConfig,
    CheckpointService, LedgerCheckpointWorker, ShardCaptureResult, ShardCaptureStatus,
};
pub use cron::{
    last_scheduled_at_or_before, local_clock, parse_cron, time_zone_offset_minutes, CronError,
    LocalClock, ParsedCron, DEFAULT_MAX_LOOKBACK_DAYS, DEFAULT_TIME_ZONE,
    TRIPOLI_UTC_OFFSET_MINUTES,
};
pub use expiry::{
    AttemptRow, ExpirySweeperConfig, ExpirySweeperWorker, InquiryOutcome, InquiryPort,
};
pub use health::{WorkerSnapshot, WorkerState};
pub use inbox::{
    InboundDecision, InboundError, InboundEventHandler, InboundEventRow, InboundInboxWorker,
    InboundOutcome, InboxConfig,
};
pub use leader::PgLeaderLock;
pub use monitor::{
    MonitorCaseClear, MonitorCaseRaise, MonitorCaseSink, MonitorCheckResult, MonitorConfig,
    MonitorContext, MonitorFinding, MonitorTickSummary, PgMonitorCaseSink, PlatformMonitorCheck,
    PlatformMonitorWorker,
};
pub use monitor_checks::{
    create_standard_platform_checks, BackupCheck, BackupOverview, BackupOverviewSource,
    CertificateExpiryCheck, CertificateFile, CertificateValidityReader,
    CommunicationReadinessCheck, CommunicationSettingsSource, ObjectStorageCheck,
    ObjectStorageProbe, ServiceProbe, ServiceReachabilityCheck, StaleUnknownCheck,
    StandardChecksConfig, UnscheduledRefundCheck, WorkerStalenessCheck,
};
pub use notices::{
    bilingual_notice, ensure_notice_templates, has_real_address, mask_notice_address, queue_notice,
    NoticeAddressCipher, NoticeDefinition, NoticeTemplate, QueueNoticeInput, MAX_EVENT_ID_LENGTH,
    NOTICE_ADDRESS_AAD,
};
pub use outbox::{
    DrainOutcome, NoopConsumer, OutboxBacklogStats, OutboxConsumer, OutboxEnvelope,
    OutboxParkedEvent, OutboxRegistry, OutboxRelayConfig, OutboxRelayCounters, OutboxRelayWorker,
    DEFAULT_KNOWN_TOPICS, DEFAULT_OUTBOX_MAX_ATTEMPTS, OUTBOX_UNKNOWN_TOPIC_ERROR,
};
pub use poll::{compute_backoff_delay_seconds, PollConfig, PollPolicy, PollWorker};
pub use remaining_workers::{
    create_remaining_workers, retention_days_from_setting, sanitize_error_message,
    statement_missing_subject_key, ConsistencyAuditConfig, ConsistencyAuditSummary,
    ConsistencyAuditWorker, ExpiredJoinRequest, ExpiryHousekeepingConfig, ExpiryHousekeepingWorker,
    HousekeepingCounts, HousekeepingPass, HousekeepingSummary, JoinRequestExpiryConfig,
    JoinRequestExpiryReason, JoinRequestExpiryWorker, JournalPartitionConfig, JournalPartitionTick,
    JournalPartitionWorker, PartitionInspection, RemainingWorkerError, RemainingWorkersConfig,
    RetentionConfig, RetentionSummary, RetentionWorker, StatementScheduleConfig,
    StatementScheduleSummary, StatementScheduleWorker, APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE,
    DAYS_PER_YEAR, DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS, DEFAULT_RETENTION_DAYS,
    JOURNAL_PARTITION_CASE_DEFAULT_ROWS, JOURNAL_PARTITION_CASE_ENSURE_FAILED,
    MAX_PARTITION_MONTHS_AHEAD, REMAINING_WORKER_NAMES, RETENTION_MS_PER_DAY,
    RETENTION_SETTING_KEY, SLOT_HOLDING_STATUSES,
};
pub use runtime::{
    LeaderLock, LocalLeaderLock, Worker, WorkerContext, WorkerError, WorkerHandle, WorkerOutcome,
    WorkerRuntime, WorkerRuntimeConfig,
};
