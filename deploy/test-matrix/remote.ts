import { SshRunner } from "../lib/sshRunner";
import type { SshTarget } from "../lib/hostPlanner";
import { labSshTarget } from "./hosts";
import type { LabHostsConfig } from "./types";

export interface ExecOptions {
  sudo?: boolean;
  sudoUser?: string;
  cwd?: string;
  timeoutMs?: number;
}

export class LabRemote {
  readonly runner: SshRunner;

  constructor(readonly lab: LabHostsConfig, options: { dryRun?: boolean; verbose?: boolean } = {}) {
    this.runner = new SshRunner({ dryRun: options.dryRun, verbose: options.verbose ?? true });
  }

  target(host: string, user?: string): SshTarget {
    return labSshTarget(this.lab, host, user);
  }

  run(host: string, command: string, options: ExecOptions = {}): string {
    return this.runner.run(this.target(host), command, options).stdout;
  }

  capture(host: string, command: string, options: ExecOptions = {}): string {
    return this.runner.capture(this.target(host), command, options);
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
    tupleOnly?: boolean;
    timeoutMs?: number;
  }): string {
    const flags = input.tupleOnly === false ? "-tAq" : "-tAqc";
    const command = `PGPASSWORD=${shellQuote(input.password)} psql -h 127.0.0.1 -p ${input.port} -U ${input.user} -d ${input.database} ${flags} ${shellQuote(input.sql)}`;
    return this.capture(input.host, command, { timeoutMs: input.timeoutMs ?? 120_000 });
  }

  pm2List(host: string): Array<{ name: string; pm2_env?: { status?: string; restart_time?: number } }> {
    const raw = this.capture(host, '"$HOME/.bun/bin/pm2" jlist 2>/dev/null || echo "[]"');
    try {
      return JSON.parse(raw || "[]") as Array<{ name: string; pm2_env?: { status?: string; restart_time?: number } }>;
    } catch {
      return [];
    }
  }

  stopPm2Prefix(host: string, prefix = "pg-"): void {
    const apps = this.pm2List(host).filter((app) => app.name.startsWith(prefix));
    if (apps.length === 0) return;
    this.run(host, `"$HOME/.bun/bin/pm2" delete ${apps.map((app) => app.name).join(" ")}`);
  }
}

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
