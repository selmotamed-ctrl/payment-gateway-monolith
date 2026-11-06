import type { SshTarget } from "./hostPlanner";
import { shellQuote } from "./quoting";

/**
 * Convergence helpers: "reload when you can, restart only when you must".
 *
 * The deploy used to restart PostgreSQL, PgBouncer and Redis unconditionally on
 * every run. PgBouncer >= 1.23 treats SIGTERM as "wait for every client to
 * disconnect", so a pool with live clients never stopped on its own and
 * systemd waited out TimeoutStopSec (90 s) before SIGKILL, three times per
 * deploy. Every builder here is pure so the exact remote script can be asserted
 * in tests; the provisioners only run them through the supplied runner.
 */

export interface ProvisionRunner {
  dryRun?: boolean;
  run(target: SshTarget, command: string, options?: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number }): unknown;
  capture(target: SshTarget, command: string, options?: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number }): string;
  /** Returns whether the content changed. Fakes may return nothing: that counts as "changed" (the safe answer). */
  writeRemoteFile(input: { target: SshTarget; path: string; content: string | Buffer; mode?: number; sudo?: boolean }): boolean | void;
}

/** A runner that does not report change detection is assumed to have changed the file. */
export const isChanged = (result: boolean | void): boolean => result !== false;

export type ApplyOutcome = "started" | "restarted" | "reloaded" | "unchanged" | "unknown";

const APPLY_MARKER = "__PG_APPLY__=";

/** Reads the outcome marker a convergence script printed. */
export const parseApplyOutcome = (output: string): ApplyOutcome => {
  const match = new RegExp(`${APPLY_MARKER}(started|restarted|reloaded|unchanged)`).exec(output);
  return (match?.[1] as ApplyOutcome | undefined) ?? "unknown";
};

/** True when the service was (re)started during this convergence, i.e. its connections were dropped. */
export const outcomeBounced = (outcome: ApplyOutcome): boolean => outcome === "started" || outcome === "restarted";

/**
 * Installs the packages that are missing and nothing else. The common case (all
 * present) is a handful of cheap local queries instead of `apt-get update` /
 * `pacman -Sy` network round-trips. On Arch `pacman -Sy <pkg>` is also a partial
 * upgrade, which is unsupported and can break the host, so only `-S --needed`
 * is used.
 */
export const ensurePackagesScript = (input: {
  debian: string[];
  arch: string[];
  /** Extra commands run after the package step regardless of what was installed (must be idempotent). */
  after?: string;
}): string => {
  const debian = input.debian.map(shellQuote).join(" ");
  const arch = input.arch.map(shellQuote).join(" ");
  return `if command -v apt-get >/dev/null 2>&1; then
  missing=""
  for p in ${debian}; do dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $p"; done
  if [ -n "$missing" ]; then apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y $missing; fi
elif command -v pacman >/dev/null 2>&1; then
  missing=""
  for p in ${arch}; do pacman -Qq "$p" >/dev/null 2>&1 || missing="$missing $p"; done
  if [ -n "$missing" ]; then pacman -S --noconfirm --needed $missing; fi
fi${input.after ? `\n${input.after}` : ""}`;
};

/** Cheap "is it already there" guard used for pinned pip installs. */
export const pipPinnedGuard = (distribution: string, version: string, installCommand: string): string =>
  `[ "$(python3 -m pip show ${shellQuote(distribution)} 2>/dev/null | awk '/^Version:/{print $2}')" = ${shellQuote(version)} ] || ${installCommand}`;

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const readyLoop = (command: string, seconds: number, label: string): string =>
  `for i in $(seq 1 ${seconds}); do ${command} >/dev/null 2>&1 && break; sleep 1; if [ "$i" = ${seconds} ]; then echo ${shellQuote(`${label} did not become ready within ${seconds}s`)} >&2; exit 1; fi; done`;

/**
 * Applies a PostgreSQL cluster's configuration with the least disruption:
 *  - inactive            -> start;
 *  - `force`             -> restart;
 *  - config/hba changed  -> reload (SIGHUP), then restart only if some setting
 *                           is `pending_restart` (postmaster-level change);
 *  - nothing changed     -> nothing.
 * It always waits for the cluster to accept connections.
 */
