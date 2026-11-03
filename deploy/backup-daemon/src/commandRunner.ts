export interface RunOptions {
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Every external command goes through this interface. Engines and the restore
 * drill never touch Bun.spawn directly, which keeps command construction pure
 * and lets tests use a deterministic fake.
 */
export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export interface DryRunRecord {
  command: string;
  args: string[];
  envKeys: string[];
  timeoutMs?: number;
}

export class CommandTimeoutError extends Error {
  public readonly code = 124;
  public readonly command: string;
  public readonly args: string[];
  public readonly stdout: string;
  public readonly stderr: string;

  constructor(
    command: string,
    args: string[],
    timeoutMs: number,
    stdout: string,
    stderr: string,
  ) {
    super(`command timed out after ${timeoutMs}ms: ${command}`);
    this.name = "CommandTimeoutError";
    this.command = command;
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

interface SpawnOptionsLike {
  env: Record<string, string | undefined>;
  stdin: Blob | "ignore";
  stdout: "pipe";
  stderr: "pipe";
  signal: AbortSignal;
  killSignal: "SIGKILL";
}

export interface SpawnedProcessLike {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export type SpawnFn = (argv: string[], options: SpawnOptionsLike) => SpawnedProcessLike;

const defaultSpawn: SpawnFn = (argv, options) =>
  Bun.spawn(argv, options) as unknown as SpawnedProcessLike;

export interface SpawnCommandRunnerOptions {
  dryRun?: boolean;
  defaultTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  onCommand?: (record: DryRunRecord) => void;
  spawn?: SpawnFn;
}

/**
 * The production runner. Arguments are passed as an argv array, so there is no
 * shell involved and no opportunity for interpolation or injection.
 */
export class SpawnCommandRunner implements CommandRunner {
  public readonly recorded: DryRunRecord[] = [];
  private readonly dryRun: boolean;
  private readonly defaultTimeoutMs?: number;
  private readonly baseEnv?: Record<string, string | undefined>;
  private readonly onCommand?: (record: DryRunRecord) => void;
  private readonly spawn: SpawnFn;

  constructor(options: SpawnCommandRunnerOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.baseEnv = options.env;
    this.onCommand = options.onCommand;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  public async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const envKeys = Object.keys(options.env ?? {});
    if (this.dryRun) {
      const record: DryRunRecord = { command, args: [...args], envKeys, timeoutMs };
      this.recorded.push(record);
      this.onCommand?.(record);
      return { code: 0, stdout: "", stderr: "" };
    }

    const timeoutSignal = new AbortController();
    const proc = this.spawn([command, ...args], {
      env: { ...(this.baseEnv ?? process.env), ...(options.env ?? {}) },
      stdin: options.input !== undefined ? new Blob([options.input]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: timeoutSignal.signal,
      killSignal: "SIGKILL",
    });

    let timedOut = false;
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            timeoutSignal.abort();
          }, timeoutMs)
        : undefined;

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) {
        throw new CommandTimeoutError(command, [...args], timeoutMs ?? 0, stdout, stderr);
      }
      return { code, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
