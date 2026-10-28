import type { DeployConfig, DeployRole } from "./configSchema";

/**
 * Turns the logical 5-role topology into the concrete per-host plan.
 *
 * The same script must deploy a single all-in-one staging box, a 2-host
 * internal/public split, and 5 separate production servers. The whole trick is
 * grouping the roles by their SSH endpoint: two roles that share an SSH host
 * are the same machine, so its OS is bootstrapped once, its PM2 process list
 * and its Nginx vhosts are merged, and its firewall rules are unioned.
 */

export type ServiceName = "pg-core-back" | "pg-admin-back" | "pg-merchant-back" | "pg-checkout-back";
export type NginxSiteName = "admin-lan" | "merchant-public" | "checkout-public" | "merchant-lan" | "checkout-lan";
export type CertBundle = "core-server" | "admin-client" | "merchant-client" | "checkout-client";

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
}

export interface NginxPlan {
  site: NginxSiteName;
  role: DeployRole;
  template: string;
  listenPort: number;
  serverName: string;
  sslMode: "lan" | "certbot" | "custom" | "self_signed";
  certPath?: string;
  keyPath?: string;
  staticRoot: string;
}

export interface FirewallRulePlan {
  port: number;
  proto: "tcp";
  /** When set, the port is only reachable from these sources. */
  fromCidrs?: string[];
  comment: string;
}

export interface HostPlan {
  /** `${host}:${port}` — the dedup key. */
  key: string;
  displayName: string;
  ssh: SshTarget;
  roles: DeployRole[];
  services: ServicePlan[];
  nginx: NginxPlan[];
  certs: CertBundle[];
  firewall: FirewallRulePlan[];
  /** How many Git releases to keep on this host. */
  keepReleases: number;
  /** The order in which this host must be deployed (the lowest role order). */
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
}

const ROLE_ORDER: Record<DeployRole, number> = {
  db: 1,
  core: 2,
  admin: 3,
  merchant: 4,
  checkout: 5,
};

const ROLE_LABEL: Record<DeployRole, string> = {
  db: "database",
  core: "core-back",
  admin: "admin-back + admin-front",
  merchant: "merchant-back + merchant-front",
  checkout: "checkout-back + checkout-front",
};

const sshKey = (ssh: { host: string; port: number }): string => `${ssh.host}:${ssh.port}`;

const coreEnv = (config: DeployConfig): Record<string, string> => ({
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: String(config.CORE_PORT),
  DATABASE_URL: config.DATABASE_URL,
  MTLS_CA_CERT_PATH: "shared/certs/internal-ca.crt",
  MTLS_SERVER_CERT_PATH: "shared/certs/core-back.crt",
  MTLS_SERVER_KEY_PATH: "shared/certs/core-back.key",
  KMS_MASTER_KEY: config.KMS_MASTER_KEY,
  TRUST_PROXY: "false",
  LOG_LEVEL: "info",
  WORKER_ENABLED: "true",
  ...(config.REDIS_URL ? { REDIS_URL: config.REDIS_URL } : {}),
});

/**
 * The edge servers never receive a database credential. Their `.env` contains
 * only the core URL, their own client certificate and the LAN CIDRs.
 */
const edgeEnv = (
  config: DeployConfig,
  role: Exclude<DeployRole, "db" | "core">,
): Record<string, string> => {
  const base: Record<string, string> = {
    NODE_ENV: "production",
    CORE_BACK_URL: `https://${config.CORE_PRIVATE_IP}:${config.CORE_PORT}`,
    MTLS_CA_CERT_PATH: "shared/certs/internal-ca.crt",
    MTLS_CLIENT_CERT_PATH: `shared/certs/${role}-back-client.crt`,
    MTLS_CLIENT_KEY_PATH: `shared/certs/${role}-back-client.key`,
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
  };
  switch (role) {
    case "admin":
      return {
        ...base,
        PORT: String(config.ADMIN_BACK_PORT),
        ADMIN_BIND_HOST: "127.0.0.1",
        ADMIN_LAN_CIDRS: config.LAN_ALLOWED_CIDRS,
      };
    case "merchant":
      return {
        ...base,
        PORT: String(config.MERCHANT_BACK_PORT),
        BIND_HOST: "127.0.0.1",
        PG_LIVE_TOKEN_PREFIX: "pg_live_",
      };
    case "checkout":
      return {
        ...base,
        PORT: String(config.CHECKOUT_BACK_PORT),
        BIND_HOST: "127.0.0.1",
        CHECKOUT_FRONT_BASE_URL: `https://${config.CHECKOUT_DOMAIN}`,
        CHECKOUT_FRONT_STATUS_PATH: "/pay/status",
      };
    default:
      return base;
  }
};

