import { toCamelRows } from "../../engine/db/rawRows";
import type { PrismaLike, Tx } from "../../engine/db/ports";

export type AttemptDeadlineKind = "EXPIRE" | "POLL" | "GRACE_END";

export const ATTEMPT_TERMINAL_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

const TERMINAL = new Set<string>(ATTEMPT_TERMINAL_STATUSES);

export interface AttemptDeadlineSource {
  id?: string;
  status?: string | null;
  expiresAt?: Date | string | null;
  graceExpiresAt?: Date | string | null;
  nextCheckAt?: Date | string | null;
}

export interface ClaimedAttemptDeadline {
  attemptId: string;
  kind: AttemptDeadlineKind;
  dueAt: Date;
}

export interface ClaimAttemptDeadlinesOptions {
  kinds: readonly AttemptDeadlineKind[];
  now: Date;
  limit: number;
  workerId: string;
  leaseMs?: number;
}

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const isTerminalAttemptStatus = (status: string | null | undefined): boolean =>
  status !== null && status !== undefined && TERMINAL.has(status);

export const deleteAttemptDeadlines = async (tx: PrismaLike, attemptId: string): Promise<void> => {
  if (typeof tx.$executeRawUnsafe !== "function") {
    return;
  }
  await tx.$executeRawUnsafe("DELETE FROM attempt_deadlines WHERE attempt_id = ?", attemptId);
};

export const syncAttemptDeadlinesFromAttempt = async (
  tx: PrismaLike,
  attempt: AttemptDeadlineSource,
): Promise<void> => {
  const attemptId = attempt.id;
  if (!attemptId || typeof tx.$executeRawUnsafe !== "function") {
    return;
  }
  if (isTerminalAttemptStatus(attempt.status)) {
    await deleteAttemptDeadlines(tx, attemptId);
    return;
  }
  const deadlines: Array<{ kind: AttemptDeadlineKind; dueAt: Date }> = [];
  const expiresAt = asDate(attempt.expiresAt);
  const graceExpiresAt = asDate(attempt.graceExpiresAt);
  const nextCheckAt = asDate(attempt.nextCheckAt);
  if (expiresAt) deadlines.push({ kind: "EXPIRE", dueAt: expiresAt });
  if (graceExpiresAt) deadlines.push({ kind: "GRACE_END", dueAt: graceExpiresAt });
  if (nextCheckAt) deadlines.push({ kind: "POLL", dueAt: nextCheckAt });

  const keep = new Set<AttemptDeadlineKind>(deadlines.map((entry) => entry.kind));
  for (const kind of ["EXPIRE", "POLL", "GRACE_END"] as const) {
    if (!keep.has(kind)) {
      await tx.$executeRawUnsafe(
        "DELETE FROM attempt_deadlines WHERE attempt_id = ? AND kind = ?",
        attemptId,
        kind,
      );
    }
  }
  for (const deadline of deadlines) {
    await tx.$executeRawUnsafe(
      `INSERT INTO attempt_deadlines (attempt_id, kind, due_at, claimed_until, claimed_by)
       VALUES (?, ?, ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE due_at = VALUES(due_at), claimed_until = NULL, claimed_by = NULL`,
      attemptId,
      deadline.kind,
      deadline.dueAt,
    );
  }
};

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

export const claimAttemptDeadlines = async (
  db: PrismaLike,
  options: ClaimAttemptDeadlinesOptions,
): Promise<ClaimedAttemptDeadline[]> => {
  const kinds = options.kinds.length > 0 ? [...options.kinds] : ["EXPIRE" as const];
  const limit = Math.max(1, Math.trunc(options.limit));
  const leaseUntil = new Date(options.now.getTime() + (options.leaseMs ?? 60_000));
  const result = await db.$transaction(async (tx: Tx) => {
    const claimed = (await tx.$queryRawUnsafe(
      `SELECT attempt_id, kind, due_at
         FROM attempt_deadlines
        WHERE kind IN (${placeholders(kinds.length)})
          AND due_at <= ?
          AND (claimed_until IS NULL OR claimed_until < ?)
        ORDER BY due_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      ...kinds,
      options.now,
      options.now,
      limit,
    )) as Array<Record<string, unknown>>;
    const rows = toCamelRows<ClaimedAttemptDeadline>(claimed);
    for (const row of rows) {
      await tx.$executeRawUnsafe(
        `UPDATE attempt_deadlines
            SET claimed_until = ?, claimed_by = ?
          WHERE attempt_id = ? AND kind = ?`,
        leaseUntil,
        options.workerId.slice(0, 64),
        row.attemptId,
        row.kind,
      );
    }
    return rows;
  });
  return Array.isArray(result) ? result : [];
};

export const ATTEMPT_WORKER_COLUMNS = [
  "id",
  "reference",
  "idempotency_key",
  "link_id",
  "attempt_group_id",
  "application_id",
  "merchant_id",
  "rail_id",
  "route_id",
  "credential_set_id",
  "gateway_version_id",
  "commission_profile_id",
  "env",
  "mode",
  "sub_mode",
  "status",
  "substatus",
  "gateway_reference",
  "provider_reference",
  "network_reference",
  "requested_amount",
  "surcharge_amount",
  "total_charged_amount",
  "gateway_amount_wire",
  "settled_amount",
  "gateway_fee_amount",
  "platform_commission_amount",
  "net_merchant_amount",
  "fee_bearer",
  "currency",
  "customer_fields_masked",
  "otp_attempts",
  "last_otp_sent_at",
  "client_ip",
  "expires_at",
  "grace_expires_at",
  "next_check_at",
  "ledger_entry_id",
  "terminal_at",
  "created_at",
  "updated_at",
].join(", ");
