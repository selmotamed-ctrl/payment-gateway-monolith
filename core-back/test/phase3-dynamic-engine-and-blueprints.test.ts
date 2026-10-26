import { describe, expect, test } from "bun:test";
import { DynamicRailEngine, type DynamicAttempt } from "../engine/flow/DynamicRailEngine";
import type { FlowStep } from "../engine/flow/StepExecutor";
import { MockGatewayServer, MOCK_SCENARIOS } from "../engine/mockGateway/MockGatewayServer";
import { GoLiveGateValidator } from "../engine/flow/GoLiveGateValidator";
import { BLUEPRINT_CATALOG } from "../prisma/seedBlueprints";
import { StepExecutor } from "../engine/flow/StepExecutor";
import { TransformPipeline } from "../engine/transforms/TransformPipeline";

const createAttempt = (overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => ({
  id: "attempt-1",
  reference: "PA-1",
  gatewayReference: "GW-1",
  status: "CREATED",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100.0000",
  totalChargedAmount: "100.0000",
  maxOtpAttempts: 3,
  otpAttempts: 0,
  ownershipMode: "PLATFORM_CLEARING",
  context: {},
  ...overrides,
});

const createHarness = (responseOverrides: Record<string, unknown> = {}) => {
  const attempts = new Map<string, DynamicAttempt>();
  const reserved: string[] = [];
  const released: string[] = [];
  const committed: string[] = [];
  const posted: string[] = [];
  const steps: FlowStep[] = [{ id: "submit", type: "HTTP", side_effect: "MOVES_MONEY" }];
  const engine = new DynamicRailEngine({
    attempts: {
      getAttempt: async (id) => attempts.get(id) ?? null,
      updateAttempt: async (id, patch) => {
        const attempt = attempts.get(id);
        if (!attempt) {
          throw new Error("attempt not found");
        }
        Object.assign(attempt, patch);
        return attempt;
      },
    },
    slots: {
      reserveSlot: async (attempt) => {
        reserved.push(attempt.id);
        return { reservationId: "slot-1" };
      },
      releaseSlot: async (attempt) => {
        released.push(attempt.id);
      },
      commitSlot: async (attempt) => {
        committed.push(attempt.id);
      },
    },
    flowProvider: {
      getSteps: async (phase) => (phase === "SUBMIT" ? steps : []),
    },
    stepExecutor: {
      execute: async (step: FlowStep) => ({
        stepId: step.id,
        status: "SUCCEEDED",
        output: { state: {}, public: {} },
        response: {
          status: "SUCCESS",
          reference: "GW-1",
          amount: "100.0000",
          currency: "LYD",
          environment: "SANDBOX",
          ...responseOverrides,
        },
        logs: [],
      }),
    } as never,
    ledgerPoster: {
      postPaymentConfirmation: async (refId: string) => {
        posted.push(refId);
        return { entry: { id: "entry-1" } };
      },
    },
  });
  return { engine, attempts, reserved, released, committed, posted };
};

describe("phase 3 production blueprints", () => {
  test("seeds exactly the seven production blueprints", () => {
    expect(BLUEPRINT_CATALOG.length).toBe(7);
    expect(BLUEPRINT_CATALOG.map((blueprint) => blueprint.key)).toEqual([
      "edfali-sadad-otp",
      "moamalat-lightbox",
      "cbl-lypay",
      "mypay-tlync-redirect",
      "hybrid-wallet-rails",
      "mpgs-evo-pay",
      "neompay-internal",
    ]);
  });

  test("the internal blueprint is a first party rail", () => {
    const internal = BLUEPRINT_CATALOG.find((blueprint) => blueprint.key === "neompay-internal");
    expect(internal?.kind).toBe("INTERNAL");
    expect(internal?.gatewayCodes).toContain("neompay");
  });

  test("every blueprint declares at least one rail and a collection mode", () => {
    for (const blueprint of BLUEPRINT_CATALOG) {
      expect(blueprint.railCodes.length).toBeGreaterThan(0);
      expect(blueprint.collectionModes.length).toBeGreaterThan(0);
      expect(blueprint.gatewayCodes.length).toBeGreaterThan(0);
    }
  });
});

describe("phase 3 mock gateway scenario suite", () => {
  test("exposes the fifteen deterministic scenarios", () => {
    expect(MOCK_SCENARIOS.length).toBe(15);
    expect(new Set(MOCK_SCENARIOS).size).toBe(15);
  });

  test("every scenario resolves deterministically", () => {
    const mock = new MockGatewayServer();
    const attempt = {
      id: "attempt-1",
      status: "CREATED" as const,
      env: "SANDBOX",
      currency: "LYD",
      requestedAmount: "100.0000",
      totalChargedAmount: "100.0000",
      context: {},
    };
    for (const scenario of MOCK_SCENARIOS) {
      const first = mock.runScenario(scenario, attempt);
      const second = mock.runScenario(scenario, attempt);
      expect(first).toEqual(second);
      expect(first.reference).toBe(second.reference);
    }
  });
});

describe("phase 3 dynamic rail engine", () => {
  test("initiates, confirms and posts the ledger entry in one flow", async () => {
    const harness = createHarness();
    const attempt = createAttempt();
    harness.attempts.set(attempt.id, attempt);

    await harness.engine.initiate(attempt, { phone: "0912345678" });
    expect(harness.reserved).toEqual([attempt.id]);
    expect(attempt.status).toBe("AWAITING_CUSTOMER");

    const result = await harness.engine.confirm(attempt, {
      status: "SUCCESS",
      reference: "GW-1",
      amount: "100.0000",
      currency: "LYD",
      environment: "SANDBOX",
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(harness.posted).toEqual([attempt.id]);
    expect(harness.committed).toEqual([attempt.id]);
  });

  test("does not post the ledger when a trusted fact fails", async () => {
    const harness = createHarness({ amount: "99.0000" });
    const attempt = createAttempt();
    harness.attempts.set(attempt.id, attempt);
    await harness.engine.initiate(attempt, {});
    const result = await harness.engine.confirm(attempt, {
      status: "SUCCESS",
      reference: "GW-1",
      amount: "99.0000",
      currency: "LYD",
      environment: "SANDBOX",
    });
    expect(result.status).toBe("UNKNOWN");
    expect(harness.posted).toEqual([]);
  });

  test("keeps the slot reservation when the outcome is unknown", async () => {
    const harness = createHarness();
    const attempt = createAttempt();
    harness.attempts.set(attempt.id, attempt);
    await harness.engine.initiate(attempt, {});
    await harness.engine.confirm(attempt, { status: "SUCCESS" });
    expect(harness.released).toEqual([]);
  });
});

describe("phase 3 go live gates", () => {
  test("reports twelve gates and passes with complete evidence", async () => {
    const validator = new GoLiveGateValidator();
    const report = await validator.validate({
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
      canaryTrafficPlanConfigured: true,
      routeAlertsConfigured: true,
      runbooksConfigured: true,
    });
    expect(report.gates.length).toBe(12);
    expect(report.passed).toBe(true);
    expect(report.failedGateIds).toEqual([]);
  });

  test("fails the maker checker gate when the checker equals the maker", async () => {
    const validator = new GoLiveGateValidator();
    const report = await validator.validate({
      makerUserId: "maker-1",
      checkerUserId: "maker-1",
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
      canaryTrafficPlanConfigured: true,
      routeAlertsConfigured: true,
      runbooksConfigured: true,
    });
    expect(report.passed).toBe(false);
    expect(report.failedGateIds).toContain("MAKER_CHECKER_APPROVAL");
  });
});

describe("phase 3 step executor and transforms", () => {
  test("rejects a money step whose required output is missing", async () => {
    const executor = new StepExecutor({
      fetch: (async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const result = await executor.execute(
      {
        id: "confirm",
        type: "HTTP",
        method: "POST",
        url_template: "https://gw.example/confirm",
        side_effect: "MOVES_MONEY",
        retry_policy: "NEVER",
        outputs: [{ name: "transaction_id", selector: "transaction_id", store_as: "STATE", required: true }],
      },
      {},
    );
    expect(result.status).toBe("UNKNOWN");
  });

  test("keeps the transform library closed", async () => {
    const pipeline = new TransformPipeline();
    const validation = pipeline.validate([{ op: "system_exec", args: [] }] as never);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});
