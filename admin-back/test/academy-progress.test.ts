import { describe, expect, test } from "bun:test";
import { academyProgressSchema } from "../api/protected/academy";

const zeroToHeroProgress = {
    progress: {
        completedLessonIds: ["M1-L1", "M1-L2", "M1-L3"],
        completedLabIds: {
            "LAB-01": {
                passed: true,
                attempts: 2,
                mistakesMade: ["LAB-01-S2:a"],
                completedAt: "2026-10-31T10:00:00.000Z",
            },
        },
        quizScores: {
            "QUIZ-M1": {
                scorePercent: 100,
                passed: true,
                completedAt: "2026-10-31T10:05:00.000Z",
                answers: { "0": 1, "1": 2, "2": 1, "3": 1, "4": 1, "5": 2, "6": 1, "7": 1 },
            },
        },
        earnedBadges: ["CERTIFIED_SUPPORT_SPECIALIST"],
        lastModuleId: "M1",
    },
};

describe("zero-to-hero academy progress schema", () => {
    test("accepts the completedLessonIds / completedLabIds / quizScores / earnedBadges shape", () => {
        const parsed = academyProgressSchema.parse(zeroToHeroProgress);
        expect(parsed.progress.completedLessonIds).toEqual(["M1-L1", "M1-L2", "M1-L3"]);
        expect(parsed.progress.completedLabIds?.["LAB-01"]?.passed).toBe(true);
        expect(parsed.progress.earnedBadges).toEqual(["CERTIFIED_SUPPORT_SPECIALIST"]);
        const quiz = parsed.progress.quizScores?.["QUIZ-M1"];
        expect(typeof quiz).toBe("object");
        if (quiz && typeof quiz === "object") {
            expect(quiz.scorePercent).toBe(100);
            expect(quiz.passed).toBe(true);
        }
    });

    test("still accepts the legacy numeric quizScores and completedModules shape", () => {
        const parsed = academyProgressSchema.parse({
            progress: {
                completedModules: ["1", "2"],
                completedLabs: ["1", "2"],
                quizScores: { "1": 100, "2": 90 },
                badges: ["CERTIFIED_OPERATOR"],
                lastModuleId: "2",
            },
        });
        expect(parsed.progress.completedModules).toEqual(["1", "2"]);
        expect(parsed.progress.quizScores?.["1"]).toBe(100);
    });

    test("rejects an unknown progress field", () => {
        expect(() =>
            academyProgressSchema.parse({ progress: { ...zeroToHeroProgress.progress, unexpectedField: true } }),
        ).toThrow();
    });
});
