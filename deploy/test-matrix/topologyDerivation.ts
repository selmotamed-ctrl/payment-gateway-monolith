import { hasRole, type LabConfig, type LabMachine, type MachineRole, type TopologyFamily } from "./labConfig";

/**
 * Derives deployable topologies from the declared machines and roles.
 *
 * Each family is a placement rule, not a fixed host list: it enumerates the
 * variants the declared machines allow (ordered by declaration order), applies
 * per-machine capacity, and records why a family produced nothing. Ports are
 * allocated per machine so co-located instances never collide.
 */

export type ComputeTier = "core" | "admin" | "merchant" | "checkout";

export interface NodeRef {
  nodeId: string;
  machineId: string;
  port: number;
}

export interface TopologyFeatures {
  /** Edge machines that must not reach private storage ports. */
  dmzMachines: string[];
  /** Compute nodes the scale gate may stop/start under load. */
  scalableNodeIds: string[];
  chaos: boolean;
}

export interface DerivedTopology {
  id: string;
  slug: string;
  family: TopologyFamily;
  name: string;
  description: string;
  aliases: string[];
  shardCount: 16 | 32;
  backupMode: "wal-g" | "barman";
  deployMode: "fresh" | "rolling_update";
  nodes: Record<ComputeTier, NodeRef[]>;
  fakeRails: NodeRef;
  pgPrimary: NodeRef;
  pgReplicas: NodeRef[];
  redis: NodeRef[];
  auditDb: NodeRef;
  logDb: NodeRef;
  backup: NodeRef;
  vault: { machineId: string; path: string } | null;
  features: TopologyFeatures;
  machinesUsed: string[];
}

export interface SkippedFamily {
  family: TopologyFamily;
  reason: string;
}

export interface DerivationResult {
  topologies: DerivedTopology[];
  skipped: SkippedFamily[];
}

interface Layout {
  core: string[];
  admin: string[];
  merchant: string[];
  checkout: string[];
  fakeRails: string;
  primary: string;
  replicas: string[];
  redis: string;
  audit: string;
  log: string;
  backup: { machine: string; mode: "wal-g" | "barman" };
  deployMode?: "fresh" | "rolling_update";
  dmzMachines?: string[];
  scalable?: boolean;
  chaos?: boolean;
}

const BASE_PORTS: Record<ComputeTier | "fakeRails" | "backup" | "pg" | "redis", { base: number; step: number }> = {
  core: { base: 4000, step: 1 },
  admin: { base: 4101, step: 10 },
  merchant: { base: 4102, step: 10 },
  checkout: { base: 4103, step: 10 },
  fakeRails: { base: 4400, step: 1 },
  backup: { base: 4090, step: 1 },
  pg: { base: 5432, step: 1 },
  redis: { base: 6379, step: 1 },
};

class PortBook {
  private readonly used = new Map<string, Set<number>>();

  take(machineId: string, kind: keyof typeof BASE_PORTS): number {
    const set = this.used.get(machineId) ?? new Set<number>();
    this.used.set(machineId, set);
    const { base, step } = BASE_PORTS[kind];
    let port = base;
    while (set.has(port)) port += step;
    set.add(port);
    return port;
  }
}

export const slugify = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const defaultShards = (family: TopologyFamily): 16 | 32 =>
  family === "single-host" || family === "split" || family === "dmz" ? 16 : 32;

const cap = (config: LabConfig, machineId: string): number =>
  config.machines.find((machine) => machine.id === machineId)?.capacity.maxNodesPerTier ?? 1;

/** n instances on one machine, clamped to its capacity. */
const times = (config: LabConfig, machineId: string, wanted: number): string[] =>
  Array.from({ length: Math.max(1, Math.min(wanted, cap(config, machineId))) }, () => machineId);

/** `perMachine` instances on each machine, clamped by capacity. */
const across = (config: LabConfig, machineIds: string[], perMachine: number): string[] =>
  machineIds.flatMap((id) => times(config, id, perMachine));

