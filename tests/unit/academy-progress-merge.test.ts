import { describe, expect, test } from "vitest";
import {
    applyPatch,
    emptyProgress,
    isEmptyPatch,
    isGuideReadEntry,
    mergeGuideRead,
    mergeLabs,
    mergeLessons,
    mergePatches,
    mergeProgress,
} from "@/components/academy/progressMerge";
import type { AcademyProgress } from "@/content/academy/apiTypes";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const T3 = "2026-01-03T00:00:00.000Z";

describe("guideRead merge", () => {
    test("later at wins, ties take the right side, keys never deleted", () => {
        const merged = mergeGuideRead(
            { a: { v: "1.0", at: T2 }, b: { v: "1.0", at: T1 } },
            { a: { v: "1.1", at: T1 }, b: { v: "1.1", at: T2 }, c: { v: "1.0", at: T1 } },
        );
        expect(merged.a.v).toBe("1.0");
        expect(merged.b.v).toBe("1.1");
        expect(merged.c.v).toBe("1.0");
        expect(mergeGuideRead({ a: { v: "x", at: T1 } }, { a: { v: "y", at: T1 } }).a.v).toBe("y");
    });

    test("tombstone (v === '') marks unread and a later read overrides it", () => {
        const unread = mergeGuideRead({ a: { v: "1.0", at: T1 } }, { a: { v: "", at: T2 } });
        expect(unread.a.v).toBe("");
        expect(isGuideReadEntry(unread.a)).toBe(false);
        const reread = mergeGuideRead(unread, { a: { v: "1.0", at: T3 } });
        expect(isGuideReadEntry(reread.a)).toBe(true);
        // an older read cannot resurrect a newer tombstone
        expect(mergeGuideRead({ a: { v: "", at: T2 } }, { a: { v: "1.0", at: T1 } }).a.v).toBe("");
        expect(isGuideReadEntry(undefined)).toBe(false);
    });
});

describe("lessons merge", () => {
    test("later at wins; tie goes to higher checkScore", () => {
        const a = { l1: { at: T1, v: "1", checkScore: 2 as const }, l2: { at: T1, v: "1", checkScore: 1 as const } };
        const b = { l1: { at: T2, v: "1", checkScore: 0 as const }, l2: { at: T1, v: "1", checkScore: 2 as const }, l3: { at: T1, v: "1", checkScore: 0 as const } };
        const merged = mergeLessons(a, b);
        expect(merged.l1.checkScore).toBe(0);
        expect(merged.l2.checkScore).toBe(2);
        expect(merged.l3).toBeDefined();
        expect(mergeLessons({ l: { at: T1, v: "1", checkScore: 2 } }, { l: { at: T1, v: "1", checkScore: 1 } }).l.checkScore).toBe(2);
    });
});

describe("labs merge", () => {
    test("bestScore/attempts max, passedAt earliest, criticalErrors and v from the best entry", () => {
        const a = { lab: { bestScore: 90, attempts: 2, passedAt: T2, criticalErrors: 0, v: "1.0" } };
        const b = { lab: { bestScore: 60, attempts: 5, passedAt: T1, criticalErrors: 1, v: "1.1" } };
        expect(mergeLabs(a, b).lab).toEqual({ bestScore: 90, attempts: 5, passedAt: T1, criticalErrors: 0, v: "1.0" });
        expect(mergeLabs(b, a).lab).toEqual({ bestScore: 90, attempts: 5, passedAt: T1, criticalErrors: 0, v: "1.0" });
    });

    test("tie on bestScore takes fewer critical errors; no passedAt stays absent", () => {
        const a = { lab: { bestScore: 70, attempts: 1, criticalErrors: 2, v: "a" } };
        const b = { lab: { bestScore: 70, attempts: 1, criticalErrors: 1, v: "b" } };
        const merged = mergeLabs(a, b).lab;
        expect(merged.v).toBe("b");
        expect(merged.criticalErrors).toBe(1);
        expect("passedAt" in merged).toBe(false);
        expect(mergeLabs({ x: { bestScore: 1, attempts: 1, criticalErrors: 0, v: "1" } }, { y: { bestScore: 2, attempts: 1, criticalErrors: 0, v: "1" } })).toHaveProperty("y");
    });
});