export const postgresApplyScript = (input: { unit: string; port: number; changed: boolean; force?: boolean }): string => {
  const unit = shellQuote(input.unit);
  const psql = `runuser -u postgres -- psql -p ${input.port} -d postgres -Atc`;
  return `set -u
unit=${unit}
if ! systemctl is-active --quiet "$unit"; then
  # A failed boot leaves the unit in start-limit-hit, where a plain start is
  # refused ("start request repeated too quickly"). Clear it before retrying.
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  systemctl enable --now "$unit" 2>/dev/null || systemctl start "$unit"
  echo ${APPLY_MARKER}started
elif [ ${input.force ? 1 : 0} = 1 ]; then
  systemctl restart "$unit"
  echo ${APPLY_MARKER}restarted
elif [ ${input.changed ? 1 : 0} = 1 ]; then
  t0=$(${psql} 'SELECT pg_conf_load_time()' 2>/dev/null || echo none)
  systemctl reload "$unit" || kill -HUP "$(systemctl show -p MainPID --value "$unit")"
  for i in $(seq 1 25); do t1=$(${psql} 'SELECT pg_conf_load_time()' 2>/dev/null || echo none); [ "$t1" != "$t0" ] && break; sleep 0.2; done
  pending=$(${psql} 'SELECT count(*) FROM pg_settings WHERE pending_restart' 2>/dev/null || echo unknown)
  if [ "$pending" != 0 ]; then systemctl restart "$unit"; echo ${APPLY_MARKER}restarted; else echo ${APPLY_MARKER}reloaded; fi
else
  echo ${APPLY_MARKER}unchanged
fi
${readyLoop(`pg_isready -h 127.0.0.1 -p ${input.port}`, 60, `PostgreSQL ${input.unit}`)}`;
};

// ---------------------------------------------------------------------------
// PgBouncer
// ---------------------------------------------------------------------------

export const PGBOUNCER_DROPIN_PATH = "/etc/systemd/system/pgbouncer.service.d/zz-pg-switch.conf";
export const PGBOUNCER_SIGNATURE_PATH = "/etc/pgbouncer/.pg-deploy-restart-signature";

/**
 * Makes `systemctl restart pgbouncer` fast and bounded. SIGINT is PgBouncer's
 * "safe shutdown": in-flight transactions finish, idle clients are dropped and
 * the process exits. The packaged default (SIGTERM) waits for every client to
 * disconnect, which core-back's long-lived pools never do.
 */
export const pgbouncerSystemdDropIn = (): string => `[Service]
KillSignal=SIGINT
TimeoutStopSec=15s
`;

/** Settings PgBouncer cannot re-read on SIGHUP: a change to any of them needs a real restart. */
const PGBOUNCER_RESTART_KEYS = ["listen_addr", "listen_port", "unix_socket_dir", "unix_socket_mode", "unix_socket_group", "so_reuseport", "pidfile", "logfile"];

/** Stable signature of the restart-only settings of a pgbouncer.ini. */
export const pgbouncerRestartSignature = (ini: string): string =>
  ini
    .split("\n")
    .map((line) => /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && PGBOUNCER_RESTART_KEYS.includes(match[1]!))
    .map((match) => `${match[1]}=${match[2]}`)
    .sort()
    .join("\n") + "\n";

/**
 * PgBouncer convergence: start if down, restart only for restart-only setting
 * changes or after the upstream PostgreSQL restarted (its server connections
 * are gone and a cached login failure would otherwise linger), reload for any
 * other change, nothing otherwise.
 */
