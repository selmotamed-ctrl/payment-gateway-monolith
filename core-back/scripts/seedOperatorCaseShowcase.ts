/**
 * Development/test seed for the type-aware operator-case queue.
 *
 * The synthetic history seeder writes the legacy attempt/reconciliation case
 * kinds. This script adds one representative OPEN case for the operational
 * groups that have no natural attempt/reconciliation evidence (backup, report,
 * route, statement, ledger, KYB, credential, outbox, audit, cash-out, dispute,
 * emergency and commission). It is idempotent: a subject key already present is
 * skipped. Run it after the synthetic seeder and `backfill-operator-cases`.
 *
 *   bun run seed-operator-case-showcase
 */
import "dotenv/config";
import { client } from "../prisma/client";
import { caseMetadata, type CaseTypeDefinition } from "../lib/operatorCases/caseCatalog";
import { appendCaseEvent, caseMetadataFields } from "../lib/operatorCases/caseService";

type Showcase = {
  subjectKey: string;
  title: string;
  detail: string;
};

const firstId = async (query: Promise<{ id: string } | null>): Promise<string | null> => {
  const row = await query;
  return row?.id ?? null;
};

const createShowcase = async (
  entry: Showcase,
  definition: CaseTypeDefinition,
): Promise<boolean> => {
  const existing = await client.operatorCase.findFirst({
    where: { subjectKey: entry.subjectKey },
    select: { id: true },
  });
  if (existing) return false;

  const meta = caseMetadata({
    subjectKey: entry.subjectKey,
    kind: "MANUAL_REVIEW",
    title: entry.title,
    detail: entry.detail,
  });
  const now = new Date();
  const created = await client.operatorCase.create({
    data: {
      kind: "MANUAL_REVIEW",
      priority: definition.defaultPriority,
      state: "OPEN",
      subjectKey: entry.subjectKey,
      ...caseMetadataFields(meta),
      resolutionNotes: entry.detail,
      slaDueAt: new Date(now.getTime() + definition.defaultSlaHours * 60 * 60 * 1000),
    },
    select: { id: true, caseNumber: true },
  });
  await appendCaseEvent(client, String(created.id), {
    eventType: "OPENED",
    summary: meta.titleText,
    detailsJson: meta.detailsJson,
    now,
  });
  if (meta.subjectType && meta.subjectId) {
    await client.operatorCaseLink.create({
      data: {
        caseId: created.id,
        linkType: meta.subjectType,
        targetId: meta.subjectId,
        labelKey: meta.titleKey,
        labelText: meta.subjectLabel,
      },
    }).catch(() => undefined);
  }
  return true;
};

