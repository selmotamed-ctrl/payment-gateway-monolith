import { createHash } from "node:crypto";
import { client } from "../../prisma/client";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import {
  createReportEngine,
  type ReportDescriptorSpec,
  type ReportDiagnostic,
  type ReportEngine,
  type WhereFilterNode,
} from "../../lib/reportEngineSdk";
import { buildMerchantReportAuthoringTranscript } from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
import { getMerchantReportHostConfig } from "./merchantHostConfig";

export const MERCHANT_TIER_LIMITS = {
  maxDatasets: 6,
  maxJoinsPerDataset: 2,
  maxSelectFields: 20,
  maxWindowFields: 2,
  maxSections: 24,
  maxRowsPerDataset: 10_000,
  maxDateRangeDays: 92,
  maxSpecBytes: 256 * 1024,
  maxZipBytes: 2 * 1024 * 1024,
  maxCodes: 50,
  maxVersionsPerCode: 20,
} as const;

export const MERCHANT_REPORT_POLICY_KEY = "merchant_reports.policy";

export interface MerchantReportPolicy {
  enabled: boolean;
  assetsEnabled: boolean;
  version: number | null;
}

const DEFAULT_MERCHANT_REPORT_POLICY: MerchantReportPolicy = {
  enabled: true,
  assetsEnabled: true,
  version: null,
};

let cachedPolicy: { value: MerchantReportPolicy; expiresAt: number } | null = null;
const POLICY_CACHE_MS = 5_000;

export function invalidateMerchantReportPolicyCache(): void {
  cachedPolicy = null;
}

/**
 * Reads the staff-managed merchant reporting policy (`merchant_reports.policy`).
 * Missing or malformed values fall back to the previous behaviour (enabled,
 * assets allowed); staff change it from Platform Settings.
 */
export async function readMerchantReportPolicy(
  db: { platformSetting: { findFirst: (args: unknown) => Promise<unknown> } } = client as never,
): Promise<MerchantReportPolicy> {
  if (cachedPolicy && cachedPolicy.expiresAt > Date.now()) return cachedPolicy.value;
  let row: { valueJson?: unknown; version?: number } | null = null;
  try {
    row = (await db.platformSetting.findFirst({
      where: { key: MERCHANT_REPORT_POLICY_KEY, scope: "PLATFORM" },
      orderBy: { version: "desc" },
    })) as { valueJson?: unknown; version?: number } | null;
  } catch {
    row = null;
  }
  const raw = row?.valueJson && typeof row.valueJson === "object" && !Array.isArray(row.valueJson)
    ? (row.valueJson as Record<string, unknown>)
    : {};
  const enabled = raw.enabled === false || raw.enabled === "false" ? false : true;
  const assetsRaw = raw.assetsEnabled ?? raw.assets_enabled;
  const assetsEnabled = assetsRaw === false || assetsRaw === "false" ? false : true;
  const value: MerchantReportPolicy = {
    enabled,
    assetsEnabled,
    version: row?.version ?? null,
  };
  cachedPolicy = { value, expiresAt: Date.now() + POLICY_CACHE_MS };
  return value;
}

export async function assertMerchantAssetsEnabled(): Promise<MerchantReportPolicy> {
  const policy = await readMerchantReportPolicy();
  if (!policy.assetsEnabled) {
    throw new MerchantReportGuardError(
      "MERCHANT_REPORT_ASSETS_DISABLED",
      "Merchant report asset bundles are disabled by platform policy",
      409,
    );
  }
  return policy;
}

let cachedEngine: ReportEngine | null = null;

export function getMerchantReportEngine(): ReportEngine {
  if (!cachedEngine) {
    cachedEngine = createReportEngine(getMerchantReportHostConfig());
  }
  return cachedEngine;
}

export function buildMerchantTranscript(
  options: Parameters<typeof buildMerchantReportAuthoringTranscript>[1] = {},
) {
  return buildMerchantReportAuthoringTranscript(getMerchantReportHostConfig(), options);
}

