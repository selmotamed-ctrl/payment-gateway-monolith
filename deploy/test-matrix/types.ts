import type { GateId, ResolvedIntensity } from "./intensity";
import type { DerivedTopology } from "./topologyDerivation";

/**
 * A check is PASS/FAIL only when something was measured. SKIP means "not
 * applicable or not implemented" and never counts as a pass (the archived
 * gates returned ok=true for "not T8" and "no replica").
 */
export type CheckStatus = "PASS" | "FAIL" | "SKIP";

export interface GateCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Raw measurements behind the verdict (latency, counts, rates...). */
  measured?: Record<string, number | string | boolean>;
}

/**
 * PASSED: at least one measured check and none failed.
 * FAILED: any check failed or the gate threw.
 * SKIPPED: every check was SKIP (not applicable / not implemented).
 * NOT_RUN: not executed because an earlier gate stopped the topology.
 */
export type GateStatus = "PASSED" | "FAILED" | "SKIPPED" | "NOT_RUN";

export interface GateResult {
  gate: number;
  id: GateId;
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  durationMs: number;
  error?: string;
}

export interface TopologyRunResult {
  topology: DerivedTopology;
  configPath: string;
  attempt: number;
  attemptsAllowed: number;
  deploy: { ok: boolean; durationMs: number; output: string };
  gates: GateResult[];
  passed: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface MatrixRunMeta {
  runId: string;
  labName: string;
  configPath: string;
  configHash: string;
  intensityHash: string;
  intensity: ResolvedIntensity;
  gitCommit: string;
  machines: Array<{ id: string; address: string; privateIp: string; roles: string[]; labels: Record<string, string> }>;
  skippedFamilies: Array<{ family: string; reason: string }>;
  startedAt: string;
  finishedAt: string;
}
