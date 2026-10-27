import type { Money } from "./money";

export interface PrismaLike {
  $transaction: (...args: any[]) => Promise<any>;
  $queryRaw: (...args: any[]) => Promise<any>;
  $executeRaw: (...args: any[]) => Promise<any>;
  $queryRawUnsafe: (...args: any[]) => Promise<any>;
  $executeRawUnsafe: (...args: any[]) => Promise<any>;
  [model: string]: any;
}

export type Tx = PrismaLike;

export type RiskTier = "LOW" | "STANDARD" | "HIGH";
export type MerchantStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "CLOSED";
export type KybStatus = "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
export type SettlementTarget = "PLATFORM_CLEARING" | "MERCHANT_DIRECT" | "PROVIDER_HELD";
export type Environment = "SANDBOX" | "LIVE";
export type Channel = "WEB" | "API" | "POS";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AmlAction = "HOLD" | "FLAG" | "BLOCK" | "CASE_ONLY";
export type AmlRuleType =
  | "SINGLE_AMOUNT"
  | "CUMULATIVE_WINDOW"
  | "STRUCTURING"
  | "RISK_TIER"
  | "COUNTERPARTY_COUNTRY"
  | "RAIL"
  | "MERCHANT_DIRECT_AMOUNT";
export type PlatformRole =
  | "GATEWAY_ADMIN"
  | "SECURITY_ADMIN"
  | "FINANCE"
  | "OPERATOR"
  | "COMPLIANCE"
  | "MLRO"
  | "SUPPORT"
  | "MERCHANT_ADMIN"
  | "MERCHANT_STAFF"
  | "MERCHANT_CASHIER";

export interface MerchantRow {
  id: string;
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  registrationNo: string | null;
  businessCategory: string | null;
  status: MerchantStatus;
  kybStatus: KybStatus;
  riskTier: RiskTier;
  onboardingChannel: string | null;
  country: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  suspensionReasonCode: string | null;
  negativeBalanceCeiling: unknown;
  payoutBankDetailsJson: unknown;
  expectedMonthlyVolume?: unknown;
}

export interface UserRow {
  id: string;
  merchantId: string | null;
  email: string | null;
  phone: string | null;
  role: PlatformRole | string;
  authoritiesMap: unknown;
  appScopeIds: unknown;
  isMaker: boolean;
  isChecker: boolean;
  mfaRequired: boolean;
  status: string | null;
}

export interface UserIdentityRow {
  id: string;
  userId: string;
  kind: "PHONE" | "EMAIL" | "GOOGLE";
  identifierNormalized: string;
  providerSubject: string | null;
  verifiedAt: Date | null;
  isPrimary: boolean;
}

export type JoinRequestStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "IN_REVIEW"
  | "INFO_REQUESTED"
  | "PENDING_CHECKER"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "EXPIRED";

export interface JoinRequestRow {
  id: string;
  merchantId: string;
  submittedByUserId: string;
  status: JoinRequestStatus;
  onboardingChannel: string;
  submittedAt: Date | null;
  assignedReviewerId: string | null;
  slaDueAt: Date | null;
  screeningId: string | null;
  proposedRiskTier: RiskTier;
  fourEyesRequired: boolean;
  fourEyesReasons: unknown;
  decision: "APPROVED" | "REJECTED" | null;
  decisionReasonCode: string | null;
  decisionNotes: string | null;
  infoRequestJson: unknown;
  resubmissionOfId: string | null;
  approvalRequestId: string | null;
  businessProfileJson?: unknown;
}

export interface KybDocumentRow {
  id: string;
  merchantId: string;
  joinRequestId: string | null;
  subjectType: "MERCHANT" | "BENEFICIAL_OWNER";
  subjectId: string;
  docType: string;
  storageKey: string;
  sha256: string;
  mime: string;
  sizeBytes: number;
  avStatus: "PENDING" | "CLEAN" | "INFECTED";
  status: "UPLOADED" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  reviewedBy: string | null;
  reviewedAt: Date | null;
  expiresOn: Date | null;
  rejectionReasonCode: string | null;
}

