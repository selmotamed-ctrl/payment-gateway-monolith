/**
 * Edge launcher for HTTP parity runs.
 *
 * Starts one edge (TS or Rust) on a free loopback port with an explicit environment map, waits
 * for `/health`, exposes a small HTTP client, and stops it cleanly.
 *
 * Selection: `EDGE_UNDER_TEST=ts|rs` (overridable per call). `ts` runs the real Bun service:
 *
 *     bun <channel>-back/index.ts
 *
 * `rs` runs, in order:
 *   1. `backend-rs/target/release/<channel>-edge serve` when the binary exists.
 *   2. `cargo run -p <channel>-edge -- serve` otherwise.
 *
 * The fallback is for developer machines that have a warm cargo cache; `cargo run` compiles the
 * binary on first use. This harness never invokes `cargo build` itself. For CI, build the release
 * binaries first (`cargo build --release -p checkout-edge -p merchant-edge -p admin-edge`) so the
 * run is deterministic and fast.
 *
 * The launcher does not invent edge configuration. The caller supplies the full map (core URL,
 * mTLS material, ports). `replay.ts` builds the minimal map each TS edge requires; see its
 * `edgeEnvironment` helper and the harness README for the TLS requirement.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export type EdgeChannel = "checkout" | "merchant" | "admin";
export type EdgeImplementation = "ts" | "rs";

export const EDGE_CHANNELS: readonly EdgeChannel[] = ["checkout", "merchant", "admin"];

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  bodyText: string;
}

export interface EdgeHandle {
  channel: EdgeChannel;
  implementation: EdgeImplementation;
  baseUrl: string;
  port: number;
  pid: number;
  /** The command line as launched (for logs and PARITY.md evidence). */
  command: string[];
  request: (pathOrUrl: string, init?: RequestInit) => Promise<RawHttpResponse>;
  logs: () => string[];
  stop: () => Promise<void>;
}

export interface StartEdgeOptions {
  channel: EdgeChannel;
  /** Full environment for the child. Must contain `CORE_BACK_URL` and the mTLS paths for TS. */
  env: Record<string, string>;
  /** Defaults to `EDGE_UNDER_TEST` (or `ts`). */
  implementation?: EdgeImplementation;
  /** Defaults to a free loopback port. */
  port?: number;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  logLimit?: number;
  cwd?: string;
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const BACKEND_RS_ROOT = path.join(REPO_ROOT, "backend-rs");

export const repoRoot = (): string => REPO_ROOT;

export const isEdgeChannel = (value: string): value is EdgeChannel =>
  (EDGE_CHANNELS as readonly string[]).includes(value);

export const resolveImplementation = (value?: string): EdgeImplementation => {
  if (value === undefined || value.length === 0) return "ts";
  if (value === "ts" || value === "rs") return value;
  throw new Error(`EDGE_UNDER_TEST must be "ts" or "rs", received "${value}"`);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("could not allocate a free port"));
      });
    });
  });

const stringEnv = (source: Record<string, string | undefined>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
};

const bunBinary = (): string => {
  const executable = process.execPath;
  return path.basename(executable).startsWith("bun") ? executable : "bun";
};

const rustPackage = (channel: EdgeChannel): string => `${channel}-edge`;

const releaseBinary = (channel: EdgeChannel): string =>
  path.join(BACKEND_RS_ROOT, "target", "release", rustPackage(channel));

export interface EdgeCommand {
  command: string[];
  cwd: string;
  /** True when the release binary was absent and `cargo run` is used. */
  cargoFallback: boolean;
}

export const edgeCommand = (channel: EdgeChannel, implementation: EdgeImplementation): EdgeCommand => {
  if (implementation === "ts") {
    return {
      command: [bunBinary(), path.join(REPO_ROOT, `${channel}-back`, "index.ts")],
      cwd: REPO_ROOT,
      cargoFallback: false,
    };
  }
  const release = releaseBinary(channel);
  if (fs.existsSync(release)) {
    return { command: [release, "serve"], cwd: BACKEND_RS_ROOT, cargoFallback: false };
  }
  return {
    command: ["cargo", "run", "-q", "-p", rustPackage(channel), "--", "serve"],
    cwd: BACKEND_RS_ROOT,
    cargoFallback: true,
  };
};

interface LogBuffer {
  lines: string[];
  push: (line: string) => void;
  text: () => string;
}

const createLogBuffer = (limit: number): LogBuffer => {
  const lines: string[] = [];
  return {
    lines,
    push: (line) => {
      lines.push(line);
      if (lines.length > limit) lines.splice(0, lines.length - limit);
    },
    text: () => lines.join("\n"),
  };
};

