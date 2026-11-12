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
  BIND_HOST: z.string().min(1).default("0.0.0.0"),
  CORE_BACK_URL: httpsUrl,
  CORE_BACK_URLS: z.string().optional(),
  SANDBOX_CORE_BACK_URL: httpsUrl.optional(),
  SANDBOX_CORE_BACK_URLS: z.string().optional(),
  MTLS_CLIENT_CERT_PATH: z.string().min(1),
  MTLS_CLIENT_KEY_PATH: z.string().min(1),
  MTLS_CA_CERT_PATH: z.string().min(1),
  CORE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  // Peers whose forwarded client-ip headers are honoured. Loopback only by default: a deploy
  // that fronts the edge with a proxy on another address must list that address explicitly.
  TRUSTED_PROXY_CIDRS: z.string().default("127.0.0.0/8,::1/128"),
  // Comma separated list of exact origins allowed to call this service cross-origin.
  // Empty (default) means no CORS headers are emitted at all.
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  // Upper bound for a buffered (non streaming) core response.
  CORE_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(536870912).default(67108864),
  // Total wall clock budget of one buffered core call (idle timeout is CORE_REQUEST_TIMEOUT_MS).
  CORE_TOTAL_DEADLINE_MS: z.coerce.number().int().min(1000).max(1800000).default(300000),
  // Concurrent SSE streams one client ip may hold open through this edge.
  MAX_STREAMS_PER_IP: z.coerce.number().int().min(1).max(1000).default(5),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).max(10485760).default(1048576),
  // Gateways post small notification payloads; 1 MiB is already generous.
  MAX_INBOUND_BODY_BYTES: z.coerce.number().int().min(1024).max(26214400).default(1048576),
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

export const parseCoreBackUrls = (raw: string | undefined, fallback: string): string[] => {
  const entries = raw !== undefined && raw.trim().length > 0 ? raw.split(",") : [fallback];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new Error("CORE_BACK_URLS must not contain an empty entry");
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`CORE_BACK_URLS contains a malformed URL: ${trimmed}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`CORE_BACK_URLS only accepts absolute https URLs: ${trimmed}`);
    }
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(trimmed);
  }
  return urls;
};

export const coreBackUrls = (): string[] => {
  const loaded = loadEnv();
  return parseCoreBackUrls(loaded.CORE_BACK_URLS, loaded.CORE_BACK_URL);
};

/**
 * The parallel Sandbox Plane pool. When `SANDBOX_CORE_BACK_URL(S)` is not
 * configured this falls back to the live pool, which keeps single-process
 * development and the unit tests working; the deploy engine writes the real
 * sandbox URL for a parallel installation.
 */
export const sandboxCoreBackUrls = (): string[] => {
  const loaded = loadEnv();
  return parseCoreBackUrls(
    loaded.SANDBOX_CORE_BACK_URLS,
    loaded.SANDBOX_CORE_BACK_URL ?? loaded.CORE_BACK_URL,
  );
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
