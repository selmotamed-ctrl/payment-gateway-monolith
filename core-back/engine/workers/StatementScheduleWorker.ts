import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase } from "./automationCases";
import { lastScheduledAtOrBefore, parseCron } from "../../lib/cron";
import { DEFAULT_BUSINESS_TIME_ZONE } from "./deadlines/businessTime";

type Any = Record<string, any>;

export interface StatementScheduleWorkerDeps extends WorkerOptions {
  /** Minutes after a scheduled time before a missing statement is reported. Default 120. */
  graceMinutes?: number;
  /** Scheduled slots looked at per source, newest first (older ones are ignored). Default 7. */
  lookbackSlots?: number;
  timeZone?: string;
  caseSlaHours?: number;
  /** Restricts the worker to these sources. Production leaves it unset; tests that share a database use it. */
  sourceIds?: readonly string[];
}

export const statementMissingSubjectKey = (sourceId: string, slot: Date): string => `statement.missing:${sourceId}:${slot.toISOString()}`;

/**
 * Statement schedules and missing-statement alerts (AUTO-07). Cluster singleton, every 5 minutes.
 *
 * `statement_sources.schedule_cron` was stored and editable but nothing read it. For every source with a cron, in
 * `Africa/Tripoli` time, the worker takes the last `lookbackSlots` scheduled times that are more than `graceMinutes`
 * old. A slot is SATISFIED when a reconciliation run of that source was created at or after the slot and before the
 * next slot (plus its grace): the statement arrived for that period. An unsatisfied slot opens ONE keyed case
 * `statement.missing:<source>:<slot>` (one case per missed slot, so a daily source that misses three days has three
 * cases); when the statement arrives later the open case is resolved with a note. A source created after a slot never
 * owes that slot. An invalid cron expression is reported once as its own keyed case and skipped.
 *
 * Not built: pulling the statement from the provider (`STATEMENT_FETCH`; no connector exists yet) and the settlement
 * sweep that AUTO-15 would schedule after a successful run. A run that arrives later than the next slot's grace is
 * attributed to that later slot, so the older case stays open for a person to resolve.
 */
