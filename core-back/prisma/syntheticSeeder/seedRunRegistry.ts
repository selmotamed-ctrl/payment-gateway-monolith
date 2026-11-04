import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { SeederConfig } from "./config";

/**
 * Durable record of successful synthetic seed runs.
 *
 * A seed run is keyed by `SYNTHETIC_SEED_KEY`. Once a run with a given key has
 * completed (all rows written, Fake Rails synced, post-seed audit clean), the
 * marker below lets later deployments skip regenerating the same history.
 * Failed or interrupted runs never write the marker, so they are retried.
 */

export const SYNTHETIC_SEED_SCOPE = "SYNTHETIC_SEED";

export interface CompletedSeedRun {
  seedKey: string;
  namespace: string;
  profile: string;
  yearsSpan: number;
  completedAt: string;
  attempts?: number;
  journalLines?: number;
  ledgerDrift?: string;
}

export const seedRunKey = (seedKey: string): string => `synthetic.seed.completed:${seedKey}`;

const asCompletedSeedRun = (value: unknown): CompletedSeedRun | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.seedKey !== "string") return null;
  return record as unknown as CompletedSeedRun;
};

export const findCompletedSeedRun = async (
  prisma: PrismaClient,
  seedKey: string,
): Promise<CompletedSeedRun | null> => {
  const setting = await prisma.platformSetting.findFirst({
    where: { key: seedRunKey(seedKey), scope: SYNTHETIC_SEED_SCOPE },
    orderBy: { version: "desc" },
  });
  return setting ? asCompletedSeedRun(setting.valueJson) : null;
};

/**
 * A completed history under a *different* seed key and the same namespace.
 * The generated rows carry key-independent unique values (emails, names), so a
 * second history cannot be layered on top: `skipDuplicates` silently drops the
 * colliding parents and the dependent children then fail their foreign keys.
 */
export const findOtherCompletedSeedRun = async (
  prisma: PrismaClient,
  seedKey: string,
  namespace: string,
): Promise<CompletedSeedRun | null> => {
  const settings = await prisma.platformSetting.findMany({
    where: {
      scope: SYNTHETIC_SEED_SCOPE,
      key: { startsWith: "synthetic.seed.completed:", not: seedRunKey(seedKey) },
    },
    orderBy: { effectiveFrom: "desc" },
  });
  for (const setting of settings) {
    const run = asCompletedSeedRun(setting.valueJson);
    if (run && run.namespace === namespace) return run;
  }
  return null;
};

export const recordCompletedSeedRun = async (
  prisma: PrismaClient,
  config: SeederConfig,
  summary: { attempts?: number; journalLines?: number; ledgerDrift?: string } = {},
): Promise<void> => {
  const key = seedRunKey(config.seedKey);
  const value: CompletedSeedRun = {
    seedKey: config.seedKey,
    namespace: config.namespace,
    profile: config.profile,
    yearsSpan: config.volumes.yearsSpan,
    completedAt: new Date().toISOString(),
    ...summary,
  };
  const valueJson = value as unknown as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({
    where: { key_scope_version: { key, scope: SYNTHETIC_SEED_SCOPE, version: 1 } },
    update: { valueJson, effectiveFrom: new Date() },
    create: {
      key,
      scope: SYNTHETIC_SEED_SCOPE,
      version: 1,
      valueJson,
      effectiveFrom: new Date(),
    },
  });
};
