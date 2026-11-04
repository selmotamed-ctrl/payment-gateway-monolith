import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
    computeLabResult,
    scoreLab,
    scoreTask,
    type TaskAnswer,
} from "@/components/academy/labScoring";
import type { LabTask } from "@/content/academy";

const REPO_ROOT = resolve(process.cwd(), "..");
const vectors = (
    JSON.parse(readFileSync(join(REPO_ROOT, "admin-front/src/content/academy/generated/lab-vectors.json"), "utf8")) as {
        vectors: Array<{
            id: string;
            name: string;
            task?: Record<string, unknown>;
            answer?: Record<string, unknown>;
            expectedScore?: string;
            criticalError?: boolean;
            labTasks?: { points: number; score: string }[];
            criticalErrors?: number;
            expectedLabScore?: number;
            expectedPassed?: boolean;
        }>;
    }
).vectors;

const asTask = (raw: Record<string, unknown>): LabTask => ({ id: "t", title: "t", prompt: "", ...raw }) as unknown as LabTask;

describe("lab scoring vectors", () => {
    test("vectors are present", () => {
        expect(vectors.length).toBe(18);
    });
    for (const vector of vectors) {
        if (vector.task) {
            test(`${vector.id}: ${vector.name}`, () => {
                const result = scoreTask(asTask(vector.task!), vector.answer as unknown as TaskAnswer);
                expect(Number(result.score) === Number(vector.expectedScore!), `got ${result.score}, want ${vector.expectedScore}`).toBe(true);
                expect(result.criticalError).toBe(vector.criticalError);
            });
        } else {
            test(`${vector.id}: ${vector.name}`, () => {
                const out = computeLabResult(vector.labTasks!, vector.criticalErrors!);
                expect(out.score).toBe(vector.expectedLabScore);
                expect(out.passed).toBe(vector.expectedPassed);
            });
        }
    }
});

