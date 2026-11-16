import { describe, expect, test } from "bun:test";
import { previewAccessDecision } from "../api/internal/reportPreviewPolicy";

/**
 * Regression: the staff report preview (POST /report-engine/specs/preview) executes a draft against live data but
 * only required an authoring or review authority: it never checked the access policy a published report gets and it
 * left no trace. These tests pin the access decision; the source checks pin its position in the route.
 */

const actor = (role: string, authorities: string[]) => ({ userId: "u1", email: "u1@example.test", role, authorities, isMaker: false, isChecker: false });
const ledgerDraft = {
  effectiveAccessPolicy: { mode: "INFERRED_STRICT" },
  inferredNaturalRoles: ["FINANCE", "COMPLIANCE"],
  inferredRequiredAuthorities: ["ledger:read", "audit:read"],
  queriedModels: ["journal_lines", "audit_log"],
};

describe("previewAccessDecision", () => {
  test("an author with only authoring authorities cannot preview a draft over ledger and audit data", () => {
    const decision = previewAccessDecision(ledgerDraft, actor("SUPPORT", ["report_engine:author", "report:review"]));
    expect(decision.allowed).toBe(false);
    expect(decision.requiredAuthorities).toEqual(["ledger:read", "audit:read"]);
    expect(decision.queriedModels).toEqual(["journal_lines", "audit_log"]);
  });

  test("holding only some of the required authorities is not enough", () => {
    expect(previewAccessDecision(ledgerDraft, actor("SUPPORT", ["ledger:read"])).allowed).toBe(false);
  });

  test("holding every required authority, or a natural role, is enough", () => {
    expect(previewAccessDecision(ledgerDraft, actor("SUPPORT", ["ledger:read", "audit:read"])).allowed).toBe(true);
    expect(previewAccessDecision(ledgerDraft, actor("FINANCE", [])).allowed).toBe(true);
  });

  test("a security admin is always allowed, as for a published report", () => {
    expect(previewAccessDecision(ledgerDraft, actor("SECURITY_ADMIN", [])).allowed).toBe(true);
    expect(previewAccessDecision(ledgerDraft, actor("OPS", ["security:write"])).allowed).toBe(true);
  });

  test("a missing inference fails closed", () => {
    for (const inference of [null, undefined]) {
      const decision = previewAccessDecision(inference, actor("SUPPORT", ["report_engine:author", "report:review"]));
      expect(decision.allowed).toBe(false);
      expect(decision.queriedModels).toEqual([]);
    }
    expect(previewAccessDecision(null, actor("SECURITY_ADMIN", [])).allowed).toBe(true);
  });

  test("an inferred policy with no required authority admits only its natural roles", () => {
    const rolesOnly = { effectiveAccessPolicy: { mode: "INFERRED_STRICT" }, inferredNaturalRoles: ["COMPLIANCE"], inferredRequiredAuthorities: [] };
    expect(previewAccessDecision(rolesOnly, actor("SUPPORT", ["report_engine:author"])).allowed).toBe(false);
    expect(previewAccessDecision(rolesOnly, actor("COMPLIANCE", [])).allowed).toBe(true);
  });
});

describe("the preview route", () => {
  const route = async () => {
    const source = (await Bun.file(new URL("../api/internal/adminReportEngine.ts", import.meta.url)).text()).split("\r\n").join("\n");
    const start = source.indexOf('router.post("/report-engine/specs/preview"');
    return source.slice(start, source.indexOf('router.post("/report-engine/specs"', start));
  };

  test("checks the access policy before it executes anything, and answers 403", async () => {
    const body = await route();
    const check = body.indexOf("previewAccessDecision(inference, actor)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf("engine.executeReport("));
    expect(body).toContain('throw new ApiError(403, "REPORT_ACCESS_DENIED"');
  });

  test("records the read in the audit log after it succeeded, never on a refused preview", async () => {
    const body = await route();
    expect(body).toContain('action: "REPORT_SPEC_PREVIEW_EXECUTED"');
    expect(body.indexOf("REPORT_SPEC_PREVIEW_EXECUTED")).toBeGreaterThan(body.indexOf("engine.executeReport("));
    expect(body.indexOf("REPORT_SPEC_PREVIEW_EXECUTED")).toBeGreaterThan(body.indexOf("REPORT_ACCESS_DENIED"));
  });
});
