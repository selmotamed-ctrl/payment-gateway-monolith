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
    for (const w of ["deploy", "deploy/backup-daemon", "admin-back", "merchant-back", "checkout-back", "admin-front", "merchant-front", "checkout-front"]) {
      expect(ci).toContain(`- ${w}`);
    }
  });

  test("CI triggers on pushes to the default branch (master)", () => {
    const ci = read(".github/workflows/ci.yml");
    const branches = ci.match(/^\s*push:\s*\n(?:\s*#.*\n)*\s*branches:\s*\[([^\]]*)\]/m)?.[1] ?? "";
    expect(branches.split(",").map((name) => name.trim())).toContain("master");
  });

  test("core-back runs against real PostgreSQL 18 and Redis and fails when a suite is skipped", () => {
    const ci = read(".github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  core-back:"), ci.indexOf("\n  backend:"));
    expect(job.length).toBeGreaterThan(0);
    expect(job).toContain("image: postgres:18");
    expect(job).toContain("55432:5432");
    expect(job).toContain("image: redis:7");
    expect(job).toContain("56379:6379");
    expect(job).toContain("working-directory: core-back");
    for (const step of ["migrate-generate", "generate-mtls-certs", "migrate-deploy", "bun run typecheck", "bun test"]) {
      expect(job).toContain(step);
    }
    // A skipped database suite is green in bun, so the job has to fail on it explicitly.
    expect(job).toMatch(/grep -Eq '\^\[\[:space:\]\]\*\[0-9\]\+ skip'/);
    expect(job).toContain("exit 1");
    // The matrix must not run core-back a second time without the services.
    const matrix = ci.slice(ci.indexOf("\n  backend:"), ci.indexOf("\n  frontend:"));
    expect(matrix).not.toContain("- core-back");
  });

  test("the companion workflow only receives its signing secrets on the default branch", () => {
    const companion = read(".github/workflows/companion.yml");
    for (const secret of ["ANDROID_KEYSTORE_BASE64", "COMPANION_CONTENT_SIGNING_KEY"]) {
      expect(companion).toContain(
        `${secret}: \${{ github.ref_name == github.event.repository.default_branch && secrets.${secret} || '' }}`,
      );
    }
    expect(companion).toContain("if: env.ANDROID_KEYSTORE_BASE64 != ''");
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
