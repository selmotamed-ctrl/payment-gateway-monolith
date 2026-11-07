import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";
import { intensitySpecSchema } from "./intensity";

/**
 * Multi-machine lab configuration.
 *
 * The JSON file declares the machines (any N >= 1), their roles, which
 * topology families to derive, and the test intensity. It never contains a
 * secret: sudo passwords and optional object-store credentials are referenced
 * by environment-variable name (`*Env`), and lab-internal secrets (DB/Redis
 * passwords, KMS key, Fake Rails tokens) are generated at runtime into the
 * git-ignored `configs/` directory.
 *
 * `machines.schema.json` is generated from this Zod schema
 * (`bun run test-matrix:schema`) and a unit test keeps the two in sync.
 */

export const MACHINE_ROLES = [
  "controller",
  "app",
  "edge",
  "db",
  "cache",
  "logs",
  "backup",
  "object-store",
  "vault",
] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

export const TOPOLOGY_FAMILIES = ["single-host", "split", "replicated", "dmz", "mesh", "scale", "chaos"] as const;
export type TopologyFamily = (typeof TOPOLOGY_FAMILIES)[number];

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_KEY = /(pass(word)?|secret|token|private[-_]?key|credential)/i;

const envRef = z
  .string()
  .regex(ENV_NAME, "must be an environment-variable name such as LAB_SUDO_PASS (UPPER_SNAKE_CASE)");

const machineId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, "must be lowercase letters, digits or '-', start with a letter, at most 31 chars");

// The deploy node grammar (`nodeId@sshHost:sshPort:privateIp:servicePort`)
// only accepts IPv4 for both the SSH host and the private IP.
const ipv4 = z
  .string()
  .refine((value) => isIP(value) === 4, "must be an IPv4 address (the deploy node grammar does not accept hostnames or IPv6)");

const cidr = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "must be an IPv4 CIDR such as 10.209.250.0/24");

const sudoSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("nopasswd").describe("Passwordless sudo (recommended for lab hosts)."),
  }).strict(),
  z.object({
    mode: z.literal("password"),
    passwordEnv: envRef.describe("Name of the environment variable holding the sudo password. The value is never stored in JSON or the repo."),
  }).strict(),
]);

const sshDefaultsSchema = z.object({
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, "must be a POSIX user name").describe("SSH user for every machine. The deploy engine plans SSH credentials per tier, so one user is shared by all machines."),
  port: z.number().int().min(1).max(65535).default(22),
  keyPath: z.string().min(1).describe("Private key path on the controller (e.g. ~/.ssh/id_ed25519_pg_lab). Passphrase-protected keys must be loaded in ssh-agent because SSH runs with BatchMode=yes."),
  generateKeyIfMissing: z.boolean().default(false).describe("Create an unencrypted Ed25519 key at keyPath when it does not exist. The public key must still be authorized on each machine by the operator (ssh-copy-id)."),
  sudo: sudoSchema.default({ mode: "nopasswd" }),
}).strict();

const machineSchema = z.object({
  id: machineId.describe("Stable machine id used in topology ids and reports."),
  address: ipv4.describe("IPv4 address the controller uses for SSH."),
  privateIp: ipv4.optional().describe("LAN IPv4 services bind to; defaults to address."),
  sshPort: z.number().int().min(1).max(65535).optional().describe("Overrides ssh.port for this machine."),
  roles: z.array(z.enum(MACHINE_ROLES)).min(1).describe("Capabilities the topology generator may place on this machine."),
  labels: z.record(z.string().regex(/^[a-z][a-z0-9_.-]*$/), z.string().max(120)).default({}).describe("Free-form labels copied into reports (zone, rack, os...)."),
  capacity: z.object({
    maxNodesPerTier: z.number().int().min(1).max(8).default(3).describe("Maximum instances of one compute tier (core/admin/merchant/checkout) on this machine."),
  }).strict().default({ maxNodesPerTier: 3 }),
}).strict();

const objectStoreSchema = z.object({
  machine: machineId.describe("Machine that runs the S3-compatible test store (MinIO)."),
  port: z.number().int().min(1).max(65535).default(9000),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,62}$/).default("pg-backups-test"),
  image: z.string().min(1).default("cgr.dev/chainguard/minio:latest"),
  provision: z.boolean().default(true).describe("Install/start MinIO during bootstrap. false = use an existing endpoint with the credentials below."),
  accessKeyEnv: envRef.optional().describe("Optional env var with the S3 access key; generated per lab when omitted."),
  secretKeyEnv: envRef.optional().describe("Optional env var with the S3 secret key; generated per lab when omitted."),
}).strict();

