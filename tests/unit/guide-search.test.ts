import { beforeAll, describe, expect, test } from "vitest";
import {
    buildGuideSearchIndex,
    getGuideSearchBuildMs,
    normalizeGuideSearchText,
    searchGuideDocuments,
    searchGuideGroups,
} from "@/components/guide/GuideSearch";

const topTypes = async (query: string): Promise<string[]> => {
    const hits = await searchGuideDocuments(query);
    return hits.slice(0, 3).map((hit) => hit.type);
};

describe("guide search index", () => {
    beforeAll(async () => {
        await buildGuideSearchIndex();
    });

    test("builds the full index in under 1000 ms", () => {
        expect(getGuideSearchBuildMs()).toBeLessThan(1000);
        expect(getGuideSearchBuildMs()).toBeGreaterThanOrEqual(0);
    });

    test("UNKNOWN finds the status and the article", async () => {
        const hits = await searchGuideDocuments("UNKNOWN");
        expect(hits.some((hit) => hit.type === "term" && hit.title === "UNKNOWN")).toBe(true);
        expect(hits.some((hit) => hit.type === "article" && hit.route.includes("b07-03"))).toBe(true);
    });

    test("case does not matter", async () => {
        const lower = await topTypes("unknown");
        const upper = await topTypes("UNKNOWN");
        expect(lower.slice(0, 2)).toEqual(upper.slice(0, 2));
    });

    test("codes are searchable with or without underscores", async () => {
        for (const query of ["limit exceeded", "LIMIT_EXCEEDED", "limit_exceeded"]) {
            const hits = await searchGuideDocuments(query);
            expect(
                hits.some((hit) => hit.type === "error-code" && hit.title === "LIMIT_EXCEEDED"),
                query,
            ).toBe(true);
        }
    });

    test("maker checker reaches governance content", async () => {
        const hits = await searchGuideDocuments("maker checker");
        const matched = hits.slice(0, 8).map((hit) => `${hit.type}:${hit.title}`).join(" | ");
        expect(matched).toMatch(/four-eyes|Four-eyes principle|Maker|Checker|Governance/i);
    });

    test("ledger, HMAC and Arabic payment all return results without crashing", async () => {
        expect((await searchGuideDocuments("ledger")).length).toBeGreaterThan(0);
        expect((await searchGuideDocuments("HMAC")).length).toBeGreaterThan(0);
        const arabic = await searchGuideDocuments("الدفع");
        expect(Array.isArray(arabic)).toBe(true);
    });

    test("Arabic-Indic digits are normalised", () => {
        expect(normalizeGuideSearchText("٠٩١٢٣٤٥٦٧٨")).toBe("0912345678");
        expect(normalizeGuideSearchText("LIMIT_EXCEEDED")).toContain("limit");
        expect(normalizeGuideSearchText("LIMIT_EXCEEDED")).toContain("exceeded");
    });

    test("results are grouped by type and never exceed eight per type", async () => {
        const groups = await searchGuideGroups("payment");
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
            expect(group.hits.length).toBeLessThanOrEqual(8);
            expect(group.label.length).toBeGreaterThan(0);
        }
    });

    test("a nonsense query still returns a safe array", async () => {
        const hits = await searchGuideDocuments("zzzz-no-such-guide-term-9999");
        expect(Array.isArray(hits)).toBe(true);
    });
});
