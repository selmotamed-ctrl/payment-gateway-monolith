import { promises as nodeFs } from "node:fs";
import { dirname } from "node:path";
import { errorMessage, isNotFound } from "./util";

/**
 * One daemon per state directory. Two daemons sharing a catalog, a job queue and a repository would run
 * overlapping `pg_basebackup`/`pg_ctl` processes and race on the same scratch directory, which the
 * in-process queue cannot prevent. The lock is a pid file: a live holder blocks a second start, a stale
 * one (crash, power loss) is taken over.
 *
 * Scope: this protects a state directory on ONE host. Two hosts pointed at the same S3 bucket are not
 * detected and remain unsupported.
 */
export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export interface InstanceLockDeps {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Command line of a pid, to tell a recycled pid from our daemon. null when unknown. */
  commandLine?: (pid: number) => Promise<string | null>;
  clock?: () => Date;
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultCommandLine = async (pid: number): Promise<string | null> => {
  try {
    return (await nodeFs.readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
  } catch {
    return null;
  }
};

export interface HeldLock {
  path: string;
  release: () => Promise<void>;
}

export const acquireInstanceLock = async (path: string, deps: InstanceLockDeps = {}): Promise<HeldLock> => {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const commandLine = deps.commandLine ?? defaultCommandLine;
  const now = (deps.clock ?? (() => new Date()))().toISOString();
  await nodeFs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ pid, startedAt: now });

  /**
   * The lock must appear with its content already in it. Creating the file and writing afterwards leaves a window
   * in which a second starter reads an EMPTY file, calls it stale, deletes it, and both end up "holding" the lock.
   * So: write a private temp file, then link() it into place (atomic, fails with EEXIST if the lock exists).
   */
  const tryCreate = async (): Promise<boolean> => {
    const temp = `${path}.${pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await nodeFs.writeFile(temp, mine, { mode: 0o600, flag: "wx" });
    try {
      await nodeFs.link(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await nodeFs.rm(temp, { force: true }).catch(() => undefined);
    }
  };

  const readHolder = async (): Promise<{ raw: string; pid?: number; startedAt?: string } | null> => {
    try {
      const raw = await nodeFs.readFile(path, "utf8");
      try {
        return { raw, ...(JSON.parse(raw) as { pid?: number; startedAt?: string }) };
      } catch {
        return { raw };
      }
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const heldLock = (): HeldLock => ({
    path,
    release: async () => {
      // Only remove our own lock: after a takeover the file belongs to someone else.
      const holder = await readHolder();
      if (holder?.pid === pid) await nodeFs.rm(path, { force: true });
    },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await tryCreate()) {
      // Verify we really are the holder (a concurrent stale takeover may have replaced the file).
      if ((await readHolder())?.pid === pid) return heldLock();
      continue;
    }
    const holder = await readHolder();
    if (holder === null) continue; // released between our attempts
    if (typeof holder.pid === "number" && holder.pid !== pid && isAlive(holder.pid)) {
      const command = await commandLine(holder.pid);
      // A recycled pid belongs to some unrelated program: only a bun/daemon process counts as a live holder.
      if (command === null || /bun|pg-backup/i.test(command)) {
        throw new InstanceLockError(
          `another pg-backup-daemon (pid ${holder.pid}, started ${holder.startedAt ?? "unknown"}) holds ${path}; ` +
            "two daemons on one state directory would run overlapping backups and drills",
        );
      }
    }
    // Stale (dead holder, recycled pid, or genuinely corrupt content). Remove it ONLY if it is still the very
    // content we judged stale: if another starter already replaced it, that one owns the lock now.
    const again = await readHolder();
    if (again !== null && again.raw === holder.raw) {
      try {
        await nodeFs.rm(path, { force: true });
      } catch (error) {
        throw new InstanceLockError(`cannot clear the stale lock ${path}: ${errorMessage(error)}`);
      }
    }
  }
  throw new InstanceLockError(`could not acquire ${path}`);
};
