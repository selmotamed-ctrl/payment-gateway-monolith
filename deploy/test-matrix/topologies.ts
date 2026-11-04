import { machineById, machinePrivateIp, machineSshPort, type LabConfig } from "./labConfig";
import type { LabSecrets } from "./labSecrets";
import type { ResolvedIntensity } from "./intensity";
import type { DerivedTopology, NodeRef } from "./topologyDerivation";

/**
 * Renders a derived topology into a deploy.env record that the real deploy
 * engine (`deploy/deploy.ts`, `lib/configSchema.ts`) accepts.
 *
 * Fixes against the archived T1-T8 generator:
 * - every tier uses the configured SSH user/key/sudo (the old generator used
 *   HOST_B's user and HOST_A's sudo password for every tier);
 * - no secret literals: secrets come from the generated `LabSecrets`;
 * - LAN_ALLOWED_CIDRS is narrowed to the declared machines (or lab.lanCidrs)
 *   instead of 10.0.0.0/8 + 192.168.0.0/16;
 * - seed profile/years come from the resolved intensity, not the topology.
 */

export interface RenderInput {
  config: LabConfig;
  topology: DerivedTopology;
  secrets: LabSecrets;
  intensity: ResolvedIntensity;
  sudoPassword: string;
}

export const nodeSpec = (config: LabConfig, ref: NodeRef): string => {
  const machine = machineById(config, ref.machineId);
  return `${ref.nodeId}@${machine.address}:${machineSshPort(config, machine)}:${machinePrivateIp(machine)}:${ref.port}`;
};

const nodeList = (config: LabConfig, refs: NodeRef[]): string => refs.map((ref) => nodeSpec(config, ref)).join(",");

const lanCidrs = (config: LabConfig): string => {
  const cidrs = config.lab.lanCidrs.length > 0
    ? config.lab.lanCidrs
    : config.machines.map((machine) => `${machinePrivateIp(machine)}/32`);
  return [...new Set([...cidrs, "127.0.0.0/8"])].join(",");
};

const sshFields = (config: LabConfig, sudoPassword: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const prefix of ["CORE", "ADMIN", "MERCHANT", "CHECKOUT", "FAKE_RAILS", "PG", "REDIS", "AUDIT_DB", "LOG_DB", "BACKUP"]) {
    fields[`${prefix}_SSH_USER`] = config.ssh.user;
    fields[`${prefix}_SSH_KEY_PATH`] = config.ssh.keyPath;
    fields[`${prefix}_SUDO_PASSWORD`] = sudoPassword;
  }
  return fields;
};

