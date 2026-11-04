/**
 * Single client for the Academy progress record, shared by the Academy pages and the Guide's
 * read tracking. Offline-safe: the last known record and a queue of unsent patches live in
 * `localStorage["pg.academy.progress"]`; a failed save never blocks learning and only shows a
 * small "not saved yet" indicator.
 */
import { computed, ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import type { AcademyBadge, AcademyProgress, ProgressEnvelope, ProgressPatch } from "@/content/academy/apiTypes";
import type { TrackId } from "@/content/academy";
import { applyPatch, emptyProgress, isEmptyPatch, isGuideReadEntry, mergePatches, mergeProgress } from "./progressMerge";

const STORAGE_KEY = "pg.academy.progress";
const FLUSH_DELAY_MS = 400;

interface StoredState {
    progress: AcademyProgress;
    queue: ProgressPatch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalise = (value: unknown): AcademyProgress | null => {
    if (!isRecord(value) || value.schema !== 1) return null;
    const base = emptyProgress();
    return {
        ...base,
        ...(value as unknown as AcademyProgress),
        guideRead: isRecord(value.guideRead) ? (value.guideRead as AcademyProgress["guideRead"]) : {},
        lessons: isRecord(value.lessons) ? (value.lessons as AcademyProgress["lessons"]) : {},
        labs: isRecord(value.labs) ? (value.labs as AcademyProgress["labs"]) : {},
        exams: isRecord(value.exams) ? (value.exams as AcademyProgress["exams"]) : {},
        badges: Array.isArray(value.badges) ? (value.badges as AcademyBadge[]) : [],
    };
};

const readStored = (): StoredState | null => {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) return null;
        const progress = normalise(parsed.progress);
        if (!progress) return null;
        return { progress, queue: isRecord(parsed.queue) ? (parsed.queue as ProgressPatch) : {} };
    } catch {
        return null;
    }
};

const writeStored = (): void => {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ progress: progress.value, queue: queue.value }));
    } catch {
        // storage unavailable or full: the server copy is still authoritative.
    }
};

const stored = readStored();
const progress = ref<AcademyProgress>(stored?.progress ?? emptyProgress());
const queue = ref<ProgressPatch>(stored?.queue ?? {});
const loaded = ref(false);
const loading = ref(false);
const saving = ref(false);
const serverAvailable = ref(false);
const unsaved = computed(() => !isEmptyPatch(queue.value));

let loadPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<boolean> | null = null;

const unwrap = (response: { data?: unknown }): ProgressEnvelope | null => {
    const payload = isRecord(response.data) && "data" in response.data ? (response.data as { data: unknown }).data : response.data;
    if (!isRecord(payload)) return null;
    const record = normalise(payload.progress);
    if (!record) return null;
    return { progress: record, rev: typeof payload.rev === "number" ? payload.rev : record.rev };
};

const fetchRemote = async (): Promise<AcademyProgress | null> => {
    const response = await api.get(urlsMap.academyProgress);
    const envelope = unwrap(response);
    return envelope ? { ...envelope.progress, rev: envelope.rev } : null;
};

/** Load once; later callers share the same promise. Safe to call from every page. */
export const loadAcademyProgress = async (force = false): Promise<void> => {
    if (loaded.value && !force) return;
    if (loadPromise && !force) return loadPromise;
    loadPromise = (async () => {
        loading.value = true;
        try {
            const remote = await fetchRemote();
            if (remote) {
                progress.value = isEmptyPatch(queue.value) ? remote : applyPatch(remote, queue.value);
                serverAvailable.value = true;
            }
        } catch {
            serverAvailable.value = false;
        } finally {
            loaded.value = true;
            loading.value = false;
            loadPromise = null;
            writeStored();
        }
        if (serverAvailable.value && !isEmptyPatch(queue.value)) void flushAcademyProgress();
    })();
    return loadPromise;
};

const putOnce = async (patch: ProgressPatch): Promise<"ok" | "conflict" | "failed"> => {
    try {
        const response = await api.put(urlsMap.academyProgress, { baseRev: progress.value.rev, patch });
        const envelope = unwrap(response);
        if (!envelope) return "failed";
        progress.value = { ...envelope.progress, rev: envelope.rev };
        return "ok";
    } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        return status === 409 ? "conflict" : "failed";
    }
};

/** Send the queued patch now. Resolves true when nothing is left unsent. */
export const flushAcademyProgress = async (): Promise<boolean> => {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (flushing) return flushing;
    if (isEmptyPatch(queue.value)) return true;
    flushing = (async () => {
        saving.value = true;
        try {
            const sent = queue.value;
            let result = await putOnce(sent);
            if (result === "conflict") {
                // Someone else (another tab/device) wrote first: merge the server copy, retry once.
                const remote = await fetchRemote().catch(() => null);
                if (remote) {
                    progress.value = mergeProgress(applyPatch(progress.value, sent), remote);
                    result = await putOnce(sent);
                }
            }
            if (result === "ok") {
                serverAvailable.value = true;
                // Patches queued while the request was in flight stay queued.
                queue.value = removeSent(queue.value, sent);
                // The server record is authoritative; re-apply anything still queued on top.
                if (!isEmptyPatch(queue.value)) progress.value = applyPatch(progress.value, queue.value);
            }
            writeStored();
            return result === "ok" && isEmptyPatch(queue.value);
        } finally {
            saving.value = false;
            flushing = null;
        }
    })();
    return flushing;
};

