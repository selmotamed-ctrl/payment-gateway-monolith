import {
  edgeCoreUrls,
  effectiveDatabase,
  parseNodeList,
  pgStorageConfigured,
  withIpv6Loopback,
  type DeployConfig,
  type DeployRole,
  type HostRole,
  type NodeSpec,
  type StorageRole,
} from "./configSchema";

/**
 * Turns the logical roles and horizontal node arrays into the concrete
 * per-host plan. Roles that share an SSH endpoint are one machine; every node
 * in a node array still receives its own ServicePlan (with a unique name), so
 * several processes can be rolled out on one box or spread over N boxes.
 */

export type ServiceName = string;
export type NginxSiteName = "admin-lan" | "merchant-public" | "checkout-public" | "merchant-lan" | "checkout-lan" | "fake-rails";
export type CertBundle = "core-server" | "admin-client" | "merchant-client" | "checkout-client" | "fake-rails-server" | "backup-server" | "pg-client" | "redis-client" | "audit-db-client" | "log-db-client";

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  sudoPassword: string;
}

export interface ServicePlan {
  name: ServiceName;
  role: DeployRole;
  sourceDir: string;
  remoteDir: string;
  port: number;
  env: Record<string, string>;
  nodeId?: string;
  privateIp?: string;
  /** Per-node env file; multi-node hosts never share one `.env`. */
  envFileName?: string;
  /** Per-node release/current suffixes keep two instances from overwriting each other. */
  releaseSuffix?: string;
  currentLink?: string;
}

export interface NginxPlan {
  site: NginxSiteName;
  role: DeployRole;
  template: string;
  listenPort: number;
  httpPort: number;
  httpsPort: number;
  ssl: boolean;
  serverName: string;
  sslMode: "lan" | "certbot" | "custom" | "self_signed";
  certPath?: string;
  keyPath?: string;
  staticRoot: string;
  /** All local and remote backend nodes for this site, used for least_conn. */
  upstreamName?: string;
  upstreamServers?: string[];
}

export interface FirewallRulePlan {
  port: number;
  proto: "tcp";
  fromCidrs?: string[];
  comment: string;
}

export type ComputeNodeRole = "core" | "admin" | "merchant" | "checkout";

export interface NodePlan {
  nodeId: string;
  id: string;
  role: ComputeNodeRole;
  ssh: SshTarget;
  host: string;
  privateIp: string;
  port: number;
  servicePort: number;
  serviceName: ServiceName;
  hostKey: string;
}

export interface StorageNodePlan {
  role: StorageRole;
  nodeId: string;
  sshHost: string;
  sshPort: number;
  privateIp: string;
  servicePort: number;
  port: number;
  ssh: SshTarget;
  hostKey: string;
}

export interface PostgresStoragePlan {
  primary: StorageNodePlan | null;
  replicas: StorageNodePlan[];
  pgbouncer: StorageNodePlan[];
  version: string;
}

export interface StoragePlan {
  nodes: StorageNodePlan[];
  postgres: PostgresStoragePlan;
  redis: StorageNodePlan[];
  auditDb: StorageNodePlan | null;
  logDb: StorageNodePlan | null;
  backup: StorageNodePlan | null;
  "pg-primary": StorageNodePlan | null;
  "pg-replica": StorageNodePlan[];
  pgbouncer: StorageNodePlan[];
  "audit-db": StorageNodePlan | null;
  "log-db": StorageNodePlan | null;
}

export interface BackupPlan {
  enabled: boolean;
  node: StorageNodePlan | null;
  engineMode: DeployConfig["BACKUP_ENGINE_MODE"];
  daemonPort: number;
  s3Bucket: string;
  secondaryTarget: string;
}

export interface HostPlan {
  key: string;
  displayName: string;
  ssh: SshTarget;
  roles: HostRole[];
  services: ServicePlan[];
  nginx: NginxPlan[];
  certs: CertBundle[];
  firewall: FirewallRulePlan[];
  keepReleases: number;
  deployOrder: number;
}

export interface DeployPlan {
  topology: "single-host" | "split" | "distributed";
  hosts: HostPlan[];
  roles: Record<DeployRole, string>;
  database: {
    engine: DeployConfig["DB_ENGINE"];
    host: string;
    port: number;
    name: string;
    user: string;
    privateIp: string | null;
    managedViaSsh: boolean;
  };
  nodes: {
    core: NodePlan[];
    admin: NodePlan[];
    merchant: NodePlan[];
    checkout: NodePlan[];
  };
  storage: StoragePlan;
  replicas: StorageNodePlan[];
  backup: BackupPlan;
}

const ROLE_ORDER: Record<HostRole, number> = {
  db: 1,
  "pg-primary": 1,
  "pg-replica": 1,
  pgbouncer: 1,
  redis: 1,
  "audit-db": 1,
  "log-db": 1,
  backup: 1,
  core: 2,
  "fake-rails": 3,
  admin: 4,
  merchant: 5,
  checkout: 6,
};

const ROLE_LABEL: Record<HostRole, string> = {
  db: "database",
  core: "core-back",
  "fake-rails": "fake-rails-back + fake-rails-front",
  admin: "admin-back + admin-front",
  merchant: "merchant-back + merchant-front",
  checkout: "checkout-back + checkout-front",
  "pg-primary": "PostgreSQL 18 primary",
  "pg-replica": "PostgreSQL 18 replica",
  pgbouncer: "PgBouncer",
  redis: "Redis",
  "audit-db": "audit database",
  "log-db": "log database",
  backup: "backup daemon",
};

const sshKey = (ssh: { host: string; port: number }): string => `${ssh.host}:${ssh.port}`;

