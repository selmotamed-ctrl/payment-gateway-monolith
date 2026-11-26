#!/usr/bin/env bun
/**
 * Generates the inline-SVG icon map for each portal from the `mdi-*` names
 * actually used in its source. The output imports only the used `@mdi/js`
 * paths, so Vite can tree-shake the rest of the icon package.
 *
 * Usage:
 *   bun scripts/generate-frontend-icons.ts
 *   bun scripts/generate-frontend-icons.ts --check
 *   bun scripts/generate-frontend-icons.ts --portal=admin-front
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PORTALS = ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"];
const args = process.argv.slice(2);
const check = args.includes("--check");
const portalArg = args.find((arg) => arg.startsWith("--portal="))?.slice("--portal=".length);
const portals = portalArg ? [portalArg] : PORTALS;

/**
 * `@mdi/js` 7.4.47 does not ship these three outlines. Use the closest
 * available glyph so the icon name in application code stays unchanged.
 */
const ALIASES: Record<string, string> = {
    "mdi-file-compare-outline": "mdiFileCompare",
    "mdi-file-document-search-outline": "mdiFileSearchOutline",
    "mdi-file-report-outline": "mdiFileChartOutline",
};

const camel = (name: string): string =>
    "mdi" +
    name
        .slice("mdi-".length)
        .split("-")
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");

const walk = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            walk(path, out);
        } else if (/\.(ts|tsx)$/.test(entry)) {
            out.push(path);
        }
    }
};

for (const portal of portals) {
    const portalDir = join(ROOT, portal);
    const srcDir = join(portalDir, "src");
    const files: string[] = [];
    walk(srcDir, files);

    const names = new Set<string>();
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/\bmdi-[a-z0-9-]+\b/g)) {
            names.add(match[0]);
        }
    }

    const requireFromPortal = createRequire(join(portalDir, "package.json"));
    const mdi = requireFromPortal("@mdi/js") as Record<string, string>;

    const sorted = [...names].sort();
    const missing: string[] = [];
    const mapping = new Map<string, string>();
    const identifiers = new Set<string>();

    for (const name of sorted) {
        const identifier = ALIASES[name] ?? camel(name);
        if (!(identifier in mdi)) {
            missing.push(`${name} (tried ${identifier})`);
            continue;
        }
        mapping.set(name, identifier);
        identifiers.add(identifier);
    }

    if (missing.length > 0) {
        console.error(`[${portal}] Missing @mdi/js icons:\n  ${missing.join("\n  ")}`);
        process.exitCode = 1;
        continue;
    }

    const importLines = [...identifiers]
        .sort()
        .map((identifier) => `    ${identifier},`)
        .join("\n");
    const mapLines = [...mapping.entries()]
        .map(([name, identifier]) => `    ${JSON.stringify(name)}: ${identifier},`)
        .join("\n");

    const content = `// GENERATED FILE - do not edit by hand.
// Run: bun scripts/generate-frontend-icons.ts --portal=${portal}
import {
${importLines}
} from "@mdi/js";

export const icons = {
${mapLines}
} as const;

export type IconName = keyof typeof icons;
`;

    const target = join(srcDir, "components", "AppIcon", "icons.generated.ts");
    const current = (() => {
        try {
            return readFileSync(target, "utf8");
        } catch {
            return "";
        }
    })();

    if (current !== content) {
        if (check) {
            console.error(`[${portal}] ${target} is stale. Run bun scripts/generate-frontend-icons.ts`);
            process.exitCode = 1;
        } else {
            mkdirSync(join(srcDir, "components", "AppIcon"), { recursive: true });
            writeFileSync(target, content);
            console.log(`[${portal}] wrote ${mapping.size} icons to ${target}`);
        }
    } else {
        console.log(`[${portal}] ${mapping.size} icons up to date`);
    }
}
