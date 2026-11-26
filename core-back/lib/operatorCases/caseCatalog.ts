/**
 * Operator-case taxonomy.
 *
 * `kind` is the historical queue bucket. `caseType` is the condition that an
 * operator actually needs to read: a backup failure, a regulatory overdue
 * report, a payment UNKNOWN, a reconciliation exception, a route override, and
 * so on. The catalog is deliberately code-owned rather than a database enum so
 * a new automation can add a type without an enum migration.
 */

export type CaseDomain = "PAYMENTS" | "FINANCE" | "COMPLIANCE" | "OPERATIONS" | "GATEWAY" | "SECURITY";
export type CaseSource =
  | "ENGINE"
  | "RECONCILIATION"
  | "PLATFORM_MONITOR"
  | "ROUTE_HEALTH"
  | "DEADLINE"
  | "LEDGER"
  | "SECURITY"
  | "KYB"
  | "MANUAL"
  | "LEGACY";
export type CaseGroup =
  | "PAYMENTS"
  | "RECONCILIATION"
  | "PLATFORM"
  | "ROUTE_HEALTH"
  | "DEADLINES"
  | "CREDENTIALS_KYB"
  | "LEDGER"
  | "STATEMENTS"
  | "SECURITY"
  | "LEGACY";
export type CaseConfidentiality = "NORMAL" | "CONFIDENTIAL" | "AML";
export type CaseActionCode = "ACKNOWLEDGE" | "OPEN_SOURCE" | "INQUIRE" | "MARK_SUCCEEDED" | "MARK_FAILED" | "CLOSE_CASE";

export interface CaseActionDefinition {
  code: CaseActionCode;
  labelKey: string;
  requiresApproval: boolean;
  /** Fields shown by the generic resolution dialog. */
  fields?: Array<"resolutionCode" | "reference" | "reason" | "notes" | "providerReference" | "settledAmount">;
}

export interface CaseTypeDefinition {
  code: string;
  group: CaseGroup;
  domain: CaseDomain;
  source: CaseSource;
  confidentiality: CaseConfidentiality;
  labelKey: string;
  defaultPriority: "P1" | "P2" | "P3";
  defaultSlaHours: number;
  /** A monitor/route/statement/report condition that can resolve itself when the source clears. */
  autoClear: boolean;
  subjectType: string;
  actions: CaseActionCode[];
}

