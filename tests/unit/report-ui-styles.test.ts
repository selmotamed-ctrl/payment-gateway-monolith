import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const root = path.basename(cwd) === "tests" ? path.dirname(cwd) : cwd;

describe("report engine UI styles", () => {
  for (const portal of ["admin-front", "merchant-front"]) {
    test(`${portal} defines the report input grid and preview surfaces`, () => {
      const css = readFileSync(path.join(root, portal, "src/styles/fintech-minimal.css"), "utf8");
      expect(css).toContain(".report-input-grid {");
      expect(css).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
      expect(css).toContain("gap: 16px 20px;");
      expect(css).toContain(".report-paged-preview-frame");
      expect(css).toContain(".report-sandboxed-surface");
    });
  }
});

describe("report run form styling", () => {
  for (const portal of ["admin-front", "merchant-front"]) {
    test(`${portal} uses the table-filter anatomy for report run sections`, () => {
      const css = readFileSync(path.join(root, portal, "src/styles/fintech-minimal.css"), "utf8");
      for (const rule of [
        ".pg-report-form",
        ".pg-report-section",
        ".pg-report-section__title",
        ".pg-report-section__description",
        ".pg-report-section__fields",
        ".pg-report-field",
        ".pg-report-field__hint",
        ".pg-report-actions",
      ]) {
        expect(css, rule).toContain(`${rule} {`);
      }
      expect(css).toContain(".pg-slide-over {\n  max-width: 100vw;\n}");
    });
  }
});
