import { z } from "zod";

/**
 * The multi-host deployment configuration.
 *
 * `deploy/deploy.env` is parsed by this schema. Everything is validated before
 * a single SSH connection is opened: a typo in an IP address must fail on the
 * operator's machine, not halfway through a production deploy.
 */

const ipv4 = z
  .string()
  .trim()
  .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "must be an IPv4 address")
  .refine((value) => value.split(".").every((octet) => Number(octet) >= 0 && Number(octet) <= 255), "octet out of range");

const cidrList = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    return value.split(",").every((entry) => {
      const [address, bits] = entry.trim().split("/");
      if (!address || bits === undefined) return false;
      const isV4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(address);
      const isV6 = /^[0-9a-fA-F:]+$/.test(address);
      const width = Number(bits);
      if (!Number.isInteger(width)) return false;
      return isV4 ? width >= 0 && width <= 32 : isV6 && width >= 0 && width <= 128;
    });
  }, "must be a comma separated list of CIDRs (e.g. 10.0.0.0/8,192.168.0.0/16)");

const sshPath = z.string().trim().min(1, "must point at an SSH key");

const domain = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "must be a fully qualified domain name");

// A vhost name may be a FQDN, a bare IP, or "_" (nginx catch-all) so a box can
// be served without DNS during staging.
const serverName = z.union([domain, z.literal("_"), ipv4]);

const port = z.coerce.number().int().min(1).max(65535);
const positive = z.coerce.number().int().min(1);
const booleanish = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((value) => value === "true" || value === "1" || value === "yes");

export const DEPLOY_MODES = ["auto", "fresh", "update", "rolling_update"] as const;
export const DB_ENGINES = ["mysql", "postgresql"] as const;
export const SSL_MODES = ["certbot", "custom", "self_signed"] as const;
export const ROLE_NAMES = ["db", "core", "admin", "merchant", "checkout", "fake-rails"] as const;
export type DeployRole = (typeof ROLE_NAMES)[number];
export const STORAGE_ROLE_NAMES = ["pg-primary", "pg-replica", "pgbouncer", "redis", "audit-db", "log-db", "backup"] as const;
export type StorageRole = (typeof STORAGE_ROLE_NAMES)[number];
export type HostRole = DeployRole | StorageRole;

/**
 * One entry of a horizontal node array:
 *
 *   nodeId@sshHost:sshPort:privateIp:servicePort
 *
 * `sshHost` is the address the orchestrator connects to (it may be public),
 * `privateIp` is the LAN address the node advertises to its peers (it is the
 * address written into TLS SANs and firewall allowlists), and `servicePort` is
 * the port the application/storage daemon listens on.
 */
export interface NodeSpec {
  nodeId: string;
  sshHost: string;
  sshPort: number;
  privateIp: string;
  servicePort: number;
}

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

const validateIpv4 = (value: string, label: string): void => {
  if (!IPV4.test(value) || value.split(".").some((octet) => Number(octet) < 0 || Number(octet) > 255)) {
    throw new Error(`${label}: '${value}' must be an IPv4 address`);
  }
};

const parsePort = (value: string, label: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${label}: '${value}' must be a port number`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}: '${value}' is out of range`);
  return port;
};

/**
 * Parses a comma separated horizontal node list and rejects malformed entries,
 * duplicate node ids and duplicate private IPs *within the same list*.
 */
export const parseNodeList = (value: string | undefined | null): NodeSpec[] => {
  if (!value || value.trim().length === 0) return [];
  const nodes: NodeSpec[] = [];
  const ids = new Set<string>();
  const ips = new Set<string>();
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;
    const at = entry.indexOf("@");
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(`node '${entry}' must use nodeId@sshHost:sshPort:privateIp:servicePort`);
    }
    const nodeId = entry.slice(0, at).trim();
    const parts = entry.slice(at + 1).split(":");
    if (parts.length !== 4) {
      throw new Error(`node '${entry}' must have exactly sshHost:sshPort:privateIp:servicePort after '@'`);
    }
    const [sshHostRaw, sshPortRaw, privateIpRaw, servicePortRaw] = parts as [string, string, string, string];
    const sshHost = sshHostRaw.trim();
    const privateIp = privateIpRaw.trim();
    if (!NODE_ID.test(nodeId)) throw new Error(`node id '${nodeId}' is invalid`);
    validateIpv4(sshHost, `node '${nodeId}' sshHost`);
    validateIpv4(privateIp, `node '${nodeId}' privateIp`);
    const sshPort = parsePort(sshPortRaw.trim(), `node '${nodeId}' sshPort`);
    const servicePort = parsePort(servicePortRaw.trim(), `node '${nodeId}' servicePort`);
    if (ids.has(nodeId)) throw new Error(`duplicate node id '${nodeId}'`);
    if (ips.has(privateIp)) throw new Error(`duplicate private IP '${privateIp}' in node list`);
    ids.add(nodeId);
    ips.add(privateIp);
    nodes.push({ nodeId, sshHost, sshPort, privateIp, servicePort });
  }
  return nodes;
};

const nodeList = z.string().trim().max(20_000).default("");
const optionalSecret = z.string().max(512).default("");

