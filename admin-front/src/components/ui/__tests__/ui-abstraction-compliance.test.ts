import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.resolve(here, "../../../pages");
const uiIndexPath = path.resolve(here, "../index.ts");

function walkTsxFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkTsxFiles(full));
        } else if (entry.isFile() && full.endsWith(".tsx")) {
            results.push(full);
        }
    }
    return results;
}

const isPageEntry = (file: string): boolean => {
    const rel = path.relative(pagesDir, file).replace(/\\/g, "/");
    if (rel.startsWith("public/")) return false;
    if (rel.includes("/components/")) return false;
    return true;
};

const pageFiles = walkTsxFiles(pagesDir).filter(isPageEntry);

describe("UI abstraction and anti-AI-slop compliance gate", () => {
    it("exports all named UI primitives and the unified table components", () => {
        const uiIndex = fs.readFileSync(uiIndexPath, "utf8");
        const requiredExports = [
            "PageHeader",
            "StatusBadge",
            "MoneyDisplay",
            "MonoRef",
            "MetricStrip",
            "SurfaceCard",
            "FormModal",
            "FormField",
            "SlideOverDrawer",
            "DescriptionList",
            "SegmentedTabs",
            "EmptyState",
            "JsonDiffViewer",
        ];
        for (const name of requiredExports) {
            expect(uiIndex).toContain(name);
        }
        expect(fs.existsSync(path.resolve(here, "../../Table/TableFilters.tsx"))).toBe(true);
        expect(fs.existsSync(path.resolve(here, "../../Table/DataTable.tsx"))).toBe(true);
        expect(fs.existsSync(path.resolve(here, "../../Table/ApiTable.tsx"))).toBe(true);
    });

    it("has no raw VDialog in route pages", () => {
        for (const file of pageFiles) {
            const src = fs.readFileSync(file, "utf8");
            expect(src, `${path.relative(pagesDir, file)} still uses raw <VDialog`).not.toMatch(/<VDialog\b/);
        }
    });

    it("has no raw VChip in route pages", () => {
        for (const file of pageFiles) {
            const src = fs.readFileSync(file, "utf8");
            expect(src, `${path.relative(pagesDir, file)} still uses raw <VChip`).not.toMatch(/<VChip\b/);
        }
    });

    it("has no raw VCard containers in route pages", () => {
        for (const file of pageFiles) {
            const src = fs.readFileSync(file, "utf8");
            expect(src, `${path.relative(pagesDir, file)} still uses raw <VCard`).not.toMatch(/<VCard\b/);
        }
    });

    it("uses PageHeader on every standard route page", () => {
        for (const file of pageFiles) {
            const rel = path.relative(pagesDir, file).replace(/\\/g, "/");
            if (rel.startsWith("public/")) continue;
            const src = fs.readFileSync(file, "utf8");
            expect(src, `${rel} must use PageHeader`).toContain("PageHeader");
        }
    });

    it("contains no gradient backgrounds in the table/header/card system", () => {
        const files = [
            "../PageHeader.tsx",
            "../../Table/TableFilters.tsx",
            "../../Table/Table.tsx",
            "../../Table/DataTable.tsx",
            "../../Table/ApiTable.tsx",
            "../../Card/index.tsx",
        ];
        for (const rel of files) {
            const file = path.resolve(here, rel);
            const src = fs.readFileSync(file, "utf8");
            expect(src, `${rel} must not contain gradients`).not.toMatch(/linear-gradient|radial-gradient/i);
        }
    });

    it("does not paint full-row semantic background tints", () => {
        const table = fs.readFileSync(path.resolve(here, "../../Table/Table.tsx"), "utf8");
        expect(table).not.toMatch(/rowColor\(row\)\s*\+\s*["']15["']/);
        expect(table).not.toMatch(/backgroundColor:\s*props\.rowColor/);
    });
});
