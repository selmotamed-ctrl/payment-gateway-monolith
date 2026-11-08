import type { CatalogStore } from "./catalogStore";
import type { JobQueue } from "./jobQueue";

export interface RestoredJobState {
  /** Runs that were QUEUED/RUNNING when the previous process stopped; now recorded as FAILED. */
  interrupted: string[];
  /** Idempotency keys restored for jobs that really finished. */
  restoredKeys: number;
}

/**
 * Brings job state back after a restart:
 *  1. runs that can never finish (their process is gone) are marked FAILED instead of staying RUNNING forever;
 *  2. idempotency keys are restored ONLY for jobs that genuinely completed. An interrupted job's key is dropped
 *     (even though its run is FAILED now), so a client retry starts a fresh job rather than being handed the id
 *     of one that died with the old process.
 */
export const restoreJobState = async (catalog: CatalogStore, jobs: JobQueue): Promise<RestoredJobState> => {
  const interrupted = await catalog.failInterruptedRuns();
  const interruptedIds = new Set(interrupted);
  const restoredKeys = await jobs.loadKeys((id) => !interruptedIds.has(id) && catalog.hasFinishedJob(id));
  return { interrupted, restoredKeys };
};