const requireValue = <T>(value: T | undefined | null, name: string): T => {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required to build the deployment plan`);
  }
  return value;
};

const slug = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "node";

const storageEnabled = (config: DeployConfig): boolean =>
  pgStorageConfigured(config)
  || config.REDIS_NODES.trim().length > 0
  || config.AUDIT_DB_NODE.trim().length > 0
  || config.LOG_DB_NODE.trim().length > 0
  || config.BACKUP_ENABLED;

const allCorePrivateIps = (config: DeployConfig): string[] => {
  const nodes = parseNodeList(config.CORE_NODES);
  if (nodes.length > 0) return nodes.map((node) => node.privateIp);
  return config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : [];
};

const allEdgePrivateIps = (config: DeployConfig): string[] => {
  const ips: string[] = [];
  for (const [value, legacy] of [
    [config.ADMIN_NODES, config.ADMIN_PRIVATE_IP],
    [config.MERCHANT_NODES, config.MERCHANT_PRIVATE_IP],
    [config.CHECKOUT_NODES, config.CHECKOUT_PRIVATE_IP],
  ] as const) {
    const nodes = parseNodeList(value);
    if (nodes.length > 0) {
      ips.push(...nodes.map((node) => node.privateIp));
    } else if (legacy) {
      ips.push(legacy);
    }
  }
  return [...new Set(ips)];
};

const backupPrivateIp = (config: DeployConfig): string | null =>
  parseNodeList(config.BACKUP_NODE)[0]?.privateIp ?? null;

const storageEnv = (config: DeployConfig): Record<string, string> => {
  if (!pgStorageConfigured(config)) return {};
  const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
  const replicas = parseNodeList(config.PG_REPLICA_NODES);
  const database = effectiveDatabase(config);
  // Replicas are read directly on their own PostgreSQL port. Routing them
  // through a single PgBouncer port would point every co-located replica back
  // at the primary and silently defeat read scaling.
  const replicaUrls = replicas.map((node) =>
    `postgresql://${encodeURIComponent(database.user)}:${encodeURIComponent(database.password)}@${node.privateIp}:${node.servicePort}/${database.name}`,
  );
  return {
    ...(primary ? {
      PG_PRIMARY_HOST: primary.privateIp,
      PG_PRIMARY_PORT: String(config.PGBOUNCER_ENABLED ? config.PGBOUNCER_PORT : primary.servicePort),
      PG_DB_NAME: config.PG_DB_NAME,
      PG_DB_USER: config.PG_DB_USER,
      PG_DB_PASSWORD: config.PG_DB_PASSWORD,
      PG_REPLICATION_USER: config.PG_REPLICATION_USER,
      PG_REPLICATION_PASSWORD: config.PG_REPLICATION_PASSWORD,
    } : {}),
    PG_REPLICA_HOSTS: replicas.map((node) => `${node.privateIp}:${node.servicePort}`).join(","),
    PG_REPLICA_NODES: config.PG_REPLICA_NODES,
    PGBOUNCER_ENABLED: config.PGBOUNCER_ENABLED ? "true" : "false",
    PGBOUNCER_PORT: String(config.PGBOUNCER_PORT),
    PGBOUNCER_DEFAULT_POOL_SIZE: String(config.PGBOUNCER_DEFAULT_POOL_SIZE),
    PGBOUNCER_MAX_CLIENT_CONN: String(config.PGBOUNCER_MAX_CLIENT_CONN),
    PGBOUNCER_MAX_PREPARED_STATEMENTS: String(config.PGBOUNCER_MAX_PREPARED_STATEMENTS),
    ...(replicaUrls.length > 0 ? { DATABASE_REPLICA_URLS: replicaUrls.join(",") } : {}),
    ...(config.AUDIT_DB_NODE ? { AUDIT_DATABASE_URL: `postgresql://${encodeURIComponent(config.AUDIT_DB_USER)}:${encodeURIComponent(config.AUDIT_DB_PASSWORD)}@${parseNodeList(config.AUDIT_DB_NODE)[0]?.privateIp}:${parseNodeList(config.AUDIT_DB_NODE)[0]?.servicePort}/${config.AUDIT_DB_NAME}` } : {}),
    ...(config.LOG_DB_NODE ? { LOG_DATABASE_URL: `postgresql://${encodeURIComponent(config.LOG_DB_USER)}:${encodeURIComponent(config.LOG_DB_PASSWORD)}@${parseNodeList(config.LOG_DB_NODE)[0]?.privateIp}:${parseNodeList(config.LOG_DB_NODE)[0]?.servicePort}/${config.LOG_DB_NAME}` } : {}),
    ...(config.BACKUP_ENABLED ? {
      BACKUP_DAEMON_URL: `https://${backupPrivateIp(config) ?? "127.0.0.1"}:${config.BACKUP_DAEMON_PORT}`,
      BACKUP_DAEMON_CA_CERT_PATH: "shared/certs/internal-ca.crt",
      BACKUP_DAEMON_CLIENT_CERT_PATH: "shared/certs/backup-client.crt",
      BACKUP_DAEMON_CLIENT_KEY_PATH: "shared/certs/backup-client.key",
    } : {}),
  };
};

const coreEnv = (config: DeployConfig, node?: NodePlan): Record<string, string> => {
  const database = effectiveDatabase(config);
  const redisNodes = parseNodeList(config.REDIS_NODES);
  const redisUrl = config.REDIS_URL
    ?? (redisNodes.length > 0
      ? `redis://:${config.REDIS_PASSWORD}@${redisNodes[0]!.privateIp}:${redisNodes[0]!.servicePort}/0`
      : undefined);
  return {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: String(node?.port ?? config.CORE_PORT),
    ...(node ? { NODE_ID: node.nodeId, NODE_PRIVATE_IP: node.privateIp } : {}),
    DATABASE_URL: database.url ?? "",
    MTLS_CA_CERT_PATH: "shared/certs/internal-ca.crt",
    MTLS_SERVER_CERT_PATH: "shared/certs/core-back.crt",
    MTLS_SERVER_KEY_PATH: "shared/certs/core-back.key",
    KMS_MASTER_KEY: config.KMS_MASTER_KEY,
    STORAGE_SHARD_COUNT: String(config.STORAGE_SHARD_COUNT),
    READ_REPLICA_MAX_LAG_MS: String(config.READ_REPLICA_MAX_LAG_MS),
    TRUST_PROXY: "false",
    LOG_LEVEL: "info",
    WORKER_ENABLED: "true",
    ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
    ...storageEnv(config),
    FAKE_RAILS_ENABLED: config.FAKE_RAILS_ENABLED ? "true" : "false",
    FAKE_RAILS_ALLOW_IN_PRODUCTION: config.FAKE_RAILS_ALLOW_IN_PRODUCTION ? "true" : "false",
    IS_TEST_SERVER: config.IS_TEST_SERVER ? "true" : "false",
    ...(config.FAKE_RAILS_ENABLED
      ? {
          FAKE_RAILS_PUBLIC_BASE_URL: config.FAKE_RAILS_PUBLIC_BASE_URL,
          ALLOW_FAKE_RAILS_HOSTS: "true",
          FAKE_RAILS_ALLOWED_HOSTS: fakeRailsAllowedHosts(config).join(","),
          FAKE_RAILS_SEEDER_TOKEN: config.FAKE_RAILS_SEEDER_TOKEN ?? "",
          ...(config.FAKE_RAILS_SSL
            ? { NODE_EXTRA_CA_CERTS: "shared/certs/internal-ca.crt" }
            : {}),
        }
      : {}),
    ...(config.RUN_SYNTHETIC_HISTORY_SEED
      ? {
          SYNTHETIC_SEED_PROFILE: config.SYNTHETIC_SEED_PROFILE,
          SYNTHETIC_SEED_KEY: config.SYNTHETIC_SEED_KEY,
          SYNTHETIC_SEED_YEARS_SPAN: String(config.SYNTHETIC_YEARS_SPAN),
        }
      : {}),
  };
};

const fakeRailsNodeSpec = (config: DeployConfig): NodeSpec | null =>
  parseNodeList(config.FAKE_RAILS_NODE)[0] ?? null;

