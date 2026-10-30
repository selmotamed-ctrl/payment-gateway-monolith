import { describe, expect, test } from "bun:test";
import {
  manifestKey,
  manifestMatches,
  mulberry32,
  parseSyntheticConfig,
  syntheticGuardError,
  syntheticId,
  syntheticReference,
  type SyntheticManifest,
} from "../scripts/syntheticDataPlan";

describe("synthetic data plan", () => {
  test("defaults to the demo profile", () => {
    const parsed = parseSyntheticConfig([], {});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.profile).toBe("demo");
    expect(parsed.config.namespace).toBe("synthv1");
    expect(parsed.config.years).toBe(3);
    expect(parsed.config.merchants).toBe(30);
    expect(parsed.config.attempts).toBe(30_000);
  });

  test("accepts flags and environment overrides", () => {
    const parsed = parseSyntheticConfig(
      ["--auto", "--reset", "--profile=staging", "--namespace", "demo2", "--seed=7", "--attempts", "12"],
      { SYNTHETIC_DATA_YEARS: "4", SYNTHETIC_DATA_MERCHANTS: "5" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config).toMatchObject({
      auto: true,
      reset: true,
      profile: "staging",
      namespace: "demo2",
      seed: 7,
      years: 4,
      merchants: 5,
      attempts: 12,
    });
  });

  test("rejects invalid profiles, namespaces and windows", () => {
    expect(parseSyntheticConfig(["--profile=wizard"], {}).ok).toBe(false);
    expect(parseSyntheticConfig(["--namespace=bad namespace"], {}).ok).toBe(false);
    expect(parseSyntheticConfig(["--years=99"], {}).ok).toBe(false);
    expect(parseSyntheticConfig(["--unknown"], {}).ok).toBe(false);
  });

  test("guards production unless explicitly allowed", () => {
    expect(syntheticGuardError("production", false)).toContain("refusing");
    expect(syntheticGuardError("production", true)).toBeNull();
    expect(syntheticGuardError("development", false)).toBeNull();
  });

  test("builds stable namespaced ids and references", () => {
    expect(syntheticId("demo", "mer", 3)).toBe("demo_mer_00000003");
    expect(syntheticReference("demo", "PA", 3)).toBe("SYNTH-DEMO-PA-00000003");
    expect(manifestKey("demo")).toBe("synthetic.dataset.demo");
  });

  test("detects a complete matching manifest", () => {
    const manifest: SyntheticManifest = {
      generatorVersion: 1,
      profile: "demo",
      namespace: "synthv1",
      seed: 20260101,
      years: 3,
      endDate: "2026-10-30",
      status: "COMPLETE",
      lastCompletedBucket: "2026-10",
      counts: {},
      ledgerDrift: "0.0000",
      startedAt: "2026-10-30T00:00:00Z",
      completedAt: "2026-10-30T00:01:00Z",
    };
    const parsed = parseSyntheticConfig([], { SYNTHETIC_DATA_END_DATE: "2026-10-30" });
    if (!parsed.ok) throw new Error("expected config");
    expect(manifestMatches(manifest, parsed.config)).toBe(true);
    expect(manifestMatches({ ...manifest, status: "RUNNING" }, parsed.config)).toBe(false);
  });

  test("the PRNG is deterministic", () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });
});