export const pgbouncerApplyScript = (input: { port: number; daemonReload: boolean; restart: boolean; reload: boolean }): string => `set -u
${input.daemonReload ? "systemctl daemon-reload\n" : ""}if ! systemctl is-active --quiet pgbouncer; then
  systemctl enable pgbouncer >/dev/null 2>&1 || true
  systemctl start pgbouncer
  echo ${APPLY_MARKER}started
elif [ ${input.restart ? 1 : 0} = 1 ]; then
  systemctl restart pgbouncer
  echo ${APPLY_MARKER}restarted
elif [ ${input.reload ? 1 : 0} = 1 ]; then
  systemctl reload pgbouncer
  echo ${APPLY_MARKER}reloaded
else
  echo ${APPLY_MARKER}unchanged
fi
${readyLoop(`pg_isready -h 127.0.0.1 -p ${input.port}`, 30, "PgBouncer")}`;

// ---------------------------------------------------------------------------
// Redis / Valkey
// ---------------------------------------------------------------------------

export type RedisFlavor = "redis-server" | "redis" | "valkey";

/**
 * Prints the name of the installed Redis-compatible systemd unit (empty when
 * none). Only real unit files count: a symlink is an alias (Arch ships
 * `redis.service` -> `valkey.service`), `systemctl enable` refuses to operate
 * on it, and a drop-in-only directory is not a unit at all.
 */
export const redisUnitDetectScript = (): string =>
  `for u in redis-server redis valkey; do for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do if [ -f "$d/$u.service" ] && [ ! -L "$d/$u.service" ]; then echo "$u"; exit 0; fi; done; done; exit 0`;

/**
 * Redis convergence: a restart flushes the L2 cache and the velocity counters,
 * so it only happens when the configuration changed (or the service is down).
 */
export const redisApplyScript = (input: { unit: string; port: number; auth: string; changed: boolean; daemonReload: boolean }): string => {
  const unit = shellQuote(input.unit);
  const cli = `${input.auth}redis-cli -p ${input.port}`;
  return `set -u
unit=${unit}
${input.daemonReload ? "systemctl daemon-reload\n" : ""}if ! systemctl is-active --quiet "$unit"; then
  systemctl enable "$unit" >/dev/null 2>&1 || true
  systemctl start "$unit"
  echo ${APPLY_MARKER}started
elif [ ${input.changed ? 1 : 0} = 1 ]; then
  # Disable save-on-shutdown on the running instance first: under the distro
  # sandbox with a read-only dir a failing shutdown save would hang systemctl.
  ${cli} CONFIG SET save "" >/dev/null 2>&1 || true
  systemctl restart "$unit"
  echo ${APPLY_MARKER}restarted
else
  echo ${APPLY_MARKER}unchanged
fi
${readyLoop(`${cli} PING`, 30, "Redis")}`;
};

// ---------------------------------------------------------------------------
// Pooler login verification
// ---------------------------------------------------------------------------

/**
 * Proves the application can really log in and run a query THROUGH PgBouncer,
 * retrying while it works through its cached failures. PgBouncer remembers a
 * failed server login for `server_login_retry` (15 s by default): after a
 * database was dropped and recreated (restore, `--fresh`, a fresh seed) the
 * pooler answers `database "x" does not exist (server_login_retry)` until that
 * expires, and `prisma migrate deploy` run immediately afterwards fails. The
 * old deploy hid this by restarting PgBouncer unconditionally; the converged
 * deploy waits for the real condition instead. The password goes through a
 * private 0600 PGPASSFILE, never the command line.
 */
export const poolerLoginScript = (input: { port: number; database: string; user: string; pgpassLine: string; seconds?: number }): string => {
  const seconds = input.seconds ?? 45;
  return `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && printf '%s\n' ${shellQuote(input.pgpassLine)} > "$d/pgpass" && chmod 600 "$d/pgpass"
for i in $(seq 1 ${seconds}); do
  if PGPASSFILE="$d/pgpass" psql --no-password -h 127.0.0.1 -p ${input.port} -U ${shellQuote(input.user)} -d ${shellQuote(input.database)} -tAc 'SELECT 1' >/dev/null 2>"$d/err"; then exit 0; fi
  sleep 1
done
echo ${shellQuote(`PgBouncer on :${input.port} did not accept a login to ${input.database} within ${seconds}s:`)} >&2; cat "$d/err" >&2; exit 1`;
};
