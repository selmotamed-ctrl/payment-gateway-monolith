import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "admin-front", "src");
const CATALOGUE_FILES = [
    join(ROOT, "constants", "i18nCatalogue.ts"),
    ...readdirSync(join(ROOT, "constants", "i18n"))
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => join(ROOT, "constants", "i18n", entry)),
];

const catalogueKeys = (): Set<string> => {
    const keys = new Set<string>();
    for (const file of CATALOGUE_FILES) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/^\s*"([^"]+)":\s*\[/gm)) keys.add(match[1]);
    }
    return keys;
};

const walk = (dir: string, files: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, files);
        else if (path.endsWith(".tsx") || path.endsWith(".ts")) files.push(path);
    }
    return files;
};

const CHECK_OBJECT = /\{\s*key:\s*"[A-Z0-9_]+",\s*label:\s*"([^"]+)"/g;

describe("checklist labels are translated", () => {
    test("every static checklist label has a catalogue entry", () => {
        const known = catalogueKeys();
        const missing: string[] = [];
        for (const file of walk(ROOT)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(CHECK_OBJECT)) {
                if (!known.has(match[1])) missing.push(`${match[1]} (${file.replace(`${ROOT}/`, "")})`);
            }
        }
        expect(missing).toEqual([]);
    });
});
