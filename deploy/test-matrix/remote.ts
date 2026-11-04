import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isLocalTarget, SshRunner } from "../lib/sshRunner";
import type { SshTarget } from "../lib/hostPlanner";
import { machineByHost, machineSshPort, type LabConfig, type LabMachine } from "./labConfig";

export interface ExecOptions {
  sudo?: boolean;
  sudoUser?: string;
  cwd?: string;
  timeoutMs?: number;
}

export type Pm2App = { name: string; pm2_env?: { status?: string; restart_time?: number } };

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * SSH/psql/PM2 helpers over the deploy `SshRunner`, addressed by machine id,
 * SSH address or private IP of any declared machine. Hosts outside the lab
 * config are refused, so a gate can never act on an undeclared machine.
 */
export class LabRemote {
  readonly runner: SshRunner;

  constructor(
    readonly config: LabConfig,
    private readonly sudoPassword: string,
    options: { dryRun?: boolean; verbose?: boolean; logger?: (message: string) => void } = {},
  ) {
    this.runner = new SshRunner({ dryRun: options.dryRun, verbose: options.verbose ?? true, logger: options.logger });
  }

  machine(hostOrId: string): LabMachine {
    const machine = this.config.machines.find((entry) => entry.id === hostOrId) ?? machineByHost(this.config, hostOrId);
    if (!machine) throw new Error(`Host '${hostOrId}' is not declared in lab '${this.config.lab.name}'`);
    return machine;
  }

  target(hostOrId: string): SshTarget {
    const machine = this.machine(hostOrId);
    return {
      host: machine.address,
      port: machineSshPort(this.config, machine),
      user: this.config.ssh.user,
      keyPath: this.config.ssh.keyPath,
      sudoPassword: this.sudoPassword,
    };
  }

  run(host: string, command: string, options: ExecOptions = {}): string {
    return this.runner.run(this.target(host), command, options).stdout;
  }

  capture(host: string, command: string, options: ExecOptions = {}): string {
    return this.runner.capture(this.target(host), command, options);
  }

  /** Runs and reports success instead of throwing (for probes). */
  tryRun(host: string, command: string, options: ExecOptions = {}): { ok: boolean; output: string } {
    try {
      return { ok: true, output: this.capture(host, command, options) };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }

  write(host: string, path: string, content: string, mode = 0o600, sudo = true): void {
    this.runner.writeRemoteFile({ target: this.target(host), path, content, mode, sudo });
  }

  psql(input: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    sql: string;
    timeoutMs?: number;
  }): string {
    const command = `PGPASSWORD=${shellQuote(input.password)} psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p ${input.port} -U ${shellQuote(input.user)} -d ${shellQuote(input.database)} -tAq -c ${shellQuote(input.sql)}`;
    return this.capture(input.host, command, { timeoutMs: input.timeoutMs ?? 120_000 });
  }

  pm2List(host: string): Pm2App[] {
    const raw = this.capture(host, '"$HOME/.bun/bin/pm2" jlist 2>/dev/null || echo "[]"');
    try {
      return JSON.parse(raw || "[]") as Pm2App[];
    } catch {
      return [];
    }
  }

  stopPm2Prefix(host: string, prefix = "pg-"): void {
    const apps = this.pm2List(host).filter((app) => app.name.startsWith(prefix));
    if (apps.length === 0) return;
    this.run(host, `"$HOME/.bun/bin/pm2" delete ${apps.map((app) => shellQuote(app.name)).join(" ")}`);
  }

  /**
   * Non-blocking variant for fault/scale actions that run while a load
   * generator shares the event loop (the sync runner would pause the
   * generator for the duration of every SSH round-trip).
   */
  runAsync(host: string, command: string, options: { sudo?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; output: string }> {
    const target = this.target(host);
    const local = isLocalTarget(target);
    const key = target.keyPath.startsWith("~/") ? resolve(homedir(), target.keyPath.slice(2)) : target.keyPath;
    const wrapped = options.sudo ? `sudo -S -p '' bash -lc ${shellQuote(command)}` : `bash -lc ${shellQuote(command)}`;
    const [file, args] = local
      ? (options.sudo ? ["sudo", ["-S", "-p", "", "bash", "-lc", command]] : ["bash", ["-lc", command]]) as [string, string[]]
      : ["ssh", ["-i", key, "-p", String(target.port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", `${target.user}@${target.host}`, wrapped]] as [string, string[]];
    return new Promise((resolvePromise) => {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.on("error", (error) => { clearTimeout(timer); resolvePromise({ ok: false, output: error.message }); });
      child.on("close", (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, output: output.trim() }); });
      child.stdin.end(options.sudo ? `${this.sudoPassword}\n` : "");
    });
  }

  /** True when the host carries the disposable-lab marker file. */
  isMarkedLabHost(host: string): boolean {
    return this.capture(host, `test -f ${shellQuote(this.config.lab.markerFile)} && echo yes || true`).trim() === "yes";
  }
}