const vaultSchema = z.object({
  machine: machineId.describe("Machine that receives the secondary SSH backup copies."),
  basePath: z.string().regex(/^\/[A-Za-z0-9._/-]+$/, "must be an absolute path").default("/var/backups/pg-lab-vault"),
}).strict();

const topologySelectionSchema = z.object({
  families: z.array(z.enum(TOPOLOGY_FAMILIES)).min(1).default([...TOPOLOGY_FAMILIES]).describe("Topology families to derive from the machines."),
  include: z.array(z.string().min(1)).default([]).describe("Restrict to these topology ids or legacy aliases (e.g. T1). Empty = every derived topology."),
  exclude: z.array(z.string().min(1)).default([]).describe("Topology ids or aliases to drop."),
  maxPerFamily: z.number().int().min(1).max(64).optional().describe("Cap the number of variants generated per family (variants are ordered by machine declaration order)."),
  shardCount: z.number().int().min(1).max(256).optional().describe("Force STORAGE_SHARD_COUNT for every topology; default 16 for single-host/split/dmz and 32 otherwise."),
}).strict();

export const labConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  lab: z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "must be lowercase letters, digits or '-'"),
    lanCidrs: z.array(cidr).default([]).describe("Allowed LAN CIDRs for edge listeners. Default: each machine's privateIp/32."),
    markerFile: z.string().regex(/^\/[A-Za-z0-9._/-]+$/).default("/etc/pg-lab-matrix").describe("File that marks a host as disposable lab hardware; destructive teardown refuses hosts without it."),
  }).strict(),
  ssh: sshDefaultsSchema,
  machines: z.array(machineSchema).min(1),
  services: z.object({
    objectStore: objectStoreSchema.optional(),
    vault: vaultSchema.optional(),
  }).strict().default({}),
  topologies: topologySelectionSchema.default({ families: [...TOPOLOGY_FAMILIES], include: [], exclude: [] }),
  intensity: intensitySpecSchema.default({ preset: "standard", overrides: {} }),
}).strict().superRefine((config, ctx) => {
  const ids = new Set<string>();
  const addresses = new Map<string, string>();
  const privateIps = new Map<string, string>();
  config.machines.forEach((machine, index) => {
    if (ids.has(machine.id)) ctx.addIssue({ code: "custom", path: ["machines", index, "id"], message: `duplicate machine id '${machine.id}'` });
    ids.add(machine.id);
    const priorAddress = addresses.get(machine.address);
    if (priorAddress) ctx.addIssue({ code: "custom", path: ["machines", index, "address"], message: `address ${machine.address} is already used by machine '${priorAddress}'` });
    addresses.set(machine.address, machine.id);
    const privateIp = machine.privateIp ?? machine.address;
    const priorIp = privateIps.get(privateIp);
    if (priorIp) ctx.addIssue({ code: "custom", path: ["machines", index, "privateIp"], message: `privateIp ${privateIp} is already used by machine '${priorIp}'` });
    privateIps.set(privateIp, machine.id);
    if (new Set(machine.roles).size !== machine.roles.length) {
      ctx.addIssue({ code: "custom", path: ["machines", index, "roles"], message: "roles contain duplicates" });
    }
  });
  const controllers = config.machines.filter((machine) => machine.roles.includes("controller"));
  if (controllers.length > 1) {
    ctx.addIssue({ code: "custom", path: ["machines"], message: `at most one machine may have role 'controller' (found ${controllers.map((m) => m.id).join(", ")})` });
  }
  const need = (role: MachineRole, why: string): void => {
    if (!config.machines.some((machine) => machine.roles.includes(role))) {
      ctx.addIssue({ code: "custom", path: ["machines"], message: `at least one machine needs role '${role}' (${why})` });
    }
  };
  need("app", "core/admin/merchant/checkout/fake-rails nodes");
  need("db", "PostgreSQL primary");
  need("cache", "Redis");
  need("logs", "audit and log databases");
  need("backup", "backup daemon");
  const checkServiceMachine = (key: "objectStore" | "vault", role: MachineRole): void => {
    const service = config.services[key];
    if (!service) return;
    const machine = config.machines.find((entry) => entry.id === service.machine);
    if (!machine) {
      ctx.addIssue({ code: "custom", path: ["services", key, "machine"], message: `unknown machine '${service.machine}' (declared: ${[...ids].join(", ")})` });
    } else if (!machine.roles.includes(role)) {
      ctx.addIssue({ code: "custom", path: ["services", key, "machine"], message: `machine '${service.machine}' must have role '${role}'` });
    }
  };
  checkServiceMachine("objectStore", "object-store");
  checkServiceMachine("vault", "vault");
  if (!config.services.objectStore) {
    ctx.addIssue({ code: "custom", path: ["services", "objectStore"], message: "services.objectStore is required: every topology enables the backup engine, which needs an S3 endpoint" });
  }
  const objectStore = config.services.objectStore;
  if (objectStore && !objectStore.provision && (!objectStore.accessKeyEnv || !objectStore.secretKeyEnv)) {
    ctx.addIssue({ code: "custom", path: ["services", "objectStore"], message: "accessKeyEnv and secretKeyEnv are required when provision=false (an existing store cannot use generated credentials)" });
  }
});

