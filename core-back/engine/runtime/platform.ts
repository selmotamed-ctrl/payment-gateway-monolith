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
import { PrismaOperatorCaseSink } from "../compliance/OperatorCaseSink";
import { PrismaReportingRuleSource, ReportingRuleEvaluator } from "../compliance/ReportingRuleEvaluator";
import { invalidationBus } from "../../lib/invalidationBus";
import { ApiError } from "../../lib/error";
import { ApiConsumerError } from "../apiConsumer/ApiConsumer";
import type { DynamicAttempt } from "../flow/DynamicRailEngine";

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
  credentialCheck: CredentialCheckService;
}

interface CredentialRow {
  key: string;
  type: string;
  value: string;
  isSecret: boolean;
  secretVersion?: number;
}

const asEntries = (value: unknown): CredentialRow[] =>
  Array.isArray(value) ? value as CredentialRow[] : [];

export interface ConsumerConfigKey {
  gatewayId: string;
  env: string;
  credentialSetId: string;
  gatewayVersionId?: string;
}

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
        | {
            gatewayId?: string;
            env?: string;
            credentialSetId?: string;
            gatewayVersionId?: string;
          }
        | undefined;
      if (!attempt?.env || !attempt.credentialSetId) {
        return undefined;
      }
      // The consumer is built from the configuration the attempt pins (design
      // v5 §9.1 rule 1): the pinned gateway version and the pinned credential
      // set. The gateway id is derived from the pinned version when the
      // projection did not carry it.
      const gatewayId = attempt.gatewayId ?? await gatewayIdOfVersion(db, attempt.gatewayVersionId);
      if (!gatewayId) {
        return undefined;
      }
      return consumerRegistry.getConsumer({
        gatewayId,
        env: attempt.env,
        credentialSetId: attempt.credentialSetId,
        ...(attempt.gatewayVersionId ? { gatewayVersionId: attempt.gatewayVersionId } : {}),
      });
    },
  });

  const ledgerPoster = new LedgerPoster(db as never);
  const attempts = new PrismaAttemptRepository(db);
  const slots = new PrismaSlotReservationStore(db);
  const flowProvider = new PrismaFlowProvider(db);
  const callbackVerifier = new PrismaCallbackVerifier(db, vault, crypto);
  const contextCipher = new VaultContextCipher(vault);
  const reportingCipher = new VaultContextCipher(vault, "reporting-payload");
  const reportingEvaluator = new ReportingRuleEvaluator(
    new PrismaReportingRuleSource(db),
    {
      codec: {
        encode: async (plaintext) => await reportingCipher.encrypt(plaintext),
        decode: async (ciphertext) => {
          const decoded = await reportingCipher.decrypt(ciphertext);
          return typeof decoded === "string" ? decoded : JSON.stringify(decoded);
        },
      },
    },
  );
  const credentialCheck = new CredentialCheckService({
    db,
    vault,
    consumerRegistry,
    stepExecutor,
    flowProvider,
  });

  const engine = new DynamicRailEngine({
    attempts,
    slots,
    flowProvider,
    stepExecutor,
    ledgerPoster,
    callbackVerifier,
    contextCipher,
    operatorCaseSink: new PrismaOperatorCaseSink(db),
    reportingEvaluator,
    invalidationBus,
    credentialResolver: async (attempt) => {
      // A credential set that was never verified is verified on its first
      // use, so a merchant can register a credential and start a payment
      // without an operator in the loop.
      if (attempt.status === "INITIATING") {
        await credentialCheck.ensureVerified(attempt);
      }
      return resolveCredentialValues(db, vault, attempt.credentialSetId);
    },
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
    credentialCheck,
  };
};

/**
 * The gateway of a pinned gateway version.
 */
const gatewayIdOfVersion = async (
  db: PrismaLike,
  gatewayVersionId: string | undefined,
): Promise<string | undefined> => {
  if (!gatewayVersionId) {
    return undefined;
  }
  const version = await db.gatewayVersion.findUnique({
    where: { id: gatewayVersionId },
    select: { gatewayId: true },
  });
  return version?.gatewayId ? String(version.gatewayId) : undefined;
};

/**
 * Loads the configuration of the outbound consumer.
 *
 * The version is the one the attempt pins (design v5 §9.1 rule 1) and the
 * credential entries are the ones of the credential set the attempt pins. The
 * consumer therefore never mixes the authentication recipe of one version
 * with the secrets of another one.
 */
