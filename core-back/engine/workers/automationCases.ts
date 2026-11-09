import type { PrismaLike } from "../db/ports";

/**
 * Operator escalations raised by the background automations (AUTO-19, AUTO-20).
 *
 * The pattern is the one of `raiseLedgerCase`: an automation case carries a
 * `subject_key`, and `operator_cases_open_subject_key_uniq` (kind, subject_key
 * among unresolved cases) guarantees that a repeated tick, a retried job or a
 * second cluster node never opens a second case for the same subject.
 */
export interface KeyedOperatorCaseInput {
  kind: "UNKNOWN" | "MANUAL_REVIEW" | "MISMATCH" | "HELD" | "CONFLICT" | "LATE_SUCCESS" | "UNMATCHED_STATEMENT";
  priority: "P1" | "P2" | "P3";
  subjectKey: string;
  attemptId?: string | null;
  notes: string;
  slaHours: number;
  now?: Date;
  /** Links the case to a reconciliation item (`operator_cases.reconciliation_item_id` is unique). */
  reconciliationItemId?: string | null;
  /**
   * Also treat any unresolved case of the same kind on the same attempt as the
   * case of this subject (the engine's `PrismaOperatorCaseSink` dedupes on
   * kind + attempt, so an UNKNOWN case it opened is not duplicated).
   */
  dedupeOnAttempt?: boolean;
}

export interface KeyedOperatorCaseResult {
  id: string | null;
  created: boolean;
}

/** Opens and in-progress cases; the unique index excludes only RESOLVED rows. */
const UNRESOLVED = { not: "RESOLVED" } as const;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && ((error as { code?: unknown }).code === "P2002" || (error as { code?: unknown }).code === "23505");

export const openKeyedOperatorCase = async (
  db: PrismaLike,
  input: KeyedOperatorCaseInput,
): Promise<KeyedOperatorCaseResult> => {
  const bySubject = await db.operatorCase.findFirst({
    where: { kind: input.kind, subjectKey: input.subjectKey, state: UNRESOLVED },
    select: { id: true },
  });
  if (bySubject) {
    return { id: String(bySubject.id), created: false };
  }
  if (input.dedupeOnAttempt && input.attemptId) {
    const byAttempt = await db.operatorCase.findFirst({
      where: { kind: input.kind, attemptId: input.attemptId, state: UNRESOLVED },
      select: { id: true },
    });
    if (byAttempt) {
      return { id: String(byAttempt.id), created: false };
    }
  }
  const now = input.now ?? new Date();
  try {
    const created = await db.operatorCase.create({
      data: {
        kind: input.kind,
        priority: input.priority,
        state: "OPEN",
        subjectKey: input.subjectKey,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.reconciliationItemId ? { reconciliationItemId: input.reconciliationItemId } : {}),
        resolutionNotes: input.notes.slice(0, 1000),
        slaDueAt: new Date(now.getTime() + input.slaHours * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    return { id: String(created.id), created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another node raised it first.
      return { id: null, created: false };
    }
    throw error;
  }
};
