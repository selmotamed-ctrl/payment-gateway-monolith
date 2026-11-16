import type { PrismaLike } from "../db/ports";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { clearKeyedCase } from "../../lib/operatorCases/caseService";
import { openKeyedOperatorCase } from "../workers/automationCases";
import { BaseWorker, type WorkerOptions, type WorkerTickResult } from "../workers/workerRuntime";
import {
  addOutcome,
  classifyAttemptOutcome,
  decideRouteHealth,
  emptyRouteHealthCounts,
} from "./decision";
import { DEFAULT_ROUTE_HEALTH_POLICY, readRouteHealthPolicy } from "./policy";
import type { RouteHealthProbeService, RouteHealthProbeResult } from "./RouteHealthProbeService";
import type {
  AttemptOutcomeClass,
  RouteHealthCounts,
  RouteHealthPolicy,
  RouteHealthState,
} from "./types";

type Any = Record<string, any>;

interface HealthRow {
  route_id: string;
  status: string;
  canonical_error: string | null;
  substatus: string | null;
  first_terminal_at: Date | string | null;
  first_unknown_at: Date | string | null;
  duration_ms: number | string | null;
  classification: string | null;
  counts_toward_breaker: boolean | null;
}

interface RouteRow {
  id: string;
  status: string;
  healthState: RouteHealthState;
  healthComputedState: RouteHealthState;
  healthComputedReason: string | null;
  healthComputedAt: Date | null;
  healthOverrideState: RouteHealthState | null;
  healthOverrideReason: string | null;
  healthOverrideExpiresAt: Date | null;
  healthConsecutiveFailures: number;
  healthProbeSuccesses: number;
  healthProbeFailures: number;
  healthLastProbeAt: Date | null;
  healthNextProbeAt: Date | null;
}

interface ClassifiedOutcome {
  at: Date;
  class: AttemptOutcomeClass;
  durationMs: number | null;
}

export interface GatewayHealthWorkerDeps extends WorkerOptions {
  /** TEST override; production reads the Platform Setting. */
  policy?: RouteHealthPolicy;
  probeService?: RouteHealthProbeService | null;
  env?: "LIVE" | "SANDBOX";
}

const asDate = (value: Date | string | null): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const successStatuses = new Set(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"]);
const ignoredStatuses = new Set(["EXPIRED", "CANCELLED", "BLOCKED"]);

const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? null;
};

const bucketStart = (at: Date, bucketSeconds: number): Date => {
  const size = bucketSeconds * 1000;
  return new Date(Math.floor(at.getTime() / size) * size);
};

const asBool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : null;

/**
 * Measures route health from real payment outcomes and drives the breaker.
 *
 * The worker recomputes the last hour of five-minute buckets every tick, so
 * late terminal transitions are reflected without a second event source.
 * It writes `health_computed_state`; `health_state` is only changed when no
 * admin override is active. Probes provide half-open evidence and are run by
 * the same leader.
 */
