import { InvariantVerifier } from "../ledger/InvariantVerifier";
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
  private readonly onDrift: ((drift: string) => void) | undefined;

  constructor(deps: LedgerInvariantWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60_000 });
    this.onDrift = deps.onDrift;
  }

  protected async tick(): Promise<void> {
    const verifier = new InvariantVerifier(this.db as never);
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
    const open = await this.db.operatorCase.findFirst({
      where: { kind: "MISMATCH", priority: "P1", state: "OPEN" },
      select: { id: true },
    });
    if (open) {
      return;
    }
    await this.db.operatorCase.create({
      data: {
        kind: "MISMATCH",
        priority: "P1",
        state: "OPEN",
        resolutionNotes: `The system wide double-entry invariant drifted by ${drift} LYD`,
        slaDueAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      },
    });
  }
}

export type { PrismaLike };
