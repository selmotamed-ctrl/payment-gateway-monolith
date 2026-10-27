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

const httpUrl = z.string().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  },
  { error: "must be an absolute http(s) URL" },
);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4103),
  CORE_BACK_URL: httpsUrl,
  MTLS_CLIENT_CERT_PATH: z.string().min(1),
  MTLS_CLIENT_KEY_PATH: z.string().min(1),
  MTLS_CA_CERT_PATH: z.string().min(1),
  CORE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).max(10485760).default(1048576),
  MAX_INBOUND_BODY_BYTES: z.coerce.number().int().min(1024).max(26214400).default(3145728),
  CHECKOUT_FRONT_BASE_URL: httpUrl.default("http://localhost:5103"),
  CHECKOUT_FRONT_STATUS_PATH: z.string().min(1).max(256).default("/pay/status"),
  PAY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  PAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  INBOUND_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  INBOUND_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
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
