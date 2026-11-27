import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const PORTALS = ["admin-front", "merchant-front", "checkout-front"];

describe("portal locale defaults", () => {
    it("boots English LTR on first paint in every portal", () => {
        for (const portal of PORTALS) {
            const html = fs.readFileSync(path.join(ROOT, portal, "index.html"), "utf-8");
            expect(html, portal).toContain('<html lang="en" dir="ltr">');
            expect(html, portal).not.toContain('lang="ar"');
        }
    });

    it("defaults the i18n locale to English and only Arabic when stored", () => {
        for (const portal of PORTALS) {
            const source = fs.readFileSync(path.join(ROOT, portal, "src/plugins/i18n.ts"), "utf-8");
            expect(source, portal).toContain('return stored === "ar" ? "ar" : "en";');
            expect(source, portal).not.toContain('return stored === "en" ? "en" : "ar";');
        }
    });
});
