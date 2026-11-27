#!/usr/bin/env bun
/**
 * UI full-sweep governance gate.
 *
 * Uses the pure rules in `packages/ui/src/testing/governanceAudit.ts` and fails
 * when application code reintroduces a raw native control, a direct
 * VuetifyShim/vael-ui import, an inline colour, container padding, a
 * hand-styled alert, the transparent-text hack, a duplicated primitive
 * directory, a legacy drifted stylesheet, stray `<PageHeader>(` parentheses, a
 * VDOM Teleport, a missing `.pg-*` class, a duplicated `src/charts/`
 * directory, a legacy `VAlert`, an ad-hoc `pa-4`/`pa-6`, or an unregistered
 * `mdi-*` icon.
 *
 * `packages/ui` is the only place allowed to contain raw HTML controls.
 *
 * Usage:
 *   bun scripts/ui-full-sweep-audit.ts
 *   bun scripts/ui-full-sweep-audit.ts --explain
 *   bun scripts/ui-full-sweep-audit.ts --json
 */
import fs from "node:fs";
import path from "node:path";
import {
    GOVERNANCE_RULE_CATALOG,
    runGovernanceAudit,
    type CssSource,
    type GovernanceViolation,
    type SourceFile,
} from "../packages/ui/src/testing/governanceAudit";

const ROOT = process.cwd();
const APPS = ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"];
const UI_SRC = path.join(ROOT, "packages", "ui", "src");
const ICON_REGISTRY = path.join(UI_SRC, "actions", "icons.generated.ts");

const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const explain = args.has("--explain");
if (args.has("--help") || args.has("-h")) {
    console.log(`UI full-sweep governance gate

  bun scripts/ui-full-sweep-audit.ts            run the gate (exit 1 on violations)
  bun scripts/ui-full-sweep-audit.ts --explain  print the rule catalogue and per-rule counts
  bun scripts/ui-full-sweep-audit.ts --json     print machine-readable results
`);
    process.exit(0);
}

const walk = (dir: string, extensions: RegExp, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, extensions, out);
        else if (extensions.test(entry.name)) out.push(full);
    }
    return out;
};

const toSource = (file: string, isPage: boolean, area: "app" | "ui"): SourceFile => ({
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    source: fs.readFileSync(file, "utf-8"),
    isPage,
    area,
});

const appSources: SourceFile[] = [];
const appDirs: Array<{ app: string; dirs: string[] }> = [];
for (const app of APPS) {
    const srcDir = path.join(ROOT, app, "src");
    for (const file of walk(srcDir, /\.tsx$/)) {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        appSources.push(toSource(file, rel.includes("/src/pages/"), "app"));
    }
    const componentDir = path.join(ROOT, app, "src", "components");
    appDirs.push({ app, dirs: fs.existsSync(componentDir) ? fs.readdirSync(componentDir) : [] });
}

// `packages/ui/src` is scanned for Teleport, missing CSS classes and icons.
// Raw-control rules never apply to the design system itself.
const uiSources: SourceFile[] = walk(UI_SRC, /\.(?:ts|tsx)$/).map((file) => toSource(file, false, "ui"));

// Icon coverage spans every TS/TSX module in the design system and the four
// portals, including non-page `.ts` files such as search command catalogs.
const iconSources: SourceFile[] = [
    ...uiSources,
    ...APPS.flatMap((app) => walk(path.join(ROOT, app, "src"), /\.(?:ts|tsx)$/)).map((file) => {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        return toSource(file, rel.includes("/src/pages/"), "app");
    }),
];

const cssSources: CssSource[] = walk(path.join(UI_SRC, "tokens"), /\.css$/).map((file) => ({
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    source: fs.readFileSync(file, "utf-8"),
}));

const chartDirs = APPS.map((app) => {
    const file = path.join(ROOT, app, "src", "charts");
    return { file: path.relative(ROOT, file).replace(/\\/g, "/"), exists: fs.existsSync(file) };
});

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

