import { BaseWorker, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase } from "./automationCases";

type Any = Record<string, any>;

/** Attempt statuses that hold a payment-link slot: every non-terminal one (a slot is released on a terminal failure and committed on success). */
export const SLOT_HOLDING_STATUSES = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"] as const;

export interface ConsistencyAuditWorkerDeps extends WorkerOptions {
  /** Repair the drifted counters. Default false: report only (plan rule 2). */
  repair?: boolean;
  /** A link changed more recently than this is skipped (an in-flight reservation looks like drift). Default 15 minutes. */
  settleMs?: number;
  caseSlaHours?: number;
  /** Restricts the audit to these links. Production leaves it unset; tests that share a database use it. */
  linkIds?: readonly string[];
}

/**
 * Slot counter self-healing (AUTO-12). Cluster singleton, hourly, REPORT ONLY unless `repair` is switched on.
 *
 * `payment_links.active_locked_count` should equal the number of live (non-terminal) attempts of the link. It can drift
 * when a crash leaves a reservation behind or a release path was missed; a drifted counter makes a link unusable
 * (`confirmed + active >= use_count`) or over-sells it. The worker compares the counter with the attempts for finite-use
 * links that have not changed for `settleMs`, opens ONE keyed case per drifted link (`link.slot_drift:<id>`, P3,
 * with both numbers), and, only when `repair` is on, corrects the counter under the row lock (re-checking the live
 * count inside the lock) and audits it. The daily cap counters against the read models are not audited here.
 */
export class ConsistencyAuditWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly deps: ConsistencyAuditWorkerDeps;

  constructor(deps: ConsistencyAuditWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60 * 60 * 1000, batchSize: deps.batchSize ?? 200 });
    this.deps = deps;
  }

  protected async tick(): Promise<WorkerTickResult> {
    const now = this.clock();
    const settled = new Date(now.getTime() - Math.max(0, this.deps.settleMs ?? 15 * 60_000));
    const scoped = this.deps.linkIds && this.deps.linkIds.length > 0;
    const drifted = toCamelRows<Any>(
      await this.db.$queryRawUnsafe(
        `SELECT l.id::text AS id, l.key, l.active_locked_count AS recorded, coalesce(a.n, 0)::int AS live
         FROM payment_links l
         LEFT JOIN (SELECT link_id, count(*) AS n FROM payment_attempts WHERE status::text = ANY($1::text[]) GROUP BY link_id) a ON a.link_id = l.id
         WHERE l.infinite_use = false AND l.updated_at < $2 AND l.active_locked_count <> coalesce(a.n, 0)${scoped ? " AND l.id::text = ANY($4::text[])" : ""}
         ORDER BY l.updated_at ASC LIMIT $3`,
        [...SLOT_HOLDING_STATUSES],
        settled,
        this.batchSize,
        ...(scoped ? [[...this.deps.linkIds!]] : []),
      ),
    );
    let repaired = 0;
    for (const row of drifted) {
      const id = String(row.id);
      const message = `Payment link ${String(row.key)} (${id}) records ${Number(row.recorded)} locked slot(s) but has ${Number(row.live)} live attempt(s).`;
      if (this.deps.repair) {
        repaired += await this.repair(id, message, now);
        continue;
      }
      const result = await openKeyedOperatorCase(this.db, {
        kind: "MISMATCH",
        priority: "P3",
        subjectKey: `link.slot_drift:${id}`,
        notes: `${message} Slot repair is switched off; correct it by hand or enable the repair flag.`,
        slaHours: this.deps.caseSlaHours ?? 72,
        now,
      });
      if (result.created) this.logger.warn("ConsistencyAuditWorker: slot drift", { linkId: id, recorded: row.recorded, live: row.live });
    }
    return { processed: drifted.length, backlog: drifted.length - repaired };
  }

  private async repair(linkId: string, message: string, now: Date): Promise<number> {
    return this.inTransaction(async (tx) => {
      const locked = toCamelRows<Any>(
        await tx.$queryRawUnsafe(`SELECT active_locked_count AS recorded FROM payment_links WHERE id = $1::uuid AND infinite_use = false FOR UPDATE`, linkId),
      );
      if (locked.length === 0) return 0;
      const live = Number(
        toCamelRows<Any>(
          await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM payment_attempts WHERE link_id = $1::uuid AND status::text = ANY($2::text[])`, linkId, [...SLOT_HOLDING_STATUSES]),
        )[0]?.n ?? 0,
      );
      const recorded = Number(locked[0]!.recorded);
      if (recorded === live) return 0; // healed or still in flight
      await tx.$executeRawUnsafe(`UPDATE payment_links SET active_locked_count = $2, updated_at = $3 WHERE id = $1::uuid`, linkId, live, now);
      await writeSystemAudit(tx, {
        action: "PAYMENT_LINK_SLOTS_REPAIRED",
        entityType: "PAYMENT_LINK",
        entityId: linkId,
        before: { activeLockedCount: recorded },
        after: { activeLockedCount: live, note: message },
      });
      return 1;
    });
  }
}
