import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const root = path.basename(cwd) === "tests" ? path.dirname(cwd) : cwd;

describe("dark-mode teleported overlays", () => {
  for (const portal of ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"]) {
    test(`${portal} gives every overlay the on-surface text color`, () => {
      const css = readFileSync(path.join(root, portal, "src/styles/fintech-minimal.css"), "utf8");
      expect(css).toMatch(/\.v-overlay__content\s*,\s*\.v-navigation-drawer__content\s*\{[^}]*color:\s*rgb\(var\(--v-theme-on-surface\)\)/s);
    });
  }
});
