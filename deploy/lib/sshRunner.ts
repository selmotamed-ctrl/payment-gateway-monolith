import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** True when the SSH target is the machine the orchestrator runs on. */
export const isLocalTarget = (target: SshTarget): boolean => {
  const host = target.host.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.address === host) return true;
    }
  }
  return false;
};

/**
 * The account that owns files for a target. Remote targets use the SSH user;
 * local targets run commands as the orchestrator's OS user, so a configured
 * SSH name that does not exist locally must not be used for chown/install.
 */
export const effectiveTargetUser = (target: SshTarget): string =>
  isLocalTarget(target) ? userInfo().username : target.user;

export const effectiveTargetHome = (target: SshTarget): string =>
  isLocalTarget(target) ? userInfo().homedir : `/home/${target.user}`;

import { shellQuote } from "./quoting";
export { shellQuote };

const sshArgs = (target: SshTarget): string[] => [
  "-i", expandHome(target.keyPath),
  "-p", String(target.port),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=20",
  "-o", "ServerAliveCountMax=6",
  `${target.user}@${target.host}`,
];

/**
 * Command lines are logged verbatim, and many carry credentials as inline
 * environment assignments (`PGPASSWORD=...`, `REDISCLI_AUTH=...`). Mask the
 * value of any secret-looking `NAME=value` before it reaches a log.
 */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|AUTH|API_?KEY|ACCESS_?KEY|MASTER_?KEY)[A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|)]+)/gi;
export const redactSecrets = (message: string): string => message.replace(SECRET_ASSIGNMENT, "$1=<redacted>");

export class SshRunner {
  private readonly options: RunnerOptions;
  private readonly logger: (message: string) => void;

  constructor(options: RunnerOptions = {}) {
    this.options = options;
    const sink = options.logger ?? ((message: string) => console.log(message));
    this.logger = (message) => sink(redactSecrets(message));
  }

  /** True when the runner only prints the commands. */
  get dryRun(): boolean {
    return this.options.dryRun === true;
  }

