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

export const DEPLOY_MODES = ["auto", "fresh", "update"] as const;
export const DB_ENGINES = ["mysql", "postgresql"] as const;
export const SSL_MODES = ["certbot", "custom", "self_signed"] as const;
export const ROLE_NAMES = ["db", "core", "admin", "merchant", "checkout", "fake-rails"] as const;
export type DeployRole = (typeof ROLE_NAMES)[number];

const base = z.strictObject({
  // 0. Global
  DEPLOY_MODE: z.enum(DEPLOY_MODES).default("auto"),
  DEPLOY_ENV: z.enum(["development", "staging", "production"]).default("development"),
  KEEP_RELEASES: z.coerce.number().int().min(1).max(100).default(5),
  ROTATE_MTLS_CERTS: booleanish.default(false),
  MTLS_VALIDITY_DAYS: z.coerce.number().int().min(1).max(3650).default(825),
  LAN_ALLOWED_CIDRS: cidrList.default("127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),

  // 1. Database
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
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier"),
  DB_USER: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, "must be an identifier"),
  DB_PASSWORD: z.string().min(8).max(256),
  DATABASE_URL: z.string().trim().min(1).max(1000),

  // 2. Core
  CORE_SSH_HOST: ipv4,
  CORE_SSH_PORT: port.default(22),
  CORE_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  CORE_SSH_KEY_PATH: sshPath,
  CORE_SUDO_PASSWORD: z.string().max(256).default(""),
  CORE_PRIVATE_IP: ipv4,
  CORE_PORT: port.default(4000),
  CORE_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-core"),
  RUN_PRISMA_SEED: booleanish.default(false),

  // 3. Admin
  ADMIN_SSH_HOST: ipv4,
  ADMIN_SSH_PORT: port.default(22),
  ADMIN_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  ADMIN_SSH_KEY_PATH: sshPath,
  ADMIN_SUDO_PASSWORD: z.string().max(256).default(""),
  ADMIN_PRIVATE_IP: ipv4,
  ADMIN_BACK_PORT: port.default(4101),
  ADMIN_NGINX_LAN_PORT: port.default(8443),
  ADMIN_SSL: booleanish.default(true),
  ADMIN_DOMAIN: serverName.default("admin.internal"),
  ADMIN_REMOTE_DIR: z.string().trim().min(1).max(200).default("/var/www/pg-admin"),

  // 4. Merchant
  MERCHANT_SSH_HOST: ipv4,
  MERCHANT_SSH_PORT: port.default(22),
  MERCHANT_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  MERCHANT_SSH_KEY_PATH: sshPath,
  MERCHANT_SUDO_PASSWORD: z.string().max(256).default(""),
  MERCHANT_PRIVATE_IP: ipv4,
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
  CHECKOUT_SSH_HOST: ipv4,
  CHECKOUT_SSH_PORT: port.default(22),
  CHECKOUT_SSH_USER: z.string().trim().min(1).max(64).default("ubuntu"),
  CHECKOUT_SSH_KEY_PATH: sshPath,
  CHECKOUT_SUDO_PASSWORD: z.string().max(256).default(""),
  CHECKOUT_PRIVATE_IP: ipv4,
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

  // 8. Synthetic operational data seeder (test servers with Fake Rails only)
  RUN_SYNTHETIC_HISTORY_SEED: booleanish.default(false),
  SYNTHETIC_SEED_PROFILE: z.enum(["COMPACT", "STANDARD", "STRESS"]).default("COMPACT"),
  SYNTHETIC_SEED_KEY: z.string().trim().min(1).max(200).default("libya-pg-2023-2026"),
  SYNTHETIC_YEARS_SPAN: z.coerce.number().min(0.5).max(10).default(3.5),
});

export type DeployConfig = z.infer<typeof base>;

/**
 * Cross-field rules. A value can be valid in isolation and still make the
 * topology impossible (the database URL not matching the engine, a certbot
 * domain with no certificate path, a database host with no SSH target, …).
 */
export const validateDeployConfig = (config: DeployConfig): string[] => {
  const problems: string[] = [];

  if (config.DB_MANAGE_VIA_SSH) {
    if (!config.DB_SSH_HOST) problems.push("DB_SSH_HOST is required when DB_MANAGE_VIA_SSH=true");
    if (!config.DB_SSH_KEY_PATH) problems.push("DB_SSH_KEY_PATH is required when DB_MANAGE_VIA_SSH=true");
    if (!config.DB_PRIVATE_IP) problems.push("DB_PRIVATE_IP is required when DB_MANAGE_VIA_SSH=true");
  }

  const enginePrefix = config.DB_ENGINE === "mysql" ? "mysql://" : "postgresql://";
  if (!config.DATABASE_URL.startsWith(enginePrefix)) {
    problems.push(`DATABASE_URL must start with ${enginePrefix} (DB_ENGINE=${config.DB_ENGINE})`);
  }
  if (config.DB_PRIVATE_IP && !config.DATABASE_URL.includes(config.DB_PRIVATE_IP)) {
    problems.push("DATABASE_URL should point at DB_PRIVATE_IP");
  }
  // A single-box installation legitimately co-locates the database with the
  // core (the database binds to 127.0.0.1 and is never exposed); on separate
  // nodes the operator points DATABASE_URL at the database host's private IP.

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
