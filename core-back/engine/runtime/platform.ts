import type { PrismaLike } from "../db/ports";
import { PrismaRepositories } from "../db/repositories";
import type { ApiConsumerConfig } from "../apiConsumer/ApiConsumer";
import { ConsumerRegistry, consumerRegistryKey } from "../apiConsumer/ConsumerRegistry";
import { DynamicRailEngine } from "../flow/DynamicRailEngine";
import { StepExecutor } from "../flow/StepExecutor";
import { LedgerPoster } from "../ledger/LedgerPoster";
import { Vault } from "../crypto/Vault";
import { CryptoEngine } from "../crypto/CryptoEngine";
import { AttemptGuardPipeline } from "../guards/AttemptGuardPipeline";
import {
  CachedScreeningProvider,
  InternalWatchlistProvider,
  type ScreeningProvider,
} from "../guards/ScreeningProvider";
import { PrismaAttemptRepository } from "./attemptRepository";
import { PrismaSlotReservationStore } from "./slotStore";
import { PrismaFlowProvider } from "./flowProvider";
import { PrismaCallbackVerifier } from "./callbackVerifier";
import { createComputeRegistry } from "./computeRegistry";
import { resolveCredentialValues } from "./credentials";
import { VaultContextCipher } from "./contextCipher";

export interface PlatformRuntime {
  engine: DynamicRailEngine;
  ledgerPoster: LedgerPoster;
  guardPipeline: AttemptGuardPipeline;
  screening: ScreeningProvider;
  consumerRegistry: ConsumerRegistry;
  stepExecutor: StepExecutor;
  callbackVerifier: PrismaCallbackVerifier;
  vault: Vault;
  crypto: CryptoEngine;
  repositories: PrismaRepositories;
}

interface CredentialRow {
  key: string;
  type: string;
  value: string;
  isSecret: boolean;
}

const asEntries = (value: unknown): CredentialRow[] =>
  Array.isArray(value) ? value as CredentialRow[] : [];

/**
 * The production composition root of `core-back`.
 *
 * Everything the running service needs is constructed exactly once here so
 * that the HTTP routes, the durable workers and the outbound gateway calls
 * all share the same ledger poster, the same registry and the same cache.
 */
export const createPlatformRuntime = (db: PrismaLike): PlatformRuntime => {
  const vault = new Vault();
  const crypto = new CryptoEngine();
  const repositories = new PrismaRepositories(db);

  const consumerRegistry = new ConsumerRegistry({
    loadConfig: async (key) => loadConsumerConfig(db, vault, key),
  });

  const stepExecutor = new StepExecutor({
    vault,
    computeRegistry: createComputeRegistry({ db, vault, crypto }),
    apiConsumerResolver: async (context) => {
      const attempt = context.attempt as
        | { gatewayId?: string; env?: string; credentialSetId?: string }
        | undefined;
      if (!attempt?.gatewayId || !attempt.env || !attempt.credentialSetId) {
        return undefined;
      }
      return consumerRegistry.getConsumer({
        gatewayId: attempt.gatewayId,
        env: attempt.env,
        credentialSetId: attempt.credentialSetId,
      });
    },
  });

  const ledgerPoster = new LedgerPoster(db as never);
  const attempts = new PrismaAttemptRepository(db);
  const slots = new PrismaSlotReservationStore(db);
  const flowProvider = new PrismaFlowProvider(db);
  const callbackVerifier = new PrismaCallbackVerifier(db, vault, crypto);

  const engine = new DynamicRailEngine({
    attempts,
    slots,
    flowProvider,
    stepExecutor,
    ledgerPoster,
    callbackVerifier,
    contextCipher: new VaultContextCipher(vault),
    credentialResolver: async (attempt) =>
      resolveCredentialValues(db, vault, attempt.credentialSetId),
    transactionRunner: async (callback) => db.$transaction(async (tx: PrismaLike) => callback(tx)),
  });

  const screening = new CachedScreeningProvider(new InternalWatchlistProvider());
  const guardPipeline = new AttemptGuardPipeline({ db, repositories, screening });

  return {
    engine,
    ledgerPoster,
    guardPipeline,
    screening,
    consumerRegistry,
    stepExecutor,
    callbackVerifier,
    vault,
    crypto,
    repositories,
  };
};

const loadConsumerConfig = async (
  db: PrismaLike,
  vault: Vault,
  key: { gatewayId: string; env: string; credentialSetId: string },
): Promise<ApiConsumerConfig> => {
  const credentialSet = await db.credentialSet.findUnique({
    where: { id: key.credentialSetId },
  });
  if (!credentialSet) {
    throw new Error(`Credential set '${key.credentialSetId}' does not exist`);
  }
  const version = await db.gatewayVersion.findFirst({
    where: { gatewayId: key.gatewayId, state: "LIVE" },
    orderBy: { versionNumber: "desc" },
    include: { auth: true, environments: true, setting: true },
  });
  const auth = version?.auth?.find((entry: { env: string }) => entry.env === key.env) ?? version?.auth?.[0];
  const environment = version?.environments?.find((entry: { env: string }) => entry.env === key.env);
  const allowedHosts = Array.isArray(environment?.allowedHosts)
    ? (environment?.allowedHosts as string[])
    : [];
  const baseUrls = (environment?.baseUrls ?? {}) as Record<string, string>;
  const baseUrl = baseUrls[auth?.authApply ?? "HEADER"] ?? Object.values(baseUrls)[0];

  const credentials: Record<string, string> = {};
  for (const entry of asEntries(credentialSet.entriesCiphertext)) {
    if (entry.type !== "HEADER") {
      continue;
    }
    credentials[entry.key] = entry.isSecret ? await vault.decryptSecret(entry.value) : entry.value;
  }

  return {
    gatewayId: key.gatewayId,
    env: key.env,
    credentialSetId: key.credentialSetId,
    allowedHosts,
    baseUrl,
    timeoutMs: version?.setting?.timeoutMs ?? 15000,
    credentials,
    auth: {
      method: (auth?.method ?? "API_KEY") as never,
      apply: (auth?.authApply ?? "HEADER") as never,
      ...(typeof auth?.refreshConfigJson === "object" && auth?.refreshConfigJson !== null
        ? (auth.refreshConfigJson as Record<string, never>)
        : {}),
    },
  };
};

export { consumerRegistryKey };
