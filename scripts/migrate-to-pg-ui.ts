#!/usr/bin/env bun
/**
 * One-shot migration of the four portals onto `@pg/ui`.
 *
 * - rewrites the Vuetify-named shim imports and JSX tags to the 2026 `Pg*`
 *   primitives (one shared implementation),
 * - rewrites duplicated local UI component imports to `@pg/ui`,
 * - moves feature-only components out of `src/components` so the duplicated
 *   primitive gate has nothing to flag.
 *
 * Idempotent: running it twice changes nothing.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const APPS = ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"];
const dryRun = process.argv.includes("--dry-run");

const TAG_MAP: Record<string, string> = {
    VBtn: "PgButton",
    VIcon: "PgIcon",
    VIconDrag: "PgIcon",
    VTextField: "PgTextField",
    VTextarea: "PgTextarea",
    VSelect: "PgAutocomplete",
    VAutocomplete: "PgAutocomplete",
    VCombobox: "PgAutocomplete",
    VCheckbox: "PgCheckbox",
    VSwitch: "PgSwitch",
    VRadioGroup: "PgRadioGroup",
    VRadio: "PgRadio",
    VSlider: "PgSlider",
    VFileInput: "PgFileUpload",
    VDateInput: "PgDateInput",
    VProgressCircular: "PgSpinner",
    VProgressLinear: "PgProgressBar",
    VDivider: "PgDivider",
    VCard: "PgCard",
    VCardText: "PgCardText",
    VCardActions: "PgCardActions",
    VCardTitle: "PgCardTitle",
    VCardSubtitle: "PgCardSubtitle",
    VChip: "PgChip",
    VAvatar: "PgAvatar",
    VTooltip: "PgTooltip",
    VMenu: "PgMenu",
    VDialog: "PgDialog",
    VForm: "PgForm",
    VSnackbar: "PgToaster",
    VApp: "PgApp",
    VAppBar: "PgAppBar",
    VAppBarTitle: "PgAppBarTitle",
    VMain: "PgMain",
    VNavigationDrawer: "PgNavigationDrawer",
    VSpacer: "PgSpacer",
    VContainer: "PgContainer",
    VRow: "PgRow",
    VCol: "PgCol",
    VList: "PgList",
    VListItem: "PgListItem",
    VListItemTitle: "PgListItemTitle",
    VListItemSubtitle: "PgListItemSubtitle",
    VListSubheader: "PgListSubheader",
    VExpansionPanels: "PgExpansionPanels",
    VExpansionPanel: "PgExpansionPanel",
    VExpansionPanelTitle: "PgExpansionPanelTitle",
    VExpansionPanelText: "PgExpansionPanelText",
    VTimeline: "PgTimeline",
    VTimelineItem: "PgTimelineItem",
    VBtnToggle: "PgBtnToggle",
    VExpandTransition: "PgTransition",
};

/** Import paths whose exports now live in `@pg/ui`. */
const PACKAGE_PATHS = new Set([
    "@/components/vael/VuetifyShim",
    "@/components/AlertView",
    "@/components/Autocomplete",
    "@/components/ApiAutocomplete",
    "@/components/AppIcon",
    "@/components/Button",
    "@/components/_Button",
    "@/components/Card",
    "@/components/CenterView",
    "@/components/Checkbox",
    "@/components/DateInput",
    "@/components/Field",
    "@/components/FieldsSections",
    "@/components/Icon",
    "@/components/MiniStats",
    "@/components/MoneyText",
    "@/components/PageHeader",
    "@/components/PageStats",
    "@/components/ScreenContainer",
    "@/components/SectionFields",
    "@/components/StateView",
    "@/components/StatusChip",
    "@/components/SubHeader",
    "@/components/TextField",
    "@/components/ThemeAndLanguageControls",
    "@/components/ThemeMenu",
    "@/components/ThemedText",
    "@/components/ThemedView",
    "@/components/loadingScreen",
    "@/components/detailsFieldsDialog",
    "@/components/ui",
    "@/components/ui/PageHeader",
    "@/components/ui/StatusBadge",
    "@/components/ui/MoneyDisplay",
    "@/components/ui/MonoRef",
    "@/components/ui/MetricStrip",
    "@/components/ui/SurfaceCard",
    "@/components/ui/FormModal",
    "@/components/ui/FormField",
    "@/components/ui/SlideOverDrawer",
    "@/components/ui/DescriptionList",
    "@/components/ui/SegmentedTabs",
    "@/components/ui/EmptyState",
    "@/components/ui/JsonDiffViewer",
    "@/components/ui/MetaPill",
    "@/components/ui/FormChecklist",
    "@/components/ui/SummaryExportCard",
    "@/components/Table/ApiTable",
    "@/components/Table/Table",
    "@/components/Table/TableFilters",
    "@/components/Table/TableRowActions",
    "@/components/Table/HeaderFooter",
    "@/components/Table/types",
    "@/components/Table/filters",
    "@/components/Table/statusTone",
]);

