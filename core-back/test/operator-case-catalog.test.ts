import { describe, expect, test } from "bun:test";
import {
  actionsForCase,
  caseMetadata,
  caseReference,
  caseTypeForSubjectKey,
} from "../lib/operatorCases/caseCatalog";

describe("operator case catalog", () => {
  test("classifies the observed backup and regulatory cases", () => {
    const backup = caseMetadata({
      subjectKey: "platform.backup:backup-failed:all",
      kind: "MANUAL_REVIEW",
      title: "The latest all backup failed",
      detail: "Backup 7b174ce9 (delta) failed: storage object parity error",
    });
    expect(backup.caseType.code).toBe("BACKUP_FAILED");
    expect(backup.domain).toBe("OPERATIONS");
    expect(backup.titleText).toBe("The latest all backup failed");
    expect(backup.subjectLabel).toBe("all");
    expect(backup.confidentiality).toBe("NORMAL");

    const report = caseMetadata({
      subjectKey: "report.overdue:e84ff644-81d1-4c4a-8dbe-d11dd5a730e8",
      kind: "MANUAL_REVIEW",
      detail: "Regulatory report PSP-M 2026-10 was due 2026-11-10 and is still DRAFT",
    });
    expect(report.caseType.code).toBe("REPORT_OVERDUE");
    expect(report.domain).toBe("COMPLIANCE");
    expect(report.confidentiality).toBe("CONFIDENTIAL");
    expect(report.subjectType).toBe("REGULATORY_REPORT");
  });

  test("payment and reconciliation cases keep their source", () => {
    expect(caseTypeForSubjectKey("attempt.unknown:abc", "UNKNOWN", true, false).code).toBe("ATTEMPT_UNKNOWN");
    expect(caseTypeForSubjectKey("recon.item:abc", "MISMATCH", false, true, "amount mismatch").code).toBe("RECON_AMOUNT_MISMATCH");
    expect(caseTypeForSubjectKey(null, "CONFLICT", true, false).code).toBe("ATTEMPT_CONFLICT");
    expect(caseTypeForSubjectKey(null, "MANUAL_REVIEW", false, false).code).toBe("LEGACY_UNCLASSIFIED");
  });

  test("only attempt types expose payment resolution actions", () => {
    const attempt = actionsForCase(caseTypeForSubjectKey(null, "UNKNOWN", true, false), true).map((action) => action.code);
    const backup = actionsForCase(caseTypeForSubjectKey("platform.backup:backup-failed:all", "MANUAL_REVIEW", false, false), false).map((action) => action.code);
    expect(attempt).toContain("MARK_SUCCEEDED");
    expect(attempt).toContain("MARK_FAILED");
    expect(backup).not.toContain("MARK_SUCCEEDED");
    expect(backup).not.toContain("MARK_FAILED");
    expect(backup).toContain("CLOSE_CASE");
    expect(backup).toContain("ACKNOWLEDGE");
  });

  test("human case references do not expose the raw UUID", () => {
    expect(caseReference(123, "2026-11-16T10:00:00.000Z")).toBe("CASE-2026-00123");
  });
});
