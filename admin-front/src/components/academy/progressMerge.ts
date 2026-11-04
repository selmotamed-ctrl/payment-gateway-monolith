/**
 * Pure merge rules for the Academy progress record (spec II-5).
 *
 * The browser owns only `guideRead`, `lessons`, `labs` and `activeTrack`; `exams`, `badges`,
 * `rev` and `contentVersion` are server-owned and always taken from the server copy.
 * Keys are never deleted. A `guideRead` entry with `v === ""` is a tombstone ("marked unread
 * at `at`") so un-reading merges by timestamp like everything else.
 */
import type { AcademyProgress, ProgressPatch } from "@/content/academy/apiTypes";

type Lessons = AcademyProgress["lessons"];
type Labs = AcademyProgress["labs"];
type GuideRead = AcademyProgress["guideRead"];

const time = (iso: string | undefined): number => {
    const value = iso ? Date.parse(iso) : 0;
    return Number.isNaN(value) ? 0 : value;
};

export const isGuideReadEntry = (entry: { v: string } | undefined): boolean => Boolean(entry && entry.v !== "");

export const emptyProgress = (now = new Date().toISOString()): AcademyProgress => ({
    schema: 1,
    rev: 0,
    startedAt: now,
    updatedAt: now,
    contentVersion: "",
    guideRead: {},
    lessons: {},
    labs: {},
    exams: {},
    badges: [],
});

export const mergeGuideRead = (a: GuideRead = {}, b: GuideRead = {}): GuideRead => {
    const out: GuideRead = { ...a };
    for (const [id, entry] of Object.entries(b)) {
        const current = out[id];
        if (!current || time(entry.at) >= time(current.at)) out[id] = entry;
    }
    return out;
};

export const mergeLessons = (a: Lessons = {}, b: Lessons = {}): Lessons => {
    const out: Lessons = { ...a };
    for (const [id, entry] of Object.entries(b)) {
        const current = out[id];
        if (!current) {
            out[id] = entry;
            continue;
        }
        const later = time(entry.at) > time(current.at) || (time(entry.at) === time(current.at) && entry.checkScore > current.checkScore);
        out[id] = later ? entry : current;
    }
    return out;
};

export const mergeLabs = (a: Labs = {}, b: Labs = {}): Labs => {
    const out: Labs = { ...a };
    for (const [id, entry] of Object.entries(b)) {
        const current = out[id];
        if (!current) {
            out[id] = entry;
            continue;
        }
        // The best attempt supplies score, criticalErrors and version; attempts take the maximum
        // and `passedAt` is the earliest pass.
        const bestIsNew = entry.bestScore > current.bestScore || (entry.bestScore === current.bestScore && entry.criticalErrors < current.criticalErrors);
        const best = bestIsNew ? entry : current;
        const passes = [current.passedAt, entry.passedAt].filter((value): value is string => Boolean(value));
        const passedAt = passes.sort((x, y) => time(x) - time(y))[0];
        out[id] = {
            bestScore: Math.max(entry.bestScore, current.bestScore),
            attempts: Math.max(entry.attempts, current.attempts),
            criticalErrors: best.criticalErrors,
            v: best.v,
            ...(passedAt ? { passedAt } : {}),
        };
    }
    return out;
};

export const mergePatches = (a: ProgressPatch, b: ProgressPatch): ProgressPatch => ({
    ...(b.activeTrack ?? a.activeTrack ? { activeTrack: b.activeTrack ?? a.activeTrack } : {}),
    ...(a.guideRead || b.guideRead ? { guideRead: mergeGuideRead(a.guideRead, b.guideRead) } : {}),
    ...(a.lessons || b.lessons ? { lessons: mergeLessons(a.lessons, b.lessons) } : {}),
    ...(a.labs || b.labs ? { labs: mergeLabs(a.labs, b.labs) } : {}),
});

export const isEmptyPatch = (patch: ProgressPatch): boolean =>
    !patch.activeTrack &&
    Object.keys(patch.guideRead ?? {}).length === 0 &&
    Object.keys(patch.lessons ?? {}).length === 0 &&
    Object.keys(patch.labs ?? {}).length === 0;

/** Apply a client patch to a record (used locally for optimistic updates). */
export const applyPatch = (progress: AcademyProgress, patch: ProgressPatch): AcademyProgress => ({
    ...progress,
    ...(patch.activeTrack ? { activeTrack: patch.activeTrack } : {}),
    guideRead: mergeGuideRead(progress.guideRead, patch.guideRead),
    lessons: mergeLessons(progress.lessons, patch.lessons),
    labs: mergeLabs(progress.labs, patch.labs),
});

/**
 * Merge a local record with the server's after a `409`: server-owned parts come from the
 * server, client-owned parts are merged by the rules above.
 */
export const mergeProgress = (local: AcademyProgress, remote: AcademyProgress): AcademyProgress => ({
    ...remote,
    activeTrack: local.activeTrack ?? remote.activeTrack,
    guideRead: mergeGuideRead(remote.guideRead, local.guideRead),
    lessons: mergeLessons(remote.lessons, local.lessons),
    labs: mergeLabs(remote.labs, local.labs),
});
