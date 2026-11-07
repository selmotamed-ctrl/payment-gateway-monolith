import { SYSTEM_AUTOMATION_EMAIL } from "../governance/GovernanceExecution";
import { writeAudit } from "../../lib/audit/writeAudit";

type Any = Record<string, any>;

/** De-duplication keys of the automated ledger alerts (unique among unresolved operator cases of one kind). */
export const LEDGER_SUBJECT_KEYS = {
  invariant: "ledger.invariant",
  shard: (glAccountId: string, shardId: number): string => `ledger.shard:${glAccountId}:${shardId}`,
} as const;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && ((error as Any).code === "P2002" || (error as Any).code === "23505");

/**
 * Opens a P1 MISMATCH operator case for `subjectKey` unless an unresolved one exists. Returns true when a
 * case was created. Independent alerts (the global invariant, one shard's parity) never suppress each other.
 */
export const raiseLedgerCase = async (
  db: Any,
  input: { subjectKey: string; notes: string; slaHours?: number; now?: Date },
): Promise<boolean> => {
  const open = await db.operatorCase.findFirst({
    where: { kind: "MISMATCH", subjectKey: input.subjectKey, state: { not: "RESOLVED" } },
    select: { id: true },
  });
  if (open) return false;
  try {
    await db.operatorCase.create({
      data: {
        kind: "MISMATCH",
        priority: "P1",
        state: "OPEN",
        subjectKey: input.subjectKey,
        resolutionNotes: input.notes,
        slaDueAt: new Date((input.now ?? new Date()).getTime() + (input.slaHours ?? 4) * 60 * 60 * 1000),
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false; // another node raised it first
    throw error;
  }
};

/** Runs `fn` in a transaction when `db` is a client, or directly when it already is a transaction. */
export const inTransaction = async <T>(db: Any, fn: (tx: Any) => Promise<T>): Promise<T> =>
  typeof db.$transaction === "function" ? db.$transaction(fn) : fn(db);

/**
 * The id of the disabled system automation user that the automated ledger alerts and scaling act as.
 *
 * `ensureSystemAutomationUser` cannot be used against PostgreSQL: it stores the literal id "SYSTEM_AUTOMATION" in
 * `users.id`, which is a UUID column. The row is therefore located (and created) by its unique e-mail, and the
 * database assigns the UUID. The user is DISABLED, carries no authority and is never a maker or checker.
 */
export const ensureLedgerSystemActor = async (db: Any): Promise<string> => {
  const find = () => db.user.findFirst({ where: { email: SYSTEM_AUTOMATION_EMAIL }, select: { id: true } });
  const existing = await find();
  if (existing) return String(existing.id);
  try {
    const created = await db.user.create({
      data: {
        email: SYSTEM_AUTOMATION_EMAIL,
        role: "OPERATOR",
        authoritiesMap: {},
        appScopeIds: [],
        isMaker: false,
        isChecker: false,
        mfaRequired: false,
        status: "DISABLED",
      },
      select: { id: true },
    });
    return String(created.id);
  } catch (error) {
    const raced = await find();
    if (!raced) throw error;
    return String(raced.id);
  }
};

/** Writes one audit row as the system automation user (role SYSTEM). `db` may be a client or a transaction. */
export const writeSystemAudit = async (
  db: Any,
  input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown },
): Promise<void> => {
  await inTransaction(db, async (tx) => {
    const actorId = await ensureLedgerSystemActor(tx);
    await writeAudit(tx, {
      data: {
        actorId,
        role: "SYSTEM",
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeJson: input.before ?? {},
        afterJson: input.after ?? {},
      },
    });
  });
};
