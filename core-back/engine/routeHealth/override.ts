import type { PrismaLike } from "../db/ports";
import { writeAudit } from "../../lib/audit/writeAudit";
import { ApiError } from "../../lib/error";
import { openKeyedOperatorCase } from "../workers/automationCases";
import type { RouteHealthState } from "./types";

export const ROUTE_HEALTH_OVERRIDE_SUBJECT = "ROUTE_HEALTH_OVERRIDE";
export const ROUTE_HEALTH_OVERRIDE_DEFAULT_DAYS = 7;
export const ROUTE_HEALTH_OVERRIDE_MAX_DAYS = 30;

export const routeHealthRank: Record<RouteHealthState, number> = {
  HEALTHY: 2,
  DEGRADED: 1,
  OPEN_BREAKER: 0,
};

export interface RouteHealthOverrideInput {
  routeId: string;
  state: RouteHealthState;
  reason: string;
  actorUserId: string;
  actorRole: string;
  approvalRequestId?: string | null;
  expiresAt?: Date | string | null;
  evidence?: unknown;
  now?: Date;
  /** The caller already holds a transaction (the approval executor). */
  inTransaction?: boolean;
  /** Default/maximum override lifetime from the route_health.policy setting. */
  defaultExpiryDays?: number;
  maxExpiryDays?: number;
  /** Approval snapshot: reject if another override was applied meanwhile. */
  expectedOverrideState?: RouteHealthState | null;
}

export interface RouteHealthOverrideResult {
  routeId: string;
  effectiveState: RouteHealthState;
  computedState: RouteHealthState;
  expiresAt: Date;
}

const parseExpiry = (
  value: Date | string | null | undefined,
  now: Date,
  defaultDays = ROUTE_HEALTH_OVERRIDE_DEFAULT_DAYS,
  maxDays = ROUTE_HEALTH_OVERRIDE_MAX_DAYS,
): Date => {
  const date = value ? new Date(value) : new Date(now.getTime() + defaultDays * 86_400_000);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new ApiError(400, "OVERRIDE_EXPIRY_INVALID", "The override expiry must be in the future");
  }
  if (date.getTime() > now.getTime() + maxDays * 86_400_000) {
    throw new ApiError(400, "OVERRIDE_EXPIRY_TOO_LONG", `An override may last at most ${maxDays} days`);
  }
  return date;
};

const assertState = (value: unknown): RouteHealthState => {
  const state = String(value ?? "").toUpperCase();
  if (state !== "HEALTHY" && state !== "DEGRADED" && state !== "OPEN_BREAKER") {
    throw new ApiError(400, "OVERRIDE_STATE_INVALID", "The override state must be HEALTHY, DEGRADED or OPEN_BREAKER");
  }
  return state;
};

const assertReason = (value: unknown): string => {
  const reason = String(value ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new ApiError(400, "OVERRIDE_REASON_INVALID", "The override reason must be between 10 and 500 characters");
  }
  return reason;
};

const asDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Applies an admin override as the effective health state. The automation keeps
 * writing health_computed_state, but it cannot change health_state while the
 * override is active.
 */
