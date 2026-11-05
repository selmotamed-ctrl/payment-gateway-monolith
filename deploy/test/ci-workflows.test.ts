import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

describe("GAP-014 CI and legacy deploy workflows", () => {
  test("root CI runs the AGENTS.md gate", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("bun scripts/project-design/build.ts --check");
    expect(ci).toContain("bun install --frozen-lockfile");
    expect(ci).toContain("bun run typecheck");
    expect(ci).toContain("bun test");
    expect(ci).toContain("bun run build");
    for (const w of ["core-back", "deploy", "deploy/backup-daemon", "admin-back", "merchant-back", "checkout-back", "admin-front", "merchant-front", "checkout-front"]) {
      expect(ci).toContain(`- ${w}`);
    }
  });
  for (const svc of ["core-back", "admin-back", "merchant-back", "checkout-back"]) {
    test(`${svc} legacy deploy workflow is manual, tested and host-key pinned`, () => {
      const path = `${svc}/.github/workflows/deploy.yml`;
      expect(existsSync(join(root, path))).toBe(true);
      const y = read(path);
      expect(y).not.toMatch(/^\s*push:/m);
      expect(y).toContain("workflow_dispatch");
      expect(y).not.toContain("StrictHostKeyChecking=no");
      expect(y).not.toContain("ssh-keyscan");
      expect(y).not.toMatch(/--delete/);
      expect(y).toContain("StrictHostKeyChecking=yes");
      expect(y).toContain("secrets.SSH_KNOWN_HOSTS");
      expect(y).toContain("bun test");
      expect(y).toContain("needs: test");
    });
  }
});
