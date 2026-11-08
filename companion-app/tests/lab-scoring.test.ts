import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { computeLabResult, scoreTask, type TaskAnswer } from "@/features/academy/labScoring";
import type { LabTask } from "@/content/types";

const vectorsPath = fileURLToPath(
    new URL("../../admin-front/src/content/academy/generated/lab-vectors.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
    vectors: Array<{
        id: string;
        name: string;
        task?: LabTask;
        answer?: TaskAnswer;
        expectedScore?: string;
        criticalError?: boolean;
        labTasks?: { points: number | string; score: number | string }[];
        criticalErrors?: number;
        expectedLabScore?: number;
        expectedPassed?: boolean;
    }>;
};

describe("academy lab scoring", () => {
    test("passes every per-task published vector", () => {
        for (const vector of vectors.vectors.filter((entry) => entry.task)) {
            const result = scoreTask(vector.task!, vector.answer);
            expect(result.score, `${vector.id} ${vector.name}`).toBe(Number(vector.expectedScore));
            expect(result.criticalError, `${vector.id} ${vector.name}`).toBe(Boolean(vector.criticalError));
        }
    });

    test("passes every lab-level published vector", () => {
        for (const vector of vectors.vectors.filter((entry) => entry.labTasks)) {
            const result = computeLabResult(
                vector.labTasks!.map((task) => ({ points: task.points, score: task.score })),
                vector.criticalErrors ?? 0,
                80,
            );
            expect(result.score, vector.id).toBe(vector.expectedLabScore);
            expect(result.passed, vector.id).toBe(vector.expectedPassed);
        }
    });
});
