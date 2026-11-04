import { moneyFromString } from "../../../engine/db/money";
import { metaOf, type SeederContext } from "../context";
import { invalidPathStep, IN_FLIGHT_STATUSES, SETTLED_STATUSES, TERMINAL_STATUSES } from "../lifecycle";
import { tripoliHour } from "../timelineClock";

type Row = Record<string, any>;

export interface InvariantReport {
  /** Total number of violated checks (rows that break an invariant). */
  total: number;
  /** Violations by rule name. */
  byRule: Record<string, number>;
  samples: string[];
  /** Descriptive metrics (not violations). */
  metrics: Record<string, number | string>;
}

const money = (value: unknown): bigint => moneyFromString(String(value ?? "0"));
const ts = (value: unknown): number => (value instanceof Date ? value.getTime() : new Date(String(value)).getTime());

/**
 * Foreign-key edges of the generated graph: [collection, field, target
 * collection | external reference set]. `external:*` targets are the baseline
 * rows loaded in `ctx.refs`.
 */
export const FK_EDGES: ReadonlyArray<[string, string, string]> = [
  ["users", "merchantId", "merchants"], ["users", "invitedById", "users"], ["userIdentities", "userId", "users"],
  ["wallets", "merchantId", "merchants"], ["wallets", "glAccountId", "glAccounts"],
  ["applications", "merchantId", "merchants"], ["applications", "assignedWalletId", "wallets"],
  ["accessTokens", "merchantId", "merchants"], ["accessTokens", "applicationId", "applications"], ["accessTokenIps", "tokenId", "accessTokens"],
  ["posTerminals", "applicationId", "applications"], ["posScreens", "posId", "posTerminals"],
  ["commissionProfiles", "merchantId", "merchants"], ["commissionProfiles", "approvalRequestId", "approvalRequests"],
  ["credentialSets", "ownerMerchantId", "merchants"], ["credentialSets", "gatewayId", "external:gateways"],
  ["joinRequests", "merchantId", "merchants"], ["joinRequests", "submittedByUserId", "users"], ["joinRequests", "assignedReviewerId", "users"],
  ["joinRequests", "screeningId", "amlScreenings"], ["joinRequests", "approvalRequestId", "approvalRequests"], ["joinRequests", "resubmissionOfId", "joinRequests"],
  ["kybDocuments", "merchantId", "merchants"], ["kybDocuments", "joinRequestId", "joinRequests"], ["kybDocuments", "uploadedById", "users"], ["kybDocuments", "reviewedById", "users"],
  ["beneficialOwners", "merchantId", "merchants"],
  ["paymentLinks", "applicationId", "applications"], ["paymentLinks", "walletId", "wallets"],
  ["attemptGroups", "linkId", "paymentLinks"],
  ["paymentAttempts", "linkId", "paymentLinks"], ["paymentAttempts", "attemptGroupId", "attemptGroups"], ["paymentAttempts", "applicationId", "applications"],
  ["paymentAttempts", "merchantId", "merchants"], ["paymentAttempts", "railId", "external:rails"], ["paymentAttempts", "routeId", "external:routes"],
  ["paymentAttempts", "credentialSetId", "credentialSets|external:credentials"], ["paymentAttempts", "gatewayVersionId", "gatewayVersions|external:versions"],
  ["paymentAttempts", "commissionProfileId", "commissionProfiles|external:commissionProfiles"], ["paymentAttempts", "ledgerEntryId", "journalEntries"],
  ["attemptStepLogs", "attemptId", "paymentAttempts"], ["attemptStepLogs", "gatewayVersionId", "gatewayVersions|external:versions"],
  ["inboundEvents", "attemptId", "paymentAttempts"], ["inboundEvents", "channelId", "confirmationChannels|external:confirmationChannels"],
  ["journalLines", "entryId", "journalEntries"], ["journalLines", "glAccountId", "glAccounts|external:glAccounts"],
  ["reconciliationRuns", "statementSourceId", "statementSources|external:statementSources"], ["reconciliationItems", "runId", "reconciliationRuns"], ["reconciliationItems", "attemptId", "paymentAttempts"],
  ["disputes", "attemptId", "paymentAttempts"], ["adjustments", "sourceAttemptId", "paymentAttempts"], ["adjustments", "disputeId", "disputes"],
  ["adjustments", "targetGlAccountId", "glAccounts|external:glAccounts"], ["adjustments", "journalEntryId", "journalEntries"],
  ["cashoutRequests", "merchantId", "merchants"], ["cashoutRequests", "walletId", "wallets"], ["cashoutRequests", "adjustmentId", "adjustments"],
  ["amlScreeningMatches", "screeningId", "amlScreenings"], ["amlCases", "screeningId", "amlScreenings"], ["amlCases", "ruleId", "amlRules"],
  ["amlCases", "holdJournalEntryId", "journalEntries"], ["amlCases", "assignedReviewerId", "users"], ["regulatoryReports", "amlCaseId", "amlCases"],
  ["regulatoryReports", "approvalRequestId", "approvalRequests"], ["operatorCases", "attemptId", "paymentAttempts"], ["operatorCases", "reconciliationItemId", "reconciliationItems"],
  ["operatorCases", "assigneeUserId", "users"], ["operatorCases", "approvalRequestId", "approvalRequests"],
  ["approvalRequests", "makerUserId", "users"], ["approvalRequests", "checkerUserId", "users"],
  ["notifications", "recipientUserId", "users"], ["notifications", "recipientMerchantId", "merchants"],
  ["auditLogs", "actorId", "users"], ["auditLogs", "approvalRequestId", "approvalRequests"], ["detailChangeLogs", "actorId", "users"], ["detailChangeLogs", "merchantId", "merchants"],
  ["gatewayVersions", "createdById", "users"], ["gatewayVersions", "approvalRequestId", "approvalRequests"],
];

