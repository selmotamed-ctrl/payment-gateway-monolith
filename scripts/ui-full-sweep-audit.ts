#!/usr/bin/env bun
/**
 * UI full-sweep governance gate.
 *
 * Uses the pure rules in `packages/ui/src/testing/governanceAudit.ts` and fails
 * when application code reintroduces a raw native control, a direct
 * VuetifyShim/vael-ui import, an inline colour, container padding, a
 * hand-styled alert, the transparent-text hack, a duplicated primitive
 * directory or a legacy drifted stylesheet.
 *
 * `packages/ui` is the only place allowed to contain raw HTML controls.
 */
import fs from "node:fs";
import path from "node:path";
import {
    auditUiSources,
    findDuplicatedComponentDirs,
    findLegacyStylesheets,
    type GovernanceViolation,
    type SourceFile,
} from "../packages/ui/src/testing/governanceAudit";

const ROOT = process.cwd();
const APPS = ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"];

const walkTsx = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkTsx(full, out);
        else if (entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
};

const sources: SourceFile[] = [];
const appDirs: Array<{ app: string; dirs: string[] }> = [];

for (const app of APPS) {
    const srcDir = path.join(ROOT, app, "src");
    for (const file of walkTsx(srcDir)) {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        sources.push({ file: rel, source: fs.readFileSync(file, "utf-8"), isPage: rel.includes("/src/pages/") });
    }
    const componentDir = path.join(ROOT, app, "src", "components");
    appDirs.push({ app, dirs: fs.existsSync(componentDir) ? fs.readdirSync(componentDir) : [] });
}

const PRIMITIVES = new Set([
    "vael", "ui", "Table", "Card", "Button", "_Button", "TextField", "DateInput", "Checkbox",
    "AlertView", "SnackBar", "Field", "FieldsSections", "SectionFields", "InputFields",
    "FiltersContainer", "PageHeader", "SubHeader", "ScreenContainer", "StateView", "StatusChip",
    "MoneyText", "MiniStats", "PageStats", "ThemedText", "ThemedView", "CenterView", "ThemeMenu",
    "ThemeAndLanguageControls", "AppIcon", "Icon", "Autocomplete", "ApiAutocomplete", "DataPage",
    "Printables", "EChart", "ActionsList", "AuthoritiesPicker", "ApiImage", "CordsInputMap",
    "StatsCard", "StatsChartCard", "StatsBarChartCard",
]);

const stylesheets = APPS.flatMap((app) =>
    ["vael-shim.css", "fintech-minimal.css", "vael-theme.css"].map((name) => {
        const file = path.join(app, "src", "styles", name);
        return { file: path.relative(ROOT, file).replace(/\\/g, "/"), exists: fs.existsSync(file) };
    }),
);

const violations: GovernanceViolation[] = [
    ...auditUiSources(sources),
    ...findDuplicatedComponentDirs(appDirs, PRIMITIVES),
    ...findLegacyStylesheets(stylesheets),
];

if (violations.length > 0) {
    const byRule = new Map<string, number>();
    const byApp = new Map<string, number>();
    for (const violation of violations) {
        const rule = violation.rule.slice(0, 5);
        byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
        const app = violation.file.split("/")[0] ?? "-";
        byApp.set(app, (byApp.get(app) ?? 0) + 1);
    }
    console.error(`\n❌ UI FULL-SWEEP AUDIT FAILED: ${violations.length} violation(s) remaining.`);
    console.error(`   by rule: ${[...byRule.entries()].map(([rule, count]) => `${rule}=${count}`).join(" ")}`);
    console.error(`   by app:  ${[...byApp.entries()].map(([app, count]) => `${app}=${count}`).join(" ")}\n`);
    for (const violation of violations.slice(0, 120)) {
        console.error(`  [${violation.rule}]\n    → ${violation.file}${violation.line ? `:${violation.line}` : ""}  |  ${violation.snippet}`);
    }
    if (violations.length > 120) console.error(`\n  ... and ${violations.length - 120} more violations.`);
    try {
        fs.mkdirSync("/tmp/opencode", { recursive: true });
        fs.writeFileSync("/tmp/opencode/ui-audit.json", JSON.stringify(violations, null, 2));
    } catch {
        /* diagnostics only */
    }
    process.exit(1);
}

console.log("✅ UI FULL-SWEEP AUDIT PASSED: 0 violations across all 4 frontends.");
