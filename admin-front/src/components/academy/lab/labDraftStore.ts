import type { TaskAnswer, TaskScore } from "../labScoring";

export type LabDraftStage = "brief" | "task";

export interface LabDraftState {
    stage: LabDraftStage;
    index: number;
    draft: Record<string, TaskAnswer>;
    submitted: Record<string, TaskAnswer>;
    checked: Record<string, TaskScore>;
    hintShown: Record<string, boolean>;
    version?: string;
}

export interface LabDraftStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export const labDraftKey = (userId: string, labId: string): string =>
    `PAYMENT_GATEWAY:ACADEMY:LAB_DRAFT:${userId}:${labId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const loadLabDraft = (storage: LabDraftStorage, key: string): LabDraftState | null => {
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) return null;
        const stage = parsed.stage === "task" ? "task" : "brief";
        const index = typeof parsed.index === "number" && Number.isInteger(parsed.index) && parsed.index >= 0 ? parsed.index : 0;
        return {
            stage,
            index,
            draft: isRecord(parsed.draft) ? parsed.draft as Record<string, TaskAnswer> : {},
            submitted: isRecord(parsed.submitted) ? parsed.submitted as Record<string, TaskAnswer> : {},
            checked: isRecord(parsed.checked) ? parsed.checked as Record<string, TaskScore> : {},
            hintShown: isRecord(parsed.hintShown) ? parsed.hintShown as Record<string, boolean> : {},
            ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
        };
    } catch {
        return null;
    }
};

export const saveLabDraft = (storage: LabDraftStorage, key: string, state: LabDraftState): void => {
    try {
        storage.setItem(key, JSON.stringify(state));
    } catch {
        // A full or unavailable storage must never block the lab itself.
    }
};

export const clearLabDraft = (storage: LabDraftStorage, key: string): void => {
    try {
        storage.removeItem(key);
    } catch {
        // Ignore unavailable storage.
    }
};
