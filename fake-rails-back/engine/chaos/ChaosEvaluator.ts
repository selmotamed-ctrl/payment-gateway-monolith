import type { Request } from "express";
import { rawBodyText } from "../../lib/rawBody";
import type { FailureMode, FailPhase, RailChaosScenarioConfig } from "./DefaultRailScenarios";
import { Prng } from "./prng";

/**
 * The deterministic + probabilistic failure injection engine.
 *
 * Priority order (highest first):
 *   1. deterministic magic inputs (the 15-scenario sandbox contract);
 *   2. a per-transaction override pinned by the tester in the portal;
 *   3. the configured percentage chance, rolled once when the transaction is
 *      created and persisted on its row, so multi-step flows stay coherent.
 */

export interface MagicTrigger {
  failureMode: FailureMode;
  phase: FailPhase;
  reason: string;
}

export interface ChaosDecision {
  failureMode: FailureMode;
  phase: FailPhase;
  source: "MAGIC_INPUT" | "TRANSACTION_OVERRIDE" | "PROBABILITY" | "OUTAGE";
  reason: string;
}

export interface FateAssignment {
  assignedFailPhase: FailPhase | null;
  assignedFailureMode: FailureMode | null;
  source: "PROBABILITY" | "NONE";
}

const PHONE_SUFFIX_TRIGGERS: Array<{ suffix: string; mode: FailureMode; phase: FailPhase; reason: string }> = [
  { suffix: "9901", mode: "TERMINAL_DECLINE_INSUFFICIENT_FUNDS", phase: "SUBMIT", reason: "magic phone 9901" },
  { suffix: "9902", mode: "LIMIT_EXCEEDED_CUSTOMER_CEILING", phase: "SUBMIT", reason: "magic phone 9902" },
  { suffix: "9905", mode: "HTTP_500_GATEWAY_FAULT", phase: "SUBMIT", reason: "magic phone 9905" },
  { suffix: "9906", mode: "TIMEOUT_HANG_ABOVE_STEP_TTL", phase: "SUBMIT", reason: "magic phone 9906" },
  { suffix: "9907", mode: "MALFORMED_OR_UNMAPPED_200_BODY", phase: "SUBMIT", reason: "magic phone 9907" },
];

const OTP_TRIGGERS: Record<string, MagicTrigger> = {
  "000000": { failureMode: "WRONG_OTP_RETRYABLE", phase: "SUBMIT", reason: "magic OTP 000000" },
  "0000": { failureMode: "WRONG_OTP_RETRYABLE", phase: "SUBMIT", reason: "magic OTP 0000" },
  "999999": { failureMode: "TERMINAL_DECLINE_INSUFFICIENT_FUNDS", phase: "SUBMIT", reason: "magic OTP 999999" },
  "500500": { failureMode: "HTTP_500_GATEWAY_FAULT", phase: "SUBMIT", reason: "magic OTP 500500" },
  "408408": { failureMode: "TIMEOUT_HANG_ABOVE_STEP_TTL", phase: "SUBMIT", reason: "magic OTP 408408" },
};

const flatten = (value: unknown, output: string[] = []): string[] => {
  if (value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) flatten(entry, output);
    return output;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) flatten(entry, output);
  }
  return output;
};

export const detectMagicTrigger = (request: Request): MagicTrigger | undefined => {
  const values = [...flatten(request.body), rawBodyText(request)];
  const joined = values.join(" ");

  // OTP checks are exact on a field value, but also accept a raw-body token.
  for (const value of values) {
    const trigger = OTP_TRIGGERS[value.trim()];
    if (trigger) return trigger;
  }
  for (const [otp, trigger] of Object.entries(OTP_TRIGGERS)) {
    if (new RegExp(`(^|[^0-9])${otp}([^0-9]|$)`).test(joined)) {
      return trigger;
    }
  }
  for (const trigger of PHONE_SUFFIX_TRIGGERS) {
    if (values.some((value) => value.replace(/[^0-9]/g, "").endsWith(trigger.suffix))) {
      return { failureMode: trigger.mode, phase: trigger.phase, reason: trigger.reason };
    }
  }
  return undefined;
};

const phaseKey = (phase: FailPhase): keyof RailChaosScenarioConfig["phaseBreakdown"] => {
  switch (phase) {
    case "INITIATE": return "initiateFailWeight";
    case "SUBMIT": return "submitFailWeight";
    case "VERIFY": return "verifyFailWeight";
    case "WEBHOOK": return "webhookFailWeight";
    case "REFUND": return "refundFailWeight";
  }
};

/** Rolls the fate of a brand new transaction. */
export const assignFate = (
  config: RailChaosScenarioConfig,
  seed: string,
): FateAssignment => {
  if (config.overallFailureChancePercent <= 0) {
    return { assignedFailPhase: null, assignedFailureMode: null, source: "NONE" };
  }
  const prng = new Prng(seed);
  if (!prng.chance(config.overallFailureChancePercent)) {
    return { assignedFailPhase: null, assignedFailureMode: null, source: "NONE" };
  }
  const phaseWeights: Record<FailPhase, number> = {
    INITIATE: config.phaseBreakdown.initiateFailWeight,
    SUBMIT: config.phaseBreakdown.submitFailWeight,
    VERIFY: config.phaseBreakdown.verifyFailWeight,
    WEBHOOK: config.phaseBreakdown.webhookFailWeight,
    REFUND: config.phaseBreakdown.refundFailWeight,
  };
  const phase = prng.weighted(phaseWeights) as FailPhase | undefined;
  const mode = prng.weighted(config.failureModeWeights) as FailureMode | undefined;
  if (!phase || !mode) {
    return { assignedFailPhase: null, assignedFailureMode: null, source: "NONE" };
  }
  return { assignedFailPhase: phase, assignedFailureMode: mode, source: "PROBABILITY" };
};

/**
 * Evaluates one incoming rail request.
 *
 * `pinned` is the fate stored on the transaction (or an explicit portal
 * override). Magic inputs always win, then the pinned fate, then the outage
 * switch.
 */
export const evaluate = (input: {
  request: Request;
  config: RailChaosScenarioConfig;
  phase: FailPhase;
  pinned?: { phase: FailPhase | null; mode: FailureMode | null } | null;
}): ChaosDecision | null => {
  const { request, config, phase, pinned } = input;

  const magic = detectMagicTrigger(request);
  if (magic && magic.phase === phase) {
    return { failureMode: magic.failureMode, phase, source: "MAGIC_INPUT", reason: magic.reason };
  }

  if (!config.enabled) {
    return { failureMode: "HTTP_500_GATEWAY_FAULT", phase, source: "OUTAGE", reason: "rail outage (503)" };
  }

  if (pinned?.mode && pinned.phase === phase) {
    return {
      failureMode: pinned.mode,
      phase,
      source: "TRANSACTION_OVERRIDE",
      reason: "pinned transaction fate",
    };
  }
  return null;
};

/** Whether the pinned fate belongs to this phase (used by the webhook path). */
export const phaseMatches = (phase: FailPhase, pinned: { phase: FailPhase | null } | null | undefined): boolean =>
  Boolean(pinned && pinned.phase === phase);

/** Weighted latency draw in the configured range. */
export const latencyFor = (config: RailChaosScenarioConfig, seed: string): number => {
  const min = Math.max(0, config.latencyMs.min);
  const max = Math.max(min, config.latencyMs.max);
  if (max === 0) return 0;
  return new Prng(seed).int(min, max);
};

export const phaseWeight = phaseKey;
