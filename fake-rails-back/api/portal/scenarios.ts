import { Router } from "express";
import { z } from "zod";
import { getDb, nowIso } from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import {
  RAIL_DESCRIPTORS,
  defaultScenario,
  resolveRail,
  type FailureMode,
  type RailChaosScenarioConfig,
} from "../../engine/chaos/DefaultRailScenarios";
import { getScenario, listScenarios, resetAllScenarios, saveScenario } from "../../engine/chaos/scenarioStore";
import { broadcast } from "./eventHub";

const weightsSchema = z.record(z.string(), z.number().min(0).max(1_000_000));

const scenarioSchema = z.object({
  enabled: z.boolean().optional(),
  overallFailureChancePercent: z.number().min(0).max(100).optional(),
  phaseBreakdown: z
    .object({
      initiateFailWeight: z.number().min(0),
      submitFailWeight: z.number().min(0),
      verifyFailWeight: z.number().min(0),
      failWeight: z.number().min(0).optional(),
      webhookFailWeight: z.number().min(0),
      refundFailWeight: z.number().min(0),
    })
    .partial()
    .optional(),
  failureModeWeights: weightsSchema.optional(),
  latencyMs: z.object({ min: z.number().min(0), max: z.number().min(0) }).optional(),
  autoApproveAsyncAfterSec: z.number().min(0).nullable().optional(),
  webhookBehavior: z
    .object({
      delaySeconds: z.number().min(0),
      duplicateCount: z.number().min(1).max(5),
      outOfOrderPendingAfterPaid: z.boolean(),
      corruptSignatureChancePercent: z.number().min(0).max(100),
    })
    .partial()
    .optional(),
});

const mergeScenario = (
  base: RailChaosScenarioConfig,
  patch: z.infer<typeof scenarioSchema>,
): RailChaosScenarioConfig => ({
  ...base,
  ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  ...(patch.overallFailureChancePercent !== undefined
    ? { overallFailureChancePercent: patch.overallFailureChancePercent }
    : {}),
  phaseBreakdown: { ...base.phaseBreakdown, ...(patch.phaseBreakdown ?? {}) },
  failureModeWeights: {
    ...base.failureModeWeights,
    ...((patch.failureModeWeights ?? {}) as Partial<Record<FailureMode, number>>),
  },
  latencyMs: patch.latencyMs ? { ...base.latencyMs, ...patch.latencyMs } : base.latencyMs,
  autoApproveAsyncAfterSec:
    patch.autoApproveAsyncAfterSec !== undefined
      ? patch.autoApproveAsyncAfterSec
      : base.autoApproveAsyncAfterSec,
  webhookBehavior: { ...base.webhookBehavior, ...(patch.webhookBehavior ?? {}) },
});

const PRESETS: Record<string, (scenario: RailChaosScenarioConfig) => RailChaosScenarioConfig> = {
  healthy: (scenario) => ({
    ...scenario,
    enabled: true,
    overallFailureChancePercent: 0,
    latencyMs: { min: 20, max: 120 },
  }),
  flaky: (scenario) => ({ ...scenario, enabled: true, overallFailureChancePercent: 25 }),
  timeout_on_confirm: (scenario) => ({
    ...scenario,
    enabled: true,
    overallFailureChancePercent: 100,
    phaseBreakdown: {
      initiateFailWeight: 0,
      submitFailWeight: 100,
      verifyFailWeight: 0,
      webhookFailWeight: 0,
      refundFailWeight: 0,
    },
    failureModeWeights: {
      TERMINAL_DECLINE_INSUFFICIENT_FUNDS: 0,
      LIMIT_EXCEEDED_CUSTOMER_CEILING: 0,
      WRONG_OTP_RETRYABLE: 0,
      HTTP_500_GATEWAY_FAULT: 0,
      TIMEOUT_HANG_ABOVE_STEP_TTL: 100,
      SOCKET_RESET_MID_STREAM: 0,
      MALFORMED_OR_UNMAPPED_200_BODY: 0,
      RATE_LIMIT_HTTP_429: 0,
      AMOUNT_ROUNDING_MISMATCH: 0,
      CONFLICTING_WEBHOOK_VS_INQUIRY: 0,
    },
  }),
  outage: (scenario) => ({ ...scenario, enabled: false }),
};

export const createScenariosRouter = (): Router => {
  const router = Router();

  router.get("/", (_request, response) => {
    response.json({ rails: RAIL_DESCRIPTORS, scenarios: listScenarios() });
  });

  router.get("/:railCode", (request, response) => {
    response.json({ scenario: getScenario(request.params.railCode ?? "") });
  });

  router.put("/:railCode", (request, response) => {
    const descriptor = resolveRail(request.params.railCode ?? "");
    if (!descriptor) throw new ApiError(404, "UNKNOWN_RAIL", "Unknown rail");
    const patch = parseOrThrow(scenarioSchema, request.body);
    const base = getScenario(descriptor.railCode);
    const saved = saveScenario(mergeScenario(base, patch));
    broadcast("scenario.updated", { railCode: saved.railCode, scenario: saved });
    response.json({ scenario: saved });
  });

  router.post("/preset/:railCode/:preset", (request, response) => {
    const descriptor = resolveRail(request.params.railCode ?? "");
    const preset = PRESETS[request.params.preset ?? ""];
    if (!descriptor) throw new ApiError(404, "UNKNOWN_RAIL", "Unknown rail");
    if (!preset) throw new ApiError(400, "UNKNOWN_PRESET", "Unknown preset");
    const saved = saveScenario(preset(getScenario(descriptor.railCode)));
    broadcast("scenario.updated", { railCode: saved.railCode, scenario: saved });
    response.json({ scenario: saved });
  });

  router.post("/reset", (_request, response) => {
    const scenarios = resetAllScenarios();
    broadcast("scenario.reset", { count: scenarios.length });
    response.json({ scenarios });
  });

  router.post("/global/:preset", (request, response) => {
    const preset = PRESETS[request.params.preset ?? ""];
    if (!preset) throw new ApiError(400, "UNKNOWN_PRESET", "Unknown preset");
    const scenarios = RAIL_DESCRIPTORS.map((descriptor) =>
      saveScenario(preset(getScenario(descriptor.railCode))),
    );
    broadcast("scenario.reset", { preset: request.params.preset, count: scenarios.length });
    response.json({ scenarios });
  });

  router.get("/:railCode/audit", (request, response) => {
    const rows = getDb()
      .prepare("SELECT * FROM fake_portal_audit WHERE target = ? ORDER BY created_at DESC LIMIT 100")
      .all(request.params.railCode ?? "");
    response.json({ audit: rows, at: nowIso() });
  });

  return router;
};
