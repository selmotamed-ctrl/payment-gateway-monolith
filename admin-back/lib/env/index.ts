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
  PORT: z.coerce.number().int().min(1).max(65535).default(4101),
  ADMIN_BIND_HOST: z.string().min(1).max(64).default("127.0.0.1"),
  CORE_BACK_URL: httpsUrl,
  MTLS_CLIENT_CERT_PATH: z.string().min(1),
  MTLS_CLIENT_KEY_PATH: z.string().min(1),
  MTLS_CA_CERT_PATH: z.string().min(1),
  CORE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  ADMIN_LAN_CIDRS: z
    .string()
    .default("127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  // Accepted authority hints for the confidential admin routes. Core issues the role name
  // (`role`) and the granted authorities (`authorities`, e.g. `aml:read`) in the session
  // token, so both vocabularies have to be listed here.
  ADMIN_AUTHORITY_HINTS: z
    .string()
    .default(
      "GATEWAY_ADMIN,SECURITY_ADMIN,FINANCE,OPERATOR,COMPLIANCE,MLRO,SUPPORT,aml:read,aml:write",
    ),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).max(20971520).default(4194304),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(52428800).default(20971520),
  UPLOAD_ALLOWED_MIME: z.string().default("text/csv,application/vnd.ms-excel,application/json"),
  ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  ADMIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  RECONCILIATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
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

/**
 * The environment is read once in every environment except the test
 * environment. A test run executes several test files inside one process and
 * each of them configures its own environment, so a cached configuration
 * would leak from one file into the next.
 */
const isTestEnvironment = (): boolean => process.env.NODE_ENV === "test";

let cached: EdgeEnv | undefined;
let warnedAboutTestEnvironment = false;

export const loadEnv = (): EdgeEnv => {
  if (isTestEnvironment()) {
    const parsed = envSchema.safeParse(process.env);
    if (parsed.success) {
      return parsed.data;
    }
    const issues = parsed.error.issues.map((issue) => issue.path.join(".") || "environment");
    if (!warnedAboutTestEnvironment) {
      warnedAboutTestEnvironment = true;
      console.error(`Test environment is missing configuration: ${issues.join(", ")}`);
    }
    throw new Error(`Invalid test environment configuration: ${issues.join(", ")}`);
  }
  cached ??= readEnv();
  return cached;
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