const externalIds = (ctx: SeederContext): Record<string, Set<string>> => ({
  gateways: new Set(ctx.refs.gateways.map((row) => row.id)),
  rails: new Set(ctx.refs.rails.map((row) => row.id)),
  routes: new Set(ctx.refs.routes.map((row) => row.id)),
  credentials: new Set(ctx.refs.credentials.map((row) => row.id)),
  versions: new Set(ctx.refs.versions.map((row) => row.id)),
  glAccounts: new Set(ctx.refs.glAccounts.map((row) => row.id)),
  statementSources: new Set(ctx.refs.statementSources.map((row) => row.id)),
  commissionProfiles: new Set((ctx.refs.commissionProfiles ?? []).map((row) => row.id)),
  confirmationChannels: new Set((ctx.refs.confirmationChannels ?? []).map((row) => row.id)),
});

/** Runs every cross-table invariant of the synthetic history. */
export const checkInvariants = (ctx: SeederContext): InvariantReport => {
  const byRule: Record<string, number> = {};
  const samples: string[] = [];
  const metrics: Record<string, number | string> = {};
  const fail = (rule: string, detail: string): void => {
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    if (samples.length < 40) samples.push(`${rule}: ${detail}`);
  };
  const ds = ctx.dataset as unknown as Record<string, Row[]>;
  const meta = metaOf(ctx);
  const endMs = ctx.timeline.end.getTime();
  const external = externalIds(ctx);
  const ids = new Map<string, Set<string>>();
  for (const [name, rows] of Object.entries(ds)) ids.set(name, new Set(rows.map((row) => String(row.id))));
  const known = (target: string, value: string): boolean =>
    target.split("|").some((part) => (part.startsWith("external:") ? external[part.slice(9)]?.has(value) : ids.get(part)?.has(value)) ?? false);

  // ---- 1. relations: every FK points at an existing row
  for (const [collection, field, target] of FK_EDGES) {
    for (const row of ds[collection] ?? []) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      if (!known(target, String(value))) fail("fk", `${collection}.${field}=${value} -> ${target}`);
    }
  }
  // gl_accounts of wallets are MERCHANT_WALLET accounts owned by the wallet's merchant
  const glById = new Map<string, Row>(ds.glAccounts!.map((row) => [String(row.id), row]));
  const walletById = new Map<string, Row>(ds.wallets!.map((row) => [String(row.id), row]));
  for (const wallet of ds.wallets!) {
    const gl = glById.get(String(wallet.glAccountId));
    if (!gl || gl.accountType !== "MERCHANT_WALLET" || String(gl.ownerId) !== String(wallet.merchantId)) fail("wallet.gl", String(wallet.id));
  }
  const applicationById = new Map<string, Row>(ds.applications!.map((row) => [String(row.id), row]));
  for (const app of ds.applications!) {
    if (walletById.get(String(app.assignedWalletId))?.merchantId !== app.merchantId) fail("application.wallet.merchant", String(app.id));
  }
  for (const link of ds.paymentLinks!) {
    const app = applicationById.get(String(link.applicationId));
    if (!app || walletById.get(String(link.walletId))?.merchantId !== app.merchantId) fail("link.wallet.merchant", String(link.id));
  }

  // ---- 2. ledger: exact, per entry, per account, no future, unique keys
  const entryTotals = new Map<string, bigint>();
  const entryAt = new Map<string, number>();
  const keys = new Set<string>();
  for (const entry of ds.journalEntries!) {
    const key = `${entry.refType}:${entry.refId}`;
    if (keys.has(key)) fail("ledger.duplicate-key", key);
    keys.add(key);
    entryAt.set(String(entry.id), ts(entry.createdAt));
    if (ts(entry.createdAt) > endMs) fail("ledger.future", key);
  }
  const accountBalance = new Map<string, bigint>();
  const lineCount = new Map<string, number>();
  let drift = 0n;
  for (const line of ds.journalLines!) {
    const amount = money(line.amount);
    if (amount <= 0n) fail("ledger.non-positive-line", String(line.id));
    if (typeof line.amount !== "string") fail("ledger.not-decimal-string", String(line.id));
    const signed = line.direction === "DEBIT" ? amount : -amount;
    drift += signed;
    const entryKey = String(line.entryId);
    entryTotals.set(entryKey, (entryTotals.get(entryKey) ?? 0n) + signed);
    lineCount.set(entryKey, (lineCount.get(entryKey) ?? 0) + 1);
    if (entryAt.get(entryKey) !== ts(line.createdAt)) fail("ledger.line-date", String(line.id));
    accountBalance.set(String(line.glAccountId), (accountBalance.get(String(line.glAccountId)) ?? 0n) + signed);
  }
  for (const [entryId, total] of entryTotals) if (total !== 0n) fail("ledger.unbalanced-entry", entryId);
  for (const entry of ds.journalEntries!) if ((lineCount.get(String(entry.id)) ?? 0) < 2) fail("ledger.entry-without-lines", String(entry.id));
  if (drift !== 0n) fail("ledger.drift", drift.toString());
  metrics.ledgerDrift = drift.toString();

  // ---- 3. checkpoints and shards reproduce the plain line sums
  const lineSums = new Map<string, bigint>();
  const afterCheckpoint = new Map<string, bigint>();
  for (const line of ds.journalLines!) {
    const id = String(line.glAccountId);
    const signed = line.direction === "DEBIT" ? money(line.amount) : -money(line.amount);
    lineSums.set(id, (lineSums.get(id) ?? 0n) + signed);
    const checkpoint = ctx.checkpoints.get(id);
    if (checkpoint && ts(line.createdAt) > checkpoint.at.getTime()) afterCheckpoint.set(id, (afterCheckpoint.get(id) ?? 0n) + signed);
  }
  for (const [id, checkpoint] of ctx.checkpoints) {
    if (money(checkpoint.balance) + (afterCheckpoint.get(id) ?? 0n) !== (lineSums.get(id) ?? 0n)) fail("checkpoint.live-balance", id);
    if (checkpoint.at.getTime() > endMs) fail("checkpoint.future", id);
  }
  if (ds.glAccountShards!.length > 0) {
    const shardSums = new Map<string, bigint>();
    for (const shard of ds.glAccountShards!) shardSums.set(String(shard.glAccountId), (shardSums.get(String(shard.glAccountId)) ?? 0n) + money(shard.currentBalance));
    for (const [id, sum] of lineSums) if ((shardSums.get(id) ?? 0n) !== sum) fail("shard.sum", id);
  }

  // ---- 4. attempts: lifecycle, timestamps, money, ledger linkage
  const entryById = ids.get("journalEntries")!;
  const linkById = new Map<string, Row>(ds.paymentLinks!.map((row) => [String(row.id), row]));
  const confirmed = new Map<string, number>();
  const active = new Map<string, number>();
  const refundedSum = new Map<string, bigint>();
  const refundExecuted = new Map<string, Row[]>();
  for (const adjustment of ds.adjustments!) {
    if (adjustment.type === "REFUND" && adjustment.state === "EXECUTED" && adjustment.sourceAttemptId) {
      const list = refundExecuted.get(String(adjustment.sourceAttemptId)) ?? [];
      list.push(adjustment);
      refundExecuted.set(String(adjustment.sourceAttemptId), list);
      refundedSum.set(String(adjustment.sourceAttemptId), (refundedSum.get(String(adjustment.sourceAttemptId)) ?? 0n) + money(adjustment.amount));
    }
  }
  const ledgerUse = new Set<string>();
  let businessHours = 0;
  const seenRef = new Set<string>();
  const seenIdem = new Set<string>();
  for (const attempt of ds.paymentAttempts!) {
    const id = String(attempt.id);
    const status = String(attempt.status);
    const info = meta.attempts.get(id);
    if (seenRef.has(String(attempt.reference))) fail("attempt.reference-unique", id);
    seenRef.add(String(attempt.reference));
    const idem = `${attempt.linkId}:${attempt.idempotencyKey}`;
    if (seenIdem.has(idem)) fail("attempt.idempotency-unique", id);
    seenIdem.add(idem);
    if (info) {
      const bad = invalidPathStep(info.path);
      if (bad) fail("attempt.lifecycle", `${id} ${bad}`);
      if (info.path[info.path.length - 1] !== status) fail("attempt.path-status", id);
      for (let index = 1; index < info.times.length; index += 1) {
        if (info.times[index]!.getTime() < info.times[index - 1]!.getTime()) fail("attempt.times-monotonic", id);
      }
      if (info.times.length !== info.path.length) fail("attempt.path-times", id);
      if (info.times[0]!.getTime() !== ts(attempt.createdAt)) fail("attempt.created-time", id);
      if (info.times[info.times.length - 1]!.getTime() > endMs) fail("attempt.future", id);
      if (info.times[info.times.length - 1]!.getTime() !== ts(attempt.updatedAt)) fail("attempt.updated-time", id);
    }
    if (ts(attempt.createdAt) > endMs || ts(attempt.updatedAt) > endMs) fail("attempt.future", id);
    if (ts(attempt.updatedAt) < ts(attempt.createdAt)) fail("attempt.updated-before-created", id);
    const terminal = TERMINAL_STATUSES.has(status);
    if (terminal !== Boolean(attempt.terminalAt)) fail("attempt.terminal-at", id);
    if (attempt.terminalAt && (ts(attempt.terminalAt) < ts(attempt.createdAt) || ts(attempt.terminalAt) > endMs)) fail("attempt.terminal-range", id);
    if (IN_FLIGHT_STATUSES.has(status) && ts(attempt.expiresAt) <= endMs && status !== "UNKNOWN" && info?.kind !== "AML_HELD") fail("attempt.inflight-expired", id);
    if (ts(attempt.expiresAt) < ts(attempt.createdAt) || ts(attempt.graceExpiresAt) < ts(attempt.expiresAt) && !IN_FLIGHT_STATUSES.has(status)) fail("attempt.expiry-order", id);
    // money
    const requested = money(attempt.requestedAmount);
    const surcharge = money(attempt.surchargeAmount);
    const total = money(attempt.totalChargedAmount);
    const commission = money(attempt.platformCommissionAmount);
    const net = money(attempt.netMerchantAmount);
    if (total !== requested + surcharge) fail("attempt.total", id);
    const bearer = String(attempt.feeBearer);
    if (status !== "BLOCKED" || true) {
      if (bearer === "MERCHANT_ABSORBS" && (net !== requested - commission || surcharge !== 0n)) fail("attempt.net.absorbs", id);
      if (bearer === "PAYER_SURCHARGE" && (net !== requested || surcharge !== commission)) fail("attempt.net.surcharge", id);
      if (bearer === "SPLIT" && net !== requested - commission + surcharge) fail("attempt.net.split", id);
    }
    if (attempt.gatewayFeeAmount !== null && (money(attempt.gatewayFeeAmount) < 0n || money(attempt.gatewayFeeAmount) > total)) fail("attempt.gateway-fee", id);
    if (SETTLED_STATUSES.has(status) !== (attempt.settledAmount !== null)) fail("attempt.settled-amount", id);
    if (attempt.currency !== "LYD") fail("attempt.currency", id);
    if (typeof attempt.requestedAmount !== "string") fail("attempt.decimal-string", id);
    // ledger linkage
    const settled = SETTLED_STATUSES.has(status);
    if (settled && !attempt.ledgerEntryId) fail("attempt.settled-without-ledger", id);
    if (!settled && attempt.ledgerEntryId) fail("attempt.ledger-on-unsettled", id);
    if (attempt.ledgerEntryId) {
      if (!entryById.has(String(attempt.ledgerEntryId))) fail("attempt.ledger-missing", id);
      if (ledgerUse.has(String(attempt.ledgerEntryId))) fail("attempt.ledger-shared", id);
      ledgerUse.add(String(attempt.ledgerEntryId));
    }
    // counters
    if (settled && info?.kind !== "SUSPENSE") confirmed.set(String(attempt.linkId), (confirmed.get(String(attempt.linkId)) ?? 0) + 1);
    if (IN_FLIGHT_STATUSES.has(status)) active.set(String(attempt.linkId), (active.get(String(attempt.linkId)) ?? 0) + 1);
    const link = linkById.get(String(attempt.linkId));
    if (link) {
      if (ts(attempt.createdAt) < ts(link.createdAt)) fail("attempt.before-link", id);
      if (attempt.applicationId !== link.applicationId) fail("attempt.link-application", id);
      if (money(attempt.requestedAmount) !== money(link.amount)) fail("attempt.link-amount", id);
      const app = applicationById.get(String(attempt.applicationId));
      if (app && app.merchantId !== attempt.merchantId) fail("attempt.merchant", id);
    }
    // refunds
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") {
      const sum = refundedSum.get(id) ?? 0n;
      if ((status === "REFUNDED") !== (sum === total) || sum > total || sum === 0n) fail("attempt.refund-sum", id);
    } else if ((refundedSum.get(id) ?? 0n) > 0n) fail("attempt.refund-on-status", id);
    if (attempt.createdAt instanceof Date) {
      const hour = tripoliHour(attempt.createdAt);
      if (hour >= 8 && hour <= 23) businessHours += 1;
    }
  }
  metrics.businessHourShare = ds.paymentAttempts!.length > 0 ? (businessHours / ds.paymentAttempts!.length).toFixed(3) : "n/a";

  // ---- 5. confirmation entries reproduce the engine's fee/settlement math
  const linesByEntry = new Map<string, Row[]>();
  for (const line of ds.journalLines!) {
    const list = linesByEntry.get(String(line.entryId)) ?? [];
    list.push(line);
    linesByEntry.set(String(line.entryId), list);
  }
  const accountType = (id: string): string => String(glById.get(id)?.accountType ?? ctx.refs.glAccounts.find((a) => a.id === id)?.accountType ?? "?");
  for (const attempt of ds.paymentAttempts!) {
    const info = meta.attempts.get(String(attempt.id));
    if (!attempt.ledgerEntryId || !info || info.kind === "SUSPENSE") continue;
    const lines = linesByEntry.get(String(attempt.ledgerEntryId)) ?? [];
    const credit = (type: string): bigint => lines.filter((line) => line.direction === "CREDIT" && accountType(String(line.glAccountId)) === type).reduce((sum, line) => sum + money(line.amount), 0n);
    if (info.ownershipMode !== "MERCHANT_DIRECT" && credit("MERCHANT_WALLET") !== money(attempt.netMerchantAmount)) fail("settlement.wallet-credit", String(attempt.id));
    if (credit("PLATFORM_INCOME") !== money(attempt.platformCommissionAmount)) fail("settlement.commission-credit", String(attempt.id));
    if (info.ownershipMode === "MERCHANT_DIRECT" && credit("MERCHANT_WALLET") !== 0n) fail("settlement.direct-wallet", String(attempt.id));
    if (info.feeAccrual && info.ownershipMode === "PLATFORM_CLEARING" && info.kind !== "AML_RELEASED" && credit("GATEWAY_FEE_ACCRUAL") !== money(attempt.gatewayFeeAmount)) fail("settlement.fee-accrual", String(attempt.id));
    const line = lines.find((l) => l.glAccountId === info.walletGlAccountId && l.direction === "CREDIT");
    if (info.ownershipMode !== "MERCHANT_DIRECT" && !line) fail("settlement.wrong-wallet", String(attempt.id));
  }

  // ---- 6. link counters / slot reservation
  for (const link of ds.paymentLinks!) {
    const id = String(link.id);
    if (Number(link.confirmedCount) !== (confirmed.get(id) ?? 0)) fail("link.confirmed-count", id);
    if (Number(link.activeLockedCount) !== (active.get(id) ?? 0)) fail("link.active-count", id);
    if (!link.infiniteUse && Number(link.confirmedCount) + Number(link.activeLockedCount) > Number(link.useCount)) fail("link.slot-overflow", id);
    if (!link.infiniteUse && link.state === "COMPLETED" && Number(link.confirmedCount) < Number(link.useCount)) fail("link.completed-early", id);
    if (!link.infiniteUse && Number(link.confirmedCount) >= Number(link.useCount) && link.state !== "COMPLETED") fail("link.not-completed", id);
    if (link.expiresAt && ts(link.expiresAt) < ts(link.createdAt)) fail("link.expiry", id);
    if (link.state === "PENDING" && link.expiresAt && ts(link.expiresAt) <= endMs && Number(link.activeLockedCount) === 0) fail("link.stale-pending", id);
  }
  const groupSuccess = new Map<string, number>();
  for (const attempt of ds.paymentAttempts!) {
    if (SETTLED_STATUSES.has(String(attempt.status)) && meta.attempts.get(String(attempt.id))?.kind !== "SUSPENSE") groupSuccess.set(String(attempt.attemptGroupId), (groupSuccess.get(String(attempt.attemptGroupId)) ?? 0) + 1);
  }
  for (const group of ds.attemptGroups!) if (Number(group.successCount) !== (groupSuccess.get(String(group.id)) ?? 0)) fail("group.success-count", String(group.id));
  // DB: CHECK attempt_groups_single_success (success_count <= 1)
  for (const group of ds.attemptGroups!) if (Number(group.successCount) > 1) fail("group.single-success", String(group.id));

  // ---- 7. maker-checker
  const userById = new Map<string, Row>(ds.users!.map((row) => [String(row.id), row]));
  for (const approval of ds.approvalRequests!) {
    const id = String(approval.id);
    const maker = userById.get(String(approval.makerUserId));
    const checker = approval.checkerUserId ? userById.get(String(approval.checkerUserId)) : null;
    if (approval.checkerUserId && approval.makerUserId === approval.checkerUserId) fail("approval.maker-is-checker", id);
    if (!maker) fail("approval.maker", id);
    else if (maker.role !== "OPERATOR" || maker.id === meta.systemUserId) {
      if (!maker.isMaker && maker.id !== meta.systemUserId && !String(approval.subjectType).includes("OPERATOR")) fail("approval.maker-flag", id);
    }
    if (checker && !checker.isChecker) fail("approval.checker-flag", id);
    const decided = ["APPROVED", "EXECUTED", "REJECTED"].includes(String(approval.state));
    if (decided && !approval.checkerUserId) fail("approval.decided-without-checker", id);
    if (!decided && approval.checkerUserId) fail("approval.checker-before-decision", id);
    if (ts(approval.updatedAt) < ts(approval.createdAt) || ts(approval.updatedAt) > endMs) fail("approval.time", id);
  }

  // ---- 8. adjustments, disputes, cash-outs, wallets
  const disputeById = new Map<string, Row>(ds.disputes!.map((row) => [String(row.id), row]));
  const attemptById = new Map<string, Row>(ds.paymentAttempts!.map((row) => [String(row.id), row]));
  for (const adjustment of ds.adjustments!) {
    const id = String(adjustment.id);
    if ((adjustment.state === "EXECUTED") !== Boolean(adjustment.journalEntryId)) fail("adjustment.journal", id);
    if (adjustment.state === "EXECUTED" && adjustment.type !== "CORRECTION" && !adjustment.journalEntryId) fail("adjustment.executed-no-journal", id);
    if (money(adjustment.amount) <= 0n) fail("adjustment.amount", id);
    const attempt = adjustment.sourceAttemptId ? attemptById.get(String(adjustment.sourceAttemptId)) : null;
    if (adjustment.type === "REFUND" && attempt && money(adjustment.amount) > money(attempt.totalChargedAmount)) fail("adjustment.refund-over-total", id);
    if (adjustment.disputeId) {
      const dispute = disputeById.get(String(adjustment.disputeId));
      if (!dispute || dispute.adjustmentId !== adjustment.id) fail("adjustment.dispute-backlink", id);
    }
    if (ts(adjustment.updatedAt) < ts(adjustment.createdAt) || ts(adjustment.updatedAt) > endMs) fail("adjustment.time", id);
  }
  const adjustmentById = new Map<string, Row>(ds.adjustments!.map((row) => [String(row.id), row]));
  const gatewayUnique = new Set<string>();
  for (const dispute of ds.disputes!) {
    const id = String(dispute.id);
    const attempt = attemptById.get(String(dispute.attemptId));
    if (!attempt || attempt.status !== "DISPUTED") fail("dispute.attempt-status", id);
    if (attempt && ts(dispute.openedAt) < ts(attempt.terminalAt)) fail("dispute.before-settlement", id);
    if (attempt && money(dispute.amount) > money(attempt.totalChargedAmount)) fail("dispute.amount", id);
    const key = `${dispute.gatewayId}:${dispute.externalDisputeRef}`;
    if (gatewayUnique.has(key)) fail("dispute.unique", id);
    gatewayUnique.add(key);
    const finished = ["WON", "LOST", "EXPIRED", "WITHDRAWN"].includes(String(dispute.status));
    if (finished !== Boolean(dispute.outcomeAt)) fail("dispute.outcome-at", id);
    if (dispute.outcomeAt && (ts(dispute.outcomeAt) < ts(dispute.openedAt) || ts(dispute.outcomeAt) > endMs)) fail("dispute.outcome-time", id);
    const adjustment = adjustmentById.get(String(dispute.adjustmentId));
    if (!adjustment || adjustment.disputeId !== dispute.id) fail("dispute.adjustment-backlink", id);
    else if ((adjustment.state === "EXECUTED") !== ["WON", "LOST", "EXPIRED"].includes(String(dispute.status))) fail("dispute.adjustment-state", id);
  }
  for (const cashout of ds.cashoutRequests!) {
    const id = String(cashout.id);
    const wallet = walletById.get(String(cashout.walletId));
    if (!wallet || wallet.merchantId !== cashout.merchantId) fail("cashout.wallet", id);
    if (["COMPLETE", "REJECTED", "SUBTRACTED"].includes(String(cashout.state)) !== Boolean(cashout.adjustmentId)) fail("cashout.adjustment", id);
    if (ts(cashout.updatedAt) < ts(cashout.createdAt) || ts(cashout.updatedAt) > endMs) fail("cashout.time", id);
  }
  // wallets never below -ceiling at any instant
  const merchantById = new Map<string, Row>(ds.merchants!.map((row) => [String(row.id), row]));
  const walletEvents = new Map<string, Array<[number, bigint]>>();
  const walletIds = new Set(ds.wallets!.map((wallet) => String(wallet.glAccountId)));
  for (const line of ds.journalLines!) {
    const id = String(line.glAccountId);
    if (!walletIds.has(id)) continue;
    const list = walletEvents.get(id) ?? [];
    list.push([ts(line.createdAt), line.direction === "CREDIT" ? money(line.amount) : -money(line.amount)]);
    walletEvents.set(id, list);
  }
  let negativeWallets = 0;
  for (const wallet of ds.wallets!) {
    const events = (walletEvents.get(String(wallet.glAccountId)) ?? []).sort((a, b) => a[0] - b[0]);
    const ceiling = money(merchantById.get(String(wallet.merchantId))?.negativeBalanceCeiling ?? "0");
    let running = 0n;
    let lowest = 0n;
    for (const [, delta] of events) {
      running += delta;
      if (running < lowest) lowest = running;
    }
    if (lowest < -ceiling) fail("wallet.below-ceiling", String(wallet.id));
    if (running < 0n) negativeWallets += 1;
  }
  metrics.negativeWallets = negativeWallets;

  // ---- 9. reconciliation
  const runById = new Map<string, Row>(ds.reconciliationRuns!.map((row) => [String(row.id), row]));
  const statsByRun = new Map<string, { lines: number; matched: number }>();
  for (const item of ds.reconciliationItems!) {
    const run = runById.get(String(item.runId));
    if (!run) continue;
    const stats = statsByRun.get(String(run.id)) ?? { lines: 0, matched: 0 };
    stats.lines += 1;
    if (item.result === "MATCHED") stats.matched += 1;
    statsByRun.set(String(run.id), stats);
    if (ts(run.ingestedAt) > endMs) fail("recon.future", String(run.id));
    const attempt = item.attemptId ? attemptById.get(String(item.attemptId)) : null;
    if (item.result === "MISSING_LOCALLY" && item.attemptId) fail("recon.missing-locally-attempt", String(item.id));
    if (item.result !== "MISSING_LOCALLY" && !attempt) fail("recon.attempt-required", String(item.id));
    if (attempt && item.result === "MATCHED" && money(item.statementAmount) !== money(attempt.settledAmount)) fail("recon.matched-amount", String(item.id));
    if (attempt && !SETTLED_STATUSES.has(String(attempt.status))) fail("recon.unsettled-attempt", String(item.id));
    if (attempt && ts(run.windowEnd) < ts(attempt.terminalAt)) fail("recon.window", String(item.id));
  }
  for (const run of ds.reconciliationRuns!) {
    const stats = statsByRun.get(String(run.id)) ?? { lines: 0, matched: 0 };
    const json = run.statsJson as Row;
    if (json.statementLines !== stats.lines || json.matched !== stats.matched || json.mismatched !== stats.lines - stats.matched) fail("recon.stats", String(run.id));
    if (ts(run.windowEnd) <= ts(run.windowStart) || ts(run.ingestedAt) < ts(run.windowEnd)) fail("recon.window-order", String(run.id));
  }

  // ---- 10. generic time sanity and uniqueness
  for (const [name, rows] of Object.entries(ds)) {
    for (const row of rows) {
      if (row.createdAt instanceof Date && row.createdAt.getTime() > endMs) fail("time.future", `${name}:${row.id}`);
      if (row.createdAt instanceof Date && row.updatedAt instanceof Date && row.updatedAt.getTime() < row.createdAt.getTime()) fail("time.updated-before-created", `${name}:${row.id}`);
    }
  }
  const emails = new Set<string>();
  for (const user of ds.users!) {
    const email = String(user.email).toLowerCase();
    if (emails.has(email)) fail("user.email-unique", email);
    emails.add(email);
  }
  const idUnique = new Set<string>();
  for (const [name, rows] of Object.entries(ds)) {
    if (name === "glAccountShards") continue;
    for (const row of rows) {
      if (!row.id) continue;
      const key = String(row.id);
      if (idUnique.has(key)) fail("id.unique", `${name}:${key}`);
      idUnique.add(key);
    }
  }
  const approvalSubjects = new Set(ds.approvalRequests!.map((row) => `${row.subjectType}:${row.subjectId}:${row.state}`));
  void approvalSubjects;

  // ---- 11. volumes: the seven formerly unused profile fields drive generation
  const v = ctx.config.volumes;
  const staff = ds.users!.filter((user) => user.merchantId === null).length;
  const feasible = (volume: number, per: number, min: number, max: number): boolean => volume >= per * min && volume <= per * max;
  const volumeChecks: Array<[string, number, number, boolean]> = [
    ["joinRequests", ds.joinRequests!.length, v.joinRequests, feasible(v.joinRequests, v.merchants, 1, 3)],
    ["wallets", ds.wallets!.length, v.wallets, feasible(v.wallets, v.merchants, 1, 3)],
    ["applications", ds.applications!.length, v.applications, feasible(v.applications, v.merchants, 1, 5)],
    ["beneficialOwners", ds.beneficialOwners!.length, v.beneficialOwners, feasible(v.beneficialOwners, v.merchants, 1, 6)],
    ["users", ds.users!.length, Math.max(v.users, staff + v.merchants), feasible(v.users - staff, v.merchants, 1, 8)],
  ];
  for (const [name, actual, expected, feasibleVolume] of volumeChecks) {
    metrics[`volume.${name}`] = `${actual}/${expected}`;
    if (feasibleVolume && actual !== expected) fail("volume.mismatch", `${name} ${actual} != ${expected}`);
  }
  metrics["volume.kybDocuments"] = `${ds.kybDocuments!.length}/${v.kybDocuments}`;
  metrics["volume.amlCases"] = `${ds.amlCases!.length}/${v.amlCases}`;
  metrics["volume.merchants"] = `${ds.merchants!.length}/${v.merchants}`;
  if (ds.merchants!.length !== v.merchants) fail("volume.mismatch", `merchants ${ds.merchants!.length} != ${v.merchants}`);

  const total = Object.values(byRule).reduce((sum, count) => sum + count, 0);
  return { total, byRule, samples, metrics };
};