export const renderTopologyEnv = ({ config, topology, secrets, intensity, sudoPassword }: RenderInput): Record<string, string> => {
  const fakeRailsMachine = machineById(config, topology.fakeRails.machineId);
  const objectStore = config.services.objectStore;
  const objectStoreMachine = objectStore ? machineById(config, objectStore.machine) : undefined;
  const allHosts = [...new Set(config.machines.flatMap((machine) => [machine.address, machinePrivateIp(machine)]))];
  const vaultMachine = topology.vault ? machineById(config, topology.vault.machineId) : undefined;
  const auditOffBackupHost = topology.auditDb.machineId !== topology.backup.machineId;

  return {
    DEPLOY_MODE: topology.deployMode,
    DEPLOY_ENV: "production",
    ROLLING_BATCH_SIZE: "1",
    KEEP_RELEASES: "3",
    LAN_ALLOWED_CIDRS: lanCidrs(config),
    KMS_MASTER_KEY_ID: "v1",
    KMS_MASTER_KEY_HEX: secrets.kmsMasterKeyHex,
    KMS_MASTER_KEY: secrets.kmsMasterKeyHex,
    BASE_CURRENCY: "LYD",
    GATEWAY_TIMEZONE: "Africa/Tripoli",
    IS_TEST_SERVER: "true",
    ...sshFields(config, sudoPassword),
    FAKE_RAILS_ENABLED: "true",
    FAKE_RAILS_ALLOW_IN_PRODUCTION: "true",
    FAKE_RAILS_ALLOWED_HOSTS: [...allHosts, "127.0.0.1", "localhost"].join(","),
    FAKE_RAILS_ADMIN_USER: "tester",
    FAKE_RAILS_ADMIN_PASSWORD: secrets.fakeRailsAdminPassword,
    FAKE_RAILS_JWT_SECRET: secrets.fakeRailsJwtSecret,
    FAKE_RAILS_SEEDER_TOKEN: secrets.fakeRailsSeederToken,
    FAKE_RAILS_NGINX_PORT: "8444",
    FAKE_RAILS_SSL: "false",
    FAKE_RAILS_NODE: nodeSpec(config, topology.fakeRails),
    FAKE_RAILS_PUBLIC_BASE_URL: `http://${machinePrivateIp(fakeRailsMachine)}:8444`,
    RUN_PRISMA_SEED: "true",
    RUN_SYNTHETIC_HISTORY_SEED: "true",
    SYNTHETIC_SEED_PROFILE: intensity.data.seedProfile,
    SYNTHETIC_YEARS_SPAN: String(intensity.data.seedYearsSpan),
    STORAGE_SHARD_COUNT: String(topology.shardCount),
    PG_MANAGE_VIA_SSH: "true",
    PG_VERSION: "18",
    PG_DB_NAME: "payment_gateway_prod",
    PG_DB_USER: "core_user",
    PG_DB_PASSWORD: secrets.pgDbPassword,
    PG_REPLICATION_USER: "replicator",
    PG_REPLICATION_PASSWORD: secrets.pgReplicationPassword,
    READ_REPLICA_MAX_LAG_MS: "60000",
    PGBOUNCER_ENABLED: "true",
    PGBOUNCER_DEFAULT_POOL_SIZE: "40",
    PGBOUNCER_MAX_CLIENT_CONN: "1000",
    PGBOUNCER_MAX_PREPARED_STATEMENTS: "256",
    PG_PRIMARY_NODE: nodeSpec(config, topology.pgPrimary),
    PG_REPLICA_NODES: nodeList(config, topology.pgReplicas),
    REDIS_MANAGE_VIA_SSH: "true",
    REDIS_PASSWORD: secrets.redisPassword,
    REDIS_NODES: nodeList(config, topology.redis),
    AUDIT_DB_MANAGE_VIA_SSH: "true",
    AUDIT_DB_NAME: "pg_audit_db",
    AUDIT_DB_USER: "audit_writer",
    AUDIT_DB_PASSWORD: secrets.auditDbPassword,
    AUDIT_DB_NODE: nodeSpec(config, topology.auditDb),
    LOG_DB_MANAGE_VIA_SSH: "true",
    LOG_DB_NAME: "pg_logs_db",
    LOG_DB_USER: "log_writer",
    LOG_DB_PASSWORD: secrets.logDbPassword,
    LOG_DB_NODE: nodeSpec(config, topology.logDb),
    ...(topology.backupMode === "wal-g" && auditOffBackupHost ? { PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" } : {}),
    BACKUP_ENABLED: "true",
    BACKUP_NODE: nodeSpec(config, topology.backup),
    BACKUP_ENGINE_MODE: topology.backupMode,
    BACKUP_COMPRESSION: "zstd",
    BACKUP_ENCRYPTION_KEY_HEX: secrets.backupEncryptionKeyHex,
    // The lab provisions its own object store; the engine must not install one.
    BACKUP_S3_MODE: "external",
    BACKUP_PRIMARY_S3_ENDPOINT: objectStore && objectStoreMachine ? `http://${machinePrivateIp(objectStoreMachine)}:${objectStore.port}` : "",
    BACKUP_PRIMARY_S3_BUCKET: objectStore ? `s3://${objectStore.bucket}` : "",
    BACKUP_PRIMARY_S3_ACCESS_KEY: secrets.objectStoreAccessKey,
    BACKUP_PRIMARY_S3_SECRET_KEY: secrets.objectStoreSecretKey,
    BACKUP_ALLOW_INSECURE_HTTP: "false",
    BACKUP_SECONDARY_SSH_TARGET: topology.vault && vaultMachine ? `${config.ssh.user}@${vaultMachine.address}:${topology.vault.path}` : "",
    CORE_NODES: nodeList(config, topology.nodes.core),
    ADMIN_NODES: nodeList(config, topology.nodes.admin),
    MERCHANT_NODES: nodeList(config, topology.nodes.merchant),
    CHECKOUT_NODES: nodeList(config, topology.nodes.checkout),
    PAY_RATE_LIMIT_MAX: String(Math.min(1_000_000, Math.max(10_000, Math.ceil(intensity.targetTps * 120)))),
    MERCHANT_DOMAIN: "merchant.lab.internal",
    CHECKOUT_DOMAIN: "checkout.lab.internal",
    MERCHANT_SSL: "false",
    CHECKOUT_SSL: "false",
    MERCHANT_LAN_PORT: "0",
    CHECKOUT_LAN_PORT: "0",
    ADMIN_SSL: "false",
    ADMIN_NGINX_LAN_PORT: "8443",
    ADMIN_DOMAIN: "_",
  };
};

export const renderEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