/** Drop from `current` what `sent` already carried (equal entries), keeping newer additions. */
const removeSent = (current: ProgressPatch, sent: ProgressPatch): ProgressPatch => {
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const out: ProgressPatch = {};
    if (current.activeTrack && current.activeTrack !== sent.activeTrack) out.activeTrack = current.activeTrack;
    for (const key of ["guideRead", "lessons", "labs"] as const) {
        const remaining = Object.fromEntries(
            Object.entries(current[key] ?? {}).filter(([id, entry]) => !same(entry, (sent[key] as Record<string, unknown> | undefined)?.[id])),
        );
        if (Object.keys(remaining).length > 0) (out as Record<string, unknown>)[key] = remaining;
    }
    return out;
};

const update = (patch: ProgressPatch): void => {
    progress.value = applyPatch(progress.value, patch);
    queue.value = mergePatches(queue.value, patch);
    writeStored();
    if (serverAvailable.value || !loaded.value) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => void flushAcademyProgress(), FLUSH_DELAY_MS);
    } else {
        // The server was unreachable at load: try again opportunistically.
        void loadAcademyProgress(true);
    }
};

if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
        if (!isEmptyPatch(queue.value)) void loadAcademyProgress(true);
    });
}

const parseTime = (value: string | undefined): number => {
    const parsed = value ? Date.parse(value) : 0;
    return Number.isNaN(parsed) ? 0 : parsed;
};

const majorOf = (version: string): number => Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;

export type BadgeState = "none" | "valid" | "expiring" | "expired" | "recertify";

export const badgeStateOf = (badge: AcademyBadge | undefined, recertifyFrom: string, now = Date.now()): BadgeState => {
    if (!badge) return "none";
    if (parseTime(badge.expiresAt) <= now) return "expired";
    if (majorOf(recertifyFrom) > majorOf(badge.v)) return "recertify";
    if (parseTime(badge.expiresAt) - now < 30 * 24 * 60 * 60 * 1000) return "expiring";
    return "valid";
};

export const useAcademyProgress = () => {
    const badgeFor = (track: TrackId): AcademyBadge | undefined =>
        [...progress.value.badges].filter((badge) => badge.track === track).sort((a, b) => parseTime(b.earnedAt) - parseTime(a.earnedAt))[0];

    return {
        progress,
        loaded,
        loading,
        saving,
        unsaved,
        serverAvailable,
        load: loadAcademyProgress,
        flush: flushAcademyProgress,
        update,
        badgeFor,
        badgeState: (track: TrackId, recertifyFrom: string) => badgeStateOf(badgeFor(track), recertifyFrom),
        lessonDone: (lessonId: string) => Boolean(progress.value.lessons[lessonId]),
        labBest: (labId: string) => progress.value.labs[labId],
        labPassed: (labId: string) => Boolean(progress.value.labs[labId]?.passedAt),
        guideRead: (articleId: string) => isGuideReadEntry(progress.value.guideRead[articleId]),
        setActiveTrack: (track: TrackId) => update({ activeTrack: track }),
        setGuideRead: (articleId: string, version: string, read: boolean) =>
            update({ guideRead: { [articleId]: { v: read ? version : "", at: new Date().toISOString() } } }),
        completeLesson: (lessonId: string, version: string, checkScore: 0 | 1 | 2) =>
            update({ lessons: { [lessonId]: { at: new Date().toISOString(), v: version, checkScore } } }),
        recordLab: (labId: string, version: string, result: { score: number; passed: boolean; criticalErrors: number }) => {
            const previous = progress.value.labs[labId];
            const now = new Date().toISOString();
            update({
                labs: {
                    [labId]: {
                        bestScore: Math.max(result.score, previous?.bestScore ?? 0),
                        attempts: (previous?.attempts ?? 0) + 1,
                        criticalErrors:
                            result.passed && (!previous?.passedAt || result.score >= previous.bestScore)
                                ? result.criticalErrors
                                : (previous?.criticalErrors ?? result.criticalErrors),
                        v: version,
                        ...(result.passed ? { passedAt: previous?.passedAt ?? now } : previous?.passedAt ? { passedAt: previous.passedAt } : {}),
                    },
                },
            });
        },
        /** Replace the local copy with a server-authoritative record (after exam start/submit). */
        adopt: (next: AcademyProgress) => {
            progress.value = isEmptyPatch(queue.value) ? next : applyPatch(next, queue.value);
            writeStored();
        },
    };
};

export type AcademyProgressApi = ReturnType<typeof useAcademyProgress>;