export const loadConsumerConfig = async (
  db: PrismaLike,
  vault: Vault,
  key: ConsumerConfigKey,
): Promise<ApiConsumerConfig> => {
  const credentialSet = await db.credentialSet.findUnique({
    where: { id: key.credentialSetId },
  });
  if (!credentialSet) {
    throw new Error(`Credential set '${key.credentialSetId}' does not exist`);
  }
  const version = key.gatewayVersionId
    ? await db.gatewayVersion.findUnique({
        where: { id: key.gatewayVersionId },
        include: { auth: true, environments: true, setting: true },
      })
    : await db.gatewayVersion.findFirst({
        where: { gatewayId: key.gatewayId, state: "LIVE" },
        orderBy: { versionNumber: "desc" },
        include: { auth: true, environments: true, setting: true },
      });
  if (!version) {
    throw new Error(
      `Gateway version '${key.gatewayVersionId ?? key.gatewayId}' does not exist`,
    );
  }
  if (String(credentialSet.gatewayId) !== String(version.gatewayId)) {
    throw new Error(
      `Credential set '${key.credentialSetId}' does not belong to gateway '${String(version.gatewayId)}'`,
    );
  }
  const auth = version.auth?.find((entry: { env: string }) => entry.env === key.env) ?? version.auth?.[0];
  const environment = version.environments?.find((entry: { env: string }) => entry.env === key.env);
  const allowedHosts = Array.isArray(environment?.allowedHosts)
    ? (environment?.allowedHosts as string[])
    : [];
  const baseUrls = (environment?.baseUrls ?? {}) as Record<string, string>;
  const baseUrl = baseUrls.api ?? baseUrls.checkout ?? Object.values(baseUrls)[0];

  const credentials: Record<string, string> = {};
  for (const entry of asEntries(credentialSet.entriesCiphertext)) {
    if (!entry || typeof entry.key !== "string" || typeof entry.value !== "string") {
      continue;
    }
    credentials[entry.key] = entry.isSecret ? await vault.decryptSecret(entry.value) : entry.value;
  }

  return {
    gatewayId: String(version.gatewayId),
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
    // Safeguard 5 (design §8.1): a rotated refresh token must be persisted
    // BEFORE the refresh promise resolves, otherwise a restart (or the next
    // refresh) replays the old token and the gateway rejects the session.
    rotatingRefreshTokenPersistence: async (input) => {
      const current = await db.credentialSet.findUnique({
        where: { id: input.credentialSetId },
      });
      if (!current) {
        return;
      }
      const entries = asEntries(current.entriesCiphertext);
      const encrypted = await vault.encryptSecret(input.newRefreshToken, "credential-set");
      const nextVersion = entries.reduce(
        (max, entry) => Math.max(max, Number(entry.secretVersion ?? 1)),
        1,
      ) + 1;
      const updated = entries.map((entry) =>
        entry.key === input.selector
          ? { ...entry, value: encrypted, isSecret: true, secretVersion: nextVersion }
          : entry,
      );
      if (!updated.some((entry) => entry.key === input.selector)) {
        // The selector names the credential the gateway rotates.
        updated.push({
          key: input.selector,
          type: "BODY",
          value: encrypted,
          isSecret: true,
          secretVersion: nextVersion,
        });
      }
      await db.$transaction(async (tx: PrismaLike) => {
        await tx.credentialSet.update({
          where: { id: input.credentialSetId },
          data: { entriesCiphertext: updated },
        });
      });
      // The consumer cache of this credential set is now stale.
      await invalidationBus.invalidateCredential(input.credentialSetId, "refresh-token-rotated");
    },
  };
};

export interface CredentialCheckOptions {
  db: PrismaLike;
  vault: Vault;
  consumerRegistry: ConsumerRegistry;
  stepExecutor: StepExecutor;
  flowProvider: PrismaFlowProvider;
}

export interface CredentialCheckResult {
  credentialSetId: string;
  gatewayId: string;
  gatewayVersionId: string | null;
  env: string;
  status: "VERIFIED" | "FAILING";
  /** `FLOW` when the version defines a credential check flow, `PROBE` otherwise. */
  method: "FLOW" | "PROBE";
  reason?: string;
  httpStatus?: number;
  checkedAt: Date;
}

/**
 * The credential check of design v5 §7.4 and §16.2.
 *
 * The check resolves the credential set of a gateway, an environment and an
 * external merchant id, proves that the credentials work and records the
 * verdict on the credential set:
 *
 *   - success: `status = VERIFIED` and `last_verified_at = now`;
 *   - failure: `status = FAILING`.
 *
 * A version that defines the steps of the `CREDENTIAL_CHECK` phase runs them;
 * every other version is probed against the base URL of its environment with
 * the `ApiConsumer`, so the authentication recipe of the pinned version is
 * exercised for real.
 */
export class CredentialCheckService {
  private readonly options: CredentialCheckOptions;

  constructor(options: CredentialCheckOptions) {
    this.options = options;
  }

