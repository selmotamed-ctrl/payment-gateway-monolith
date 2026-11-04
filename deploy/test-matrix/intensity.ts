import { z } from "zod";

/**
 * Test intensity: a named preset plus overridable knobs. Every gate threshold
 * and workload size comes from the resolved intensity; nothing is hard-coded
 * in the gates, and the resolved object is written into the report.
 */

export const INTENSITY_PRESETS = ["smoke", "standard", "soak", "chaos", "certification"] as const;
export type IntensityPreset = (typeof INTENSITY_PRESETS)[number];

export const GATE_IDS = [
  "provisioning",
  "storage-routing",
  "seeder-invariants",
  "checkout-stress",
  "realtime-sse",
  "workers",
  "audit-chain",
  "log-db-outage",
  "search",
  "backup",
  "scale",
  "chaos",
] as const;
export type GateId = (typeof GATE_IDS)[number];

export const CHAOS_FAULTS = ["core-restart", "core-kill", "replica-stop", "redis-stop", "log-db-stop", "primary-pitr"] as const;
export type ChaosFaultType = (typeof CHAOS_FAULTS)[number];

const chaosFaultSchema = z.object({
  type: z.enum(CHAOS_FAULTS),
  everySec: z.number().positive().max(86_400).describe("Inject this fault every N seconds while the chaos workload runs (first injection after one interval)."),
  downSec: z.number().min(0).max(3_600).default(10).describe("How long the target stays down before it is restored."),
}).strict();

const sloSchema = z.object({
  minTps: z.number().min(0).describe("Minimum achieved successful checkouts per second over the steady-state window."),
  maxP95Ms: z.number().positive(),
  maxP99Ms: z.number().positive(),
  maxErrorRate: z.number().min(0).max(1).describe("Transport/5xx/4xx (non-409) failures divided by requests."),
  searchP95Ms: z.number().positive(),
  chaosMaxErrorRate: z.number().min(0).max(1).describe("Error budget while faults are being injected."),
  recoverySec: z.number().positive().describe("Time allowed for checkouts to succeed again after a fault is restored."),
  backupTimeoutSec: z.number().positive(),
  queueDrainSec: z.number().positive().describe("How long gate 'workers' waits for inbound/outbox queues to drain."),
}).strict();

const intensityKnobs = z.object({
  durationSec: z.number().positive().max(86_400).describe("Steady-state duration of each sustained workload phase."),
  rampUpSec: z.number().min(0).max(3_600).describe("Linear ramp from 0 to targetTps before the steady window."),
  targetTps: z.number().positive().max(100_000).describe("Offered checkout rate (open-loop)."),
  concurrency: z.number().int().positive().max(10_000).describe("Maximum in-flight requests; when saturated the offered rate is not met and minTps decides."),
  requestTimeoutMs: z.number().int().positive().max(300_000),
  hotLink: z.object({
    attempts: z.number().int().positive().max(100_000),
    concurrency: z.number().int().positive().max(10_000),
    useCount: z.number().int().positive().max(100_000).describe("Slot limit set on the contended link; exactly this many attempts must win."),
  }).strict(),
  data: z.object({
    seedProfile: z.enum(["COMPACT", "STANDARD", "STRESS"]),
    seedYearsSpan: z.number().positive().max(10),
  }).strict(),
  searchQueries: z.number().int().positive().max(100_000),
  readSamples: z.number().int().positive().max(10_000).describe("Admin list reads used to measure replica routing."),
  gates: z.union([z.literal("all"), z.array(z.enum(GATE_IDS)).min(1)]),
  continueOnGateFailure: z.boolean().describe("Run later gates after a failure (provisioning failure always stops the topology)."),
  attempts: z.number().int().min(1).max(5).describe("Deploy+gate attempts per topology. Results record the attempt that produced them."),
  chaos: z.object({
    enabled: z.boolean(),
    allowDestructive: z.boolean().describe("Required for primary-pitr (wipes the primary data directory)."),
    faults: z.array(chaosFaultSchema),
  }).strict(),
  slo: sloSchema,
}).strict();

export type IntensityKnobs = z.output<typeof intensityKnobs>;

