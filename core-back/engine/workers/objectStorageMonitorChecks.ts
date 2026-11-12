import type { PrismaClient } from "../../generated/prisma/client";
import type { ObjectStorageSdk } from "../../lib/objectStorageSdk";
import type { MonitorFinding, PlatformMonitorCheck } from "./PlatformMonitorWorker";

/**
 * AUTO-03 extension: shared object & asset storage health.
 *
 * The console exposes this data live; the monitor turns the conditions an
 * operator must act on into keyed cases so they also appear when nobody is
 * watching the page:
 *
 *   health            the mTLS daemon (or the local vault) is unreachable
 *   scrub-errors      an ACTIVE object failed its integrity scrub
 *   quarantine-stuck  a quarantined upload has waited for AV for over 30 min
 */
export interface ObjectStorageMonitorOptions {
  sdk: ObjectStorageSdk;
  prisma: PrismaClient;
  /** A quarantined object older than this is reported. Default 30 minutes. */
  quarantineMaxAgeMs?: number;
}

const DEFAULT_QUARANTINE_MAX_AGE_MS = 30 * 60 * 1000;

export const createObjectStorageMonitorCheck = (options: ObjectStorageMonitorOptions): PlatformMonitorCheck => ({
  id: "object_storage",
  async run({ now }): Promise<MonitorFinding[]> {
    const findings: MonitorFinding[] = [];
    const health = await options.sdk.blobStore.healthCheck();
    if (!health.ok) {
      findings.push({
        key: "health",
        title: "The shared object storage vault cannot be reached",
        detail: `The ${health.mode === "REMOTE_MTLS" ? "mTLS object-storage daemon" : "local object vault"} at ${health.rootDirOrUrl} is unhealthy${health.error ? `: ${health.error}` : ""}. Uploads and downloads will fail.`,
        priority: "P1",
      });
    }

    const scrubErrors = await options.prisma.storageObject.count({
      where: { status: "ACTIVE", scrubErrorCount: { gt: 0 } },
    });
    if (scrubErrors > 0) {
      findings.push({
        key: "scrub-errors",
        title: "Stored objects failed their integrity scrub",
        detail: `${scrubErrors} ACTIVE object(s) have a non-zero scrub error count and may not decrypt. Inspect /system/object-storage and restore the affected objects from backup.`,
        priority: "P1",
      });
    }

    const cutoff = new Date(now.getTime() - (options.quarantineMaxAgeMs ?? DEFAULT_QUARANTINE_MAX_AGE_MS));
    const stuck = await options.prisma.storageObject.count({
      where: {
        status: "QUARANTINE_PENDING_AV",
        createdAt: { lt: cutoff },
      },
    });
    if (stuck > 0) {
      findings.push({
        key: "quarantine-stuck",
        title: "Uploads are waiting too long for malware scanning",
        detail: `${stuck} uploaded object(s) have been in QUARANTINE_PENDING_AV for more than ${Math.round((options.quarantineMaxAgeMs ?? DEFAULT_QUARANTINE_MAX_AGE_MS) / 60_000)} minutes. The scanner backlog blocks their owners from downloading them.`,
        priority: "P2",
      });
    }

    return findings;
  },
});