const fakeRailsAllowedHosts = (config: DeployConfig): string[] =>
  [...new Set([
    config.FAKE_RAILS_DOMAIN,
    fakeRailsNodeSpec(config)?.privateIp ?? config.FAKE_RAILS_PRIVATE_IP ?? "",
    "127.0.0.1",
    "localhost",
    ...config.FAKE_RAILS_ALLOWED_HOSTS.split(",").map((entry) => entry.trim()),
  ].filter((entry) => entry.length > 0 && entry !== "_"))];

const fakeRailsEnv = (config: DeployConfig): Record<string, string> => ({
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: String(fakeRailsNodeSpec(config)?.servicePort ?? config.FAKE_RAILS_BACK_PORT),
  LOG_LEVEL: "info",
  FAKE_RAILS_ENABLED: "true",
  FAKE_RAILS_ALLOW_IN_PRODUCTION: config.FAKE_RAILS_ALLOW_IN_PRODUCTION ? "true" : "false",
  FAKE_RAILS_PUBLIC_BASE_URL: config.FAKE_RAILS_PUBLIC_BASE_URL,
  FAKE_RAILS_DATA_DIR: `${config.FAKE_RAILS_REMOTE_DIR}/shared/data`,
  CORE_INBOUND_BASE_URL: `http://${parseNodeList(config.CHECKOUT_NODES)[0]?.privateIp ?? requireValue(config.CHECKOUT_PRIVATE_IP, "CHECKOUT_PRIVATE_IP")}:${parseNodeList(config.CHECKOUT_NODES)[0]?.servicePort ?? config.CHECKOUT_BACK_PORT}/api/v1/inbound`,
  FAKE_RAILS_ADMIN_USER: config.FAKE_RAILS_ADMIN_USER ?? "",
  FAKE_RAILS_ADMIN_PASSWORD: config.FAKE_RAILS_ADMIN_PASSWORD ?? "",
  FAKE_RAILS_JWT_SECRET: config.FAKE_RAILS_JWT_SECRET ?? "",
  FAKE_RAILS_SEEDER_TOKEN: config.FAKE_RAILS_SEEDER_TOKEN ?? "",
  FAKE_RAILS_ALLOWED_CIDRS: withIpv6Loopback(config.FAKE_RAILS_ALLOWED_CIDRS),
});

/**
 * The edge servers never receive a database credential. Their `.env` contains
 * only the core upstream URL list, their own client certificate and the LAN
 * CIDRs.
 */
const edgeEnv = (
  config: DeployConfig,
  role: Exclude<DeployRole, "db" | "core">,
  node?: NodePlan,
): Record<string, string> => {
  const coreUrls = edgeCoreUrls(config);
  const base: Record<string, string> = {
    NODE_ENV: "production",
    CORE_BACK_URLS: coreUrls.join(","),
    CORE_BACK_URL: coreUrls[0] ?? "",
    MTLS_CA_CERT_PATH: "shared/certs/internal-ca.crt",
    MTLS_CLIENT_CERT_PATH: `shared/certs/${role}-back-client.crt`,
    MTLS_CLIENT_KEY_PATH: `shared/certs/${role}-back-client.key`,
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    ...(node ? { NODE_ID: node.nodeId, NODE_PRIVATE_IP: node.privateIp } : {}),
  };
  switch (role) {
    case "admin":
      return {
        ...base,
        PORT: String(node?.port ?? config.ADMIN_BACK_PORT),
        ADMIN_BIND_HOST: node?.privateIp ?? "127.0.0.1",
        ADMIN_LAN_CIDRS: withIpv6Loopback(config.LAN_ALLOWED_CIDRS),
      };
    case "merchant":
      return {
        ...base,
        PORT: String(node?.port ?? config.MERCHANT_BACK_PORT),
        BIND_HOST: node?.privateIp ?? "127.0.0.1",
        PG_LIVE_TOKEN_PREFIX: "pg_live_",
      };
    case "checkout":
      return {
        ...base,
        PORT: String(node?.port ?? config.CHECKOUT_BACK_PORT),
        BIND_HOST: node?.privateIp ?? "127.0.0.1",
        CHECKOUT_FRONT_BASE_URL: `https://${config.CHECKOUT_DOMAIN}`,
        CHECKOUT_FRONT_STATUS_PATH: "/pay/status",
        PAY_RATE_LIMIT_MAX: String(config.PAY_RATE_LIMIT_MAX),
      };
    default:
      return base;
  }
};

interface TierDefinition {
  role: ComputeNodeRole;
  nodes: string;
  legacyHost?: string;
  legacyPort: number;
  legacyUser: string;
  legacyKey?: string;
  legacySudo: string;
  legacyPrivateIp?: string;
  servicePort: number;
  serviceName: string;
  sourceDir: string;
  remoteDir: string;
}

const tierDefinitions = (config: DeployConfig): TierDefinition[] => [
  { role: "core", nodes: config.CORE_NODES, legacyHost: config.CORE_SSH_HOST, legacyPort: config.CORE_SSH_PORT, legacyUser: config.CORE_SSH_USER, legacyKey: config.CORE_SSH_KEY_PATH, legacySudo: config.CORE_SUDO_PASSWORD, legacyPrivateIp: config.CORE_PRIVATE_IP, servicePort: config.CORE_PORT, serviceName: "pg-core-back", sourceDir: "core-back", remoteDir: config.CORE_REMOTE_DIR },
  { role: "admin", nodes: config.ADMIN_NODES, legacyHost: config.ADMIN_SSH_HOST, legacyPort: config.ADMIN_SSH_PORT, legacyUser: config.ADMIN_SSH_USER, legacyKey: config.ADMIN_SSH_KEY_PATH, legacySudo: config.ADMIN_SUDO_PASSWORD, legacyPrivateIp: config.ADMIN_PRIVATE_IP, servicePort: config.ADMIN_BACK_PORT, serviceName: "pg-admin-back", sourceDir: "admin-back", remoteDir: config.ADMIN_REMOTE_DIR },
  { role: "merchant", nodes: config.MERCHANT_NODES, legacyHost: config.MERCHANT_SSH_HOST, legacyPort: config.MERCHANT_SSH_PORT, legacyUser: config.MERCHANT_SSH_USER, legacyKey: config.MERCHANT_SSH_KEY_PATH, legacySudo: config.MERCHANT_SUDO_PASSWORD, legacyPrivateIp: config.MERCHANT_PRIVATE_IP, servicePort: config.MERCHANT_BACK_PORT, serviceName: "pg-merchant-back", sourceDir: "merchant-back", remoteDir: config.MERCHANT_REMOTE_DIR },
  { role: "checkout", nodes: config.CHECKOUT_NODES, legacyHost: config.CHECKOUT_SSH_HOST, legacyPort: config.CHECKOUT_SSH_PORT, legacyUser: config.CHECKOUT_SSH_USER, legacyKey: config.CHECKOUT_SSH_KEY_PATH, legacySudo: config.CHECKOUT_SUDO_PASSWORD, legacyPrivateIp: config.CHECKOUT_PRIVATE_IP, servicePort: config.CHECKOUT_BACK_PORT, serviceName: "pg-checkout-back", sourceDir: "checkout-back", remoteDir: config.CHECKOUT_REMOTE_DIR },
];

