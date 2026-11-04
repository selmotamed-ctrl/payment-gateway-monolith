import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import type { SeederConfig } from "./config";
import { emptyDataset, type SyntheticDataset } from "./dataset";
import { Prng } from "./prng";
import { buildTimeline, type TimelineConfig } from "./timelineClock";

export interface GatewayRef {
  id: string;
  code: string;
  kind: string;
  activeVersionId?: string | null;
}
export interface VersionRef {
  id: string;
  gatewayId: string;
  gatewayCode: string;
  versionNumber?: number;
  state?: string;
  environments: Array<{ id: string; env: string }>;
}
export interface RailRef {
  id: string;
  code: string;
  collectionMode: string;
}
export interface RouteRef {
  id: string;
  railId: string;
  railCode: string;
  gatewayId: string;
  gatewayCode: string;
  credentialPolicy: string;
  /** The pinned route cost model (`rail_routes.cost_model`). */
  costModel?: Record<string, unknown> | null;
  status?: string;
  healthState?: string;
  minAmount?: string | null;
  maxAmount?: string | null;
}
export interface CredentialRef {
  id: string;
  gatewayId: string;
  gatewayCode: string;
  env: string;
  ownerType: string;
  settlementTarget: string;
  ownerMerchantId?: string | null;
  status?: string;
}
export interface GlRef {
  id: string;
  accountType: string;
  gatewayId: string | null;
  env: string | null;
  ownerId: string | null;
  credentialSetId?: string | null;
  currency?: string | null;
}
export interface UserRef {
  id: string;
  email: string;
  role: string;
}
export interface CommissionProfileRef {
  id: string;
  merchantId: string | null;
  applicationId: string | null;
  railCode: string;
  calcType: string;
  flatFee: string;
  percentageRate: string;
  tiersJson: unknown;
  minFee: string;
  maxFee: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}
export interface NotificationTemplateRef {
  code: string;
  channel: string;
  lang: string;
}

export interface SeedReferences {
  gateways: GatewayRef[];
  versions: VersionRef[];
  rails: RailRef[];
  routes: RouteRef[];
  credentials: CredentialRef[];
  glAccounts: GlRef[];
  adminUsers: UserRef[];
  statementSources: Array<{
    id: string;
    gatewayId: string;
    gatewayCode: string;
    settlementLagDays?: number;
    parserConfig?: unknown;
  }>;
  /** Platform-level commission profiles from the baseline seed (`railCode = default`, ...). */
  commissionProfiles?: CommissionProfileRef[];
  /** The baseline notification catalogue (`prisma/seed.ts`). */
  notificationTemplates?: NotificationTemplateRef[];
  /** `platform_settings.onboarding.required_documents` (raw JSON), when configured. */
  requiredDocumentsSetting?: unknown;
  /** Existing confirmation channels (the baseline webhook channels). */
  confirmationChannels?: Array<{ id: string; gatewayVersionId: string; type: string }>;
}

/**
 * Generator-to-generator facts that are not columns. They never reach the
 * database; they let the later generators continue the SAME lifecycle the
 * earlier ones started (an AML hold that is later released, a success that
 * is later refunded, ...).
 */
export interface AttemptMeta {
  /** The status history, each step a transition allowed by the engine. */
  path: string[];
  /** One timestamp per `path` entry (monotonic, never after `timeline.end`). */
  times: Date[];
  kind:
    | "NORMAL"
    | "LATE_SUCCESS"
    | "SUSPENSE"
    | "CONFLICT"
    | "STUCK_UNKNOWN"
    | "MANUAL_REVIEW"
    | "AML_HELD"
    | "AML_RELEASED"
    | "AML_VOIDED"
    | "LIVE";
  ownershipMode: "INTERNAL" | "PLATFORM_CLEARING" | "MERCHANT_DIRECT";
  feeAccrual: boolean;
  gatewayId: string;
  gatewayCode: string;
  walletGlAccountId: string;
  walletId: string;
  railMode: string;
  /** Set when the engine would have touched the gateway (fake rails knows it). */
  reachedGateway: boolean;
  /** The authoritative status the Fake Rails emulator holds for this attempt. */
  gatewayTruth?: "PAID" | "FAILED" | "PENDING";
  amlCaseStatus?: string;
  amlSeverity?: string;
  holdEntryId?: string;
  refund?: { at: Date; amount: string; full: boolean };
  dispute?: { at: Date };
  failureCode?: string;
}