  /**
   * Resolves the credential set of a gateway, an environment and an external
   * merchant id. A platform owned set has no external merchant, so the
   * sentinel `PLATFORM` identifies it.
   */
  async resolveCredentialSet(input: {
    gatewayId: string;
    env: string;
    externalMerchantId?: string | null;
    ownerType?: "PLATFORM" | "MERCHANT";
    ownerMerchantId?: string | null;
  }): Promise<Record<string, unknown> | null> {
    const externalMerchantId = input.externalMerchantId ?? "PLATFORM";
    const credentialSet = await this.options.db.credentialSet.findFirst({
      where: {
        gatewayId: input.gatewayId,
        env: input.env,
        externalMerchantId,
        ...(input.ownerType ? { ownerType: input.ownerType } : {}),
        ...(input.ownerMerchantId ? { ownerMerchantId: input.ownerMerchantId } : {}),
      },
    });
    return (credentialSet as Record<string, unknown> | null) ?? null;
  }

  /**
   * Verifies a credential set and records the verdict on it.
   */
  async verify(
    credentialSetId: string,
    options: { gatewayVersionId?: string } = {},
  ): Promise<CredentialCheckResult> {
    const db = this.options.db;
    const credentialSet = await db.credentialSet.findUnique({
      where: { id: credentialSetId },
    });
    if (!credentialSet) {
      throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
    }
    const gatewayId = String(credentialSet.gatewayId);
    const env = String(credentialSet.env);
    const version = await this.resolveGatewayVersion(gatewayId, options.gatewayVersionId);
    if (!version) {
      return this.record(credentialSetId, {
        credentialSetId,
        gatewayId,
        gatewayVersionId: options.gatewayVersionId ?? null,
        env,
        status: "FAILING",
        method: "PROBE",
        reason: "The gateway has no configuration version to verify the credentials against",
        checkedAt: new Date(),
      });
    }

    const attempt = {
      id: `credential-check:${credentialSetId}`,
      reference: `CREDENTIAL-CHECK:${credentialSetId}`,
      gatewayId,
      gatewayVersionId: version.id,
      credentialSetId,
      env,
      status: "CREATED",
      currency: "LYD",
      requestedAmount: "0.0000",
      totalChargedAmount: "0.0000",
      otpAttempts: 0,
      context: {},
    } as unknown as DynamicAttempt;

    const steps = await this.options.flowProvider.getCredentialCheckSteps(attempt);
    if (steps.length > 0) {
      return this.runFlowCheck(credentialSetId, attempt, steps);
    }
    return this.runProbeCheck(credentialSetId, attempt, version.id);
  }

  /**
   * Verifies the credential set of an attempt when it was never verified.
   *
   * The attempt pins the credential set and the gateway version, so the check
   * is executed against exactly that configuration.
   */
  async ensureVerified(attempt: DynamicAttempt): Promise<void> {
    const credentialSetId = attempt.credentialSetId;
    if (!credentialSetId) {
      return;
    }
    const credentialSet = await this.options.db.credentialSet.findUnique({
      where: { id: credentialSetId },
    });
    if (!credentialSet) {
      throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
    }
    const status = String(credentialSet.status);
    if (status === "VERIFIED") {
      return;
    }
    if (status === "REVOKED") {
      throw new ApiError(409, "CREDENTIAL_SET_REVOKED", "The credential set was revoked");
    }
    const result = await this.verify(credentialSetId, {
      ...(attempt.gatewayVersionId ? { gatewayVersionId: attempt.gatewayVersionId } : {}),
    });
    if (result.status !== "VERIFIED") {
      throw new ApiError(
        502,
        "CREDENTIAL_VERIFICATION_FAILED",
        result.reason ?? "The credentials of the gateway could not be verified",
        { credentialSetId, method: result.method },
      );
    }
  }

  private async resolveGatewayVersion(
    gatewayId: string,
    gatewayVersionId?: string,
  ): Promise<{ id: string } | null> {
    if (gatewayVersionId) {
      const pinned = await this.options.db.gatewayVersion.findUnique({
        where: { id: gatewayVersionId },
        select: { id: true },
      });
      return pinned ?? null;
    }
    const gateway = await this.options.db.gateway.findUnique({
      where: { id: gatewayId },
      select: { activeVersionId: true },
    });
    if (gateway?.activeVersionId) {
      const active = await this.options.db.gatewayVersion.findUnique({
        where: { id: gateway.activeVersionId },
        select: { id: true },
      });
      if (active) {
        return active;
      }
    }
    const live = await this.options.db.gatewayVersion.findFirst({
      where: { gatewayId, state: "LIVE" },
      orderBy: { versionNumber: "desc" },
      select: { id: true },
    });
    return live ?? null;
  }