const rangePredicates = (where: WhereFilterNode | undefined): Array<Extract<WhereFilterNode, { kind: "PREDICATE" }>> => {
  if (!where) return [];
  if (where.kind === "PREDICATE") return [where];
  return where.logic === "AND" ? where.conditions.flatMap(rangePredicates) : [];
};

const daysBetween = (start: unknown, end: unknown): number | null => {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / (24 * 3600 * 1000) : null;
};

/**
 * Merchant-tier resource guards (E05). These are stricter than the staff
 * limits and are re-checked on every verify, save and execute call.
 */
export function validateMerchantTierLimits(
  spec: ReportDescriptorSpec,
  extras: { specBytes?: number; zipBytes?: number } = {},
): ReportDiagnostic[] {
  const diagnostics: ReportDiagnostic[] = [];
  const push = (path: string, code: string, message: string, aiFixHint: string) =>
    diagnostics.push({ layer: 1, severity: "error", path, code, message, aiFixHint });

  if (extras.specBytes !== undefined && extras.specBytes > MERCHANT_TIER_LIMITS.maxSpecBytes) {
    push("spec", "MERCHANT_SPEC_TOO_LARGE", `The report spec exceeds ${MERCHANT_TIER_LIMITS.maxSpecBytes} bytes.`, "Split the report into smaller reports.");
  }
  if (extras.zipBytes !== undefined && extras.zipBytes > MERCHANT_TIER_LIMITS.maxZipBytes) {
    push("assets.zip", "MERCHANT_ASSET_ZIP_TOO_LARGE", `The asset bundle exceeds ${MERCHANT_TIER_LIMITS.maxZipBytes} bytes.`, "Use smaller assets (the merchant limit is 2 MB).");
  }
  if (spec.datasets.length > MERCHANT_TIER_LIMITS.maxDatasets) {
    push("datasets", "MERCHANT_TOO_MANY_DATASETS", `At most ${MERCHANT_TIER_LIMITS.maxDatasets} datasets are allowed.`, "Remove datasets or split the report.");
  }
  if (spec.sections.length > MERCHANT_TIER_LIMITS.maxSections) {
    push("sections", "MERCHANT_TOO_MANY_SECTIONS", `At most ${MERCHANT_TIER_LIMITS.maxSections} sections are allowed.`, "Remove sections.");
  }
  for (let i = 0; i < spec.datasets.length; i++) {
    const ds = spec.datasets[i]!;
    const path = `datasets[${i}](${ds.dataset_id})`;
    if (ds.joins.length > MERCHANT_TIER_LIMITS.maxJoinsPerDataset) {
      push(`${path}.joins`, "MERCHANT_TOO_MANY_JOINS", `At most ${MERCHANT_TIER_LIMITS.maxJoinsPerDataset} joins per dataset are allowed.`, "Remove joins.");
    }
    if (ds.select.length > MERCHANT_TIER_LIMITS.maxSelectFields) {
      push(`${path}.select`, "MERCHANT_TOO_MANY_SELECTS", `At most ${MERCHANT_TIER_LIMITS.maxSelectFields} select fields are allowed.`, "Remove select fields.");
    }
    if (ds.window_fields.length > MERCHANT_TIER_LIMITS.maxWindowFields) {
      push(`${path}.window_fields`, "MERCHANT_TOO_MANY_WINDOWS", `At most ${MERCHANT_TIER_LIMITS.maxWindowFields} window fields are allowed.`, "Remove window fields.");
    }
    if (ds.limit > MERCHANT_TIER_LIMITS.maxRowsPerDataset) {
      push(`${path}.limit`, "MERCHANT_ROW_LIMIT_EXCEEDED", `The dataset limit exceeds ${MERCHANT_TIER_LIMITS.maxRowsPerDataset} rows.`, "Lower the limit.");
    }
    const model = getMerchantReportHostConfig().models[ds.from_model];
    const dateColumn = model?.columns.created_at
      ? "created_at"
      : model?.columns.day
        ? "day"
        : null;
    if (!dateColumn) {
      push(`${path}.from_model`, "MERCHANT_DATE_RANGE_UNBOUNDED", `Model "${ds.from_model}" has no date column for the mandatory bounded range.`, "Use a dated model.");
      continue;
    }
    const predicates = rangePredicates(ds.where).filter((predicate) => predicate.column === dateColumn);
    let bounded = false;
    for (const predicate of predicates) {
      if (predicate.op === "between") {
        if (predicate.binding?.source === "INPUT") {
          const inputKey = predicate.binding.input_key;
          const input = spec.inputs.find((entry) => entry.key === inputKey);
          const maxRange = input?.validation?.max_range_days ?? 0;
          if (maxRange > 0 && maxRange <= MERCHANT_TIER_LIMITS.maxDateRangeDays) bounded = true;
        } else if (predicate.binding?.source === "LITERAL") {
          const value = predicate.binding.value as { start?: unknown; end?: unknown } | [unknown, unknown];
          const pair = Array.isArray(value) ? value : [value.start, value.end];
          const days = daysBetween(pair[0], pair[1]);
          if (days !== null && days <= MERCHANT_TIER_LIMITS.maxDateRangeDays) bounded = true;
        }
      }
    }
    if (!bounded) {
      const lower = predicates.find((predicate) => predicate.op === "gte" || predicate.op === "gt");
      const upper = predicates.find((predicate) => predicate.op === "lte" || predicate.op === "lt");
      if (lower && upper) {
        const lowerBinding = lower.binding;
        const upperBinding = upper.binding;
        if (
          lowerBinding?.source === "INPUT" &&
          upperBinding?.source === "INPUT" &&
          lowerBinding.input_key === upperBinding.input_key &&
          lowerBinding.range_bound === "START" &&
          upperBinding.range_bound === "END"
        ) {
          const input = spec.inputs.find((entry) => entry.key === lowerBinding.input_key);
          const maxRange = input?.validation?.max_range_days ?? 0;
          bounded = maxRange > 0 && maxRange <= MERCHANT_TIER_LIMITS.maxDateRangeDays;
        } else if (lowerBinding?.source === "LITERAL" && upperBinding?.source === "LITERAL") {
          const days = daysBetween(lowerBinding.value, upperBinding.value);
          bounded = days !== null && days <= MERCHANT_TIER_LIMITS.maxDateRangeDays;
        }
      }
    }
    if (!bounded) {
      push(
        `${path}.where`,
        "MERCHANT_DATE_RANGE_UNBOUNDED",
        `Every merchant dataset must bound ${dateColumn} to at most ${MERCHANT_TIER_LIMITS.maxDateRangeDays} days.`,
        `Add a between predicate on ${dateColumn} bound to a daterange input with validation.max_range_days <= ${MERCHANT_TIER_LIMITS.maxDateRangeDays}.`,
      );
    }
  }
  return diagnostics;
}

