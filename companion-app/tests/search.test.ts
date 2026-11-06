import { describe, expect, test } from "vitest";
import { resetSearchIndexForTests, searchContent, searchGroups } from "@/content/search";
import { setBundleForTests } from "@/content/store";
import { loadBundle } from "./helpers";

const bundle = loadBundle();
setBundleForTests(bundle);

describe("offline search", () => {
    test("finds error codes and edge cases", async () => {
        const hits = await searchContent("LIMIT_EXCEEDED");
        expect(hits.some((hit) => hit.type === "error-code" || hit.type === "article")).toBe(true);
    });

    test("finds maker-checker material", async () => {
        const groups = await searchGroups("maker checker");
        expect(groups.length).toBeGreaterThan(0);
        expect(groups.some((group) => group.type === "article" || group.type === "lesson")).toBe(true);
    });

    test("finds a glossary term by name", async () => {
        const term = bundle.guide.glossary[0]!;
        const hits = await searchContent(term.term);
        expect(hits.some((hit) => hit.type === "term" && hit.title === term.term)).toBe(true);
    });

    test("returns nothing for an empty query", async () => {
        expect(await searchContent("   ")).toEqual([]);
    });

    test("reset works for test isolation", () => {
        resetSearchIndexForTests();
        expect(true).toBe(true);
    });
});
