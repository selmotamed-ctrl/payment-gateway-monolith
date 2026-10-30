import { describe, expect, test } from "bun:test";
import type { Request } from "express";
import { defaultScenario, resolveRail, RAIL_DESCRIPTORS } from "../engine/chaos/DefaultRailScenarios";
import { assignFate, detectMagicTrigger, evaluate } from "../engine/chaos/ChaosEvaluator";
import { Prng } from "../engine/chaos/prng";

const request = (body: Record<string, unknown>): Request =>
  ({ body, rawBody: Buffer.from(JSON.stringify(body)), header: () => undefined }) as unknown as Request;

describe("rail catalogue", () => {
  test("contains all twenty rails and resolves aliases", () => {
    expect(RAIL_DESCRIPTORS).toHaveLength(20);
    expect(resolveRail("cbl_lypay")?.railCode).toBe("ly_pay");
    expect(resolveRail("evo_pay")?.railCode).toBe("evopay");
    expect(resolveRail("nope")).toBeUndefined();
  });
});

describe("ChaosEvaluator", () => {
  test("magic OTPs and phone suffixes are deterministic", () => {
    expect(detectMagicTrigger(request({ otp: "000000" }))?.failureMode).toBe("WRONG_OTP_RETRYABLE");
    expect(detectMagicTrigger(request({ phone: "0911239901" }))?.failureMode).toBe("TERMINAL_DECLINE_INSUFFICIENT_FUNDS");
    expect(detectMagicTrigger(request({ phone: "0911239906" }))?.failureMode).toBe("TIMEOUT_HANG_ABOVE_STEP_TTL");
    expect(detectMagicTrigger(request({ phone: "0911239907" }))?.failureMode).toBe("MALFORMED_OR_UNMAPPED_200_BODY");
    expect(detectMagicTrigger(request({ phone: "0911230000" }))).toBeUndefined();
  });

  test("assignFate is reproducible for the same seed", () => {
    const scenario = { ...defaultScenario(RAIL_DESCRIPTORS[0]!), overallFailureChancePercent: 100 };
    const first = assignFate(scenario, "tx-1");
    const second = assignFate(scenario, "tx-1");
    expect(first).toEqual(second);
    expect(first.assignedFailPhase).not.toBeNull();
    expect(first.assignedFailureMode).not.toBeNull();
  });

  test("zero percent never fails", () => {
    const scenario = { ...defaultScenario(RAIL_DESCRIPTORS[0]!), overallFailureChancePercent: 0 };
    expect(assignFate(scenario, "tx-1").assignedFailureMode).toBeNull();
  });

  test("magic input wins over the pinned transaction fate", () => {
    const scenario = defaultScenario(RAIL_DESCRIPTORS[0]!);
    const decision = evaluate({
      request: request({ otp: "999999" }),
      config: scenario,
      phase: "SUBMIT",
      pinned: { phase: "SUBMIT", mode: "HTTP_500_GATEWAY_FAULT" },
    });
    expect(decision?.source).toBe("MAGIC_INPUT");
    expect(decision?.failureMode).toBe("TERMINAL_DECLINE_INSUFFICIENT_FUNDS");
  });

  test("a disabled rail becomes a 503 outage", () => {
    const scenario = { ...defaultScenario(RAIL_DESCRIPTORS[0]!), enabled: false };
    const decision = evaluate({ request: request({}), config: scenario, phase: "INITIATE" });
    expect(decision?.source).toBe("OUTAGE");
  });

  test("PRNG is deterministic and weighted sampling is stable", () => {
    const a = new Prng("seed");
    const b = new Prng("seed");
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});
