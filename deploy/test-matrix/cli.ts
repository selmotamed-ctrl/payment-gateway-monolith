#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadDeployConfig } from "../lib/configSchema";
import { gateMeta, loadGateContext, runAllGates, topologyPassed } from "./gates";
import { bootstrapLab, ensureVaultDir, verifyMachines } from "./hosts";
import { INTENSITY_PRESETS, resolveIntensity, selectedGates, type IntensityPreset, type ResolvedIntensity } from "./intensity";
import { configHash, hashCanonical, labConfigSchema, LabConfigError, loadLabConfig, machinePrivateIp, resolveSudoPassword, type LabConfig } from "./labConfig";
import { loadOrCreateLabSecrets, redact, secretValues } from "./labSecrets";
import { DEFAULT_CONFIGS_DIR, writeTopologyConfigs } from "./generateTopologyConfigs";
import { LabRemote } from "./remote";
import { DEFAULT_REPORTS_DIR, writeCertificationReport } from "./report";
import { teardownTopology } from "./teardown";
import { describeTopology, selectTopologies, type DerivedTopology } from "./topologyDerivation";
import type { MatrixRunMeta, TopologyRunResult } from "./types";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const DEFAULT_CONFIG_PATH = join(import.meta.dirname, "machines.local.json");
export const SCHEMA_PATH = join(import.meta.dirname, "machines.schema.json");

export const COMMANDS = ["validate", "plan", "bootstrap", "run", "teardown", "schema"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  configPath: string;
  topologies: string[];
  intensity?: IntensityPreset;
  dryRun: boolean;
  skipBootstrap: boolean;
  skipTeardown: boolean;
  keepData: boolean;
  attempts?: number;
  configsDir: string;
  reportsDir: string;
}

export const parseArgs = (argv: string[], env: Record<string, string | undefined> = process.env): CliOptions => {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) {
    throw new Error(`Usage: cli.ts <${COMMANDS.join("|")}> [--config=machines.json] [--topologies=id,alias] [--intensity=${INTENSITY_PRESETS.join("|")}] [--attempts=N] [--dry-run] [--skip-bootstrap] [--skip-teardown] [--keep-data]`);
  }
  const options: CliOptions = {
    command: command as Command,
    configPath: env.LAB_MATRIX_CONFIG ? resolve(env.LAB_MATRIX_CONFIG) : DEFAULT_CONFIG_PATH,
    topologies: [],
    dryRun: false,
    skipBootstrap: false,
    skipTeardown: false,
    keepData: false,
    configsDir: DEFAULT_CONFIGS_DIR,
    reportsDir: DEFAULT_REPORTS_DIR,
  };
  for (const raw of rest) {
    const [flag, value = ""] = raw.split(/=(.*)/s, 2) as [string, string?];
    switch (flag) {
      case "--config": options.configPath = resolve(value); break;
      case "--topologies": options.topologies = value.split(",").map((entry) => entry.trim()).filter(Boolean); break;
      case "--intensity":
        if (!INTENSITY_PRESETS.includes(value as IntensityPreset)) throw new Error(`Unknown intensity '${value}' (expected ${INTENSITY_PRESETS.join(", ")})`);
        options.intensity = value as IntensityPreset;
        break;
      case "--attempts": {
        const attempts = Number(value);
        if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error(`--attempts must be an integer 1-5 (got '${value}')`);
        options.attempts = attempts;
        break;
      }
      case "--configs-dir": options.configsDir = resolve(value); break;
      case "--reports-dir": options.reportsDir = resolve(value); break;
      case "--dry-run": options.dryRun = true; break;
      case "--skip-bootstrap": options.skipBootstrap = true; break;
      case "--skip-teardown": options.skipTeardown = true; break;
      case "--keep-data": options.keepData = true; break;
      default: throw new Error(`Unknown option ${raw}`);
    }
  }
  return options;
};

export const generateJsonSchema = (): string =>
  `${JSON.stringify({ ...z.toJSONSchema(labConfigSchema, { io: "input", unrepresentable: "any" }), title: "Payment gateway multi-machine test lab", $id: "machines.schema.json" }, null, 2)}\n`;

interface Prepared {
  config: LabConfig;
  intensity: ResolvedIntensity;
  topologies: DerivedTopology[];
  skipped: Array<{ family: string; reason: string }>;
  hash: string;
  intensityHash: string;
}

