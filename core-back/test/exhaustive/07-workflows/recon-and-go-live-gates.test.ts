/**
 * Suite 07.2 — statement parsing and the 12 go-live gates.
 */
import { describe, expect, test } from "bun:test";
import {
  parseCsvRows,
  parseStatementDate,
} from "../../../engine/reconciliation/StatementIngestor";
import {
  GoLiveGateValidator,
  type GoLiveEvidence,
} from "../../../engine/flow/GoLiveGateValidator";
import { MOCK_SCENARIOS } from "../../../engine/mockGateway/MockGatewayServer";

describe("Suite 07 · statement CSV parser", () => {
  const cases: Array<{ name: string; input: string; delimiter?: string; expected: string[][] }> = [
    { name: "comma", input: "a,b,c\n1,2,3\n", expected: [["a", "b", "c"], ["1", "2", "3"]] },
    { name: "semicolon", input: "a;b;c\n1;2;3", delimiter: ";", expected: [["a", "b", "c"], ["1", "2", "3"]] },
    { name: "tab", input: "a\tb\n1\t2", delimiter: "\t", expected: [["a", "b"], ["1", "2"]] },
    { name: "CRLF", input: "a,b\r\n1,2\r\n", expected: [["a", "b"], ["1", "2"]] },
    { name: "quoted comma", input: '"a,b",c', expected: [["a,b", "c"]] },
    { name: "escaped quote", input: '"a""b",c', expected: [['a"b', "c"]] },
    { name: "Arabic values", input: "الاسم,المبلغ\nمحمد,100.0000", expected: [["الاسم", "المبلغ"], ["محمد", "100.0000"]] },
    { name: "empty rows filtered", input: "a,b\n\n\n1,2\n", expected: [["a", "b"], ["1", "2"]] },
    { name: "trailing field without newline", input: "a,b\n1,2", expected: [["a", "b"], ["1", "2"]] },
  ];
  for (const entry of cases) {
    test(`parses ${entry.name}`, () => {
      expect(parseCsvRows(entry.input, entry.delimiter)).toEqual(entry.expected);
    });
  }

  test("a quoted newline stays inside the field", () => {
    expect(parseCsvRows('"a\nb",c')).toEqual([["a\nb", "c"]]);
  });
});

describe("Suite 07 · statement date parser", () => {
  const cases: Array<{ value: string; format?: string; expected: string | null }> = [
    { value: "2026-01-02T03:04:05.000Z", expected: "2026-01-02T03:04:05.000Z" },
    { value: "2026-01-02", format: "YYYY-MM-DD", expected: "2026-01-02T00:00:00.000Z" },
    { value: "02/01/2026", format: "DD/MM/YYYY", expected: "2026-01-02T00:00:00.000Z" },
    { value: "20260102030405", format: "YYYYMMDDHHmmss", expected: "2026-01-02T03:04:05.000Z" },
    { value: "2026-02-30", format: "YYYY-MM-DD", expected: "2026-03-02T00:00:00.000Z" },
    { value: "", expected: null },
    { value: "not-a-date", expected: null },
    { value: "2026/01/02", format: "YYYY-MM-DD", expected: null },
  ];
  for (const entry of cases) {
    test(`${entry.value || "<empty>"} with ${entry.format ?? "native"}`, () => {
      const parsed = parseStatementDate(entry.value, entry.format);
      expect(parsed?.toISOString() ?? null).toBe(entry.expected);
    });
  }
});

const passingEvidence = (): GoLiveEvidence => ({
  makerUserId: "maker-1",
  checkerUserId: "checker-1",
  scenarioResults: MOCK_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
  amountPipelineContractPassed: true,
  referenceFormatContractPassed: true,
  cryptographicSignatureContractPassed: true,
  channels: [{ type: "WEBHOOK", verificationMethod: "HMAC_BODY", mustInquire: false }],
  rollbackVersionId: "version-0",
  routeLimitsPreviewed: true,
  commissionProfilePreviewed: true,
  statementParserPreviewed: true,
  evidenceLevel: "VERIFIED",
  internalContractSuitePassed: true,
  highRiskExecutiveAcceptanceSigned: true,
  panFieldCount: 0,
  pciScopeReviewPassed: true,
  canaryTrafficPlanConfigured: true,
  routeAlertsConfigured: true,
  runbooksConfigured: true,
});

