import { beforeEach, describe, expect, test } from "bun:test";
import { rollbackGatewayVersionInTransaction } from "../api/internal/admin";
import { MOCK_SCENARIOS } from "../engine/mockGateway/MockGatewayServer";
import {
  createFakePrisma,
  fakeTable,
  resetFakeDatabase,
  type FakePrisma,
} from "./helpers/governanceFake";

const attachEvidenceModel = (client: FakePrisma): void => {
  client.gatewayVersionEvidence = {
    async findUnique(args: { where: { gatewayVersionId: string } }) {
      return fakeTable("gatewayVersionEvidence")
        .find((row) => row.gatewayVersionId === args.where.gatewayVersionId) ?? null;
    },
  };
};

const greenEvidence = (): Record<string, unknown> => ({
  scenarioResults: MOCK_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
  amountPipelineContractPassed: true,
  referenceFormatContractPassed: true,
  cryptographicSignatureContractPassed: true,
  channels: [{ type: "WEBHOOK", verificationMethod: "HMAC_BODY", mustInquire: false }],
  rollbackVersionId: "version-older",
  routeLimitsPreviewed: true,
  commissionProfilePreviewed: true,
  statementParserPreviewed: true,
  evidenceLevel: "VERIFIED",
  internalContractSuitePassed: true,
  highRiskExecutiveAcceptanceSigned: false,
  panFieldCount: 0,
  pciScopeReviewPassed: false,
  canaryTrafficPlanConfigured: true,
  routeAlertsConfigured: true,
  runbooksConfigured: true,
});

interface Fixture {
  client: FakePrisma;
}

const buildFixture = (options: { previousEvidence?: Record<string, unknown> | null } = {}): Fixture => {
  resetFakeDatabase();
  const client = createFakePrisma();
  attachEvidenceModel(client);

  client.gateway.create({
    data: { id: "gateway-1", code: "test_gw", status: "LIVE", activeVersionId: "version-current" },
  });
  client.gatewayVersion.create({
    data: {
      id: "version-older",
      gatewayId: "gateway-1",
      state: "SUPERSEDED",
      versionNumber: 0,
      createdById: "user-maker",
    },
  });
  client.gatewayVersion.create({
    data: {
      id: "version-previous",
      gatewayId: "gateway-1",
      state: "SUPERSEDED",
      versionNumber: 1,
      createdById: "user-maker",
      rollbackVersionId: "version-older",
    },
  });
  client.gatewayVersion.create({
    data: {
      id: "version-current",
      gatewayId: "gateway-1",
      state: "LIVE",
      versionNumber: 2,
      createdById: "user-maker",
      rollbackVersionId: "version-previous",
    },
  });
  client.gatewayVersion.create({
    data: {
      id: "version-draft",
      gatewayId: "gateway-1",
      state: "DRAFT",
      versionNumber: 3,
      createdById: "user-maker",
      rollbackVersionId: "version-previous",
    },
  });

  const previousEvidence = options.previousEvidence === undefined
    ? greenEvidence()
    : options.previousEvidence;
  if (previousEvidence) {
    fakeTable("gatewayVersionEvidence").push({
      id: "evidence-previous",
      gatewayVersionId: "version-previous",
      evidenceJson: previousEvidence,
    });
  }
  return { client };
};

const rollback = async (fixture: Fixture, versionId: string) =>
  fixture.client.$transaction(async (tx) =>
    rollbackGatewayVersionInTransaction(tx as never, "gateway-1", versionId, "user-checker"),
  );

const stateOf = (versionId: string): unknown =>
  fakeTable("gatewayVersion").find((row) => row.id === versionId)?.state;

describe("F-NEW-4: a rollback cannot bypass the twelve go-live gates", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  test("a rollback to a never-validated DRAFT version is refused", async () => {
    await expect(rollback(fixture, "version-draft")).rejects.toMatchObject({
      code: "GATEWAY_VERSION_NOT_ROLLBACKABLE",
      statusCode: 409,
    });

    expect(stateOf("version-draft")).toBe("DRAFT");
    expect(stateOf("version-current")).toBe("LIVE");
    expect(
      fakeTable("gateway").find((row) => row.id === "gateway-1")?.activeVersionId,
    ).toBe("version-current");
  });

  test("a rollback to a previously LIVE version with green evidence succeeds", async () => {
    const gateway = await rollback(fixture, "version-previous");

    expect(String(gateway.activeVersionId)).toBe("version-previous");
    expect(stateOf("version-previous")).toBe("LIVE");
    expect(stateOf("version-current")).toBe("ROLLED_BACK");
    expect(
      fakeTable("gateway").find((row) => row.id === "gateway-1")?.activeVersionId,
    ).toBe("version-previous");
  });

  test("a previously live version with red evidence is refused and lists the failed gates", async () => {
    fixture = buildFixture({
      previousEvidence: { ...greenEvidence(), scenarioResults: [] },
    });

    await expect(rollback(fixture, "version-previous")).rejects.toMatchObject({
      code: "GO_LIVE_GATES_FAILED",
      statusCode: 409,
      details: { failedGateIds: expect.arrayContaining(["SANDBOX_SCENARIO_SUITE"]) },
    });

    expect(stateOf("version-previous")).toBe("SUPERSEDED");
    expect(stateOf("version-current")).toBe("LIVE");
  });

  test("a previously live version without persisted evidence is refused", async () => {
    fixture = buildFixture({ previousEvidence: null });

    await expect(rollback(fixture, "version-previous")).rejects.toMatchObject({
      code: "GO_LIVE_EVIDENCE_MISSING",
      statusCode: 409,
    });
  });
});