const buildComputeNodes = (config: DeployConfig): Record<ComputeNodeRole, NodePlan[]> => {
  const result: Record<ComputeNodeRole, NodePlan[]> = { core: [], admin: [], merchant: [], checkout: [] };
  for (const tier of tierDefinitions(config)) {
    const specs = parseNodeList(tier.nodes);
    const source: Array<NodeSpec | null> = specs.length > 0 ? specs : [null];
    source.forEach((spec, index) => {
      const sshHost = spec?.sshHost ?? requireValue(tier.legacyHost, `${tier.role.toUpperCase()}_SSH_HOST`);
      const sshPort = spec?.sshPort ?? tier.legacyPort;
      const privateIp = spec?.privateIp ?? requireValue(tier.legacyPrivateIp, `${tier.role.toUpperCase()}_PRIVATE_IP`);
      const keyPath = tier.legacyKey ?? "";
      const nodeId = spec?.nodeId ?? `${tier.role}-1`;
      const port = spec?.servicePort ?? tier.servicePort;
      // A multi-node tier gets a nodeId-suffixed PM2 name for every node,
      // including the first. A single legacy/single-node tier keeps the
      // historical unsuffixed name so existing process tooling still works.
      const serviceName = specs.length > 1 ? `${tier.serviceName}-${slug(nodeId)}` : tier.serviceName;
      const ssh: SshTarget = { host: sshHost, port: sshPort, user: tier.legacyUser, keyPath, sudoPassword: tier.legacySudo };
      const node: NodePlan = { nodeId, id: nodeId, role: tier.role, ssh, host: sshHost, privateIp, port, servicePort: port, serviceName, hostKey: sshKey(ssh) };
      result[tier.role].push(node);
    });
  }
  return result;
};

const buildService = (config: DeployConfig, node: NodePlan, tier: TierDefinition): ServicePlan => {
  const sharedName = node.serviceName === tier.serviceName;
  return {
    name: node.serviceName,
    role: tier.role,
    sourceDir: tier.sourceDir,
    remoteDir: tier.remoteDir,
    port: node.port,
    env: tier.role === "core" ? coreEnv(config, node) : edgeEnv(config, tier.role as Exclude<DeployRole, "db" | "core">, node),
    nodeId: node.nodeId,
    privateIp: node.privateIp,
    envFileName: sharedName ? ".env" : `.env.${node.nodeId}`,
    releaseSuffix: sharedName ? "" : `-${node.nodeId}`,
    currentLink: sharedName ? `${tier.remoteDir}/current` : `${tier.remoteDir}/current-${node.nodeId}`,
  };
};

const buildFakeRailsService = (config: DeployConfig): ServicePlan => ({
  name: "pg-fake-rails-back",
  role: "fake-rails",
  sourceDir: "fake-rails-back",
  remoteDir: config.FAKE_RAILS_REMOTE_DIR,
  port: fakeRailsNodeSpec(config)?.servicePort ?? config.FAKE_RAILS_BACK_PORT,
  env: fakeRailsEnv(config),
  envFileName: ".env",
  releaseSuffix: "",
  currentLink: `${config.FAKE_RAILS_REMOTE_DIR}/current`,
});

type ComputeNodeMap = Partial<Record<ComputeNodeRole, NodePlan[]>>;

const currentDirFor = (remoteDir: string, localNodes?: NodePlan[], allNodes?: NodePlan[]): string => {
  if (!localNodes || localNodes.length === 0) return `${remoteDir}/current`;
  return (allNodes?.length ?? 0) > 1 ? `${remoteDir}/current-${localNodes[0]!.nodeId}` : `${remoteDir}/current`;
};

const upstreamFor = (
  role: string,
  site: string | null,
  nodes: NodePlan[] | undefined,
  fallbackIp: string,
  fallbackPort: number,
): {
  upstreamName: string;
  upstreamServers: string[];
} => ({
  // Upstream names are global in nginx, so a role with both a public and a LAN
  // site must not reuse the same name in two files.
  upstreamName: site ? `pg_${role}_${site}_backend` : `pg_${role}_backend`,
  upstreamServers: nodes && nodes.length > 0
    ? nodes.map((node) => `${node.privateIp}:${node.port}`)
    : [`${fallbackIp}:${fallbackPort}`],
});

