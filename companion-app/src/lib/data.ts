import { computed, shallowRef } from "vue";
import { Preferences } from "@capacitor/preferences";
import type { LabScore } from "@/features/academy/labScoring";
import type { Role, TrackId } from "@/content/types";

export const DATA_KEY = "pg.companion.data.v1";
export const DATA_SCHEMA = 1;

export type ThemeChoice = "system" | "light" | "dark" | "sepia";
export type LanguageChoice = "en" | "ar";
export type SettingsPatch = Omit<Partial<Settings>, "reminders"> & { reminders?: Partial<ReminderSettings> };
export type BookmarkKind = "article" | "lesson" | "term" | "card";
export type HighlightColor = "yellow" | "green" | "blue" | "rose";

export interface ReminderSettings {
    enabled: boolean;
    time: string;
    quietStart: string;
    quietEnd: string;
}

export interface Settings {
    theme: ThemeChoice;
    fontScale: number;
    serif: boolean;
    language: LanguageChoice;
    reminders: ReminderSettings;
    lastReminderSync?: string;
}

export interface Bookmark {
    id: string;
    kind: BookmarkKind;
    targetId: string;
    title: string;
    headingId?: string;
    label?: string;
    at: string;
}

export interface Highlight {
    id: string;
    kind: "article" | "lesson";
    targetId: string;
    title: string;
    headingId?: string;
    text: string;
    note?: string;
    color: HighlightColor;
    at: string;
}

export interface ReadingPosition {
    percent: number;
    headingId?: string;
    at: string;
}

export interface LastRead {
    kind: "article" | "lesson";
    targetId: string;
    title: string;
    route: string;
    at: string;
}

export interface GuideReadEntry {
    v: string;
    at: string;
}

export interface LessonProgress {
    at: string;
    v: string;
    checkScore: number;
}

export interface LabProgress {
    bestScore: number;
    attempts: number;
    passedAt?: string;
    criticalErrors: number;
    v: string;
}

export interface CompanionData {
    schema: typeof DATA_SCHEMA;
    role: Role | "";
    activeTrack: TrackId;
    guideRead: Record<string, GuideReadEntry>;
    lessons: Record<string, LessonProgress>;
    labs: Record<string, LabProgress>;
    bookmarks: Bookmark[];
    highlights: Highlight[];
    positions: Record<string, ReadingPosition>;
    readingDays: string[];
    lastRead?: LastRead;
    settings: Settings;
}

export const defaultSettings = (): Settings => ({
    theme: "system",
    fontScale: 1,
    serif: false,
    language: "en",
    reminders: {
        enabled: false,
        time: "20:00",
        quietStart: "22:00",
        quietEnd: "07:00",
    },
});

export const defaultData = (): CompanionData => ({
    schema: DATA_SCHEMA,
    role: "",
    activeTrack: "FOUNDATION",
    guideRead: {},
    lessons: {},
    labs: {},
    bookmarks: [],
    highlights: [],
    positions: {},
    readingDays: [],
    settings: defaultSettings(),
});

const clone = <T>(value: T): T =>
    typeof structuredClone === "function" ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);

const dataRef = shallowRef<CompanionData>(defaultData());
const loadedRef = shallowRef(false);
const savingRef = shallowRef(false);
let loadPromise: Promise<CompanionData> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const isDateKey = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const normalizeData = (raw: unknown): CompanionData => {
    const value = raw as Partial<CompanionData> | null;
    if (!value || typeof value !== "object" || value.schema !== DATA_SCHEMA) return defaultData();
    const base = defaultData();
    return {
        ...base,
        ...value,
        schema: DATA_SCHEMA,
        guideRead: value.guideRead && typeof value.guideRead === "object" ? value.guideRead : {},
        lessons: value.lessons && typeof value.lessons === "object" ? value.lessons : {},
        labs: value.labs && typeof value.labs === "object" ? value.labs : {},
        bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks : [],
        highlights: Array.isArray(value.highlights) ? value.highlights : [],
        positions: value.positions && typeof value.positions === "object" ? value.positions : {},
        readingDays: Array.isArray(value.readingDays)
            ? [...new Set(value.readingDays.filter(isDateKey))].sort()
            : [],
        settings: {
            ...base.settings,
            ...(value.settings ?? {}),
            reminders: {
                ...base.settings.reminders,
                ...(value.settings?.reminders ?? {}),
            },
        },
    };
};

