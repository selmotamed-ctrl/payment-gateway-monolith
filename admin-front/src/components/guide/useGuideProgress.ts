import { computed, ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";

const LOCAL_STORAGE_KEY = "pg.guide.read";

export interface GuideReadEntry {
    v: string;
    at: string;
}

export interface GuideReadState {
    [articleId: string]: GuideReadEntry;
}

type ProgressRecord = Record<string, unknown>;

const readLocal = (): GuideReadState => {
    try {
        const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const result: GuideReadState = {};
        for (const [articleId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== "object" || Array.isArray(value)) continue;
            const entry = value as Record<string, unknown>;
            if (typeof articleId !== "string" || typeof entry.v !== "string") continue;
            result[articleId] = {
                v: entry.v,
                at: typeof entry.at === "string" ? entry.at : new Date(0).toISOString(),
            };
        }
        return result;
    } catch {
        return {};
    }
};

const writeLocal = (read: GuideReadState): void => {
    try {
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(read));
    } catch {
        // localStorage may be unavailable or full; server persistence still works.
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizedRead = (value: unknown): GuideReadState => {
    if (!isRecord(value)) return {};
    const result: GuideReadState = {};
    for (const [articleId, entry] of Object.entries(value)) {
        if (!isRecord(entry) || typeof entry.v !== "string") continue;
        result[articleId] = {
            v: entry.v,
            at: typeof entry.at === "string" ? entry.at : new Date(0).toISOString(),
        };
    }
    return result;
};

const mergeProgress = (raw: ProgressRecord, read: GuideReadState): ProgressRecord => {
    const merged: ProgressRecord = {};
    const passthroughKeys = [
        "completedModules",
        "completedLabs",
        "badges",
        "completedLessonIds",
        "completedLabIds",
        "earnedBadges",
        "quizScores",
        "lastModuleId",
    ];
    for (const key of passthroughKeys) {
        if (raw[key] !== undefined) {
            merged[key] = raw[key];
        }
    }
    merged.guideRead = read;
    return merged;
};

const guideReadState = ref<GuideReadState>(readLocal());
const loaded = ref(false);
const loading = ref(false);
const saving = ref(false);
const serverAvailable = ref(false);
let rawProgress: ProgressRecord = {};
let loadPromise: Promise<void> | null = null;

const loadGuideProgress = async (): Promise<void> => {
    if (loaded.value) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        loading.value = true;
        try {
            const response = await api.get(urlsMap.academyProgress);
            const payload = response.data?.data ?? response.data ?? {};
            const progress = isRecord(payload.progress) ? payload.progress : payload;
            if (isRecord(progress)) {
                rawProgress = progress;
                const serverRead = normalizedRead(progress.guideRead);
                guideReadState.value =
                    Object.keys(serverRead).length > 0 ? serverRead : readLocal();
                writeLocal(guideReadState.value);
                serverAvailable.value = true;
            }
        } catch {
            serverAvailable.value = false;
            guideReadState.value = readLocal();
        } finally {
            loaded.value = true;
            loading.value = false;
            loadPromise = null;
        }
    })();
    return loadPromise;
};

const persistGuideRead = async (): Promise<boolean> => {
    writeLocal(guideReadState.value);
    if (!serverAvailable.value) return false;
    saving.value = true;
    try {
        await api.put(urlsMap.academyProgress, {
            progress: mergeProgress(rawProgress, guideReadState.value),
        });
        rawProgress = mergeProgress(rawProgress, guideReadState.value);
        return true;
    } catch {
        return false;
    } finally {
        saving.value = false;
    }
};

const setGuideRead = async (articleId: string, version: string, read: boolean): Promise<boolean> => {
    await loadGuideProgress();
    const next = { ...guideReadState.value };
    if (read) {
        next[articleId] = { v: version, at: new Date().toISOString() };
    } else {
        delete next[articleId];
    }
    guideReadState.value = next;
    return persistGuideRead();
};

export const useGuideProgress = () => {
    const readIds = computed(() => new Set(Object.keys(guideReadState.value)));
    const lastRead = computed(() => {
        const entries = Object.entries(guideReadState.value).sort(
            ([, left], [, right]) => Date.parse(right.at) - Date.parse(left.at),
        );
        return entries[0]?.[0] ?? "";
    });
    const lastReadEntry = computed(() => {
        const articleId = lastRead.value;
        return articleId ? guideReadState.value[articleId] : undefined;
    });

    return {
        read: guideReadState,
        readIds,
        loaded,
        loading,
        saving,
        serverAvailable,
        lastRead,
        lastReadEntry,
        loadGuideProgress,
        setGuideRead,
        isRead: (articleId: string) => Boolean(guideReadState.value[articleId]),
        readCount: (articleIds: string[]) =>
            articleIds.filter((articleId) => Boolean(guideReadState.value[articleId])).length,
        isCurrentVersion: (articleId: string, version: string) =>
            guideReadState.value[articleId]?.v === version,
    };
};

export type GuideProgressApi = ReturnType<typeof useGuideProgress>;