describe("lab scoring edge cases", () => {
    const choice = (points = 10): LabTask =>
        asTask({ kind: "choice", points, options: [{ id: "a", correct: true }, { id: "b", correct: false }] });

    test("hint penalty is 1 point and floors at zero", () => {
        expect(scoreTask(choice(), { selected: "a" }, { hintUsed: true }).score).toBe(9);
        expect(scoreTask(choice(), { selected: "a", hintUsed: true }).hintPenalty).toBe(1);
        expect(scoreTask(choice(), { selected: "b", hintUsed: true }).score).toBe(0);
        expect(scoreTask(choice(), undefined, { hintUsed: true }).score).toBe(0);
    });

    test("unanswered scores zero", () => {
        expect(scoreTask(choice(), undefined).score).toBe(0);
        expect(scoreTask(choice(), { selected: null }).score).toBe(0);
    });

    const ledger = asTask({
        kind: "ledger",
        points: 12,
        accounts: ["A", "B", "C", "D"],
        expected: [
            { account: "A", side: "DR", amount: "100.0000" },
            { account: "B", side: "CR", amount: "100.0000" },
        ],
    });

    test("ledger: extra non-zero cell costs one line; zero cells are free", () => {
        expect(scoreTask(ledger, { cells: { A: { DR: "100" }, B: { CR: "100.00" } } }).score).toBe(12);
        expect(scoreTask(ledger, { cells: { A: { DR: "100" }, B: { CR: "100" }, C: { DR: "5" } } }).score).toBe(6);
        expect(scoreTask(ledger, { cells: { A: { DR: "100" }, B: { CR: "100" }, C: { DR: "0" }, D: { CR: "0.00" } } }).score).toBe(12);
    });

    test("ledger: score never below zero; non-numeric input is wrong and counted as extra off-account", () => {
        const heavy = scoreTask(ledger, { cells: { A: { DR: "1" }, C: { DR: "5" }, D: { CR: "7" } } });
        expect(heavy.score).toBe(0);
        const text = scoreTask(ledger, { cells: { A: { DR: "abc" }, B: { CR: "1e2" } } });
        expect(text.score).toBe(0);
        const textExtra = scoreTask(ledger, { cells: { A: { DR: "100" }, B: { CR: "100" }, C: { DR: "abc" } } });
        expect(textExtra.score).toBe(6);
    });

    test("order: partial credit rounds DOWN to one decimal", () => {
        const order = asTask({ kind: "order", points: 10, correctOrder: ["a", "b", "c"] });
        // 1 of 3 right: 3.3333 -> 3.3 ; 2 of 3: 6.6667 -> 6.6
        expect(scoreTask(order, { order: ["a", "c", "b"] }).score).toBe(3.3);
        expect(scoreTask(order, { order: ["a", "b", "x"] }).score).toBe(6.6);
        expect(scoreTask(order, { order: ["a", "b", "c"] }).score).toBe(10);
        // BUG (reported): an answer with an extra trailing item should not earn full marks, but scoreOrder
        // only treats `exact` specially and otherwise rounds 3/3 positions to full points.
        expect(scoreTask(order, { order: ["a", "b", "c", "d"] }).score).toBeLessThan(10);
    });

    test("multi never below zero and caps at full points", () => {
        const multi = asTask({
            kind: "multi",
            points: 10,
            options: [
                { id: "a", correct: true },
                { id: "b", correct: true },
                { id: "c", correct: false },
                { id: "d", correct: false },
            ],
        });
        expect(scoreTask(multi, { selected: ["c", "d"] }).score).toBe(0);
        expect(scoreTask(multi, { selected: ["a", "b"] }).score).toBe(10);
        expect(scoreTask(multi, { selected: ["a", "b", "c"] }).score).toBe(5);
    });

    test("numeric tolerance and non-numeric input", () => {
        const num = asTask({ kind: "numeric", points: 5, answer: "10.00", tolerance: "0.05" });
        expect(scoreTask(num, { value: "10.05" }).score).toBe(5);
        expect(scoreTask(num, { value: "9.95" }).score).toBe(5);
        expect(scoreTask(num, { value: "10.06" }).score).toBe(0);
        expect(scoreTask(num, { value: "ten" }).score).toBe(0);
        expect(scoreTask(num, { value: "" }).score).toBe(0);
        expect(scoreTask(num, undefined).score).toBe(0);
    });

    test("checklist wrongly ticked critical item flags a critical error", () => {
        const checklist = asTask({
            kind: "checklist",
            points: 10,
            criticalWrong: ["x"],
            items: [{ id: "a", shouldTick: true }, { id: "x", shouldTick: false }],
        });
        expect(scoreTask(checklist, { ticked: ["a"] }).criticalError).toBe(false);
        expect(scoreTask(checklist, { ticked: ["a", "x"] }).criticalError).toBe(true);
    });

    test("scoreLab combines tasks, hints and critical errors", () => {
        const lab = {
            passPercent: 80,
            tasks: [{ ...(choice() as object), id: "t1" }, { ...(choice() as object), id: "t2" }] as LabTask[],
        };
        const pass = scoreLab(lab, { t1: { selected: "a" }, t2: { selected: "a" } });
        expect(pass).toMatchObject({ score: 100, passed: true, criticalErrors: 0, earned: 20, possible: 20 });
        const hinted = scoreLab(lab, { t1: { selected: "a" }, t2: { selected: "a" } }, ["t1", "t2"]);
        expect(hinted.score).toBe(90);
        const fail = scoreLab(lab, { t1: { selected: "a" }, t2: { selected: "b" } });
        expect(fail).toMatchObject({ score: 50, passed: false });
    });

    test("computeLabResult: exactly 80 passes, 79.5 rounds up, empty lab scores 0", () => {
        expect(computeLabResult([{ points: 10, score: 8 }], 0).passed).toBe(true);
        expect(computeLabResult([{ points: 200, score: 159 }], 0).score).toBe(80);
        expect(computeLabResult([{ points: 10, score: 7.9 }], 0).passed).toBe(false);
        expect(computeLabResult([], 0)).toMatchObject({ score: 0, passed: false });
    });
});