const saveNow = async (): Promise<void> => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    savingRef.value = true;
    try {
        await Preferences.set({ key: DATA_KEY, value: JSON.stringify(dataRef.value) });
    } finally {
        savingRef.value = false;
    }
};

const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        void saveNow();
    }, 150);
};

const mutate = (mutator: (draft: CompanionData) => void): void => {
    const draft = clone(dataRef.value);
    mutator(draft);
    dataRef.value = draft;
    scheduleSave();
};

export const loadCompanionData = async (): Promise<CompanionData> => {
    if (loadedRef.value) return dataRef.value;
    if (!loadPromise) {
        loadPromise = (async () => {
            const { value } = await Preferences.get({ key: DATA_KEY });
            if (value) {
                try {
                    dataRef.value = normalizeData(JSON.parse(value));
                } catch {
                    dataRef.value = defaultData();
                }
            }
            loadedRef.value = true;
            return dataRef.value;
        })();
    }
    return loadPromise;
};

export const useCompanionData = () => ({
    data: computed(() => dataRef.value),
    loaded: computed(() => loadedRef.value),
    saving: computed(() => savingRef.value),
    settings: computed(() => dataRef.value.settings),
    load: loadCompanionData,
    flush: saveNow,
});

export const todayKey = (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

export const dateKey = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

export const recordReadingDay = (): void => {
    const today = todayKey();
    mutate((draft) => {
        if (!draft.readingDays.includes(today)) {
            draft.readingDays.push(today);
            draft.readingDays = [...new Set(draft.readingDays)].sort().slice(-400);
        }
    });
};

export const recordGuideRead = (articleId: string, version: string, read = true): void => {
    recordReadingDay();
    mutate((draft) => {
        if (read) draft.guideRead[articleId] = { v: version, at: new Date().toISOString() };
        else draft.guideRead[articleId] = { v: "", at: new Date().toISOString() };
    });
};

export const isGuideRead = (articleId: string): boolean =>
    Boolean(dataRef.value.guideRead[articleId]?.v);

export const setReadingPosition = (targetKey: string, percent: number, headingId?: string): void => {
    mutate((draft) => {
        draft.positions[targetKey] = {
            percent: Math.max(0, Math.min(100, Math.round(percent))),
            ...(headingId ? { headingId } : {}),
            at: new Date().toISOString(),
        };
    });
};

export const recordLastRead = (
    kind: LastRead["kind"],
    targetId: string,
    title: string,
    route: string,
): void => {
    recordReadingDay();
    mutate((draft) => {
        draft.lastRead = { kind, targetId, title, route, at: new Date().toISOString() };
    });
};

export const readingPosition = (targetKey: string): ReadingPosition | undefined =>
    dataRef.value.positions[targetKey];

export const lastReadingTarget = (): { key: string; position: ReadingPosition } | null => {
    const entries = Object.entries(dataRef.value.positions).sort(
        ([, left], [, right]) => Date.parse(right.at) - Date.parse(left.at),
    );
    const first = entries[0];
    return first ? { key: first[0], position: first[1] } : null;
};

export const bookmarkId = (kind: BookmarkKind, targetId: string, headingId?: string): string =>
    `${kind}:${targetId}:${headingId ?? "top"}`;

export const toggleBookmark = (bookmark: Omit<Bookmark, "id" | "at">): boolean => {
    const id = bookmarkId(bookmark.kind, bookmark.targetId, bookmark.headingId);
    let added = false;
    mutate((draft) => {
        const index = draft.bookmarks.findIndex((entry) => entry.id === id);
        if (index >= 0) {
            draft.bookmarks.splice(index, 1);
        } else {
            draft.bookmarks.unshift({ ...bookmark, id, at: new Date().toISOString() });
            added = true;
        }
    });
    return added;
};

export const removeBookmark = (id: string): void => {
    mutate((draft) => {
        draft.bookmarks = draft.bookmarks.filter((entry) => entry.id !== id);
    });
};

export const isBookmarked = (kind: BookmarkKind, targetId: string, headingId?: string): boolean =>
    dataRef.value.bookmarks.some((entry) => entry.id === bookmarkId(kind, targetId, headingId));

export const addHighlight = (highlight: Omit<Highlight, "id" | "at">): void => {
    recordReadingDay();
    mutate((draft) => {
        const id = `h:${highlight.kind}:${highlight.targetId}:${Date.now().toString(36)}`;
        draft.highlights.unshift({ ...highlight, id, at: new Date().toISOString() });
    });
};

export const updateHighlight = (id: string, patch: Partial<Pick<Highlight, "note" | "color">>): void => {
    mutate((draft) => {
        const highlight = draft.highlights.find((entry) => entry.id === id);
        if (highlight) Object.assign(highlight, patch);
    });
};

export const removeHighlight = (id: string): void => {
    mutate((draft) => {
        draft.highlights = draft.highlights.filter((entry) => entry.id !== id);
    });
};

export const completeLesson = (lessonId: string, version: string, checkScore: number): void => {
    recordReadingDay();
    mutate((draft) => {
        draft.lessons[lessonId] = {
            at: new Date().toISOString(),
            v: version,
            checkScore: Math.max(0, Math.min(2, checkScore)),
        };
    });
};

export const lessonDone = (lessonId: string): boolean => Boolean(dataRef.value.lessons[lessonId]);

export const recordLab = (labId: string, version: string, result: LabScore): void => {
    recordReadingDay();
    mutate((draft) => {
        const previous = draft.labs[labId];
        const best = previous && previous.bestScore >= result.score ? previous : null;
        draft.labs[labId] = {
            bestScore: Math.max(previous?.bestScore ?? 0, result.score),
            attempts: (previous?.attempts ?? 0) + 1,
            passedAt: previous?.passedAt ?? (result.passed ? new Date().toISOString() : undefined),
            criticalErrors: best ? best.criticalErrors : result.criticalErrors,
            v: version,
        };
    });
};

export const labBest = (labId: string): LabProgress | undefined => dataRef.value.labs[labId];

export const setRole = (role: Role | ""): void => {
    mutate((draft) => {
        draft.role = role;
    });
};

export const setActiveTrack = (trackId: TrackId): void => {
    mutate((draft) => {
        draft.activeTrack = trackId;
    });
};

export const updateSettings = (patch: SettingsPatch): void => {
    mutate((draft) => {
        draft.settings = {
            ...draft.settings,
            ...patch,
            reminders: {
                ...draft.settings.reminders,
                ...(patch.reminders ?? {}),
            },
        };
    });
};

export const readingDaysThisWeek = (): string[] => {
    const now = new Date();
    const day = now.getDay();
    const offset = day === 0 ? 6 : day - 1;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const days: string[] = [];
    for (let index = 0; index < 7; index += 1) {
        const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
        days.push(dateKey(date));
    }
    return days;
};

export const readingDatesThisWeek = (): Set<string> =>
    new Set(readingDaysThisWeek().filter((day) => dataRef.value.readingDays.includes(day)));

export const exportData = (): string => JSON.stringify(dataRef.value, null, 2);

export const importData = async (raw: string): Promise<CompanionData> => {
    const parsed = normalizeData(JSON.parse(raw));
    dataRef.value = parsed;
    await saveNow();
    return parsed;
};

export const replaceDataForTests = (value: CompanionData): void => {
    dataRef.value = normalizeData(value);
    loadedRef.value = true;
    loadPromise = Promise.resolve(dataRef.value);
};

export const resetData = async (): Promise<void> => {
    await Preferences.remove({ key: DATA_KEY });
    dataRef.value = defaultData();
    await saveNow();
};