const buildServices = (config: DeployConfig): ServicePlan[] => [
  {
    name: "pg-core-back",
    role: "core",
    sourceDir: "core-back",
    remoteDir: config.CORE_REMOTE_DIR,
    port: config.CORE_PORT,
    env: coreEnv(config),
  },
  {
    name: "pg-admin-back",
    role: "admin",
    sourceDir: "admin-back",
    remoteDir: config.ADMIN_REMOTE_DIR,
    port: config.ADMIN_BACK_PORT,
    env: edgeEnv(config, "admin"),
  },
  {
    name: "pg-merchant-back",
    role: "merchant",
    sourceDir: "merchant-back",
    remoteDir: config.MERCHANT_REMOTE_DIR,
    port: config.MERCHANT_BACK_PORT,
    env: edgeEnv(config, "merchant"),
  },
  {
    name: "pg-checkout-back",
    role: "checkout",
    sourceDir: "checkout-back",
    remoteDir: config.CHECKOUT_REMOTE_DIR,
    port: config.CHECKOUT_BACK_PORT,
    env: edgeEnv(config, "checkout"),
  },
];

const buildNginx = (config: DeployConfig): NginxPlan[] => [
  {
    site: "admin-lan",
    role: "admin",
    template: "nginx.admin.lan.conf.tpl",
    listenPort: config.ADMIN_NGINX_LAN_PORT,
    serverName: config.ADMIN_DOMAIN,
    sslMode: "lan",
    staticRoot: `${config.ADMIN_REMOTE_DIR}/current/admin-front/dist`,
  },
  {
    site: "merchant-public",
    role: "merchant",
    template: "nginx.merchant.ssl.conf.tpl",
    listenPort: 443,
    serverName: config.MERCHANT_DOMAIN,
    sslMode: config.MERCHANT_SSL_MODE,
    certPath: config.MERCHANT_SSL_CERT_PATH ?? `/etc/letsencrypt/live/${config.MERCHANT_DOMAIN}/fullchain.pem`,
    keyPath: config.MERCHANT_SSL_KEY_PATH ?? `/etc/letsencrypt/live/${config.MERCHANT_DOMAIN}/privkey.pem`,
    staticRoot: `${config.MERCHANT_REMOTE_DIR}/current/merchant-front/dist`,
  },
  {
    site: "checkout-public",
    role: "checkout",
    template: "nginx.checkout.ssl.conf.tpl",
    listenPort: 443,
    serverName: config.CHECKOUT_DOMAIN,
    sslMode: config.CHECKOUT_SSL_MODE,
    certPath: config.CHECKOUT_SSL_CERT_PATH ?? `/etc/letsencrypt/live/${config.CHECKOUT_DOMAIN}/fullchain.pem`,
    keyPath: config.CHECKOUT_SSL_KEY_PATH ?? `/etc/letsencrypt/live/${config.CHECKOUT_DOMAIN}/privkey.pem`,
    staticRoot: `${config.CHECKOUT_REMOTE_DIR}/current/checkout-front/dist`,
  },
  ...(config.MERCHANT_LAN_PORT > 0
    ? [{
        site: "merchant-lan" as const,
        role: "merchant" as const,
        template: "nginx.merchant.lan.conf.tpl",
        listenPort: config.MERCHANT_LAN_PORT,
        serverName: config.MERCHANT_PRIVATE_IP,
        sslMode: "self_signed" as const,
        staticRoot: `${config.MERCHANT_REMOTE_DIR}/current/merchant-front/dist`,
      }]
    : []),
  ...(config.CHECKOUT_LAN_PORT > 0
    ? [{
        site: "checkout-lan" as const,
        role: "checkout" as const,
        template: "nginx.checkout.lan.conf.tpl",
        listenPort: config.CHECKOUT_LAN_PORT,
        serverName: config.CHECKOUT_PRIVATE_IP,
        sslMode: "self_signed" as const,
        staticRoot: `${config.CHECKOUT_REMOTE_DIR}/current/checkout-front/dist`,
      }]
    : []),
];

