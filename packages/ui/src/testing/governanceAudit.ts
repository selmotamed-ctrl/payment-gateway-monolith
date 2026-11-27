/**
 * Pure governance rules for the 2026 Fintech UI architecture.
 *
 * The CLI gate (`scripts/ui-full-sweep-audit.ts`) feeds it the app sources and
 * fails the build. Keep it dependency-free so it can run in Bun, Vitest or CI.
 *
 * Rule catalogue (see `GOVERNANCE_RULE_CATALOG`):
 *   UI-01..UI-04  raw native controls
 *   UI-05         VuetifyShim / vael-ui / vuetify imports
 *   UI-06         hardcoded hex colours in pages
 *   UI-07         container padding overrides
 *   UI-08         hand-styled role="alert" divs
 *   UI-09         transparent text-fill hack
 *   UI-10         duplicated primitive directories
 *   UI-11         legacy drifted stylesheets
 *   UI-12         stray `<PageHeader ...>( ... )</PageHeader>` parentheses
 *   UI-13         VDOM `Teleport` imported from "vue" inside packages/ui/src
 *   UI-14         `.pg-*` classes referenced without a CSS definition
 *   UI-15         duplicated frontend `src/charts/` directories
 *   UI-16         raw native controls in route pages
 *   UI-17         legacy `VAlert` usage in app code
 *   UI-18         ad-hoc `pa-4` / `pa-6` padding on route pages
 *   UI-19         missing `mdi-*` names in the generated icon registry
 *   UI-20         conditional `v-slots` expression that drops the default slot
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
    /** "ui" for `packages/ui/src`; inferred from the path when omitted. */
    area?: "app" | "ui";
}

export interface GovernanceRule {
    id: string;
    message: string;
    regex: RegExp;
    pagesOnly?: boolean;
}

export interface CssSource {
    file: string;
    source: string;
}

