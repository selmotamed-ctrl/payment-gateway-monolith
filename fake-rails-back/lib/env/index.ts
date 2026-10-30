import { z } from "zod";

/**
 * Startup configuration of the standalone Fake Payment Rails service.
 *
 * The service is intentionally independent from `core-back`: it reads its own
 * `.env`, owns its own SQLite store, and never touches the gateway database.
 *
 * Three non-negotiable guards are enforced here before the HTTP listener is
 * created:
 *
 *  1. production opt-in: running with `NODE_ENV=production` requires
 *     `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`;
 *  2. the single tester credential pair must be strong and non-default;
 *  3. the seeder token and the JWT secret must be non-trivial.
 */

const booleanish = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return value;
}, z.boolean());

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4104),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  FAKE_RAILS_ENABLED: booleanish.default(true),
  FAKE_RAILS_ALLOW_IN_PRODUCTION: booleanish.default(false),
  FAKE_RAILS_PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8444"),
  FAKE_RAILS_DATA_DIR: z.string().min(1).default("shared/data"),
  CORE_INBOUND_BASE_URL: z.string().url().default("http://127.0.0.1:4103/api/v1/inbound"),

  FAKE_RAILS_ADMIN_USER: z.string().min(4).max(128),
  FAKE_RAILS_ADMIN_PASSWORD: z.string().min(12).max(512),
  FAKE_RAILS_JWT_SECRET: z.string().min(16).max(512),
  FAKE_RAILS_SEEDER_TOKEN: z.string().min(16).max(512),

  FAKE_RAILS_ALLOWED_CIDRS: z.string().default("127.0.0.1/32,10.0.0.0/8,192.168.0.0/16"),
  FAKE_RAILS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  FAKE_RAILS_MAX_BODY_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  FAKE_RAILS_PORTAL_RATE_LIMIT: z.coerce.number().int().positive().max(1000).default(10),
  FAKE_RAILS_PORTAL_RATE_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
});

export type FakeRailsEnv = z.infer<typeof envSchema>;

const DEFAULT_PASSWORDS = new Set([
  "ChangeMe-Strong-Tester-Pass-2026!",
  "changeme",
  "password",
  "tester_admin",
]);

const parse = (): FakeRailsEnv => {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    process.stderr.write(`Invalid fake-rails-back environment:\n- ${issues.join("\n- ")}\n`);
    process.exit(1);
  }
  const value = result.data;

  if (value.NODE_ENV === "production" && value.FAKE_RAILS_ALLOW_IN_PRODUCTION !== true) {
    process.stderr.write(
      'FAKE_RAILS_PRODUCTION_GUARD_BLOCKED: Set FAKE_RAILS_ALLOW_IN_PRODUCTION="true" to run Fake Rails in production mode\n',
    );
    process.exit(1);
  }
  if (!value.FAKE_RAILS_ENABLED) {
    process.stderr.write("FAKE_RAILS_DISABLED: FAKE_RAILS_ENABLED must be 'true' to start the service\n");
    process.exit(1);
  }
  if (DEFAULT_PASSWORDS.has(value.FAKE_RAILS_ADMIN_PASSWORD)) {
    process.stderr.write("FAKE_RAILS_WEAK_CREDENTIALS: FAKE_RAILS_ADMIN_PASSWORD must not be a default value\n");
    process.exit(1);
  }
  if (value.FAKE_RAILS_ADMIN_USER === value.FAKE_RAILS_ADMIN_PASSWORD) {
    process.stderr.write("FAKE_RAILS_WEAK_CREDENTIALS: the tester username and password must differ\n");
    process.exit(1);
  }
  return value;
};

let cached: FakeRailsEnv | undefined;

export const loadEnv = (): FakeRailsEnv => {
  if (!cached) {
    cached = parse();
  }
  return cached;
};

export const resetEnvForTests = (): void => {
  cached = undefined;
};

export const env: FakeRailsEnv = new Proxy({} as FakeRailsEnv, {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    return loadEnv()[property as keyof FakeRailsEnv];
  },
  has(_target, property) {
    if (typeof property === "symbol") return false;
    return property in loadEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(loadEnv());
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(loadEnv(), property);
  },
});
