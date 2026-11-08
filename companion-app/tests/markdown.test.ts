import { describe, expect, test } from "vitest";
import {
    extractParentheticalRefs,
    firstProseParagraph,
    lessonProse,
    renderMarkdown,
    shortTitle,
} from "@/lib/markdown";
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

    test("wraps tables in a keyboard-scrollable container", () => {
        const source = [
            "| Field | Meaning |",
            "| --- | --- |",
            "| `SECURITY_ADMIN/FINANCE` | The longest role name in the guide. |",
        ].join("\n");
        const html = renderMarkdown(source, context)
            .map((segment) => segment.html ?? "")
            .join("\n");
        expect(html).toContain('<div class="table-wrap table-wrap--md" tabindex="0">');
        expect(html).toContain("</table></div>");
        expect(html).not.toMatch(/<table[^>]*(?:style=|width=)/);
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

describe("reference clarity helpers", () => {
    test("extracts pure parenthetical reference pointers", () => {
        expect(extractParentheticalRefs("The core shows methods ([[a:b02-06]]).")).toEqual({
            cleaned: "The core shows methods.",
            refs: [{ kind: "a", id: "b02-06", label: undefined }],
        });
        expect(extractParentheticalRefs("Ask the partner (see [[a:b07-03]]).").refs).toEqual([
            { kind: "a", id: "b07-03", label: undefined },
        ]);
        expect(
            extractParentheticalRefs("Check both (see [[a:b06-05]], [[a:b06-07]]).").refs,
        ).toHaveLength(2);
    });

    test("keeps meaningful parenthetical prose and removes only the pointer", () => {
        expect(
            extractParentheticalRefs(
                "The core decides which methods to show (called *rails*, see [[a:b02-06]]).",
            ),
        ).toEqual({
            cleaned:
                "The core decides which methods to show (called *rails*).",
            refs: [{ kind: "a", id: "b02-06", label: undefined }],
        });
    });

    test("removes the pointer but keeps the parenthetical prose and punctuation", () => {
        expect(
            extractParentheticalRefs(
                "a **fee bearer** (who pays our commission; see [[a:b01-05|Fees]]),",
            ),
        ).toEqual({
            cleaned: "a **fee bearer** (who pays our commission),",
            refs: [{ kind: "a", id: "b01-05", label: "Fees" }],
        });
    });

    test("short labels never dump a long article title", () => {
        expect(shortTitle("The visible-rails formula: why a customer sees a method")).toBe(
            "The visible-rails formula",
        );
        expect(shortTitle("The engine: ten phases, steps, side effects and the retry boundary")).toBe(
            "The engine",
        );
    });

    test("renders summary and refs callouts and a section reference tray", () => {
        const source = [
            ":::summary Big picture",
            "The whole point in one sentence.",
            ":::",
            "",
            "## A section",
            "Text with a pointer ([[a:b02-06]]).",
            ":::refs",
            "- [[a:b07-03|Runbook for UNKNOWN]]",
            ":::",
        ].join("\n");
        const html = renderMarkdown(source, {
            articles: [
                { id: "b02-06", title: "The four layers: Gateway, Credential Set, Rail, Route" },
                { id: "b07-03", title: "UNKNOWN: what it means and exactly what to do" },
            ],
        })
            .map((segment) => segment.html ?? "")
            .join("\n");
        expect(html).toContain("callout-summary");
        expect(html).toContain("In plain words");
        expect(html).toContain("callout-refs");
        expect(html).toContain("Runbook for UNKNOWN");
        expect(html).toContain("section-refs");
        expect(html).toContain('data-ref-kind="a"');
        expect(html).toContain("The four layers");
        expect(html).not.toContain("[[");
    });

    test("firstProseParagraph strips headings, links and callout markers", () => {
        const paragraph = firstProseParagraph(
            ":::summary Big picture\n## Heading\n\nThe amount comes from ([[a:b07-03|the link]]), not the customer.\n\nSecond paragraph.",
        );
        expect(paragraph).toBe("The amount comes from (the link), not the customer.");
    });
});