export interface CssClassUsage {
    className: string;
    file: string;
    line: number;
    snippet: string;
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
    {
        id: "UI-20",
        regex: /v-slots=\{(?!\{)/g,
        message: "v-slots must be an object literal; a conditional expression silently drops the default slot",
    },
];

/** Every gate id/message, including the rules implemented by dedicated scanners. */
export const GOVERNANCE_RULE_CATALOG: Array<{ id: string; message: string; scope: string }> = [
    ...GOVERNANCE_RULES.map((rule) => ({
        id: rule.id,
        message: rule.message,
        scope: rule.pagesOnly ? "route pages" : "app sources",
    })),
    {
        id: "UI-07",
        message: "Container padding override forbidden; use the PgPage/PgCard/PgDialog spacing policy",
        scope: "route pages",
    },
    { id: "UI-10", message: "Duplicated primitive component directory; extract to packages/ui", scope: "all frontends" },
    { id: "UI-11", message: "Legacy duplicated stylesheet must be deleted (use @pg/ui/tokens)", scope: "all frontends" },
    { id: "UI-12", message: "Stray PageHeader parentheses forbidden; pass actions directly as children", scope: "all frontends" },
    { id: "UI-13", message: "VDOM Teleport import from \"vue\" forbidden inside packages/ui; use createIf + fixed positioning", scope: "packages/ui/src" },
    { id: "UI-14", message: "Referenced .pg-* CSS class has no definition in packages/ui tokens", scope: "packages/ui/src" },
    { id: "UI-15", message: "Frontend src/charts directory must be deleted; use PgChart from @pg/ui", scope: "all frontends" },
    { id: "UI-16", message: "Raw native control in route page; use the @pg/ui control", scope: "route pages" },
    { id: "UI-17", message: "Legacy VAlert usage forbidden; use <PgAlert> from @pg/ui", scope: "app sources" },
    { id: "UI-18", message: "Ad-hoc pa-4/pa-6 container padding forbidden in route pages; use PgPage/PgSection/PgCard spacing", scope: "route pages (table cells exempt)" },
    { id: "UI-19", message: "Literal mdi-* icon missing from packages/ui/src/actions/icons.generated.ts", scope: "packages/ui + all frontends" },
].sort((a, b) => a.id.localeCompare(b.id));

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

/**
 * Dynamic class prefixes built as `` `pg-x--${value}` ``. They cannot be
 * matched against a static CSS selector, so UI-14 ignores them by design. The
 * list is exported so the gate and the tests document the intentional
 * exceptions instead of rediscovering them as false positives.
 */
export const DYNAMIC_CSS_PREFIXES = [
    "pg-ac-",
    "pg-alert--",
    "pg-badge--",
    "pg-btn--",
    "pg-card--tone-",
    "pg-control-box--",
    "pg-dialog--",
    "pg-drawer--",
    "pg-field-",
    "pg-form-col-",
    "pg-meta-pill--",
    "pg-progress--",
    "pg-row-indicator--",
    "pg-spinner",
    "pg-status-",
    "pg-toast--",
] as const;

/** Dynamic element-id prefixes (not classes) that also appear in template literals. */
export const DYNAMIC_ID_PREFIXES = [
    "pg-ac-list-",
    "pg-ta-",
    "pg-table-filters-",
    "pg-tf-",
] as const;

/**
 * String literals that start with `pg-` but are not CSS classes. `pg-total` is
 * an ECharts stack id in `PgStatBarChartCard`, not a selector.
 */
export const NON_CSS_CLASS_TOKENS = new Set(["pg-total"]);

const PADDING_PROPERTY = /\bpadding(?:Top|Bottom|Left|Right|Inline|Block)?\s*:/;

const isUiSource = (file: SourceFile): boolean =>
    file.area === "ui" || (file.area !== "app" && /(^|\/)packages\/ui\//.test(file.file.replace(/\\/g, "/")));

const lineAt = (source: string, offset: number): number => {
    let line = 1;
    const end = Math.max(0, Math.min(offset, source.length));
    for (let index = 0; index < end; index += 1) {
        if (source[index] === "\n") line += 1;
    }
    return line;
};

const snippetAt = (source: string, offset: number): string => {
    const start = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
    const end = source.indexOf("\n", offset);
    const text = source.slice(start, end === -1 ? undefined : end).trim();
    return text.slice(0, 110);
};

const violation = (
    id: string,
    message: string,
    file: string,
    source: string,
    offset: number,
): GovernanceViolation => ({
    rule: `${id}: ${message}`,
    file,
    line: lineAt(source, offset),
    snippet: snippetAt(source, offset),
});

/** Scans one file's per-file rules (UI-01..UI-09 plus the app/UI-specific rules). */
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
    if (isUiSource(file)) {
        violations.push(...findTeleportImports([file]));
    } else {
        violations.push(
            ...findStrayPageHeaderParens([file]),
            ...findLegacyVAlert([file]),
            ...findAdHocPagePadding([file]),
        );
    }
    return violations;
};

/**
 * Finds the end of a JSX/HTML start tag while respecting quoted strings and
 * `{...}` attribute expressions, so a `>` inside a prop value cannot end the
 * tag early.
 */
const findTagEnd = (source: string, start: number): number => {
    let quote: string | null = null;
    let braces = 0;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index]!;
        if (quote) {
            if (char === "\\") index += 1;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "{") braces += 1;
        else if (char === "}") braces = Math.max(0, braces - 1);
        else if (char === ">" && braces === 0) return index;
    }
    return -1;
};

/**
 * UI-12: a `<PageHeader ...>` whose default slot starts with a bare `(`
 * wrapper (and therefore normally ends with a bare `)`), e.g.
 *
 *   <PageHeader ...>(
 *       <PgButton />
 *   )</PageHeader>
 *
 * A legitimate conditional (`>tab ? null : (`) has content before the
 * parenthesis and is not flagged.
 */
