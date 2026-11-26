#!/usr/bin/env node
/**
 * Mechanical Vue 3.6 / Vapor migration codemod.
 *
 * It only rewrites imports and slot calls. It does not try to understand
 * component semantics; build/type-check/e2e must validate the result.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
    console.error("usage: node scripts/vapor-codemod.mjs <frontend-dir>");
    process.exit(1);
}

const files = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === "dist") continue;
            walk(p);
        } else if (p.endsWith(".tsx")) {
            files.push(p);
        }
    }
}
walk(path.join(root, "src"));

const splitNames = (value) =>
    value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

let changed = 0;
for (const file of files) {
    const original = fs.readFileSync(file, "utf8");
    let text = original;
    const hasSlots = /(?:ctx\.)?slots\.[A-Za-z0-9_]+\?\.\(\)/.test(text);

    // kt-dc -> local Vapor wrapper
    text = text.replace(/from\s+["']kt-dc["']/g, 'from "@/utils/dc"');

    // Vue imports: defineComponent -> local Vapor wrapper, createSlot when needed
    text = text.replace(
        /import\s*\{([^}]*)\}\s*from\s*["']vue["'];?/g,
        (full, names) => {
            const list = splitNames(names);
            const define = list.filter((n) => n === "defineComponent");
            const rest = list.filter((n) => n !== "defineComponent");
            if (hasSlots && !rest.some((n) => n === "createSlot")) rest.push("createSlot");
            const lines = [];
            if (rest.length) lines.push(`import { ${rest.join(", ")} } from "vue";`);
            if (define.length) lines.push(`import { defineComponent } from "@/utils/dc";`);
            return lines.length ? lines.join("\n") : "";
        },
    );

    // Vue Router Vapor components
    text = text.replace(
        /import\s*\{([^}]*)\}\s*from\s*["']vue-router["'];?/g,
        (full, names) => {
            const list = splitNames(names);
            const vapor = list.filter((n) => n === "RouterLink" || n === "RouterView");
            const rest = list.filter((n) => n !== "RouterLink" && n !== "RouterView");
            const lines = [];
            if (rest.length) lines.push(`import { ${rest.join(", ")} } from "vue-router";`);
            if (vapor.length)
                lines.push(`import { ${vapor.join(", ")} } from "vue-router/experimental/vapor";`);
            return lines.length ? lines.join("\n") : "";
        },
    );

    // Vuetify composables that validate the vdom current instance
    text = text.replace(
        /import\s*\{([^}]*)\}\s*from\s*["']vuetify["'];?/g,
        (full, names) => {
            const list = splitNames(names);
            const compat = list.filter((n) => n === "useTheme" || n === "useDisplay");
            const rest = list.filter((n) => n !== "useTheme" && n !== "useDisplay");
            const lines = [];
            if (rest.length) lines.push(`import { ${rest.join(", ")} } from "vuetify";`);
            if (compat.length)
                lines.push(`import { ${compat.join(", ")} } from "@/utils/vuetify-compat";`);
            return lines.length ? lines.join("\n") : "";
        },
    );

    // Slot outlets must use createSlot in Vapor components
    text = text.replace(
        /(?:ctx\.)?slots\.([A-Za-z0-9_]+)\?\.\(\)/g,
        (_, name) => `createSlot("${name}")`,
    );

    if (text !== original) {
        fs.writeFileSync(file, text);
        changed += 1;
    }
}

console.log(`vapor-codemod: ${changed}/${files.length} files updated in ${root}`);
