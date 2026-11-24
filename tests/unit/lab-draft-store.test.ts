import { describe, expect, test } from "vitest";
import { clearLabDraft, labDraftKey, loadLabDraft, saveLabDraft, type LabDraftStorage } from "../../admin-front/src/components/academy/lab/labDraftStore";

const memoryStorage = (): LabDraftStorage => {
    const values = new Map<string, string>();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key),
    };
};

describe("academy lab draft storage", () => {
    test("round-trips a draft per user and lab", () => {
        const storage = memoryStorage();
        const key = labDraftKey("user-1", "lab-ledger");
        saveLabDraft(storage, key, {
            stage: "task",
            index: 2,
            draft: { t1: { selected: "a" } as never },
            submitted: {},
            checked: {},
            hintShown: { t1: true },
        });
        expect(loadLabDraft(storage, key)).toMatchObject({ stage: "task", index: 2, hintShown: { t1: true } });
        expect(loadLabDraft(storage, labDraftKey("user-2", "lab-ledger"))).toBeNull();
    });

    test("keeps the content fingerprint so stale drafts can be discarded", () => {
        const storage = memoryStorage();
        const key = labDraftKey("user-1", "lab-ledger");
        saveLabDraft(storage, key, { stage: "task", index: 0, draft: {}, submitted: {}, checked: {}, hintShown: {}, version: "t1|t2" });
        expect(loadLabDraft(storage, key)?.version).toBe("t1|t2");
    });

    test("corrupt or missing drafts are ignored", () => {
        const storage = memoryStorage();
        expect(loadLabDraft(storage, "missing")).toBeNull();
        storage.setItem("broken", "{not json");
        expect(loadLabDraft(storage, "broken")).toBeNull();
    });

    test("clear removes the saved draft", () => {
        const storage = memoryStorage();
        const key = labDraftKey("user-1", "lab-ledger");
        saveLabDraft(storage, key, { stage: "brief", index: 0, draft: {}, submitted: {}, checked: {}, hintShown: {} });
        clearLabDraft(storage, key);
        expect(loadLabDraft(storage, key)).toBeNull();
    });
});
