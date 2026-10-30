/**
 * Pure planning helpers for the synthetic historical dataset.
 */

export type SyntheticProfile = "demo" | "staging" | "load";
export type SyntheticStatus = "RUNNING" | "COMPLETE" | "FAILED";

export interface SyntheticConfig {
  profile: SyntheticProfile;
  namespace: string;
  seed: number;
  years: number;
  endDate: string;
  merchants: number;
  attempts: number;
  reset: boolean;
  auto: boolean;
  verify: boolean;
  allowProduction: boolean;
}

export interface SyntheticManifest {
  generatorVersion: number;
  profile: SyntheticProfile;
  namespace: string;
  seed: number;
  years: number;
  endDate: string;
  status: SyntheticStatus;
  lastCompletedBucket: string | null;
  counts: Record<string, number>;
  ledgerDrift: string;
  startedAt: string;
  completedAt: string | null;
}

export const GENERATOR_VERSION = 1;
export const DEFAULT_NAMESPACE = "synthv1";
export const DEFAULT_SEED = 20260101;

const PROFILES: Record<SyntheticProfile, { years: number; merchants: number; attempts: number }> = {
  demo: { years: 3, merchants: 30, attempts: 30_000 },
  staging: { years: 3, merchants: 100, attempts: 150_000 },
  load: { years: 5, merchants: 400, attempts: 500_000 },
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const parseSyntheticConfig = (
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: SyntheticConfig } | { ok: false; error: string } => {
  let profile = (env.SYNTHETIC_DATA_PROFILE ?? "demo").trim().toLowerCase() as SyntheticProfile;
  let namespace = env.SYNTHETIC_DATA_NAMESPACE?.trim() || DEFAULT_NAMESPACE;
  let seed = parseNumber(env.SYNTHETIC_DATA_SEED, DEFAULT_SEED);
  let years = parseNumber(env.SYNTHETIC_DATA_YEARS, PROFILES[profile]?.years ?? 3);
  let endDate = env.SYNTHETIC_DATA_END_DATE?.trim() || new Date().toISOString().slice(0, 10);
  let merchants = parseNumber(env.SYNTHETIC_DATA_MERCHANTS, PROFILES[profile]?.merchants ?? 30);
  let attempts = parseNumber(env.SYNTHETIC_DATA_ATTEMPTS, PROFILES[profile]?.attempts ?? 30_000);
  let reset = (env.SYNTHETIC_DATA_RESET ?? "false").toLowerCase() === "true";
  let auto = false;
  let verify = false;
  let allowProduction = (env.SYNTHETIC_DATA_ALLOW_PRODUCTION ?? "false").toLowerCase() === "true";

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    try {
      if (flag === "--auto") auto = true;
      else if (flag === "--reset") reset = true;
      else if (flag === "--verify") verify = true;
      else if (flag === "--allow-production") allowProduction = true;
      else if (flag === "--profile") profile = next().trim().toLowerCase() as SyntheticProfile;
      else if (flag.startsWith("--profile=")) profile = flag.slice(10).trim().toLowerCase() as SyntheticProfile;
      else if (flag === "--namespace") namespace = next().trim();
      else if (flag.startsWith("--namespace=")) namespace = flag.slice(12).trim();
      else if (flag === "--seed") seed = parseNumber(next(), seed);
      else if (flag.startsWith("--seed=")) seed = parseNumber(flag.slice(7), seed);
      else if (flag === "--years") years = parseNumber(next(), years);
      else if (flag.startsWith("--years=")) years = parseNumber(flag.slice(8), years);
      else if (flag === "--merchants") merchants = parseNumber(next(), merchants);
      else if (flag.startsWith("--merchants=")) merchants = parseNumber(flag.slice(12), merchants);
      else if (flag === "--attempts") attempts = parseNumber(next(), attempts);
      else if (flag.startsWith("--attempts=")) attempts = parseNumber(flag.slice(11), attempts);
      else if (flag === "--help" || flag === "-h") return { ok: false, error: "help" };
      else return { ok: false, error: `unknown option '${flag}'` };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  if (!PROFILES[profile]) return { ok: false, error: `unknown profile '${profile}'` };
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(namespace)) {
    return { ok: false, error: "the namespace must be 2-32 letters, digits, _ or -" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || Number.isNaN(new Date(`${endDate}T00:00:00Z`).getTime())) {
    return { ok: false, error: "SYNTHETIC_DATA_END_DATE must be YYYY-MM-DD" };
  }
  if (years < 1 || years > 10) return { ok: false, error: "years must be between 1 and 10" };
  if (merchants < 1 || merchants > 5000) return { ok: false, error: "merchants must be between 1 and 5000" };
  if (attempts < 1 || attempts > 2_000_000) return { ok: false, error: "attempts must be between 1 and 2000000" };

  return {
    ok: true,
    config: { profile, namespace, seed, years, endDate, merchants, attempts, reset, auto, verify, allowProduction },
  };
};

export const syntheticGuardError = (
  nodeEnv: string | undefined,
  allowProduction: boolean,
): string | null => {
  if ((nodeEnv ?? "development") !== "production") return null;
  if (allowProduction) return null;
  return "refusing to generate synthetic data in production; pass --allow-production or set SYNTHETIC_DATA_ALLOW_PRODUCTION=true";
};

export const manifestKey = (namespace: string): string => `synthetic.dataset.${namespace}`;

export const manifestMatches = (manifest: SyntheticManifest | null, config: SyntheticConfig): boolean =>
  Boolean(
    manifest
    && manifest.status === "COMPLETE"
    && manifest.generatorVersion === GENERATOR_VERSION
    && manifest.profile === config.profile
    && manifest.seed === config.seed
    && manifest.years === config.years
    && manifest.endDate === config.endDate,
  );

export const syntheticId = (namespace: string, kind: string, index: number): string =>
  `${namespace}_${kind}_${String(index).padStart(8, "0")}`;

export const syntheticReference = (namespace: string, kind: string, index: number): string =>
  `SYNTH-${namespace.toUpperCase()}-${kind.toUpperCase()}-${String(index).padStart(8, "0")}`;

export const mulberry32 = (seed: number): (() => number) => {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const pick = <T>(random: () => number, values: readonly T[]): T =>
  values[Math.floor(random() * values.length) % values.length] as T;

export const money = (value: number): string => Math.max(0, value).toFixed(4);

export const USAGE = `Usage: bun run seed-synthetic [options]

Options:
  --auto                 Skip when the namespace is already complete.
  --reset                Delete the namespace before generating.
  --verify               Verify counts and ledger drift without writing.
  --profile <name>       demo | staging | load (default demo).
  --namespace <name>     Default ${DEFAULT_NAMESPACE}.
  --seed <number>        Default ${DEFAULT_SEED}.
  --years <number>       Default 3.
  --merchants <number>   Profile default.
  --attempts <number>    Profile default.
  --allow-production     Required when NODE_ENV=production.

Environment equivalents use the SYNTHETIC_DATA_* names.`;
