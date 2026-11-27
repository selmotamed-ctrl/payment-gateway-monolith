/**
 * Pure governance rules for the 2026 Fintech UI architecture.
 *
 * The CLI gate (`scripts/ui-full-sweep-audit.ts`) feeds it the app sources and
 * fails the build. Keep it dependency-free so it can run in Bun, Vitest or CI.
 */

export interface GovernanceViolation {
    rule: string;
    file: string;
    line: number;
    snippet: string;
}

export interface SourceFile {
    file: string;
    source: string;
    isPage: boolean;
}

export interface GovernanceRule {
    id: string;
    message: string;
    regex: RegExp;
    pagesOnly?: boolean;
}

export const GOVERNANCE_RULES: GovernanceRule[] = [
    { id: "UI-01", regex: /<select\b/g, message: "Raw <select> forbidden; use <PgAutocomplete> from @pg/ui" },
    { id: "UI-02", regex: /<input\b[^>]*type=["'](?:date|datetime-local)["']/g, message: "Raw date <input> forbidden; use <PgDateInput> from @pg/ui" },
    { id: "UI-03", regex: /<input\b[^>]*type=["']checkbox["']/g, message: "Raw checkbox <input> forbidden; use <PgCheckbox> from @pg/ui" },
    { id: "UI-04", regex: /<(?:input|textarea)\b/g, message: "Raw <input>/<textarea> forbidden; use <PgTextField>/<PgSearchInput>/<PgTextarea> from @pg/ui" },
    { id: "UI-05", regex: /VuetifyShim|from\s+["']vael-ui|from\s+["']vuetify/g, message: "Direct VuetifyShim/vael-ui/vuetify import forbidden in app code; import from @pg/ui" },
    { id: "UI-06", regex: /#[0-9a-fA-F]{3,8}\b/g, message: "Hardcoded hex colour forbidden in pages; use a --pg-* CSS token", pagesOnly: true },
    { id: "UI-08", regex: /role=["']alert["']/g, message: "Hand-styled role='alert' div forbidden; use <PgAlert> from @pg/ui" },
    { id: "UI-09", regex: /-webkit-text-fill-color["']?\s*:\s*["']?transparent/g, message: "Broken transparent text-fill hack forbidden" },
];

/** Layout containers whose spacing is owned by `@pg/ui`. */
export const CONTAINER_TAGS = new Set([
    "PgPage",
    "PgCard",
    "PgDialog",
    "PgDrawer",
    "PgSection",
    "SurfaceCard",
    "PgFormModal",
    "PgDetailsDialog",
]);

const PADDING_PROPERTY = /\bpadding(?:Top|Bottom|Left|Right|Inline|Block)?\s*:/;

/** Scans one file's source. */
export const scanSource = (file: SourceFile): GovernanceViolation[] => {
    const violations: GovernanceViolation[] = [];
    const lines = file.source.split(/\r?\n/);
    lines.forEach((text, index) => {
        for (const rule of GOVERNANCE_RULES) {
            if (rule.pagesOnly && !file.isPage) continue;
            rule.regex.lastIndex = 0;
            if (rule.regex.test(text)) {
                violations.push({
                    rule: `${rule.id}: ${rule.message}`,
                    file: file.file,
                    line: index + 1,
                    snippet: text.trim().slice(0, 110),
                });
            }
        }
        // UI-07: only container padding is a policy violation.
        if (file.isPage && PADDING_PROPERTY.test(text)) {
            const before = lines.slice(Math.max(0, index - 20), index + 1).join("\n");
            const tags = [...before.matchAll(/<([A-Za-z][A-Za-z0-9_.]*)\b/g)];
            const tag = tags.length ? tags[tags.length - 1]![1] : "";
            if (CONTAINER_TAGS.has(tag)) {
                violations.push({
                    rule: "UI-07: Container padding override forbidden; use the PgPage/PgCard/PgDialog spacing policy",
                    file: file.file,
                    line: index + 1,
                    snippet: text.trim().slice(0, 110),
                });
            }
        }
    });
    return violations;
};

export const auditUiSources = (files: SourceFile[]): GovernanceViolation[] =>
    files.flatMap(scanSource);

/** UI-10: the same primitive directory must not exist in two or more portals. */
export const findDuplicatedComponentDirs = (
    apps: Array<{ app: string; dirs: string[] }>,
    primitives: ReadonlySet<string>,
): GovernanceViolation[] => {
    const occurrences = new Map<string, string[]>();
    for (const { app, dirs } of apps) {
        for (const dir of dirs) {
            if (!primitives.has(dir)) continue;
            occurrences.set(dir, [...(occurrences.get(dir) ?? []), app]);
        }
    }
    return [...occurrences.entries()]
        .filter(([, appList]) => appList.length >= 2)
        .map(([name, appList]) => ({
            rule: "UI-10: Duplicated primitive component directory; extract to packages/ui",
            file: `${name} (${appList.join(", ")})`,
            line: 0,
            snippet: `Found in ${appList.length} frontends`,
        }));
};

/** UI-11: the legacy drifted stylesheets must be gone. */
export const findLegacyStylesheets = (paths: Array<{ file: string; exists: boolean }>): GovernanceViolation[] =>
    paths
        .filter((entry) => entry.exists)
        .map((entry) => ({
            rule: "UI-11: Legacy duplicated stylesheet must be deleted (use @pg/ui/tokens)",
            file: entry.file,
            line: 0,
            snippet: entry.file.split("/").pop() ?? "",
        }));
