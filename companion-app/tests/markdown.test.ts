import { describe, expect, test } from "vitest";
import { lessonProse, renderMarkdown } from "@/lib/markdown";
import { loadBundle } from "./helpers";

const bundle = loadBundle();
const context = {
    glossary: bundle.guide.glossary,
    articles: bundle.guide.articles,
    cards: bundle.guide.cards,
    situations: bundle.guide.playbook,
};

describe("markdown renderer", () => {
    test("renders every article without unresolved guide links", () => {
        for (const article of bundle.guide.articles) {
            const segments = renderMarkdown(article.body, context);
            const html = segments.map((segment) => segment.html ?? "").join("\n");
            expect(html, article.id).not.toContain("[[");
            expect(html, article.id).not.toContain("{{widget:");
        }
    });

    test("renders callouts, glossary terms and widget placeholders", () => {
        const article = bundle.guide.articles.find((entry) => entry.id === "b06-04");
        expect(article).toBeDefined();
        const segments = renderMarkdown(article!.body, context);
        expect(segments.some((segment) => segment.type === "widget" && segment.widgetId === "transform-sandbox")).toBe(true);
        const html = segments.map((segment) => segment.html ?? "").join("\n");
        expect(html).toContain("glossary-term");
    });

    test("renders all academy lesson bodies", () => {
        for (const lesson of bundle.academy.lessons) {
            const segments = renderMarkdown(lessonProse(lesson.body), context);
            const html = segments.map((segment) => segment.html ?? "").join("\n");
            expect(html, lesson.id).not.toContain("[[");
            expect(html, lesson.id).not.toContain("{{widget:");
        }
    });

    test("lessonProse removes the structural Read now and Check yourself sections", () => {
        const lesson = bundle.academy.lessons[0]!;
        const prose = lessonProse(lesson.body);
        expect(prose).not.toMatch(/### Read now/i);
        expect(prose).not.toMatch(/### Check yourself/i);
    });

    test("heading ids are stable and unique within a rendered article", () => {
        const article = bundle.guide.articles.find((entry) => entry.headings.length > 3) ?? bundle.guide.articles[0]!;
        const html = renderMarkdown(article.body, context)
            .map((segment) => segment.html ?? "")
            .join("\n");
        const ids = [...html.matchAll(/<h[1-4] id="([^"]+)"/g)].map((match) => match[1]!);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