export const findStrayPageHeaderParens = (files: SourceFile[]): GovernanceViolation[] => {
    const violations: GovernanceViolation[] = [];
    for (const file of files) {
        if (isUiSource(file)) continue;
        const source = file.source;
        const opener = /<PageHeader\b/g;
        let match: RegExpExecArray | null;
        while ((match = opener.exec(source))) {
            const tagEnd = findTagEnd(source, match.index + match[0].length);
            if (tagEnd === -1) continue;
            // Self-closing header: nothing to scan.
            if (source.slice(match.index, tagEnd).trimEnd().endsWith("/")) continue;
            const close = source.indexOf("</PageHeader>", tagEnd + 1);
            if (close === -1) continue;
            const inner = source.slice(tagEnd + 1, close);
            const leading = inner.match(/^\s*\(/);
            if (!leading) {
                opener.lastIndex = tagEnd + 1;
                continue;
            }
            const openOffset = tagEnd + 1 + leading[0].lastIndexOf("(");
            violations.push(
                violation("UI-12", "Stray PageHeader parentheses forbidden; pass actions directly as children", file.file, source, openOffset),
            );
            const trailing = inner.match(/\)\s*$/);
            if (trailing) {
                const closeOffset = tagEnd + 1 + (trailing.index ?? 0);
                violations.push(
                    violation("UI-12", "Stray PageHeader parentheses forbidden; pass actions directly as children", file.file, source, closeOffset),
                );
            }
            opener.lastIndex = close + "</PageHeader>".length;
        }
    }
    return violations;
};

/** True when a `Teleport` import from "vue" (or an inline `<Teleport>`) appears. */
const TELEPORT_IMPORT = /import\s+(?:type\s+)?[^;]*?\bTeleport\b[^;]*?\bfrom\s*["']vue["']/gs;
const TELEPORT_JSX = /<Teleport\b/g;

/** UI-13: no VDOM `Teleport` inside `packages/ui/src`; use Vapor `createIf`. */
export const findTeleportImports = (files: SourceFile[]): GovernanceViolation[] => {
    const violations: GovernanceViolation[] = [];
    for (const file of files) {
        if (!isUiSource(file)) continue;
        // The governance scanner's own source mentions Teleport in comments and
        // regexes; it is tooling, not a rendered overlay.
        if (/(^|\/)packages\/ui\/src\/testing\//.test(file.file.replace(/\\/g, "/"))) continue;
        const source = file.source;
        for (const regex of [TELEPORT_IMPORT, TELEPORT_JSX]) {
            regex.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(source))) {
                violations.push(
                    violation(
                        "UI-13",
                        'VDOM Teleport import from "vue" forbidden inside packages/ui; use createIf + fixed positioning',
                        file.file,
                        source,
                        match.index,
                    ),
                );
            }
        }
    }
    return violations;
};

/** UI-16: raw native controls inside route pages (the existing UI-01..04 stay global). */
export const findRawPageControls = (files: SourceFile[]): GovernanceViolation[] => {
    const violations: GovernanceViolation[] = [];
    const regex = /<(?:select|input|textarea)\b/g;
    for (const file of files) {
        if (!file.isPage || isUiSource(file)) continue;
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(file.source))) {
            violations.push(
                violation("UI-16", "Raw native control in route page; use the @pg/ui control", file.file, file.source, match.index),
            );
        }
    }
    return violations;
};

/** UI-17: legacy `VAlert` references in app code (the @pg/ui alias itself is exempt). */
export const findLegacyVAlert = (files: SourceFile[]): GovernanceViolation[] => {
    const violations: GovernanceViolation[] = [];
    const regex = /\bVAlert\b/g;
    for (const file of files) {
        if (isUiSource(file)) continue;
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(file.source))) {
            violations.push(
                violation("UI-17", "Legacy VAlert usage forbidden; use <PgAlert> from @pg/ui", file.file, file.source, match.index),
            );
        }
    }
    return violations;
};

/**
 * UI-18: ad-hoc `pa-4` / `pa-6` padding classes on route pages. Table cells are
 * explicitly exempt because their padding is a local data-grid concern.
 */