const prepare = (options: CliOptions): Prepared => {
  const config = loadLabConfig(options.configPath);
  const intensity = resolveIntensity(config.intensity, options.intensity);
  if (options.attempts) intensity.attempts = options.attempts;
  const { topologies, skipped } = selectTopologies(config, options.topologies);
  return { config, intensity, topologies, skipped, hash: configHash(config), intensityHash: hashCanonical(intensity) };
};

const printPlan = (prepared: Prepared): void => {
  console.log(`lab ${prepared.config.lab.name}: ${prepared.config.machines.length} machine(s), config sha256 ${prepared.hash}`);
  console.log(`intensity ${prepared.intensity.preset}${prepared.intensity.overridden.length ? ` (+${prepared.intensity.overridden.join(", ")})` : ""}: ${prepared.intensity.targetTps} TPS x ${prepared.intensity.durationSec}s, concurrency ${prepared.intensity.concurrency}, gates ${selectedGates(prepared.intensity).map((id) => `${gateMeta(id).gate}:${id}`).join(" ")}`);
  for (const entry of prepared.skipped) console.log(`  (family ${entry.family} skipped: ${entry.reason})`);
  console.log(`${prepared.topologies.length} topology(ies) selected:`);
  for (const topology of prepared.topologies) console.log(describeTopology(topology));
};

const gitCommit = (): string => {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "deploy"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout?.trim() ? "+dirty" : "";
  return `${(result.stdout ?? "").trim() || "unknown"}${dirty}`;
};

const deploy = (configPath: string, mode: "--fresh" | "--update"): { ok: boolean; output: string; durationMs: number } => {
  const started = Date.now();
  const result = spawnSync("bun", ["deploy/deploy.ts", `--env=${configPath}`, mode], { cwd: REPO_ROOT, encoding: "utf8", timeout: 4 * 60 * 60_000 });
  return { ok: (result.status ?? 1) === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, durationMs: Date.now() - started };
};

const diagnostics = (config: LabConfig, remote: LabRemote, topology: DerivedTopology, configPath: string): string => {
  const lines: string[] = [];
  for (const machineId of topology.machinesUsed) {
    const pm2 = remote.tryRun(machineId, '"$HOME/.bun/bin/pm2" logs --nostream --lines 80 2>&1 || true');
    lines.push(`### ${machineId} PM2 logs`, "", "```", pm2.output.slice(-12_000), "```", "");
    const journal = remote.tryRun(machineId, "journalctl -u 'postgresql@18-*' -u pg-backup-daemon -u nginx -n 80 --no-pager 2>&1 || true", { sudo: true });
    lines.push(`### ${machineId} service journal`, "", "```", journal.output.slice(-12_000), "```", "");
  }
  if (existsSync(configPath)) lines.push("### topology config", "", "```", readFileSync(configPath, "utf8"), "```");
  return lines.join("\n");
};

