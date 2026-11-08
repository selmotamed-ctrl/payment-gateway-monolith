import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshTarget } from "../lib/hostPlanner";
import { SshRunner, shellQuote } from "../lib/sshRunner";
import { parseEnv, withOverrides } from "./env";
import { diffSnapshots, takeSnapshot, type ServiceSnapshot, type Target } from "./probes";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Measure {
  name: string;
  value: number;
  unit: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skipped";
  ms: number;
  checks: Check[];
  measures: Measure[];
  notes: string[];
  error?: string;
  skipReason?: string;
}

export interface DeployRun {
  name: string;
  ok: boolean;
  code: number | null;
  ms: number;
  output: string;
  logFile: string;
  /** `service=outcome` pairs the provisioners reported (started / restarted / reloaded / unchanged). */
  outcomes: Array<{ service: string; outcome: string }>;
  /** Services the deploy started or restarted. */
  bounced: string[];
  /** Commands the runner flagged as slow (>= its threshold). */
  slowCommands: number;
}

export interface DeployOptions {
  name: string;
  /** Full replacement env text (defaults to the operator's deploy.env). */
  envText?: string;
  /** Key overrides applied on top of the env text. */
  overrides?: Record<string, string>;
  args?: string[];
  /** Pass false to omit `--skip-build` (the default skips builds; the build cache makes them cheap anyway). */
  skipBuild?: boolean;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}

export const parseOutcomes = (output: string): Array<{ service: string; outcome: string }> => {
  const found: Array<{ service: string; outcome: string }> = [];
  for (const line of output.split("\n")) {
    const match = /^\s*services:\s*(.+)$/.exec(line);
    if (!match) continue;
    for (const pair of match[1]!.split(",")) {
      const [service, outcome] = pair.trim().split("=");
      if (service && outcome) found.push({ service, outcome });
    }
  }
  return found;
};

/** Deploy-log lines that mean a backup daemon / dependent service was restarted. */
export const parseDaemonOutcome = (output: string): string | undefined => /backup daemon (\w+) ->/.exec(output)?.[1];

export interface ContextOptions {
  repoRoot: string;
  baseEnvPath: string;
  workDir: string;
  /** Multiplies every time budget (slow machine / loaded CI). */
  budgetFactor: number;
  logger: (message: string) => void;
  /** Rng seed so a random soak is reproducible. */
  seed: number;
  /** Intensity multiplier: workers, iterations, request counts. */
  intensity: number;
}

/**
 * Everything a scenario needs: the real deploy engine, the real machine, and
 * assertions. Nothing here is mocked; a scenario that passes proves the
 * behaviour on the actual services.
 */
export class StressContext {
  readonly baseText: string;
  readonly base: Map<string, string>;
  readonly sudoTarget: SshTarget;
  readonly runner: SshRunner;
  readonly target: Target;
  readonly checks: Check[] = [];
  readonly measures: Measure[] = [];
  readonly notes: string[] = [];
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private rng: number;

  constructor(readonly options: ContextOptions) {
    this.baseText = readFileSync(options.baseEnvPath, "utf8");
    this.base = parseEnv(this.baseText);
    const need = (key: string): string => {
      const value = this.base.get(key);
      if (!value) throw new Error(`${options.baseEnvPath} does not define ${key}`);
      return value;
    };
    this.sudoTarget = {
      host: "127.0.0.1",
      port: 22,
      user: this.base.get("PG_SSH_USER") ?? "root",
      keyPath: this.base.get("PG_SSH_KEY_PATH") ?? "",
      sudoPassword: this.base.get("PG_SUDO_PASSWORD") ?? this.base.get("CORE_SUDO_PASSWORD") ?? "",
    };
    this.runner = new SshRunner({ logger: () => undefined, mux: false });
    const node = (key: string): { port: number } => {
      const spec = need(key).split(",")[0]!.split(":");
      return { port: Number(spec[spec.length - 1]) };
    };
    this.target = {
      pgPort: node("PG_PRIMARY_NODE").port,
      pgbouncerPort: Number(this.base.get("PGBOUNCER_PORT") ?? "6432"),
      redisPort: node("REDIS_NODES").port,
      redisPassword: need("REDIS_PASSWORD"),
      dbName: need("PG_DB_NAME"),
      dbUser: need("PG_DB_USER"),
      dbPassword: need("PG_DB_PASSWORD"),
    };
    this.rng = options.seed >>> 0 || 1;
    mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  }

  // ---- assertions ---------------------------------------------------------

