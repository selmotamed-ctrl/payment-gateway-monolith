import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PACKAGE = path.join(ROOT, "packages", "ui");
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf-8");

const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
};

const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const tokens = [
    "fintech-2026.css",
    "layout-policy.css",
    "components.css",
    ...fs.readdirSync(path.join(PACKAGE, "src/tokens/parts")).map((p) => `parts/${p}`),
]
    .map((file) => read(PACKAGE, "src/tokens", file))
    .join("\n");

describe("2026 fintech token contract", () => {
    it("loads tokens before layout and components", () => {
        const index = read(PACKAGE, "src/tokens/index.css");
        const order = ["vael-ui/style.css", "./fintech-2026.css", "./layout-policy.css", "./components.css"];
        let cursor = -1;
        for (const entry of order) {
            const next = index.indexOf(entry);
            expect(next, entry).toBeGreaterThan(cursor);
            cursor = next;
        }
    });

    it("uses a neutral focus ring and a four-step dark elevation ladder", () => {
        expect(tokens).toMatch(/--pg-border-focus:\s*#0f172a/);
        expect(tokens).toMatch(/--pg-border-focus:\s*#e4e4e7/);
        expect(tokens).toMatch(/--pg-focus-ring:\s*0 0 0 3px rgba\(15, 23, 42, 0\.08\)/);
        expect(tokens).toMatch(/--pg-bg-elevated:\s*#1e1e26/);
        expect(tokens).toMatch(/--pg-bg-canvas:\s*#09090b/);
    });

    it("owns the exact control heights and z-index scale", () => {
        expect(tokens).toMatch(/--pg-control-h-sm:\s*36px/);
        expect(tokens).toMatch(/--pg-control-h-md:\s*40px/);
        expect(tokens).toMatch(/--pg-control-h-lg:\s*44px/);
        expect(tokens).toMatch(/--pg-z-popover:\s*1200/);
        expect(tokens).toMatch(/--pg-z-tooltip:\s*1300/);
        expect(tokens).toMatch(/--pg-z-toast:\s*1500/);
    });
});

describe("global layout policy", () => {
    it("owns page, section, card and dialog spacing", () => {
        expect(tokens).toMatch(/\.pg-page\s*\{[^}]*padding:\s*var\(--pg-space-page-desktop\)/s);
        expect(tokens).toMatch(/\.pg-page\s+\.pg-page[^{]*\{[^}]*padding:\s*0/s);
        expect(tokens).toMatch(/\.pg-section\s*\{[^}]*gap:\s*var\(--pg-space-section\)/s);
        expect(tokens).toMatch(/\.pg-dialog__body\s*\{[^}]*padding/s);
    });

    it("never paints a second outline around the inner input", () => {
        expect(tokens).toMatch(/\.pg-control-native:focus[^{]*\{[^}]*outline:\s*none !important/s);
        expect(tokens).toMatch(/\.pg-control-box:focus-within[\s\S]{0,400}?box-shadow:\s*var\(--pg-focus-ring\)/);
    });

    it("balances 5 and 6 metric tiles without orphan rows", () => {
        expect(tokens).toMatch(/data-cols="5"[^}]*--pg-metric-cols:\s*5/);
        expect(tokens).toMatch(/data-cols="6"[^}]*--pg-metric-cols:\s*3/);
    });

    it("uses a seamless 1px hairline grid for detail fields", () => {
        expect(tokens).toMatch(/\.pg-field-grid\s*\{[^}]*gap:\s*1px/s);
        expect(tokens).toMatch(/\.pg-field-item\s*\{[^}]*background:\s*var\(--pg-bg-surface\)/s);
    });
});

describe("component class contract", () => {
    const required = [
        "pg-row-actions",
        "pg-row-actions__primary",
        "pg-row-actions__more",
        "pg-row-actions__panel",
        "pg-menu-divider",
        "pg-menu-item--danger",
        "pg-menu-trigger",
        "pg-z-popover",
        "pg-z-tooltip",
        "pg-toast__close",
        "pg-toast__action",
        "pg-toast__timer--paused",
        "pg-json-editor__frame",
        "pg-json-editor__frame--invalid",
        "pg-json-editor__gutter",
        "pg-json-editor__gutter-line",
        "pg-json-editor__gutter-line--error",
        "pg-json-editor__input",
        "pg-control-adornment--start",
        "pg-control-adornment--end",
        "pg-field--disabled",
        "pg-checkbox--bare",
        "pg-card--interactive",
        "pg-inline--wrap",
        "pg-form",
        "pg-field-item--interactive",
        "pg-section-fields--split",
        "pg-metric-tile__head",
        "pg-metric-loading",
        "pg-badge__label",
        "pg-command-backdrop",
        "pg-table-filter-surface",
        "pg-json-diff",
        "pg-sr-only",
        "pg-progress--brand",
        "pg-meta-pill--brand",
    ];
    it.each(required)("defines .%s", (name) => {
        expect(tokens, name).toContain(`.${name}`);
    });

    it("keeps the close buttons visually borderless and the row menu floating", () => {
        expect(tokens).toMatch(/\.pg-toast__close\s*\{[^}]*border:\s*0/s);
        expect(tokens).toMatch(/\.pg-row-actions__panel\s*\{[^}]*position:\s*fixed/s);
        expect(tokens).toMatch(/\.pg-row-actions__panel\s*\{[^}]*z-index:\s*var\(--pg-z-popover\)/s);
    });
});

describe("runtime purity", () => {
    const sources = walk(path.join(PACKAGE, "src")).filter((file) => !file.includes(`${path.sep}testing${path.sep}`));

    it("has no VDOM Teleport import anywhere in @pg/ui", () => {
        const offenders = sources.filter((file) => /import[^;]*\bTeleport\b[^;]*from\s+["']vue["']/.test(stripComments(read(file))));
        expect(offenders.map((file) => path.relative(PACKAGE, file))).toEqual([]);
    });

    it("owns every control natively (no vael-ui outside the provider bridge)", () => {
        const offenders = sources.filter(
            (file) => !file.endsWith("provider/PgProvider.tsx") && /from\s+["']vael-ui/.test(stripComments(read(file))),
        );
        expect(offenders.map((file) => path.relative(PACKAGE, file))).toEqual([]);
    });

    it("never renders a raw select or date input", () => {
        const offenders = sources.filter((file) => /<select\b|<input\b[^>]*type=["']date["']/.test(stripComments(read(file))));
        expect(offenders.map((file) => path.relative(PACKAGE, file))).toEqual([]);
    });
});

describe("portal defaults", () => {
    for (const portal of ["admin-front", "merchant-front", "checkout-front"]) {
        it(`${portal} boots English LTR`, () => {
            const html = read(ROOT, portal, "index.html");
            expect(html).toContain('<html lang="en" dir="ltr">');
        });
    }

    it("has no stray PageHeader parentheses anywhere", () => {
        const offenders: string[] = [];
        for (const app of ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"]) {
            for (const file of walk(path.join(ROOT, app, "src"))) {
                const source = read(file);
                if (
                    /<(?:PageHeader|PgPageHeader)[^>]*>\s*\(\s*$/m.test(source) ||
                    /^\s*\)\s*<\/(?:PageHeader|PgPageHeader)>/m.test(source)
                ) {
                    offenders.push(path.relative(ROOT, file));
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("keeps all duplicated chart directories deleted", () => {
        for (const app of ["admin-front", "merchant-front", "checkout-front"]) {
            expect(fs.existsSync(path.join(ROOT, app, "src", "charts"))).toBe(false);
        }
    });
});