export async function applyRouteHealthOverride(
  db: PrismaLike,
  input: RouteHealthOverrideInput,
): Promise<RouteHealthOverrideResult> {
  const now = input.now ?? new Date();
  const state = assertState(input.state);
  const reason = assertReason(input.reason);
  const expiresAt = parseExpiry(input.expiresAt, now, input.defaultExpiryDays, input.maxExpiryDays);
  let result: RouteHealthOverrideResult | null = null;
  const apply = async (tx: PrismaLike) => {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT health_state::text AS "healthState", health_computed_state::text AS "computedState",
              health_override_state::text AS "overrideState"
       FROM rail_routes WHERE id = $1::uuid FOR UPDATE`,
      input.routeId,
    )) as Array<{ healthState: RouteHealthState; computedState: RouteHealthState; overrideState: RouteHealthState | null }>;
    const row = rows[0];
    if (!row) throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
    if (input.expectedOverrideState !== undefined && input.expectedOverrideState !== row.overrideState) {
      throw new ApiError(409, "OVERRIDE_CHANGED", "The route override changed after the approval request was created");
    }
    await tx.$executeRawUnsafe(
      `UPDATE rail_routes SET
         health_override_state = $2::"HealthState",
         health_override_reason = $3,
         health_override_set_at = $4,
         health_override_set_by = $5::uuid,
         health_override_expires_at = $6,
         health_override_approval_id = $7::uuid,
         health_state = $2::"HealthState",
         health_reason = $8,
         health_changed_at = CASE WHEN health_state <> $2::"HealthState" THEN $4 ELSE health_changed_at END,
         health_next_probe_at = CASE WHEN $2::text = 'HEALTHY' AND $9::text = 'HEALTHY' THEN NULL ELSE $4 END,
         updated_at = now()
       WHERE id = $1::uuid`,
      input.routeId,
      state,
      reason,
      now,
      input.actorUserId,
      expiresAt,
      input.approvalRequestId ?? null,
      `ADMIN_OVERRIDE_${state}`,
      row.computedState,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO route_health_events
         (id, route_id, from_state, to_state, source, reason, evidence_json, actor_user_id, approval_request_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::"HealthState", $3::"HealthState", 'OVERRIDE', $4, $5::jsonb, $6::uuid, $7::uuid)`,
      input.routeId,
      row.healthState,
      state,
      reason,
      JSON.stringify({ reason, expiresAt: expiresAt.toISOString(), evidence: input.evidence ?? null }),
      input.actorUserId,
      input.approvalRequestId ?? null,
    );
    await writeAudit(tx, {
      data: {
        actorId: input.actorUserId,
        role: input.actorRole,
        action: "ROUTE_HEALTH_OVERRIDDEN",
        entityType: "RAIL_ROUTE",
        entityId: input.routeId,
        approvalRequestId: input.approvalRequestId ?? null,
        beforeJson: { state: row.healthState, computed: row.computedState },
        afterJson: { state, reason, expiresAt: expiresAt.toISOString() },
      },
    });
    result = { routeId: input.routeId, effectiveState: state, computedState: row.computedState, expiresAt };
  };
  if (!input.inTransaction && typeof db.$transaction === "function") await db.$transaction(apply);
  else await apply(db);
  if (!result) throw new ApiError(500, "OVERRIDE_APPLY_FAILED", "The override could not be applied");
  const applied = result as RouteHealthOverrideResult;
  await openKeyedOperatorCase(db, {
    kind: "MANUAL_REVIEW",
    priority: applied.effectiveState === "HEALTHY" ? "P2" : "P1",
    subjectKey: `route.health.override:${input.routeId}`,
    slaHours: 24,
    now,
    notes: `Route ${input.routeId} was forced to ${applied.effectiveState}. Reason: ${reason}. Expires: ${expiresAt.toISOString()}.`,
  });
  const oldReview = await db.operatorCase.findFirst({
    where: { kind: "MANUAL_REVIEW", subjectKey: `route.health.override_review:${input.routeId}`, state: { not: "RESOLVED" } },
    select: { id: true, resolutionNotes: true },
  });
  if (oldReview) {
    await db.operatorCase.update({
      where: { id: oldReview.id },
      data: {
        state: "RESOLVED",
        resolutionNotes: `${oldReview.resolutionNotes ?? ""}\n[REPLACED ${now.toISOString()}] A new override was applied.`.trim().slice(0, 8000),
      },
    });
  }
  if (applied.computedState !== applied.effectiveState) {
    await openKeyedOperatorCase(db, {
      kind: "MANUAL_REVIEW",
      priority: "P2",
      subjectKey: `route.health.override_conflict:${input.routeId}`,
      slaHours: 24,
      now,
      notes: `Route ${input.routeId} is forced to ${applied.effectiveState}, but automation computes ${applied.computedState}.`,
    });
  }
  return applied;
}