export type LabConfigInput = z.input<typeof labConfigSchema>;
export type LabConfig = z.output<typeof labConfigSchema>;
export type LabMachine = LabConfig["machines"][number];

export class LabConfigError extends Error {
  constructor(readonly source: string, readonly problems: string[]) {
    super(`Invalid lab config ${source}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "LabConfigError";
  }
}

const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
  path.length === 0
    ? "(root)"
    : path.reduce<string>((acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)), "");

/**
 * Rejects literal secrets before schema validation so the error explains the
 * fix (`...Env` reference) instead of a generic "unrecognized key".
 */
export const findLiteralSecrets = (value: unknown, path: Array<string | number> = []): string[] => {
  const problems: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => problems.push(...findLiteralSecrets(entry, [...path, index])));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = [...path, key];
      if (SECRET_KEY.test(key) && !/Env$/.test(key)) {
        problems.push(`${formatPath(keyPath)}: literal secrets are not allowed in the lab config; reference an environment variable instead (e.g. "${key.replace(/^(.)/, (c) => c.toLowerCase())}Env": "LAB_${key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}")`);
      } else {
        problems.push(...findLiteralSecrets(entry, keyPath));
      }
    }
  }
  return problems;
};

export const parseLabConfig = (raw: unknown, source = "<inline>"): LabConfig => {
  const secretProblems = findLiteralSecrets(raw);
  if (secretProblems.length > 0) throw new LabConfigError(source, secretProblems);
  const parsed = labConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LabConfigError(source, parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`));
  }
  return parsed.data;
};

export const loadLabConfig = (path: string): LabConfig => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new LabConfigError(path, [`cannot read file: ${error instanceof Error ? error.message : String(error)}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new LabConfigError(path, [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseLabConfig(raw, path);
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "$schema")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};

/** sha256 of the parsed (defaults applied, key-sorted) config: formatting-insensitive. */
export const hashCanonical = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export const configHash = (config: LabConfig): string => hashCanonical(config);

export const machinePrivateIp = (machine: LabMachine): string => machine.privateIp ?? machine.address;
export const machineSshPort = (config: LabConfig, machine: LabMachine): number => machine.sshPort ?? config.ssh.port;
export const hasRole = (machine: LabMachine, role: MachineRole): boolean => machine.roles.includes(role);

export const machineById = (config: LabConfig, id: string): LabMachine => {
  const machine = config.machines.find((entry) => entry.id === id);
  if (!machine) throw new Error(`Unknown machine '${id}'`);
  return machine;
};

export const machineByHost = (config: LabConfig, host: string): LabMachine | undefined =>
  config.machines.find((entry) => entry.address === host || machinePrivateIp(entry) === host);

/**
 * Resolves the sudo password from the referenced environment variable.
 * Returns "" for passwordless sudo. Throws a clear error when the variable is
 * missing so a run never silently falls back to a default password.
 */
export const resolveSudoPassword = (config: LabConfig, env: Record<string, string | undefined> = process.env): string => {
  if (config.ssh.sudo.mode === "nopasswd") return "";
  const value = env[config.ssh.sudo.passwordEnv];
  if (value === undefined || value.length === 0) {
    throw new Error(`ssh.sudo.passwordEnv refers to ${config.ssh.sudo.passwordEnv}, which is not set. Export it (e.g. read -rs ${config.ssh.sudo.passwordEnv}; export ${config.ssh.sudo.passwordEnv}) or switch the lab to sudo mode "nopasswd".`);
  }
  return value;
};
