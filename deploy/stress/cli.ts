#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { StressContext, type ScenarioResult } from "./harness";
import { writeReport, type RunMeta } from "./report";
import { SCENARIOS, SkipScenario } from "./scenarios";

/**
 * Deploy stress test: drives the REAL deploy engine against this machine's
 * real services (PostgreSQL, PgBouncer, Redis, MinIO, the backup daemon, PM2,
 * nginx, Fake Rails) under load, faults and tampering, and asserts on what the
 * services actually did.
 *
 *   bun run stress                          # every non-destructive scenario
 *   bun run stress -- --scenarios=noop-redeploy,chaos-recovery
 *   bun run stress -- --destructive         # + drop databases, STRESS seed, backup
 *   bun run stress:list
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

export interface CliOptions {
  list: boolean;
  scenarios: string[];
  destructive: boolean;
  intensity: number;
  budgetFactor: number;
  seed: number;
  envPath: string;
  reportsDir: string;
}

export const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    list: false,
    scenarios: [],
    destructive: false,
    intensity: 1,
    budgetFactor: 1,
    seed: Date.now() % 2 ** 31,
    envPath: join(REPO_ROOT, "deploy", "deploy.env"),
    reportsDir: join(REPO_ROOT, "deploy", "stress", "reports"),
  };
  const positive = (flag: string, value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number (got '${value}')`);
    return parsed;
  };
  for (const raw of argv) {
    if (raw === "--") continue;
    if (raw === "list" || raw === "--list") options.list = true;
    else if (raw === "--destructive") options.destructive = true;
    else if (raw.startsWith("--scenarios=")) options.scenarios = raw.slice(12).split(",").map((entry) => entry.trim()).filter(Boolean);
    else if (raw.startsWith("--intensity=")) options.intensity = positive("--intensity", raw.slice(12));
    else if (raw.startsWith("--budget-factor=")) options.budgetFactor = positive("--budget-factor", raw.slice(16));
    else if (raw.startsWith("--seed=")) options.seed = Math.floor(positive("--seed", raw.slice(7)));
    else if (raw.startsWith("--env=")) options.envPath = resolve(raw.slice(6));
    else if (raw.startsWith("--reports-dir=")) options.reportsDir = resolve(raw.slice(14));
    else throw new Error(`Unknown option '${raw}'`);
  }
  const known = new Set(SCENARIOS.map((scenario) => scenario.id));
  for (const id of options.scenarios) if (!known.has(id)) throw new Error(`Unknown scenario '${id}' (known: ${[...known].join(", ")})`);
  return options;
};

/** The scenarios a run will execute, in order. Destructive ones need an explicit opt-in. */
export const selectScenarios = (options: Pick<CliOptions, "scenarios" | "destructive">) => {
  const wanted = options.scenarios.length > 0 ? SCENARIOS.filter((scenario) => options.scenarios.includes(scenario.id)) : SCENARIOS;
  const skippedDestructive = wanted.filter((scenario) => scenario.destructive && !options.destructive);
  return { run: wanted.filter((scenario) => !scenario.destructive || options.destructive), skippedDestructive };
};

const commit = (): string => {
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim() || "unknown";
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "deploy"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  return dirty ? `${head}+dirty` : head;
};

const main = async (): Promise<number> => {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of SCENARIOS) console.log(`${scenario.id.padEnd(30)} ${scenario.destructive ? "[destructive] " : ""}${scenario.title}\n${" ".repeat(31)}${scenario.why}`);
    return 0;
  }
  if (!existsSync(options.envPath)) throw new Error(`Missing ${options.envPath}`);
  const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const workDir = join(REPO_ROOT, "deploy", "stress", ".work", runId);
  const startedAt = new Date().toISOString();
  const { run, skippedDestructive } = selectScenarios(options);
  const ctx = new StressContext({
    repoRoot: REPO_ROOT,
    baseEnvPath: options.envPath,
    workDir,
    budgetFactor: options.budgetFactor,
    logger: (message) => console.log(message),
    seed: options.seed,
    intensity: options.intensity,
  });
  console.log(`deploy stress ${runId}: ${run.length} scenario(s), intensity x${options.intensity}, seed ${options.seed}`);
  const results: ScenarioResult[] = [];
  for (const skipped of skippedDestructive) {
    results.push({ id: skipped.id, title: skipped.title, status: "skipped", ms: 0, checks: [], measures: [], notes: [], skipReason: "destructive; pass --destructive to run" });
  }
  for (const scenario of run) {
    console.log(`\n=== ${scenario.id}: ${scenario.title}`);
    ctx.checks.length = 0;
    ctx.measures.length = 0;
    ctx.notes.length = 0;
    const started = Date.now();
    let status: ScenarioResult["status"] = "pass";
    let error: string | undefined;
    let skipReason: string | undefined;
    try {
      await scenario.run(ctx);
      if (ctx.checks.some((check) => !check.ok)) status = "fail";
    } catch (caught) {
      if (caught instanceof SkipScenario) {
        status = "skipped";
        skipReason = caught.message;
      } else {
        status = "fail";
        error = (caught as Error).stack ?? String(caught);
      }
    } finally {
      await ctx.runCleanups();
    }
    results.push({ id: scenario.id, title: scenario.title, status, ms: Date.now() - started, checks: [...ctx.checks], measures: [...ctx.measures], notes: [...ctx.notes], error, skipReason });
    console.log(`=== ${scenario.id}: ${status.toUpperCase()} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  // The derived env files carry the lab's secrets: never leave them behind.
  for (const file of existsSync(workDir) ? readdirSync(workDir) : []) if (/^deploy\..*\.env$/.test(file)) rmSync(join(workDir, file), { force: true });
  const meta: RunMeta = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: commit(),
    host: hostname(),
    intensity: options.intensity,
    budgetFactor: options.budgetFactor,
    seed: options.seed,
    destructive: options.destructive,
  };
  const files = writeReport(join(options.reportsDir, runId), meta, results);
  const failed = results.filter((result) => result.status === "fail");
  console.log(`\n${results.filter((r) => r.status === "pass").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skipped").length} skipped`);
  console.log(`report: ${files.markdown}`);
  for (const result of failed) console.log(`  FAILED ${result.id}${result.error ? `: ${result.error.split("\n")[0]}` : ""}`);
  return failed.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error: unknown) => {
    console.error(`stress failed: ${(error as Error).message}`);
    process.exit(2);
  });
}