export interface BeneficialOwnerRow {
  id: string;
  merchantId: string;
  fullNameAr: string;
  fullNameEn: string | null;
  nationalIdCiphertext: string | null;
  dateOfBirth: Date | null;
  nationality: string | null;
  ownershipPercent: unknown;
  role: "OWNER" | "DIRECTOR" | "SIGNATORY" | "CONTROLLER";
  pepDeclared: boolean;
  screeningStatus: "NOT_SCREENED" | "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
  active: boolean;
}

export interface VelocityRuleRow {
  id: string;
  scopeType: "END_CLIENT_IP" | "END_CLIENT_PHONE" | "END_CLIENT_CARD" | "MERCHANT" | "APPLICATION" | "RAIL" | "LINK";
  scopeValue: string | null;
  windowSeconds: number;
  maxCount: number | null;
  maxAmount: unknown;
  action: "REJECT" | "FLAG";
  active: boolean;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface AmlRuleRow {
  id: string;
  code: string;
  name: string;
  ruleType: AmlRuleType;
  scope: unknown;
  params: unknown;
  action: AmlAction;
  baseSeverity: Severity;
  active: boolean;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface AmlCaseRow {
  id: string;
  subjectType: "MERCHANT" | "END_CLIENT" | "PAYMENT_ATTEMPT";
  subjectId: string;
  triggerReason: string;
  severity: Severity;
  severityInputsJson: unknown;
  screeningId: string | null;
  ruleId: string | null;
  ruleVersion: number | null;
  holdJournalEntryId: string | null;
  status: "OPEN" | "IN_REVIEW" | "PENDING_CHECKER" | "RELEASED" | "REJECTED_VOID" | "FROZEN" | "ESCALATED_STR";
  slaDueAt: Date | null;
  assignedReviewerId: string | null;
  regulatoryReportId: string | null;
  confidential: boolean;
  reviewerNotes: string | null;
  merchantId?: string | null;
}

export interface AmlScreeningRow {
  id: string;
  subjectType: "MERCHANT" | "BENEFICIAL_OWNER" | "END_CLIENT" | "PAYMENT_ATTEMPT";
  subjectId: string;
  trigger: "ONBOARDING" | "PERIODIC" | "LIST_UPDATE" | "OWNER_CHANGE" | "TRANSACTION" | "MANUAL";
  providerCode: string;
  providerRequestRef: string | null;
  listVersionsJson: unknown;
  inputHash: string;
  result: "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH" | "ERROR";
  matchCount: number;
  highestScore: unknown;
  requestedAt: Date;
  completedAt: Date | null;
}

export interface AmlScreeningMatchRow {
  id: string;
  screeningId: string;
  listType: "SANCTIONS" | "PEP" | "ADVERSE_MEDIA" | "INTERNAL_WATCHLIST";
  listName: string;
  listEntryRef: string;
  matchedName: string;
  score: unknown;
  attributesJson: unknown;
  disposition: "UNREVIEWED" | "FALSE_POSITIVE" | "TRUE_MATCH" | "ESCALATED";
  dispositionBy: string | null;
  dispositionNotes: string | null;
  suppressFuture: boolean;
  suppressUntil: Date | null;
}

export interface ReportingRuleRow {
  id: string;
  authority: string;
  reportType: "LARGE_TRANSACTION" | "SUSPICIOUS_ACTIVITY" | "PERIODIC_RETURN";
  thresholdAmount: unknown;
  windowSeconds: number | null;
  currency: string;
  conditions: unknown;
  sourceReference: string;
  status: "PROVISIONAL" | "CONFIRMED";
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface RegulatoryReportRow {
  id: string;
  reportType: "LARGE_TRANSACTION" | "SUSPICIOUS_ACTIVITY" | "PERIODIC_RETURN";
  authority: string;
  subjectType: string;
  subjectId: string;
  amlCaseId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  status: "DRAFT" | "PENDING_CHECKER" | "APPROVED" | "SUBMITTED" | "ACKNOWLEDGED" | "REJECTED_BY_AUTHORITY";
  payloadCiphertext: string | null;
  payloadSha256: string | null;
  submissionRef: string | null;
  submittedAt: Date | null;
  confidential: boolean;
  approvalRequestId: string | null;
}

export interface OperatorCaseRow {
  id: string;
  attemptId: string | null;
  reconciliationItemId: string | null;
  kind: string;
  priority: "P1" | "P2" | "P3";
  slaDueAt: Date | null;
  state: "OPEN" | "IN_PROGRESS" | "PENDING_CHECKER" | "RESOLVED";
  assigneeUserId: string | null;
  resolutionNotes: string | null;
}

export interface PaymentLinkRow {
  id: string;
  key: string;
  applicationId: string;
  walletId: string;
  amount: unknown;
  currency: string;
  feeBearer: string;
  infiniteUse: boolean;
  useCount: number;
  confirmedCount: number;
  activeLockedCount: number;
  state: "PENDING" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  expiresAt: Date | null;
  railWhitelist: unknown;
}

export interface PaymentAttemptRow {
  id: string;
  reference: string;
  idempotencyKey: string | null;
  linkId: string;
  attemptGroupId: string | null;
  applicationId: string;
  merchantId: string;
  railId: string | null;
  routeId: string | null;
  credentialSetId: string | null;
  gatewayVersionId: string | null;
  commissionProfileId: string | null;
  env: Environment;
  mode: string | null;
  subMode: string | null;
  status: string;
  substatus: string | null;
  gatewayReference: string | null;
  providerReference: string | null;
  networkReference: string | null;
  requestedAmount: unknown;
  surchargeAmount: unknown;
  totalChargedAmount: unknown;
  gatewayAmountWire?: string | null;
  settledAmount: unknown;
  gatewayFeeAmount: unknown;
  platformCommissionAmount: unknown;
  netMerchantAmount: unknown;
  feeBearer: string | null;
  currency: string;
  customerFieldsMasked: unknown;
  contextCiphertext?: string;
  otpAttempts: number;
  lastOtpSentAt?: Date | null;
  clientIp: string | null;
  userAgent?: string | null;
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  nextCheckAt: Date | null;
  ledgerEntryId?: string | null;
  terminalAt: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  amlCaseId?: string | null;
}

export interface DisputeRow {
  id: string;
  attemptId: string;
  gatewayId: string;
  railId: string;
  externalDisputeRef: string;
  source: "WEBHOOK" | "STATEMENT" | "MANUAL";
  reasonCode: string | null;
  amount: unknown;
  currency: string;
  status: "OPENED" | "EVIDENCE_REQUESTED" | "EVIDENCE_SUBMITTED" | "WON" | "LOST" | "EXPIRED" | "WITHDRAWN";
  openedAt: Date;
  evidenceDueAt: Date | null;
  outcomeAt: Date | null;
  adjustmentId: string | null;
  evidenceJson: unknown;
}

export interface AdjustmentRow {
  id: string;
  type: "CHARGEBACK" | "REFUND" | "MANUAL_CREDIT" | "MANUAL_DEBIT" | "CORRECTION" | "CASHOUT_SUBTRACTION";
  targetGlAccountId: string;
  sourceAttemptId: string | null;
  disputeId: string | null;
  draftedBySystem: boolean;
  amount: unknown;
  reverseCommission: boolean;
  reason: string;
  externalDisputeRef: string | null;
  providerRefundRef: string | null;
  state: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "EXECUTING" | "EXECUTED" | "REJECTED";
  journalEntryId: string | null;
  merchantId?: string | null;
}

export interface ApprovalRequestRow {
  id: string;
  subjectType: string;
  subjectId: string;
  payloadDiffJson: unknown;
  mode: "STANDARD" | "EMERGENCY_RATIFICATION";
  baseVersion: number | null;
  expiresAt: Date | null;
  ratifyDueAt: Date | null;
  makerUserId: string;
  checkerUserId: string | null;
  state: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "EXECUTED" | "REJECTED";
  rejectionReason: string | null;
  riskAcceptanceNote: string | null;
}

export interface NotificationTemplateRow {
  id?: string;
  code: string;
  channel: "SMS" | "EMAIL" | "IN_APP";
  lang: "ar" | "en";
  subjectTemplate: string | null;
  bodyTemplate: string;
  confidentialityClass: "PUBLIC" | "MERCHANT" | "INTERNAL";
  version: number;
  active: boolean;
}

export interface NotificationRow {
  id: string;
  eventId: string;
  recipientUserId: string | null;
  recipientMerchantId: string | null;
  addressMasked: string | null;
  addressCiphertext: string | null;
  templateCode: string;
  channel: "SMS" | "EMAIL" | "IN_APP";
  lang: "ar" | "en";
  payloadJson: unknown;
  status: "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "SUPPRESSED";
  providerMessageId: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
}

export interface PlatformSettingRow {
  key: string;
  scope: string;
  valueJson: unknown;
  version: number;
  effectiveFrom: Date;
  approvalRequestId: string | null;
}

export interface StatementSourceRow {
  id: string;
  gatewayId: string;
  type: "API" | "SFTP" | "UPLOAD";
  scheduleCron: string | null;
  parserConfig: unknown;
  settlementLagDays: number;
  dedupeKeyTemplate: string | null;
}

export interface ReconciliationRunRow {
  id: string;
  statementSourceId: string;
  windowStart: Date;
  windowEnd: Date;
  fileHash: string;
  statsJson: unknown;
}

export interface ReconciliationItemRow {
  id: string;
  runId: string;
  attemptId: string | null;
  ourReference: string | null;
  providerReference: string | null;
  batchReference: string | null;
  statementAmount: unknown;
  statementFee: unknown;
  result: "MATCHED" | "AMOUNT_MISMATCH" | "MISSING_AT_GATEWAY" | "MISSING_LOCALLY" | "DUPLICATE";
  operatorCaseId: string | null;
}

export interface AttemptWindowFilter {
  merchantId: string;
  applicationId?: string | null;
  linkId?: string | null;
  railCode?: string | null;
  clientIp?: string | null;
  clientPhone?: string | null;
  cardAlias?: string | null;
  since: Date;
}

export interface AttemptWindowStats {
  count: number;
  totalAmount: Money;
  amounts: Money[];
}

export interface WatchlistEntry {
  entryRef: string;
  listType: "SANCTIONS" | "PEP" | "ADVERSE_MEDIA" | "INTERNAL_WATCHLIST";
  listName: string;
  names: string[];
  identifiers?: string[];
  attributes?: Record<string, unknown>;
}

export interface IdentityRepository {
  createUser(tx: Tx, data: {
    merchantId?: string | null;
    email?: string | null;
    phone?: string | null;
    role: string;
    authoritiesMap?: unknown;
    status?: string;
  }): Promise<UserRow>;
  findUserById(tx: Tx, id: string): Promise<UserRow | null>;
  findUserByEmail(tx: Tx, email: string): Promise<UserRow | null>;
  findUserByPhone(tx: Tx, phone: string): Promise<UserRow | null>;
  createIdentity(tx: Tx, data: {
    userId: string;
    kind: "PHONE" | "EMAIL" | "GOOGLE";
    identifierNormalized: string;
    providerSubject?: string | null;
    isPrimary?: boolean;
  }): Promise<UserIdentityRow>;
  findIdentityByKind(tx: Tx, kind: string, identifierNormalized: string): Promise<UserIdentityRow | null>;
  findIdentityByProviderSubject(tx: Tx, providerSubject: string): Promise<UserIdentityRow | null>;
  listIdentitiesByUser(tx: Tx, userId: string): Promise<UserIdentityRow[]>;
  markIdentityVerified(tx: Tx, id: string, verifiedAt: Date): Promise<void>;
}

export interface MerchantRepository {
  createMerchant(tx: Tx, data: Partial<MerchantRow> & { legalName: string }): Promise<MerchantRow>;
  findMerchantById(tx: Tx, id: string): Promise<MerchantRow | null>;
  findMerchantByApplication(tx: Tx, applicationId: string): Promise<MerchantRow | null>;
  updateMerchant(tx: Tx, id: string, patch: Partial<MerchantRow>): Promise<MerchantRow>;
  /**
   * Takes a row lock on the merchant. Two workers can therefore never
   * process the same merchant at the same time.
   */
  lockMerchantById(tx: Tx, id: string): Promise<MerchantRow | null>;
  findMerchantsByDuplicateSignals(tx: Tx, signals: {
    taxId?: string | null;
    registrationNo?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
  }): Promise<MerchantRow[]>;
  getWalletBalance(tx: Tx, merchantId: string): Promise<Money>;
  getNegativeBalanceCeiling(tx: Tx, merchantId: string): Promise<Money>;
}

export interface OnboardingRepository {
  createJoinRequest(tx: Tx, data: Partial<JoinRequestRow> & { merchantId: string; submittedByUserId: string }): Promise<JoinRequestRow>;
  findJoinRequestById(tx: Tx, id: string): Promise<JoinRequestRow | null>;
  findOpenJoinRequestByMerchant(tx: Tx, merchantId: string): Promise<JoinRequestRow | null>;
  listJoinRequests(tx: Tx, filter: { status?: JoinRequestStatus | string; merchantId?: string; limit: number; offset: number }): Promise<JoinRequestRow[]>;
  updateJoinRequest(tx: Tx, id: string, patch: Partial<JoinRequestRow>): Promise<JoinRequestRow>;
  createKybDocument(tx: Tx, data: Partial<KybDocumentRow> & {
    merchantId: string;
    subjectType: string;
    subjectId: string;
    docType: string;
    storageKey: string;
    sha256: string;
    mime: string;
    sizeBytes: number;
  }): Promise<KybDocumentRow>;
  findKybDocumentById(tx: Tx, id: string): Promise<KybDocumentRow | null>;
  findKybDocumentsBySha256(tx: Tx, sha256: string): Promise<KybDocumentRow[]>;
  listKybDocumentsByMerchant(tx: Tx, merchantId: string): Promise<KybDocumentRow[]>;
  updateKybDocument(tx: Tx, id: string, patch: Partial<KybDocumentRow>): Promise<KybDocumentRow>;
  createBeneficialOwner(tx: Tx, data: Partial<BeneficialOwnerRow> & { merchantId: string; fullNameAr: string }): Promise<BeneficialOwnerRow>;
  findBeneficialOwnerById(tx: Tx, id: string): Promise<BeneficialOwnerRow | null>;
  listBeneficialOwners(tx: Tx, merchantId: string): Promise<BeneficialOwnerRow[]>;
  updateBeneficialOwner(tx: Tx, id: string, patch: Partial<BeneficialOwnerRow>): Promise<BeneficialOwnerRow>;
}

export interface RiskRepository {
  listActiveVelocityRules(tx: Tx): Promise<VelocityRuleRow[]>;
  listActiveAmlRules(tx: Tx): Promise<AmlRuleRow[]>;
  findAmlRuleById(tx: Tx, id: string): Promise<AmlRuleRow | null>;
  createAmlRule(tx: Tx, data: Partial<AmlRuleRow> & { code: string; name: string; ruleType: AmlRuleType }): Promise<AmlRuleRow>;
  listAmlRules(tx: Tx): Promise<AmlRuleRow[]>;
  createAmlCase(tx: Tx, data: Partial<AmlCaseRow> & {
    subjectType: string;
    subjectId: string;
    triggerReason: string;
    severity: Severity;
  }): Promise<AmlCaseRow>;
  findAmlCaseById(tx: Tx, id: string): Promise<AmlCaseRow | null>;
  listAmlCases(tx: Tx, filter: { status?: string; subjectId?: string; limit: number; offset: number }): Promise<AmlCaseRow[]>;
  updateAmlCase(tx: Tx, id: string, patch: Partial<AmlCaseRow>): Promise<AmlCaseRow>;
  countOpenAmlCases(tx: Tx, subjectType: string, subjectId: string): Promise<number>;
  createScreening(tx: Tx, data: Partial<AmlScreeningRow> & {
    subjectType: string;
    subjectId: string;
    trigger: string;
    providerCode: string;
    inputHash: string;
  }): Promise<AmlScreeningRow>;
  createScreeningMatch(tx: Tx, data: Partial<AmlScreeningMatchRow> & {
    screeningId: string;
    listType: string;
    listName: string;
    listEntryRef: string;
    matchedName: string;
  }): Promise<AmlScreeningMatchRow>;
  findScreeningById(tx: Tx, id: string): Promise<AmlScreeningRow | null>;
  listScreenings(tx: Tx, filter: { subjectId?: string; result?: string; limit: number; offset: number }): Promise<AmlScreeningRow[]>;
  listScreeningMatches(tx: Tx, screeningId: string): Promise<AmlScreeningMatchRow[]>;
  findScreeningMatchById(tx: Tx, id: string): Promise<AmlScreeningMatchRow | null>;
  updateScreeningMatch(tx: Tx, id: string, patch: Partial<AmlScreeningMatchRow>): Promise<AmlScreeningMatchRow>;
  listReportingRules(tx: Tx): Promise<ReportingRuleRow[]>;
  createReportingRule(tx: Tx, data: Partial<ReportingRuleRow> & { reportType: string; sourceReference: string }): Promise<ReportingRuleRow>;
  listRegulatoryReports(tx: Tx, filter: { status?: string; limit: number; offset: number }): Promise<RegulatoryReportRow[]>;
  findRegulatoryReportById(tx: Tx, id: string): Promise<RegulatoryReportRow | null>;
  createRegulatoryReport(tx: Tx, data: Partial<RegulatoryReportRow> & {
    reportType: string;
    authority: string;
    subjectType: string;
    subjectId: string;
  }): Promise<RegulatoryReportRow>;
  updateRegulatoryReport(tx: Tx, id: string, patch: Partial<RegulatoryReportRow>): Promise<RegulatoryReportRow>;
  createOperatorCase(tx: Tx, data: Partial<OperatorCaseRow> & { kind: string; priority: string }): Promise<OperatorCaseRow>;
}

export interface PaymentRepository {
  lockLinkByKey(tx: Tx, key: string): Promise<PaymentLinkRow | null>;
  findLinkByKey(tx: Tx, key: string): Promise<PaymentLinkRow | null>;
  findLinkById(tx: Tx, id: string): Promise<PaymentLinkRow | null>;
  updateLinkSlotCount(tx: Tx, linkId: string, delta: number): Promise<void>;
  resolveSettlementTarget(tx: Tx, input: { railCode: string | null; merchantId: string | null; env: Environment }): Promise<SettlementTarget>;
  createAttempt(tx: Tx, data: Partial<PaymentAttemptRow> & { linkId: string; merchantId: string; applicationId: string }): Promise<PaymentAttemptRow>;
  findAttemptById(tx: Tx, id: string): Promise<PaymentAttemptRow | null>;
  findAttemptByReference(tx: Tx, reference: string): Promise<PaymentAttemptRow | null>;
  findAttemptByIdempotencyKey(tx: Tx, idempotencyKey: string): Promise<PaymentAttemptRow | null>;
  findAttemptByProviderReference(tx: Tx, providerReference: string): Promise<PaymentAttemptRow | null>;
  updateAttempt(tx: Tx, id: string, patch: Partial<PaymentAttemptRow>): Promise<PaymentAttemptRow>;
  collectWindowStats(tx: Tx, filter: AttemptWindowFilter): Promise<AttemptWindowStats>;
  /**
   * The processed volume of a window, grouped by route. It is derived from
   * the attempts themselves, so a daily cap can never drift from the ledger.
   */
  sumSucceededAmountByRouteInWindow(
    tx: Tx,
    window: { since: Date; until: Date },
  ): Promise<Map<string, Money>>;
  listSettledAttemptsInWindow(tx: Tx, input: { gatewayId: string; since: Date; until: Date }): Promise<PaymentAttemptRow[]>;
  listPollPolicies(tx: Tx): Promise<{ routeId: string; firstAfterSeconds: number; backoffSeconds: number[]; maxDurationSeconds: number; stopOnStates: string[] }[]>;
  listRouteInquirySupport(tx: Tx): Promise<{ routeId: string; supportsStatusCheck: boolean }[]>;
}

export interface DisputeRepository {
  findDisputeByGatewayRef(tx: Tx, gatewayId: string, externalDisputeRef: string): Promise<DisputeRow | null>;
  createDispute(tx: Tx, data: Partial<DisputeRow> & {
    attemptId: string;
    gatewayId: string;
    railId: string;
    externalDisputeRef: string;
    source: "WEBHOOK" | "STATEMENT" | "MANUAL";
  }): Promise<DisputeRow>;
  findDisputeById(tx: Tx, id: string): Promise<DisputeRow | null>;
  listDisputes(tx: Tx, filter: { status?: string; merchantId?: string; limit: number; offset: number }): Promise<DisputeRow[]>;
  updateDispute(tx: Tx, id: string, patch: Partial<DisputeRow>): Promise<DisputeRow>;
  createAdjustment(tx: Tx, data: Partial<AdjustmentRow> & { type: string; targetGlAccountId: string; amount: unknown; reason: string }): Promise<AdjustmentRow>;
  findAdjustmentById(tx: Tx, id: string): Promise<AdjustmentRow | null>;
  findAdjustmentByDispute(tx: Tx, disputeId: string): Promise<AdjustmentRow | null>;
  listAdjustments(tx: Tx, filter: { state?: string; limit: number; offset: number }): Promise<AdjustmentRow[]>;
  updateAdjustment(tx: Tx, id: string, patch: Partial<AdjustmentRow>): Promise<AdjustmentRow>;
  sumExecutedRefundsForAttempt(tx: Tx, attemptId: string): Promise<Money>;
}

export interface GovernanceRepository {
  createApprovalRequest(tx: Tx, data: Partial<ApprovalRequestRow> & {
    subjectType: string;
    subjectId: string;
    makerUserId: string;
  }): Promise<ApprovalRequestRow>;
  findApprovalRequestById(tx: Tx, id: string): Promise<ApprovalRequestRow | null>;
  listApprovalRequests(tx: Tx, filter: { state?: string; subjectType?: string; limit: number; offset: number }): Promise<ApprovalRequestRow[]>;
  updateApprovalRequest(tx: Tx, id: string, patch: Partial<ApprovalRequestRow>): Promise<ApprovalRequestRow>;
  writeAuditLog(tx: Tx, data: {
    actorId: string | null;
    role: string | null;
    action: string;
    entityType: string;
    entityId: string;
    beforeJson?: unknown;
    afterJson?: unknown;
    approvalRequestId?: string | null;
  }): Promise<void>;
  getPlatformSetting(tx: Tx, key: string): Promise<unknown>;
  listPlatformSettings(tx: Tx): Promise<PlatformSettingRow[]>;
}

export interface NotificationRepository {
  findTemplate(tx: Tx, code: string, channel: string, lang: string): Promise<NotificationTemplateRow | null>;
  listTemplates(tx: Tx): Promise<NotificationTemplateRow[]>;
  enqueueNotification(tx: Tx, data: Partial<NotificationRow> & {
    eventId: string;
    templateCode: string;
    channel: "SMS" | "EMAIL" | "IN_APP";
    lang: "ar" | "en";
  }): Promise<NotificationRow>;
  updateNotification(tx: Tx, id: string, patch: Partial<NotificationRow>): Promise<NotificationRow>;
}

export interface ReconciliationRepository {
  findStatementSourceById(tx: Tx, id: string): Promise<StatementSourceRow | null>;
  listStatementSources(tx: Tx): Promise<StatementSourceRow[]>;
  findRunByFileHash(tx: Tx, fileHash: string): Promise<ReconciliationRunRow | null>;
  createRun(tx: Tx, data: { statementSourceId: string; windowStart: Date; windowEnd: Date; fileHash: string; statsJson: unknown }): Promise<ReconciliationRunRow>;
  updateRunStats(tx: Tx, id: string, stats: unknown): Promise<void>;
  createItem(tx: Tx, data: Partial<ReconciliationItemRow> & { runId: string }): Promise<ReconciliationItemRow>;
  listItemsByRun(tx: Tx, runId: string): Promise<ReconciliationItemRow[]>;
}

export interface Repositories {
  identity: IdentityRepository;
  merchants: MerchantRepository;
  onboarding: OnboardingRepository;
  risk: RiskRepository;
  payments: PaymentRepository;
  disputes: DisputeRepository;
  governance: GovernanceRepository;
  notifications: NotificationRepository;
  reconciliation: ReconciliationRepository;
}