const buildNginx = (config: DeployConfig, privateIp?: string, nodes: ComputeNodeMap = {}, fakeRails?: NodeSpec | null): NginxPlan[] => {
  const fakeRailsPort = fakeRails?.servicePort ?? config.FAKE_RAILS_BACK_PORT;
  const local = (list?: NodePlan[]): NodePlan[] | undefined => {
    const matching = list?.filter((node) => !privateIp || node.privateIp === privateIp);
    return matching && matching.length > 0 ? matching : list;
  };
  const adminUpstream = upstreamFor("admin", null, nodes.admin, "127.0.0.1", config.ADMIN_BACK_PORT);
  const merchantPublicUpstream = upstreamFor("merchant", "public", nodes.merchant, "127.0.0.1", config.MERCHANT_BACK_PORT);
  const merchantLanUpstream = upstreamFor("merchant", "lan", nodes.merchant, "127.0.0.1", config.MERCHANT_BACK_PORT);
  const checkoutPublicUpstream = upstreamFor("checkout", "public", nodes.checkout, "127.0.0.1", config.CHECKOUT_BACK_PORT);
  const checkoutLanUpstream = upstreamFor("checkout", "lan", nodes.checkout, "127.0.0.1", config.CHECKOUT_BACK_PORT);
  return [
    {
      site: "admin-lan",
      role: "admin",
      template: "nginx.admin.lan.conf.tpl",
      listenPort: config.ADMIN_NGINX_LAN_PORT,
      httpPort: config.ADMIN_NGINX_LAN_PORT,
      httpsPort: config.ADMIN_NGINX_LAN_PORT,
      ssl: config.ADMIN_SSL,
      serverName: config.ADMIN_DOMAIN,
      sslMode: "lan",
      staticRoot: `${currentDirFor(config.ADMIN_REMOTE_DIR, local(nodes.admin), nodes.admin)}/admin-front/dist`,
      ...adminUpstream,
    },
    {
      site: "merchant-public",
      role: "merchant",
      template: "nginx.merchant.ssl.conf.tpl",
      listenPort: config.MERCHANT_SSL ? config.MERCHANT_HTTPS_PORT : config.MERCHANT_HTTP_PORT,
      httpPort: config.MERCHANT_HTTP_PORT,
      httpsPort: config.MERCHANT_HTTPS_PORT,
      ssl: config.MERCHANT_SSL,
      serverName: config.MERCHANT_DOMAIN,
      sslMode: config.MERCHANT_SSL_MODE,
      certPath: config.MERCHANT_SSL_CERT_PATH ?? `/etc/letsencrypt/live/${config.MERCHANT_DOMAIN}/fullchain.pem`,
      keyPath: config.MERCHANT_SSL_KEY_PATH ?? `/etc/letsencrypt/live/${config.MERCHANT_DOMAIN}/privkey.pem`,
      staticRoot: `${currentDirFor(config.MERCHANT_REMOTE_DIR, local(nodes.merchant), nodes.merchant)}/merchant-front/dist`,
      ...merchantPublicUpstream,
    },
    {
      site: "checkout-public",
      role: "checkout",
      template: "nginx.checkout.ssl.conf.tpl",
      listenPort: config.CHECKOUT_SSL ? config.CHECKOUT_HTTPS_PORT : config.CHECKOUT_HTTP_PORT,
      httpPort: config.CHECKOUT_HTTP_PORT,
      httpsPort: config.CHECKOUT_HTTPS_PORT,
      ssl: config.CHECKOUT_SSL,
      serverName: config.CHECKOUT_DOMAIN,
      sslMode: config.CHECKOUT_SSL_MODE,
      certPath: config.CHECKOUT_SSL_CERT_PATH ?? `/etc/letsencrypt/live/${config.CHECKOUT_DOMAIN}/fullchain.pem`,
      keyPath: config.CHECKOUT_SSL_KEY_PATH ?? `/etc/letsencrypt/live/${config.CHECKOUT_DOMAIN}/privkey.pem`,
      staticRoot: `${currentDirFor(config.CHECKOUT_REMOTE_DIR, local(nodes.checkout), nodes.checkout)}/checkout-front/dist`,
      ...checkoutPublicUpstream,
    },
    ...(config.MERCHANT_LAN_PORT > 0
      ? [{
          site: "merchant-lan" as const,
          role: "merchant" as const,
          template: "nginx.merchant.lan.conf.tpl",
          listenPort: config.MERCHANT_LAN_PORT,
          httpPort: config.MERCHANT_LAN_PORT,
          httpsPort: config.MERCHANT_LAN_PORT,
          ssl: config.MERCHANT_LAN_SSL,
          serverName: privateIp ?? config.MERCHANT_PRIVATE_IP ?? "_",
          sslMode: "self_signed" as const,
          staticRoot: `${currentDirFor(config.MERCHANT_REMOTE_DIR, local(nodes.merchant), nodes.merchant)}/merchant-front/dist`,
          ...merchantLanUpstream,
        }]
      : []),
    ...(config.CHECKOUT_LAN_PORT > 0
      ? [{
          site: "checkout-lan" as const,
          role: "checkout" as const,
          template: "nginx.checkout.lan.conf.tpl",
          listenPort: config.CHECKOUT_LAN_PORT,
          httpPort: config.CHECKOUT_LAN_PORT,
          httpsPort: config.CHECKOUT_LAN_PORT,
          ssl: config.CHECKOUT_LAN_SSL,
          serverName: privateIp ?? config.CHECKOUT_PRIVATE_IP ?? "_",
          sslMode: "self_signed" as const,
          staticRoot: `${currentDirFor(config.CHECKOUT_REMOTE_DIR, local(nodes.checkout), nodes.checkout)}/checkout-front/dist`,
          ...checkoutLanUpstream,
        }]
      : []),
    ...(config.FAKE_RAILS_ENABLED
      ? [{
          site: "fake-rails" as const,
          role: "fake-rails" as const,
          template: "nginx.fakerails.conf.tpl",
          listenPort: config.FAKE_RAILS_NGINX_PORT,
          httpPort: config.FAKE_RAILS_NGINX_PORT,
          httpsPort: config.FAKE_RAILS_NGINX_PORT,
          ssl: config.FAKE_RAILS_SSL,
          serverName: config.FAKE_RAILS_DOMAIN,
          sslMode: config.FAKE_RAILS_SSL_MODE,
          certPath: `${config.FAKE_RAILS_REMOTE_DIR}/shared/certs/fake-rails.crt`,
          keyPath: `${config.FAKE_RAILS_REMOTE_DIR}/shared/certs/fake-rails.key`,
          staticRoot: `${config.FAKE_RAILS_REMOTE_DIR}/current/fake-rails-front/dist`,
          upstreamName: "pg_fake_rails_backend",
          upstreamServers: [`127.0.0.1:${fakeRailsPort}`],
        }]
      : []),
  ];
};
const buildCertBundles = (role: HostRole, config?: DeployConfig): CertBundle[] => {
  const storageCerts: CertBundle[] = config && storageEnabled(config) ? ["pg-client", "redis-client", "audit-db-client", "log-db-client"] : [];
  switch (role) {
    case "core":
      return ["core-server", ...storageCerts];
    case "admin":
      return ["admin-client"];
    case "merchant":
      return ["merchant-client"];
    case "checkout":
      return ["checkout-client"];
    case "fake-rails":
      return ["fake-rails-server"];
    case "backup":
      return ["backup-server", "pg-client"];
    case "pg-primary":
    case "pg-replica":
      return ["pg-client"];
    case "redis":
      return ["redis-client"];
    case "audit-db":
      return ["audit-db-client"];
    case "log-db":
      return ["log-db-client"];
    default:
      return [];
  }
};

const storageNode = (input: {
  config: DeployConfig;
  role: StorageRole;
  spec: NodeSpec;
  user: string;
  keyPath?: string;
  sudoPassword: string;
}): StorageNodePlan => {
  const ssh: SshTarget = {
    host: input.spec.sshHost,
    port: input.spec.sshPort,
    user: input.user,
    keyPath: input.keyPath ?? "",
    sudoPassword: input.sudoPassword,
  };
  return {
    role: input.role,
    nodeId: input.spec.nodeId,
    sshHost: input.spec.sshHost,
    sshPort: input.spec.sshPort,
    privateIp: input.spec.privateIp,
    servicePort: input.spec.servicePort,
    port: input.spec.servicePort,
    ssh,
    hostKey: sshKey(ssh),
  };
};

const parseSingleNode = (value: string, label: string): NodeSpec | null => {
  const nodes = parseNodeList(value);
  if (nodes.length > 1) throw new Error(`${label} must describe exactly one node`);
  return nodes[0] ?? null;
};