export interface MerchantInfo {
  id: string;
  status: string;
  categoryCode: string;
  ticketMin: number;
  ticketMax: number;
  pos: boolean;
  createdAt: Date;
  /** When payments may start (KYB approved), or null when never activated. */
  activatedAt: Date | null;
  /** When payments stop (suspension / closure), or null. */
  stoppedAt: Date | null;
  suspensionReason: string | null;
  adminUserId: string | null;
  wallets: Array<{ id: string; glAccountId: string; createdAt: Date; status: string }>;
  applicationIds: string[];
  negativeBalanceCeiling: string;
  /** The final join request: the maker-checker facts generator 08 binds approvals to. */
  join?: {
    requestId: string;
    status: string;
    reviewerId: string | null;
    proposedAt: Date | null;
    decidedAt: Date | null;
    fourEyes: boolean;
  };
}

/** A sensitive column filled by the async Vault pass before the bulk write. */
export interface PendingSecret {
  row: Record<string, unknown>;
  field: string;
  plaintext: string;
  keyId: string;
  /** `context` = VaultContextCipher JSON envelope, `secret` = encryptSecret. */
  mode: "secret" | "context";
}

export interface SeederMeta {
  attempts: Map<string, AttemptMeta>;
  merchants: Map<string, MerchantInfo>;
  pendingSecrets: PendingSecret[];
  /** `${refType}:${refId}` of every posted journal entry (DB-unique pair). */
  journalKeys: Set<string>;
  /** The synthetic system-automation user that drafts chargebacks. */
  systemUserId?: string;
  /** Ledger account resolution cache. */
  accountCache: Map<string, string>;
}

export interface SeederContext {
  prisma: PrismaClient;
  config: SeederConfig;
  rng: Prng;
  timeline: TimelineConfig;
  dataset: SyntheticDataset;
  refs: SeedReferences;
  /** Monotonic id factory, namespaced so two seeds never collide. */
  nextId: (entity: string) => string;
  /** Monthly GL checkpoint snapshots applied after the bulk insert. */
  checkpoints: Map<string, { balance: string; at: Date; lastCheckpointId: string }>;
  meta?: SeederMeta;
}

export const emptyMeta = (): SeederMeta => ({
  attempts: new Map(),
  merchants: new Map(),
  pendingSecrets: [],
  journalKeys: new Set(),
  accountCache: new Map(),
});

export const metaOf = (ctx: SeederContext): SeederMeta => {
  if (!ctx.meta) ctx.meta = emptyMeta();
  return ctx.meta;
};

/**
 * A deterministic, RFC-4122-shaped (version 7 nibble, variant 8) id whose
 * first 64 bits are derived from the namespace AND the seed key.
 *
 * The previous factory ignored both, so two different seed keys produced the
 * same ids and `createMany({ skipDuplicates: true })` silently dropped the
 * second history. The counter keeps ids unique within a run; the prefix keeps
 * runs apart.
 */
