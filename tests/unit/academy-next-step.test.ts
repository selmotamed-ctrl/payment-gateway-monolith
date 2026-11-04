import { describe, expect, test } from "vitest";
import { emptyProgress } from "@/components/academy/progressMerge";
import { fallbackMissing, nextStep, pickActiveTrack, trackStats } from "@/components/academy/nextStep";
import type { Lab, Lesson, Module, Track } from "@/content/academy";
import type { AcademyProgress } from "@/content/academy/apiTypes";

const AT = "2026-01-01T00:00:00.000Z";
const track = {
    id: "OPERATOR",
    moduleIds: ["m1", "m2"],
    lessonIds: ["l1", "l2", "l3"],
    labIds: ["lab1", "lab2"],
    examId: "exam-operator",
} as unknown as Track;
const modules = [
    { id: "m1", lessonIds: ["l1", "l2"], labIds: ["lab1"] },
    { id: "m2", lessonIds: ["l3"], labIds: ["lab2"] },
] as unknown as Module[];
const lessons = [
    { id: "l1", title: "One" },
    { id: "l2", title: "Two" },
    { id: "l3", title: "Three" },
] as unknown as Lesson[];
const labs = [
    { id: "lab1", title: "Lab One" },
    { id: "lab2", title: "Lab Two" },
] as unknown as Lab[];

const lessonDone = { at: AT, v: "1", checkScore: 2 as const };
const labPassed = { bestScore: 90, attempts: 1, passedAt: AT, criticalErrors: 0, v: "1" };
const progress = (over: Partial<AcademyProgress> = {}): AcademyProgress => ({ ...emptyProgress(AT), ...over });
const step = (p: AcademyProgress, eligibility?: Parameters<typeof nextStep>[0]["eligibility"]) =>
    nextStep({ track, modules, lessons, labs, progress: p, eligibility });

describe("nextStep", () => {
    test("starts with the first lesson", () => {
        expect(step(progress())).toMatchObject({
            kind: "lesson",
            id: "l1",
            moduleId: "m1",
            route: { name: "AdminAcademyLesson", params: { lessonId: "l1" } },
        });
    });

    test("after the module's lessons come the module's labs, then the next module", () => {
        const lessonsOne = { l1: lessonDone, l2: lessonDone };
        expect(step(progress({ lessons: lessonsOne }))).toMatchObject({
            kind: "lab",
            id: "lab1",
            route: { name: "AdminAcademyLab", params: { labId: "lab1" } },
        });
        expect(step(progress({ lessons: lessonsOne, labs: { lab1: labPassed } }))).toMatchObject({ kind: "lesson", id: "l3", moduleId: "m2" });
    });

    test("a lab attempted but not passed is still the next step", () => {
        const p = progress({
            lessons: { l1: lessonDone, l2: lessonDone },
            labs: { lab1: { bestScore: 50, attempts: 2, criticalErrors: 0, v: "1" } },
        });
        expect(step(p).id).toBe("lab1");
    });

    const allDone = {
        lessons: { l1: lessonDone, l2: lessonDone, l3: lessonDone },
        labs: { lab1: labPassed, lab2: labPassed },
    };

    test("exam when everything else is done; unknown eligibility opens the exam", () => {
        expect(step(progress(allDone))).toMatchObject({
            kind: "exam",
            id: "exam-operator",
            locked: false,
            route: { name: "AdminAcademyExam", params: { examId: "exam-operator" } },
        });
    });

    test("locked exam routes to the track page", () => {
        const locked = step(progress(allDone), { eligible: false, missing: [] });
        expect(locked).toMatchObject({ kind: "exam", locked: true, route: { name: "AdminAcademyTrack", params: { trackId: "OPERATOR" } } });
        expect(step(progress(allDone), { eligible: true, missing: [] }).locked).toBe(false);
    });

    test("done state when the exam is passed", () => {
        const p = progress({ ...allDone, exams: { "exam-operator": { passedAt: AT } } as unknown as AcademyProgress["exams"] });
        expect(step(p)).toMatchObject({ kind: "done", id: "OPERATOR", route: { name: "AdminAcademyTrack", params: { trackId: "OPERATOR" } } });
    });
});

describe("trackStats", () => {
    test("counts done lessons, passed labs and exam", () => {
        expect(trackStats(track, progress())).toEqual({ lessonsDone: 0, lessonsTotal: 3, labsPassed: 0, labsTotal: 2, examPassed: false });
        const p = progress({
            lessons: { l1: lessonDone, other: lessonDone },
            labs: { lab1: labPassed, lab2: { bestScore: 10, attempts: 1, criticalErrors: 0, v: "1" } },
            exams: { "exam-operator": { passedAt: AT } } as unknown as AcademyProgress["exams"],
        });
        expect(trackStats(track, p)).toEqual({ lessonsDone: 1, lessonsTotal: 3, labsPassed: 1, labsTotal: 2, examPassed: true });
    });
});

describe("fallbackMissing", () => {
    test("lists unfinished lessons and labs with titles", () => {
        const missing = fallbackMissing(track, lessons, labs, progress({ lessons: { l1: lessonDone }, labs: { lab1: labPassed } }), {
            lesson: (t) => `Complete lesson ${t}`,
            lab: (t) => `Pass lab ${t}`,
        });
        expect(missing.map((m) => m.text)).toEqual(["Complete lesson Two", "Complete lesson Three", "Pass lab Lab Two"]);
    });
});

describe("pickActiveTrack", () => {
    test("explicit activeTrack wins", () => {
        expect(pickActiveTrack(progress({ activeTrack: "MLRO" }), "FINANCE", () => "none")).toBe("MLRO");
    });
    test("first required track whose badge is missing/expired", () => {
        const state = (s: Record<string, string>) => (id: string) => s[id] ?? "none";
        expect(pickActiveTrack(progress(), "FINANCE", state({}))).toBe("FOUNDATION");
        expect(pickActiveTrack(progress(), "FINANCE", state({ FOUNDATION: "valid" }))).toBe("FINANCE");
        expect(pickActiveTrack(progress(), "FINANCE", state({ FOUNDATION: "expired" }))).toBe("FOUNDATION");
        expect(pickActiveTrack(progress(), "FINANCE", state({ FOUNDATION: "valid", FINANCE: "recertify" }))).toBe("FINANCE");
    });
    test("everything valid falls back to the role track, or FOUNDATION without a role", () => {
        expect(pickActiveTrack(progress(), "FINANCE", () => "valid")).toBe("FINANCE");
        expect(pickActiveTrack(progress(), null, () => "valid")).toBe("FOUNDATION");
        expect(pickActiveTrack(progress(), null, () => "none")).toBe("FOUNDATION");
    });
});