const runTopology = async (input: {
  config: LabConfig;
  remote: LabRemote;
  intensity: ResolvedIntensity;
  topology: DerivedTopology;
  configPath: string;
  options: CliOptions;
}): Promise<TopologyRunResult> => {
  const { config, remote, intensity, topology, configPath, options } = input;
  const startedAt = new Date().toISOString();
  let last: Omit<TopologyRunResult, "startedAt" | "finishedAt"> | undefined;
  for (let attempt = 1; attempt <= intensity.attempts; attempt += 1) {
    console.log(`\n=== ${topology.id} attempt ${attempt}/${intensity.attempts} ===`);
    if (!options.skipTeardown) {
      const report = teardownTopology(config, remote, { removeData: !options.keepData, machines: topology.machinesUsed });
      if (report.refused.length > 0) throw new Error(`teardown refused on unmarked machine(s) ${report.refused.join(", ")}; run bootstrap`);
    }
    if (topology.vault) ensureVaultDir(config, remote, topology.vault.machineId, topology.vault.path);
    // Rolling topologies are deployed fresh and then redeployed with
    // --update so the rolling path is exercised. (The archived runner always
    // passed --fresh, which overrode DEPLOY_MODE=rolling_update.)
    let deployed = deploy(configPath, "--fresh");
    if (deployed.ok && topology.deployMode === "rolling_update") {
      const update = deploy(configPath, "--update");
      deployed = { ok: update.ok, output: `${deployed.output}\n--- rolling update ---\n${update.output}`, durationMs: deployed.durationMs + update.durationMs };
    }
    console.log(deployed.output.slice(-4000));
    let gates: TopologyRunResult["gates"] = [];
    if (deployed.ok) {
      try {
        gates = await runAllGates(loadGateContext({ lab: config, topology, intensity, configPath, remote }));
      } catch (error) {
        deployed.output += `\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
      }
    }
    const passed = topologyPassed(deployed.ok, gates);
    last = {
      topology,
      configPath,
      attempt,
      attemptsAllowed: intensity.attempts,
      deploy: { ok: deployed.ok, durationMs: deployed.durationMs, output: deployed.output.slice(-20_000) },
      gates,
      passed,
    };
    if (passed) break;
    last.deploy.output += `\n\n${diagnostics(config, remote, topology, configPath)}`;
  }
  return { ...last!, startedAt, finishedAt: new Date().toISOString() };
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "schema") {
    writeFileSync(SCHEMA_PATH, generateJsonSchema());
    console.log(`wrote ${SCHEMA_PATH}`);
    return;
  }
  const prepared = prepare(options);
  printPlan(prepared);
  if (options.command === "validate") return;

  const { config, intensity, topologies } = prepared;
  const sudoPassword = resolveSudoPassword(config);
  const secrets = loadOrCreateLabSecrets(config, options.configsDir);
  const known = secretValues(secrets, sudoPassword ? [sudoPassword] : []);
  const remote = new LabRemote(config, sudoPassword, { dryRun: options.dryRun, logger: (message) => console.log(redact(message, known)) });

  if (options.command === "bootstrap") {
    bootstrapLab(config, remote, secrets);
    console.log(`lab ${config.lab.name} ready: ${config.machines.map((machine) => `${machine.id}=${machinePrivateIp(machine)}`).join(" ")}`);
    return;
  }
  if (options.command === "teardown") {
    const report = teardownTopology(config, remote, { removeData: !options.keepData });
    console.log(`teardown: cleaned ${report.cleaned.join(", ") || "-"}; refused ${report.refused.join(", ") || "-"}`);
    if (report.refused.length > 0) process.exitCode = 1;
    return;
  }

  const paths = writeTopologyConfigs({ config, topologies, secrets, intensity, sudoPassword, directory: options.configsDir });
  for (const topology of topologies) {
    const loaded = loadDeployConfig(readFileSync(paths.get(topology.id)!, "utf8"));
    if (!loaded.ok) throw new Error(`${topology.id}: generated deploy config is invalid: ${loaded.problems.join("; ")}`);
  }
  console.log(`deploy configs written (0600) under ${join(options.configsDir, config.lab.name)}`);
  if (options.command === "plan" || options.dryRun) return;

  if (options.skipBootstrap) {
    const failed = verifyMachines(config, remote).filter((check) => !check.ok);
    if (failed.length > 0) throw new Error(failed.map((check) => `${check.machineId}: ${check.detail}`).join("\n"));
  } else {
    bootstrapLab(config, remote, secrets);
  }

  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${prepared.hash.slice(0, 8)}`;
  const results: TopologyRunResult[] = [];
  for (const topology of topologies) {
    const result = await runTopology({ config, remote, intensity, topology, configPath: paths.get(topology.id)!, options });
    results.push(result);
    console.log(`\n${topology.id}: ${result.passed ? "CERTIFIED" : "NOT CERTIFIED"} (attempt ${result.attempt}/${result.attemptsAllowed})`);
  }
  const meta: MatrixRunMeta = {
    runId,
    labName: config.lab.name,
    configPath: options.configPath,
    configHash: prepared.hash,
    intensityHash: prepared.intensityHash,
    intensity,
    gitCommit: gitCommit(),
    machines: config.machines.map((machine) => ({ id: machine.id, address: machine.address, privateIp: machinePrivateIp(machine), roles: machine.roles, labels: machine.labels })),
    skippedFamilies: prepared.skipped,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  const report = writeCertificationReport(meta, results, { directory: options.reportsDir, knownSecrets: known });
  console.log(`\nreport: ${report.markdown}\njson:   ${report.json}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof LabConfigError ? error.message : `test-matrix failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
