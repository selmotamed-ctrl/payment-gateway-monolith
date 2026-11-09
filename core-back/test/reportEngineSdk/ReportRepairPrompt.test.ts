import { describe, expect, test } from "bun:test";
import { buildReportRepairPrompt } from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
import { baseReportSpec } from "./helpers";

describe("RE-T21: deterministic repair prompt", () => {
  test("contains all three paths, codes, hints and the original JSON", () => {
    const raw = JSON.stringify(baseReportSpec());
    const prompt = buildReportRepairPrompt(raw, [
      { layer: 1, severity: "error", path: "i18n.locales.ar", code: "MISSING_DEFAULT_LOCALE_AR", message: "Arabic is required", aiFixHint: "Add the ar dictionary." },
      { layer: 2, severity: "error", path: "datasets[0].where", code: "MANDATORY_PARTITION_FILTER_MISSING", message: "created_at missing", aiFixHint: "Bound created_at." },
      { layer: 2, severity: "error", path: "datasets[0].select[0]", code: "FORBIDDEN_SECRET_COLUMN", message: "Secret", aiFixHint: "Remove the secret column." },
    ]);
    for (const text of ["i18n.locales.ar", "MISSING_DEFAULT_LOCALE_AR", "datasets[0].where", "MANDATORY_PARTITION_FILTER_MISSING", "datasets[0].select[0]", "FORBIDDEN_SECRET_COLUMN", "Add the ar dictionary.", "Bound created_at.", "merchant-settlement-summary"]) {
      expect(prompt).toContain(text);
    }
    expect(prompt).toContain("Original");
  });
});