const buildStoragePlan = (config: DeployConfig): StoragePlan => {
  const primarySpec = parseSingleNode(config.PG_PRIMARY_NODE, "PG_PRIMARY_NODE");
  const replicaSpecs = parseNodeList(config.PG_REPLICA_NODES);
  const pgPrimary = primarySpec ? storageNode({ config, role: "pg-primary", spec: primarySpec, user: config.PG_SSH_USER, keyPath: config.PG_SSH_KEY_PATH, sudoPassword: config.PG_SUDO_PASSWORD }) : null;
  const pgReplicas = replicaSpecs.map((spec) => storageNode({ config, role: "pg-replica", spec, user: config.PG_SSH_USER, keyPath: config.PG_SSH_KEY_PATH, sudoPassword: config.PG_SUDO_PASSWORD }));
  const pgbouncer = config.PGBOUNCER_ENABLED
    ? [pgPrimary, ...pgReplicas].filter((node): node is StorageNodePlan => node !== null).map((node) => ({ ...node, role: "pgbouncer" as const }))
    : [];
  const redis = parseNodeList(config.REDIS_NODES).map((spec) => storageNode({ config, role: "redis", spec, user: config.REDIS_SSH_USER, keyPath: config.REDIS_SSH_KEY_PATH, sudoPassword: config.REDIS_SUDO_PASSWORD }));
  const auditSpec = parseSingleNode(config.AUDIT_DB_NODE, "AUDIT_DB_NODE");
  const logSpec = parseSingleNode(config.LOG_DB_NODE, "LOG_DB_NODE");
  const backupSpec = parseSingleNode(config.BACKUP_NODE, "BACKUP_NODE");
  const auditDb = auditSpec ? storageNode({ config, role: "audit-db", spec: auditSpec, user: config.AUDIT_DB_SSH_USER, keyPath: config.AUDIT_DB_SSH_KEY_PATH, sudoPassword: config.AUDIT_DB_SUDO_PASSWORD }) : null;
  const logDb = logSpec ? storageNode({ config, role: "log-db", spec: logSpec, user: config.LOG_DB_SSH_USER, keyPath: config.LOG_DB_SSH_KEY_PATH, sudoPassword: config.LOG_DB_SUDO_PASSWORD }) : null;
  const backup = backupSpec ? storageNode({ config, role: "backup", spec: backupSpec, user: config.BACKUP_SSH_USER, keyPath: config.BACKUP_SSH_KEY_PATH, sudoPassword: config.BACKUP_SUDO_PASSWORD }) : null;
  const nodes = [pgPrimary, ...pgReplicas, ...pgbouncer, ...redis, auditDb, logDb, backup].filter((node): node is StorageNodePlan => node !== null);
  return {
    nodes,
    postgres: { primary: pgPrimary, replicas: pgReplicas, pgbouncer, version: config.PG_VERSION },
    redis,
    auditDb,
    logDb,
    backup,
    "pg-primary": pgPrimary,
    "pg-replica": pgReplicas,
    pgbouncer,
    "audit-db": auditDb,
    "log-db": logDb,
  };
};

/**
 * The firewall rules of one compute role. The database only accepts the core
 * private IPs, the core only accepts the edge private IPs, and the edge
 * backends are bound to loopback.
 */
const buildComputeFirewall = (config: DeployConfig, role: HostRole, context: { sshPort: number; servicePort?: number; privateIp?: string }): FirewallRulePlan[] => {
  switch (role) {
    case "db":
      return [
        { port: context.sshPort, proto: "tcp", comment: "SSH" },
        {
          port: config.DB_PORT,
          proto: "tcp",
          fromCidrs: allCorePrivateIps(config),
          comment: "database only from the core hosts",
        },
      ];
    case "core":
      return [
        { port: context.sshPort, proto: "tcp", comment: "SSH" },
        {
          port: context.servicePort ?? config.CORE_PORT,
          proto: "tcp",
          fromCidrs: allEdgePrivateIps(config),
          comment: "mTLS core only from the edge hosts",
        },
      ];
    case "admin":
      return [
        { port: context.sshPort, proto: "tcp", comment: "SSH" },
        {
          port: config.ADMIN_NGINX_LAN_PORT,
          proto: "tcp",
          fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
          comment: "LAN-only admin portal",
        },
        {
          port: context.servicePort ?? config.ADMIN_BACK_PORT,
          proto: "tcp",
          fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
          comment: "admin-back from local/remote Nginx upstreams",
        },
      ];
    case "merchant":
      return [
        { port: context.sshPort, proto: "tcp", comment: "SSH" },
        { port: context.servicePort ?? config.MERCHANT_BACK_PORT, proto: "tcp", fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()), comment: "merchant-back from local/remote Nginx upstreams" },
        { port: config.MERCHANT_HTTP_PORT, proto: "tcp", comment: "public HTTP" },
        ...(config.MERCHANT_SSL
          ? [{ port: config.MERCHANT_HTTPS_PORT, proto: "tcp" as const, comment: "public HTTPS" }]
          : []),
        ...(config.MERCHANT_LAN_PORT > 0
          ? [{
              port: config.MERCHANT_LAN_PORT,
              proto: "tcp" as const,
              fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
              comment: "merchant portal on the LAN (no domain)",
            }]
          : []),
      ];
    case "fake-rails":
      return [
        { port: context.sshPort, proto: "tcp", comment: "SSH" },
        {
          port: config.FAKE_RAILS_NGINX_PORT,
          proto: "tcp",
          fromCidrs: [...new Set([
            ...config.FAKE_RAILS_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
            ...allCorePrivateIps(config),
            ...(config.CHECKOUT_PRIVATE_IP ? [config.CHECKOUT_PRIVATE_IP] : []),
          ])],
          comment: "Fake Rails portal + hosted pages + gateway APIs",
        },
      ];
    case "checkout":
      return [
        { port: context.sshPort, proto: "tcp", comment: "SSH" },
        { port: context.servicePort ?? config.CHECKOUT_BACK_PORT, proto: "tcp", fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()), comment: "checkout-back from local/remote Nginx upstreams" },
        { port: config.CHECKOUT_HTTP_PORT, proto: "tcp", comment: "public HTTP" },
        ...(config.CHECKOUT_SSL
          ? [{ port: config.CHECKOUT_HTTPS_PORT, proto: "tcp" as const, comment: "public HTTPS" }]
          : []),
        ...(config.CHECKOUT_LAN_PORT > 0
          ? [{
              port: config.CHECKOUT_LAN_PORT,
              proto: "tcp" as const,
              fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
              comment: "checkout portal on the LAN (no domain)",
            }]
          : []),
      ];
    default:
      return [];
  }
};