export class StatementScheduleWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly deps: StatementScheduleWorkerDeps;

  constructor(deps: StatementScheduleWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 5 * 60 * 1000 });
    this.deps = deps;
  }

  protected async tick(): Promise<WorkerTickResult> {
    const now = this.clock();
    const graceMs = Math.max(0, this.deps.graceMinutes ?? 120) * 60_000;
    const lookback = Math.max(1, Math.floor(this.deps.lookbackSlots ?? 7));
    const zone = this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
    const scoped = this.deps.sourceIds && this.deps.sourceIds.length > 0;
    const sources = toCamelRows<Any>(
      await this.db.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.schedule_cron, s.created_at, g.name AS gateway_name
         FROM statement_sources s LEFT JOIN gateways g ON g.id = s.gateway_id
         WHERE s.schedule_cron IS NOT NULL AND btrim(s.schedule_cron) <> ''${scoped ? " AND s.id::text = ANY($2::text[])" : ""}
         ORDER BY s.created_at ASC, s.id ASC LIMIT $1`,
        this.batchSize,
        ...(scoped ? [[...this.deps.sourceIds!]] : []),
      ),
    );
    let opened = 0;
    let resolved = 0;
    const errors: string[] = [];
    for (const source of sources) {
      try {
        const result = await this.checkSource(source, now, graceMs, lookback, zone);
        opened += result.opened;
        resolved += result.resolved;
      } catch (error) {
        errors.push(`${source.id}: ${sanitizeWorkerError(error)}`);
      }
    }
    if (opened + resolved > 0) this.logger.info("StatementScheduleWorker: statement alerts", { opened, resolved });
    if (errors.length > 0) throw new Error(`statement schedule failed for ${errors.length} source(s) (${errors[0]})`);
    return { processed: opened + resolved };
  }

  private async checkSource(source: Any, now: Date, graceMs: number, lookback: number, zone: string): Promise<{ opened: number; resolved: number }> {
    const sourceId = String(source.id);
    let cron;
    try {
      cron = parseCron(String(source.scheduleCron));
    } catch (error) {
      await openKeyedOperatorCase(this.db, {
        kind: "UNMATCHED_STATEMENT",
        priority: "P3",
        subjectKey: `statement.schedule_invalid:${sourceId}`,
        notes: `The statement schedule "${String(source.scheduleCron)}" of source ${sourceId} is not a valid cron expression (${(error as Error).message}); no missing-statement alert can run for it.`,
        slaHours: 72,
        now,
      });
      return { opened: 0, resolved: 0 };
    }
    // Newest slot that is already past its grace, then the earlier ones.
    const slots: Date[] = [];
    let cursor: Date | null = lastScheduledAtOrBefore(cron, new Date(now.getTime() - graceMs), { timeZone: zone });
    while (cursor && slots.length < lookback) {
      slots.push(cursor);
      cursor = lastScheduledAtOrBefore(cron, new Date(cursor.getTime() - 60_000), { timeZone: zone });
    }
    if (slots.length === 0) return { opened: 0, resolved: 0 };
    const createdAt = source.createdAt instanceof Date ? source.createdAt : new Date(String(source.createdAt));
    const runs = toCamelRows<Any>(
      await this.db.$queryRawUnsafe(
        `SELECT created_at FROM reconciliation_runs WHERE statement_source_id = $1::uuid AND created_at >= $2 ORDER BY created_at ASC LIMIT 500`,
        sourceId,
        slots.at(-1)!,
      ),
    );
    const arrivals = runs.map((row) => (row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt))).getTime());
    let opened = 0;
    let resolved = 0;
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]!;
      if (createdAt.getTime() > slot.getTime()) continue; // the source did not exist yet
      const next = index === 0 ? null : slots[index - 1]!;
      const upper = next ? next.getTime() + graceMs : Number.POSITIVE_INFINITY;
      const satisfied = arrivals.some((at) => at >= slot.getTime() && at < upper);
      const key = statementMissingSubjectKey(sourceId, slot);
      if (satisfied) {
        resolved += await this.resolveOpenCase(key, now);
        continue;
      }
      const result = await openKeyedOperatorCase(this.db, {
        kind: "UNMATCHED_STATEMENT",
        priority: "P2",
        subjectKey: key,
        notes: `No statement arrived for source ${sourceId}${source.gatewayName ? ` (${String(source.gatewayName)})` : ""} for the schedule of ${slot.toISOString()} (cron "${String(source.scheduleCron)}", ${Math.round(graceMs / 60_000)} min grace). Upload the statement or ask the provider; the case resolves itself when it arrives.`,
        slaHours: this.deps.caseSlaHours ?? 24,
        now,
      });
      if (result.created) {
        opened += 1;
        await writeSystemAudit(this.db as Any, {
          action: "STATEMENT_MISSING",
          entityType: "STATEMENT_SOURCE",
          entityId: sourceId,
          after: { slot: slot.toISOString(), cron: String(source.scheduleCron) },
        });
      }
    }
    return { opened, resolved };
  }

  private async resolveOpenCase(subjectKey: string, now: Date): Promise<number> {
    const changed = await this.db.$executeRawUnsafe(
      `UPDATE operator_cases SET state = 'RESOLVED', resolution_notes = left(coalesce(resolution_notes, '') || E'\\n' || $2, 8000), updated_at = $3
       WHERE kind = 'UNMATCHED_STATEMENT' AND subject_key = $1 AND state <> 'RESOLVED'`,
      subjectKey,
      `[AUTO-RESOLVED ${now.toISOString()}] The statement arrived.`,
      now,
    );
    return Number(changed) > 0 ? 1 : 0;
  }
}
