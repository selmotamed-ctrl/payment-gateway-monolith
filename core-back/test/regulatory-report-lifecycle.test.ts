import { beforeEach, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import {
  acknowledgeRegulatoryReport,
  createRegulatoryReportViaApproval,
  proposeReportingRulePromotion,
  submitRegulatoryReport,
} from "../api/internal/admin";
import { executeApprovalSubject } from "../engine/governance/GovernanceExecution";
import { createGovernanceFixture } from "./edge-cases/helpers";
import { fakeTable } from "./helpers/governanceFake";

const MAKER = "user-maker";
const CHECKER = "user-checker";
const RULE_ID = "rule-1";
const REPORT_SUBJECT = "attempt-1";

type Fixture = ReturnType<typeof createGovernanceFixture>;

const approve = async (fixture: Fixture, approvalRequestId: string, checkerUserId = CHECKER) => {
  const approval = fakeTable("approvalRequest").find((row) => row.id === approvalRequestId);
  if (!approval) {
    throw new Error(`approval ${approvalRequestId} not found`);
  }
  return executeApprovalSubject(fixture.context, fixture.client as never, {
    approval: {
      id: String(approval.id),
      subjectType: String(approval.subjectType),
      subjectId: String(approval.subjectId),
      payloadDiffJson: approval.payloadDiffJson,
      makerUserId: String(approval.makerUserId),
    },
    checkerUserId,
    checkerRole: checkerUserId === CHECKER ? "MLRO" : "COMPLIANCE",
  });
};

const seedProvisionalRule = async (fixture: Fixture): Promise<void> => {
  await fixture.client.reportingRule.create({
    data: {
      id: RULE_ID,
      authority: "CBL",
      reportType: "LARGE_TRANSACTION",
      thresholdAmount: new Decimal(50_000),
      windowSeconds: null,
      currency: "LYD",
      conditions: {},
      sourceReference: "CBL-LT-001",
      status: "PROVISIONAL",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
};

const createReport = async (fixture: Fixture) =>
  createRegulatoryReportViaApproval(
    fixture.client as never,
    {
      reportType: "LARGE_TRANSACTION",
      authority: "CBL",
      subjectType: "PAYMENT_ATTEMPT",
      subjectId: REPORT_SUBJECT,
      payload: {
        ruleId: RULE_ID,
        amount: "75000.0000",
        currency: "LYD",
        attemptId: REPORT_SUBJECT,
      },
    },
    { userId: MAKER, role: "COMPLIANCE" },
  );

const submit = (fixture: Fixture, reportId: string, actorUserId = CHECKER) =>
  submitRegulatoryReport(fixture.client as never, {
    reportId,
    submissionRef: "CBL-STR-2026-0001",
    actorUserId,
    actorRole: "MLRO",
  });

describe("F-D: regulatory report lifecycle and rule promotion", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = createGovernanceFixture();
    await seedProvisionalRule(fixture);
  });

  test("a report is created through an approval request and the checker approves it", async () => {
    const created = await createReport(fixture);

    const report = fakeTable("regulatoryReport").find((row) => row.id === created.reportId);
    expect(report?.status).toBe("PENDING_CHECKER");
    expect(report?.approvalRequestId).toBe(created.approvalRequestId);

    const approval = fakeTable("approvalRequest").find((row) => row.id === created.approvalRequestId);
    expect(approval?.subjectType).toBe("REGULATORY_REPORT");
    expect(approval?.subjectId).toBe(created.reportId);
    expect(approval?.makerUserId).toBe(MAKER);

    const result = await approve(fixture, created.approvalRequestId);
    expect(result.status).toBe("EXECUTED");
    expect(fakeTable("regulatoryReport").find((row) => row.id === created.reportId)?.status).toBe("APPROVED");
    expect(fakeTable("auditLog").some((row) => row.action === "REGULATORY_REPORT_APPROVED")).toBe(true);
  });

  test("a PROVISIONAL rule's report cannot be submitted (OD-1)", async () => {
    const created = await createReport(fixture);
    await approve(fixture, created.approvalRequestId);

    await expect(submit(fixture, created.reportId)).rejects.toMatchObject({
      code: "REPORTING_RULE_PROVISIONAL",
    });
    const report = fakeTable("regulatoryReport").find((row) => row.id === created.reportId);
    expect(report?.status).toBe("APPROVED");
    expect(report?.submissionRef ?? null).toBeNull();
  });

  test("the report maker can never be the checker or the submitter", async () => {
    const created = await createReport(fixture);

    await expect(approve(fixture, created.approvalRequestId, MAKER)).rejects.toMatchObject({
      code: "APPROVAL_MAKER_EQUALS_CHECKER",
    });
    expect(fakeTable("regulatoryReport").find((row) => row.id === created.reportId)?.status).toBe("PENDING_CHECKER");

    // Even after a real checker approves it, the maker cannot submit it.
    await approve(fixture, created.approvalRequestId);
    await expect(submit(fixture, created.reportId, MAKER)).rejects.toMatchObject({
      code: "APPROVAL_MAKER_EQUALS_CHECKER",
    });
  });

  test("a CONFIRMED report can be submitted and acknowledged", async () => {
    const created = await createReport(fixture);
    await approve(fixture, created.approvalRequestId);

    // Promotion only happens through a maker/checker approval.
    const promotion = await proposeReportingRulePromotion(fixture.client as never, {
      ruleId: RULE_ID,
      actorUserId: MAKER,
      actorRole: "COMPLIANCE",
    });
    expect(fakeTable("reportingRule").find((row) => row.id === RULE_ID)?.status).toBe("PROVISIONAL");

    await expect(approve(fixture, promotion.approvalRequestId, MAKER)).rejects.toMatchObject({
      code: "APPROVAL_MAKER_EQUALS_CHECKER",
    });
    expect(fakeTable("reportingRule").find((row) => row.id === RULE_ID)?.status).toBe("PROVISIONAL");

    const promotionResult = await approve(fixture, promotion.approvalRequestId, CHECKER);
    expect(promotionResult.status).toBe("EXECUTED");
    expect(fakeTable("reportingRule").find((row) => row.id === RULE_ID)?.status).toBe("CONFIRMED");
    expect(fakeTable("auditLog").some((row) => row.action === "REPORTING_RULE_CONFIRMED")).toBe(true);

    const submitted = await submit(fixture, created.reportId);
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submissionRef).toBe("CBL-STR-2026-0001");
    expect(submitted.submittedAt).toBeInstanceOf(Date);

    const acknowledged = await acknowledgeRegulatoryReport(fixture.client as never, {
      reportId: created.reportId,
      status: "ACKNOWLEDGED",
      actorUserId: CHECKER,
      actorRole: "MLRO",
    });
    expect(acknowledged.status).toBe("ACKNOWLEDGED");
    expect(fakeTable("regulatoryReport").find((row) => row.id === created.reportId)?.status).toBe("ACKNOWLEDGED");
    expect(fakeTable("auditLog").some((row) => row.action === "REGULATORY_REPORT_ACKNOWLEDGED")).toBe(true);
  });

  test("acknowledgement can record a rejection by the authority with a reason", async () => {
    const created = await createReport(fixture);
    await approve(fixture, created.approvalRequestId);
    await proposeReportingRulePromotion(fixture.client as never, {
      ruleId: RULE_ID,
      actorUserId: MAKER,
      actorRole: "COMPLIANCE",
    });
    const promotion = fakeTable("approvalRequest").find((row) => row.subjectType === "REPORTING_RULE");
    if (!promotion) {
      throw new Error("promotion approval not found");
    }
    await approve(fixture, String(promotion.id));
    await submit(fixture, created.reportId);

    await expect(
      acknowledgeRegulatoryReport(fixture.client as never, {
        reportId: created.reportId,
        status: "REJECTED_BY_AUTHORITY",
        actorUserId: CHECKER,
        actorRole: "MLRO",
      }),
    ).rejects.toMatchObject({ code: "REJECTION_REASON_REQUIRED" });

    const rejected = await acknowledgeRegulatoryReport(fixture.client as never, {
      reportId: created.reportId,
      status: "REJECTED_BY_AUTHORITY",
      reason: "Missing source reference",
      actorUserId: CHECKER,
      actorRole: "MLRO",
    });
    expect(rejected.status).toBe("REJECTED_BY_AUTHORITY");
    expect(rejected.reason).toBe("Missing source reference");
  });
});