export async function clearRouteHealthOverride(
  db: PrismaLike,
  input: {
    routeId: string;
    reason: string;
    actorUserId: string;
    actorRole: string;
    approvalRequestId?: string | null;
    now?: Date;
    /** The caller already holds a transaction (the approval executor). */
    inTransaction?: boolean;
    /** The approval executor passes its request id; an immediate clear has none. */
    requireApprovalIfHealthier?: boolean;
    expectedOverrideState?: RouteHealthState | null;
  },
): Promise<RouteHealthOverrideResult> {
  const now = input.now ?? new Date();
  const reason = assertReason(input.reason);
  let result: RouteHealthOverrideResult | null = null;
  const clear = async (tx: PrismaLike) => {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT health_state::text AS "healthState", health_computed_state::text AS "computedState",
              health_override_state::text AS "overrideState", health_override_expires_at AS "overrideExpiresAt"
       FROM rail_routes WHERE id = $1::uuid FOR UPDATE`,
      input.routeId,
    )) as Array<{ healthState: RouteHealthState; computedState: RouteHealthState; overrideState: RouteHealthState | null; overrideExpiresAt: Date | null }>;
    const row = rows[0];
    if (!row) throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
    if (!row.overrideState) throw new ApiError(409, "OVERRIDE_NOT_ACTIVE", "The route has no active override");
    if (input.expectedOverrideState !== undefined && input.expectedOverrideState !== row.overrideState) {
      throw new ApiError(409, "OVERRIDE_CHANGED", "The route override changed after the approval request was created");
    }
    const effective = row.computedState;
    const overrideExpired = row.overrideExpiresAt !== null && new Date(row.overrideExpiresAt).getTime() <= now.getTime();
    const currentEffective = overrideExpired ? row.computedState : row.healthState;
    if (input.requireApprovalIfHealthier !== false
        && !input.approvalRequestId
        && !overrideExpired
        && routeHealthRank[effective] > routeHealthRank[currentEffective]) {
      throw new ApiError(409, "APPROVAL_REQUIRED", "Clearing this override needs a second approval");
    }
    await tx.$executeRawUnsafe(
      `UPDATE rail_routes SET
         health_override_state = NULL, health_override_reason = NULL, health_override_set_at = NULL,
         health_override_set_by = NULL, health_override_expires_at = NULL, health_override_approval_id = NULL,
         health_state = $2::"HealthState", health_reason = $3,
         health_changed_at = CASE WHEN health_state <> $2::"HealthState" THEN $4 ELSE health_changed_at END,
         health_probe_successes = 0, health_probe_failures = 0,
         health_next_probe_at = CASE WHEN $2::text = 'HEALTHY' THEN NULL ELSE $4 END,
         updated_at = now()
       WHERE id = $1::uuid`,
      input.routeId,
      effective,
      `OVERRIDE_CLEARED:${row.computedState}`,
      now,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO route_health_events
         (id, route_id, from_state, to_state, source, reason, evidence_json, actor_user_id, approval_request_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::"HealthState", $3::"HealthState", 'OVERRIDE', $4, $5::jsonb, $6::uuid, $7::uuid)`,
      input.routeId,
      row.healthState,
      effective,
      reason,
      JSON.stringify({ reason, clearedOverride: row.overrideState }),
      input.actorUserId,
      input.approvalRequestId ?? null,
    );
    await writeAudit(tx, {
      data: {
        actorId: input.actorUserId,
        role: input.actorRole,
        action: "ROUTE_HEALTH_OVERRIDE_CLEARED",
        entityType: "RAIL_ROUTE",
        entityId: input.routeId,
        approvalRequestId: input.approvalRequestId ?? null,
        beforeJson: { override: row.overrideState, state: row.healthState },
        afterJson: { state: effective, reason },
      },
    });
    result = { routeId: input.routeId, effectiveState: effective, computedState: row.computedState, expiresAt: now };
  };
  if (!input.inTransaction && typeof db.$transaction === "function") await db.$transaction(clear);
  else await clear(db);
  if (!result) throw new ApiError(500, "OVERRIDE_CLEAR_FAILED", "The override could not be cleared");
  const cleared = result as RouteHealthOverrideResult;
  await clearOverrideCases(db, input.routeId, now, reason);
  return cleared;
}

async function clearOverrideCases(db: PrismaLike, routeId: string, now: Date, reason: string): Promise<void> {
  for (const subjectKey of [
    `route.health.override:${routeId}`,
    `route.health.override_conflict:${routeId}`,
    `route.health.override_review:${routeId}`,
  ]) {
    const open = (await db.operatorCase.findFirst({
      where: { kind: "MANUAL_REVIEW", subjectKey, state: { not: "RESOLVED" } },
      select: { id: true, resolutionNotes: true },
    })) as { id: string; resolutionNotes: string | null } | null;
    if (!open) continue;
    await db.operatorCase.update({
      where: { id: open.id },
      data: {
        state: "RESOLVED",
        resolutionNotes: `${open.resolutionNotes ?? ""}\n[CLEARED ${now.toISOString()}] ${reason}`.trim().slice(0, 8000),
      },
    });
  }
}

export const overrideExpiryDate = (
  expiresAt: Date | string | null | undefined,
  now = new Date(),
  options?: { defaultDays?: number; maxDays?: number },
): Date => parseExpiry(expiresAt, now, options?.defaultDays, options?.maxDays);
export const overrideComputedAt = asDate;
