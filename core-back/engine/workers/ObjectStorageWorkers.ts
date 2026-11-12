import type { PrismaClient } from "../../generated/prisma/client";
import type { ObjectStorageSdk } from "../../lib/objectStorageSdk";
import { containsActiveContent } from "../../lib/kybScan";
import { BaseWorker, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";

const EICAR_MARKER = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export interface ObjectStorageWorkerDeps {
  sdk: ObjectStorageSdk;
  /** The Prisma client the SDK is bound to (same database). */
  prisma: PrismaClient;
}

/**
 * The generic object-storage maintenance and quarantine scan.
 *
 * KYB documents are deliberately excluded from the generic scan: the
 * dedicated `KybScanWorker` owns their domain status machine and applies the
 * configured ClamAV/EICAR verdict to the same object. Running two scanners on
 * one KYB object would let one promote it while the other quarantines it.
 */
export function createObjectStorageWorkers(deps: ObjectStorageWorkerDeps) {
  const { sdk, prisma } = deps;

  const runGcBatch = () => sdk.workerClient.runGcBatch();
  const runBlobSweep = () => sdk.workerClient.runBlobSweep();
  const runIntegrityScrubBatch = (batchSize = 50) => sdk.workerClient.runIntegrityScrubBatch(batchSize);
  const runLockReconcile = () => sdk.workerClient.runLockReconcile();
  const runRewrapBatch = (batchSize = 100) => sdk.workerClient.runRewrapBatch(batchSize);

  async function runAvScanBatch(batchSize = 25): Promise<{ scanned: number; clean: number; infected: number }> {
    const pending = await prisma.storageObject.findMany({
      where: {
        status: 'QUARANTINE_PENDING_AV',
        avScanStatus: 'PENDING',
        namespace: { not: 'KYB_DOCUMENTS' },
      },
      orderBy: { createdAt: 'asc' },
      take: clampBatch(batchSize),
    });
    let clean = 0;
    let infected = 0;
    for (const obj of pending) {
      let bytes: Buffer;
      try {
        ({ bytes } = await sdk.workerClient.readForScan(obj.id));
      } catch (error) {
        // A corrupt/unreadable object must not be promoted by accident. Leave
        // it PENDING (fail closed); the scrub/integrity tools will report it.
        continue;
      }
      const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8192)).toString('utf8');
      const isEicar = sample.includes(EICAR_MARKER);
      const active = containsActiveContent(bytes);
      if (isEicar || active) {
        await sdk.workerClient.applyScanVerdict({
          objectId: obj.id,
          verdict: 'INFECTED',
          signature: isEicar ? 'EICAR-Test-Signature' : 'ACTIVE_CONTENT',
        });
        infected++;
      } else {
        await sdk.workerClient.applyScanVerdict({ objectId: obj.id, verdict: 'CLEAN' });
        clean++;
      }
    }
    return { scanned: pending.length, clean, infected };
  }

  return {
    runAvScanBatch,
    runGcBatch,
    runBlobSweep,
    runIntegrityScrubBatch,
    runLockReconcile,
    runRewrapBatch,
  };
}

function clampBatch(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.min(1000, Math.floor(value)) : 25;
}

export interface ObjectStorageWorkerOptions extends WorkerOptions, ObjectStorageWorkerDeps {
  /** The orphan-blob sweep walks the whole vault; run it this many ticks apart (default 60). */
  sweepEveryTicks?: number;
  /** KEK rewrap is cheap but not free; run it this many ticks apart (default 10). */
  rewrapEveryTicks?: number;
}

/**
 * One periodic worker that drains every object-storage housekeeping job that
 * does not need its own scheduler. It is NOT a singleton: every node may scan
 * its own batch; the database guard triggers and the row updates make the
 * operations idempotent, and the AV claims move rows out of the PENDING state
 * so two nodes never apply a different verdict to the same object.
 */
export class ObjectStorageMaintenanceWorker extends BaseWorker {
  private readonly sdk: ObjectStorageSdk;
  private readonly prisma: PrismaClient;
  private readonly sweepEveryTicks: number;
  private readonly rewrapEveryTicks: number;
  private tickCount = 0;

  constructor(options: ObjectStorageWorkerOptions) {
    super(options);
    this.sdk = options.sdk;
    this.prisma = options.prisma;
    this.sweepEveryTicks = Math.max(1, options.sweepEveryTicks ?? 60);
    this.rewrapEveryTicks = Math.max(1, options.rewrapEveryTicks ?? 10);
  }

  protected async tick(): Promise<WorkerTickResult> {
    this.tickCount++;
    const batchSize = this.batchSize;
    let processed = 0;

    const scan = await createObjectStorageWorkers({ sdk: this.sdk, prisma: this.prisma }).runAvScanBatch(batchSize);
    processed += scan.scanned;

    const gc = await this.sdk.workerClient.runGcBatch(this.clock());
    processed += gc.purgedObjectIds.length;

    const scrub = await this.sdk.workerClient.runIntegrityScrubBatch(batchSize);
    processed += scrub.verifiedCount + scrub.corruptedObjectIds.length;

    const reconcile = await this.sdk.workerClient.runLockReconcile();
    processed += reconcile.releasedDanglingLocks;

    if (this.tickCount % this.rewrapEveryTicks === 0) {
      const rewrap = await this.sdk.workerClient.runRewrapBatch(Math.max(100, batchSize * 4));
      processed += rewrap.rewrappedCount;
    }
    if (this.tickCount % this.sweepEveryTicks === 0) {
      const sweep = await this.sdk.workerClient.runBlobSweep();
      processed += sweep.trashedOrphans.length;
    }

    return { processed };
  }
}
