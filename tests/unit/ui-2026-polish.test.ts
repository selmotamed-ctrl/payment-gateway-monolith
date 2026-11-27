import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const root = path.basename(cwd) === "tests" ? path.dirname(cwd) : cwd;
const ui = (...parts: string[]) => path.join(root, "packages/ui/src", ...parts);
const read = (...parts: string[]) => readFileSync(ui(...parts), "utf8");

describe("@pg/ui 2026 interaction polish", () => {
  test("quiet page actions are outlined and press feedback never scales the label", () => {
    const actions = read("tokens", "parts", "actions.css");
    expect(actions).toMatch(/\.pg-btn--tonal\s*\{[^}]*background:\s*var\(--pg-bg-surface\)/s);
    expect(actions).toMatch(/\.pg-btn--tonal\s*\{[^}]*border:\s*1px solid var\(--pg-border-default\)/s);
    expect(actions).toMatch(/\.pg-btn:active[^{]*\{[^}]*transform:\s*translateY\(1px\)/s);
    expect(actions).not.toContain("scale(0.97)");
    expect(actions).not.toContain("scale(0.985)");
  });

  test("every input family uses one monochrome outline with no halo", () => {
    const inputs = read("tokens", "parts", "inputs-advanced.css");
    expect(inputs).toMatch(/\.pg-control-box:focus-within,[\s\S]*?outline:\s*2px solid var\(--pg-border-focus\) !important/s);
    expect(inputs).toMatch(/\.pg-chk:has\(\.pg-chk__native:focus-visible\) \.pg-chk__box[\s\S]*?box-shadow:\s*none !important/s);
    expect(inputs).toMatch(/\.pg-ac-panel\s*\{[^}]*padding:\s*0 !important/s);
    expect(inputs).toMatch(/\.pg-ac-panel\s*\{[^}]*border-radius:\s*0 !important/s);
    const finalTokens = read("tokens", "parts", "tokens-final.css");
    expect(finalTokens).toMatch(/:root\s*\{[^}]*--pg-border-focus:\s*#0f172a/s);
    expect(finalTokens).toMatch(/\[data-theme="dark"\][\s\S]*?--pg-border-focus:\s*#e4e4e7/s);
  });

  test("tables are flat and the sticky action column ends with a rule, not a shadow", () => {
    const table = read("tokens", "parts", "table.css");
    expect(table).toMatch(/\.pg-card\.pg-table-card[\s\S]*?border:\s*0 !important/s);
    expect(table).toMatch(/\.pg-table-shell \.pg-col-actions\s*\{[^}]*box-shadow:\s*none !important/s);
    expect(table).toMatch(/\.pg-table-shell \.pg-col-actions\s*\{[^}]*border-inline-start:\s*2px solid var\(--pg-border-strong\)/s);
    expect(table).toMatch(/\.pg-table-filters,[\s\S]*?border:\s*0 !important/s);
  });

  test("drawer bodies keep child height and the help inspector covers the app bar", () => {
    const overlays = read("tokens", "parts", "overlays.css");
    expect(overlays).toMatch(/\.pg-slideover__body > \*\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(overlays).toMatch(/\.guide-context-drawer\s*\{[^}]*inset-block:\s*0 !important/s);
    expect(overlays).toMatch(/\.guide-context-drawer\s*\{[^}]*height:\s*100dvh !important/s);
  });

  test("merchant sections use one symmetric body rhythm and table-only sections are flush", () => {
    const scss = readFileSync(path.join(root, "admin-front/src/styles/globals/app.scss"), "utf8");
    expect(scss).toMatch(/\.merchant-section__body\s*\{[^}]*padding:\s*20px 16px/s);
    expect(scss).toMatch(/\.merchant-section__body--flush\s*\{[^}]*padding:\s*0/s);
    const section = readFileSync(path.join(root, "admin-front/src/components/CollapsibleSection/index.tsx"), "utf8");
    expect(section).toContain('class="merchant-section__header"');
    expect(section).toContain('flush ? "merchant-section__body--flush" : ""');
  });
});