const main = async (): Promise<void> => {
  const glAccountId = await firstId(client.glAccount.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const report = await client.regulatoryReport.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, reportCode: true, periodKey: true },
  });
  const routeId = await firstId(client.railRoute.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const statementSourceId = await firstId(client.statementSource.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const cashoutId = await firstId(client.cashoutRequest.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const disputeId = await firstId(client.dispute.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const approvalId = await firstId(client.approvalRequest.findFirst({
    where: { state: "PENDING_REVIEW" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const merchantId = await firstId(client.merchant.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const kybId = await firstId(client.kybDocument.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const credentialId = await firstId(client.credentialSet.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));
  const amlCaseId = await firstId(client.amlCase.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  }));

  const reportLabel = [report?.reportCode, report?.periodKey].filter(Boolean).join(" ");
  const entries: Array<Showcase & { code: string }> = [
    {
      code: "BACKUP_FAILED",
      subjectKey: "platform.backup:backup-failed:seed-showcase",
      title: "Backup failed: seed showcase",
      detail: "The showcase backup target failed its last run. Open System Backups, verify the target and record the recovery evidence before closing.",
    },
    {
      code: "REPORT_OVERDUE",
      subjectKey: report ? `report.overdue:${report.id}` : "report.overdue:seed-showcase",
      title: reportLabel
        ? `Regulatory report ${reportLabel} overdue`
        : "Regulatory report overdue: seed showcase",
      detail: "The seeded regulatory return is past its filing date and remains a draft. File it or record the filing reference.",
    },
    {
      code: "ROUTE_HEALTH",
      subjectKey: routeId ? `route.health:degraded:${routeId}` : "route.health:degraded:seed-showcase",
      title: "Route health degraded: seed showcase",
      detail: "The showcase route is degraded. Review the passive outcomes, canary traffic and recovery probe before changing its health.",
    },
    {
      code: "STATEMENT_MISSING",
      subjectKey: statementSourceId ? `statement.missing:${statementSourceId}:seed-slot` : "statement.missing:seed-source:seed-slot",
      title: "Statement missing: seed showcase",
      detail: "The showcase statement source did not deliver its scheduled file. Check the source and ingest the missing statement.",
    },
    {
      code: "LEDGER_SHARD",
      subjectKey: glAccountId ? `ledger.shard:${glAccountId}:0` : "ledger.shard:seed-account:0",
      title: "Ledger shard mismatch: seed showcase",
      detail: "The showcase shard disagrees with its journal lines. Inspect or repair the projection in the GL account drawer.",
    },
    {
      code: "LEDGER_INVARIANT",
      subjectKey: "ledger.invariant:seed-showcase",
      title: "Ledger invariant drift: seed showcase",
      detail: "The showcase invariant check reports a non-zero drift. Review the journal evidence before taking action.",
    },
    {
      code: "KYB_SCAN_FAILED",
      subjectKey: kybId ? `kyb-scan-failed:${kybId}` : "kyb-scan-failed:seed-document",
      title: "KYB scan repeatedly failed: seed showcase",
      detail: "The showcase KYB document has no scanner verdict. Inspect the document and scanner state; do not approve it blindly.",
    },
    {
      code: "CREDENTIAL_EXPIRED",
      subjectKey: credentialId ? `credential.expired:${credentialId}` : "credential.expired:seed-credential",
      title: "Gateway credential expired: seed showcase",
      detail: "The showcase credential set has expired. Replace or re-verify the credential before restoring its routes.",
    },
    {
      code: "OUTBOX_PARKED",
      subjectKey: "outbox.parked:seed-showcase",
      title: "Outbox events parked: seed showcase",
      detail: "The showcase outbox topic has parked events. Inspect the last error and replay or discard the parked rows.",
    },
    {
      code: "AUDIT_CHAIN_BROKEN",
      subjectKey: "audit.chain_broken:seed-showcase",
      title: "Audit chain broken: seed showcase",
      detail: "The showcase audit chain has a broken link. Treat this as confidential and investigate the audit evidence.",
    },
    {
      code: "CASHOUT_SLA",
      subjectKey: cashoutId ? `cashout.sla:${cashoutId}` : "cashout.sla:seed-cashout",
      title: "Cash-out SLA breached: seed showcase",
      detail: "The showcase cash-out is waiting past its operator SLA. Process it or record why it is still pending.",
    },
    {
      code: "DISPUTE_EXPIRED",
      subjectKey: disputeId ? `dispute.expired:${disputeId}` : "dispute.expired:seed-dispute",
      title: "Dispute evidence window expired: seed showcase",
      detail: "The showcase dispute passed its evidence deadline. Review the evidence and finance outcome.",
    },
    {
      code: "EMERGENCY_UNRATIFIED",
      subjectKey: approvalId ? `emergency.unratified:${approvalId}` : "emergency.unratified:seed-approval",
      title: "Emergency action not ratified: seed showcase",
      detail: "The showcase emergency action missed its ratification deadline. Ratify, extend or revert it.",
    },
    {
      code: "COMMISSION_RECEIVABLE_AGED",
      subjectKey: merchantId ? `commission.receivable.aged:${merchantId}` : "commission.receivable.aged:seed-merchant",
      title: "Aged commission receivable: seed showcase",
      detail: "The showcase merchant-direct commission receivable is older than the aging window.",
    },
    {
      code: "AML_SLA_BREACH",
      subjectKey: amlCaseId ? `aml.sla_breached:${amlCaseId}` : "aml.sla_breached:seed-aml-case",
      title: "AML review SLA breached: seed showcase",
      detail: "The showcase AML case passed its review deadline. Continue the investigation or escalate it.",
    },
    {
      code: "REPORT_SCOPE_VIOLATION",
      subjectKey: "merchant_report_scope:seed-showcase",
      title: "Merchant report scope violation: seed showcase",
      detail: "The showcase merchant report returned a row outside its tenant scope. Suspend the report and investigate.",
    },
    {
      code: "PLATFORM_ALERT",
      subjectKey: "platform.seed_showcase",
      title: "Platform alert: seed showcase",
      detail: "A showcase platform condition needs an operator review. Open the related platform screen and investigate.",
    },
  ];

  let created = 0;
  for (const entry of entries) {
    const meta = caseMetadata({
      subjectKey: entry.subjectKey,
      kind: "MANUAL_REVIEW",
      title: entry.title,
      detail: entry.detail,
    });
    if (meta.caseType.code !== entry.code) {
      console.warn(`skip ${entry.code}: classified as ${meta.caseType.code}`);
      continue;
    }
    const ok = await createShowcase(entry, meta.caseType);
    if (ok) {
      created += 1;
      console.log(`created ${entry.code}: ${entry.title}`);
    } else {
      console.log(`exists ${entry.code}: ${entry.subjectKey}`);
    }
  }
  console.log(`operator case showcase: ${created} created, ${entries.length - created} already present`);
};

main()
  .catch((error) => {
    console.error(`seedOperatorCaseShowcase failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect().catch(() => undefined));