describe("Suite 07 · 12 go-live gates", () => {
  const validator = new GoLiveGateValidator();

  test("a fully evidenced version passes all 12 gates", async () => {
    const result = await validator.validate(passingEvidence());
    expect(result.passed).toBe(true);
    expect(result.gates).toHaveLength(12);
    expect(result.failedGateIds).toEqual([]);
  });

  test("assertGoLive resolves for a passing version", async () => {
    await expect(validator.assertGoLive(passingEvidence())).resolves.toBeDefined();
  });

  const failures: Array<{ name: string; gate: string; mutate: (evidence: GoLiveEvidence) => GoLiveEvidence }> = [
    { name: "maker = checker", gate: "MAKER_CHECKER_APPROVAL", mutate: (e) => ({ ...e, checkerUserId: "maker-1" }) },
    { name: "SYSTEM_AUTOMATION checker", gate: "MAKER_CHECKER_APPROVAL", mutate: (e) => ({ ...e, checkerUserId: "SYSTEM_AUTOMATION" }) },
    { name: "missing scenario", gate: "SANDBOX_SCENARIO_SUITE", mutate: (e) => ({ ...e, scenarioResults: e.scenarioResults.slice(1) }) },
    { name: "amount pipeline red", gate: "AMOUNT_PIPELINE_CONTRACT", mutate: (e) => ({ ...e, amountPipelineContractPassed: false }) },
    { name: "reference format red", gate: "REFERENCE_FORMAT_CONTRACT", mutate: (e) => ({ ...e, referenceFormatContractPassed: false }) },
    { name: "crypto contract red", gate: "CRYPTO_SIGNATURE_CONTRACT", mutate: (e) => ({ ...e, cryptographicSignatureContractPassed: false }) },
    { name: "weak channel", gate: "CHANNEL_VERIFICATION_STRENGTH", mutate: (e) => ({ ...e, channels: [{ type: "WEBHOOK", verificationMethod: "SHARED_TOKEN", mustInquire: false }] }) },
    { name: "no channel", gate: "CHANNEL_VERIFICATION_STRENGTH", mutate: (e) => ({ ...e, channels: [] }) },
    { name: "no rollback", gate: "ROLLBACK_VERSION", mutate: (e) => ({ ...e, rollbackVersionId: null }) },
    { name: "route limits not previewed", gate: "ROUTE_LIMITS_AND_PREVIEWS", mutate: (e) => ({ ...e, routeLimitsPreviewed: false }) },
    { name: "commission not previewed", gate: "ROUTE_LIMITS_AND_PREVIEWS", mutate: (e) => ({ ...e, commissionProfilePreviewed: false }) },
    { name: "statement parser not previewed", gate: "ROUTE_LIMITS_AND_PREVIEWS", mutate: (e) => ({ ...e, statementParserPreviewed: false }) },
    { name: "unverified evidence", gate: "EVIDENCE_LEVEL", mutate: (e) => ({ ...e, evidenceLevel: "UNVERIFIED" }) },
    { name: "PAN without PCI review", gate: "PCI_SCOPE_REVIEW", mutate: (e) => ({ ...e, panFieldCount: 1, pciScopeReviewPassed: false }) },
    { name: "no canary plan", gate: "CANARY_TRAFFIC_PLAN", mutate: (e) => ({ ...e, canaryTrafficPlanConfigured: false }) },
    { name: "no route alerts", gate: "ALERTS_AND_RUNBOOKS", mutate: (e) => ({ ...e, routeAlertsConfigured: false }) },
    { name: "no runbooks", gate: "ALERTS_AND_RUNBOOKS", mutate: (e) => ({ ...e, runbooksConfigured: false }) },
  ];

  for (const failure of failures) {
    test(`${failure.name} blocks go-live at ${failure.gate}`, async () => {
      const result = await validator.validate(failure.mutate(passingEvidence()));
      expect(result.passed).toBe(false);
      expect(result.failedGateIds).toContain(failure.gate as never);
      await expect(validator.assertGoLive(failure.mutate(passingEvidence()))).rejects.toThrow();
    });
  }

  test("an INTERNAL rail needs the internal contract suite", async () => {
    const blocked = await validator.validate({
      ...passingEvidence(),
      evidenceLevel: "INTERNAL",
      internalContractSuitePassed: false,
    });
    expect(blocked.failedGateIds).toContain("EVIDENCE_LEVEL");
    const passed = await validator.validate({
      ...passingEvidence(),
      evidenceLevel: "INTERNAL",
      internalContractSuitePassed: true,
    });
    expect(passed.passed).toBe(true);
  });

  test("a HIGH_RISK rail needs executive acceptance", async () => {
    const blocked = await validator.validate({
      ...passingEvidence(),
      evidenceLevel: "HIGH_RISK",
      highRiskExecutiveAcceptanceSigned: false,
    });
    expect(blocked.failedGateIds).toContain("EVIDENCE_LEVEL");
  });

  test("a PAN field with a completed PCI review passes", async () => {
    const result = await validator.validate({
      ...passingEvidence(),
      panFieldCount: 2,
      pciScopeReviewPassed: true,
    });
    expect(result.passed).toBe(true);
  });

  test("every gate has a unique number 1..12", async () => {
    const result = await validator.validate(passingEvidence());
    const numbers = result.gates.map((gate) => gate.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