  /** Runs a command on the remote host. `sudo` wraps it in `sudo -S`. */
  run(target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): RunResult {
    const remoteCommand = options.cwd
      ? `cd ${shellQuote(options.cwd)} && ${command}`
      : command;
    const wrapped = options.sudo
      ? `sudo -S -p '' ${options.sudoUser ? `-u ${options.sudoUser} ` : ""}bash -lc ${shellQuote(remoteCommand)}`
      : `bash -lc ${shellQuote(remoteCommand)}`;
    const args = sshArgs(target);
    args.push(wrapped);
    if (this.options.dryRun) {
      this.logger(`[dry-run] ssh ${target.user}@${target.host} :: ${remoteCommand}${options.sudo ? " (sudo)" : ""}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (isLocalTarget(target)) {
      if (this.options.verbose) {
        this.logger(`[local] ${remoteCommand}${options.sudo ? " (sudo)" : ""}`);
      }
      const result = options.sudo
        ? spawnSync("sudo", ["-S", "-p", "", ...(options.sudoUser ? ["-u", options.sudoUser] : []), "bash", "-lc", remoteCommand], {
            input: `${target.sudoPassword}\n`,
            encoding: "utf8",
            timeout: options.timeoutMs ?? this.options.timeoutMs ?? 15 * 60_000,
            cwd: options.cwd,
          })
        : spawnSync("bash", ["-lc", remoteCommand], {
            encoding: "utf8",
            timeout: options.timeoutMs ?? this.options.timeoutMs ?? 15 * 60_000,
            cwd: options.cwd,
          });
      if (result.error) throw new Error(`Local command failed: ${result.error.message}`);
      if ((result.status ?? 1) !== 0) {
        throw new Error(`Local command failed (exit ${result.status}): ${remoteCommand}\n${(result.stderr ?? "").trim().slice(-2000)}`);
      }
      return { code: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
    if (this.options.verbose) {
      this.logger(`[ssh] ${target.user}@${target.host} :: ${remoteCommand}${options.sudo ? " (sudo)" : ""}`);
    }
    const result = spawnSync("ssh", args, {
      input: options.sudo ? `${target.sudoPassword}\n` : undefined,
      encoding: "utf8",
      timeout: options.timeoutMs ?? this.options.timeoutMs ?? 15 * 60_000,
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
  capture(target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): string {
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
    const args = ["-az", "--info=progress2", "--partial", "--no-owner", "--no-group"];
    if (input.delete) {
      args.push("--delete");
    }
    for (const exclude of input.excludes ?? ["node_modules", ".git", "dist", ".certs", "certs", "generated", "test"]) {
      args.push(`--exclude=${exclude}`);
    }
    const localMode = isLocalTarget(input.target);
    if (!localMode) {
      args.push("-e", sshCommand, `${input.local.replace(/\/$/, "")}/`, `${input.target.user}@${input.target.host}:${input.remote}`);
    } else {
      args.push(`${input.local.replace(/\/$/, "")}/`, input.remote);
    }
    if (this.options.dryRun) {
      this.logger(`[dry-run] rsync ${input.local} -> ${localMode ? input.remote : `${input.target.user}@${input.target.host}:${input.remote}`}`);
      return;
    }
    this.logger(`[rsync] ${input.local} -> ${localMode ? input.remote : input.target.host + ":" + input.remote}`);
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
    // With sudo, the first stdin line is the password and the rest is the
    // file. The remote script reads the password line itself and installs a
    // temporary copy with `sudo install`, so the password can never end up in
    // the written file. (Previously `sudo -S bash -c 'cat > file'` was fed
    // password+content: with NOPASSWD sudo or a cached sudo timestamp, sudo
    // did not consume the password line and it became line 1 of the file.)
    const sudoScript = [
      "IFS= read -r PG_SUDO_PW",
      "tmp=$(umask 077 && mktemp)",
      "cat > \"$tmp\" || { rm -f \"$tmp\"; exit 1; }",
      `printf '%s\\n' "$PG_SUDO_PW" | sudo -S -p '' install -D -m ${mode.toString(8)} "$tmp" ${shellQuote(input.path)}`,
      "rc=$?",
      "rm -f \"$tmp\"",
      "exit $rc",
    ].join("; ");
    const wrapped = input.sudo
      ? `bash -c ${shellQuote(sudoScript)}`
      : `bash -lc ${shellQuote(command)}`;
    if (this.options.dryRun) {
      this.logger(`[dry-run] write ${input.target.user}@${input.target.host}:${input.path} (${Buffer.byteLength(input.content)} bytes, mode ${mode.toString(8)})`);
      return;
    }
    if (isLocalTarget(input.target)) {
      if (input.sudo) {
        // Write the content to a local temp file first and install it with
        // sudo. The sudo password is never mixed with the file bytes: a
        // cached sudo timestamp would otherwise leave the password line at the
        // top of the installed file.
        // A private 0700 directory (mkdtemp) holds the 0600 file; both are removed in `finally`.
        const privateDir = mkdtempSync(join(tmpdir(), "pg-deploy-"));
        chmodSync(privateDir, 0o700);
        const temporary = join(privateDir, "payload");
        writeFileSync(temporary, input.content, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        try {
          const args = ["-S", "-p", "", "install", "-D", "-m", mode.toString(8), temporary, input.path];
          const result = spawnSync("sudo", args, {
            input: `${input.target.sudoPassword}\n`,
            encoding: "utf8",
            timeout: this.options.timeoutMs ?? 5 * 60_000,
          });
          if ((result.status ?? 1) !== 0) {
            throw new Error(`write ${input.path} locally failed (exit ${result.status}): ${(result.stderr ?? "").slice(-1000)}`);
          }
        } finally {
          rmSync(privateDir, { recursive: true, force: true });
        }
      } else {
        mkdirSync(dirname(input.path), { recursive: true });
        writeFileSync(input.path, input.content, { mode });
        chmodSync(input.path, mode);
      }
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
    if (isLocalTarget(target)) return;
    const key = expandHome(target.keyPath);
    if (!existsSync(key)) {
      throw new Error(`SSH key '${target.keyPath}' (${key}) does not exist`);
    }
  }

  /** Runs a local command (the frontend builds) and returns its stdout. */
  local(command: string, cwd: string, env: Record<string, string> = {}): string {
    if (this.options.dryRun) {
      this.logger(`[dry-run] local: ${command} (cwd ${cwd})`);
      return "";
    }
    this.logger(`[local] ${command}`);
    const result = spawnSync("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: this.options.timeoutMs ?? 30 * 60_000,
    });
    if (result.error) {
      throw new Error(`local command failed: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`local command failed (exit ${result.status}): ${command}\n${(result.stderr ?? "").slice(-2000)}`);
    }
    return result.stdout ?? "";
  }

  /** Runs a local command and streams its output (used for the SPA builds). */
  async localStreaming(command: string, cwd: string, env: Record<string, string> = {}): Promise<void> {
    if (this.options.dryRun) {
      this.logger(`[dry-run] local: ${command} (cwd ${cwd})`);
      return;
    }
    this.logger(`[local] ${command}`);
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`local command failed (exit ${code}): ${command}`))));
    });
  }
}