export const findAdHocPagePadding = (files: SourceFile[]): GovernanceViolation[] => {
    const violations: GovernanceViolation[] = [];
    const regex = /\bpa-[46]\b/g;
    for (const file of files) {
        if (!file.isPage || isUiSource(file)) continue;
        file.source.split(/\r?\n/).forEach((line, index) => {
            if (!/(?:class|className)\s*=/.test(line)) return;
            if (/<(?:td|th)\b|\bTableCell\b/.test(line)) return;
            regex.lastIndex = 0;
            if (regex.test(line)) {
                violations.push({
                    rule: "UI-18: Ad-hoc pa-4/pa-6 container padding forbidden in route pages; use PgPage/PgSection/PgCard spacing",
                    file: file.file,
                    line: index + 1,
                    snippet: line.trim().slice(0, 110),
                });
            }
        });
    }
    return violations;
};

/**
 * Extracts every `.pg-*` class from the design-system CSS files. Comments are
 * stripped so a class mentioned only in prose is not considered defined.
 */
export const extractCssClasses = (sources: CssSource[]): Set<string> => {
    const classes = new Set<string>();
    for (const source of sources) {
        const css = source.source.replace(/\/\*[\s\S]*?\*\//g, "");
        for (const match of css.matchAll(/\.(pg-[A-Za-z0-9_-]+)/g)) {
            classes.add(match[1]!);
        }
    }
    return classes;
};

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const CLASS_TOKEN = /^pg-[A-Za-z0-9_-]+$/;

const isDynamicClassPrefix = (value: string): boolean =>
    value.endsWith("-") ||
    DYNAMIC_ID_PREFIXES.includes(value as (typeof DYNAMIC_ID_PREFIXES)[number]);

/**
 * Literal `.pg-*` class names used by a TSX file. Template literals are
 * ignored: `pg-btn--${size}` cannot be resolved statically, and the known
 * prefixes are exported above. String literals are split on whitespace so
 * `class="pg-a pg-b"` yields both classes.
 */
export const extractUsedCssClasses = (file: SourceFile): CssClassUsage[] => {
    const usages: CssClassUsage[] = [];
    const source = file.source;
    STRING_LITERAL.lastIndex = 0;
    let literal: RegExpExecArray | null;
    while ((literal = STRING_LITERAL.exec(source))) {
        const raw = literal[0]!;
        const content = raw.slice(1, -1);
        // Static chunks of a template literal are still checked; the dynamic
        // expression itself and known `pg-x--` prefixes are ignored.
        const staticContent = content.includes("${")
            ? content.replace(/\$\{[^}]*\}/g, " ")
            : content;
        const literalOffset = literal.index;
        for (const token of staticContent.split(/\s+/)) {
            if (!CLASS_TOKEN.test(token)) continue;
            if (isDynamicClassPrefix(token)) continue;
            if (NON_CSS_CLASS_TOKENS.has(token)) continue;
            const within = raw.indexOf(token);
            const offset = literalOffset + (within === -1 ? 1 : within);
            usages.push({
                className: token,
                file: file.file,
                line: lineAt(source, offset),
                snippet: snippetAt(source, offset),
            });
        }
    }
    return usages;
};

/** UI-14: every statically referenced `.pg-*` class must exist in the token CSS. */
export const findMissingCssClasses = (files: SourceFile[], cssSources: CssSource[]): GovernanceViolation[] => {
    const defined = extractCssClasses(cssSources);
    const violations: GovernanceViolation[] = [];
    for (const file of files) {
        if (!isUiSource(file)) continue;
        for (const usage of extractUsedCssClasses(file)) {
            if (defined.has(usage.className)) continue;
            violations.push({
                rule: `UI-14: Referenced .pg-* CSS class "${usage.className}" has no definition in packages/ui tokens`,
                file: usage.file,
                line: usage.line,
                snippet: usage.snippet,
            });
        }
    }
    return violations;
};