type DeepPartial<T> = T extends Array<unknown> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Deep-partial overrides schema (arrays replace, objects merge). */
const overridesSchema = z.object({
  durationSec: intensityKnobs.shape.durationSec.optional(),
  rampUpSec: intensityKnobs.shape.rampUpSec.optional(),
  targetTps: intensityKnobs.shape.targetTps.optional(),
  concurrency: intensityKnobs.shape.concurrency.optional(),
  requestTimeoutMs: intensityKnobs.shape.requestTimeoutMs.optional(),
  hotLink: intensityKnobs.shape.hotLink.partial().strict().optional(),
  data: intensityKnobs.shape.data.partial().strict().optional(),
  searchQueries: intensityKnobs.shape.searchQueries.optional(),
  readSamples: intensityKnobs.shape.readSamples.optional(),
  gates: intensityKnobs.shape.gates.optional(),
  continueOnGateFailure: intensityKnobs.shape.continueOnGateFailure.optional(),
  attempts: intensityKnobs.shape.attempts.optional(),
  chaos: intensityKnobs.shape.chaos.partial().strict().optional(),
  slo: sloSchema.partial().strict().optional(),
}).strict();

export const intensitySpecSchema = z.object({
  preset: z.enum(INTENSITY_PRESETS).default("standard"),
  overrides: overridesSchema.default({}),
}).strict();

export type IntensitySpec = z.input<typeof intensitySpecSchema>;

const baseSlo = {
  maxErrorRate: 0.01,
  chaosMaxErrorRate: 0.05,
  recoverySec: 30,
  backupTimeoutSec: 600,
  queueDrainSec: 30,
};

export const PRESETS: Record<IntensityPreset, IntensityKnobs> = {
  smoke: {
    durationSec: 10,
    rampUpSec: 2,
    targetTps: 20,
    concurrency: 10,
    requestTimeoutMs: 30_000,
    hotLink: { attempts: 40, concurrency: 10, useCount: 10 },
    data: { seedProfile: "COMPACT", seedYearsSpan: 1 },
    searchQueries: 10,
    readSamples: 10,
    gates: ["provisioning", "storage-routing", "seeder-invariants", "checkout-stress", "audit-chain"],
    continueOnGateFailure: true,
    attempts: 1,
    chaos: { enabled: false, allowDestructive: false, faults: [] },
    slo: { ...baseSlo, minTps: 10, maxP95Ms: 5_000, maxP99Ms: 10_000, maxErrorRate: 0.02, searchP95Ms: 1_000 },
  },
  standard: {
    durationSec: 60,
    rampUpSec: 10,
    targetTps: 200,
    concurrency: 100,
    requestTimeoutMs: 30_000,
    hotLink: { attempts: 200, concurrency: 50, useCount: 50 },
    data: { seedProfile: "COMPACT", seedYearsSpan: 3.5 },
    searchQueries: 50,
    readSamples: 20,
    gates: "all",
    continueOnGateFailure: true,
    attempts: 2,
    chaos: {
      enabled: false,
      allowDestructive: false,
      faults: [
        { type: "core-restart", everySec: 20, downSec: 0 },
        { type: "replica-stop", everySec: 30, downSec: 10 },
      ],
    },
    slo: { ...baseSlo, minTps: 150, maxP95Ms: 1_500, maxP99Ms: 3_000, searchP95Ms: 500 },
  },
  soak: {
    durationSec: 1_800,
    rampUpSec: 60,
    targetTps: 300,
    concurrency: 150,
    requestTimeoutMs: 30_000,
    hotLink: { attempts: 1_000, concurrency: 100, useCount: 250 },
    data: { seedProfile: "STANDARD", seedYearsSpan: 3.5 },
    searchQueries: 500,
    readSamples: 100,
    gates: "all",
    continueOnGateFailure: true,
    attempts: 1,
    chaos: { enabled: false, allowDestructive: false, faults: [] },
    slo: { ...baseSlo, minTps: 250, maxP95Ms: 1_000, maxP99Ms: 2_500, maxErrorRate: 0.005, searchP95Ms: 500 },
  },
  chaos: {
    durationSec: 300,
    rampUpSec: 30,
    targetTps: 200,
    concurrency: 100,
    requestTimeoutMs: 30_000,
    hotLink: { attempts: 200, concurrency: 50, useCount: 50 },
    data: { seedProfile: "COMPACT", seedYearsSpan: 3.5 },
    searchQueries: 50,
    readSamples: 20,
    gates: "all",
    continueOnGateFailure: true,
    attempts: 1,
    chaos: {
      enabled: true,
      allowDestructive: false,
      faults: [
        { type: "core-kill", everySec: 60, downSec: 15 },
        { type: "replica-stop", everySec: 90, downSec: 20 },
        { type: "redis-stop", everySec: 120, downSec: 10 },
        { type: "log-db-stop", everySec: 120, downSec: 20 },
      ],
    },
    slo: { ...baseSlo, minTps: 100, maxP95Ms: 3_000, maxP99Ms: 8_000, searchP95Ms: 1_000, chaosMaxErrorRate: 0.05 },
  },
  // The archived plan's strict production targets (500 TPS, p95 < 35 ms,
  // search p95 < 25 ms), previously behind LAB_STRICT_PERF=true.
  certification: {
    durationSec: 120,
    rampUpSec: 15,
    targetTps: 500,
    concurrency: 200,
    requestTimeoutMs: 10_000,
    hotLink: { attempts: 200, concurrency: 100, useCount: 50 },
    data: { seedProfile: "STANDARD", seedYearsSpan: 3.5 },
    searchQueries: 200,
    readSamples: 50,
    gates: "all",
    continueOnGateFailure: true,
    attempts: 1,
    chaos: { enabled: false, allowDestructive: false, faults: [] },
    slo: { ...baseSlo, minTps: 500, maxP95Ms: 35, maxP99Ms: 100, maxErrorRate: 0, searchP95Ms: 25 },
  },
};