export class GatewayHealthWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly policyOverride?: RouteHealthPolicy;
  private readonly probeService: RouteHealthProbeService | null;
  private readonly env: "LIVE" | "SANDBOX";

  constructor(deps: GatewayHealthWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60_000 });
    this.policyOverride = deps.policy;
    this.probeService = deps.probeService ?? null;
    this.env = deps.env ?? "LIVE";
  }

  private async policy(): Promise<RouteHealthPolicy> {
    return this.policyOverride ?? readRouteHealthPolicy(this.db);
  }

  protected async tick(): Promise<WorkerTickResult> {
    const policy = await this.policy();
    const now = this.clock();
    const expired = await this.clearExpiredOverrides(now);
    const reviewed = await this.remindDueOverrides(now, policy);
    if (!policy.enabled || policy.mode === "OFF") return { processed: expired + reviewed };

    const bucketSeconds = policy.sampleBucketSeconds;
    const lookbackSeconds = Math.max(3600, policy.windowSeconds + bucketSeconds);
    const since = new Date(now.getTime() - lookbackSeconds * 1000);
    const rows = (await this.db.$queryRawUnsafe(
      `SELECT a.route_id::text AS route_id,
              CASE WHEN a.first_terminal_at IS NULL AND a.first_unknown_at IS NOT NULL
                   THEN 'UNKNOWN' ELSE a.status::text END AS status,
              COALESCE(a.canonical_error, a.substatus) AS canonical_error,
              a.substatus,
              a.first_terminal_at,
              a.first_unknown_at,
              EXTRACT(EPOCH FROM (COALESCE(a.first_terminal_at, a.first_unknown_at) - a.created_at)) * 1000 AS duration_ms,
              em.classification::text AS classification,
              em.counts_toward_breaker
       FROM payment_attempts a
       LEFT JOIN LATERAL (
         SELECT em.classification::text AS classification, em.counts_toward_breaker
         FROM error_maps em
         WHERE em.gateway_version_id = a.gateway_version_id
           AND em.canonical_error = COALESCE(a.canonical_error, a.substatus)
         ORDER BY em.gateway_code ASC
         LIMIT 1
       ) em ON true
       WHERE a.env::text = $1
         AND ((a.first_terminal_at IS NOT NULL AND a.first_terminal_at >= $2)
           OR (a.first_terminal_at IS NULL AND a.first_unknown_at IS NOT NULL AND a.first_unknown_at >= $2))
       ORDER BY COALESCE(a.first_terminal_at, a.first_unknown_at) ASC`,
      this.env,
      since,
    )) as HealthRow[];

    const byRoute = new Map<string, ClassifiedOutcome[]>();
    const byRouteBucket = new Map<string, Map<string, { counts: RouteHealthCounts; durations: number[] }>>();
    for (const row of rows) {
      const at = asDate(row.first_terminal_at) ?? asDate(row.first_unknown_at);
      if (!at) continue;
      const outcome = classifyAttemptOutcome({
        status: row.status,
        canonicalError: row.canonical_error,
        substatus: row.substatus,
        errorMap: row.classification
          ? { classification: row.classification, countsTowardBreaker: asBool(row.counts_toward_breaker) }
          : null,
      });
      const duration = row.duration_ms === null || row.duration_ms === undefined ? null : Math.max(0, Math.round(Number(row.duration_ms)));
      const routeOutcomes = byRoute.get(row.route_id) ?? [];
      routeOutcomes.push({ at, class: outcome, durationMs: duration });
      byRoute.set(row.route_id, routeOutcomes);

      const bucket = bucketStart(at, bucketSeconds).toISOString();
      let buckets = byRouteBucket.get(row.route_id);
      if (!buckets) {
        buckets = new Map();
        byRouteBucket.set(row.route_id, buckets);
      }
      const current = buckets.get(bucket) ?? { counts: emptyRouteHealthCounts(), durations: [] };
      current.counts = addOutcome(current.counts, outcome);
      if (duration !== null && outcome !== "IGNORED" && outcome !== "RATE_LIMITED") current.durations.push(duration);
      buckets.set(bucket, current);
    }

    // Rebuild the sample window from the attempts. An UNKNOWN that later becomes a
    // terminal attempt moves buckets; without removing the old rows it would be counted twice
    // and the health history would never converge.
    await this.db.$transaction(async (tx: PrismaLike) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM gateway_health_samples WHERE window_start >= $1 AND window_start < $2`,
        since,
        now,
      );
      for (const [routeId, buckets] of byRouteBucket) {
        for (const [windowStart, bucket] of buckets) {
          await tx.$executeRawUnsafe(
            `INSERT INTO gateway_health_samples
               (id, created_at, updated_at, route_id, window_start, successes, definitive_failures,
                ambiguous_unknowns, rate_limits_429, ignored_outcomes, p50_ms, p95_ms, p99_ms)
             VALUES (gen_random_uuid(), now(), now(), $1::uuid, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10)`,
            routeId,
            windowStart,
            bucket.counts.successes,
            bucket.counts.definitiveFailures,
            bucket.counts.ambiguousUnknowns,
            bucket.counts.rateLimits429,
            bucket.counts.ignoredOutcomes,
            percentile(bucket.durations, 0.5),
            percentile(bucket.durations, 0.95),
            percentile(bucket.durations, 0.99),
          );
        }
      }
    });

    const routes = (await this.db.railRoute.findMany({
      select: {
        id: true,
        status: true,
        healthState: true,
        healthComputedState: true,
        healthComputedReason: true,
        healthComputedAt: true,
        healthOverrideState: true,
        healthOverrideReason: true,
        healthOverrideExpiresAt: true,
        healthConsecutiveFailures: true,
        healthProbeSuccesses: true,
        healthProbeFailures: true,
        healthLastProbeAt: true,
        healthNextProbeAt: true,
      },
    })) as RouteRow[];

    const countsByRoute = new Map<string, { counts: RouteHealthCounts; streak: number; durations: number[] }>();
    const windowStart = now.getTime() - policy.windowSeconds * 1000;
    for (const route of routes) {
      const outcomes = byRoute.get(route.id) ?? [];
      const stateStart = Math.max(windowStart, asDate(route.healthComputedAt)?.getTime() ?? 0);
      const current = outcomes.filter((entry) => entry.at.getTime() >= stateStart);
      let counts = emptyRouteHealthCounts();
      const durations: number[] = [];
      let streak = 0;
      for (const entry of current) {
        counts = addOutcome(counts, entry.class);
        if (entry.durationMs !== null && entry.class !== "IGNORED" && entry.class !== "RATE_LIMITED") durations.push(entry.durationMs);
        if (entry.class === "SUCCESS") streak = 0;
        else if (entry.class === "DEFINITIVE_FAILURE" || entry.class === "AMBIGUOUS") streak += 1;
      }
      countsByRoute.set(route.id, { counts, streak, durations });
    }

    let processed = expired;
    for (const route of routes) {
      const input = countsByRoute.get(route.id) ?? { counts: emptyRouteHealthCounts(), streak: 0, durations: [] };
      const decision = decideRouteHealth({
        current: route.healthComputedState,
        counts: input.counts,
        consecutiveFailures: input.streak,
        probeSuccesses: route.healthProbeSuccesses,
        probeFailures: route.healthProbeFailures,
        policy,
      });
      const overrideActive = route.healthOverrideState !== null
        && (!route.healthOverrideExpiresAt || route.healthOverrideExpiresAt.getTime() > now.getTime());
      const expectedEffective = overrideActive ? route.healthOverrideState : decision.state;
      const changed = decision.changed || route.healthConsecutiveFailures !== input.streak;
      if (!changed && expectedEffective === route.healthState) continue;
      await this.applyDecision(route.id, route, decision.state, decision.reason, input.counts, input.streak, now, policy, "TRAFFIC");
      processed += 1;
    }

    // Half-open probes: due routes only, after the traffic decision.
    if (this.probeService) {
      const due = (await this.db.railRoute.findMany({
        where: {
          status: "ACTIVE",
          OR: [
            { healthNextProbeAt: { lte: now } },
            { healthNextProbeAt: null, healthComputedState: { not: "HEALTHY" } },
          ],
        },
        select: {
          id: true,
          status: true,
          healthState: true,
          healthComputedState: true,
          healthComputedReason: true,
          healthComputedAt: true,
          healthOverrideState: true,
          healthOverrideReason: true,
          healthOverrideExpiresAt: true,
          healthConsecutiveFailures: true,
          healthProbeSuccesses: true,
          healthProbeFailures: true,
          healthLastProbeAt: true,
          healthNextProbeAt: true,
        },
      })) as RouteRow[];
      for (const route of due) {
        if (route.healthComputedState === "HEALTHY" && route.healthOverrideState === null) continue;
        const result = await this.probeService.probe(route.id, now);
        await this.recordProbe(route, result, now, policy);
        processed += 1;
      }
    }

    return { processed };
  }

  private async remindDueOverrides(now: Date, policy: RouteHealthPolicy): Promise<number> {
    const cutoff = now.getTime() - policy.overrideReviewHours * 3_600_000;
    const due = (await this.db.railRoute.findMany({
      where: {
        healthOverrideState: { not: null },
        healthOverrideSetAt: { lte: new Date(cutoff) },
        OR: [{ healthOverrideExpiresAt: null }, { healthOverrideExpiresAt: { gt: now } }],
      },
      select: { id: true, healthState: true, healthOverrideReason: true, healthOverrideExpiresAt: true },
    })) as Array<{ id: string; healthState: RouteHealthState; healthOverrideReason: string | null; healthOverrideExpiresAt: Date | null }>;
    for (const route of due) {
      await openKeyedOperatorCase(this.db, {
        kind: "MANUAL_REVIEW",
        priority: "P2",
        subjectKey: `route.health.override_review:${route.id}`,
        slaHours: 24,
        now,
        notes: `Route ${route.id} has been forced to ${route.healthState} for at least ${policy.overrideReviewHours}h. Reason: ${route.healthOverrideReason ?? "—"}. Expires: ${route.healthOverrideExpiresAt?.toISOString() ?? "—"}.`,
      });
    }
    return due.length;
  }

  private async clearExpiredOverrides(now: Date): Promise<number> {
    const expired = (await this.db.railRoute.findMany({
      where: { healthOverrideState: { not: null }, healthOverrideExpiresAt: { lte: now } },
      select: { id: true, healthState: true, healthComputedState: true, healthComputedReason: true },
    })) as Array<{ id: string; healthState: RouteHealthState; healthComputedState: RouteHealthState; healthComputedReason: string | null }>;
    let count = 0;
    for (const route of expired) {
      await this.db.$transaction(async (tx: PrismaLike) => {
        const current = (await tx.$queryRawUnsafe(
          `SELECT health_state::text AS "healthState", health_computed_state::text AS "healthComputedState",
                  health_computed_reason AS "healthComputedReason", health_override_state::text AS "healthOverrideState",
                  health_override_expires_at AS "healthOverrideExpiresAt"
           FROM rail_routes WHERE id = $1::uuid FOR UPDATE`,
          route.id,
        )) as Any[];
        const row = current[0];
        if (!row || !row.healthOverrideState || !row.healthOverrideExpiresAt || new Date(row.healthOverrideExpiresAt) > now) return;
        const effective = String(row.healthComputedState) as RouteHealthState;
        await tx.$executeRawUnsafe(
          `UPDATE rail_routes SET health_override_state = NULL, health_override_reason = NULL,
             health_override_set_at = NULL, health_override_set_by = NULL, health_override_expires_at = NULL,
             health_override_approval_id = NULL, health_state = $2::"HealthState", health_reason = $3,
             health_changed_at = $4, health_probe_successes = 0, health_probe_failures = 0,
             health_next_probe_at = CASE WHEN $2::text = 'HEALTHY' THEN NULL ELSE $4 END,
             updated_at = now()
           WHERE id = $1::uuid`,
          route.id,
          effective,
          String(row.healthComputedReason ?? "OVERRIDE_EXPIRED"),
          now,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO route_health_events (id, route_id, from_state, to_state, source, reason, evidence_json)
           VALUES (gen_random_uuid(), $1::uuid, $2::"HealthState", $3::"HealthState", 'EXPIRY', 'OVERRIDE_EXPIRED', $4::jsonb)`,
          route.id,
          row.healthState,
          effective,
          JSON.stringify({ expiredAt: now.toISOString(), computedReason: row.healthComputedReason ?? null }),
        );
        await writeSystemAudit(tx, {
          action: "ROUTE_HEALTH_OVERRIDE_EXPIRED",
          entityType: "RAIL_ROUTE",
          entityId: route.id,
          before: { effective: row.healthState, override: row.healthOverrideState },
          after: { effective, reason: "OVERRIDE_EXPIRED" },
        });
      });
      await this.clearCase(`route.health.override:${route.id}`, now, "Override expired");
      await this.clearCase(`route.health.override_conflict:${route.id}`, now, "Override expired");
      await this.clearCase(`route.health.override_review:${route.id}`, now, "Override expired");
      count += 1;
    }
    return count;
  }

  private async applyDecision(
    routeId: string,
    route: RouteRow,
    computed: RouteHealthState,
    reason: string,
    counts: RouteHealthCounts,
    streak: number,
    now: Date,
    policy: RouteHealthPolicy,
    source: "TRAFFIC" | "PROBE" | "SHADOW",
    probeSuccesses = route.healthProbeSuccesses,
    probeFailures = route.healthProbeFailures,
  ): Promise<void> {
    const shadow = policy.mode === "SHADOW";
    const computedChanged = computed !== route.healthComputedState;
    const nextProbeSuccesses = computedChanged ? 0 : probeSuccesses;
    const nextProbeFailures = computedChanged ? 0 : probeFailures;
    let effective: RouteHealthState = computed;
    let conflict = false;
    await this.db.$transaction(async (tx: PrismaLike) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT health_state::text AS "healthState", health_computed_state::text AS "healthComputedState",
                health_override_state::text AS "healthOverrideState", health_override_expires_at AS "healthOverrideExpiresAt",
                health_computed_at AS "healthComputedAt"
         FROM rail_routes WHERE id = $1::uuid FOR UPDATE`,
        routeId,
      )) as Any[];
      const current = rows[0];
      if (!current) return;
      const overrideState = current.healthOverrideState as RouteHealthState | null;
      const overrideActive =
        overrideState !== null &&
        (!current.healthOverrideExpiresAt || new Date(current.healthOverrideExpiresAt) > now);
      effective = overrideActive ? overrideState : computed;
      conflict = overrideActive && overrideState !== computed;
      const effectiveChanged = effective !== current.healthState;
      const probeTarget: RouteHealthState = overrideActive && overrideState !== "HEALTHY"
        ? overrideState
        : computed;
      const nextProbe = probeTarget === "HEALTHY"
        ? null
        : probeTarget === "OPEN_BREAKER"
          ? new Date(now.getTime() + policy.openCooldownSeconds * 1000)
          : new Date(now.getTime() + policy.probeIntervalSeconds * 1000);
      const computedAt = computedChanged ? now : asDate(current.healthComputedAt);
      await tx.$executeRawUnsafe(
        `UPDATE rail_routes SET
           health_computed_state = $2::"HealthState", health_computed_reason = $3, health_computed_at = $4,
           health_state = CASE WHEN $5::boolean THEN health_state ELSE $6::"HealthState" END,
           health_reason = CASE WHEN $5::boolean THEN health_reason ELSE $7 END,
           health_changed_at = CASE WHEN $8::boolean THEN $4 ELSE health_changed_at END,
           health_consecutive_failures = $9, health_probe_successes = $10, health_probe_failures = $11,
           health_next_probe_at = $12, updated_at = now()
         WHERE id = $1::uuid`,
        routeId,
        computed,
        reason,
        computedAt,
        overrideActive || shadow,
        effective,
        overrideActive ? "ADMIN_OVERRIDE" : reason,
        effectiveChanged && !shadow,
        streak,
        nextProbeSuccesses,
        nextProbeFailures,
        nextProbe,
      );
      if (computedChanged || effectiveChanged) {
        await tx.$executeRawUnsafe(
          `INSERT INTO route_health_events (id, route_id, from_state, to_state, source, reason, evidence_json)
           VALUES (gen_random_uuid(), $1::uuid, $2::"HealthState", $3::"HealthState", $4::"RouteHealthEventSource", $5, $6::jsonb)`,
          routeId,
          current.healthState,
          effective,
          shadow ? "SHADOW" : source,
          reason,
          JSON.stringify({ computed, effective, counts, consecutiveFailures: streak, overrideActive }),
        );
        await writeSystemAudit(tx, {
          action: shadow ? "ROUTE_HEALTH_SHADOW_DECISION" : "ROUTE_HEALTH_CHANGED",
          entityType: "RAIL_ROUTE",
          entityId: routeId,
          before: { state: current.healthState, computed: current.healthComputedState, override: overrideState },
          after: { state: effective, computed, reason, overrideActive, counts },
        });
      }
    });

    if (shadow) return;
    if (conflict) {
      await openKeyedOperatorCase(this.db, {
        kind: "MANUAL_REVIEW",
        priority: "P2",
        subjectKey: `route.health.override_conflict:${routeId}`,
        slaHours: 24,
        now,
        notes: `Route ${routeId} is forced to ${effective} by an admin override while automation computes ${computed} (${reason}).`,
      });
    } else {
      await this.clearCase(`route.health.override_conflict:${routeId}`, now, "Override no longer conflicts");
    }
    if (!conflict && (computed === "DEGRADED" || computed === "OPEN_BREAKER")) {
      await openKeyedOperatorCase(this.db, {
        kind: "MANUAL_REVIEW",
        priority: computed === "OPEN_BREAKER" ? "P1" : "P2",
        subjectKey: `route.health:${routeId}`,
        slaHours: computed === "OPEN_BREAKER" ? 4 : 24,
        now,
        notes: `Route ${routeId} is ${computed}: ${reason}.`,
      });
    } else if (!conflict) {
      await this.clearCase(`route.health:${routeId}`, now, "Route health recovered");
    }
  }

  private async recordProbe(route: RouteRow, result: RouteHealthProbeResult, now: Date, policy: RouteHealthPolicy): Promise<void> {
    await this.db.$executeRawUnsafe(
      `INSERT INTO route_health_probes
         (id, created_at, route_id, credential_set_id, gateway_version_id, method, status, reason, http_status, latency_ms)
       VALUES (gen_random_uuid(), $1, $2::uuid, $3::uuid, $4::uuid, $5::"RouteHealthProbeMethod",
               $6::"RouteHealthProbeStatus", $7, $8, $9)`,
      now,
      result.routeId,
      result.credentialSetId,
      result.gatewayVersionId,
      result.method,
      result.status,
      result.reason,
      result.httpStatus,
      result.latencyMs,
    );
    let successes = result.status === "PASSED" ? route.healthProbeSuccesses + 1 : 0;
    const failures = result.status === "FAILED" ? route.healthProbeFailures + 1 : 0;
    const backoff = Math.min(policy.probeBackoffMaxSeconds, policy.probeIntervalSeconds * 2 ** Math.min(failures, 8));
    const next = result.status === "SKIPPED"
      ? new Date(now.getTime() + Math.max(policy.probeIntervalSeconds, 300) * 1000)
      : new Date(now.getTime() + (result.status === "PASSED" ? policy.probeIntervalSeconds : backoff) * 1000);
    let state = route.healthComputedState;
    let reason = route.healthComputedReason ?? "DEGRADED";
    const overrideNeedsProbe = route.healthOverrideState !== null && route.healthOverrideState !== "HEALTHY";
    if (result.status === "FAILED" && (state === "DEGRADED" || state === "OPEN_BREAKER")) {
      state = "OPEN_BREAKER";
      reason = "PROBE_FAILED";
      successes = 0;
    } else if (result.status === "PASSED") {
      const decision = decideRouteHealth({
        current: state,
        counts: emptyRouteHealthCounts(),
        consecutiveFailures: route.healthConsecutiveFailures,
        probeSuccesses: successes,
        policy,
      });
      state = decision.state;
      reason = decision.reason;
    }
    await this.applyDecision(route.id, route, state, reason, emptyRouteHealthCounts(), route.healthConsecutiveFailures, now, policy, "PROBE", successes, failures);
    await this.db.$executeRawUnsafe(
      `UPDATE rail_routes SET health_last_probe_at = $2, health_next_probe_at = $3,
         health_probe_successes = $4, health_probe_failures = $5, updated_at = now()
       WHERE id = $1::uuid`,
      route.id,
      now,
      state === "HEALTHY" ? null : next,
      successes,
      failures,
    );
  }

  private async clearCase(subjectKey: string, now: Date, detail: string): Promise<void> {
    await clearKeyedCase(this.db as never, {
      kind: "MANUAL_REVIEW",
      subjectKey,
      detail,
      now,
    });
  }
}

export const DEFAULT_GATEWAY_HEALTH_INTERVAL_MS = DEFAULT_ROUTE_HEALTH_POLICY.probeIntervalSeconds * 1000;
