import { describe, expect, test } from "bun:test";
import { GoLiveGateValidator, type GoLiveEvidence } from "../../engine/flow/GoLiveGateValidator";
import { MOCK_SCENARIOS } from "../../engine/mockGateway/MockGatewayServer";

const greenEvidence = (): GoLiveEvidence => ({
  makerUserId: "maker-1",
  checkerUserId: "checker-1",
  scenarioResults: MOCK_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
  amountPipelineContractPassed: true,
  referenceFormatContractPassed: true,
  cryptographicSignatureContractPassed: true,
  channels: [{ type: "WEBHOOK", verificationMethod: "HMAC_BODY", mustInquire: false }],
  rollbackVersionId: "version-1",
  routeLimitsPreviewed: true,
  commissionProfilePreviewed: true,
  statementParserPreviewed: true,
  evidenceLevel: "VERIFIED",
  panFieldCount: 0,
  canaryTrafficPlanConfigured: true,
  routeAlertsConfigured: true,
  runbooksConfigured: true,
});

describe("twelve go live gates", () => {
  const validator = new GoLiveGateValidator();

  test("evaluates exactly twelve gates", async () => {
    const result = await validator.validate(greenEvidence());
    expect(result.gates).toHaveLength(12);
    expect(result.gates.map((gate) => gate.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("passes with fully green evidence", async () => {
    const result = await validator.validate(greenEvidence());
    expect(result.passed).toBe(true);
    expect(result.failedGateIds).toEqual([]);
  });

  test("gate 1 fails when the checker equals the maker", async () => {
    const evidence = greenEvidence();
    evidence.checkerUserId = evidence.makerUserId;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("MAKER_CHECKER_APPROVAL");
  });

  test("gate 1 fails when SYSTEM_AUTOMATION is the checker", async () => {
    const evidence = greenEvidence();
    evidence.checkerUserId = "SYSTEM_AUTOMATION";
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("MAKER_CHECKER_APPROVAL");
  });

  test("gate 2 fails when a scenario has not passed", async () => {
    const evidence = greenEvidence();
    evidence.scenarioResults = evidence.scenarioResults.map((result) =>
      result.scenario === "CONFIRM_TIMEOUT" ? { ...result, passed: false } : result,
    );
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("SANDBOX_SCENARIO_SUITE");
  });

  test("gate 2 requires all fifteen scenarios", async () => {
    const evidence = greenEvidence();
    evidence.scenarioResults = evidence.scenarioResults.slice(0, 14);
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("SANDBOX_SCENARIO_SUITE");
    expect(MOCK_SCENARIOS).toHaveLength(15);
  });

  test("gates 3, 4 and 5 require the contract suites", async () => {
    const evidence = greenEvidence();
    evidence.amountPipelineContractPassed = false;
    evidence.referenceFormatContractPassed = false;
    evidence.cryptographicSignatureContractPassed = false;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("AMOUNT_PIPELINE_CONTRACT");
    expect(result.failedGateIds).toContain("REFERENCE_FORMAT_CONTRACT");
    expect(result.failedGateIds).toContain("CRYPTO_SIGNATURE_CONTRACT");
  });

  test("gate 6 requires must_inquire on weak channels", async () => {
    const evidence = greenEvidence();
    evidence.channels = [
      { type: "RETURN_URL", verificationMethod: "IP_ONLY", mustInquire: false },
    ];
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("CHANNEL_VERIFICATION_STRENGTH");
  });

  test("gate 7 requires a named rollback version", async () => {
    const evidence = greenEvidence();
    evidence.rollbackVersionId = null;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("ROLLBACK_VERSION");
  });

  test("gate 8 requires the route, commission and statement previews", async () => {
    const evidence = greenEvidence();
    evidence.routeLimitsPreviewed = false;
    evidence.commissionProfilePreviewed = false;
    evidence.statementParserPreviewed = false;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("ROUTE_LIMITS_AND_PREVIEWS");
  });

  test("gate 9 accepts an internal rail with a green contract suite", async () => {
    const evidence = greenEvidence();
    evidence.evidenceLevel = "INTERNAL";
    evidence.internalContractSuitePassed = true;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).not.toContain("EVIDENCE_LEVEL");
  });

  test("gate 9 rejects an internal rail without a green contract suite", async () => {
    const evidence = greenEvidence();
    evidence.evidenceLevel = "INTERNAL";
    evidence.internalContractSuitePassed = false;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("EVIDENCE_LEVEL");
  });

  test("gate 9 rejects an unverified evidence level", async () => {
    const evidence = greenEvidence();
    evidence.evidenceLevel = "PARTIAL";
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("EVIDENCE_LEVEL");
  });

  test("gate 10 requires a PCI scope review when PAN fields exist", async () => {
    const evidence = greenEvidence();
    evidence.panFieldCount = 1;
    evidence.pciScopeReviewPassed = false;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("PCI_SCOPE_REVIEW");
    evidence.pciScopeReviewPassed = true;
    const second = await validator.validate(evidence);
    expect(second.failedGateIds).not.toContain("PCI_SCOPE_REVIEW");
  });

  test("gate 11 requires a canary traffic plan", async () => {
    const evidence = greenEvidence();
    evidence.canaryTrafficPlanConfigured = false;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("CANARY_TRAFFIC_PLAN");
  });

  test("gate 12 requires route alerts and runbooks", async () => {
    const evidence = greenEvidence();
    evidence.routeAlertsConfigured = false;
    evidence.runbooksConfigured = false;
    const result = await validator.validate(evidence);
    expect(result.failedGateIds).toContain("ALERTS_AND_RUNBOOKS");
  });

  test("assertGoLive throws when a gate fails", async () => {
    const evidence = greenEvidence();
    evidence.runbooksConfigured = false;
    await expect(validator.assertGoLive(evidence)).rejects.toThrow();
  });
});