const base = z.strictObject({
  // 0. Global
  DEPLOY_MODE: z.enum(DEPLOY_MODES).default("auto"),
  DEPLOY_ENV: z.enum(["development", "staging", "production"]).default("development"),
  KEEP_RELEASES: z.coerce.number().int().min(1).max(100).default(5),
  ROTATE_MTLS_CERTS: booleanish.default(false),
  MTLS_VALIDITY_DAYS: z.coerce.number().int().min(1).max(3650).default(825),
  LAN_ALLOWED_CIDRS: cidrList.default("127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  ROLLING_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(1),

  // 1. Database (legacy single-host fields)
  DB_MANAGE_VIA_SSH: booleanish.default(true),
  DB_SSH_HOST: ipv4.optional(),
  DB_SSH_PORT: port.default(22),
  DB_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  DB_SSH_KEY_PATH: sshPath.optional(),
  DB_SUDO_PASSWORD: z.string().max(256).default(""),
  DB_PRIVATE_IP: ipv4.optional(),
  DB_ENGINE: z.enum(DB_ENGINES).default("mysql"),
  DB_PORT: port.default(3306),
  DB_NAME: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .optional(),
  DB_USER: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .optional(),
  DB_PASSWORD: z.string().min(8).max(256).optional(),
  DATABASE_URL: z.string().trim().min(1).max(1000).optional(),

  // 1b. Horizontal compute node arrays (override the single-host fields above)
  CORE_NODES: nodeList,
  ADMIN_NODES: nodeList,
  MERCHANT_NODES: nodeList,
  CHECKOUT_NODES: nodeList,
  CORE_BACK_URLS: z.string().trim().max(4000).optional(),

  // 2. Core
  CORE_SSH_HOST: ipv4.optional(),
  CORE_SSH_PORT: port.default(22),
  CORE_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  CORE_SSH_KEY_PATH: sshPath.optional(),
  CORE_SUDO_PASSWORD: z.string().max(256).default(""),
  CORE_PRIVATE_IP: ipv4.optional(),
  CORE_PORT: port.default(4000),
  CORE_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-core"),
  RUN_PRISMA_SEED: booleanish.default(false),

  // 3. Admin
  ADMIN_SSH_HOST: ipv4.optional(),
  ADMIN_SSH_PORT: port.default(22),
  ADMIN_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  ADMIN_SSH_KEY_PATH: sshPath.optional(),
  ADMIN_SUDO_PASSWORD: z.string().max(256).default(""),
  ADMIN_PRIVATE_IP: ipv4.optional(),
  ADMIN_BACK_PORT: port.default(4101),
  ADMIN_NGINX_LAN_PORT: port.default(8443),
  ADMIN_SSL: booleanish.default(true),
  ADMIN_DOMAIN: serverName.default("admin.internal"),
  ADMIN_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-admin"),
  ADMIN_SHOW_CHECKLISTS: booleanish.optional(),
  ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST: booleanish.default(true),
  ADMIN_SHOW_HELP_PANELS: booleanish.default(true),

  // 4. Merchant
  MERCHANT_SSH_HOST: ipv4.optional(),
  MERCHANT_SSH_PORT: port.default(22),
  MERCHANT_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  MERCHANT_SSH_KEY_PATH: sshPath.optional(),
  MERCHANT_SUDO_PASSWORD: z.string().max(256).default(""),
  MERCHANT_PRIVATE_IP: ipv4.optional(),
  MERCHANT_BACK_PORT: port.default(4102),
  MERCHANT_HTTP_PORT: port.default(80),
  MERCHANT_HTTPS_PORT: port.default(443),
  MERCHANT_SSL: booleanish.default(true),
  MERCHANT_LAN_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
  MERCHANT_LAN_SSL: booleanish.default(true),
  MERCHANT_DOMAIN: serverName,
  MERCHANT_SSL_MODE: z.enum(SSL_MODES).default("certbot"),
  MERCHANT_SSL_CERT_PATH: z.string().trim().max(300).optional(),
  MERCHANT_SSL_KEY_PATH: z.string().trim().max(300).optional(),
  MERCHANT_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-merchant"),

  // 5. Checkout
  CHECKOUT_SSH_HOST: ipv4.optional(),
  CHECKOUT_SSH_PORT: port.default(22),
  CHECKOUT_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  CHECKOUT_SSH_KEY_PATH: sshPath.optional(),
  CHECKOUT_SUDO_PASSWORD: z.string().max(256).default(""),
  CHECKOUT_PRIVATE_IP: ipv4.optional(),
  CHECKOUT_BACK_PORT: port.default(4103),
  CHECKOUT_HTTP_PORT: port.default(80),
  CHECKOUT_HTTPS_PORT: port.default(443),
  CHECKOUT_SSL: booleanish.default(true),
  CHECKOUT_LAN_PORT: z.coerce.number().int().min(0).max(65535).default(8082),
  CHECKOUT_LAN_SSL: booleanish.default(true),
  CHECKOUT_DOMAIN: serverName,
  CHECKOUT_SSL_MODE: z.enum(SSL_MODES).default("certbot"),
  CHECKOUT_SSL_CERT_PATH: z.string().trim().max(300).optional(),
  CHECKOUT_SSL_KEY_PATH: z.string().trim().max(300).optional(),
  CHECKOUT_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-checkout"),

  // 6. Core-only secrets
  KMS_MASTER_KEY: z.string().min(16).max(512),
  BASE_CURRENCY: z.string().trim().length(3).default("LYD"),
  GATEWAY_TIMEZONE: z.string().trim().min(1).max(64).default("Africa/Tripoli"),
  REDIS_URL: z.string().trim().max(500).optional(),

  // 7. Standalone Fake Payment Rails service (optional testing / sandbox tier)
  IS_TEST_SERVER: booleanish.default(false),
  FAKE_RAILS_ENABLED: booleanish.default(false),
  FAKE_RAILS_ALLOW_IN_PRODUCTION: booleanish.default(false),
  FAKE_RAILS_SSH_HOST: ipv4.optional(),
  FAKE_RAILS_SSH_PORT: port.default(22),
  FAKE_RAILS_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  FAKE_RAILS_SSH_KEY_PATH: sshPath.optional(),
  FAKE_RAILS_SUDO_PASSWORD: z.string().max(256).default(""),
  FAKE_RAILS_PRIVATE_IP: ipv4.optional(),
  FAKE_RAILS_BACK_PORT: port.default(4104),
  FAKE_RAILS_NGINX_PORT: port.default(8444),
  FAKE_RAILS_SSL: booleanish.default(false),
  FAKE_RAILS_SSL_MODE: z.enum(SSL_MODES).default("self_signed"),
  FAKE_RAILS_DOMAIN: serverName.default("fakerails.internal"),
  FAKE_RAILS_PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8444"),
  FAKE_RAILS_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-fake-rails"),
  FAKE_RAILS_ALLOWED_CIDRS: cidrList.default("127.0.0.1/32,10.0.0.0/8,192.168.0.0/16"),
  FAKE_RAILS_ALLOWED_HOSTS: z.string().trim().default("127.0.0.1,localhost"),
  FAKE_RAILS_ADMIN_USER: z.string().trim().min(4).max(128).optional(),
  FAKE_RAILS_ADMIN_PASSWORD: z.string().min(12).max(512).optional(),
  FAKE_RAILS_JWT_SECRET: z.string().min(16).max(512).optional(),
  FAKE_RAILS_SEEDER_TOKEN: z.string().min(16).max(512).optional(),
  SEED_FAKE_RAILS_BLUEPRINTS: booleanish.default(true),

  // 9. PostgreSQL 18 relational core, replicas and PgBouncer
  PG_MANAGE_VIA_SSH: booleanish.default(false),
  PG_VERSION: z.string().trim().regex(/^\d{1,2}$/, "must be a PostgreSQL major version").default("18"),
  PG_PRIMARY_NODE: z.string().trim().max(500).default(""),
  PG_REPLICA_NODES: z.string().trim().max(20_000).default(""),
  PG_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  PG_SSH_PORT: port.default(22),
  PG_SSH_KEY_PATH: sshPath.optional(),
  PG_SUDO_PASSWORD: z.string().max(256).default(""),
  PG_DB_NAME: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("payment_gateway_prod"),
  PG_DB_USER: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("pg_core_user"),
  PG_DB_PASSWORD: optionalSecret,
  PG_REPLICATION_USER: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("pg_replicator"),
  PG_REPLICATION_PASSWORD: optionalSecret,
  PGBOUNCER_ENABLED: booleanish.default(false),
  PGBOUNCER_PORT: port.default(6432),
  PGBOUNCER_DEFAULT_POOL_SIZE: z.coerce.number().int().min(1).max(10_000).default(50),
  PGBOUNCER_MAX_CLIENT_CONN: z.coerce.number().int().min(1).max(100_000).default(2000),
  PGBOUNCER_MAX_PREPARED_STATEMENTS: z.coerce.number().int().min(0).max(10_000).default(256),

  // 10. Redis cache / velocity engine
  REDIS_MANAGE_VIA_SSH: booleanish.default(false),
  REDIS_NODES: nodeList,
  REDIS_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  REDIS_SSH_PORT: port.default(22),
  REDIS_SSH_KEY_PATH: sshPath.optional(),
  REDIS_SUDO_PASSWORD: z.string().max(256).default(""),
  REDIS_PASSWORD: optionalSecret,
  REDIS_MAXMEMORY: z.string().trim().regex(/^\d+[kmgt]?b$/i, "must be a Redis memory size such as 4gb").default("4gb"),

  // 11. Dedicated tamper-evident audit database
  AUDIT_DB_MANAGE_VIA_SSH: booleanish.default(false),
  AUDIT_DB_NODE: z.string().trim().max(500).default(""),
  AUDIT_DB_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  AUDIT_DB_SSH_PORT: port.default(22),
  AUDIT_DB_SSH_KEY_PATH: sshPath.optional(),
  AUDIT_DB_SUDO_PASSWORD: z.string().max(256).default(""),
  AUDIT_DB_NAME: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("pg_audit_db"),
  AUDIT_DB_USER: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("pg_audit_writer"),
  AUDIT_DB_PASSWORD: optionalSecret,

  // 12. Dedicated operational/step log database
  LOG_DB_MANAGE_VIA_SSH: booleanish.default(false),
  LOG_DB_NODE: z.string().trim().max(500).default(""),
  LOG_DB_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  LOG_DB_SSH_PORT: port.default(22),
  LOG_DB_SSH_KEY_PATH: sshPath.optional(),
  LOG_DB_SUDO_PASSWORD: z.string().max(256).default(""),
  LOG_DB_NAME: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("pg_logs_db"),
  LOG_DB_USER: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier")
    .default("pg_log_writer"),
  LOG_DB_PASSWORD: optionalSecret,
  LOG_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(12),

  // 13. Backup & PITR verification engine
  BACKUP_ENABLED: booleanish.default(false),
  BACKUP_NODE: z.string().trim().max(500).default(""),
  BACKUP_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  BACKUP_SSH_PORT: port.default(22),
  BACKUP_SSH_KEY_PATH: sshPath.optional(),
  BACKUP_SUDO_PASSWORD: z.string().max(256).default(""),
  BACKUP_ENGINE_MODE: z.enum(["wal-g", "barman"]).default("wal-g"),
  BACKUP_COMPRESSION: z.enum(["zstd", "lz4", "gzip"]).default("zstd"),
  BACKUP_ENCRYPTION_KEY_HEX: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, "must be exactly 64 hexadecimal characters")
    .or(z.literal(""))
    .default(""),
  BACKUP_PRIMARY_S3_ENDPOINT: z.string().trim().max(500).default(""),
  BACKUP_PRIMARY_S3_BUCKET: z.string().trim().max(500).default(""),
  BACKUP_PRIMARY_S3_ACCESS_KEY: z.string().max(500).default(""),
  BACKUP_PRIMARY_S3_SECRET_KEY: z.string().max(500).default(""),
  BACKUP_SECONDARY_SSH_TARGET: z.string().trim().max(500).default(""),
  BACKUP_FULL_CRON: z.string().trim().min(1).max(120).default("0 2 * * 0"),
  BACKUP_DELTA_CRON: z.string().trim().min(1).max(120).default("0 2 * * 1-6"),
  BACKUP_DRILL_CRON: z.string().trim().min(1).max(120).default("0 4 * * 0"),
  BACKUP_RETENTION_FULL_COUNT: z.coerce.number().int().min(1).max(365).default(8),
  BACKUP_RETENTION_WAL_DAYS: z.coerce.number().int().min(1).max(3650).default(14),
  BACKUP_DAEMON_PORT: port.default(4090),

  // 8. Synthetic operational data seeder (test servers with Fake Rails only)
  RUN_SYNTHETIC_HISTORY_SEED: booleanish.default(false),
  SYNTHETIC_SEED_PROFILE: z.enum(["COMPACT", "STANDARD", "STRESS"]).default("COMPACT"),
  SYNTHETIC_SEED_KEY: z.string().trim().min(1).max(200).default("libya-pg-2023-2026"),
  SYNTHETIC_YEARS_SPAN: z.coerce.number().min(0.5).max(10).default(3.5),
});

