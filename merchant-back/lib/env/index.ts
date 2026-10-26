import z from "zod";

const httpsUrl = z.string().refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { error: "must be an absolute https URL" },
);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4102),
  CORE_BACK_URL: httpsUrl,
  MTLS_CLIENT_CERT_PATH: z.string().min(1),
  MTLS_CLIENT_KEY_PATH: z.string().min(1),
  MTLS_CA_CERT_PATH: z.string().min(1),
  CORE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).max(10485760).default(2097152),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(26214400).default(10485760),
  UPLOAD_ALLOWED_MIME: z
    .string()
    .default("image/png,image/jpeg,application/pdf"),
  PG_LIVE_TOKEN_PREFIX: z.string().min(4).max(32).default("pg_live_"),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  EXTERNAL_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  EXTERNAL_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  POS_STREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3600000).default(900000),
});

export type EdgeEnv = z.infer<typeof envSchema>;

const readEnv = (): EdgeEnv => {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Invalid environment configuration:",
      JSON.stringify(result.error.issues, null, 2),
    );
    process.exit(1);
  }
  return result.data;
};

let cached: EdgeEnv | undefined;

export const loadEnv = (): EdgeEnv => {
  cached ??= readEnv();
  return cached;
};

/**
 * Drops the cached environment snapshot. Used by the test suites, which boot
 * several service instances with a different configuration inside one process.
 */
export const resetEnvCache = (): void => {
  cached = undefined;
};

export const env: EdgeEnv = new Proxy({} as EdgeEnv, {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    return loadEnv()[property as keyof EdgeEnv];
  },
  has(_target, property) {
    return property in loadEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(loadEnv());
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(loadEnv(), property);
  },
});