const buildStorageFirewall = (config: DeployConfig, node: StorageNodePlan, allStorage: StoragePlan): FirewallRulePlan[] => {
  const coreIps = allCorePrivateIps(config);
  const backupIp = allStorage.backup?.privateIp ?? backupPrivateIp(config);
  const pgIps = [allStorage.postgres.primary, ...allStorage.postgres.replicas]
    .filter((entry): entry is StorageNodePlan => entry !== null)
    .map((entry) => entry.privateIp);
  const replicaIps = allStorage.postgres.replicas.map((entry) => entry.privateIp);
  const pgPort = allStorage.postgres.primary?.servicePort ?? 5432;
  const sshRule: FirewallRulePlan = { port: node.sshPort, proto: "tcp", comment: "SSH" };
  switch (node.role) {
    case "pg-primary":
      return [
        sshRule,
        { port: pgPort, proto: "tcp", fromCidrs: [...new Set([...replicaIps, ...(backupIp ? [backupIp] : []), ...(config.PGBOUNCER_ENABLED ? [] : coreIps)])], comment: "PostgreSQL 18 primary <- replicas + backup/Barman/WAL streaming" },
        ...(config.PGBOUNCER_ENABLED ? [{ port: config.PGBOUNCER_PORT, proto: "tcp" as const, fromCidrs: coreIps, comment: "PgBouncer from core nodes" }] : []),
      ];
    case "pg-replica":
      return [
        sshRule,
        { port: pgPort, proto: "tcp", fromCidrs: [...new Set([...pgIps.filter((ip) => ip !== node.privateIp), ...(backupIp ? [backupIp] : []), ...(config.PGBOUNCER_ENABLED ? [] : coreIps)])], comment: "PostgreSQL 18 replica <- primary/replicas + backup/Barman/WAL streaming" },
        ...(config.PGBOUNCER_ENABLED ? [{ port: config.PGBOUNCER_PORT, proto: "tcp" as const, fromCidrs: coreIps, comment: "PgBouncer from core nodes" }] : []),
      ];
    case "pgbouncer":
      return [{ port: config.PGBOUNCER_PORT, proto: "tcp", fromCidrs: coreIps, comment: "PgBouncer from core nodes" }];
    case "redis":
      return [
        sshRule,
        { port: node.servicePort, proto: "tcp", fromCidrs: [...new Set([...coreIps, ...(backupIp ? [backupIp] : [])])], comment: "Redis from core + backup nodes" },
      ];
    case "audit-db":
      return [
        sshRule,
        { port: node.servicePort, proto: "tcp", fromCidrs: [...new Set([...coreIps, ...(backupIp ? [backupIp] : [])])], comment: "audit DB from core + backup nodes" },
      ];
    case "log-db":
      return [
        sshRule,
        { port: node.servicePort, proto: "tcp", fromCidrs: [...new Set([...coreIps, ...(backupIp ? [backupIp] : [])])], comment: "log DB from core + backup nodes" },
      ];
    case "backup":
      return [
        sshRule,
        { port: config.BACKUP_DAEMON_PORT, proto: "tcp", fromCidrs: coreIps, comment: "backup-daemon mTLS from core nodes" },
      ];
    default:
      return [sshRule];
  }
};

interface RoleTarget {
  role: HostRole;
  ssh: SshTarget;
  service?: ServicePlan;
  nginx?: NginxPlan[];
  certs?: CertBundle[];
  firewall: FirewallRulePlan[];
  nodeId?: string;
  privateIp?: string;
}

const legacyRoleTargets = (config: DeployConfig): RoleTarget[] => {
  const targets: RoleTarget[] = [];
  if (config.DB_MANAGE_VIA_SSH && !pgStorageConfigured(config) && config.DB_SSH_HOST && config.DB_SSH_KEY_PATH) {
    const ssh: SshTarget = { host: config.DB_SSH_HOST, port: config.DB_SSH_PORT, user: config.DB_SSH_USER, keyPath: config.DB_SSH_KEY_PATH, sudoPassword: config.DB_SUDO_PASSWORD };
    targets.push({ role: "db", ssh, firewall: buildComputeFirewall(config, "db", { sshPort: ssh.port }), certs: [] });
  }
  const fakeRailsSpec = fakeRailsNodeSpec(config);
  if (config.FAKE_RAILS_ENABLED && (fakeRailsSpec || (config.FAKE_RAILS_SSH_HOST && config.FAKE_RAILS_SSH_KEY_PATH))) {
    const ssh: SshTarget = {
      host: fakeRailsSpec?.sshHost ?? config.FAKE_RAILS_SSH_HOST!,
      port: fakeRailsSpec?.sshPort ?? config.FAKE_RAILS_SSH_PORT,
      user: config.FAKE_RAILS_SSH_USER,
      keyPath: config.FAKE_RAILS_SSH_KEY_PATH ?? "",
      sudoPassword: config.FAKE_RAILS_SUDO_PASSWORD,
    };
    targets.push({
      role: "fake-rails",
      ssh,
      service: buildFakeRailsService(config),
      nginx: buildNginx(config, undefined, {}, fakeRailsSpec).filter((site) => site.role === "fake-rails"),
      firewall: buildComputeFirewall(config, "fake-rails", { sshPort: ssh.port }),
      certs: buildCertBundles("fake-rails", config),
    });
  }
  return targets;
};

const storageTargets = (config: DeployConfig, storage: StoragePlan): RoleTarget[] => {
  const targets: RoleTarget[] = [];
  const managed: Array<[StorageNodePlan | null, boolean]> = [
    [storage.postgres.primary, config.PG_MANAGE_VIA_SSH],
    ...storage.postgres.replicas.map((node) => [node, config.PG_MANAGE_VIA_SSH] as [StorageNodePlan, boolean]),
    ...storage.pgbouncer.map((node) => [node, config.PG_MANAGE_VIA_SSH] as [StorageNodePlan, boolean]),
    ...storage.redis.map((node) => [node, config.REDIS_MANAGE_VIA_SSH] as [StorageNodePlan, boolean]),
    [storage.auditDb, config.AUDIT_DB_MANAGE_VIA_SSH],
    [storage.logDb, config.LOG_DB_MANAGE_VIA_SSH],
    [storage.backup, config.BACKUP_ENABLED],
  ];
  const seen = new Set<string>();
  for (const [node, enabled] of managed) {
    if (!node || !enabled) continue;
    const targetKey = `${node.role}:${node.hostKey}`;
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    targets.push({
      role: node.role,
      ssh: node.ssh,
      firewall: buildStorageFirewall(config, node, storage),
      certs: buildCertBundles(node.role, config),
      nodeId: node.nodeId,
      privateIp: node.privateIp,
    });
  }
  return targets;
};

const allTargets = (config: DeployConfig): RoleTarget[] => {
  const nodes = buildComputeNodes(config);
  const storage = buildStoragePlan(config);
  const targets: RoleTarget[] = [];
  for (const tier of tierDefinitions(config)) {
    for (const node of nodes[tier.role]) {
      targets.push({
        role: tier.role,
        ssh: node.ssh,
        service: buildService(config, node, tier),
        nginx: buildNginx(config, node.privateIp, nodes, fakeRailsNodeSpec(config)).filter((site) => site.role === tier.role),
        firewall: buildComputeFirewall(config, tier.role, { sshPort: node.ssh.port, servicePort: node.port, privateIp: node.privateIp }),
        certs: buildCertBundles(tier.role, config),
        nodeId: node.nodeId,
        privateIp: node.privateIp,
      });
    }
  }
  targets.push(...legacyRoleTargets(config));
  targets.push(...storageTargets(config, storage));
  return targets;
};