export const createIdFactory = (namespace: string, seedKey: string): ((entity: string) => string) => {
  const digest = createHash("sha256").update(`synthetic-seeder:${namespace}:${seedKey}`).digest("hex");
  const prefix = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-7${digest.slice(12, 15)}-8${digest.slice(15, 18)}`;
  let counter = 0;
  return (_entity: string) => {
    counter += 1;
    if (counter > 0xffffffffffff) throw new Error("Synthetic id space exhausted");
    return `${prefix}-${counter.toString(16).padStart(12, "0")}`;
  };
};

const decimalText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export const loadReferences = async (prisma: PrismaClient): Promise<SeedReferences> => {
  const gateways = await prisma.gateway.findMany({ select: { id: true, code: true, kind: true, activeVersionId: true } });
  const versions = await prisma.gatewayVersion.findMany({
    include: { gateway: { select: { code: true } }, environments: { select: { id: true, env: true } } },
  });
  const rails = await prisma.rail.findMany({ select: { id: true, code: true, collectionMode: true } });
  const routes = await prisma.railRoute.findMany({
    include: { rail: { select: { code: true } }, gateway: { select: { code: true } } },
  });
  const credentials = await prisma.credentialSet.findMany({
    include: { gateway: { select: { code: true } } },
  });
  const glAccounts = await prisma.glAccount.findMany({
    select: { id: true, accountType: true, gatewayId: true, env: true, ownerId: true, credentialSetId: true, currency: true },
  });
  const adminUsers = await prisma.user.findMany({
    where: {
      role: { in: ["GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "OPERATOR", "COMPLIANCE", "MLRO", "SUPPORT"] },
      merchantId: null,
    },
    select: { id: true, email: true, role: true },
  });
  const statementSources = await prisma.statementSource.findMany({
    include: { gateway: { select: { code: true } } },
  });
  const commissionProfiles = await prisma.commissionProfile.findMany({ where: { merchantId: null, applicationId: null } });
  const notificationTemplates = await prisma.notificationTemplate.findMany({
    where: { active: true },
    select: { code: true, channel: true, lang: true },
  });
  const confirmationChannels = await prisma.confirmationChannel.findMany({
    select: { id: true, gatewayVersionId: true, type: true },
  });
  const requiredDocuments = await prisma.platformSetting.findFirst({
    where: { key: "onboarding.required_documents" },
    orderBy: { version: "desc" },
  });

  return {
    gateways,
    versions: versions.map((version) => ({
      id: version.id,
      gatewayId: version.gatewayId,
      gatewayCode: version.gateway.code,
      versionNumber: version.versionNumber,
      state: version.state,
      environments: version.environments,
    })),
    rails,
    routes: routes.map((route) => ({
      id: route.id,
      railId: route.railId,
      railCode: route.rail.code,
      gatewayId: route.gatewayId,
      gatewayCode: route.gateway.code,
      credentialPolicy: route.credentialPolicy,
      costModel: (route.costModel ?? null) as Record<string, unknown> | null,
      status: route.status,
      healthState: route.healthState,
      minAmount: decimalText(route.minAmount),
      maxAmount: decimalText(route.maxAmount),
    })),
    credentials: credentials.map((credential) => ({
      id: credential.id,
      gatewayId: credential.gatewayId,
      gatewayCode: credential.gateway.code,
      env: credential.env,
      ownerType: credential.ownerType,
      settlementTarget: credential.settlementTarget,
      ownerMerchantId: credential.ownerMerchantId,
      status: credential.status,
    })),
    glAccounts,
    adminUsers,
    statementSources: statementSources.map((source) => ({
      id: source.id,
      gatewayId: source.gatewayId,
      gatewayCode: source.gateway.code,
      settlementLagDays: source.settlementLagDays,
      parserConfig: source.parserConfig,
    })),
    commissionProfiles: commissionProfiles.map((profile) => ({
      id: profile.id,
      merchantId: profile.merchantId,
      applicationId: profile.applicationId,
      railCode: profile.railCode,
      calcType: profile.calcType,
      flatFee: String(profile.flatFee),
      percentageRate: String(profile.percentageRate),
      tiersJson: profile.tiersJson,
      minFee: String(profile.minFee),
      maxFee: decimalText(profile.maxFee),
      effectiveFrom: profile.effectiveFrom,
      effectiveTo: profile.effectiveTo,
    })),
    notificationTemplates,
    requiredDocumentsSetting: requiredDocuments?.valueJson ?? null,
    confirmationChannels,
  };
};

export const createContext = async (
  prisma: PrismaClient,
  config: SeederConfig,
): Promise<SeederContext> => {
  const refs = await loadReferences(prisma);
  return buildContext(prisma, config, refs);
};

/** Builds a context from already-loaded references (DB-free; used by the tests). */
export const buildContext = (
  prisma: PrismaClient,
  config: SeederConfig,
  refs: SeedReferences,
): SeederContext => ({
  prisma,
  config,
  rng: new Prng(config.seedKey),
  timeline: buildTimeline(config.now, config.volumes.yearsSpan),
  dataset: emptyDataset(),
  refs,
  checkpoints: new Map(),
  nextId: createIdFactory(config.namespace, config.seedKey),
  meta: emptyMeta(),
});
