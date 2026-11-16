/**
 * Backfills the type-aware case fields for rows created before schema v41 and
 * seeds the append-only case timeline. Safe to run more than once: existing
 * non-null fields are left alone and an existing event/link is not duplicated.
 */
import "dotenv/config";
import { client } from "../prisma/client";
import { caseMetadata, caseReference } from "../lib/operatorCases/caseCatalog";
import { appendCaseEvent, caseMetadataFields } from "../lib/operatorCases/caseService";

const main = async (): Promise<void> => {
  const cases = await client.operatorCase.findMany({
    include: {
      events: { select: { id: true }, take: 1 },
      links: { select: { id: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });
  let updated = 0;
  for (const row of cases) {
    let notes = row.summary ?? row.resolutionNotes ?? "";
    if (!row.summary || row.state === "RESOLVED") {
      const origin = await client.auditLog.findFirst({
        where: {
          entityType: "OPERATOR_CASE",
          entityId: row.id,
          action: { in: ["PLATFORM_MONITOR_CASE_RAISED", "REGULATORY_REPORT_OVERDUE"] },
        },
        orderBy: { createdAt: "asc" },
      });
      const detail = origin?.afterJson && typeof origin.afterJson === "object"
        ? (origin.afterJson as Record<string, unknown>).detail
        : null;
      if (typeof detail === "string" && detail.trim()) notes = detail.trim();
    }
    let reportTitle: string | null = null;
    const reportId = row.subjectType === "REGULATORY_REPORT" && row.subjectId
      ? row.subjectId
      : String(row.subjectKey ?? "").startsWith("report.overdue:")
        ? String(row.subjectKey).slice("report.overdue:".length)
        : null;
    if (reportId) {
      const report = await client.regulatoryReport.findUnique({
        where: { id: reportId },
        select: { reportCode: true, periodKey: true, status: true, dueAt: true },
      });
      if (report) {
        const label = [report.reportCode, report.periodKey].filter(Boolean).join(" ") || reportId;
        notes = `Regulatory report ${label} was due ${report.dueAt?.toISOString() ?? "unknown"} and is still ${report.status}.`;
        reportTitle = `Regulatory report ${label} overdue`;
      }
    }
    const meta = caseMetadata({
      subjectKey: row.subjectKey,
      kind: row.kind,
      attemptId: row.attemptId,
      reconciliationItemId: row.reconciliationItemId,
      title: row.titleText,
      detail: notes,
    });
    const target = String(row.subjectKey ?? "").split(":").filter(Boolean).at(-1) ?? "backup";
    if (!row.titleText && meta.caseType.code.startsWith("BACKUP_")) {
      meta.titleText = `${meta.caseType.code === "BACKUP_FAILED" ? "Backup failed" : "Backup issue"}: ${target}`;
    }
    if (!row.titleText && meta.caseType.code === "REPORT_OVERDUE") meta.titleText = reportTitle ?? "Regulatory report overdue";
    const nextTitle = reportTitle && row.caseType === "REPORT_OVERDUE" ? reportTitle : (row.titleText ?? meta.titleText);
    const reference = caseReference(row.caseNumber, row.createdAt);
    await client.operatorCase.update({
      where: { id: row.id },
      data: {
        ...(row.caseType ? {} : { caseType: meta.caseType.code }),
        ...(row.source ? {} : { source: meta.source }),
        ...(row.domain ? {} : { domain: meta.domain }),
        ...(row.confidentiality === "NORMAL" && meta.confidentiality !== "NORMAL"
          ? { confidentiality: meta.confidentiality }
          : {}),
        ...(row.titleKey ? {} : { titleKey: meta.titleKey }),
        ...(nextTitle !== row.titleText ? { titleText: nextTitle } : {}),
        ...(row.state === "RESOLVED" || !row.summary ? { summary: meta.summary || notes.slice(0, 4000) } : {}),
        ...(row.detailsJson === null || row.detailsJson === undefined
          ? { detailsJson: meta.detailsJson as never }
          : {}),
        ...(row.subjectType ? {} : { subjectType: meta.subjectType }),
        ...(row.subjectId ? {} : { subjectId: meta.subjectId }),
        ...(row.subjectLabel ? {} : { subjectLabel: meta.subjectLabel }),
        ...(row.state === "RESOLVED" && !row.resolvedAt ? { resolvedAt: row.updatedAt } : {}),
      },
    });
    if (row.events.length === 0) {
      await appendCaseEvent(client, row.id, {
        eventType: "OPENED",
        summary: nextTitle || meta.summary || reference,
        detailsJson: meta.detailsJson,
        now: row.createdAt,
      });
    } else if ((row.state === "RESOLVED" || !row.summary) && meta.summary) {
      await client.operatorCaseEvent.updateMany({
        where: { caseId: row.id, eventType: "OPENED" },
        data: { summary: nextTitle || meta.summary, detailsJson: meta.detailsJson as never },
      });
    }
    if (row.links.length === 0 && meta.subjectType && meta.subjectId) {
      await client.operatorCaseLink.create({
        data: {
          caseId: row.id,
          linkType: meta.subjectType,
          targetId: meta.subjectId,
          labelKey: meta.titleKey,
          labelText: meta.subjectLabel,
        },
      }).catch(() => undefined);
    }
    updated += 1;
  }
  console.log(`Backfilled ${updated} operator case(s).`);
};

main()
  .catch((error) => {
    console.error(`backfillOperatorCases failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect().catch(() => undefined));
