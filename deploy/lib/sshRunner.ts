import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SshTarget } from "./hostPlanner";

/**
 * The remote execution engine.
 *
 * It runs every command through `ssh`, and every privileged command through
 * `sudo -S` with the password fed on stdin (never on the command line, never in
 * the process list). `rsync` moves the release trees; `writeRemoteFile` streams
 * a file over ssh stdin so a secret never touches the local disk.
 */

export interface RunnerOptions {
  dryRun?: boolean;
  /** Print the command without running it (implied by dryRun). */
  verbose?: boolean;
  logger?: (message: string) => void;
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
  /** Overridable for tests. */
  spawnImpl?: typeof spawnSync;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const expandHome = (path: string): string =>
  path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const sshArgs = (target: SshTarget): string[] => [
  "-i", expandHome(target.keyPath),
  "-p", String(target.port),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=20",
  "-o", "ServerAliveCountMax=6",
  `${target.user}@${target.host}`,
];

export class SshRunner {
  private readonly options: RunnerOptions;
  private readonly logger: (message: string) => void;

  constructor(options: RunnerOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? ((message) => console.log(message));
  }

  /** True when the runner only prints the commands. */
  get dryRun(): boolean {
    return this.options.dryRun === true;
  }

  /** Runs a command on the remote host. `sudo` wraps it in `sudo -S`. */
  run(target: SshTarget, command: string, options: { sudo?: boolean; cwd?: string } = {}): RunResult {
    const remoteCommand = options.cwd
      ? `cd ${shellQuote(options.cwd)} && ${command}`
      : command;
    const wrapped = options.sudo
      ? `sudo -S -p '' bash -lc ${shellQuote(remoteCommand)}`
      : `bash -lc ${shellQuote(remoteCommand)}`;
    const args = sshArgs(target);
    args.push(wrapped);
    if (this.options.dryRun) {
      this.logger(`[dry-run] ssh ${target.user}@${target.host} :: ${remoteCommand}${options.sudo ? " (sudo)" : ""}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (this.options.verbose) {
      this.logger(`[ssh] ${target.user}@${target.host} :: ${remoteCommand}${options.sudo ? " (sudo)" : ""}`);
    }
    const result = spawnSync("ssh", args, {
      input: options.sudo ? `${target.sudoPassword}\n` : undefined,
      encoding: "utf8",
      timeout: this.options.timeoutMs ?? 15 * 60_000,
    });
    if (result.error) {
      throw new Error(`SSH to ${target.host} failed: ${result.error.message}`);
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `Remote command failed on ${target.host} (exit ${result.status}): ${remoteCommand}\n${stderr.trim().slice(-2000)}`,
      );
    }
    return { code: result.status ?? 0, stdout, stderr };
  }

  /** Runs a command and returns its stdout, trimming the trailing newline. */
  capture(target: SshTarget, command: string, options: { sudo?: boolean; cwd?: string } = {}): string {
    return this.run(target, command, options).stdout.trim();
  }

  /** Copies a local directory to the remote host with rsync. */
  sync(input: {
    target: SshTarget;
    local: string;
    remote: string;
    delete?: boolean;
    excludes?: string[];
    sudo?: boolean;
  }): void {
    const sshCommand = `ssh -i ${expandHome(input.target.keyPath)} -p ${input.target.port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    const args = ["-az", "--info=progress2", "--partial"];
    if (input.delete) {
      args.push("--delete");
    }
    for (const exclude of input.excludes ?? ["node_modules", ".git", "dist", ".certs", "certs", "generated", "test"]) {
      args.push(`--exclude=${exclude}`);
    }
    args.push("-e", sshCommand, `${input.local.replace(/\/$/, "")}/`, `${input.target.user}@${input.target.host}:${input.remote}`);
    if (this.options.dryRun) {
      this.logger(`[dry-run] rsync ${input.local} -> ${input.target.user}@${input.target.host}:${input.remote}`);
      return;
    }
    this.logger(`[rsync] ${input.local} -> ${input.target.host}:${input.remote}`);
    const result = spawnSync("rsync", args, {
      encoding: "utf8",
      timeout: this.options.timeoutMs ?? 30 * 60_000,
    });
    if (result.error) {
      throw new Error(`rsync to ${input.target.host} failed: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`rsync to ${input.target.host} failed (exit ${result.status}): ${(result.stderr ?? "").slice(-2000)}`);
    }
  }

  /**
   * Writes a file on the remote host by streaming it over ssh stdin. The
   * content is never written to a local temporary file, so a `.env` or a
   * private key never touches the disk of the deployment workstation.
   */
  writeRemoteFile(input: {
    target: SshTarget;
    path: string;
    content: string | Buffer;
    mode?: number;
    sudo?: boolean;
  }): void {
    const mode = input.mode ?? 0o600;
    const parent = input.path.slice(0, input.path.lastIndexOf("/")) || ".";
    const command = `mkdir -p ${shellQuote(parent)} && cat > ${shellQuote(input.path)} && chmod ${mode.toString(8)} ${shellQuote(input.path)}`;
    const wrapped = input.sudo
      ? `sudo -S -p '' bash -lc ${shellQuote(command)}`
      : `bash -lc ${shellQuote(command)}`;
    if (this.options.dryRun) {
      this.logger(`[dry-run] write ${input.target.user}@${input.target.host}:${input.path} (${Buffer.byteLength(input.content)} bytes, mode ${mode.toString(8)})`);
      return;
    }
    const args = sshArgs(input.target);
    args.push(wrapped);
    const result = spawnSync("ssh", args, {
      input: input.sudo
        ? Buffer.concat([Buffer.from(`${input.target.sudoPassword}\n`), Buffer.from(input.content)])
        : Buffer.from(input.content),
      encoding: "buffer",
      timeout: this.options.timeoutMs ?? 5 * 60_000,
    });
    if (result.error) {
      throw new Error(`write ${input.path} on ${input.target.host} failed: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`write ${input.path} on ${input.target.host} failed (exit ${result.status})`);
    }
  }

  /** Verifies the SSH key exists before a deploy starts. */
  assertKeyExists(target: SshTarget): void {
    const key = expandHome(target.keyPath);
    if (!existsSync(key)) {
      throw new Error(`SSH key '${target.keyPath}' (${key}) does not exist`);
    }
  }

  /** Runs a local command (the frontend builds) and returns its stdout. */
  local(command: string, cwd: string): string {
    if (this.options.dryRun) {
      this.logger(`[dry-run] local: ${command} (cwd ${cwd})`);
      return "";
    }
    this.logger(`[local] ${command}`);
    const result = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf8", timeout: this.options.timeoutMs ?? 30 * 60_000 });
    if (result.error) {
      throw new Error(`local command failed: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`local command failed (exit ${result.status}): ${command}\n${(result.stderr ?? "").slice(-2000)}`);
    }
    return result.stdout ?? "";
  }

  /** Runs a local command and streams its output (used for the SPA builds). */
  async localStreaming(command: string, cwd: string): Promise<void> {
    if (this.options.dryRun) {
      this.logger(`[dry-run] local: ${command} (cwd ${cwd})`);
      return;
    }
    this.logger(`[local] ${command}`);
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`local command failed (exit ${code}): ${command}`))));
    });
  }
}
