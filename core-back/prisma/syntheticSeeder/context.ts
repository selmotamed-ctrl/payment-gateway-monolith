import type { PrismaClient } from "../../generated/prisma/client";
import type { SeederConfig } from "./config";
import { emptyDataset, type SyntheticDataset } from "./dataset";
import { Prng } from "./prng";
import { buildTimeline, type TimelineConfig } from "./timelineClock";

export interface GatewayRef {
  id: string;
  code: string;
  kind: string;
}
export interface VersionRef {
  id: string;
  gatewayId: string;
  gatewayCode: string;
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
}
export interface CredentialRef {
  id: string;
  gatewayId: string;
  gatewayCode: string;
  env: string;
  ownerType: string;
  settlementTarget: string;
}
export interface GlRef {
  id: string;
  accountType: string;
  gatewayId: string | null;
  env: string | null;
  ownerId: string | null;
}
export interface UserRef {
  id: string;
  email: string;
  role: string;
}

export interface SeedReferences {
  gateways: GatewayRef[];
  versions: VersionRef[];
  rails: RailRef[];
  routes: RouteRef[];
  credentials: CredentialRef[];
  glAccounts: GlRef[];
  adminUsers: UserRef[];
  statementSources: Array<{ id: string; gatewayId: string; gatewayCode: string }>;
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
}

export const loadReferences = async (prisma: PrismaClient): Promise<SeedReferences> => {
  const gateways = await prisma.gateway.findMany({ select: { id: true, code: true, kind: true } });
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
    select: { id: true, accountType: true, gatewayId: true, env: true, ownerId: true },
  });
  const adminUsers = await prisma.user.findMany({
    where: { role: { in: ["GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "OPERATOR", "COMPLIANCE", "MLRO", "SUPPORT"] } },
    select: { id: true, email: true, role: true },
  });
  const statementSources = await prisma.statementSource.findMany({
    include: { gateway: { select: { code: true } } },
  });

  return {
    gateways,
    versions: versions.map((version) => ({
      id: version.id,
      gatewayId: version.gatewayId,
      gatewayCode: version.gateway.code,
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
    })),
    credentials: credentials.map((credential) => ({
      id: credential.id,
      gatewayId: credential.gatewayId,
      gatewayCode: credential.gateway.code,
      env: credential.env,
      ownerType: credential.ownerType,
      settlementTarget: credential.settlementTarget,
    })),
    glAccounts,
    adminUsers,
    statementSources: statementSources.map((source) => ({
      id: source.id,
      gatewayId: source.gatewayId,
      gatewayCode: source.gateway.code,
    })),
  };
};

export const createContext = async (
  prisma: PrismaClient,
  config: SeederConfig,
): Promise<SeederContext> => {
  const refs = await loadReferences(prisma);
  const rng = new Prng(config.seedKey);
  const timeline = buildTimeline(config.now, config.volumes.yearsSpan);
  let counter = 0;
  return {
    prisma,
    config,
    rng,
    timeline,
    dataset: emptyDataset(),
    refs,
    checkpoints: new Map(),
    nextId: (_entity: string) => {
      counter += 1;
      // A stable, collision-free RFC-4122-shaped id. The zero prefix keeps the
      // synthetic rows visually distinct from the real seeded rows.
      return `00000000-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
    },
  };
};