/**
 * Every role that shares an SSH endpoint must also share the same key and sudo
 * password. Two roles on one machine with different keys is a configuration
 * mistake, not a topology.
 */
export const findSshConflicts = (config: DeployConfig): string[] => {
  const groups = new Map<string, RoleTarget[]>();
  for (const target of allTargets(config)) {
    const key = sshKey(target.ssh);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const conflicts: string[] = [];
  for (const [key, members] of groups) {
    const keys = new Set(members.map((member) => member.ssh.keyPath).filter((entry) => entry.length > 0));
    const users = new Set(members.map((member) => member.ssh.user));
    if (keys.size > 1) {
      conflicts.push(`${key} is shared by ${members.map((m) => m.role).join(", ")} but uses more than one SSH key`);
    }
    if (users.size > 1) {
      conflicts.push(`${key} is shared by ${members.map((m) => m.role).join(", ")} but uses more than one SSH user`);
    }
  }
  return conflicts;
};

export const planHosts = (config: DeployConfig): DeployPlan => {
  const conflicts = findSshConflicts(config);
  if (conflicts.length > 0) {
    throw new Error(`Invalid host topology:\n- ${conflicts.join("\n- ")}`);
  }

  const computeNodes = buildComputeNodes(config);
  const storage = buildStoragePlan(config);
  const targets = allTargets(config);
  const groups = new Map<string, HostPlan>();

  for (const target of targets) {
    const key = sshKey(target.ssh);
    const existing = groups.get(key);
    const services = target.service ? [target.service] : [];
    const nginx = target.nginx ?? [];
    const certs = target.certs ?? [];
    if (existing) {
      if (!existing.roles.includes(target.role)) existing.roles.push(target.role);
      existing.certs = [...new Set([...existing.certs, ...certs])];
      existing.firewall = mergeFirewall(existing.firewall, target.firewall);
      existing.services = [...existing.services, ...services.filter((service) => !existing.services.some((candidate) => candidate.name === service.name))];
      existing.nginx = [...existing.nginx, ...nginx.filter((site) => !existing.nginx.some((candidate) => candidate.site === site.site))];
      existing.deployOrder = Math.min(existing.deployOrder, ROLE_ORDER[target.role]);
      continue;
    }
    groups.set(key, {
      key,
      displayName: `${target.ssh.user}@${target.ssh.host} (${ROLE_LABEL[target.role]})`,
      ssh: target.ssh,
      roles: [target.role],
      services,
      nginx,
      certs,
      firewall: target.firewall,
      keepReleases: config.KEEP_RELEASES,
      deployOrder: ROLE_ORDER[target.role],
    });
  }

  const hosts = [...groups.values()]
    .map((host) => ({ ...host, displayName: `${host.ssh.user}@${host.ssh.host} (${host.roles.map((role) => ROLE_LABEL[role]).join(" + ")})` }))
    .sort((left, right) => left.deployOrder - right.deployOrder || left.key.localeCompare(right.key));

  const roles = {} as Record<DeployRole, string>;
  for (const host of hosts) {
    for (const role of host.roles) {
      if (role === "pg-primary" || role === "pg-replica" || role === "pgbouncer" || role === "redis" || role === "audit-db" || role === "log-db" || role === "backup") continue;
      if (!roles[role]) roles[role] = host.ssh.host;
    }
  }

  const topology: DeployPlan["topology"] = hosts.length === 1
    ? "single-host"
    : hosts.length === 2
      ? "split"
      : "distributed";

  const database = effectiveDatabase(config);
  const backupIp = backupPrivateIp(config);
  return {
    topology,
    hosts,
    roles,
    database: {
      engine: database.engine,
      host: database.host ?? database.privateIp ?? config.CORE_SSH_HOST ?? "",
      port: database.port,
      name: database.name,
      user: database.user,
      privateIp: database.privateIp,
      managedViaSsh: database.managedViaSsh,
    },
    nodes: {
      core: computeNodes.core,
      admin: computeNodes.admin,
      merchant: computeNodes.merchant,
      checkout: computeNodes.checkout,
    },
    storage,
    replicas: storage.postgres.replicas,
    backup: {
      enabled: config.BACKUP_ENABLED,
      node: storage.backup,
      engineMode: config.BACKUP_ENGINE_MODE,
      daemonPort: config.BACKUP_DAEMON_PORT,
      s3Bucket: config.BACKUP_PRIMARY_S3_BUCKET,
      secondaryTarget: config.BACKUP_SECONDARY_SSH_TARGET,
    },
  };
};

/** Union two rule lists; the same port from more sources widens the allowlist a rule needs. */
const mergeFirewall = (left: FirewallRulePlan[], right: FirewallRulePlan[]): FirewallRulePlan[] => {
  const merged = [...left];
  for (const rule of right) {
    const existing = merged.find((candidate) => candidate.port === rule.port && candidate.proto === rule.proto);
    if (!existing) {
      merged.push(rule);
      continue;
    }
    if (!existing.fromCidrs || !rule.fromCidrs) {
      // An unrestricted rule wins over a restricted one.
      delete existing.fromCidrs;
      continue;
    }
    existing.fromCidrs = [...new Set([...existing.fromCidrs, ...rule.fromCidrs])];
    existing.comment = `${existing.comment}; ${rule.comment}`;
  }
  return merged;
};

/** A human readable topology map for step 1 of the deploy. */
export const renderTopology = (plan: DeployPlan): string => {
  const lines = [`Topology: ${plan.topology} (${plan.hosts.length} host${plan.hosts.length === 1 ? "" : "s"})`, ""];
  for (const host of plan.hosts) {
    lines.push(`  ${host.ssh.user}@${host.ssh.host}:${host.ssh.port}  [${host.roles.join(", ")}]`);
    for (const service of host.services) {
      lines.push(`    - pm2 ${service.name} :${service.port}  (${service.sourceDir} -> ${service.remoteDir})`);
    }
    for (const site of host.nginx) {
      lines.push(`    - nginx ${site.site} :${site.listenPort}  ${site.serverName}`);
    }
    if (host.certs.length > 0) {
      lines.push(`    - certs ${host.certs.join(", ")}`);
    }
    lines.push(`    - ufw ${host.firewall.map((rule) => (rule.fromCidrs ? `${rule.port}<=${rule.fromCidrs.join("|")}` : String(rule.port))).join(" ")}`);
  }
  for (const node of plan.storage.nodes) {
    lines.push(`  storage ${node.role}: ${node.nodeId}@${node.privateIp}:${node.port}`);
  }
  return lines.join("\n");
};

export type { NodeSpec };