const build = (
  config: LabConfig,
  family: TopologyFamily,
  id: string,
  name: string,
  description: string,
  layout: Layout,
): DerivedTopology => {
  const ports = new PortBook();
  const counters = new Map<string, number>();
  const nextId = (prefix: string): string => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${next}`;
  };
  const tier = (tierName: ComputeTier, prefix: string, machines: string[]): NodeRef[] =>
    machines.map((machineId) => ({ nodeId: nextId(prefix), machineId, port: ports.take(machineId, tierName) }));

  const nodes: Record<ComputeTier, NodeRef[]> = {
    core: tier("core", "core", layout.core),
    admin: tier("admin", "admin", layout.admin),
    merchant: tier("merchant", "merch", layout.merchant),
    checkout: tier("checkout", "chk", layout.checkout),
  };
  const fakeRails = { nodeId: "fakerails-1", machineId: layout.fakeRails, port: ports.take(layout.fakeRails, "fakeRails") };
  const backup = { nodeId: "backup-1", machineId: layout.backup.machine, port: ports.take(layout.backup.machine, "backup") };
  const pgPrimary = { nodeId: "pg-pri", machineId: layout.primary, port: ports.take(layout.primary, "pg") };
  const pgReplicas = layout.replicas.map((machineId) => ({ nodeId: nextId("pg-rep"), machineId, port: ports.take(machineId, "pg") }));
  const auditDb = { nodeId: "audit-1", machineId: layout.audit, port: ports.take(layout.audit, "pg") };
  const logDb = { nodeId: "log-1", machineId: layout.log, port: ports.take(layout.log, "pg") };
  const redis = [{ nodeId: "redis-1", machineId: layout.redis, port: ports.take(layout.redis, "redis") }];

  const vaultService = config.services.vault;
  const slug = slugify(id);
  const vault = vaultService ? { machineId: vaultService.machine, path: `${vaultService.basePath}/${slug}` } : null;

  const scalableNodeIds = layout.scalable
    ? [...nodes.core.slice(Math.ceil(nodes.core.length / 2)), ...nodes.checkout.slice(Math.ceil(nodes.checkout.length / 2))].map((node) => node.nodeId)
    : [];

  const used = new Set<string>([
    ...Object.values(nodes).flat().map((node) => node.machineId),
    fakeRails.machineId,
    backup.machineId,
    pgPrimary.machineId,
    ...pgReplicas.map((node) => node.machineId),
    auditDb.machineId,
    logDb.machineId,
    ...redis.map((node) => node.machineId),
  ]);

  return {
    id,
    slug,
    family,
    name,
    description,
    aliases: [],
    shardCount: config.topologies.shardCount ?? defaultShards(family),
    backupMode: layout.backup.mode,
    deployMode: layout.deployMode ?? "fresh",
    nodes,
    fakeRails,
    pgPrimary,
    pgReplicas,
    redis,
    auditDb,
    logDb,
    backup,
    vault,
    features: { dmzMachines: layout.dmzMachines ?? [], scalableNodeIds, chaos: layout.chaos === true },
    machinesUsed: config.machines.map((machine) => machine.id).filter((machineId) => used.has(machineId)),
  };
};

const withRole = (config: LabConfig, role: MachineRole): LabMachine[] => config.machines.filter((machine) => hasRole(machine, role));

/** First machine with `role`, preferring `prefer` then avoiding `avoid`. */
const pick = (config: LabConfig, role: MachineRole, options: { prefer?: string[]; avoid?: string[]; within?: string[] } = {}): string | null => {
  const candidates = withRole(config, role).filter((machine) => !options.within || options.within.includes(machine.id));
  for (const id of options.prefer ?? []) {
    const hit = candidates.find((machine) => machine.id === id && !(options.avoid ?? []).includes(id));
    if (hit) return hit.id;
  }
  return candidates.find((machine) => !(options.avoid ?? []).includes(machine.id))?.id ?? null;
};

const backupFor = (config: LabConfig, primary: string, options: { preferBarman: boolean; within?: string[] }): Layout["backup"] | null => {
  const primaryCanBackup = config.machines.find((machine) => machine.id === primary)?.roles.includes("backup") ?? false;
  if (options.preferBarman) {
    const remote = pick(config, "backup", { avoid: [primary], within: options.within });
    if (remote) return { machine: remote, mode: "barman" };
  }
  // WAL-G reads the primary's data directory, so it must run on the primary.
  if (primaryCanBackup) return { machine: primary, mode: "wal-g" };
  const remote = pick(config, "backup", { avoid: [primary], within: options.within });
  return remote ? { machine: remote, mode: "barman" } : null;
};

const singleHost = (config: LabConfig): DerivationResult => {
  const required: MachineRole[] = ["app", "db", "cache", "logs", "backup"];
  const eligible = config.machines.filter((machine) => required.every((role) => hasRole(machine, role)));
  if (eligible.length === 0) {
    return { topologies: [], skipped: [{ family: "single-host", reason: `no machine has all of ${required.join(", ")}` }] };
  }
  return {
    topologies: eligible.map((machine) => build(config, "single-host", `single-host@${machine.id}`,
      `Single-host density on ${machine.id}`,
      `2 core, 1 admin, 1 merchant, 2 checkout, primary + local replica, Redis, audit/log DB and WAL-G all on ${machine.id}`, {
        core: times(config, machine.id, 2),
        admin: [machine.id],
        merchant: [machine.id],
        checkout: times(config, machine.id, 2),
        fakeRails: machine.id,
        primary: machine.id,
        replicas: [machine.id],
        redis: machine.id,
        audit: machine.id,
        log: machine.id,
        backup: { machine: machine.id, mode: "wal-g" },
      })),
    skipped: [],
  };
};

const split = (config: LabConfig): DerivationResult => {
  const topologies: DerivedTopology[] = [];
  for (const compute of withRole(config, "app")) {
    for (const storage of withRole(config, "db")) {
      if (storage.id === compute.id) continue;
      const redis = pick(config, "cache", { prefer: [storage.id], avoid: [compute.id] });
      const logs = pick(config, "logs", { prefer: [storage.id], avoid: [compute.id] });
      const backup = backupFor(config, storage.id, { preferBarman: true });
      if (!redis || !logs || !backup) continue;
      topologies.push(build(config, "split", `split@${compute.id}/${storage.id}`,
        `Compute on ${compute.id}, storage on ${storage.id}`,
        `Every compute tier on ${compute.id}; primary, Redis, audit and log DB on separate storage; ${backup.mode} on ${backup.machine}`, {
          core: times(config, compute.id, 3),
          admin: [compute.id],
          merchant: times(config, compute.id, 2),
          checkout: times(config, compute.id, 2),
          fakeRails: compute.id,
          primary: storage.id,
          replicas: [],
          redis,
          audit: logs,
          log: logs,
          backup,
        }));
    }
  }
  return topologies.length > 0
    ? { topologies, skipped: [] }
    : { topologies, skipped: [{ family: "split", reason: "needs an 'app' machine and a different 'db' machine, with 'cache'/'logs' available off the compute machine" }] };
};

const replicated = (config: LabConfig): DerivationResult => {
  const dbs = withRole(config, "db");
  if (dbs.length < 2) return { topologies: [], skipped: [{ family: "replicated", reason: "needs at least two 'db' machines" }] };
  const apps = withRole(config, "app").map((machine) => machine.id);
  const topologies: DerivedTopology[] = [];
  dbs.forEach((primary, index) => {
    const others = dbs.filter((machine) => machine.id !== primary.id).map((machine) => machine.id);
    const redis = pick(config, "cache", { avoid: [primary.id] }) ?? pick(config, "cache");
    const logs = pick(config, "logs", { avoid: [primary.id] }) ?? pick(config, "logs");
    // Alternate the backup engine across variants so both engines are covered.
    const backup = backupFor(config, primary.id, { preferBarman: index % 2 === 1 });
    if (!redis || !logs || !backup) return;
    const coreMachines = apps.length >= 2 ? apps : times(config, apps[0]!, 2);
    topologies.push(build(config, "replicated", `replicated@${primary.id}`,
      `Primary on ${primary.id} with local + cross-host streaming replicas`,
      `Primary on ${primary.id}; replicas on ${[primary.id, ...others].join(", ")}; Redis on ${redis}; audit/log on ${logs}; ${backup.mode} on ${backup.machine}`, {
        core: coreMachines,
        admin: [apps[0]!],
        merchant: [apps[apps.length - 1]!],
        checkout: coreMachines,
        fakeRails: apps[apps.length - 1]!,
        primary: primary.id,
        replicas: [primary.id, ...others],
        redis,
        audit: logs,
        log: logs,
        backup,
      }));
  });
  return { topologies, skipped: [] };
};

const dmz = (config: LabConfig): DerivationResult => {
  const topologies: DerivedTopology[] = [];
  for (const edge of withRole(config, "edge")) {
    const privateIds = config.machines.filter((machine) => machine.id !== edge.id).map((machine) => machine.id);
    const core = pick(config, "app", { within: privateIds });
    const primary = pick(config, "db", { within: privateIds, prefer: core ? [core] : [] });
    if (!core || !primary) continue;
    const redis = pick(config, "cache", { within: privateIds, prefer: [primary] });
    const logs = pick(config, "logs", { within: privateIds, prefer: [primary] });
    // The backup host must stay private: a DMZ backup host needs PostgreSQL
    // access, which would defeat the zero-trust assertion.
    const backup = backupFor(config, primary, { preferBarman: false, within: privateIds });
    if (!redis || !logs || !backup) continue;
    topologies.push(build(config, "dmz", `dmz@${edge.id}`,
      `Public edge DMZ on ${edge.id}, private core/storage`,
      `Merchant + checkout + Fake Rails on ${edge.id}; core, admin, PostgreSQL, Redis, audit/log and backup on private machines; edge must not reach storage ports`, {
        core: times(config, core, 2),
        admin: [core],
        merchant: times(config, edge.id, 2),
        checkout: times(config, edge.id, 3),
        fakeRails: edge.id,
        primary,
        replicas: [primary],
        redis,
        audit: logs,
        log: logs,
        backup,
        dmzMachines: [edge.id],
      }));
  }
  return topologies.length > 0
    ? { topologies, skipped: [] }
    : { topologies, skipped: [{ family: "dmz", reason: "needs an 'edge' machine plus private (non-edge) 'app', 'db', 'cache', 'logs' and 'backup' machines" }] };
};

const meshLayout = (config: LabConfig, options: { preferWalG: boolean }): Layout | null => {
  const apps = withRole(config, "app").map((machine) => machine.id);
  const primary = pick(config, "db");
  if (apps.length === 0 || !primary) return null;
  const otherDbs = withRole(config, "db").map((machine) => machine.id).filter((id) => id !== primary);
  const redis = pick(config, "cache", { avoid: [primary] }) ?? pick(config, "cache");
  const logs = pick(config, "logs", { avoid: [primary] }) ?? pick(config, "logs");
  const backup = backupFor(config, primary, { preferBarman: !options.preferWalG });
  if (!redis || !logs || !backup) return null;
  return {
    core: across(config, apps, 2),
    admin: apps.slice(0, 2),
    merchant: across(config, apps, 2),
    checkout: across(config, apps, 2),
    fakeRails: apps[apps.length - 1]!,
    primary,
    replicas: [primary, ...otherDbs],
    redis,
    audit: logs,
    log: logs,
    backup,
  };
};

const meshFamily = (config: LabConfig, family: "mesh" | "scale" | "chaos"): DerivationResult => {
  if (config.machines.length < 2) {
    return { topologies: [], skipped: [{ family, reason: "needs at least two machines (with one machine it degenerates to single-host)" }] };
  }
  const layout = meshLayout(config, { preferWalG: family === "chaos" });
  if (!layout) return { topologies: [], skipped: [{ family, reason: "needs 'app', 'db', 'cache', 'logs' and 'backup' machines" }] };
  if (family === "scale") {
    if (layout.core.length < 2 || layout.checkout.length < 2) {
      return { topologies: [], skipped: [{ family, reason: "needs at least two core and two checkout nodes to scale in/out" }] };
    }
    return {
      topologies: [build(config, family, "scale", "Live scale-in/scale-out under sustained load",
        "Mesh layout deployed with rolling_update; the scale gate stops and restarts half of the core/checkout nodes while the workload runs",
        { ...layout, deployMode: "rolling_update", scalable: true })],
      skipped: [],
    };
  }
  if (family === "chaos") {
    return {
      topologies: [build(config, family, "chaos", "Chaos and failover gauntlet",
        "Mesh layout with WAL-G on the primary where possible; the chaos gate injects the configured faults under load",
        { ...layout, chaos: true })],
      skipped: [],
    };
  }
  return {
    topologies: [build(config, family, "mesh", "Symmetric mesh across every app machine",
      "Every compute tier spread across all 'app' machines; primary + local and cross-host replicas; separate Redis/log storage where possible",
      layout)],
    skipped: [],
  };
};

const FAMILY_BUILDERS: Record<TopologyFamily, (config: LabConfig) => DerivationResult> = {
  "single-host": singleHost,
  split,
  replicated,
  dmz,
  mesh: (config) => meshFamily(config, "mesh"),
  scale: (config) => meshFamily(config, "scale"),
  chaos: (config) => meshFamily(config, "chaos"),
};

/**
 * Compatibility: with exactly two machines, the archived T1-T8 ids become
 * aliases of the equivalent derived topologies (machine[0] = HOST_A,
 * machine[1] = HOST_B).
 */
export const LEGACY_ALIAS_RULES = (a: string, b: string): Record<string, string> => ({
  T1: `single-host@${a}`,
  T2: `split@${a}/${b}`,
  T3: `replicated@${a}`,
  T4: `replicated@${b}`,
  T5: `dmz@${b}`,
  T6: "mesh",
  T7: "scale",
  T8: "chaos",
});

const assignAliases = (config: LabConfig, topologies: DerivedTopology[]): void => {
  if (config.machines.length !== 2) return;
  const rules = LEGACY_ALIAS_RULES(config.machines[0]!.id, config.machines[1]!.id);
  for (const [alias, id] of Object.entries(rules)) {
    topologies.find((topology) => topology.id === id)?.aliases.push(alias);
  }
};

/** Every topology the machines allow, for the selected families (before include/exclude). */
export const deriveTopologies = (config: LabConfig): DerivationResult => {
  const topologies: DerivedTopology[] = [];
  const skipped: SkippedFamily[] = [];
  for (const family of config.topologies.families) {
    const result = FAMILY_BUILDERS[family](config);
    const limited = config.topologies.maxPerFamily ? result.topologies.slice(0, config.topologies.maxPerFamily) : result.topologies;
    topologies.push(...limited);
    skipped.push(...result.skipped);
  }
  assignAliases(config, topologies);
  return { topologies, skipped };
};

const matches = (topology: DerivedTopology, key: string): boolean =>
  topology.id === key || topology.slug === key || topology.aliases.some((alias) => alias.toUpperCase() === key.toUpperCase());

/**
 * Applies `topologies.include/exclude` from the config and an optional CLI
 * selection. Unknown ids are an error (a typo must not silently run nothing).
 */
export const selectTopologies = (config: LabConfig, cliSelection: string[] = []): DerivationResult => {
  const derived = deriveTopologies(config);
  const unknown = (keys: string[]): string[] => keys.filter((key) => !derived.topologies.some((topology) => matches(topology, key)));
  const include = cliSelection.length > 0 ? cliSelection : config.topologies.include;
  const problems = [...unknown(include), ...unknown(config.topologies.exclude)];
  if (problems.length > 0) {
    const available = derived.topologies.map((topology) => (topology.aliases.length ? `${topology.id} (${topology.aliases.join(",")})` : topology.id));
    throw new Error(`Unknown topology selection: ${problems.join(", ")}. Derived topologies: ${available.join(", ") || "(none)"}`);
  }
  let selected = include.length > 0
    ? include.map((key) => derived.topologies.find((topology) => matches(topology, key))!)
    : derived.topologies;
  selected = selected.filter((topology, index, all) => all.findIndex((entry) => entry.id === topology.id) === index);
  selected = selected.filter((topology) => !config.topologies.exclude.some((key) => matches(topology, key)));
  return { topologies: selected, skipped: derived.skipped };
};

export const describeTopology = (topology: DerivedTopology): string => {
  const list = (refs: NodeRef[]): string => refs.map((ref) => `${ref.nodeId}@${ref.machineId}:${ref.port}`).join(", ") || "-";
  return [
    `${topology.id}${topology.aliases.length ? ` [${topology.aliases.join(",")}]` : ""} — ${topology.name}`,
    `  core: ${list(topology.nodes.core)}`,
    `  admin: ${list(topology.nodes.admin)} · merchant: ${list(topology.nodes.merchant)}`,
    `  checkout: ${list(topology.nodes.checkout)} · fake-rails: ${list([topology.fakeRails])}`,
    `  pg: primary ${list([topology.pgPrimary])}; replicas ${list(topology.pgReplicas)}`,
    `  redis: ${list(topology.redis)} · audit: ${list([topology.auditDb])} · log: ${list([topology.logDb])}`,
    `  backup: ${topology.backupMode} on ${list([topology.backup])} · shards ${topology.shardCount} · ${topology.deployMode}`,
    ...(topology.features.dmzMachines.length ? [`  dmz edge: ${topology.features.dmzMachines.join(", ")}`] : []),
    ...(topology.features.scalableNodeIds.length ? [`  scalable: ${topology.features.scalableNodeIds.join(", ")}`] : []),
  ].join("\n");
};