const buildCertBundles = (role: DeployRole): CertBundle[] => {
  switch (role) {
    case "core":
      return ["core-server"];
    case "admin":
      return ["admin-client"];
    case "merchant":
      return ["merchant-client"];
    case "checkout":
      return ["checkout-client"];
    default:
      return [];
  }
};

/**
 * The firewall rules of one role. They mirror the design's table: the database
 * only accepts the core private IP, the core only accepts the three edge
 * private IPs, and the edge backends are bound to loopback so they are not
 * exposed at all.
 */
const buildRoleFirewall = (config: DeployConfig, role: DeployRole): FirewallRulePlan[] => {
  switch (role) {
    case "db":
      return [
        { port: config.DB_SSH_PORT, proto: "tcp", comment: "SSH" },
        {
          port: config.DB_PORT,
          proto: "tcp",
          fromCidrs: [config.CORE_PRIVATE_IP],
          comment: "database only from the core host",
        },
      ];
    case "core":
      return [
        { port: config.CORE_SSH_PORT, proto: "tcp", comment: "SSH" },
        {
          port: config.CORE_PORT,
          proto: "tcp",
          fromCidrs: [config.ADMIN_PRIVATE_IP, config.MERCHANT_PRIVATE_IP, config.CHECKOUT_PRIVATE_IP],
          comment: "mTLS core only from the three edge hosts",
        },
      ];
    case "admin":
      return [
        { port: config.ADMIN_SSH_PORT, proto: "tcp", comment: "SSH" },
        {
          port: config.ADMIN_NGINX_LAN_PORT,
          proto: "tcp",
          fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
          comment: "LAN-only admin portal",
        },
      ];
    case "merchant":
      return [
        { port: config.MERCHANT_SSH_PORT, proto: "tcp", comment: "SSH" },
        { port: 80, proto: "tcp", comment: "public HTTP (redirect)" },
        { port: 443, proto: "tcp", comment: "public HTTPS" },
        ...(config.MERCHANT_LAN_PORT > 0
          ? [{
              port: config.MERCHANT_LAN_PORT,
              proto: "tcp" as const,
              fromCidrs: config.LAN_ALLOWED_CIDRS.split(",").map((entry) => entry.trim()),
              comment: "merchant portal on the LAN (no domain)",
            }]
          : []),
      ];
    case "checkout":
      return [
        { port: config.CHECKOUT_SSH_PORT, proto: "tcp", comment: "SSH" },
        { port: 80, proto: "tcp", comment: "public HTTP (redirect)" },
        { port: 443, proto: "tcp", comment: "public HTTPS" },
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

interface RoleSsh {
  role: DeployRole;
  ssh: SshTarget;
}

const roleSshTargets = (config: DeployConfig): RoleSsh[] => {
  const targets: RoleSsh[] = [];
  if (config.DB_MANAGE_VIA_SSH && config.DB_SSH_HOST && config.DB_SSH_KEY_PATH) {
    targets.push({
      role: "db",
      ssh: {
        host: config.DB_SSH_HOST,
        port: config.DB_SSH_PORT,
        user: config.DB_SSH_USER,
        keyPath: config.DB_SSH_KEY_PATH,
        sudoPassword: config.DB_SUDO_PASSWORD,
      },
    });
  }
  targets.push(
    {
      role: "core",
      ssh: {
        host: config.CORE_SSH_HOST,
        port: config.CORE_SSH_PORT,
        user: config.CORE_SSH_USER,
        keyPath: config.CORE_SSH_KEY_PATH,
        sudoPassword: config.CORE_SUDO_PASSWORD,
      },
    },
    {
      role: "admin",
      ssh: {
        host: config.ADMIN_SSH_HOST,
        port: config.ADMIN_SSH_PORT,
        user: config.ADMIN_SSH_USER,
        keyPath: config.ADMIN_SSH_KEY_PATH,
        sudoPassword: config.ADMIN_SUDO_PASSWORD,
      },
    },
    {
      role: "merchant",
      ssh: {
        host: config.MERCHANT_SSH_HOST,
        port: config.MERCHANT_SSH_PORT,
        user: config.MERCHANT_SSH_USER,
        keyPath: config.MERCHANT_SSH_KEY_PATH,
        sudoPassword: config.MERCHANT_SUDO_PASSWORD,
      },
    },
    {
      role: "checkout",
      ssh: {
        host: config.CHECKOUT_SSH_HOST,
        port: config.CHECKOUT_SSH_PORT,
        user: config.CHECKOUT_SSH_USER,
        keyPath: config.CHECKOUT_SSH_KEY_PATH,
        sudoPassword: config.CHECKOUT_SUDO_PASSWORD,
      },
    },
  );
  return targets;
};

/**
 * Every role that shares an SSH endpoint must also share the same key and sudo
 * password. Two roles on one machine with different keys is a configuration
 * mistake, not a topology.
 */
export const findSshConflicts = (config: DeployConfig): string[] => {
  const groups = new Map<string, RoleSsh[]>();
  for (const target of roleSshTargets(config)) {
    const key = sshKey(target.ssh);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const conflicts: string[] = [];
  for (const [key, members] of groups) {
    const keys = new Set(members.map((member) => member.ssh.keyPath));
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

  const services = buildServices(config);
  const nginx = buildNginx(config);
  const groups = new Map<string, HostPlan>();

  for (const target of roleSshTargets(config)) {
    const key = sshKey(target.ssh);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.roles.includes(target.role)) {
        existing.roles.push(target.role);
      }
      existing.certs = [...new Set([...existing.certs, ...buildCertBundles(target.role)])];
      existing.firewall = mergeFirewall(existing.firewall, buildRoleFirewall(config, target.role));
      existing.services = [...existing.services, ...services.filter((service) => service.role === target.role)];
      existing.nginx = [...existing.nginx, ...nginx.filter((site) => site.role === target.role)];
      existing.deployOrder = Math.min(existing.deployOrder, ROLE_ORDER[target.role]);
      continue;
    }
    groups.set(key, {
      key,
      displayName: `${target.ssh.user}@${target.ssh.host} (${ROLE_LABEL[target.role]})`,
      ssh: target.ssh,
      roles: [target.role],
      services: services.filter((service) => service.role === target.role),
      nginx: nginx.filter((site) => site.role === target.role),
      certs: buildCertBundles(target.role),
      firewall: buildRoleFirewall(config, target.role),
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
      roles[role] = host.ssh.host;
    }
  }

  const topology: DeployPlan["topology"] = hosts.length === 1
    ? "single-host"
    : hosts.length === 2
      ? "split"
      : "distributed";

  return {
    topology,
    hosts,
    roles,
    database: {
      engine: config.DB_ENGINE,
      host: config.DB_PRIVATE_IP ?? config.CORE_SSH_HOST,
      port: config.DB_PORT,
      name: config.DB_NAME,
      user: config.DB_USER,
      privateIp: config.DB_PRIVATE_IP ?? null,
      managedViaSsh: config.DB_MANAGE_VIA_SSH,
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
  return lines.join("\n");
};
