/**
 * Human labels and source links for the operator-case catalog.
 *
 * The backend decides the authoritative case type and available actions. This
 * file is the presentation layer: it keeps UUID-heavy technical cases readable
 * and links each type to the screen where the underlying condition is fixed.
 */
export type CaseTypeMeta = {
    label: string;
    meaning: string;
    next: string;
    sourceRoute?: string;
    sourceLabel?: string;
    tone?: "info" | "warning" | "danger" | "success";
};

const meta = (
    label: string,
    meaning: string,
    next: string,
    sourceRoute?: string,
    sourceLabel?: string,
    tone: CaseTypeMeta["tone"] = "info",
): CaseTypeMeta => ({ label, meaning, next, sourceRoute, sourceLabel, tone });

export const CASE_TYPE_META: Record<string, CaseTypeMeta> = {
    ATTEMPT_UNKNOWN: meta("Payment outcome unknown", "The gateway has not given a definitive result for this payment attempt.", "Inquire with the gateway; if it cannot answer, use statement evidence and a maker-checker outcome.", "Transactions", "Open transactions", "warning"),
    ATTEMPT_CONFLICT: meta("Conflicting payment signals", "Two trusted sources disagree about the payment result.", "Compare the gateway response and settlement evidence before proposing an outcome.", "Transactions", "Open transactions", "danger"),
    ATTEMPT_LATE_SUCCESS: meta("Late payment success", "A success arrived after the attempt had already reached a terminal state or the slot was gone.", "Check whether the settlement is in suspense and resolve it through the documented outcome.", "Transactions", "Open transactions", "warning"),
    ATTEMPT_HELD: meta("Payment held for compliance", "The payment is under an AML or risk hold.", "Resolve the hold in the AML case workflow; do not mark the payment failed.", "AmlCases", "Open AML cases", "danger"),
    ATTEMPT_MANUAL_REVIEW: meta("Payment needs manual review", "The engine deliberately paused this payment for a human decision.", "Read the gateway evidence and propose the documented attempt outcome.", "Transactions", "Open transactions", "warning"),
    ATTEMPT_INBOUND_FAILURE: meta("Webhook processing failed", "An inbound gateway message could not be processed after retries.", "Inspect the event and the attempt; use the gateway inquiry or statement evidence.", "Transactions", "Open transactions", "warning"),
    ATTEMPT_SUSPENSE: meta("Payment settled into suspense", "The money arrived but could not be credited to the normal merchant wallet.", "Review the suspense settlement and the related adjustment.", "Transactions", "Open transactions", "warning"),
    RECON_AMOUNT_MISMATCH: meta("Reconciliation amount mismatch", "The statement amount differs from the local attempt beyond tolerance.", "Open the reconciliation run and resolve the difference through an adjustment.", "Reconciliation", "Open reconciliation", "warning"),
    RECON_MISSING_AT_GATEWAY: meta("Missing at gateway", "The local attempt does not appear in the gateway statement.", "Review the statement and the attempt evidence; use reconciliation resolution.", "Reconciliation", "Open reconciliation", "warning"),
    RECON_MISSING_LOCALLY: meta("Missing locally", "The gateway statement contains a line with no matching local attempt.", "Match the line to an attempt or resolve it as an unmatched statement via reconciliation.", "Reconciliation", "Open reconciliation", "warning"),
    RECON_DUPLICATE: meta("Duplicate statement line", "A statement line appears to match the same payment more than once.", "Inspect the reconciliation item and resolve the duplicate.", "Reconciliation", "Open reconciliation", "warning"),
    RECON_UNMATCHED_STATEMENT: meta("Unmatched statement line", "A statement line could not be matched to a local attempt.", "Inspect the references and resolve it through reconciliation.", "Reconciliation", "Open reconciliation", "warning"),
    RECON_ITEM_EXCEPTION: meta("Reconciliation exception", "A statement line could not be reconciled automatically.", "Open the reconciliation run and resolve the exception.", "Reconciliation", "Open reconciliation", "warning"),
    RECON_OVERFLOW: meta("Reconciliation exception overflow", "A run produced more exceptions than the per-run case cap.", "Open the reconciliation run and work the full exception list.", "Reconciliation", "Open reconciliation", "warning"),

    BACKUP_FAILED: meta("Backup failed", "The latest backup for a target failed.", "Open the backup console, verify the target and run a successful backup; close the case only with evidence.", "SystemBackups", "Open backups", "danger"),
    BACKUP_DAEMON: meta("Backup daemon unreachable", "The backup daemon cannot be reached or is unhealthy.", "Open the backup console and check the daemon and its targets.", "SystemBackups", "Open backups", "danger"),
    BACKUP_UNHEALTHY: meta("Backup target unhealthy", "The backup daemon reports an unhealthy target.", "Open the backup console and inspect the unhealthy target.", "SystemBackups", "Open backups", "danger"),
    BACKUP_WAL_LAG: meta("WAL archive is behind", "Point-in-time recovery is behind the configured WAL lag limit.", "Open the backup console and investigate the WAL stream.", "SystemBackups", "Open backups", "danger"),
    BACKUP_STALE: meta("No recent full backup", "No passing full backup exists within the freshness window.", "Run a full backup and verify the result.", "SystemBackups", "Open backups", "danger"),
    BACKUP_DRILL_FAILED: meta("Restore drill failed", "The latest restore drill failed or found a ledger/audit mismatch.", "Open the backup console and inspect the drill report.", "SystemBackups", "Open backups", "danger"),
    BACKUP_DRILL_STALE: meta("Restore drill is stale", "No restore drill has run within the expected window.", "Run a restore drill and review its result.", "SystemBackups", "Open backups", "warning"),
    BACKUP_ALERT: meta("Backup alert", "The backup monitor raised an alert for the daemon or a target.", "Open the backup console and inspect the current backup state.", "SystemBackups", "Open backups", "warning"),

    WORKER_STALE: meta("Worker is stale", "A background worker has not made progress within its window.", "Check Jobs & Outbox and the worker health details.", "JobsOutbox", "Open jobs & outbox", "warning"),
    CHECKPOINT_STALE: meta("Ledger checkpoint is behind", "A ledger shard has not been checkpointed within the expected window.", "Open the ledger audit and inspect the account/shard checkpoint.", "Invariant", "Open ledger audit", "warning"),
    OUTBOX_AGE: meta("Outbox relay is behind", "Outbox events are older than the allowed age.", "Check Jobs & Outbox and the relay health.", "JobsOutbox", "Open jobs & outbox", "danger"),
    AUDIT_OUTBOX_AGE: meta("Audit relay is behind", "Audit events are waiting too long to be shipped.", "Check Jobs & Outbox and the audit shipper.", "JobsOutbox", "Open jobs & outbox", "danger"),
    BACKGROUND_JOB_AGE: meta("Background job is late", "A background job has been queued beyond its deadline.", "Open Jobs & Outbox and inspect the job queue.", "JobsOutbox", "Open jobs & outbox", "danger"),
    KYB_SCAN_BACKLOG: meta("KYB scanning backlog", "Documents are waiting too long for malware scanning.", "Open the KYB review and inspect pending documents.", "KybReview", "Open KYB review", "warning"),
    JOURNAL_DEFAULT_ROWS: meta("Journal rows in default partition", "Journal lines are stranded in the default partition.", "Open the ledger audit and run the partition maintenance procedure.", "Invariant", "Open ledger audit", "danger"),
    CERT_EXPIRY: meta("Certificate expiring", "A TLS or mTLS certificate is nearing expiry or cannot be read.", "Check the deployment certificates and renew the affected certificate.", undefined, undefined, "warning"),
    REDIS_UNREACHABLE: meta("Redis unreachable", "The cache/velocity store cannot be reached.", "Check the Redis service and the platform health.", undefined, undefined, "warning"),
    STALE_UNKNOWN_BACKLOG: meta("Stale UNKNOWN backlog", "Too many payment attempts remain in UNKNOWN.", "Open the payment attempts and work the UNKNOWN queue.", "Transactions", "Open transactions", "danger"),
    REFUND_UNSCHEDULED: meta("Refund has no inquiry", "A refund is stuck in EXECUTING without a scheduled inquiry.", "Open the adjustments and inspect the refund workflow.", "Transactions", "Open transactions", "danger"),
    OBJECT_STORAGE: meta("Object storage alert", "The shared object vault or quarantine is unhealthy.", "Open the object storage console and inspect the vault.", "SystemObjectStorage", "Open object storage", "danger"),
    MONITOR_CHECK_FAILED: meta("Platform monitor check failed", "A platform monitor check could not run.", "Inspect Jobs & Outbox and the monitor worker health.", "JobsOutbox", "Open jobs & outbox", "warning"),
    PLATFORM_ALERT: meta("Platform alert", "A platform monitor check found a condition that needs attention.", "Open the related platform screen and investigate the source.", undefined, undefined, "warning"),
    COMMUNICATION_UNCONFIGURED: meta("Communication is not configured", "Email delivery is not configured, so merchant registration and sign-in are in maintenance.", "Open Platform Settings → Communication and configure SMTP; the case clears automatically once email is ready.", "AdminPlatformSettings", "Open platform settings", "danger"),

    ROUTE_HEALTH: meta("Route health is degraded", "A gateway route is degraded or its breaker is open.", "Open the route health drawer and review the traffic and probes.", "GatewayRoutes", "Open routes", "danger"),
    ROUTE_OVERRIDE: meta("Route health override", "An operator forced a route health state.", "Open the route drawer and review the override and its expiry.", "GatewayRoutes", "Open routes", "warning"),
    ROUTE_OVERRIDE_REVIEW: meta("Route override needs review", "A forced route health state has been in place for a long time.", "Review the override and either extend it with approval or clear it.", "GatewayRoutes", "Open routes", "warning"),
    ROUTE_OVERRIDE_CONFLICT: meta("Route override conflict", "The forced route state conflicts with the computed health state.", "Open the route drawer and reconcile the override.", "GatewayRoutes", "Open routes", "danger"),

    REPORT_OVERDUE: meta("Regulatory report overdue", "A regulatory return is still a draft after its filing due date.", "Open the regulatory reports and file it or record the filing reference.", "AmlReports", "Open regulatory reports", "danger"),
    AML_SLA_BREACH: meta("AML review SLA breached", "An AML case has passed its review deadline.", "Open the AML case and continue the investigation or escalate it.", "AmlCases", "Open AML cases", "danger"),
    DISPUTE_EXPIRED: meta("Dispute evidence window expired", "The evidence deadline passed and the dispute is lost by default.", "Open the dispute and confirm the next finance/chargeback action.", "Disputes", "Open disputes", "warning"),
    DISPUTE_RULING_OVERDUE: meta("Dispute ruling overdue", "The provider has not ruled within the expected window.", "Open the dispute and follow up with the provider.", "Disputes", "Open disputes", "warning"),
    CASHOUT_SLA: meta("Cash-out SLA breached", "A cash-out is waiting past its operator SLA.", "Open the cash-out request and process it.", "CashOuts", "Open cash-outs", "warning"),
    EMERGENCY_UNRATIFIED: meta("Emergency action not ratified", "An emergency action missed its ratification deadline.", "Open the approvals and ratify, extend or revert the action.", "Approvals", "Open approvals", "danger"),
    EMERGENCY_LIFTED: meta("Emergency action lifted", "An emergency action was automatically lifted after the grace period.", "Open the approvals to review the action and its history.", "Approvals", "Open approvals", "warning"),

    CREDENTIAL_EXPIRING: meta("Credential expiring", "A gateway credential set is nearing expiry.", "Open credential sets and rotate or renew the credential.", "CredentialSets", "Open credential sets", "warning"),
    CREDENTIAL_EXPIRED: meta("Credential expired", "A gateway credential set has expired and its routes are hidden.", "Open credential sets and replace the credential.", "CredentialSets", "Open credential sets", "danger"),
    CREDENTIAL_FAILING: meta("Credential verification failing", "A scheduled credential re-verification is failing.", "Open credential sets and re-verify the credential.", "CredentialSets", "Open credential sets", "danger"),
    KYB_INFECTED: meta("KYB document quarantined", "A document failed the malware scan and was quarantined.", "Open the KYB review and replace or reject the document.", "KybReview", "Open KYB review", "danger"),
    KYB_SCAN_FAILED: meta("KYB scan repeatedly failed", "The scanner could not produce a verdict for a document.", "Open the KYB review and inspect the document/scanner state.", "KybReview", "Open KYB review", "warning"),

    LEDGER_INVARIANT: meta("Ledger invariant drift", "The system-wide double-entry invariant does not balance.", "Open the ledger audit and inspect the invariant evidence.", "Invariant", "Open ledger audit", "danger"),
    LEDGER_SHARD: meta("Ledger shard mismatch", "A ledger shard does not agree with its journal lines or sequence.", "Open the GL account and inspect/repair the shard.", "Invariant", "Open ledger audit", "danger"),
    LEDGER_PARTITION: meta("Journal partition maintenance", "Monthly journal partitions are missing or rows are stranded in the default partition.", "Open the ledger audit and run the partition maintenance procedure.", "Invariant", "Open ledger audit", "danger"),
    COMMISSION_RECEIVABLE_AGED: meta("Aged commission receivable", "A merchant-direct commission receivable is older than the aging window.", "Open the merchant finance view and resolve the receivable.", undefined, undefined, "warning"),
    LINK_SLOT_DRIFT: meta("Payment-link slot drift", "The link's locked counter disagrees with live attempts.", "Open the payment link and inspect/repair the slot counters.", "Transactions", "Open transactions", "warning"),
    OUTBOX_PARKED: meta("Outbox events parked", "Outbox events for a topic were parked after repeated failures.", "Open Jobs & Outbox and inspect the parked events.", "JobsOutbox", "Open jobs & outbox", "danger"),
    REFUND_INQUIRY: meta("Refund inquiry stuck", "A refund adjustment is stuck in EXECUTING.", "Open the adjustment and inspect the refund inquiry.", "Transactions", "Open transactions", "danger"),

    STATEMENT_MISSING: meta("Statement missing", "A scheduled statement did not arrive within its grace window.", "Open reconciliation and check the statement source.", "Reconciliation", "Open reconciliation", "warning"),
    STATEMENT_SCHEDULE_INVALID: meta("Statement schedule invalid", "A statement source has an invalid cron schedule.", "Open reconciliation sources and fix the schedule.", "Reconciliation", "Open reconciliation", "warning"),
    AUDIT_ANCHOR_INVALID: meta("Audit-chain anchor invalid", "The latest audit anchor does not verify.", "Open the audit log and investigate the anchor/chain evidence.", "AuditLog", "Open audit log", "danger"),
    AUDIT_CHAIN_REWRITTEN: meta("Audit chain rewritten", "An anchored audit row is missing or its hash changed.", "Open the audit log and investigate the rewritten history.", "AuditLog", "Open audit log", "danger"),
    AUDIT_CHAIN_BROKEN: meta("Audit chain broken", "An audit row does not chain to its predecessor.", "Open the audit log and investigate the broken link.", "AuditLog", "Open audit log", "danger"),
    REPORT_SCOPE_VIOLATION: meta("Merchant report scope violation", "A merchant-authored report returned a row outside its tenant scope.", "Open the report engine merchant oversight and suspend/investigate the report.", "ReportsMerchantReports", "Open merchant reports", "danger"),

    LEGACY_UNCLASSIFIED: meta("Unclassified case", "This case predates the type-aware case catalog and has no clear source.", "Read the case evidence and classify or close it with a documented resolution.", undefined, undefined, "warning"),
};

export const CASE_ACTION_LABELS: Record<string, string> = {
    ACKNOWLEDGE: "Acknowledge",
    OPEN_SOURCE: "Open source",
    INQUIRE: "Inquire gateway",
    MARK_SUCCEEDED: "Mark succeeded",
    MARK_FAILED: "Mark failed",
    CLOSE_CASE: "Close case",
};

export const CASE_TYPE_OPTIONS = Object.entries(CASE_TYPE_META).map(([value, entry]) => ({
    title: entry.label,
    value,
}));

export const caseTypeMeta = (code: string | null | undefined): CaseTypeMeta =>
    CASE_TYPE_META[String(code ?? "")] ?? CASE_TYPE_META.LEGACY_UNCLASSIFIED!;
