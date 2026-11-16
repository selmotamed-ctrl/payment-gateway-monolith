import { Decimal } from "decimal.js";
import type { PrismaLike } from "../db/ports";
import type { RouteHealthMode, RouteHealthPolicy } from "./types";

export const ROUTE_HEALTH_POLICY_KEY = "route_health.policy";

let cachedPolicy: { value: RouteHealthPolicy; expiresAt: number } | null = null;
const POLICY_CACHE_MS = 5_000;

export function invalidateRouteHealthPolicyCache(): void {
  cachedPolicy = null;
}

export const DEFAULT_ROUTE_HEALTH_POLICY: RouteHealthPolicy = {
  enabled: true,
  mode: "ENFORCE",
  sampleBucketSeconds: 300,
  windowSeconds: 900,
  minOutcomes: 10,
  degradeErrorRate: 0.3,
  openErrorRate: 0.6,
  degradeConsecutive: 3,
  openConsecutive: 6,
  recoverDegradedProbes: 2,
  recoverOpenProbes: 3,
  openCooldownSeconds: 300,
  probeIntervalSeconds: 60,
  probeBackoffMaxSeconds: 900,
  canaryPercent: 5,
  canaryMaxAmount: null,
  degradedRecoverMinOutcomes: 10,
  degradedRecoverErrorRate: 0.1,
  overrideDefaultExpiryDays: 7,
  overrideMaxExpiryDays: 30,
  overrideReviewHours: 24,
};

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  if (value === null || value === undefined || typeof value === "boolean") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const canaryMaximum = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const amount = new Decimal(String(value).trim());
    if (!amount.isFinite() || amount.lte(0)) return null;
    return amount.toFixed(4);
  } catch {
    return null;
  }
};

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : fallback;

const mode = (value: unknown, fallback: RouteHealthMode): RouteHealthMode =>
  value === "OFF" || value === "SHADOW" || value === "ENFORCE" ? value : fallback;

/** Unknown keys are ignored; malformed values fall back to defaults so a bad setting never stops the worker. */
export function parseRouteHealthPolicy(value: unknown): RouteHealthPolicy {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const fallback = DEFAULT_ROUTE_HEALTH_POLICY;
  const maxExpiryDays = clamp(raw.overrideMaxExpiryDays, fallback.overrideMaxExpiryDays, 1, 30);
  const probeIntervalSeconds = clamp(raw.probeIntervalSeconds, fallback.probeIntervalSeconds, 10, 86_400);
  const probeBackoffMaxSeconds = Math.max(
    probeIntervalSeconds,
    clamp(raw.probeBackoffMaxSeconds, fallback.probeBackoffMaxSeconds, 60, 86_400),
  );
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    mode: mode(raw.mode, fallback.mode),
    sampleBucketSeconds: clamp(raw.sampleBucketSeconds, fallback.sampleBucketSeconds, 60, 3600),
    windowSeconds: clamp(raw.windowSeconds, fallback.windowSeconds, 300, 86_400),
    minOutcomes: clamp(raw.minOutcomes, fallback.minOutcomes, 1, 100_000),
    degradeErrorRate: clamp(raw.degradeErrorRate, fallback.degradeErrorRate, 0, 1),
    openErrorRate: clamp(raw.openErrorRate, fallback.openErrorRate, 0, 1),
    degradeConsecutive: clamp(raw.degradeConsecutive, fallback.degradeConsecutive, 1, 1000),
    openConsecutive: clamp(raw.openConsecutive, fallback.openConsecutive, 1, 1000),
    recoverDegradedProbes: clamp(raw.recoverDegradedProbes, fallback.recoverDegradedProbes, 1, 100),
    recoverOpenProbes: clamp(raw.recoverOpenProbes, fallback.recoverOpenProbes, 1, 100),
    openCooldownSeconds: clamp(raw.openCooldownSeconds, fallback.openCooldownSeconds, 0, 86_400),
    probeIntervalSeconds,
    probeBackoffMaxSeconds,
    canaryPercent: clamp(raw.canaryPercent, fallback.canaryPercent, 0, 100),
    canaryMaxAmount: canaryMaximum(raw.canaryMaxAmount),
    degradedRecoverMinOutcomes: clamp(raw.degradedRecoverMinOutcomes, fallback.degradedRecoverMinOutcomes, 1, 100_000),
    degradedRecoverErrorRate: clamp(raw.degradedRecoverErrorRate, fallback.degradedRecoverErrorRate, 0, 1),
    overrideDefaultExpiryDays: Math.min(
      clamp(raw.overrideDefaultExpiryDays, fallback.overrideDefaultExpiryDays, 1, 30),
      maxExpiryDays,
    ),
    overrideMaxExpiryDays: maxExpiryDays,
    overrideReviewHours: clamp(raw.overrideReviewHours, fallback.overrideReviewHours, 1, 720),
  };
}

/** Reads the platform setting; a missing model or row uses the defaults (useful in narrow tests/tools). */
export async function readRouteHealthPolicy(db: PrismaLike): Promise<RouteHealthPolicy> {
  if (cachedPolicy && cachedPolicy.expiresAt > Date.now()) return cachedPolicy.value;
  const model = (db as unknown as { platformSetting?: { findFirst?: (args: unknown) => Promise<unknown> } }).platformSetting;
  if (!model?.findFirst) {
    const fallback = DEFAULT_ROUTE_HEALTH_POLICY;
    cachedPolicy = { value: fallback, expiresAt: Date.now() + POLICY_CACHE_MS };
    return fallback;
  }
  try {
    const row = (await model.findFirst({
      where: { key: ROUTE_HEALTH_POLICY_KEY, scope: "PLATFORM" },
      orderBy: { version: "desc" },
      select: { valueJson: true },
    })) as { valueJson?: unknown } | null;
    const value = parseRouteHealthPolicy(row?.valueJson);
    cachedPolicy = { value, expiresAt: Date.now() + POLICY_CACHE_MS };
    return value;
  } catch {
    const fallback = DEFAULT_ROUTE_HEALTH_POLICY;
    cachedPolicy = { value: fallback, expiresAt: Date.now() + POLICY_CACHE_MS };
    return fallback;
  }
}