export class MerchantReportGuardError extends ApiError {
  readonly status: number;
  constructor(code: string, message: string, status = 429) {
    super(status, code, message);
    this.name = "MerchantReportGuardError";
    this.status = status;
  }
}

export async function assertMerchantEngineAvailable(merchantId: string): Promise<MerchantReportPolicy> {
  const policy = await readMerchantReportPolicy();
  if (!policy.enabled) {
    throw new MerchantReportGuardError(
      "MERCHANT_REPORT_DISABLED",
      "Merchant reporting is disabled by platform policy",
      503,
    );
  }
  const status = await client.merchantReportStudioStatus.findUnique({ where: { merchantId } });
  if (status?.suspendedAt) {
    throw new MerchantReportGuardError(
      "MERCHANT_REPORT_STUDIO_SUSPENDED",
      status.reason ? `Merchant reporting is suspended: ${status.reason}` : "Merchant reporting is suspended",
      403,
    );
  }
  return policy;
}

export async function assertMerchantRateLimit(merchantId: string, action: "verify" | "execute"): Promise<void> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  const count = await client.merchantReportRateEvent.count({
    where: { merchantId, action, createdAt: { gte: windowStart } },
  });
  const limit = action === "verify" ? env.MERCHANT_REPORT_VERIFY_PER_HOUR : env.MERCHANT_REPORT_EXECUTE_PER_HOUR;
  if (count >= limit) {
    throw new MerchantReportGuardError(
      "MERCHANT_REPORT_RATE_LIMITED",
      `The merchant ${action} limit (${limit}/hour) is exhausted`,
    );
  }
  await client.merchantReportRateEvent.create({ data: { merchantId, action } });
}

