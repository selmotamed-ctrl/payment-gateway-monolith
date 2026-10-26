import { MOCK_SCENARIOS, type MockScenario } from "../mockGateway/MockGatewayServer";

export type GoLiveGateId =
  | "MAKER_CHECKER_APPROVAL"
  | "SANDBOX_SCENARIO_SUITE"
  | "AMOUNT_PIPELINE_CONTRACT"
  | "REFERENCE_FORMAT_CONTRACT"
  | "CRYPTO_SIGNATURE_CONTRACT"
  | "CHANNEL_VERIFICATION_STRENGTH"
  | "ROLLBACK_VERSION"
  | "ROUTE_LIMITS_AND_PREVIEWS"
  | "EVIDENCE_LEVEL"
  | "PCI_SCOPE_REVIEW"
  | "CANARY_TRAFFIC_PLAN"
  | "ALERTS_AND_RUNBOOKS";

export type ChannelVerificationMethod =
  | "HMAC_BODY"
  | "HASH_FIELDS"
  | "SORTED_VALUES_HASH"
  | "RSA"
  | "SHARED_TOKEN"
  | "IP_ONLY"
  | "NONE_PLUS_INQUIRY";

export interface ScenarioContractResult {
  scenario: MockScenario | string;
  passed: boolean;
  details?: string;
}

export interface ChannelVerificationEvidence {
  type: string;
  verificationMethod: ChannelVerificationMethod;
  mustInquire: boolean;
}

export interface GoLiveEvidence {
  makerUserId: string;
  checkerUserId: string;
  scenarioResults: readonly ScenarioContractResult[];
  amountPipelineContractPassed: boolean;
  referenceFormatContractPassed: boolean;
  cryptographicSignatureContractPassed: boolean;
  channels: readonly ChannelVerificationEvidence[];
  rollbackVersionId?: string | null;
  routeLimitsPreviewed: boolean;
  commissionProfilePreviewed: boolean;
  statementParserPreviewed: boolean;
  evidenceLevel: "VERIFIED" | "INTERNAL" | "UNVERIFIED" | "PARTIAL" | "HIGH_RISK";
  internalContractSuitePassed?: boolean;
  highRiskExecutiveAcceptanceSigned?: boolean;
  panFieldCount?: number;
  pciScopeReviewPassed?: boolean;
  canaryTrafficPlanConfigured: boolean;
  routeAlertsConfigured: boolean;
  runbooksConfigured: boolean;
}

export interface GoLiveGateResult {
  id: GoLiveGateId;
  number: number;
  passed: boolean;
  reasons: readonly string[];
}

export interface GoLiveValidationResult {
  passed: boolean;
  gates: readonly GoLiveGateResult[];
  failedGateIds: readonly GoLiveGateId[];
}

export class GoLiveGateValidator {
  async validate(evidence: GoLiveEvidence): Promise<GoLiveValidationResult> {
    const gates: GoLiveGateResult[] = [
      this.makerCheckerGate(evidence),
      this.scenarioSuiteGate(evidence),
      this.booleanGate(
        3,
        "AMOUNT_PIPELINE_CONTRACT",
        evidence.amountPipelineContractPassed,
        "Amount pipeline contract test is not green",
      ),
      this.booleanGate(
        4,
        "REFERENCE_FORMAT_CONTRACT",
        evidence.referenceFormatContractPassed,
        "Reference format contract test is not green",
      ),
      this.booleanGate(
        5,
        "CRYPTO_SIGNATURE_CONTRACT",
        evidence.cryptographicSignatureContractPassed,
        "Cryptographic signature contract test is not green",
      ),
      this.channelStrengthGate(evidence),
      this.rollbackGate(evidence),
      this.routePreviewGate(evidence),
      this.evidenceLevelGate(evidence),
      this.pciGate(evidence),
      this.booleanGate(
        11,
        "CANARY_TRAFFIC_PLAN",
        evidence.canaryTrafficPlanConfigured,
        "Canary traffic plan is not configured",
      ),
      this.alertsAndRunbooksGate(evidence),
    ];
    const failedGateIds = gates.filter((gate) => !gate.passed).map((gate) => gate.id);
    return {
      passed: failedGateIds.length === 0,
      gates,
      failedGateIds,
    };
  }

  async assertGoLive(evidence: GoLiveEvidence): Promise<GoLiveValidationResult> {
    const result = await this.validate(evidence);
    if (!result.passed) {
      throw new Error(`Go-live validation failed: ${result.failedGateIds.join(", ")}`);
    }
    return result;
  }

