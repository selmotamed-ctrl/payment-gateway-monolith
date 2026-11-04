/**
 * Guide read-tracking, backed by the shared Academy progress record (`useAcademyProgress`).
 * Public API unchanged. Entries with `v === ""` are "marked unread" tombstones, not read.
 */
import { computed } from "vue";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";

const LEGACY_KEY = "pg.guide.read";

export interface GuideReadEntry {
    v: string;
    at: string;
}

export interface GuideReadState {
    [articleId: string]: GuideReadEntry;
}

let migrated = false;

/** One-time: fold the legacy localStorage record into the new progress record, then drop it. */
const migrateLegacy = (academy: ReturnType<typeof useAcademyProgress>): void => {
    if (migrated) return;
    migrated = true;
    try {
        const raw = window.localStorage.getItem(LEGACY_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        const patch: GuideReadState = {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
                const entry = value as { v?: unknown; at?: unknown } | null;
                if (!entry || typeof entry.v !== "string" || entry.v === "") continue;
                const at = typeof entry.at === "string" ? entry.at : new Date(0).toISOString();
                const existing = academy.progress.value.guideRead[id];
                if (existing && Date.parse(existing.at) >= Date.parse(at)) continue;
                patch[id] = { v: entry.v.slice(0, 20), at };
            }
        }
        if (Object.keys(patch).length > 0) academy.update({ guideRead: patch });
        window.localStorage.removeItem(LEGACY_KEY);
    } catch {
        // ignore: legacy data is best-effort.
    }
};

export const useGuideProgress = () => {
    const academy = useAcademyProgress();

    const read = computed<GuideReadState>(() =>
        Object.fromEntries(Object.entries(academy.progress.value.guideRead).filter(([, entry]) => entry.v !== "")),
    );
    const readIds = computed(() => new Set(Object.keys(read.value)));
    const lastRead = computed(() => {
        const entries = Object.entries(read.value).sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at));
        return entries[0]?.[0] ?? "";
    });
    const lastReadEntry = computed(() => (lastRead.value ? read.value[lastRead.value] : undefined));

    const loadGuideProgress = async (): Promise<void> => {
        await academy.load();
        migrateLegacy(academy);
    };

    const setGuideRead = async (articleId: string, version: string, value: boolean): Promise<boolean> => {
        await loadGuideProgress();
        academy.setGuideRead(articleId, version, value);
        return academy.flush();
    };

    return {
        read,
        readIds,
        loaded: academy.loaded,
        loading: academy.loading,
        saving: academy.saving,
        serverAvailable: academy.serverAvailable,
        lastRead,
        lastReadEntry,
        loadGuideProgress,
        setGuideRead,
        isRead: (articleId: string) => Boolean(read.value[articleId]),
        readCount: (articleIds: string[]) => articleIds.filter((id) => Boolean(read.value[id])).length,
        isCurrentVersion: (articleId: string, version: string) => read.value[articleId]?.v === version,
    };
};

export type GuideProgressApi = ReturnType<typeof useGuideProgress>;