/** UI-15: the local `src/charts` directories must not exist in any frontend. */
export const findLegacyChartDirs = (paths: Array<{ file: string; exists: boolean }>): GovernanceViolation[] =>
    paths
        .filter((entry) => entry.exists)
        .map((entry) => ({
            rule: "UI-15: Frontend src/charts directory must be deleted; use PgChart from @pg/ui",
            file: entry.file,
            line: 0,
            snippet: entry.file.split("/").slice(-2).join("/"),
        }));

/** Alias kept for callers that describe UI-15 as the duplicated-charts rule. */
export const findDuplicatedChartDirs = findLegacyChartDirs;

/**
 * UI-19: every literal `mdi-*` name in the design system or the four portals
 * must exist in the generated registry. `icons.generated.ts` itself is skipped
 * so a stale registry cannot satisfy its own check.
 */
export const findMissingIconNames = (
    sources: SourceFile[],
    registry: string | ReadonlySet<string>,
): GovernanceViolation[] => {
    let names: ReadonlySet<string>;
    if (typeof registry === "string") {
        names = new Set([...registry.matchAll(/"([^"]+)"\s*:\s*mdi/g)].map((match) => match[1]!));
    } else {
        names = registry;
    }
    const violations: GovernanceViolation[] = [];
    const regex = /\bmdi-[a-z0-9-]+\b/g;
    for (const file of sources) {
        if (/(^|\/)icons\.generated\.ts$/.test(file.file)) continue;
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(file.source))) {
            if (names.has(match[0])) continue;
            violations.push(
                violation("UI-19", "Literal mdi-* icon missing from packages/ui/src/actions/icons.generated.ts", file.file, file.source, match.index),
            );
        }
    }
    return violations;
};

export const auditUiSources = (files: SourceFile[]): GovernanceViolation[] =>
    files.flatMap((file) => {
        if (isUiSource(file)) {
            // Raw-control/colour rules belong to application pages only. The
            // design system is the one place allowed to render native controls.
            return findTeleportImports([file]);
        }
        // UI-16 stays separate so `scanSource` keeps its historical UI-01..05
        // exact-set contract for direct callers.
        return [...scanSource(file), ...findRawPageControls([file])];
    });

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

export interface GovernanceAuditInput {
    appSources?: SourceFile[];
    uiSources?: SourceFile[];
    cssSources?: CssSource[];
    chartDirs?: Array<{ file: string; exists: boolean }>;
    primitiveDirs?: Array<{ app: string; dirs: string[] }>;
    primitives?: ReadonlySet<string>;
    legacyStylesheets?: Array<{ file: string; exists: boolean }>;
    iconRegistry?: string | ReadonlySet<string> | null;
    /** Files scanned for `mdi-*` literals; defaults to uiSources + appSources. */
    iconSources?: SourceFile[];
}

/**
 * One pure entry point used by the CLI and the governance test. It does not
 * touch the filesystem; callers provide the sources and existence probes.
 */
export const runGovernanceAudit = (input: GovernanceAuditInput): GovernanceViolation[] => {
    const appSources = input.appSources ?? [];
    const uiSources = input.uiSources ?? [];
    const uiTsx = uiSources.filter((file) => file.file.endsWith(".tsx"));
    const violations = auditUiSources([...appSources, ...uiSources]);
    violations.push(...findMissingCssClasses(uiTsx, input.cssSources ?? []));
    violations.push(...findLegacyChartDirs(input.chartDirs ?? []));
    if (input.primitiveDirs && input.primitives) {
        violations.push(...findDuplicatedComponentDirs(input.primitiveDirs, input.primitives));
    }
    violations.push(...findLegacyStylesheets(input.legacyStylesheets ?? []));
    if (input.iconRegistry !== null && input.iconRegistry !== undefined) {
        violations.push(...findMissingIconNames(input.iconSources ?? [...uiSources, ...appSources], input.iconRegistry));
    }
    return violations;
};