  /**
   * Runs the `CREDENTIAL_CHECK` steps of the pinned version.
   */
  private async runFlowCheck(
    credentialSetId: string,
    attempt: DynamicAttempt,
    steps: readonly { id: string }[],
  ): Promise<CredentialCheckResult> {
    const credentials = await resolveCredentialValues(
      this.options.db,
      this.options.vault,
      credentialSetId,
    );
    for (const step of steps) {
      const result = await this.options.stepExecutor.execute(
        step as Parameters<StepExecutor["execute"]>[0],
        {
          attempt: attempt as unknown as Record<string, unknown>,
          credentials,
        },
      );
      if (result.status === "FAILED" || result.status === "UNKNOWN") {
        return this.record(credentialSetId, {
          credentialSetId,
          gatewayId: String(attempt.gatewayId ?? ""),
          gatewayVersionId: attempt.gatewayVersionId ?? null,
          env: String(attempt.env ?? ""),
          status: "FAILING",
          method: "FLOW",
          reason: result.canonicalError ?? `The credential check step '${step.id}' failed`,
          checkedAt: new Date(),
        });
      }
    }
    return this.record(credentialSetId, {
      credentialSetId,
      gatewayId: String(attempt.gatewayId ?? ""),
      gatewayVersionId: attempt.gatewayVersionId ?? null,
      env: String(attempt.env ?? ""),
      status: "VERIFIED",
      method: "FLOW",
      reason: "The credential check flow of the gateway version succeeded",
      checkedAt: new Date(),
    });
  }

  /**
   * Probes the gateway with the `ApiConsumer`.
   *
   * The probe authenticates with the recipe of the pinned version and the
   * secrets of the pinned credential set, so a wrong secret or a wrong
   * authentication method is detected before a payment is started.
   */
  private async runProbeCheck(
    credentialSetId: string,
    attempt: DynamicAttempt,
    gatewayVersionId: string,
  ): Promise<CredentialCheckResult> {
    const gatewayId = String(attempt.gatewayId ?? "");
    const env = String(attempt.env ?? "");
    const base = {
      credentialSetId,
      gatewayId,
      gatewayVersionId,
      env,
      method: "PROBE" as const,
      checkedAt: new Date(),
    };
    let consumer;
    try {
      consumer = await this.options.consumerRegistry.getConsumer({
        gatewayId,
        env,
        credentialSetId,
        gatewayVersionId,
      });
    } catch (error) {
      return this.record(credentialSetId, {
        ...base,
        status: "FAILING",
        reason: error instanceof Error ? error.message : "The outbound consumer could not be built",
      });
    }
    const environment = await this.options.db.gatewayEnvironment.findFirst({
      where: { gatewayVersionId, env },
    });
    const baseUrls = (environment?.baseUrls ?? {}) as Record<string, string>;
    const baseUrl = baseUrls.api ?? baseUrls.checkout ?? Object.values(baseUrls)[0];
    if (!baseUrl) {
      return this.record(credentialSetId, {
        ...base,
        status: "FAILING",
        reason: "The gateway environment has no base URL to probe",
      });
    }
    try {
      const response = await consumer.request({
        method: "GET",
        url: baseUrl,
        sideEffect: "READ_ONLY",
        retryPolicy: "NEVER",
      });
      if (response.status === 401 || response.status === 403) {
        return this.record(credentialSetId, {
          ...base,
          status: "FAILING",
          httpStatus: response.status,
          reason: `The gateway rejected the credentials with HTTP ${response.status}`,
        });
      }
      if (response.status >= 500) {
        return this.record(credentialSetId, {
          ...base,
          status: "FAILING",
          httpStatus: response.status,
          reason: `The gateway answered with HTTP ${response.status}`,
        });
      }
      return this.record(credentialSetId, {
        ...base,
        status: "VERIFIED",
        httpStatus: response.status,
        reason: "The gateway accepted the credentials",
      });
    } catch (error) {
      const status = error instanceof ApiConsumerError ? error.status : undefined;
      return this.record(credentialSetId, {
        ...base,
        status: "FAILING",
        ...(status ? { httpStatus: status } : {}),
        reason: error instanceof Error ? error.message : "The credential probe failed",
      });
    }
  }

  /**
   * Records the verdict of the check on the credential set.
   */
  private async record(
    credentialSetId: string,
    result: CredentialCheckResult,
  ): Promise<CredentialCheckResult> {
    await this.options.db.credentialSet.update({
      where: { id: credentialSetId },
      data: {
        status: result.status,
        ...(result.status === "VERIFIED" ? { lastVerifiedAt: result.checkedAt } : {}),
      },
    });
    return result;
  }
}

export { consumerRegistryKey };
