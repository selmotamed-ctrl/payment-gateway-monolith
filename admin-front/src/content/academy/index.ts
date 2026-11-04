/**
 * Employee Academy content: typed, lazy loaders over the committed extractor output in
 * `./generated/` (see `scripts/extract-academy-content.ts`). Nothing here is hand-written
 * content; exam-pool questions are never in the browser (they live in `core-back`).
 */

export type TrackId =
    | "FOUNDATION"
    | "OPERATOR"
    | "SUPPORT"
    | "FINANCE"
    | "COMPLIANCE"
    | "MLRO"
    | "GATEWAY_ADMIN"
    | "SECURITY_ADMIN";

export const TRACK_ORDER: readonly TrackId[] = [
    "FOUNDATION",
    "OPERATOR",
    "SUPPORT",
    "FINANCE",
    "COMPLIANCE",
    "MLRO",
    "GATEWAY_ADMIN",
    "SECURITY_ADMIN",
];

export interface AcademyMeta {
    contentVersion: string;
    recertifyFrom: string;
    generatedAt: string;
    contentHash: string;
    counts: Record<string, number>;
}

export interface Track {
    id: TrackId;
    title: string;
    badge: string;
    hours: string;
    requires: TrackId[];
    description: string;
    moduleIds: string[];
    lessonIds: string[];
    labIds: string[];
    examId: string;
}

export interface Module {
    id: string;
    title: string;
    minutes: number;
    objective: string;
    lessonIds: string[];
    labIds: string[];
}

export interface Lesson {
    id: string;
    module: string;
    order: number;
    title: string;
    minutes: number;
    tracks: string[];
    reading: string[];
    /** Markdown source (rendered with the Guide's MarkdownView so links/callouts match the Guide). */
    body: string;
    html: string;
    plainText: string;
    checkIds: string[];
}

export type QType = "single" | "multi" | "order" | "number" | "truefalse";

/** `correct` is present only in practice content (lesson checks); never for exam questions. */
export interface QOption {
    id: string;
    text: string;
    correct?: boolean;
    note?: string;
}

export interface Question {
    id: string;
    module: string;
    type: QType;
    difficulty: 1 | 2 | 3;
    critical: boolean;
    lesson?: string;
    refs: string[];
    stem: string;
    options: QOption[];
    answer?: string;
    tolerance?: string;
    why?: string;
}

export interface ExamBlueprintPublic {
    id: string;
    track: TrackId;
    questionCount: number;
    passPercent: number;
    timeLimitMinutes: number;
    cooldownMinutes: number;
    composition: { module: string; count: number }[];
}

export type Panel = { title: string } & (
    | { rows: [string, string][] }
    | { table: { columns: string[]; rows: string[][] } }
    | { timeline: { t: string; text: string; flag?: "warn" | "ok" | "bad" }[] }
    | { text: string }
    | Record<string, never>
);

interface TaskBase {
    id: string;
    title: string;
    panels: Panel[];
    prompt: string;
    points: number;
    hint?: string;
    refs?: string[];
}
export interface ChoiceTask extends TaskBase {
    kind: "choice";
    options: { id: string; label: string; correct: boolean; critical?: boolean; feedback: string }[];
}
export interface MultiTask extends TaskBase {
    kind: "multi";
    options: { id: string; label: string; correct: boolean; feedback: string }[];
    criticalWrong?: string[];
}
export interface LedgerTask extends TaskBase {
    kind: "ledger";
    accounts: string[];
    expected: { account: string; side: "DR" | "CR"; amount: string }[];
    feedback: string;
}
export interface OrderTask extends TaskBase {
    kind: "order";
    items: { id: string; label: string }[];
    correctOrder: string[];
    feedback: string;
}
export interface ChecklistTask extends TaskBase {
    kind: "checklist";
    items: { id: string; label: string; shouldTick: boolean; why: string }[];
    criticalWrong?: string[];
}
export interface NumericTask extends TaskBase {
    kind: "numeric";
    answer: string;
    tolerance: string;
    unit?: string;
    feedback: string;
}
export type LabTask = ChoiceTask | MultiTask | LedgerTask | OrderTask | ChecklistTask | NumericTask;

export interface Lab {
    id: string;
    module: string;
    title: string;
    minutes: number;
    tracks: string[];
    refs: string[];
    briefing: string;
    passPercent: number;
    tasks: LabTask[];
}

export interface Drill {
    id: string;
    title: string;
    rail: string;
    minutes: number;
    refs: string[];
    markdown: string;
    html: string;
    plainText: string;
}

export interface AcademyPage {
    id: string;
    title: string;
    markdown: string;
    html: string;
    plainText: string;
}

const cache = new Map<string, Promise<unknown>>();
const once = <T,>(key: string, load: () => Promise<{ default: T }>): Promise<T> => {
    let hit = cache.get(key) as Promise<T> | undefined;
    if (!hit) {
        hit = load().then((module) => module.default);
        cache.set(key, hit);
    }
    return hit;
};

export const loadMeta = (): Promise<AcademyMeta> => once("meta", () => import("./generated/meta.json"));
export const loadTracks = (): Promise<Track[]> => once("tracks", () => import("./generated/tracks.json")) as Promise<Track[]>;
export const loadModules = (): Promise<Module[]> => once("modules", () => import("./generated/modules.json")) as Promise<Module[]>;
export const loadLessons = (): Promise<Lesson[]> => once("lessons", () => import("./generated/lessons.en.json")) as Promise<Lesson[]>;
export const loadChecks = (): Promise<Question[]> => once("checks", () => import("./generated/checks.en.json")) as Promise<Question[]>;
export const loadLabs = (): Promise<Lab[]> => once("labs", () => import("./generated/labs.en.json")) as unknown as Promise<Lab[]>;
export const loadDrills = (): Promise<Drill[]> => once("drills", () => import("./generated/drills.en.json")) as Promise<Drill[]>;
export const loadPages = (): Promise<AcademyPage[]> => once("pages", () => import("./generated/pages.en.json")) as Promise<AcademyPage[]>;
export const loadExamBlueprints = (): Promise<ExamBlueprintPublic[]> =>
    once("blueprints", () => import("./generated/exam-blueprints.public.json")) as Promise<ExamBlueprintPublic[]>;

/** Everything the catalogue pages need in one call (small: tracks + modules + meta + blueprints). */
export const loadCatalog = async () => {
    const [meta, tracks, modules, blueprints] = await Promise.all([loadMeta(), loadTracks(), loadModules(), loadExamBlueprints()]);
    return { meta, tracks, modules, blueprints };
};

export const findTrack = (tracks: Track[], id: string): Track | undefined => tracks.find((track) => track.id === id);

/** Role → its role track (the Foundation track applies to everyone). */
export const roleTrackFor = (role: string | undefined | null): TrackId | null => {
    const value = String(role ?? "");
    return (TRACK_ORDER as readonly string[]).includes(value) && value !== "FOUNDATION" ? (value as TrackId) : null;
};