export type DeployConfig = z.infer<typeof base>;

/** True when any PostgreSQL 18 storage field is configured. */
export const pgStorageConfigured = (config: DeployConfig): boolean =>
  config.PG_MANAGE_VIA_SSH
  || config.PG_PRIMARY_NODE.trim().length > 0
  || config.PG_REPLICA_NODES.trim().length > 0
  || config.PG_DB_PASSWORD.length > 0;

export const redisStorageConfigured = (config: DeployConfig): boolean =>
  config.REDIS_MANAGE_VIA_SSH || parseNodeList(config.REDIS_NODES).length > 0;

export const auditDbConfigured = (config: DeployConfig): boolean =>
  config.AUDIT_DB_MANAGE_VIA_SSH || config.AUDIT_DB_NODE.trim().length > 0;

export const logDbConfigured = (config: DeployConfig): boolean =>
  config.LOG_DB_MANAGE_VIA_SSH || config.LOG_DB_NODE.trim().length > 0;

export const backupStorageConfigured = (config: DeployConfig): boolean =>
  config.BACKUP_ENABLED || config.BACKUP_NODE.trim().length > 0;

/**
 * The core upstream URLs every edge service receives. The helper is the single
 * source of truth: an explicit CORE_BACK_URLS wins, otherwise the core node
 * array, otherwise the legacy single-host fields.
 */