const pump = async (
  stream: ReadableStream<Uint8Array> | null,
  tag: string,
  buffer: LogBuffer,
): Promise<void> => {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      let index = pending.indexOf("\n");
      while (index >= 0) {
        buffer.push(`${tag}${pending.slice(0, index)}`);
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
    }
    if (pending.length > 0) buffer.push(`${tag}${pending}`);
  } catch {
    // The pipe closes when the child exits; the exit path reports the real failure.
  }
};

const fetchHealth = async (baseUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
    });
    return response.status === 200;
  } catch {
    return false;
  }
};

const readResponse = async (response: Response): Promise<RawHttpResponse> => {
  const buffer = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers.entries()) {
    const key = name.toLowerCase();
    const current = headers[key];
    if (current === undefined) headers[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else headers[key] = [current, value];
  }
  if (typeof response.headers.getSetCookie === "function") {
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies.length === 1 ? cookies[0]! : cookies;
  }
  return {
    status: response.status,
    headers,
    body: buffer,
    bodyText: buffer.toString("utf8"),
  };
};

const killProcessTree = (handle: EdgeHandle, signal: NodeJS.Signals): void => {
  try {
    if (process.platform !== "win32") process.kill(-handle.pid, signal);
    else process.kill(handle.pid, signal);
  } catch {
    // Already gone.
  }
};

export interface EdgeUnderTest {
  implementation: EdgeImplementation;
  value: string;
}

/** `EDGE_UNDER_TEST` as read from the environment, for callers that want to print it. */
export const edgeUnderTest = (): EdgeUnderTest => ({
  implementation: resolveImplementation(process.env.EDGE_UNDER_TEST),
  value: process.env.EDGE_UNDER_TEST ?? "ts",
});

export const startEdge = async (options: StartEdgeOptions): Promise<EdgeHandle> => {
  const implementation = options.implementation ?? resolveImplementation(process.env.EDGE_UNDER_TEST);
  const port = options.port ?? (await freePort());
  const cwd = options.cwd ?? REPO_ROOT;
  const command = edgeCommand(options.channel, implementation);
  const log = createLogBuffer(options.logLimit ?? 300);

  const env: Record<string, string> = {
    ...stringEnv(process.env),
    ...stringEnv(options.env),
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    // admin-back listens on ADMIN_BIND_HOST rather than BIND_HOST.
    ADMIN_BIND_HOST: "127.0.0.1",
    NODE_ENV: options.env.NODE_ENV ?? "development",
  };
  if (implementation === "rs") env.RUST_LOG ??= "info";

  log.push(`$ ${command.command.join(" ")} (cwd ${command.cwd})`);
  if (command.cargoFallback) {
    log.push(
      "release binary missing: falling back to `cargo run` (may compile; the harness does not run cargo build)",
    );
  }

  const proc = Bun.spawn({
    cmd: command.command,
    cwd: command.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: process.platform !== "win32",
  });

  void pump(proc.stdout as ReadableStream<Uint8Array> | null, "[out] ", log);
  void pump(proc.stderr as ReadableStream<Uint8Array> | null, "[err] ", log);

  const baseUrl = `http://127.0.0.1:${port}`;
  const handle: EdgeHandle = {
    channel: options.channel,
    implementation,
    baseUrl,
    port,
    pid: proc.pid,
    command: command.command,
    request: async (pathOrUrl, init) => {
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
      const response = await fetch(url, { redirect: "manual", ...init });
      return readResponse(response);
    },
    logs: () => log.lines.slice(),
    stop: async () => {
      killProcessTree(handle, "SIGTERM");
      const timeout = options.stopTimeoutMs ?? 5000;
      const exited = await Promise.race([
        proc.exited.then(() => true),
        delay(timeout).then(() => false),
      ]);
      if (!exited) {
        killProcessTree(handle, "SIGKILL");
        await Promise.race([proc.exited, delay(2000)]);
      }
    },
  };

  const deadline = Date.now() + (options.healthTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await fetchHealth(baseUrl)) return handle;
    // Surface an early exit immediately instead of waiting out the health timeout.
    const exited = await Promise.race([
      proc.exited.then(() => true),
      delay(150).then(() => false),
    ]);
    if (exited) {
      await handle.stop();
      throw new Error(
        `edge ${options.channel} (${implementation}) exited before /health answered\n${log.text()}`,
      );
    }
  }

  await handle.stop();
  throw new Error(
    `edge ${options.channel} (${implementation}) did not answer /health on ${baseUrl} within ${
      options.healthTimeoutMs ?? 30_000
    } ms\n${log.text()}`,
  );
};

/** Waits for a URL's `/health` without owning the process (used by ad-hoc probes). */
export const waitForHealth = async (
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchHealth(baseUrl)) return true;
    await delay(150);
  }
  return false;
};