/** Default-import aliases for package paths (`import X from "path"`). */
const DEFAULT_ALIAS: Record<string, string> = {
    "@/components/AlertView": "AlertView",
    "@/components/Autocomplete": "PgAutocomplete",
    "@/components/ApiAutocomplete": "PgApiAutocomplete",
    "@/components/Button": "PgButton",
    "@/components/_Button": "PgButton",
    "@/components/Card": "PgCard",
    "@/components/CenterView": "PgCenter",
    "@/components/Checkbox": "PgCheckbox",
    "@/components/DateInput": "PgDateInput",
    "@/components/Field": "PgField",
    "@/components/FieldsSections": "PgFieldsSection",
    "@/components/Icon": "PgIcon",
    "@/components/MoneyText": "PgMoneyText",
    "@/components/PageHeader": "PgPageHeader",
    "@/components/PageStats": "PgMetricStrip",
    "@/components/ScreenContainer": "PgPage",
    "@/components/SectionFields": "PgSectionFields",
    "@/components/StateView": "PgStateView",
    "@/components/StatusChip": "PgStatusBadge",
    "@/components/SubHeader": "PgSubHeader",
    "@/components/TextField": "PgTextField",
    "@/components/ThemeAndLanguageControls": "PgThemeLanguageControls",
    "@/components/ThemeMenu": "PgThemeMenu",
    "@/components/ThemedText": "PgText",
    "@/components/ThemedView": "PgView",
    "@/components/loadingScreen": "PgLoadingScreen",
    "@/components/detailsFieldsDialog": "PgDetailsDialog",
    "@/components/Table/ApiTable": "PgApiTable",
    "@/components/Table/Table": "PgTable",
    "@/components/Table/HeaderFooter": "PgTableHeader",
};

/** Path-only moves to feature folders (no export rename). */
const PATH_MOVES: Array<[RegExp, string]> = [
    [/^@\/components\/Table\/tableRegistry$/, "@/tables/tableRegistry"],
    [/^@\/components\/Table\/registry\/(.+)$/, "@/tables/registry/$1"],
    [/^@\/components\/Table\/referenceOptions$/, "@/tables/referenceOptions"],
    [/^@\/components\/Table\/DataTable$/, "@/tables/DataTable"],
    [/^@\/components\/Table\/styling\.css$/, ""],
    [/^@\/components\/DataPage$/, "@/tables/DataPage"],
    [/^@\/components\/InputFields$/, "@/forms/InputFields"],
    [/^@\/components\/FiltersContainer$/, "@/forms/FiltersContainer"],
    [/^@\/components\/Printables\/(.+)$/, "@/printables/$1"],
    [/^@\/components\/Printables$/, "@/printables"],
    [/^@\/components\/EChart\/(.+)$/, "@/charts/EChart/$1"],
    [/^@\/components\/EChart$/, "@/charts/EChart"],
    [/^@\/components\/ActionsList$/, "@/features/ActionsList"],
    [/^@\/components\/AuthoritiesPicker$/, "@/features/AuthoritiesPicker"],
    [/^@\/components\/ApiImage$/, "@/features/ApiImage"],
    [/^@\/components\/CordsInputMap$/, "@/features/CordsInputMap"],
    [/^@\/components\/sandbox\/(.+)$/, "@/features/sandbox/$1"],
    [/^@\/components\/vael\/VaelProvider$/, "@pg/ui"],
];