export async function assertMerchantBudget(merchantId: string): Promise<void> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const usage = await client.merchantReportExecutionAudit.aggregate({
    where: { merchantId, createdAt: { gte: startOfDay } },
    _sum: { durationMs: true },
  });
  if ((usage._sum.durationMs ?? 0) >= env.MERCHANT_REPORT_DAILY_DB_TIME_MS) {
    throw new MerchantReportGuardError(
      "MERCHANT_REPORT_BUDGET_EXHAUSTED",
      "The daily merchant reporting database-time budget is exhausted",
    );
  }
}

export async function assertMerchantQuota(merchantId: string, code?: string): Promise<void> {
  const codes = await client.merchantReportSpecRecord.groupBy({
    by: ["code"],
    where: { merchantId },
  });
  const isNewCode = Boolean(code) && !codes.some((entry) => entry.code === code);
  if (codes.length >= MERCHANT_TIER_LIMITS.maxCodes && (!code || isNewCode)) {
    throw new MerchantReportGuardError(
      "MERCHANT_REPORT_QUOTA_EXHAUSTED",
      `The merchant report-code quota (${MERCHANT_TIER_LIMITS.maxCodes}) is exhausted`,
    );
  }
  if (code) {
    const versions = await client.merchantReportSpecRecord.count({
      where: { merchantId, code },
    });
    if (versions >= MERCHANT_TIER_LIMITS.maxVersionsPerCode) {
      throw new MerchantReportGuardError(
        "MERCHANT_REPORT_VERSION_QUOTA_EXHAUSTED",
        `The version quota (${MERCHANT_TIER_LIMITS.maxVersionsPerCode}) for this report code is exhausted`,
      );
    }
  }
}

const runningPerMerchant = new Map<string, number>();
let globalRunning = 0;
const MAX_GLOBAL_MERCHANT_RUNS = 4;

export function acquireMerchantExecutionSlot(merchantId: string): () => void {
  if ((runningPerMerchant.get(merchantId) ?? 0) > 0) {
    throw new MerchantReportGuardError("MERCHANT_REPORT_BUSY", "Another report of this merchant is still running");
  }
  if (globalRunning >= MAX_GLOBAL_MERCHANT_RUNS) {
    throw new MerchantReportGuardError("MERCHANT_REPORT_BUSY", "The merchant reporting line is busy; retry shortly");
  }
  runningPerMerchant.set(merchantId, 1);
  globalRunning += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runningPerMerchant.delete(merchantId);
    globalRunning = Math.max(0, globalRunning - 1);
  };
}

interface MerchantCacheEntry {
  expiresAt: number;
  value: unknown;
}
const merchantResultCache = new Map<string, MerchantCacheEntry>();

export function merchantCacheKey(params: {
  merchantId: string;
  spec: ReportDescriptorSpec;
  inputs: Record<string, unknown>;
  chromeFingerprint?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        merchantId: params.merchantId,
        spec: params.spec,
        inputs: params.inputs,
        chromeFingerprint: params.chromeFingerprint ?? "",
      }),
    )
    .digest("hex");
}

export function readMerchantCache<T>(key: string): T | null {
  const entry = merchantResultCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    merchantResultCache.delete(key);
    return null;
  }
  return entry.value as T;
}

export function writeMerchantCache(key: string, value: unknown): void {
  merchantResultCache.set(key, { value, expiresAt: Date.now() + 60_000 });
  if (merchantResultCache.size > 500) {
    const now = Date.now();
    for (const [entryKey, entry] of merchantResultCache) {
      if (entry.expiresAt <= now || merchantResultCache.size > 500) merchantResultCache.delete(entryKey);
    }
  }
}

export function resetMerchantReportRuntimeForTests(): void {
  cachedEngine = null;
  cachedPolicy = null;
  runningPerMerchant.clear();
  globalRunning = 0;
  merchantResultCache.clear();
}