  check(name: string, ok: boolean, detail?: string): boolean {
    this.checks.push({ name, ok, detail });
    this.options.logger(`    ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
    return ok;
  }

  measure(name: string, value: number, unit: string): void {
    this.measures.push({ name, value: Math.round(value * 100) / 100, unit });
    this.options.logger(`    ....  ${name}: ${Math.round(value * 100) / 100} ${unit}`);
  }

  note(message: string): void {
    this.notes.push(message);
    this.options.logger(`    note  ${message}`);
  }

  /** A time budget in ms, scaled by --budget-factor. */
  budget(seconds: number): number {
    return seconds * 1000 * this.options.budgetFactor;
  }

  /** Scales a count (workers, iterations) by --intensity, never below 1. */
  scale(count: number): number {
    return Math.max(1, Math.round(count * this.options.intensity));
  }

  /** Deterministic pseudo-random number in [0, 1). */
  random(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 2 ** 32;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)]!;
  }

  /** Registers work that always runs when the scenario ends (restoring the base config). */
  onCleanup(fn: () => Promise<void> | void): void {
    this.cleanups.push(fn);
  }

  async runCleanups(): Promise<void> {
    for (const fn of this.cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (error) {
        this.note(`cleanup failed: ${(error as Error).message}`);
      }
    }
  }

  // ---- machine access -----------------------------------------------------

  /** Runs a shell command on this machine (as root with `sudo`). */
  sh(command: string, options: { sudo?: boolean; timeoutMs?: number } = {}): string {
    return this.runner.capture(this.sudoTarget, command, { sudo: options.sudo ?? true, timeoutMs: options.timeoutMs ?? 120_000 });
  }

  /** Like `sh` but never throws: returns the failure text instead. */
  tryShell(command: string, options: { sudo?: boolean; timeoutMs?: number } = {}): { ok: boolean; out: string } {
    try {
      return { ok: true, out: this.sh(command, options) };
    } catch (error) {
      return { ok: false, out: (error as Error).message };
    }
  }

  snapshot(): ServiceSnapshot {
    return takeSnapshot(this.runner, this.sudoTarget, this.target);
  }

  diff(before: ServiceSnapshot, after: ServiceSnapshot): string[] {
    return diffSnapshots(before, after);
  }

  redis(args: string): string {
    return this.sh(`REDISCLI_AUTH=${shellQuote(this.target.redisPassword)} redis-cli -p ${this.target.redisPort} ${args}`);
  }

  psql(sql: string, database = "postgres", port = this.target.pgPort): string {
    return this.sh(`runuser -u postgres -- psql -p ${port} -d ${shellQuote(database)} -Atc ${shellQuote(sql)}`);
  }

  unitActive(unit: string): boolean {
    return this.tryShell(`systemctl is-active --quiet ${shellQuote(unit)}`).ok;
  }

  /** The systemd unit the managed Redis-compatible server runs under (valkey / redis-server / redis). */
  redisUnit(): string {
    return this.sh(`for u in redis-server redis valkey; do for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do [ -f "$d/$u.service" ] && [ ! -L "$d/$u.service" ] && { echo $u; exit 0; }; done; done`).trim() || "redis-server";
  }

  get pgUnit(): string {
    return "postgresql@18-main";
  }

  // ---- the deploy engine --------------------------------------------------

  writeEnv(name: string, text: string): string {
    const path = join(this.options.workDir, `deploy.${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.env`);
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  /** Runs the real `deploy.ts` as a child process (async: load generators keep running meanwhile). */
  deploy(options: DeployOptions): Promise<DeployRun> {
    const text = withOverrides(options.envText ?? this.baseText, options.overrides ?? {});
    const envPath = this.writeEnv(options.name, text);
    const logFile = join(this.options.workDir, `deploy.${options.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
    const args = ["deploy/deploy.ts", `--env=${envPath}`, ...(options.args ?? ["--update"])];
    if (options.skipBuild !== false && !args.includes("--skip-build")) args.push("--skip-build");
    const started = Date.now();
    this.options.logger(`    run   deploy ${args.slice(2).join(" ")}  (${options.name})`);
    return new Promise((resolvePromise) => {
      const out = createWriteStream(logFile, { mode: 0o600 });
      const child = spawn("bun", args, { cwd: this.options.repoRoot, env: { ...process.env, ...options.extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const sink = (chunk: Buffer): void => {
        out.write(chunk);
        output += chunk.toString("utf8");
      };
      child.stdout.on("data", sink);
      child.stderr.on("data", sink);
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30 * 60_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        out.end();
        const outcomes = parseOutcomes(output);
        const daemon = parseDaemonOutcome(output);
        const bounced = outcomes.filter((entry) => entry.outcome === "started" || entry.outcome === "restarted").map((entry) => entry.service);
        if (daemon === "started" || daemon === "restarted") bounced.push("pg-backup-daemon");
        resolvePromise({
          name: options.name,
          ok: code === 0 && output.includes("Deployment complete."),
          code,
          ms: Date.now() - started,
          output,
          logFile,
          outcomes,
          bounced,
          slowCommands: (output.match(/! slow command/g) ?? []).length,
        });
      });
    });
  }

  /** Re-deploys the operator's own env, undoing any scenario override. */
  restoreBase(extraArgs: string[] = ["--update", "--only=storage"]): Promise<DeployRun> {
    return this.deploy({ name: "restore-base", args: extraArgs });
  }

  fileExists(path: string): boolean {
    return existsSync(path);
  }
}
