import { describe, expect, test } from "bun:test";
import { MERCHANT_OPERATIONS_CHAPTERS } from "../guide/merchantOperationsGuide";
import { MERCHANT_DEVELOPER_CHAPTERS } from "../guide/merchantDeveloperApiGuide";

describe("merchant operations guide content completeness", () => {
    test("all 10 operations chapters exist and are substantive", () => {
        expect(MERCHANT_OPERATIONS_CHAPTERS.length).toBe(10);
        expect(MERCHANT_OPERATIONS_CHAPTERS.map((chapter) => chapter.id)).toEqual([
            "M-01",
            "M-02",
            "M-03",
            "M-04",
            "M-05",
            "M-06",
            "M-07",
            "M-08",
            "M-09",
            "M-10",
        ]);
        for (const chapter of MERCHANT_OPERATIONS_CHAPTERS) {
            expect(chapter.titleEn.trim().length, `${chapter.id} title`).toBeGreaterThan(10);
            expect(chapter.bodyEn.trim().length, `${chapter.id} body`).toBeGreaterThan(400);
            expect(chapter.tags.length, `${chapter.id} tags`).toBeGreaterThan(1);
            expect(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER", "DEVELOPER", "ALL"]).toContain(chapter.role);
        }
        const allText = MERCHANT_OPERATIONS_CHAPTERS.map((chapter) => chapter.bodyEn).join("\n");
        for (const phrase of ["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT", "negative_balance_ceiling", "evidence_due_at", "MERCHANT_DIRECT"]) {
            expect(allText, phrase).toContain(phrase);
        }
    });
});

describe("merchant developer guide content completeness", () => {
    test("all 5 developer chapters exist and D-05 contains all four code templates", () => {
        expect(MERCHANT_DEVELOPER_CHAPTERS.length).toBe(5);
        expect(MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => chapter.id)).toEqual(["D-01", "D-02", "D-03", "D-04", "D-05"]);
        for (const chapter of MERCHANT_DEVELOPER_CHAPTERS) {
            expect(chapter.titleEn.trim().length, `${chapter.id} title`).toBeGreaterThan(10);
            expect(chapter.bodyEn.trim().length, `${chapter.id} body`).toBeGreaterThan(400);
        }
        const d05 = MERCHANT_DEVELOPER_CHAPTERS.find((chapter) => chapter.id === "D-05");
        expect(d05).toBeDefined();
        for (const language of ["typescript", "php", "python", "curl"] as const) {
            expect(d05?.codeTemplates?.[language], language).toBeTruthy();
            expect((d05?.codeTemplates?.[language] ?? "").length, `${language} length`).toBeGreaterThan(150);
        }
        const allText = MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => chapter.bodyEn).join("\n");
        for (const phrase of ["pg_live_", "maxUses", "IP_NOT_ALLOWLISTED", "/api/v1/external/links", "point of no return"]) {
            expect(allText.toLowerCase(), phrase).toContain(phrase.toLowerCase());
        }
    });
});
