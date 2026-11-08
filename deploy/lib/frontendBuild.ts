import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Frontend builds for the deploy: content-addressed (a build whose inputs did
 * not change is skipped), parallel, and started in the background so they
 * overlap with storage provisioning instead of blocking the pipeline.
 */

export const BUILD_STAMP = ".pg-build-stamp";

const IGNORED_DIRS = new Set(["node_modules", "dist", ".vite", ".turbo", "coverage", "playwright-report", "test-results", ".git"]);

/** Every file that can influence a frontend build, in a stable order. */
const sourceFiles = (root: string): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && !entry.name.endsWith(".log")) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return files;
};

/** sha256 over the frontend's source tree and the build-time environment injected by the deploy. */
export const frontendFingerprint = (frontendDir: string, buildEnv: Record<string, string>): string => {
  const hash = createHash("sha256");
  for (const file of sourceFiles(frontendDir)) {
    hash.update(`${relative(frontendDir, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  hash.update(JSON.stringify(Object.entries(buildEnv).sort(([a], [b]) => a.localeCompare(b))));
  return hash.digest("hex");
};

/** True when `dist/` exists and was built from exactly these inputs. */
export const isBuildFresh = (frontendDir: string, fingerprint: string): boolean => {
  const stamp = join(frontendDir, "dist", BUILD_STAMP);
  const index = join(frontendDir, "dist", "index.html");
  try {
    return existsSync(index) && readFileSync(stamp, "utf8").trim() === fingerprint;
  } catch {
    return false;
  }
};

export interface BuildResult {
  frontend: string;
  cached: boolean;
  ms: number;
}

export interface FrontendBuildHandle {
  /** Resolves when `frontend` is built (rejects with the log tail if its build failed). */
  wait(frontend: string): Promise<BuildResult>;
  /** Waits for every build; rejects with the first failure. */
  waitAll(): Promise<BuildResult[]>;
  /** Kills every build still running (the deploy is aborting). */
  abort(): void;
  readonly frontends: readonly string[];
}

const tail = (file: string, bytes = 4000): string => {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

/**
 * Starts the builds and returns immediately. At most `maxParallel` run at once
 * (each is itself `type-check` + `vite build`). Output goes to a log file
 * rather than a pipe, so a parent blocked in a synchronous ssh call can never
 * stall a build on a full pipe buffer.
 */
export const startFrontendBuilds = (input: {
  repoRoot: string;
  frontends: string[];
  envFor: (frontend: string) => Record<string, string>;
  /** Ignore the cache and rebuild everything (`--rebuild`). */
  force?: boolean;
  maxParallel?: number;
  logger?: (message: string) => void;
}): FrontendBuildHandle => {
  const log = input.logger ?? ((message: string) => console.log(message));
  const logDir = mkdtempSync(join(tmpdir(), "pg-build-"));
  const maxParallel = Math.max(1, input.maxParallel ?? Math.min(4, Math.ceil(cpus().length / 2)));
  const children = new Set<ChildProcess>();
  const results = new Map<string, Promise<BuildResult>>();
  const queue: Array<() => void> = [];
  let running = 0;
  let aborted = false;

  const pump = (): void => {
    while (running < maxParallel && queue.length > 0) queue.shift()!();
  };

  for (const frontend of input.frontends) {
    const dir = join(input.repoRoot, frontend);
    const env = input.envFor(frontend);
    const promise = new Promise<BuildResult>((resolve, reject) => {
      const started = Date.now();
      const fingerprint = frontendFingerprint(dir, env);
      if (!input.force && isBuildFresh(dir, fingerprint)) {
        log(`  ${frontend}: build cache hit (${fingerprint.slice(0, 12)}), skipping`);
        resolve({ frontend, cached: true, ms: Date.now() - started });
        return;
      }
      queue.push(() => {
        if (aborted) {
          reject(new Error(`${frontend} build aborted`));
          return;
        }
        running += 1;
        const logFile = join(logDir, `${frontend}.log`);
        const fd = openSync(logFile, "w");
        const child = spawn("bash", ["-lc", "bun run build"], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
        children.add(child);
        const finish = (): void => {
          closeSync(fd);
          children.delete(child);
          running -= 1;
          pump();
        };
        child.on("error", (error) => {
          finish();
          reject(error);
        });
        child.on("exit", (code) => {
          finish();
          if (code === 0) {
            try {
              // Stamp the POST-build state. Some builds regenerate tracked source
              // files (e.g. unplugin-vue-components rewrites src/components.d.ts),
              // so the pre-build fingerprint would never match on the next run.
              writeFileSync(join(dir, "dist", BUILD_STAMP), `${frontendFingerprint(dir, env)}\n`);
            } catch {
              // A missing stamp only costs a rebuild next time.
            }
            const ms = Date.now() - started;
            log(`  built ${frontend}/dist in ${(ms / 1000).toFixed(1)}s`);
            resolve({ frontend, cached: false, ms });
          } else {
            reject(new Error(`${frontend} build failed (exit ${code}); last output:\n${tail(logFile)}`));
          }
        });
      });
    });
    // A failure must surface where it is awaited, not as an unhandled rejection
    // while the (synchronous) storage steps are still running.
    promise.catch(() => undefined);
    results.set(frontend, promise);
  }
  pump();

  return {
    frontends: input.frontends,
    wait: (frontend) => {
      const promise = results.get(frontend);
      if (!promise) return Promise.reject(new Error(`no build was started for ${frontend}`));
      return promise;
    },
    waitAll: () => Promise.all([...results.values()]),
    abort: () => {
      aborted = true;
      for (const child of children) child.kill("SIGTERM");
    },
  };
};
