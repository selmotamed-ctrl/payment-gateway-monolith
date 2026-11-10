import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadBundle } from "./helpers";

const bundle = loadBundle();
const articleIds = new Set(bundle.guide.articles.map((article) => article.id));
const cardIds = new Set(bundle.guide.cards.map((card) => card.id));
const situationIds = new Set(bundle.guide.playbook.map((situation) => situation.id));
const termIds = new Set(bundle.guide.glossary.map((term) => term.slug));
const lessonIds = new Set(bundle.academy.lessons.map((lesson) => lesson.id));
const labIds = new Set(bundle.academy.labs.map((lab) => lab.id));
const checkIds = new Set(bundle.academy.checks.map((check) => check.id));

describe("companion content bundle", () => {
    test("contains the complete guide and learner academy", () => {
        expect(bundle.schema).toBe(1);
        expect(bundle.meta.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(bundle.guide.books).toHaveLength(14);
        expect(bundle.guide.articles).toHaveLength(135);
        expect(bundle.guide.glossary).toHaveLength(151);
        expect(bundle.guide.cards).toHaveLength(25);
        expect(bundle.guide.playbook).toHaveLength(32);
        expect(bundle.guide.edgeCases).toHaveLength(140);
        expect(bundle.academy.tracks).toHaveLength(8);
        expect(bundle.academy.modules).toHaveLength(11);
        expect(bundle.academy.lessons).toHaveLength(50);
        expect(bundle.academy.labs).toHaveLength(16);
        expect(bundle.academy.checks).toHaveLength(100);
    });

    test("all cross-document links resolve", () => {
        const targets: Record<string, Set<string>> = {
            a: articleIds,
            c: cardIds,
            s: situationIds,
            g: termIds,
        };
        const walk = (value: unknown): void => {
            if (typeof value === "string") {
                for (const match of value.matchAll(/\[\[([acgs]):([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g)) {
                    expect(targets[match[1]!]?.has(match[2]!), `${match[1]}:${match[2]}`).toBe(true);
                }
            } else if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === "object") Object.values(value).forEach(walk);
        };
        walk({ guide: bundle.guide, academy: bundle.academy });
    });

    test("lesson reading and practice references resolve", () => {
        for (const lesson of bundle.academy.lessons) {
            for (const articleId of lesson.reading) expect(articleIds.has(articleId)).toBe(true);
            for (const checkId of lesson.checkIds) expect(checkIds.has(checkId)).toBe(true);
        }
        for (const lab of bundle.academy.labs) {
            for (const articleId of lab.refs) expect(articleIds.has(articleId)).toBe(true);
        }
    });

    test("contains no external URLs or exam-bank question ids", () => {
        const serialized = JSON.stringify(bundle);
        expect(serialized).not.toMatch(/https?:\/\//i);
        // Exam ids are deliberately not present in the learner bundle; if the
        // cache exists during a local build, verify no question id leaked.
        const examBankPath = new URL("../.cache/exam-bank.json", import.meta.url);
        if (existsSync(examBankPath)) {
            const examBank = JSON.parse(readFileSync(examBankPath, "utf8")) as {
                questions?: { id?: string }[];
            };
            for (const question of examBank.questions ?? []) {
                if (question.id) expect(serialized.includes(question.id)).toBe(false);
            }
        }
    });
});
