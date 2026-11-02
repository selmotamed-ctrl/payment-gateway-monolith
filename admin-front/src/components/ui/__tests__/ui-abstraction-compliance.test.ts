import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../../..");
const pagesDir = path.resolve(here, "../../../pages");
const tableDir = path.resolve(here, "../../Table");
const uiIndexPath = path.resolve(here, "../index.ts");
const statusTonePath = path.join(tableDir, "statusTone.ts");
const tableRowActionsPath = path.join(tableDir, "TableRowActions.tsx");
const sectionFieldsPath = path.resolve(here, "../../SectionFields/index.tsx");
const screenContainerPath = path.resolve(here, "../../ScreenContainer/index.tsx");

function walkFiles(dir: string, extensions: Set<string>): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkFiles(full, extensions));
        } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
            results.push(full);
        }
    }
    return results;
}

function walkTsxFiles(dir: string): string[] {
    return walkFiles(dir, new Set([".tsx"]));
}

const isPageEntry = (file: string): boolean => {
    const rel = path.relative(pagesDir, file).replace(/\\/g, "/");
    if (rel.startsWith("public/")) return false;
    if (rel.startsWith("components/") || rel.includes("/components/")) return false;
    return true;
};

const stripComments = (source: string): string =>
    source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");

const withoutLayerBlocks = (source: string): string => {
    let result = source;
    const layerPattern = /@layer\b[^{;]*\{/g;

    while (true) {
        layerPattern.lastIndex = 0;
        const match = layerPattern.exec(result);
        if (!match) return result;

        const open = match.index + match[0].length - 1;
        let depth = 0;
        let close = -1;
        for (let index = open; index < result.length; index += 1) {
            if (result[index] === "{") depth += 1;
            else if (result[index] === "}") {
                depth -= 1;
                if (depth === 0) {
                    close = index;
                    break;
                }
            }
        }
        if (close === -1) return result;
        result = result.slice(0, match.index) + result.slice(close + 1);
    }
};

const isZeroResetValue = (value: string): boolean =>
    /^0(?:px|rem|em|%)?(?:\s+0(?:px|rem|em|%)?){0,3}$/i.test(value.replace(/!important/gi, "").trim());

function findUniversalResetOffenders(file: string, content: string): string[] {
    const unlayered = withoutLayerBlocks(stripComments(content));
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = rulePattern.exec(unlayered))) {
        const selector = match[1].trim();
        if (!selector || selector.startsWith("@")) continue;

        const hasUniversalSelector = selector
            .split(",")
            .map((part) => part.trim())
            .some((part) => /^\*(?:::?[a-z-]+(?:\([^)]*\))?)?$/i.test(part));
        if (!hasUniversalSelector) continue;

        for (const declaration of match[2].split(";")) {
            const separator = declaration.indexOf(":");
            if (separator === -1) continue;
            const property = declaration.slice(0, separator).trim().toLowerCase();
            const value = declaration.slice(separator + 1);
            if (property !== "padding" && property !== "margin" && !property.startsWith("padding-") && !property.startsWith("margin-")) {
                continue;
            }
            if (isZeroResetValue(value)) {
                offenders.push(`${path.relative(srcDir, file)}: ${selector} { ${declaration.trim()} }`);
            }
        }
    }

    return offenders;
}

function enclosingObject(source: string, index: number): { start: number; end: number } | null {
    let start = -1;
    for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (source[cursor] === "{") {
            start = cursor;
            break;
        }
    }
    if (start === -1) return null;

    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let cursor = start; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        const next = source[cursor + 1];

        if (lineComment) {
            if (char === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                cursor += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }
        if (char === "/" && next === "/") {
            lineComment = true;
            cursor += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            cursor += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return { start, end: cursor + 1 };
        }
    }

    return null;
}

const pageFiles = walkTsxFiles(pagesDir).filter(isPageEntry);
const sourceFiles = walkFiles(srcDir, new Set([".tsx", ".css", ".scss"]));

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

    it("has no unlayered universal padding or margin reset in src TSX/CSS/SCSS", () => {
        const offenders = sourceFiles.flatMap((file) =>
            findUniversalResetOffenders(file, fs.readFileSync(file, "utf8")),
        );
        expect(offenders, `Remove these unlayered universal resets:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("statusTone has no rainbow row tint production", () => {
        const source = fs.readFileSync(statusTonePath, "utf8");
        expect(source, "statusTone.ts must not emit rgba row tints").not.toMatch(/rgba\([^)]*,\s*0\.(?:0[5-9]|1)\)/i);
        expect(source, "statusTone.ts must not paint row backgrounds").not.toMatch(/\bbackground(?:Color)?\s*:/i);

        const tintFunction = source.match(/(?:export\s+)?(?:function|const)\s+getRowTintStyle[\s\S]*?\n\}/);
        if (tintFunction) {
            expect(tintFunction[0], "getRowTintStyle must return an empty object").toMatch(/return\s*\{\s*\}/);
        }
    });

    it("ships TableRowActions and page action columns use it or avoid multi-VBtn stacks", () => {
        expect(fs.existsSync(tableRowActionsPath), "TableRowActions.tsx must exist").toBe(true);

        const offenders: string[] = [];
        for (const file of pageFiles) {
            const source = fs.readFileSync(file, "utf8");
            const keyPattern = /\bkey\s*:\s*["'`]actions["'`]/g;
            let match: RegExpExecArray | null;

            while ((match = keyPattern.exec(source))) {
                const block = enclosingObject(source, match.index);
                if (!block) continue;

                const actionColumn = source.slice(block.start, block.end);
                const usesTableRowActions = /\bTableRowActions\b/.test(actionColumn);
                const vbtnCount = (actionColumn.match(/<VBtn\b/g) ?? []).length;
                if (!usesTableRowActions && vbtnCount > 1) {
                    const rel = path.relative(pagesDir, file).replace(/\\/g, "/");
                    offenders.push(`${rel}: actions column stacks ${vbtnCount} VBtn elements without <TableRowActions />`);
                }
            }
        }

        expect(offenders, `Refactor these action columns:\n${offenders.join("\n")}`).toEqual([]);
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

    it("ships the v2 SectionFields and required container/table classes", () => {
        expect(fs.existsSync(sectionFieldsPath), "SectionFields/index.tsx must exist").toBe(true);
        const sectionFields = fs.readFileSync(sectionFieldsPath, "utf8");
        expect(sectionFields, "SectionFields must be exported").toMatch(
            /export\s+(?:const|default|function|class)\s+SectionFields|export\s*\{[^}]*\bSectionFields\b/,
        );
        expect(sectionFields, "SectionFields must render .pg-section-fields__body").toContain("pg-section-fields__body");

        const screenContainer = fs.readFileSync(screenContainerPath, "utf8");
        expect(screenContainer, "ScreenContainer must use .pg-screen-container").toContain("pg-screen-container");

        for (const rel of ["../../Table/DataTable.tsx", "../../Table/ApiTable.tsx"]) {
            const source = fs.readFileSync(path.resolve(here, rel), "utf8");
            expect(source, `${rel} must use .pg-table-card`).toContain("pg-table-card");
        }
    });
});
