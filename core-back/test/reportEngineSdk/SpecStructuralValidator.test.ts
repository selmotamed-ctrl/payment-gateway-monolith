import { describe, expect, test } from "bun:test";
import { validateSpecStructureAndI18n } from "../../lib/reportEngineSdk/verifier/SpecStructuralValidator";
import { baseReportSpec } from "./helpers";

describe("RE-T01 / RE-T02: structural and bilingual i18n validation", () => {
  test("RE-T01: a spec without the Arabic dictionary is rejected", () => {
    const spec = baseReportSpec();
    delete (spec.i18n.locales as Record<string, unknown>).ar;
    const result = validateSpecStructureAndI18n(spec);
    expect(result.spec).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "MISSING_DEFAULT_LOCALE_AR")).toBe(true);
    expect(result.diagnostics.every((d) => d.layer === 1)).toBe(true);
  });

  test("RE-T02: a declared locale missing a referenced translation key is rejected", () => {
    const spec = baseReportSpec();
    spec.i18n.locales.fr = { "report.title": "Resume" };
    const result = validateSpecStructureAndI18n(spec);
    expect(result.spec).not.toBeNull();
    const missing = result.diagnostics.filter((d) => d.code === "MISSING_I18N_KEY_FOR_LOCALE");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((d) => d.path.includes(".fr"))).toBe(true);
    expect(missing.every((d) => d.aiFixHint && d.aiFixHint.length > 0)).toBe(true);
  });

  test("a complete bilingual spec passes", () => {
    const result = validateSpecStructureAndI18n(baseReportSpec());
    expect(result.spec).not.toBeNull();
    expect(result.diagnostics).toEqual([]);
  });
});