export interface ResolvedIntensity extends IntensityKnobs {
  preset: IntensityPreset;
  /** Dotted paths of the knobs that differ from the preset. */
  overridden: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const deepMerge = <T>(base: T, patch: DeepPartial<T> | undefined, prefix: string, changed: string[]): T => {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    if (JSON.stringify(base) !== JSON.stringify(patch)) changed.push(prefix);
    return patch as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge((base as Record<string, unknown>)[key], value as never, prefix ? `${prefix}.${key}` : key, changed);
  }
  return out as T;
};

/**
 * Preset + overrides -> fully specified, validated knobs. `presetOverride`
 * (CLI `--intensity=`) replaces the config preset but keeps its overrides.
 */
export const resolveIntensity = (spec: IntensitySpec | undefined, presetOverride?: IntensityPreset): ResolvedIntensity => {
  const parsed = intensitySpecSchema.parse(spec ?? {});
  const preset = presetOverride ?? parsed.preset;
  const changed: string[] = [];
  const merged = deepMerge<IntensityKnobs>(structuredClone(PRESETS[preset]), parsed.overrides as DeepPartial<IntensityKnobs>, "", changed);
  const validated = intensityKnobs.safeParse(merged);
  if (!validated.success) {
    throw new Error(`Invalid intensity (${preset} + overrides): ${validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const knobs = validated.data;
  if (knobs.chaos.faults.some((fault) => fault.type === "primary-pitr") && !knobs.chaos.allowDestructive) {
    throw new Error("Invalid intensity: chaos fault 'primary-pitr' wipes the primary and requires chaos.allowDestructive=true");
  }
  if (knobs.hotLink.useCount > knobs.hotLink.attempts) {
    throw new Error("Invalid intensity: hotLink.useCount must not exceed hotLink.attempts (the over-subscription is what the gate measures)");
  }
  return { ...knobs, preset, overridden: changed.sort() };
};

export const selectedGates = (intensity: Pick<IntensityKnobs, "gates">): GateId[] =>
  intensity.gates === "all" ? [...GATE_IDS] : GATE_IDS.filter((gate) => (intensity.gates as GateId[]).includes(gate));

/** Requests the open-loop generator offers in one phase (ramp + steady). */
export const offeredRequests = (intensity: Pick<IntensityKnobs, "targetTps" | "rampUpSec" | "durationSec">): number =>
  Math.round(intensity.targetTps * (intensity.durationSec + intensity.rampUpSec / 2));