export const edgeCoreUrls = (config: DeployConfig): string[] => {
  if (config.CORE_BACK_URLS && config.CORE_BACK_URLS.trim().length > 0) {
    return config.CORE_BACK_URLS.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  const coreNodes = parseNodeList(config.CORE_NODES);
  if (coreNodes.length > 0) {
    return coreNodes.map((node) => `https://${node.privateIp}:${node.servicePort}`);
  }
  if (config.CORE_PRIVATE_IP) {
    return [`https://${config.CORE_PRIVATE_IP}:${config.CORE_PORT}`];
  }
  return [];
};

/** The effective relational database (legacy DB_* or the PG 18 settings). */
export const effectiveDatabase = (config: DeployConfig): {
  engine: DeployConfig["DB_ENGINE"];
  host: string | null;
  port: number;
  name: string;
  user: string;
  password: string;
  url: string | null;
  privateIp: string | null;
  managedViaSsh: boolean;
} => {
  const primary = parseNodeList(config.PG_PRIMARY_NODE)[0] ?? null;
  const pg = pgStorageConfigured(config);
  const name = config.DB_NAME ?? config.PG_DB_NAME;
  const user = config.DB_USER ?? config.PG_DB_USER;
  const password = config.DB_PASSWORD ?? config.PG_DB_PASSWORD;
  const host = primary?.privateIp ?? config.DB_PRIVATE_IP ?? null;
  const port = primary?.servicePort ?? config.DB_PORT;
  const derivedPort = config.PGBOUNCER_ENABLED ? config.PGBOUNCER_PORT : port;
  const url = config.DATABASE_URL
    ?? (pg && host ? `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${derivedPort}/${name}` : null);
  return {
    engine: config.DB_ENGINE,
    host,
    port,
    name,
    user,
    password,
    url,
    privateIp: config.DB_PRIVATE_IP ?? primary?.privateIp ?? null,
    managedViaSsh: config.DB_MANAGE_VIA_SSH || config.PG_MANAGE_VIA_SSH,
  };
};

/**
 * Cross-field rules. A value can be valid in isolation and still make the
 * topology impossible (the database URL not matching the engine, a certbot
 * domain with no certificate path, a database host with no SSH target, …).
 */
export const validateDeployConfig = (config: DeployConfig): string[] => {
  const problems: string[] = [];
  const pgConfigured = pgStorageConfigured(config);

  if (pgConfigured && config.DB_ENGINE !== "postgresql") {
    problems.push("DB_ENGINE must be 'postgresql' when PostgreSQL 18 storage fields are configured");
  }
  const replicaNodes = (() => {
    try {
      return parseNodeList(config.PG_REPLICA_NODES);
    } catch (error) {
      problems.push(`PG_REPLICA_NODES: ${(error as Error).message}`);
      return [];
    }
  })();
  const primaryNodes = (() => {
    try {
      return parseNodeList(config.PG_PRIMARY_NODE);
    } catch (error) {
      problems.push(`PG_PRIMARY_NODE: ${(error as Error).message}`);
      return [];
    }
  })();
  if (primaryNodes.length > 1) problems.push("PG_PRIMARY_NODE must describe exactly one primary");
  if (replicaNodes.length > 0 && primaryNodes.length === 0) {
    problems.push("PG_REPLICA_NODES requires PG_PRIMARY_NODE");
  }
  if (config.PG_MANAGE_VIA_SSH) {
    if (primaryNodes.length === 0) problems.push("PG_PRIMARY_NODE is required when PG_MANAGE_VIA_SSH=true");
    if (!config.PG_SSH_KEY_PATH) problems.push("PG_SSH_KEY_PATH is required when PG_MANAGE_VIA_SSH=true");
    if (config.PG_DB_PASSWORD.length === 0) problems.push("PG_DB_PASSWORD is required when PG_MANAGE_VIA_SSH=true");
  }
  if (pgConfigured && config.PG_DB_PASSWORD.length > 0 && config.PG_DB_PASSWORD.length < 8) {
    problems.push("PG_DB_PASSWORD must be at least 8 characters");
  }
  if (config.PGBOUNCER_ENABLED && !pgConfigured) {
    problems.push("PGBOUNCER_ENABLED requires the PostgreSQL 18 storage fields");
  }

  if (config.DB_MANAGE_VIA_SSH && !pgConfigured) {
    if (!config.DB_SSH_HOST) problems.push("DB_SSH_HOST is required when DB_MANAGE_VIA_SSH=true");
    if (!config.DB_SSH_KEY_PATH) problems.push("DB_SSH_KEY_PATH is required when DB_MANAGE_VIA_SSH=true");
    if (!config.DB_PRIVATE_IP) problems.push("DB_PRIVATE_IP is required when DB_MANAGE_VIA_SSH=true");
  }

  if (!pgConfigured) {
    if (!config.DB_NAME) problems.push("DB_NAME is required");
    if (!config.DB_USER) problems.push("DB_USER is required");
    if (!config.DB_PASSWORD) problems.push("DB_PASSWORD is required");
    if (!config.DATABASE_URL) problems.push("DATABASE_URL is required");
  }
  if (config.DATABASE_URL) {
    const enginePrefix = config.DB_ENGINE === "mysql" ? "mysql://" : "postgresql://";
    if (!config.DATABASE_URL.startsWith(enginePrefix)) {
      problems.push(`DATABASE_URL must start with ${enginePrefix} (DB_ENGINE=${config.DB_ENGINE})`);
    }
    if (config.DB_PRIVATE_IP && !config.DATABASE_URL.includes(config.DB_PRIVATE_IP)) {
      problems.push("DATABASE_URL should point at DB_PRIVATE_IP");
    }
  }
  // A single-box installation legitimately co-locates the database with the
  // core (the database binds to 127.0.0.1 and is never exposed); on separate
  // nodes the operator points DATABASE_URL at the database host's private IP.

  // --- Horizontal compute node arrays -------------------------------------
  const tiers = [
    { name: "CORE_NODES", value: config.CORE_NODES, legacy: [["CORE_SSH_HOST", config.CORE_SSH_HOST], ["CORE_SSH_KEY_PATH", config.CORE_SSH_KEY_PATH], ["CORE_PRIVATE_IP", config.CORE_PRIVATE_IP]] },
    { name: "ADMIN_NODES", value: config.ADMIN_NODES, legacy: [["ADMIN_SSH_HOST", config.ADMIN_SSH_HOST], ["ADMIN_SSH_KEY_PATH", config.ADMIN_SSH_KEY_PATH], ["ADMIN_PRIVATE_IP", config.ADMIN_PRIVATE_IP]] },
    { name: "MERCHANT_NODES", value: config.MERCHANT_NODES, legacy: [["MERCHANT_SSH_HOST", config.MERCHANT_SSH_HOST], ["MERCHANT_SSH_KEY_PATH", config.MERCHANT_SSH_KEY_PATH], ["MERCHANT_PRIVATE_IP", config.MERCHANT_PRIVATE_IP]] },
    { name: "CHECKOUT_NODES", value: config.CHECKOUT_NODES, legacy: [["CHECKOUT_SSH_HOST", config.CHECKOUT_SSH_HOST], ["CHECKOUT_SSH_KEY_PATH", config.CHECKOUT_SSH_KEY_PATH], ["CHECKOUT_PRIVATE_IP", config.CHECKOUT_PRIVATE_IP]] },
  ];
  for (const [name, value, keyPath] of [
    ["CORE_NODES", config.CORE_NODES, config.CORE_SSH_KEY_PATH],
    ["ADMIN_NODES", config.ADMIN_NODES, config.ADMIN_SSH_KEY_PATH],
    ["MERCHANT_NODES", config.MERCHANT_NODES, config.MERCHANT_SSH_KEY_PATH],
    ["CHECKOUT_NODES", config.CHECKOUT_NODES, config.CHECKOUT_SSH_KEY_PATH],
  ] as const) {
    if (value.trim().length > 0 && !keyPath) {
      problems.push(`${name} requires the matching *_SSH_KEY_PATH`);
    }
  }
  const parsedTiers = new Map<string, NodeSpec[]>();
  for (const tier of tiers) {
    if (tier.value.trim().length === 0) {
      for (const [field, value] of tier.legacy) {
        if (!value) problems.push(`${field} is required when ${tier.name} is empty`);
      }
      parsedTiers.set(tier.name, []);
      continue;
    }
    try {
      parsedTiers.set(tier.name, parseNodeList(tier.value));
    } catch (error) {
      problems.push(`${tier.name}: ${(error as Error).message}`);
      parsedTiers.set(tier.name, []);
    }
  }

  // --- Storage node arrays / single nodes ---------------------------------
  const storageNodes: Array<{ label: string; nodes: NodeSpec[] }> = [];
  for (const [label, value] of [
    ["PG_PRIMARY_NODE", config.PG_PRIMARY_NODE],
    ["PG_REPLICA_NODES", config.PG_REPLICA_NODES],
    ["REDIS_NODES", config.REDIS_NODES],
    ["AUDIT_DB_NODE", config.AUDIT_DB_NODE],
    ["LOG_DB_NODE", config.LOG_DB_NODE],
    ["BACKUP_NODE", config.BACKUP_NODE],
  ] as const) {
    storageNodes.push({ label, nodes: label === "PG_PRIMARY_NODE" ? primaryNodes : label === "PG_REPLICA_NODES" ? replicaNodes : (() => {
      try {
        return parseNodeList(value);
      } catch (error) {
        problems.push(`${label}: ${(error as Error).message}`);
        return [];
      }
    })() });
  }
  if (config.REDIS_MANAGE_VIA_SSH) {
    const redisNodes = storageNodes.find((entry) => entry.label === "REDIS_NODES")?.nodes ?? [];
    if (redisNodes.length === 0) problems.push("REDIS_NODES is required when REDIS_MANAGE_VIA_SSH=true");
    if (!config.REDIS_SSH_KEY_PATH) problems.push("REDIS_SSH_KEY_PATH is required when REDIS_MANAGE_VIA_SSH=true");
    if (!config.REDIS_PASSWORD) problems.push("REDIS_PASSWORD is required when REDIS_MANAGE_VIA_SSH=true");
  }
  if (config.AUDIT_DB_MANAGE_VIA_SSH) {
    if (!config.AUDIT_DB_NODE) problems.push("AUDIT_DB_NODE is required when AUDIT_DB_MANAGE_VIA_SSH=true");
    if (!config.AUDIT_DB_SSH_KEY_PATH) problems.push("AUDIT_DB_SSH_KEY_PATH is required when AUDIT_DB_MANAGE_VIA_SSH=true");
    if (!config.AUDIT_DB_PASSWORD) problems.push("AUDIT_DB_PASSWORD is required when AUDIT_DB_MANAGE_VIA_SSH=true");
  }
  if (config.LOG_DB_MANAGE_VIA_SSH) {
    if (!config.LOG_DB_NODE) problems.push("LOG_DB_NODE is required when LOG_DB_MANAGE_VIA_SSH=true");
    if (!config.LOG_DB_SSH_KEY_PATH) problems.push("LOG_DB_SSH_KEY_PATH is required when LOG_DB_MANAGE_VIA_SSH=true");
    if (!config.LOG_DB_PASSWORD) problems.push("LOG_DB_PASSWORD is required when LOG_DB_MANAGE_VIA_SSH=true");
  }
  if (config.BACKUP_ENABLED) {
    if (!config.BACKUP_NODE) problems.push("BACKUP_NODE is required when BACKUP_ENABLED=true");
    if (!config.BACKUP_SSH_KEY_PATH) problems.push("BACKUP_SSH_KEY_PATH is required when BACKUP_ENABLED=true");
    if (!config.BACKUP_PRIMARY_S3_BUCKET) problems.push("BACKUP_PRIMARY_S3_BUCKET is required when BACKUP_ENABLED=true");
    if (!config.BACKUP_ENCRYPTION_KEY_HEX) problems.push("BACKUP_ENCRYPTION_KEY_HEX is required when BACKUP_ENABLED=true");
  }
  // Node ids are unique across the whole plan; private IPs are unique within a
  // tier (co-locating different tiers on one box remains supported).
  const allNodes = [...parsedTiers.values(), ...storageNodes.map((entry) => entry.nodes)].flat();
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const node of allNodes) {
    if (seenIds.has(node.nodeId)) duplicateIds.add(node.nodeId);
    seenIds.add(node.nodeId);
  }
  for (const id of duplicateIds) problems.push(`node id '${id}' is used more than once across the node lists`);

  const pgIps = [...primaryNodes, ...replicaNodes].map((node) => node.privateIp);
  const duplicatePgIps = new Set<string>();
  const seenPgIps = new Set<string>();
  for (const ip of pgIps) {
    if (seenPgIps.has(ip)) duplicatePgIps.add(ip);
    seenPgIps.add(ip);
  }
  for (const ip of duplicatePgIps) problems.push(`PostgreSQL primary/replica private IP '${ip}' is used more than once`);

  // The same SSH endpoint cannot host two compute roles on the same port.
  const endpointPorts = new Map<string, Map<number, string>>();
  for (const [label, nodes] of parsedTiers) {
    for (const node of nodes) {
      const endpoint = `${node.sshHost}:${node.sshPort}`;
      const ports = endpointPorts.get(endpoint) ?? new Map<number, string>();
      const owner = ports.get(node.servicePort);
      if (owner && owner !== `${label}:${node.nodeId}`) {
        problems.push(`port ${node.servicePort} on ${endpoint} is requested by both ${owner} and ${label}:${node.nodeId}`);
      }
      ports.set(node.servicePort, `${label}:${node.nodeId}`);
      endpointPorts.set(endpoint, ports);
    }
  }
  // A storage listener may share 5432 with another PostgreSQL-family role on
  // the same host (co-located primary/audit/log), but never a compute listener.
  const storagePortClaims: Array<{ label: string; node: NodeSpec; port: number; family: "postgres" | "redis" | "backup" | "pgbouncer" }> = [];
  for (const entry of storageNodes) {
    const family = entry.label.startsWith("PG_") ? "postgres" as const : entry.label === "REDIS_NODES" ? "redis" as const : entry.label === "AUDIT_DB_NODE" || entry.label === "LOG_DB_NODE" ? "postgres" as const : "backup" as const;
    for (const node of entry.nodes) storagePortClaims.push({ label: entry.label, node, port: node.servicePort, family });
  }
  for (const node of primaryNodes) storagePortClaims.push({ label: "PGBOUNCER_PORT", node, port: config.PGBOUNCER_PORT, family: "pgbouncer" });
  if (config.PGBOUNCER_ENABLED) {
    for (const node of replicaNodes) storagePortClaims.push({ label: "PGBOUNCER_PORT", node, port: config.PGBOUNCER_PORT, family: "pgbouncer" });
  }
  const storageEndpointPorts = new Map<string, Array<{ label: string; family: string; port: number }>>();
  for (const claim of storagePortClaims) {
    const endpoint = `${claim.node.sshHost}:${claim.node.sshPort}`;
    const computeOwner = endpointPorts.get(endpoint)?.get(claim.port);
    if (computeOwner) {
      problems.push(`storage port ${claim.port} on ${endpoint} collides with compute listener ${computeOwner}`);
    }
    const claims = storageEndpointPorts.get(endpoint) ?? [];
    const clash = claims.find((other) => other.port === claim.port && other.family !== claim.family);
    if (clash) {
      problems.push(`storage port ${claim.port} on ${endpoint} is claimed by both ${clash.label} and ${claim.label}`);
    }
    claims.push({ label: claim.label, family: claim.family, port: claim.port });
    storageEndpointPorts.set(endpoint, claims);
  }

  for (const [role, enabled, mode, cert, key] of [
    ["MERCHANT", config.MERCHANT_SSL, config.MERCHANT_SSL_MODE, config.MERCHANT_SSL_CERT_PATH, config.MERCHANT_SSL_KEY_PATH],
    ["CHECKOUT", config.CHECKOUT_SSL, config.CHECKOUT_SSL_MODE, config.CHECKOUT_SSL_CERT_PATH, config.CHECKOUT_SSL_KEY_PATH],
  ] as const) {
    if (enabled && mode === "custom" && (!cert || !key)) {
      problems.push(`${role}_SSL_MODE=custom requires ${role}_SSL_CERT_PATH and ${role}_SSL_KEY_PATH`);
    }
  }

  // Distinct listeners within a portal. The two public portals may share
  // 80/443 because they are told apart by server_name.
  for (const [role, httpPort, httpsPort, lanPort, lanEnabled] of [
    ["MERCHANT", config.MERCHANT_HTTP_PORT, config.MERCHANT_HTTPS_PORT, config.MERCHANT_LAN_PORT, config.MERCHANT_LAN_PORT > 0],
    ["CHECKOUT", config.CHECKOUT_HTTP_PORT, config.CHECKOUT_HTTPS_PORT, config.CHECKOUT_LAN_PORT, config.CHECKOUT_LAN_PORT > 0],
  ] as const) {
    const ports: Array<[string, number]> = [
      [`${role}_HTTP_PORT`, httpPort],
      [`${role}_HTTPS_PORT`, httpsPort],
      ...(lanEnabled ? [[`${role}_LAN_PORT`, lanPort] as [string, number]] : []),
    ];
    for (let i = 0; i < ports.length; i += 1) {
      for (let j = i + 1; j < ports.length; j += 1) {
        if (ports[i]![1] === ports[j]![1]) {
          problems.push(`${ports[i]![0]} and ${ports[j]![0]} must differ (two listeners on the same port)`);
        }
      }
    }
    if (httpPort === config.ADMIN_NGINX_LAN_PORT && lanEnabled) {
      problems.push(`${role}_HTTP_PORT must differ from ADMIN_NGINX_LAN_PORT`);
    }
  }

  const lanPorts = [
    ["MERCHANT_LAN_PORT", config.MERCHANT_LAN_PORT],
    ["CHECKOUT_LAN_PORT", config.CHECKOUT_LAN_PORT],
    ["ADMIN_NGINX_LAN_PORT", config.ADMIN_NGINX_LAN_PORT],
  ].filter(([, port]) => Number(port) > 0);
  for (let i = 0; i < lanPorts.length; i += 1) {
    for (let j = i + 1; j < lanPorts.length; j += 1) {
      if (lanPorts[i]![1] === lanPorts[j]![1]) {
        problems.push(`${lanPorts[i]![0]} and ${lanPorts[j]![0]} must differ (two listeners on the same port)`);
      }
    }
  }
  if (config.MERCHANT_DOMAIN === config.CHECKOUT_DOMAIN) {
    problems.push("MERCHANT_DOMAIN and CHECKOUT_DOMAIN must differ (two public vhosts on the edge host)");
  }

  if (config.CORE_PORT === config.ADMIN_BACK_PORT
    || config.CORE_PORT === config.MERCHANT_BACK_PORT
    || config.CORE_PORT === config.CHECKOUT_BACK_PORT) {
    problems.push("CORE_PORT must differ from the edge backend ports");
  }

  // --- Fake Rails tier -----------------------------------------------------
  if (config.FAKE_RAILS_ENABLED) {
    if (!config.FAKE_RAILS_SSH_HOST) problems.push("FAKE_RAILS_SSH_HOST is required when FAKE_RAILS_ENABLED=true");
    if (!config.FAKE_RAILS_SSH_KEY_PATH) problems.push("FAKE_RAILS_SSH_KEY_PATH is required when FAKE_RAILS_ENABLED=true");
    if (!config.FAKE_RAILS_PRIVATE_IP) problems.push("FAKE_RAILS_PRIVATE_IP is required when FAKE_RAILS_ENABLED=true");
    if (!config.FAKE_RAILS_ADMIN_USER) problems.push("FAKE_RAILS_ADMIN_USER is required when FAKE_RAILS_ENABLED=true");
    if (!config.FAKE_RAILS_ADMIN_PASSWORD) problems.push("FAKE_RAILS_ADMIN_PASSWORD is required when FAKE_RAILS_ENABLED=true");
    if (!config.FAKE_RAILS_JWT_SECRET) problems.push("FAKE_RAILS_JWT_SECRET is required when FAKE_RAILS_ENABLED=true");
    if (!config.FAKE_RAILS_SEEDER_TOKEN) problems.push("FAKE_RAILS_SEEDER_TOKEN is required when FAKE_RAILS_ENABLED=true");
    if (config.DEPLOY_ENV === "production" && !config.FAKE_RAILS_ALLOW_IN_PRODUCTION) {
      problems.push(
        'FAKE_RAILS_PRODUCTION_GUARD_BLOCKED: Set FAKE_RAILS_ALLOW_IN_PRODUCTION="true" to run Fake Rails in production mode',
      );
    }
    if (config.FAKE_RAILS_ADMIN_PASSWORD && config.FAKE_RAILS_ADMIN_PASSWORD.length < 12) {
      problems.push("FAKE_RAILS_ADMIN_PASSWORD must be at least 12 characters");
    }
    if (config.FAKE_RAILS_BACK_PORT === config.FAKE_RAILS_NGINX_PORT) {
      problems.push("FAKE_RAILS_BACK_PORT and FAKE_RAILS_NGINX_PORT must differ");
    }
    const reserved = [
      ["CORE_PORT", config.CORE_PORT],
      ["ADMIN_BACK_PORT", config.ADMIN_BACK_PORT],
      ["MERCHANT_BACK_PORT", config.MERCHANT_BACK_PORT],
      ["CHECKOUT_BACK_PORT", config.CHECKOUT_BACK_PORT],
      ["ADMIN_NGINX_LAN_PORT", config.ADMIN_NGINX_LAN_PORT],
    ] as Array<[string, number]>;
    for (const [name, port] of reserved) {
      if (config.FAKE_RAILS_BACK_PORT === port) problems.push(`FAKE_RAILS_BACK_PORT must differ from ${name}`);
      if (config.FAKE_RAILS_NGINX_PORT === port) problems.push(`FAKE_RAILS_NGINX_PORT must differ from ${name}`);
    }
    for (const port of [80, 443]) {
      if (config.FAKE_RAILS_NGINX_PORT === port) {
        problems.push(`FAKE_RAILS_NGINX_PORT must not be the public ${port}`);
      }
    }
  }

  if (config.RUN_SYNTHETIC_HISTORY_SEED) {
    if (!config.IS_TEST_SERVER) problems.push("RUN_SYNTHETIC_HISTORY_SEED requires IS_TEST_SERVER=true");
    if (!config.FAKE_RAILS_ENABLED) problems.push("RUN_SYNTHETIC_HISTORY_SEED requires FAKE_RAILS_ENABLED=true");
    if (config.DEPLOY_ENV === "production" && !config.FAKE_RAILS_ALLOW_IN_PRODUCTION) {
      problems.push("RUN_SYNTHETIC_HISTORY_SEED requires FAKE_RAILS_ALLOW_IN_PRODUCTION=true in production");
    }
  }

  return problems;
};

/** A tiny dotenv parser that understands `KEY=value`, `KEY="value with spaces"` and `#` comments. */
export const parseDeployEnv = (source: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // A quoted value ends at its closing quote; anything after it (an inline
    // comment such as `# "auto" | "fresh"`) is not part of the value. This
    // also preserves a `#` that is legitimately inside the quotes.
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) {
        value = value.slice(0, hash).trim();
      }
    }
    values[key] = value;
  }
  return values;
};

export interface ConfigLoadResult {
  ok: boolean;
  config?: DeployConfig;
  problems: string[];
}

/** Parses and validates a `deploy.env` source. */
export const loadDeployConfig = (source: string): ConfigLoadResult => {
  const env = parseDeployEnv(source);
  const parsed = base.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const problems = validateDeployConfig(parsed.data);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, config: parsed.data, problems: [] };
};

export const deployConfigSchema = base;