  private makerCheckerGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const reasons: string[] = [];
    if (!evidence.makerUserId || !evidence.checkerUserId) {
      reasons.push("Maker and checker are required");
    }
    if (evidence.makerUserId === evidence.checkerUserId) {
      reasons.push("Checker must differ from maker");
    }
    if (evidence.checkerUserId === "SYSTEM_AUTOMATION") {
      reasons.push("SYSTEM_AUTOMATION cannot be a checker");
    }
    return { id: "MAKER_CHECKER_APPROVAL", number: 1, passed: reasons.length === 0, reasons };
  }

  private scenarioSuiteGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const reasons: string[] = [];
    const passedScenarios = new Set(
      evidence.scenarioResults.filter((result) => result.passed).map((result) => result.scenario),
    );
    for (const scenario of MOCK_SCENARIOS) {
      if (!passedScenarios.has(scenario)) {
        reasons.push(`Scenario '${scenario}' has not passed`);
      }
    }
    return { id: "SANDBOX_SCENARIO_SUITE", number: 2, passed: reasons.length === 0, reasons };
  }

  private booleanGate(
    number: number,
    id: GoLiveGateId,
    passed: boolean,
    reason: string,
  ): GoLiveGateResult {
    return { id, number, passed, reasons: passed ? [] : [reason] };
  }

  private channelStrengthGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const reasons = evidence.channels
      .filter((channel) => ["SHARED_TOKEN", "IP_ONLY"].includes(channel.verificationMethod) && !channel.mustInquire)
      .map((channel) => `Channel '${channel.type}' must require inquiry`);
    if (evidence.channels.length === 0) {
      reasons.push("At least one confirmation channel is required");
    }
    return { id: "CHANNEL_VERIFICATION_STRENGTH", number: 6, passed: reasons.length === 0, reasons };
  }

  private rollbackGate(evidence: GoLiveEvidence): GoLiveGateResult {
    return this.booleanGate(
      7,
      "ROLLBACK_VERSION",
      Boolean(evidence.rollbackVersionId),
      "Named rollback version is not configured",
    );
  }

  private routePreviewGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const reasons: string[] = [];
    if (!evidence.routeLimitsPreviewed) {
      reasons.push("Route limits have not been previewed");
    }
    if (!evidence.commissionProfilePreviewed) {
      reasons.push("Commission profile has not been previewed");
    }
    if (!evidence.statementParserPreviewed) {
      reasons.push("Statement parser has not been previewed");
    }
    return { id: "ROUTE_LIMITS_AND_PREVIEWS", number: 8, passed: reasons.length === 0, reasons };
  }

  private evidenceLevelGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const reasons: string[] = [];
    if (evidence.evidenceLevel === "VERIFIED") {
      return { id: "EVIDENCE_LEVEL", number: 9, passed: true, reasons };
    }
    if (evidence.evidenceLevel === "INTERNAL") {
      if (!evidence.internalContractSuitePassed) {
        reasons.push("Internal rail contract suite is not green");
      }
    } else if (evidence.evidenceLevel === "HIGH_RISK") {
      if (!evidence.highRiskExecutiveAcceptanceSigned) {
        reasons.push("High-risk executive acceptance is not signed");
      }
    } else {
      reasons.push(`Evidence level '${evidence.evidenceLevel}' is insufficient for go-live`);
    }
    return { id: "EVIDENCE_LEVEL", number: 9, passed: reasons.length === 0, reasons };
  }

  private pciGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const panFieldCount = evidence.panFieldCount ?? 0;
    if (panFieldCount === 0) {
      return { id: "PCI_SCOPE_REVIEW", number: 10, passed: true, reasons: [] };
    }
    return this.booleanGate(
      10,
      "PCI_SCOPE_REVIEW",
      evidence.pciScopeReviewPassed === true,
      "PCI scope review is required for PAN fields",
    );
  }

  private alertsAndRunbooksGate(evidence: GoLiveEvidence): GoLiveGateResult {
    const reasons: string[] = [];
    if (!evidence.routeAlertsConfigured) {
      reasons.push("Route alerts are not configured");
    }
    if (!evidence.runbooksConfigured) {
      reasons.push("Operational runbooks are not wired");
    }
    return { id: "ALERTS_AND_RUNBOOKS", number: 12, passed: reasons.length === 0, reasons };
  }
}
