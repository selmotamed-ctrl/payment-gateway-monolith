import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditUiSources, findDuplicatedComponentDirs, scanSource } from "../src/testing/governanceAudit";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src");
const read = (file: string) => fs.readFileSync(path.join(src, file), "utf-8");

describe("governance audit", () => {
    it("flags every raw native control and shim import", () => {
        const violations = scanSource({
            file: "admin-front/src/pages/test.tsx",
            isPage: true,
            source: `<select></select>\n<input type="date" />\n<input type="checkbox" />\n<input type="text" />\n<textarea />\nimport x from "vael-ui/vapor";`,
        });
        const ids = new Set(violations.map((violation) => violation.rule.slice(0, 5)));
        expect(ids).toEqual(new Set(["UI-01", "UI-02", "UI-03", "UI-04", "UI-05"]));
    });

    it("accepts a clean page that only uses @pg/ui controls", () => {
        const violations = auditUiSources([
            { file: "admin-front/src/pages/clean.tsx", isPage: true, source: "<PgTextField modelValue={x} />" },
        ]);
        expect(violations).toHaveLength(0);
    });

    it("flags hardcoded page colours but ignores non-page modules", () => {
        expect(scanSource({ file: "admin-front/src/pages/a.tsx", isPage: true, source: `color: "#123456"` })).toHaveLength(1);
        expect(scanSource({ file: "admin-front/src/lib/a.ts", isPage: false, source: `color: "#123456"` })).toHaveLength(0);
    });

    it("flags padding on layout containers, not on table cells", () => {
        expect(
            scanSource({
                file: "admin-front/src/pages/a.tsx",
                isPage: true,
                source: `<PgCard style={{ padding: "20px" }}>\n<td style={{ padding: "8px" }} />`,
            }).map((violation) => violation.rule.slice(0, 5)),
        ).toEqual(["UI-07"]);
    });

    it("flags hand-styled alerts and the transparent text hack", () => {
        const violations = scanSource({
            file: "admin-front/src/pages/a.tsx",
            isPage: true,
            source: `<div role="alert" />\nstyle={{ "-webkit-text-fill-color": "transparent" }}`,
        });
        expect(violations.map((violation) => violation.rule.slice(0, 5))).toEqual(["UI-08", "UI-09"]);
    });

    it("flags a primitive directory shared by two portals", () => {
        const violations = findDuplicatedComponentDirs(
            [
                { app: "admin-front", dirs: ["Table", "guide"] },
                { app: "merchant-front", dirs: ["Table"] },
            ],
            new Set(["Table"]),
        );
        expect(violations).toHaveLength(1);
        expect(violations[0]!.file).toContain("admin-front, merchant-front");
    });
});

describe("component source contracts", () => {
    it("PgAutocomplete never renders a native select and supports the full combobox lifecycle", () => {
        const source = read("inputs/PgAutocomplete.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(source).not.toContain("<select");
        expect(source).toContain("position: \"fixed\"");
        expect(source).toContain("ArrowDown");
        expect(source).toContain("Backspace");
        expect(source).toContain("pg-ac-chip");
        expect(source).toContain("commitTyped");
    });

    it("PgDateInput has a calendar grid, month jump and range presets", () => {
        const source = read("inputs/PgDateInput.tsx");
        expect(source).toContain("pg-cal-grid");
        expect(source).toContain("pg-date-presets");
        expect(source).toContain("Last 30 Days");
        expect(source).toContain("Year to Date");
        expect(source).not.toContain('<input type="date"');
    });

    it("PgDialog keeps the close button in the header flex slot", () => {
        const source = read("overlays/PgDialog.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(source).toContain("pg-dialog__header");
        expect(source).toContain("pg-dialog__close");
        expect(source).not.toContain("position: absolute");
        expect(source).toContain("pg-dialog__body");
        expect(source).toContain("pg-dialog__footer");
    });

    it("PgMetricStrip uses a seamless zero-gap grid rather than a border-coloured gap", () => {
        const layout = fs.readFileSync(path.resolve(here, "../src/tokens/layout-policy.css"), "utf-8");
        const rule = layout.slice(layout.indexOf(".pg-metric-strip"), layout.indexOf(".pg-metric-tile"));
        expect(rule).toContain("gap: 0");
        expect(rule).not.toContain("gap: 1px");
        expect(layout).toContain("inset -1px 0 0");
    });

    it("PgToast has the guaranteed auto-dismiss and pause behaviour", () => {
        const store = read("feedback/toastStore.ts");
        expect(store).toContain("4500");
        expect(store).toContain("6500");
        expect(store).toContain("pauseToast");
        expect(store).toContain("resumeToast");
        expect(store).toContain("toasts.value.length >= 4");
    });

    it("the design tokens define the neutral 2026 focus ring, not a blue glow", () => {
        const tokens = read("tokens/fintech-2026.css");
        expect(tokens).toContain("--pg-border-focus: #0f172a");
        expect(tokens).toContain("--pg-focus-ring: 0 0 0 3px rgba(15, 23, 42, 0.08)");
        expect(tokens).toContain("--pg-space-page-desktop: 28px 36px 56px 36px");
        expect(tokens).toContain("--pg-control-h-md: 40px");
    });
});
