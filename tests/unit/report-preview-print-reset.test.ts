import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const root = path.basename(cwd) === "tests" ? path.dirname(cwd) : cwd;

describe("report preview print reset", () => {
  for (const portal of ["admin-front", "merchant-front"]) {
    test(`${portal} injects a print-only reset after Paged.js pagination`, () => {
      const bridge = readFileSync(path.join(root, portal, "public/report-engine/paged-preview-bridge.js"), "utf8");
      expect(bridge).toContain('style.setAttribute("media", "print")');
      expect(bridge).toContain(".pagedjs_pages { padding: 0 !important; gap: 0 !important; background: transparent !important; display: block !important; }");
      expect(bridge).toContain(".pagedjs_page { border: 0 !important; box-shadow: none !important; }");
      expect(bridge).toContain("ensurePreviewPrintResetRules();");
    });
  }

  test("the admin and merchant bridges stay identical", () => {
    const admin = readFileSync(path.join(root, "admin-front/public/report-engine/paged-preview-bridge.js"), "utf8");
    const merchant = readFileSync(path.join(root, "merchant-front/public/report-engine/paged-preview-bridge.js"), "utf8");
    expect(merchant).toBe(admin);
  });
});
