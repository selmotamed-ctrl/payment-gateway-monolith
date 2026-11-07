/**
 * Pure helpers of the System Jobs & Outbox monitor: ageing labels, which rows may be acted on and
 * the metric strip derived from the summary endpoint.
 */

export interface JobsOutboxSummary {
    unpublishedOutbox: number;
    oldestUnpublishedOutboxAt: string | null;
    auditOutboxQueued: number;
    oldestAuditOutboxAt: string | null;
    jobs24h: { queued: number; running: number; succeeded: number; failed: number };
    failedNotifications: number;
    /** Health of the ledger automation (shard checkpoints and shard scaling). */
    ledger?: {
        shards: number;
        shardsBehind: number;
        maxPendingLines: string;
        oldestPendingCheckpointAt: string | null;
        failedShards: number;
        lastScaling: { glAccountId: string; shardCount: number; at: string } | null;
    };
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** 4m, 2h 05m, 3d 4h: a compact human age for queue backlog. */
export const formatAge = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
    const total = Math.floor(seconds);
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
};

export const ageSecondsSince = (iso: string | null | undefined, now: number = Date.now()): number | null => {
    if (!iso) return null;
    const time = new Date(iso).getTime();
    return Number.isNaN(time) ? null : Math.max(0, Math.round((now - time) / 1000));
};

/** A backlog is calm under 1 minute, worth watching under 15 minutes, urgent beyond. */
export const backlogTone = (count: number, oldestAgeSeconds: number | null): Tone => {
    if (count <= 0) return "success";
    if (oldestAgeSeconds === null) return "warning";
    if (oldestAgeSeconds > 15 * 60) return "danger";
    if (oldestAgeSeconds > 60) return "warning";
    return "info";
};

/** Only a FAILED job can be re-queued (the server rejects everything else with JOB_NOT_FAILED). */
export const canRequeueJob = (state: string | null | undefined, canWrite: boolean): boolean => canWrite && state === "FAILED";

/** Only a FAILED notification can be retried (NOTIFICATION_NOT_FAILED otherwise). */
export const canRetryNotification = (status: string | null | undefined, canWrite: boolean): boolean => canWrite && status === "FAILED";

export const attemptsLabel = (attempts: number, maxAttempts: number): string => `${attempts} / ${maxAttempts}`;

export const jobStateTone = (state: string | null | undefined): Tone => {
    switch (state) {
        case "SUCCEEDED":
            return "success";
        case "FAILED":
            return "danger";
        case "RUNNING":
            return "info";
        case "QUEUED":
            return "warning";
        default:
            return "neutral";
    }
};

export const OUTBOX_TABS = ["outbox", "audit", "jobs", "notifications"] as const;
export type OutboxTab = (typeof OUTBOX_TABS)[number];

export const normalizeTab = (value: unknown): OutboxTab => (OUTBOX_TABS as readonly string[]).includes(String(value)) ? (String(value) as OutboxTab) : "outbox";

/** Job errors can be long stack-like strings; the table shows the start, the title attribute the rest. */
export const truncateError = (value: string | null | undefined, max = 140): string => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
