import type { PrismaLike, Tx } from "../db/ports";

export const ACTIVE_GATEWAY_INQUIRY_STATUSES = ["SCHEDULED", "RUNNING", "RETRYING"] as const;
export type GatewayInquiryStatus =
  | "SCHEDULED"
  | "RUNNING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export interface GatewayInquiryScheduleRow {
  id: string;
  createdAt: Date;
  attemptId: string;
  operatorCaseId: string | null;
  status: GatewayInquiryStatus;
  windowStartedAt: Date | null;
  nextRunAt: Date;
  lastRunAt: Date | null;
  attempts: number;
  lastResult: string | null;
  lastError: string | null;
}

const delegate = (db: PrismaLike | Tx): Record<string, any> | undefined => {
  const candidate = (db as Record<string, any>).gatewayInquirySchedule;
  return candidate && typeof candidate === "object" ? candidate : undefined;
};

export const findActiveGatewayInquiry = async (
  db: PrismaLike | Tx,
  attemptId: string,
): Promise<GatewayInquiryScheduleRow | null> => {
  const model = delegate(db);
  if (!model?.findFirst) {
    return null;
  }
  return (await model.findFirst({
    where: { attemptId, status: { in: [...ACTIVE_GATEWAY_INQUIRY_STATUSES] } },
    orderBy: { createdAt: "desc" },
  })) as GatewayInquiryScheduleRow | null;
};

export const markGatewayInquiryRunning = async (
  db: PrismaLike | Tx,
  scheduleId: string,
  now: Date,
): Promise<boolean> => {
  const model = delegate(db);
  if (!model?.updateMany) {
    return false;
  }
  const result = await model.updateMany({
    where: { id: scheduleId, status: { in: [...ACTIVE_GATEWAY_INQUIRY_STATUSES] } },
    data: {
      status: "RUNNING",
      lastRunAt: now,
      attempts: { increment: 1 },
      lastError: null,
    },
  });
  return Number(result?.count ?? 0) > 0;
};

export const updateGatewayInquiry = async (
  db: PrismaLike | Tx,
  scheduleId: string,
  data: Record<string, unknown>,
): Promise<void> => {
  const model = delegate(db);
  if (!model?.updateMany) {
    return;
  }
  await model.updateMany({ where: { id: scheduleId }, data });
};

/**
 * Marks schedules whose attempt has already reached a terminal state, or
 * whose route polling window has elapsed, as finished. It keeps the schedule
 * table from showing a stale "scheduled" row after a webhook resolves the
 * attempt before the poll worker runs.
 */
export const reconcileGatewayInquiries = async (db: PrismaLike | Tx, now: Date): Promise<void> => {
  const model = delegate(db);
  if (!model?.findMany) {
    return;
  }
  const open = (await model.findMany({
    where: { status: { in: [...ACTIVE_GATEWAY_INQUIRY_STATUSES] } },
    select: {
      id: true,
      status: true,
      attempt: { select: { status: true, terminalAt: true, nextCheckAt: true } },
    },
    take: 500,
  })) as Array<{
    id: string;
    status: GatewayInquiryStatus;
    attempt?: { status?: string | null; terminalAt?: Date | null; nextCheckAt?: Date | null } | null;
  }>;

  for (const row of open) {
    const attempt = row.attempt;
    if (!attempt) {
      await model.updateMany({
        where: { id: row.id },
        data: { status: "COMPLETED", completedAt: now, lastError: "The payment attempt no longer exists" },
      });
      continue;
    }
    const terminal = Boolean(attempt.terminalAt) || ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"].includes(String(attempt.status ?? ""));
    if (terminal) {
      await model.updateMany({
        where: { id: row.id },
        data: {
          status: "COMPLETED",
          completedAt: now,
          lastResult: attempt.status ?? null,
        },
      });
      continue;
    }
    if (row.status !== "RUNNING" && !attempt.nextCheckAt) {
      await model.updateMany({
        where: { id: row.id },
        data: {
          status: "EXPIRED",
          completedAt: now,
          lastResult: attempt.status ?? null,
          lastError: "The polling window elapsed before a definitive result",
        },
      });
    }
  }
};
