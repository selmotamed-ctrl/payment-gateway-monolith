import { describe, expect, test } from "bun:test";
import { BOOKS_PART_1 } from "../guide/booksPart1";
import { BOOKS_PART_2 } from "../guide/booksPart2";
import {
    ATTEMPT_STATUS_DEFINITIONS,
    COLLECTION_MODE_DEFINITIONS,
    CONFIRMATION_CHANNEL_DEFINITIONS,
    EDGE_CASE_DEFINITIONS,
    ERROR_CODE_GLOSSARY,
    GL_ACCOUNT_DEFINITIONS,
    GLOSSARY_TERMS,
    RUNBOOK_DEFINITIONS,
} from "../guide/glossaryData";
import { buildGuideSearchIndex } from "../guide/search";

const BOOKS = [...BOOKS_PART_1, ...BOOKS_PART_2];

describe("admin guide content completeness", () => {
    test("all 12 books exist with the required depth", () => {
        expect(BOOKS.length).toBe(12);
        expect(BOOKS.map((book) => book.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        for (const book of BOOKS) {
            const body = book.chapters.map((chapter) => chapter.bodyEn).join("\n\n");
            expect(body.length, `Book ${book.number} body length`).toBeGreaterThanOrEqual(1500);
            expect(book.sopChecklist.length, `Book ${book.number} SOP`).toBeGreaterThanOrEqual(1);
            expect(book.humanErrorWarning.trim().length, `Book ${book.number} warning`).toBeGreaterThan(20);
            expect(book.chapters.length, `Book ${book.number} chapters`).toBeGreaterThanOrEqual(1);
            for (const chapter of book.chapters) {
                expect(chapter.bodyEn.trim().length, `${book.number}.${chapter.number} body`).toBeGreaterThan(200);
                expect(chapter.titleEn.trim().length).toBeGreaterThan(5);
            }
        }
    });

    test("the zero-assumption glossary and canonical definition lists are complete", () => {
        expect(GLOSSARY_TERMS.length).toBeGreaterThanOrEqual(20);
        expect(GL_ACCOUNT_DEFINITIONS.length).toBe(10);
        expect(ATTEMPT_STATUS_DEFINITIONS.length).toBe(14);
        expect(COLLECTION_MODE_DEFINITIONS.length).toBe(9);
        expect(CONFIRMATION_CHANNEL_DEFINITIONS.length).toBe(7);
        expect(RUNBOOK_DEFINITIONS.length).toBe(5);
        expect(ERROR_CODE_GLOSSARY.length).toBeGreaterThanOrEqual(5);
        expect(EDGE_CASE_DEFINITIONS.length).toBe(140);
        for (const term of GLOSSARY_TERMS) {
            expect(term.definitionEn.trim().length).toBeGreaterThan(40);
            expect(term.analogyEn.trim().length).toBeGreaterThan(10);
            expect(term.fatalErrorEn.trim().length).toBeGreaterThan(10);
        }
        for (const status of ATTEMPT_STATUS_DEFINITIONS) {
            expect(status.meaningEn.trim().length).toBeGreaterThan(20);
            expect(status.operatorAction.trim().length).toBeGreaterThan(10);
        }
        for (const runbook of RUNBOOK_DEFINITIONS) {
            expect(runbook.stepsEn.length).toBeGreaterThanOrEqual(4);
            expect(runbook.stepsAr.length).toBe(runbook.stepsEn.length);
        }
    });

    test("Ctrl+K search reaches books, glossary, errors, GL accounts, statuses, runbooks, and edge cases", () => {
        const index = buildGuideSearchIndex();
        for (const book of BOOKS) {
            expect(index.some((entry) => entry.kind === "book" && entry.bookNumber === book.number)).toBe(true);
        }
        for (const code of ["RETRYABLE_OTP", "LIMIT_EXCEEDED", "GATEWAY_FAULT", "AMBIGUOUS"]) {
            expect(index.some((entry) => entry.kind === "error" && entry.titleEn === code)).toBe(true);
        }
        for (const code of ["TREASURY", "GATEWAY_CLEARING", "COMMISSION_RECEIVABLE", "SUSPENSE"]) {
            expect(index.some((entry) => entry.kind === "gl" && entry.titleEn === code)).toBe(true);
        }
        for (const code of ["UNKNOWN", "SUCCEEDED", "BLOCKED", "DISPUTED"]) {
            expect(index.some((entry) => entry.kind === "status" && entry.titleEn === code)).toBe(true);
        }
        for (const id of ["RB-01", "RB-02", "RB-03", "RB-04", "RB-05"]) {
            expect(index.some((entry) => entry.kind === "runbook" && entry.titleEn.startsWith(id))).toBe(true);
        }
        expect(index.filter((entry) => entry.kind === "edge-case").length).toBe(140);
        expect(index.some((entry) => entry.kind === "simulator" && entry.titleEn === "Transform Playground")).toBe(true);
    });
});