const iconRegistry = fs.existsSync(ICON_REGISTRY) ? fs.readFileSync(ICON_REGISTRY, "utf-8") : "";

const violations: GovernanceViolation[] = runGovernanceAudit({
    appSources,
    uiSources,
    cssSources,
    chartDirs,
    primitiveDirs: appDirs,
    primitives: PRIMITIVES,
    legacyStylesheets: stylesheets,
    iconRegistry,
    iconSources,
});

const byRule = new Map<string, number>();
const byArea = new Map<string, number>();
for (const entry of violations) {
    const rule = entry.rule.slice(0, 5);
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    const area = entry.file.includes("/")
        ? entry.file.startsWith("packages/")
            ? "packages/ui"
            : entry.file.split("/")[0]!
        : "-";
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
}

const ruleSummary = [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b));
const areaSummary = [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b));
const iconNameCount = new Set([...iconRegistry.matchAll(/"([^"]+)"\s*:\s*mdi/g)].map((match) => match[1]!)).size;

const writeDiagnostics = (): void => {
    try {
        fs.mkdirSync("/tmp/opencode", { recursive: true });
        fs.writeFileSync("/tmp/opencode/ui-audit.json", JSON.stringify(violations, null, 2));
    } catch {
        /* diagnostics only */
    }
};

if (jsonMode) {
    console.log(
        JSON.stringify(
            {
                ok: violations.length === 0,
                generatedAt: new Date().toISOString(),
                root: ROOT,
                scanned: {
                    appSources: appSources.length,
                    uiSources: uiSources.length,
                    cssSources: cssSources.length,
                    icons: iconNameCount,
                },
                counts: Object.fromEntries(ruleSummary),
                areas: Object.fromEntries(areaSummary),
                violations,
            },
            null,
            2,
        ),
    );
    writeDiagnostics();
    process.exit(violations.length > 0 ? 1 : 0);
}

if (explain) {
    console.log(`\nUI governance rule catalogue (${GOVERNANCE_RULE_CATALOG.length} rules):\n`);
    for (const rule of GOVERNANCE_RULE_CATALOG) {
        console.log(`  ${rule.id}  ${rule.message}\n        scope: ${rule.scope}`);
    }
    console.log(
        `\nScanned ${appSources.length} app sources, ${uiSources.length} @pg/ui sources, ` +
            `${cssSources.length} token CSS files and ${iconNameCount} registered icons.\n`,
    );
    if (ruleSummary.length > 0) {
        console.log(`Current counts: ${ruleSummary.map(([rule, count]) => `${rule}=${count}`).join(" ")}\n`);
    }
}

if (violations.length > 0) {
    if (!jsonMode) {
        console.error(`\n❌ UI FULL-SWEEP AUDIT FAILED: ${violations.length} violation(s) remaining.`);
        if (ruleSummary.length > 0) {
            console.error(`   by rule: ${ruleSummary.map(([rule, count]) => `${rule}=${count}`).join(" ")}`);
        }
        if (areaSummary.length > 0) {
            console.error(`   by area: ${areaSummary.map(([area, count]) => `${area}=${count}`).join(" ")}`);
        }
        console.error(`   scanned: ${appSources.length} app sources + ${uiSources.length} @pg/ui sources\n`);
        for (const entry of violations.slice(0, 120)) {
            console.error(`  [${entry.rule}]\n    → ${entry.file}${entry.line ? `:${entry.line}` : ""}  |  ${entry.snippet}`);
        }
        if (violations.length > 120) console.error(`\n  ... and ${violations.length - 120} more violations.`);
        console.error(`\n  Full list: /tmp/opencode/ui-audit.json\n`);
    }
    writeDiagnostics();
    process.exit(1);
}

if (!jsonMode) {
    console.log(
        `✅ UI FULL-SWEEP AUDIT PASSED: 0 violations across 4 frontends + @pg/ui ` +
            `(${appSources.length + uiSources.length} sources, ${iconNameCount} icons).`,
    );
}
writeDiagnostics();