const ATTEMPT_ACTIONS: CaseActionCode[] = ["ACKNOWLEDGE", "OPEN_SOURCE", "INQUIRE", "MARK_SUCCEEDED", "MARK_FAILED", "CLOSE_CASE"];
const RECON_ACTIONS: CaseActionCode[] = ["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const OPERATIONS_ACTIONS: CaseActionCode[] = ["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const DEADLINE_ACTIONS: CaseActionCode[] = ["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const LEDGER_ACTIONS: CaseActionCode[] = ["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const LEGACY_ACTIONS: CaseActionCode[] = ["ACKNOWLEDGE", "CLOSE_CASE"];

const define = (input: {
  code: string;
  group: CaseGroup;
  domain: CaseDomain;
  source: CaseSource;
  subjectType: string;
  priority?: "P1" | "P2" | "P3";
  slaHours?: number;
  autoClear?: boolean;
  confidentiality?: CaseConfidentiality;
  actions?: CaseActionCode[];
}): CaseTypeDefinition => ({
  code: input.code,
  group: input.group,
  domain: input.domain,
  source: input.source,
  subjectType: input.subjectType,
  labelKey: `operatorCase.type.${input.code}`,
  defaultPriority: input.priority ?? (input.source === "PLATFORM_MONITOR" || input.source === "ROUTE_HEALTH" ? "P2" : "P1"),
  defaultSlaHours: input.slaHours ?? (input.priority === "P3" ? 72 : input.priority === "P2" ? 24 : 4),
  autoClear: input.autoClear ?? false,
  confidentiality: input.confidentiality ?? "NORMAL",
  actions: input.actions ?? OPERATIONS_ACTIONS,
});

const defs = [
  // Payment attempt / engine
  define({ code: "ATTEMPT_UNKNOWN", group: "PAYMENTS", domain: "PAYMENTS", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", actions: ATTEMPT_ACTIONS }),
  define({ code: "ATTEMPT_CONFLICT", group: "PAYMENTS", domain: "PAYMENTS", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", confidentiality: "CONFIDENTIAL", actions: ATTEMPT_ACTIONS }),
  define({ code: "ATTEMPT_LATE_SUCCESS", group: "PAYMENTS", domain: "PAYMENTS", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", priority: "P2", actions: ATTEMPT_ACTIONS }),
  define({ code: "ATTEMPT_HELD", group: "PAYMENTS", domain: "COMPLIANCE", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", confidentiality: "AML", actions: ATTEMPT_ACTIONS }),
  define({ code: "ATTEMPT_MANUAL_REVIEW", group: "PAYMENTS", domain: "PAYMENTS", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", actions: ATTEMPT_ACTIONS }),
  define({ code: "ATTEMPT_INBOUND_FAILURE", group: "PAYMENTS", domain: "PAYMENTS", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", priority: "P2", actions: ATTEMPT_ACTIONS }),
  define({ code: "ATTEMPT_SUSPENSE", group: "PAYMENTS", domain: "FINANCE", source: "ENGINE", subjectType: "PAYMENT_ATTEMPT", actions: ATTEMPT_ACTIONS }),

  // Reconciliation
  define({ code: "RECON_AMOUNT_MISMATCH", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_ITEM", priority: "P2", actions: RECON_ACTIONS }),
  define({ code: "RECON_MISSING_AT_GATEWAY", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_ITEM", priority: "P2", actions: RECON_ACTIONS }),
  define({ code: "RECON_MISSING_LOCALLY", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_ITEM", priority: "P2", actions: RECON_ACTIONS }),
  define({ code: "RECON_DUPLICATE", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_ITEM", priority: "P2", actions: RECON_ACTIONS }),
  define({ code: "RECON_UNMATCHED_STATEMENT", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_ITEM", priority: "P2", actions: RECON_ACTIONS }),
  define({ code: "RECON_ITEM_EXCEPTION", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_ITEM", priority: "P2", actions: RECON_ACTIONS }),
  define({ code: "RECON_OVERFLOW", group: "RECONCILIATION", domain: "FINANCE", source: "RECONCILIATION", subjectType: "RECONCILIATION_RUN", priority: "P2", actions: RECON_ACTIONS }),

  // Platform monitor / infrastructure
  define({ code: "BACKUP_FAILED", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_TARGET", autoClear: true }),
  define({ code: "BACKUP_DAEMON", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_DAEMON", autoClear: true }),
  define({ code: "BACKUP_UNHEALTHY", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_DAEMON", autoClear: true }),
  define({ code: "BACKUP_WAL_LAG", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_WAL", autoClear: true }),
  define({ code: "BACKUP_STALE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_TARGET", autoClear: true }),
  define({ code: "BACKUP_DRILL_FAILED", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_DRILL", autoClear: true }),
  define({ code: "BACKUP_DRILL_STALE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_DRILL", priority: "P2", autoClear: true }),
  define({ code: "BACKUP_ALERT", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKUP_DAEMON", autoClear: true }),
  define({ code: "WORKER_STALE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "WORKER", autoClear: true }),
  define({ code: "CHECKPOINT_STALE", group: "PLATFORM", domain: "FINANCE", source: "PLATFORM_MONITOR", subjectType: "GL_ACCOUNT_SHARD", priority: "P2", autoClear: true }),
  define({ code: "OUTBOX_AGE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "OUTBOX_TOPIC", autoClear: true }),
  define({ code: "AUDIT_OUTBOX_AGE", group: "PLATFORM", domain: "SECURITY", source: "PLATFORM_MONITOR", subjectType: "AUDIT_OUTBOX", autoClear: true }),
  define({ code: "BACKGROUND_JOB_AGE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "BACKGROUND_JOB_QUEUE", autoClear: true }),
  define({ code: "KYB_SCAN_BACKLOG", group: "PLATFORM", domain: "COMPLIANCE", source: "PLATFORM_MONITOR", subjectType: "KYB_SCAN", priority: "P2", autoClear: true, confidentiality: "CONFIDENTIAL" }),
  define({ code: "JOURNAL_DEFAULT_ROWS", group: "PLATFORM", domain: "FINANCE", source: "PLATFORM_MONITOR", subjectType: "LEDGER", autoClear: true }),
  define({ code: "CERT_EXPIRY", group: "PLATFORM", domain: "SECURITY", source: "PLATFORM_MONITOR", subjectType: "CERTIFICATE", autoClear: true }),
  define({ code: "REDIS_UNREACHABLE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "REDIS", priority: "P2", autoClear: true }),
  define({ code: "STALE_UNKNOWN_BACKLOG", group: "PLATFORM", domain: "PAYMENTS", source: "PLATFORM_MONITOR", subjectType: "PAYMENT_ATTEMPT", autoClear: true }),
  define({ code: "REFUND_UNSCHEDULED", group: "PLATFORM", domain: "FINANCE", source: "PLATFORM_MONITOR", subjectType: "ADJUSTMENT", autoClear: true }),
  define({ code: "OBJECT_STORAGE", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "OBJECT_STORAGE", autoClear: true }),
  define({ code: "MONITOR_CHECK_FAILED", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "PLATFORM_CHECK", priority: "P2", autoClear: true }),
  define({ code: "PLATFORM_ALERT", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "PLATFORM_CHECK", autoClear: true }),
  define({ code: "COMMUNICATION_UNCONFIGURED", group: "PLATFORM", domain: "OPERATIONS", source: "PLATFORM_MONITOR", subjectType: "COMMUNICATION_CHANNEL", autoClear: true }),

  // Route health
  define({ code: "ROUTE_HEALTH", group: "ROUTE_HEALTH", domain: "GATEWAY", source: "ROUTE_HEALTH", subjectType: "RAIL_ROUTE", autoClear: true }),
  define({ code: "ROUTE_OVERRIDE", group: "ROUTE_HEALTH", domain: "GATEWAY", source: "ROUTE_HEALTH", subjectType: "RAIL_ROUTE", autoClear: true }),
  define({ code: "ROUTE_OVERRIDE_REVIEW", group: "ROUTE_HEALTH", domain: "GATEWAY", source: "ROUTE_HEALTH", subjectType: "RAIL_ROUTE", priority: "P2", autoClear: true }),
  define({ code: "ROUTE_OVERRIDE_CONFLICT", group: "ROUTE_HEALTH", domain: "GATEWAY", source: "ROUTE_HEALTH", subjectType: "RAIL_ROUTE", priority: "P2", autoClear: true }),

  // Deadlines / regulatory / compliance
  define({ code: "REPORT_OVERDUE", group: "DEADLINES", domain: "COMPLIANCE", source: "DEADLINE", subjectType: "REGULATORY_REPORT", autoClear: true, confidentiality: "CONFIDENTIAL" }),
  define({ code: "AML_SLA_BREACH", group: "DEADLINES", domain: "COMPLIANCE", source: "DEADLINE", subjectType: "AML_CASE", confidentiality: "AML" }),
  define({ code: "DISPUTE_EXPIRED", group: "DEADLINES", domain: "FINANCE", source: "DEADLINE", subjectType: "DISPUTE", priority: "P2", confidentiality: "CONFIDENTIAL" }),
  define({ code: "DISPUTE_RULING_OVERDUE", group: "DEADLINES", domain: "FINANCE", source: "DEADLINE", subjectType: "DISPUTE", priority: "P2", confidentiality: "CONFIDENTIAL" }),
  define({ code: "CASHOUT_SLA", group: "DEADLINES", domain: "FINANCE", source: "DEADLINE", subjectType: "CASHOUT", priority: "P2" }),
  define({ code: "EMERGENCY_UNRATIFIED", group: "DEADLINES", domain: "COMPLIANCE", source: "DEADLINE", subjectType: "APPROVAL_REQUEST", confidentiality: "CONFIDENTIAL" }),
  define({ code: "EMERGENCY_LIFTED", group: "DEADLINES", domain: "COMPLIANCE", source: "DEADLINE", subjectType: "APPROVAL_REQUEST", confidentiality: "CONFIDENTIAL" }),

  // Credentials / KYB
  define({ code: "CREDENTIAL_EXPIRING", group: "CREDENTIALS_KYB", domain: "GATEWAY", source: "PLATFORM_MONITOR", subjectType: "CREDENTIAL_SET" }),
  define({ code: "CREDENTIAL_EXPIRED", group: "CREDENTIALS_KYB", domain: "GATEWAY", source: "PLATFORM_MONITOR", subjectType: "CREDENTIAL_SET" }),
  define({ code: "CREDENTIAL_FAILING", group: "CREDENTIALS_KYB", domain: "GATEWAY", source: "PLATFORM_MONITOR", subjectType: "CREDENTIAL_SET" }),
  define({ code: "KYB_INFECTED", group: "CREDENTIALS_KYB", domain: "COMPLIANCE", source: "KYB", subjectType: "KYB_DOCUMENT", confidentiality: "CONFIDENTIAL" }),
  define({ code: "KYB_SCAN_FAILED", group: "CREDENTIALS_KYB", domain: "COMPLIANCE", source: "KYB", subjectType: "KYB_DOCUMENT", priority: "P2", confidentiality: "CONFIDENTIAL" }),

  // Ledger / consistency
  define({ code: "LEDGER_INVARIANT", group: "LEDGER", domain: "FINANCE", source: "LEDGER", subjectType: "LEDGER", actions: LEDGER_ACTIONS }),
  define({ code: "LEDGER_SHARD", group: "LEDGER", domain: "FINANCE", source: "LEDGER", subjectType: "GL_ACCOUNT_SHARD", actions: LEDGER_ACTIONS }),
  define({ code: "LEDGER_PARTITION", group: "LEDGER", domain: "FINANCE", source: "LEDGER", subjectType: "LEDGER", actions: LEDGER_ACTIONS }),
  define({ code: "COMMISSION_RECEIVABLE_AGED", group: "LEDGER", domain: "FINANCE", source: "LEDGER", subjectType: "MERCHANT", actions: LEDGER_ACTIONS }),
  define({ code: "LINK_SLOT_DRIFT", group: "LEDGER", domain: "OPERATIONS", source: "LEDGER", subjectType: "PAYMENT_LINK", priority: "P3", actions: LEDGER_ACTIONS }),
  define({ code: "OUTBOX_PARKED", group: "LEDGER", domain: "OPERATIONS", source: "LEDGER", subjectType: "OUTBOX_TOPIC", actions: LEDGER_ACTIONS }),
  define({ code: "REFUND_INQUIRY", group: "LEDGER", domain: "FINANCE", source: "LEDGER", subjectType: "ADJUSTMENT", actions: LEDGER_ACTIONS }),

  // Statements / audit / report scope
  define({ code: "STATEMENT_MISSING", group: "STATEMENTS", domain: "FINANCE", source: "PLATFORM_MONITOR", subjectType: "STATEMENT_SOURCE", priority: "P2", autoClear: true }),
  define({ code: "STATEMENT_SCHEDULE_INVALID", group: "STATEMENTS", domain: "FINANCE", source: "PLATFORM_MONITOR", subjectType: "STATEMENT_SOURCE", priority: "P3", autoClear: true }),
  define({ code: "AUDIT_ANCHOR_INVALID", group: "SECURITY", domain: "SECURITY", source: "SECURITY", subjectType: "AUDIT_CHAIN", confidentiality: "CONFIDENTIAL" }),
  define({ code: "AUDIT_CHAIN_REWRITTEN", group: "SECURITY", domain: "SECURITY", source: "SECURITY", subjectType: "AUDIT_CHAIN", confidentiality: "CONFIDENTIAL" }),
  define({ code: "AUDIT_CHAIN_BROKEN", group: "SECURITY", domain: "SECURITY", source: "SECURITY", subjectType: "AUDIT_CHAIN", confidentiality: "CONFIDENTIAL" }),
  define({ code: "REPORT_SCOPE_VIOLATION", group: "SECURITY", domain: "SECURITY", source: "SECURITY", subjectType: "MERCHANT_REPORT", confidentiality: "CONFIDENTIAL" }),

  define({ code: "LEGACY_UNCLASSIFIED", group: "LEGACY", domain: "OPERATIONS", source: "LEGACY", subjectType: "CASE", priority: "P3", slaHours: 72, actions: LEGACY_ACTIONS }),
];

export const CASE_TYPES: Record<string, CaseTypeDefinition> = Object.fromEntries(defs.map((entry) => [entry.code, entry]));

const caseOf = (code: string): CaseTypeDefinition => CASE_TYPES[code]!;

export const CASE_TYPE_LIST: CaseTypeDefinition[] = defs;

export const ACTION_DEFINITIONS: Record<CaseActionCode, CaseActionDefinition> = {
  ACKNOWLEDGE: { code: "ACKNOWLEDGE", labelKey: "operatorCase.action.ACKNOWLEDGE", requiresApproval: false, fields: ["notes"] },
  OPEN_SOURCE: { code: "OPEN_SOURCE", labelKey: "operatorCase.action.OPEN_SOURCE", requiresApproval: false },
  INQUIRE: { code: "INQUIRE", labelKey: "operatorCase.action.INQUIRE", requiresApproval: false, fields: ["reason", "notes"] },
  MARK_SUCCEEDED: { code: "MARK_SUCCEEDED", labelKey: "operatorCase.action.MARK_SUCCEEDED", requiresApproval: true, fields: ["providerReference", "settledAmount", "reason", "notes"] },
  MARK_FAILED: { code: "MARK_FAILED", labelKey: "operatorCase.action.MARK_FAILED", requiresApproval: true, fields: ["reason", "notes"] },
  CLOSE_CASE: { code: "CLOSE_CASE", labelKey: "operatorCase.action.CLOSE_CASE", requiresApproval: true, fields: ["resolutionCode", "reference", "reason", "notes"] },
};

export const RESOLUTION_CODES = [
  "FIXED_AT_SOURCE",
  "FALSE_POSITIVE",
  "DUPLICATE",
  "ACCEPTED_RISK",
  "REFERRED",
  "NO_ACTION_REQUIRED",
  "SOURCE_CLEARED",
  "OTHER",
] as const;

/** The case type is the condition; `kind` is only the legacy queue bucket. */
export const caseTypeForSubjectKey = (
  subjectKey: string | null | undefined,
  kind: string | null | undefined,
  hasAttempt: boolean,
  hasReconciliationItem: boolean,
  notes = "",
): CaseTypeDefinition => {
  const key = String(subjectKey ?? "");
  const lowerNotes = notes.toLowerCase();
  if (key.startsWith("platform.backup:backup-failed")) return caseOf("BACKUP_FAILED");
  if (key.startsWith("platform.backup:backup-stale")) return caseOf("BACKUP_STALE");
  if (key.startsWith("platform.backup:daemon")) return caseOf("BACKUP_DAEMON");
  if (key.startsWith("platform.backup:unhealthy")) return caseOf("BACKUP_UNHEALTHY");
  if (key.startsWith("platform.backup:wal-lag")) return caseOf("BACKUP_WAL_LAG");
  if (key.startsWith("platform.backup:drill-failed")) return caseOf("BACKUP_DRILL_FAILED");
  if (key.startsWith("platform.backup:drill-stale")) return caseOf("BACKUP_DRILL_STALE");
  if (key.startsWith("platform.backup:")) return caseOf("BACKUP_ALERT");
  if (key.startsWith("platform.worker_stale")) return caseOf("WORKER_STALE");
  if (key.startsWith("platform.checkpoint_stale")) return caseOf("CHECKPOINT_STALE");
  if (key.startsWith("platform.outbox_age")) return caseOf("OUTBOX_AGE");
  if (key.startsWith("platform.audit_outbox_age")) return caseOf("AUDIT_OUTBOX_AGE");
  if (key.startsWith("platform.background_job_age")) return caseOf("BACKGROUND_JOB_AGE");
  if (key.startsWith("platform.kyb_scan_backlog")) return caseOf("KYB_SCAN_BACKLOG");
  if (key.startsWith("platform.journal_default_rows")) return caseOf("JOURNAL_DEFAULT_ROWS");
  if (key.startsWith("platform.cert_expiry")) return caseOf("CERT_EXPIRY");
  if (key.startsWith("platform.redis_unreachable")) return caseOf("REDIS_UNREACHABLE");
  if (key.startsWith("platform.stale_unknown")) return caseOf("STALE_UNKNOWN_BACKLOG");
  if (key.startsWith("platform.refund_unscheduled")) return caseOf("REFUND_UNSCHEDULED");
  if (key.startsWith("platform.object_storage")) return caseOf("OBJECT_STORAGE");
  if (key.startsWith("platform.communication")) return caseOf("COMMUNICATION_UNCONFIGURED");
  if (key.startsWith("platform.monitor_check_failed")) return caseOf("MONITOR_CHECK_FAILED");
  if (key.startsWith("platform.")) return caseOf("PLATFORM_ALERT");
  if (key.startsWith("report.overdue")) return caseOf("REPORT_OVERDUE");
  if (key.startsWith("aml.sla_breached")) return caseOf("AML_SLA_BREACH");
  if (key.startsWith("dispute.expired")) return caseOf("DISPUTE_EXPIRED");
  if (key.startsWith("dispute.ruling_overdue")) return caseOf("DISPUTE_RULING_OVERDUE");
  if (key.startsWith("cashout.sla")) return caseOf("CASHOUT_SLA");
  if (key.startsWith("emergency.unratified")) return caseOf("EMERGENCY_UNRATIFIED");
  if (key.startsWith("emergency.lifted")) return caseOf("EMERGENCY_LIFTED");
  if (key.startsWith("route.health.override_review")) return caseOf("ROUTE_OVERRIDE_REVIEW");
  if (key.startsWith("route.health.override_conflict")) return caseOf("ROUTE_OVERRIDE_CONFLICT");
  if (key.startsWith("route.health.override")) return caseOf("ROUTE_OVERRIDE");
  if (key.startsWith("route.health")) return caseOf("ROUTE_HEALTH");
  if (key.startsWith("credential.expiring")) return caseOf("CREDENTIAL_EXPIRING");
  if (key.startsWith("credential.expired")) return caseOf("CREDENTIAL_EXPIRED");
  if (key.startsWith("credential.failing")) return caseOf("CREDENTIAL_FAILING");
  if (key.startsWith("kyb-infected")) return caseOf("KYB_INFECTED");
  if (key.startsWith("kyb-scan-failed")) return caseOf("KYB_SCAN_FAILED");
  if (key.startsWith("ledger.invariant")) return caseOf("LEDGER_INVARIANT");
  if (key.startsWith("ledger.shard")) return caseOf("LEDGER_SHARD");
  if (key.startsWith("ledger.partition")) return caseOf("LEDGER_PARTITION");
  if (key.startsWith("commission.receivable.aged")) return caseOf("COMMISSION_RECEIVABLE_AGED");
  if (key.startsWith("link.slot_drift")) return caseOf("LINK_SLOT_DRIFT");
  if (key.startsWith("outbox.parked")) return caseOf("OUTBOX_PARKED");
  if (key.startsWith("refund.inquiry")) return caseOf("REFUND_INQUIRY");
  if (key.startsWith("statement.missing")) return caseOf("STATEMENT_MISSING");
  if (key.startsWith("statement.schedule_invalid")) return caseOf("STATEMENT_SCHEDULE_INVALID");
  if (key.startsWith("audit.anchor_invalid")) return caseOf("AUDIT_ANCHOR_INVALID");
  if (key.startsWith("audit.chain_rewritten")) return caseOf("AUDIT_CHAIN_REWRITTEN");
  if (key.startsWith("audit.chain_broken")) return caseOf("AUDIT_CHAIN_BROKEN");
  if (key.startsWith("merchant_report_scope")) return caseOf("REPORT_SCOPE_VIOLATION");
  if (key.startsWith("attempt.unknown")) return caseOf("ATTEMPT_UNKNOWN");
  if (key.startsWith("recon.overflow")) return caseOf("RECON_OVERFLOW");
  if (key.startsWith("recon.item")) {
    if (lowerNotes.includes("duplicate")) return caseOf("RECON_DUPLICATE");
    if (lowerNotes.includes("missing at gateway")) return caseOf("RECON_MISSING_AT_GATEWAY");
    if (lowerNotes.includes("missing locally") || lowerNotes.includes("local only")) return caseOf("RECON_MISSING_LOCALLY");
    if (lowerNotes.includes("unmatched") || lowerNotes.includes("only in statement")) return caseOf("RECON_UNMATCHED_STATEMENT");
    return caseOf("RECON_AMOUNT_MISMATCH");
  }

  const normalizedKind = String(kind ?? "").toUpperCase();
  if (hasAttempt) {
    if (normalizedKind === "CONFLICT") return caseOf("ATTEMPT_CONFLICT");
    if (normalizedKind === "LATE_SUCCESS") return caseOf("ATTEMPT_LATE_SUCCESS");
    if (normalizedKind === "HELD") return caseOf("ATTEMPT_HELD");
    if (normalizedKind === "UNKNOWN") return caseOf("ATTEMPT_UNKNOWN");
    if (normalizedKind === "MISMATCH") return caseOf("ATTEMPT_SUSPENSE");
    if (normalizedKind === "UNMATCHED_STATEMENT") return caseOf("RECON_UNMATCHED_STATEMENT");
    return caseOf("ATTEMPT_MANUAL_REVIEW");
  }
  if (hasReconciliationItem) return caseOf("RECON_ITEM_EXCEPTION");
  return caseOf("LEGACY_UNCLASSIFIED");
};

const splitSubject = (subjectKey: string | null | undefined): string[] => String(subjectKey ?? "").split(":").filter(Boolean);

const uuidLike = (value: string | undefined): string | null =>
  value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;

export interface CaseMetadata {
  caseType: CaseTypeDefinition;
  source: CaseSource;
  domain: CaseDomain;
  confidentiality: CaseConfidentiality;
  titleKey: string;
  titleText: string;
  summary: string;
  detailsJson: Record<string, unknown>;
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string | null;
}

export const caseMetadata = (input: {
  subjectKey?: string | null;
  kind?: string | null;
  attemptId?: string | null;
  reconciliationItemId?: string | null;
  title?: string | null;
  detail?: string | null;
  notes?: string | null;
  now?: Date;
}): CaseMetadata => {
  const notes = String(input.detail ?? input.notes ?? "").trim();
  const definition = caseTypeForSubjectKey(
    input.subjectKey,
    input.kind,
    Boolean(input.attemptId),
    Boolean(input.reconciliationItemId),
    notes,
  );
  const segments = splitSubject(input.subjectKey);
  const lastSegment = segments.at(-1);
  const idSegment = uuidLike(lastSegment) ?? uuidLike(segments.at(-2)) ?? null;
  let subjectId: string | null = idSegment;
  if (definition.code.startsWith("BACKUP_")) {
    const backupKey = segments.slice(0, 3).join(":");
    subjectId = backupKey || lastSegment || null;
  } else if (definition.code === "CASHOUT_SLA" && segments.length >= 2) {
    subjectId = segments[1] ?? null;
  } else if (definition.code === "LEDGER_SHARD" && segments.length >= 2) {
    subjectId = segments[1] ?? null;
  } else if (definition.code === "RECON_OVERFLOW") {
    subjectId = lastSegment ?? null;
  }
  const title = input.title?.trim()
    || (definition.code.startsWith("BACKUP_") ? `${definition.labelKey.split(".").at(-1)?.replaceAll("_", " ")}: ${lastSegment ?? "backup"}` : definition.labelKey.split(".").at(-1)?.replaceAll("_", " ") ?? definition.code);
  const subjectLabel = definition.code.startsWith("BACKUP_")
    ? lastSegment ?? null
    : definition.code === "REPORT_OVERDUE"
      ? "Regulatory report"
      : definition.subjectType === "PAYMENT_ATTEMPT"
        ? null
        : definition.subjectType === "RECONCILIATION_ITEM"
          ? "Reconciliation item"
          : definition.subjectType === "RAIL_ROUTE"
            ? "Route"
            : definition.subjectType === "CREDENTIAL_SET"
              ? "Credential set"
              : definition.subjectType === "KYB_DOCUMENT"
                ? "KYB document"
                : definition.subjectType === "PLATFORM_CHECK"
                  ? "Platform check"
                  : subjectId;
  return {
    caseType: definition,
    source: definition.source,
    domain: definition.domain,
    confidentiality: definition.confidentiality,
    titleKey: definition.labelKey,
    titleText: title,
    summary: notes.slice(0, 4000),
    detailsJson: {
      subjectKey: input.subjectKey ?? null,
      notes: notes.slice(0, 4000),
      kind: input.kind ?? null,
    },
    subjectType: definition.subjectType,
    subjectId,
    subjectLabel,
  };
};

export const caseReference = (caseNumber: number, createdAt: Date | string): string => {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const year = Number.isNaN(date.getTime()) ? "" : String(date.getUTCFullYear());
  return `CASE-${year}-${String(caseNumber).padStart(5, "0")}`;
};

export const actionsForCase = (definition: CaseTypeDefinition, hasAttempt: boolean): CaseActionDefinition[] =>
  definition.actions
    .filter((action) => (action === "INQUIRE" || action === "MARK_SUCCEEDED" || action === "MARK_FAILED" ? hasAttempt : true))
    .map((action) => ACTION_DEFINITIONS[action]);