const walk = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
    }
};

const rewriteImportNames = (clause: string, source: string): string => {
    // `type X` / `type X as Y` / `X as Y` / `X`
    return clause
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const typePrefix = part.startsWith("type ") ? "type " : "";
            const body = typePrefix ? part.slice(5).trim() : part;
            const [name, alias] = body.split(/\s+as\s+/).map((value) => value.trim());
            const mapped = TAG_MAP[name!] ?? name!;
            return `${typePrefix}${mapped}${alias ? ` as ${alias}` : ""}`;
        })
        .join(", ");
};

const processImport = (statement: string): string => {
    const match = /^import\s+(type\s+)?([\s\S]+?)\s+from\s+["']([^"']+)["'];?$/.exec(statement.trim());
    if (!match) return statement;
    const [, typeOnly, rawClause, rawSource] = match;
    let source = rawSource!;

    // path-only moves
    for (const [pattern, target] of PATH_MOVES) {
        if (pattern.test(source)) {
            source = source.replace(pattern, target);
            break;
        }
    }

    if (PACKAGE_PATHS.has(rawSource!)) source = "@pg/ui";

    if (source !== "@/tables/tableRegistry" && !source.startsWith("@/tables/") && !source.startsWith("@/forms/") && !source.startsWith("@/printables") && !source.startsWith("@/charts/") && !source.startsWith("@/features/")) {
        if (source === rawSource && !PACKAGE_PATHS.has(rawSource!)) return statement;
    }

    let clause = rawClause!;
    // default import
    const defaultMatch = /^([A-Za-z_$][\w$]*)(?:\s*,\s*\{([\s\S]+)\})?$/.exec(clause);
    const namespace = /^\*\s+as\s+/.test(clause);
    if (!namespace && defaultMatch && !clause.startsWith("{")) {
        const local = defaultMatch[1]!;
        const rest = defaultMatch[2]?.trim();
        const preferred = DEFAULT_ALIAS[rawSource!] ?? local;
        const named = `${preferred === local ? preferred : `${preferred} as ${local}`}${rest ? `, ${rewriteImportNames(rest, rawSource!)}` : ""}`;
        return `import ${typeOnly ?? ""}{ ${named} } from "${source}";`;
    }

    if (clause.startsWith("{")) {
        const inner = clause.slice(1, -1);
        return `import ${typeOnly ?? ""}{ ${rewriteImportNames(inner, rawSource!)} } from "${source}";`;
    }

    return `import ${typeOnly ?? ""}${clause} from "${source}";`;
};

let changed = 0;
const report: string[] = [];

for (const app of APPS) {
    const files: string[] = [];
    walk(join(ROOT, app, "src"), files);
    for (const file of files) {
        const before = readFileSync(file, "utf8");
        let after = before;

        // 1. import statements
        after = after.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, (statement) => processImport(statement));

        // 2. JSX/identifier renames from the shim vocabulary
        for (const [from, to] of Object.entries(TAG_MAP)) {
            after = after.replace(new RegExp(`\\b${from}\\b`, "g"), to);
        }

        // 3. remove legacy CSS imports (the package tokens replace them)
        after = after.replace(/^import\s+["']@\/styles\/(?:fintech-minimal|vael-shim|vael-theme)\.css["'];?\n?/gm, "");

        if (after !== before) {
            changed += 1;
            report.push(relative(ROOT, file));
            if (!dryRun) writeFileSync(file, after);
        }
    }
}

console.log(`${dryRun ? "[dry-run] " : ""}rewrote ${changed} files`);
if (dryRun) console.log(report.slice(0, 40).join("\n"));
