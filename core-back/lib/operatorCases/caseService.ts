import type { PrismaLike } from "../../engine/db/ports";
import { caseMetadata, type CaseMetadata } from "./caseCatalog";

export interface CaseEventInput {
  eventType: string;
  summary: string;
  actorType?: "SYSTEM" | "USER";
  actorUserId?: string | null;
  actorEmail?: string | null;
  detailsJson?: unknown;
  now?: Date;
}

/** Writes one append-only case timeline row. Kept on `any` only for the narrow worker ports. */
export const appendCaseEvent = async (db: PrismaLike, caseId: string, input: CaseEventInput): Promise<void> => {
  const model = (db as unknown as { operatorCaseEvent?: { create: (args: unknown) => Promise<unknown> } }).operatorCaseEvent;
  if (!model) return;
  await model.create({
    data: {
      caseId,
      eventType: input.eventType,
      actorType: input.actorType ?? "SYSTEM",
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      summary: input.summary.slice(0, 8000),
      detailsJson: input.detailsJson ?? undefined,
      ...(input.now ? { createdAt: input.now } : {}),
    },
  });
};

export const caseMetadataFields = (meta: CaseMetadata): Record<string, unknown> => ({
  caseType: meta.caseType.code,
  source: meta.source,
  domain: meta.domain,
  confidentiality: meta.confidentiality,
  titleKey: meta.titleKey,
  titleText: meta.titleText,
  summary: meta.summary,
  detailsJson: meta.detailsJson,
  subjectType: meta.subjectType,
  subjectId: meta.subjectId,
  subjectLabel: meta.subjectLabel,
});

/** Metadata for a newly created case, accepting the same title/detail a monitor already has. */
export const metaForNewCase = (input: {
  subjectKey?: string | null;
  kind?: string | null;
  attemptId?: string | null;
  reconciliationItemId?: string | null;
  title?: string | null;
  detail?: string | null;
  notes?: string | null;
}): CaseMetadata => caseMetadata(input);

/**
 * Resolve a keyed automation case when its source condition clears.
 *
 * This replaces the historical `[CLEARED]` marker that left the case OPEN (and
 * therefore in the operator queue forever). A re-trip creates a new case, which
 * preserves both the resolved history and the new incident.
 */
export const clearKeyedCase = async (
  db: PrismaLike,
  input: {
    kind: string;
    subjectKey: string;
    detail: string;
    now?: Date;
    actorUserId?: string | null;
    actorEmail?: string | null;
  },
): Promise<boolean> => {
  const open = await db.operatorCase.findFirst({
    where: { kind: input.kind as never, subjectKey: input.subjectKey, state: { not: "RESOLVED" } },
    select: { id: true },
  });
  if (!open) return false;
  const now = input.now ?? new Date();
  await db.operatorCase.update({
    where: { id: open.id },
    data: {
      state: "RESOLVED",
      resolvedAt: now,
      resolvedByUserId: input.actorUserId ?? null,
      resolutionCode: "SOURCE_CLEARED",
      resolutionSummary: input.detail.slice(0, 2000),
    },
  });
  await appendCaseEvent(db, String(open.id), {
    eventType: "SOURCE_CLEARED",
    summary: input.detail,
    actorType: input.actorUserId ? "USER" : "SYSTEM",
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    now,
  });
  return true;
};
