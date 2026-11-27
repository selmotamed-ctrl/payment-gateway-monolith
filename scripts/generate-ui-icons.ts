#!/usr/bin/env bun
/**
 * Generates the single `@pg/ui` icon registry from every `mdi-*` name used in
 * the design system and in the four portals. The output imports only the used
 * `@mdi/js` paths, so Vite can tree-shake the rest of the icon package.
 *
 * Usage:
 *   bun scripts/generate-ui-icons.ts
 *   bun scripts/generate-ui-icons.ts --check
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TARGET = join(ROOT, "packages", "ui", "src", "actions", "icons.generated.ts");
const check = process.argv.includes("--check");
const SOURCES = [
    join(ROOT, "packages", "ui", "src"),
    ...["admin-front", "merchant-front", "checkout-front", "fake-rails-front"].map((portal) =>
        join(ROOT, portal, "src"),
    ),
];

/** `@mdi/js` 7.4.47 lacks these three outlines; use the closest glyph. */
const ALIASES: Record<string, string> = {
    "mdi-file-compare-outline": "mdiFileCompare",
    "mdi-file-document-search-outline": "mdiFileSearchOutline",
    "mdi-file-report-outline": "mdiFileChartOutline",
};

const camel = (name: string): string =>
    "mdi" +
    name
        .slice(4)
        .split("-")
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");

const walk = (dir: string, out: string[]): void => {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
    }
};

const files: string[] = [];
for (const source of SOURCES) walk(source, files);

const names = new Set<string>();
for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bmdi-[a-z0-9-]+\b/g)) names.add(match[0]);
}

const requireFromPackage = createRequire(join(ROOT, "packages", "ui", "package.json"));
const mdi = requireFromPackage("@mdi/js") as Record<string, string>;

const sorted = [...names].sort();
const missing: string[] = [];
const mapping: Array<[string, string]> = [];
const identifiers = new Set<string>();

for (const name of sorted) {
    const identifier = ALIASES[name] ?? camel(name);
    if (!(identifier in mdi)) {
        missing.push(`${name} (tried ${identifier})`);
        continue;
    }
    mapping.push([name, identifier]);
    identifiers.add(identifier);
}

if (missing.length > 0) {
    console.error(`[@pg/ui] Missing @mdi/js icons:\n  ${missing.join("\n  ")}`);
    process.exit(1);
}

const content = `// GENERATED FILE - do not edit by hand.
// Run: bun scripts/generate-ui-icons.ts
import {
${[...identifiers]
    .sort()
    .map((identifier) => `    ${identifier},`)
    .join("\n")}
} from "@mdi/js";

export const icons = {
${mapping.map(([name, identifier]) => `    ${JSON.stringify(name)}: ${identifier},`).join("\n")}
} as const;

export type IconName = keyof typeof icons;
`;

if (check) {
    let current = "";
    try {
        current = readFileSync(TARGET, "utf8");
    } catch {
        current = "";
    }
    if (current !== content) {
        console.error("[@pg/ui] icons.generated.ts is stale. Run bun scripts/generate-ui-icons.ts");
        process.exit(1);
    }
    console.log(`[@pg/ui] icon registry up to date (${mapping.length} icons).`);
} else {
    writeFileSync(TARGET, content);
    console.log(`[@pg/ui] wrote ${mapping.length} icons to packages/ui/src/actions/icons.generated.ts`);
}
