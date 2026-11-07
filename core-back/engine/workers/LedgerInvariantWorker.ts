import { InvariantVerifier } from "../ledger/InvariantVerifier";
import { LEDGER_SUBJECT_KEYS, raiseLedgerCase } from "../ledger/ledgerAlerts";
import type { PrismaLike } from "../db/ports";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface LedgerInvariantWorkerDeps extends WorkerOptions {
  intervalMs?: number;
  onDrift?: (drift: string) => void;
}

/**
 * The design requires the double-entry invariant to be checked continuously
 * by `core-back` and not only on demand from the admin panel. This worker
 * verifies the invariant on a schedule and raises an operator case whenever
 * the system wide drift becomes non zero.
 */
export class LedgerInvariantWorker extends BaseWorker {
  /** Cluster singleton: only the advisory-lock leader ticks (GAP-012). */
  protected override get singleton(): boolean {
    return true;
  }

  private readonly onDrift: ((drift: string) => void) | undefined;

  constructor(deps: LedgerInvariantWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60_000 });
    this.onDrift = deps.onDrift;
  }

  protected async tick(): Promise<void> {
    const verifier = new InvariantVerifier(this.db as never, { sql: true });
    const result = await verifier.verify();
    if (result.ok) {
      return;
    }
    const drift = result.drift.toFixed(4);
    this.logger.error("Ledger invariant drift detected", {
      drift,
      left: result.leftSide.toFixed(4),
      right: result.rightSide.toFixed(4),
    });
    this.onDrift?.(drift);
    await this.raiseOperatorCase(drift);
  }

  private async raiseOperatorCase(drift: string): Promise<void> {
    // Keyed, so it does not suppress (or get suppressed by) a per-shard checkpoint alert.
    await raiseLedgerCase(this.db as never, {
      subjectKey: LEDGER_SUBJECT_KEYS.invariant,
      notes: `The system wide double-entry invariant drifted by ${drift} LYD`,
      now: this.clock(),
    });
  }
}

export type { PrismaLike };
