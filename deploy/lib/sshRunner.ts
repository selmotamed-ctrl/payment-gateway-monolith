import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
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
  /** Reuse one SSH connection per host (default true; PG_DEPLOY_SSH_MUX=0 also disables). */
  mux?: boolean;
  /** Commands slower than this are flagged in the log as they finish (default 30 s). */
  slowCommandMs?: number;
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

/**
 * Connection multiplexing: one TCP+auth handshake per host for the whole run
 * instead of one per command (a deploy issues hundreds). The control sockets
 * live in a private 0700 directory and are closed by SshRunner.close().
 */
const muxOptions = (controlDir: string | undefined): string[] =>
  controlDir
    ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir}/%C`, "-o", "ControlPersist=120"]
    : [];

const sshArgs = (target: SshTarget, controlDir?: string): string[] => [
  "-i", expandHome(target.keyPath),
  "-p", String(target.port),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=20",
  "-o", "ServerAliveCountMax=6",
  ...muxOptions(controlDir),
  `${target.user}@${target.host}`,
];

/** Markers printed by the remote write script so the caller learns whether the file changed. */
export const WRITE_CHANGED = "__PG_WRITE_CHANGED__";
export const WRITE_UNCHANGED = "__PG_WRITE_UNCHANGED__";

/** Result of an rsync run. `changed` is false when the destination already matched. */
export interface SyncResult {
  changed: boolean;
  /** Number of files created, updated or deleted. */
  files: number;
}

/** One executed command, kept for the end-of-run timing report. */
export interface CommandTiming {
  host: string;
  command: string;
  ms: number;
  sudo: boolean;
}

/** rsync `--itemize-changes` lines that represent a real change (not a directory mtime touch). */
export const countRsyncChanges = (output: string): number =>
  output.split("\n").filter((line) => /^(>f|<f|cf|hf|cd|cL|cS|cD|\*deleting)/.test(line)).length;

/**
 * Command lines are logged verbatim, and many carry credentials as inline
 * environment assignments (`PGPASSWORD=...`, `REDISCLI_AUTH=...`). Mask the
 * value of any secret-looking `NAME=value` before it reaches a log.
 */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|AUTH|API_?KEY|ACCESS_?KEY|MASTER_?KEY)[A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|)]+)/gi;
export const redactSecrets = (message: string): string => message.replace(SECRET_ASSIGNMENT, "$1=<redacted>");

/** Config keys whose value is a credential (matched by name, never by guessing at values). */
const SECRET_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|MASTER_KEY|ACCESS_KEY|ENCRYPTION_KEY|JWT|SEED_KEY)/i;

/**
 * The literal credential values in a loaded deploy config. `redactSecrets` only
 * recognises `NAME=value`; a pgpass line (`host:port:db:user:PASSWORD`) or a
 * connection URL carries the same secret in a form no name pattern can see, so
 * the runner also masks these exact values wherever they appear.
 */
export const collectSecretValues = (config: object): string[] => {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value.length >= 8 && SECRET_KEY.test(key)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
};

export class SshRunner {
  private readonly options: RunnerOptions;
  private readonly logger: (message: string) => void;
  private readonly timingLog: CommandTiming[] = [];
  private controlDir: string | undefined;
  private readonly muxTargets = new Map<string, SshTarget>();
  private secrets: string[] = [];

  constructor(options: RunnerOptions = {}) {
    this.options = options;
    const sink = options.logger ?? ((message: string) => console.log(message));
    this.logger = (message) => sink(this.scrub(message));
  }

  /** Registers literal secret values to mask in every log line, timing entry and error message. */
  addSecrets(values: readonly string[]): void {
    this.secrets = [...new Set([...this.secrets, ...values.filter((value) => value.length >= 8)])].sort((a, b) => b.length - a.length);
  }

  /** Masks `NAME=value` secrets and every registered literal secret value. */
  scrub(message: string): string {
    let out = redactSecrets(message);
    for (const secret of this.secrets) out = out.split(secret).join("<redacted>");
    return out;
  }

  /**
   * The private directory that holds the SSH control sockets, created lazily
   * on the first remote command. Disabled with PG_DEPLOY_SSH_MUX=0 or
   * `mux: false`, and never used for local targets or dry runs.
   */
  private muxDir(target: SshTarget): string | undefined {
    if (this.options.dryRun || this.options.mux === false || process.env.PG_DEPLOY_SSH_MUX === "0") return undefined;
    if (isLocalTarget(target)) return undefined;
    if (!this.controlDir) {
      this.controlDir = mkdtempSync(join(tmpdir(), "pg-ssh-"));
      chmodSync(this.controlDir, 0o700);
    }
    this.muxTargets.set(`${target.user}@${target.host}:${target.port}`, target);
    return this.controlDir;
  }

  /** Closes every multiplexed SSH master and removes the control directory. Safe to call twice. */
  close(): void {
    const dir = this.controlDir;
    if (!dir) return;
    for (const target of this.muxTargets.values()) {
      spawnSync("ssh", ["-O", "exit", ...sshArgs(target, dir)], { stdio: "ignore", timeout: 10_000 });
    }
    this.muxTargets.clear();
    rmSync(dir, { recursive: true, force: true });
    this.controlDir = undefined;
  }

  /** Every command executed so far with its wall-clock duration (the deploy's timing report). */
  get timings(): readonly CommandTiming[] {
    return this.timingLog;
  }

  /** The `count` slowest commands, slowest first. */
  slowest(count = 5): CommandTiming[] {
    return [...this.timingLog].sort((a, b) => b.ms - a.ms).slice(0, count);
  }

  private record(target: SshTarget, command: string, started: number, sudo: boolean | undefined): void {
    const ms = Date.now() - started;
    this.timingLog.push({ host: target.host, command: this.scrub(command).replace(/\s+/g, " ").slice(0, 200), ms, sudo: sudo === true });
    const threshold = this.options.slowCommandMs ?? 30_000;
    if (ms >= threshold && !this.options.dryRun) {
      this.logger(`  ! slow command (${(ms / 1000).toFixed(1)}s) on ${target.host}: ${this.scrub(command).replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }

  /** True when the runner only prints the commands. */
  get dryRun(): boolean {
    return this.options.dryRun === true;
  }

  /** Runs a command on the remote host. `sudo` wraps it in `sudo -S`. */
  run(target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): RunResult {
    const started = Date.now();
    try {
      return this.execute(target, command, options);
    } finally {
      if (!this.options.dryRun) this.record(target, command, started, options.sudo);
    }
  }

  private execute(target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number }): RunResult {
    const remoteCommand = options.cwd
      ? `cd ${shellQuote(options.cwd)} && ${command}`
      : command;
    const wrapped = options.sudo
      ? `sudo -S -p '' ${options.sudoUser ? `-u ${options.sudoUser} ` : ""}bash -lc ${shellQuote(remoteCommand)}`
      : `bash -lc ${shellQuote(remoteCommand)}`;
    const args = sshArgs(target, this.muxDir(target));
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
        throw new Error(this.scrub(`Local command failed (exit ${result.status}): ${remoteCommand}\n${(result.stderr ?? "").trim().slice(-2000)}`));
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
        this.scrub(`Remote command failed on ${target.host} (exit ${result.status}): ${remoteCommand}\n${stderr.trim().slice(-2000)}`),
      );
    }
    return { code: result.status ?? 0, stdout, stderr };
  }

  /** Runs a command and returns its stdout, trimming the trailing newline. */
  capture(target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): string {
    return this.run(target, command, options).stdout.trim();
  }

  /** Copies a local directory to the remote host with rsync and reports whether anything changed. */
  sync(input: {
    target: SshTarget;
    local: string;
    remote: string;
    delete?: boolean;
    excludes?: string[];
    sudo?: boolean;
  }): SyncResult {
    const started = Date.now();
    const control = this.muxDir(input.target);
    const sshCommand = `ssh -i ${expandHome(input.target.keyPath)} -p ${input.target.port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new${control ? ` -o ControlMaster=auto -o ControlPath=${control}/%C -o ControlPersist=120` : ""}`;
    // --itemize-changes lets the caller skip a service restart when nothing was synced.
    const args = ["-az", "--itemize-changes", "--partial", "--no-owner", "--no-group"];
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
      return { changed: true, files: 0 };
    }
    this.logger(`[rsync] ${input.local} -> ${localMode ? input.remote : input.target.host + ":" + input.remote}`);
    const result = spawnSync("rsync", args, {
      encoding: "utf8",
      timeout: this.options.timeoutMs ?? 30 * 60_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    this.record(input.target, `rsync ${input.local} -> ${input.remote}`, started, false);
    if (result.error) {
      throw new Error(`rsync to ${input.target.host} failed: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(this.scrub(`rsync to ${input.target.host} failed (exit ${result.status}): ${(result.stderr ?? "").slice(-2000)}`));
    }
    const files = countRsyncChanges(result.stdout ?? "");
    return { changed: files > 0, files };
  }

  /**
   * Writes a file on the remote host by streaming it over ssh stdin and returns
   * whether the content actually changed (`false` when the file already held
   * exactly these bytes, in which case only its mode is re-asserted). Callers
   * use the result to skip service restarts/reloads for unchanged config.
   * The content is never written to a local temporary file on remote targets,
   * so a `.env` or a private key never touches the deployment workstation.
   */
  writeRemoteFile(input: {
    target: SshTarget;
    path: string;
    content: string | Buffer;
    mode?: number;
    sudo?: boolean;
  }): boolean {
    const started = Date.now();
    try {
      return this.writeRemoteFileInner(input);
    } finally {
      if (!this.options.dryRun) this.record(input.target, `write ${input.path}`, started, input.sudo);
    }
  }

  private writeRemoteFileInner(input: {
    target: SshTarget;
    path: string;
    content: string | Buffer;
    mode?: number;
    sudo?: boolean;
  }): boolean {
    const mode = input.mode ?? 0o600;
    const modeText = mode.toString(8);
    const parent = input.path.slice(0, input.path.lastIndexOf("/")) || ".";
    // Non-sudo: write next to the destination, compare, then atomically rename.
    const command = [
      `mkdir -p ${shellQuote(parent)}`,
      `tmp=$(umask 077 && mktemp ${shellQuote(`${parent}/.pg-write.XXXXXX`)})`,
      `cat > "$tmp" || { rm -f "$tmp"; exit 1; }`,
      `if cmp -s "$tmp" ${shellQuote(input.path)}; then rm -f "$tmp"; chmod ${modeText} ${shellQuote(input.path)}; echo ${WRITE_UNCHANGED}; else chmod ${modeText} "$tmp" && mv -f "$tmp" ${shellQuote(input.path)} && echo ${WRITE_CHANGED}; fi`,
    ].join("; ");
    // With sudo, the first stdin line is the password and the rest is the
    // file. The remote script reads the password line itself and installs a
    // temporary copy with a single `sudo` call, so the password can never end
    // up in the written file. (Previously `sudo -S bash -c 'cat > file'` was fed
    // password+content: with NOPASSWD sudo or a cached sudo timestamp, sudo
    // did not consume the password line and it became line 1 of the file.)
    const installScript = `if cmp -s "$1" "$2"; then chmod "$3" "$2"; echo ${WRITE_UNCHANGED}; else install -D -m "$3" "$1" "$2" && echo ${WRITE_CHANGED}; fi`;
    const sudoScript = [
      "IFS= read -r PG_SUDO_PW",
      "tmp=$(umask 077 && mktemp)",
      "cat > \"$tmp\" || { rm -f \"$tmp\"; exit 1; }",
      `printf '%s\\n' "$PG_SUDO_PW" | sudo -S -p '' bash -c ${shellQuote(installScript)} _ "$tmp" ${shellQuote(input.path)} ${modeText}`,
      "rc=$?",
      "rm -f \"$tmp\"",
      "exit $rc",
    ].join("; ");
    const wrapped = input.sudo
      ? `bash -c ${shellQuote(sudoScript)}`
      : `bash -lc ${shellQuote(command)}`;
    if (this.options.dryRun) {
      this.logger(`[dry-run] write ${input.target.user}@${input.target.host}:${input.path} (${Buffer.byteLength(input.content)} bytes, mode ${modeText})`);
      return true;
    }
    if (isLocalTarget(input.target)) {
      const incoming = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
      if (input.sudo) {
        // Write the content to a local temp file first and install it with
        // sudo. The sudo password is never mixed with the file bytes: a
        // cached sudo timestamp would otherwise leave the password line at the
        // top of the installed file.
        // A private 0700 directory (mkdtemp) holds the 0600 file; both are removed in `finally`.
        const privateDir = mkdtempSync(join(tmpdir(), "pg-deploy-"));
        chmodSync(privateDir, 0o700);
        const temporary = join(privateDir, "payload");
        writeFileSync(temporary, incoming, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        try {
          const args = ["-S", "-p", "", "bash", "-c", installScript, "_", temporary, input.path, modeText];
          const result = spawnSync("sudo", args, {
            input: `${input.target.sudoPassword}\n`,
            encoding: "utf8",
            timeout: this.options.timeoutMs ?? 5 * 60_000,
          });
          if ((result.status ?? 1) !== 0) {
            throw new Error(this.scrub(`write ${input.path} locally failed (exit ${result.status}): ${(result.stderr ?? "").slice(-1000)}`));
          }
          return !(result.stdout ?? "").includes(WRITE_UNCHANGED);
        } finally {
          rmSync(privateDir, { recursive: true, force: true });
        }
      }
      mkdirSync(dirname(input.path), { recursive: true });
      let unchanged = false;
      try {
        unchanged = existsSync(input.path) && readFileSync(input.path).equals(incoming);
      } catch {
        unchanged = false;
      }
      if (!unchanged) writeFileSync(input.path, incoming, { mode });
      chmodSync(input.path, mode);
      return !unchanged;
    }
    const args = sshArgs(input.target, this.muxDir(input.target));
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
    return !Buffer.from(result.stdout ?? "").toString("utf8").includes(WRITE_UNCHANGED);
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