describe("patches", () => {
    test("mergePatches combines parts, last activeTrack wins, omits empty parts", () => {
        const merged = mergePatches(
            { activeTrack: "FOUNDATION", lessons: { l1: { at: T1, v: "1", checkScore: 1 } } },
            { activeTrack: "OPERATOR", guideRead: { a: { v: "1", at: T1 } } },
        );
        expect(merged.activeTrack).toBe("OPERATOR");
        expect(Object.keys(merged.lessons ?? {})).toEqual(["l1"]);
        expect(Object.keys(merged.guideRead ?? {})).toEqual(["a"]);
        expect(merged.labs).toBeUndefined();
        expect(mergePatches({ activeTrack: "MLRO" }, {}).activeTrack).toBe("MLRO");
    });

    test("isEmptyPatch", () => {
        expect(isEmptyPatch({})).toBe(true);
        expect(isEmptyPatch({ lessons: {}, labs: {}, guideRead: {} })).toBe(true);
        expect(isEmptyPatch({ activeTrack: "FOUNDATION" })).toBe(false);
        expect(isEmptyPatch({ guideRead: { a: { v: "", at: T1 } } })).toBe(false);
    });

    test("applyPatch merges client parts and never mutates the input or server-owned parts", () => {
        const base: AcademyProgress = { ...emptyProgress(T1), rev: 7, contentVersion: "1.0.0" };
        const frozen = JSON.stringify(base);
        const next = applyPatch(base, {
            activeTrack: "FINANCE",
            lessons: { l1: { at: T2, v: "1", checkScore: 2 } },
        });
        expect(JSON.stringify(base)).toBe(frozen);
        expect(next.activeTrack).toBe("FINANCE");
        expect(next.lessons.l1.checkScore).toBe(2);
        expect(next.rev).toBe(7);
        expect(next.contentVersion).toBe("1.0.0");
        expect(applyPatch(next, {}).activeTrack).toBe("FINANCE");
    });
});

describe("mergeProgress", () => {
    test("server-owned parts come from remote; client parts are merged", () => {
        const local: AcademyProgress = {
            ...emptyProgress(T1),
            rev: 1,
            activeTrack: "OPERATOR",
            contentVersion: "0.9",
            guideRead: { a: { v: "1", at: T2 } },
            lessons: { l1: { at: T2, v: "1", checkScore: 2 } },
            labs: { lab: { bestScore: 50, attempts: 1, criticalErrors: 0, v: "1" } },
            exams: {},
            badges: [],
        };
        const remote: AcademyProgress = {
            ...emptyProgress(T1),
            rev: 9,
            contentVersion: "1.0.0",
            guideRead: { a: { v: "", at: T3 }, b: { v: "1", at: T1 } },
            lessons: { l1: { at: T1, v: "1", checkScore: 0 }, l2: { at: T1, v: "1", checkScore: 1 } },
            labs: { lab: { bestScore: 80, attempts: 3, passedAt: T1, criticalErrors: 0, v: "1" } },
            exams: { "exam-foundation": { attempts: [], passedAt: T1 } } as unknown as AcademyProgress["exams"],
            badges: [{ id: "bd", track: "FOUNDATION", earnedAt: T1, expiresAt: T3, v: "1.0.0" }],
        };
        const merged = mergeProgress(local, remote);
        expect(merged.rev).toBe(9);
        expect(merged.contentVersion).toBe("1.0.0");
        expect(merged.exams).toBe(remote.exams);
        expect(merged.badges).toBe(remote.badges);
        expect(merged.activeTrack).toBe("OPERATOR");
        expect(merged.guideRead.a.v).toBe("");
        expect(merged.guideRead.b.v).toBe("1");
        expect(merged.lessons.l1.checkScore).toBe(2);
        expect(merged.lessons.l2).toBeDefined();
        expect(merged.labs.lab.bestScore).toBe(80);
        expect(merged.labs.lab.passedAt).toBe(T1);
        expect(mergeProgress({ ...local, activeTrack: undefined }, { ...remote, activeTrack: "MLRO" }).activeTrack).toBe("MLRO");
    });
});
