#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapSshAndLabAccess, discoverLabHosts } from "./hosts";
import { configPathFor, writeTopologyConfigs } from "./generateTopologyConfigs";
import { runAllGates, loadGateContext } from "./gates";
import { writeCertificationReport } from "./report";
import { teardownTopology } from "./teardown";
import { buildAllTopologySpecs } from "./topologies";
import type { LabHostsConfig, TopologyId, TopologyRunResult } from "./types";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

interface RunnerOptions {
  topologies: TopologyId[];
  dryRun: boolean;
  skipBootstrap: boolean;
  skipTeardown: boolean;
  keepData: boolean;
  attempts: number;
}

const parseArgs = (argv: string[]): RunnerOptions => {
  const options: RunnerOptions = {
    topologies: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"],
    dryRun: false,
    skipBootstrap: false,
    skipTeardown: false,
    keepData: false,
    attempts: 2,
  };
  for (const raw of argv) {
    if (raw === "--dry-run") options.dryRun = true;
    else if (raw === "--skip-bootstrap") options.skipBootstrap = true;
    else if (raw === "--skip-teardown") options.skipTeardown = true;
    else if (raw === "--keep-data") options.keepData = true;
    else if (raw.startsWith("--topologies=")) {
      options.topologies = raw.slice("--topologies=".length).split(",").map((entry) => entry.trim().toUpperCase()) as TopologyId[];
    } else if (raw.startsWith("--attempts=")) {
      options.attempts = Math.max(1, Number(raw.slice("--attempts=".length)) || 1);
    } else if (raw.startsWith("--")) {
      throw new Error(`Unknown option ${raw}`);
    }
  }
  return options;
};

const run = (command: string, args: string[], cwd = REPO_ROOT): { ok: boolean; output: string; durationMs: number } => {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 4 * 60 * 60_000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { ok: (result.status ?? 1) === 0, output, durationMs: Date.now() - started };
};

const diagnostics = (lab: LabHostsConfig, configPath: string): string => {
  const lines: string[] = [];
  for (const host of [lab.hostALanIp, lab.hostBLanIp]) {
    const pm2 = run("ssh", ["-i", lab.sshKeyPath, "-o", "BatchMode=yes", `${host === lab.hostALanIp ? lab.hostASshUser : lab.hostBSshUser}@${host}`, '"$HOME/.bun/bin/pm2" logs --nostream --lines 80 2>&1 || true']);
    lines.push(`### ${host} PM2 logs`, "", "```", pm2.output.slice(-12_000), "```", "");
    const journal = run("ssh", ["-i", lab.sshKeyPath, "-o", "BatchMode=yes", `${host === lab.hostALanIp ? lab.hostASshUser : lab.hostBSshUser}@${host}`, "sudo -n journalctl -u 'postgresql@18-*' -u pg-backup-daemon -u nginx -n 80 --no-pager 2>&1 || true"]);
    lines.push(`### ${host} service journal`, "", "```", journal.output.slice(-12_000), "```", "");
  }
  if (existsSync(configPath)) {
    lines.push("### topology config", "", "```", readFileSync(configPath, "utf8").replace(/PASSWORD=.*$/gm, "PASSWORD=***"), "```");
  }
  return lines.join("\n");
};

const deployTopology = (configPath: string): { ok: boolean; output: string; durationMs: number } =>
  run("bun", ["deploy/deploy.ts", `--env=${configPath}`, "--fresh"], REPO_ROOT);

const runTopology = async (lab: LabHostsConfig, topology: TopologyId, configPath: string, options: RunnerOptions): Promise<TopologyRunResult> => {
  const spec = buildAllTopologySpecs().find((entry) => entry.id === topology);
  if (!spec) throw new Error(`Unknown topology ${topology}`);
  const startedAt = new Date().toISOString();
  let lastDeploy = { ok: false, output: "", durationMs: 0 };
  let lastGates: TopologyRunResult["gates"] = [];
  let failureDetail = "";

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    console.log(`\n=== ${topology} attempt ${attempt}/${options.attempts} ===`);
    if (!options.skipTeardown) teardownTopology(lab, { removeData: !options.keepData });
    lastDeploy = deployTopology(configPath);
    console.log(lastDeploy.output.slice(-4000));
    if (!lastDeploy.ok) {
      failureDetail = diagnostics(lab, configPath);
      console.log(`deploy failed for ${topology}; diagnostics captured`);
      continue;
    }
    try {
      const context = loadGateContext(lab, topology, configPath);
      lastGates = await runAllGates(context);
      if (lastGates.every((gate) => gate.status === "PASSED")) {
        return {
          topology,
          name: spec.name,
          configPath,
          deploy: { ok: true, durationMs: lastDeploy.durationMs, output: lastDeploy.output.slice(-20_000) },
          gates: lastGates,
          passed: true,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
      failureDetail = diagnostics(lab, configPath);
    } catch (error) {
      failureDetail = `${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n${diagnostics(lab, configPath)}`;
    }
  }

  return {
    topology,
    name: spec.name,
    configPath,
    deploy: { ok: lastDeploy.ok, durationMs: lastDeploy.durationMs, output: `${lastDeploy.output.slice(-20_000)}\n\n${failureDetail}` },
    gates: lastGates,
    passed: false,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const lab = options.skipBootstrap ? discoverLabHosts() : bootstrapSshAndLabAccess();
  writeTopologyConfigs(lab);
  console.log(`lab: HOST_A=${lab.hostALanIp} HOST_B=${lab.hostBLanIp}`);

  if (options.dryRun) {
    for (const topology of options.topologies) {
      console.log(`[dry-run] ${topology}: ${configPathFor(topology)}`);
    }
    return;
  }

  const results: TopologyRunResult[] = [];
  for (const topology of options.topologies) {
    const result = await runTopology(lab, topology, configPathFor(topology), options);
    results.push(result);
    console.log(`\n${topology}: ${result.passed ? "PASSED" : "FAILED"}`);
  }
  const report = writeCertificationReport(results);
  console.log(`\nreport: ${report}`);
  if (results.some((result) => !result.passed)) process.exit(1);
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`matrix failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { parseArgs, runTopology };
