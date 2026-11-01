import { describe, expect, test } from "bun:test";
import {
  APPROVAL_DOMAIN_SUBJECT_TYPES,
  APPROVAL_PENDING_STATES,
  approvalAgeHours,
  approvalChangeKind,
  approvalDomain,
  approvalExpiresInHours,
  approvalIsExpired,
  approvalListRow,
  approvalSubjectTypeVariants,
  normalizeApprovalSubjectType,
} from "../lib/approvalQueue";

describe("approval queue helpers", () => {
  test("maps every subject type to a checker domain", () => {
    expect(approvalDomain("MERCHANT")).toBe("MERCHANT");
    expect(approvalDomain("JOIN_REQUEST")).toBe("ONBOARDING");
    expect(approvalDomain("ADJUSTMENT")).toBe("FINANCE");
    expect(approvalDomain("AML_CASE")).toBe("COMPLIANCE");
    expect(approvalDomain("GATEWAY_VERSION")).toBe("GATEWAY");
    expect(approvalDomain("USER")).toBe("SECURITY");
    expect(approvalDomain("UNKNOWN_SUBJECT")).toBe("OTHER");
    expect(normalizeApprovalSubjectType("JoinRequest")).toBe("JOIN_REQUEST");
    expect(normalizeApprovalSubjectType("OperatorCase")).toBe("OPERATOR_CASE");
    expect(normalizeApprovalSubjectType("GatewayVersion")).toBe("GATEWAY_VERSION");
    expect(approvalDomain("JoinRequest")).toBe("ONBOARDING");
    expect(approvalDomain("OperatorCase")).toBe("OPERATIONS");
    expect(approvalSubjectTypeVariants("JoinRequest")).toEqual(expect.arrayContaining(["JOIN_REQUEST", "JoinRequest", "join_request"]));
    const all = Object.values(APPROVAL_DOMAIN_SUBJECT_TYPES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(APPROVAL_PENDING_STATES).toEqual(["DRAFT", "PENDING_REVIEW"]);
  });

  test("derives a readable change kind from JSON patches and payloads", () => {
    expect(approvalChangeKind({ subjectType: "MERCHANT", payloadDiffJson: [{ op: "replace", path: "/name", value: "x" }] })).toBe("FIELD_EDIT");
    expect(approvalChangeKind({ subjectType: "MERCHANT", payloadDiffJson: { kind: "SUSPEND_EMERGENCY" } })).toBe("SUSPEND_EMERGENCY");
    expect(approvalChangeKind({ subjectType: "ADJUSTMENT", payloadDiffJson: { type: "CHARGEBACK" } })).toBe("CHARGEBACK");
    expect(approvalChangeKind({ subjectType: "AML_CASE", payloadDiffJson: { action: "HOLD" } })).toBe("HOLD");
    expect(approvalChangeKind({ subjectType: "MERCHANT", payloadDiffJson: {} })).toBe("EDIT");
    expect(approvalChangeKind({ subjectType: "USER", payloadDiffJson: {} })).toBe("CHANGE");
    expect(approvalChangeKind({ subjectType: "Adjustment", payloadDiffJson: { field: "status", from: "PENDING", to: "ACTIVE" } })).toBe("FIELD_EDIT");
  });

  test("computes ageing and expiry without negative ages", () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    expect(approvalAgeHours(new Date("2026-11-02T09:30:00.000Z"), now)).toBe(2);
    expect(approvalAgeHours(new Date("2026-11-02T13:00:00.000Z"), now)).toBe(0);
    expect(approvalExpiresInHours(new Date("2026-11-03T12:00:00.000Z"), now)).toBe(24);
    expect(approvalExpiresInHours(null, now)).toBeNull();
    expect(approvalIsExpired(new Date("2026-11-02T11:59:59.000Z"), now)).toBe(true);
    expect(approvalIsExpired(new Date("2026-11-02T12:00:01.000Z"), now)).toBe(false);
    expect(approvalIsExpired(null, now)).toBe(false);
  });

  test("projects the list row with domain, kind and SLA fields", () => {
    const createdAt = new Date("2026-11-02T10:00:00.000Z");
    const row = approvalListRow({
      id: "apr_1",
      subjectType: "ADJUSTMENT",
      subjectId: "adj_1",
      state: "PENDING_REVIEW",
      mode: "STANDARD",
      baseVersion: 3,
      payloadDiffJson: { type: "CHARGEBACK" },
      makerUserId: "usr_maker",
      makerReason: "chargeback",
      rejectionReason: null,
      riskAcceptanceNote: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date("2026-11-03T10:00:00.000Z"),
      ratifyDueAt: null,
      maker: { email: "maker@example.com" },
      checker: null,
    });
    expect(row.domain).toBe("FINANCE");
    expect(row.subjectType).toBe("ADJUSTMENT");
    expect(row.kind).toBe("CHARGEBACK");
    expect(row.makerName).toBe("maker@example.com");
    expect(row.checkerName).toBe("");
    expect(row.baseVersion).toBe(3);
    expect(row.expiresInHours).not.toBeNull();
  });
});
