import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scaleNodes, sshLoopbackEnv } from "./env";
import type { DeployRun, ScenarioResult, StressContext } from "./harness";
import { startAvailabilityProbe, startDbLoad } from "./probes";

export interface Scenario {
  id: string;
  title: string;
  /** What breaks in production if this scenario fails. */
  why: string;
  /** Needs --destructive (drops databases). */
  destructive?: boolean;
  run(ctx: StressContext): Promise<void>;
}

const OK = (run: DeployRun): string => (run.ok ? "" : `exit ${run.code}; see ${run.logFile}`);
const find = (run: DeployRun, fragment: string): string | undefined => run.outcomes.find((entry) => entry.service.includes(fragment))?.outcome;

const EDGE_URLS = ["http://127.0.0.1:8080/api/health", "http://127.0.0.1:8081/api/health", "http://127.0.0.1:8082/api/health", "http://127.0.0.1:8444/health"];

/** Deploys the base config and asserts it converged cleanly. Used as warm-up and as recovery. */
const converge = async (ctx: StressContext, name: string, args = ["--update"]): Promise<DeployRun> => {
  const run = await ctx.deploy({ name, args });
  ctx.check(`${name}: deploy succeeds`, run.ok, OK(run));
  return run;
};

// ---------------------------------------------------------------------------

const noopRedeploy: Scenario = {
  id: "noop-redeploy",
  title: "Repeated no-op redeploys bounce nothing and finish fast",
  why: "The original bug: every deploy restarted PgBouncer (3 x 90 s), PostgreSQL and Redis, dropping connections and flushing the cache.",
  async run(ctx) {
    await converge(ctx, "warmup");
    const before = ctx.snapshot();
    const sentinel = `sentinel-${Date.now()}`;
    ctx.redis(`SET stress:sentinel ${sentinel}`);
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(20) });
    const iterations = ctx.scale(3);
    for (let i = 1; i <= iterations; i += 1) {
      const run = await ctx.deploy({ name: `noop-${i}`, args: ["--update"] });
      ctx.measure(`no-op deploy #${i}`, run.ms / 1000, "s");
      ctx.check(`#${i} deploy succeeds`, run.ok, OK(run));
      ctx.check(`#${i} finishes within budget`, run.ms <= ctx.budget(90), `${(run.ms / 1000).toFixed(1)}s`);
      ctx.check(`#${i} starts/restarts no service`, run.bounced.length === 0, run.bounced.join(", "));
      ctx.check(`#${i} flags no slow command`, run.slowCommands === 0, `${run.slowCommands} slow command(s)`);
      const changed = ctx.diff(before, ctx.snapshot());
      ctx.check(`#${i} no service identity changed`, changed.length === 0, changed.join(", "));
    }
    ctx.check("Redis cache survived (sentinel key still there)", ctx.redis("GET stress:sentinel").trim() === sentinel);
    ctx.redis("DEL stress:sentinel");
    const summary = await load.stop();
    ctx.measure("db queries during no-op deploys", summary.queries, "queries");
    ctx.check("DB clients saw zero errors during no-op deploys", summary.errors === 0, `${summary.errors} errors, max outage ${summary.maxOutageMs}ms`);
  },
};

const pgbouncerReload: Scenario = {
  id: "pgbouncer-reload",
  title: "A PgBouncer config change is applied by reload, without dropping clients",
  why: "Pool-size tuning used to cost a full restart (up to 90 s) and an outage for every connected client.",
  async run(ctx) {
    await converge(ctx, "warmup");
    const before = ctx.snapshot();
    const current = Number(ctx.base.get("PGBOUNCER_DEFAULT_POOL_SIZE") ?? "20");
    const bumped = String(current + 5);
    const since = Math.floor(Date.now() / 1000);
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(20) });
    ctx.onCleanup(async () => {
      await ctx.restoreBase();
    });
    const run = await ctx.deploy({ name: "pool-bump", overrides: { PGBOUNCER_DEFAULT_POOL_SIZE: bumped }, args: ["--update", "--only=storage"] });
    ctx.check("deploy succeeds", run.ok, OK(run));
    ctx.check("PgBouncer reported `reloaded`", find(run, "pgbouncer") === "reloaded", `got ${find(run, "pgbouncer")}`);
    ctx.check("PgBouncer process was not replaced", ctx.diff(before, ctx.snapshot()).length === 0, ctx.diff(before, ctx.snapshot()).join(", "));
    const sighups = Number(ctx.sh(`journalctl -u pgbouncer --since @${since} --no-pager 2>/dev/null | grep -c 'got SIGHUP' || true`).trim() || "0");
    ctx.check("PgBouncer re-read its config (SIGHUP in journal)", sighups >= 1, `${sighups} SIGHUPs`);
    ctx.check("new pool size is on disk", ctx.sh("grep -E '^default_pool_size' /etc/pgbouncer/pgbouncer.ini").includes(bumped));
    const summary = await load.stop();
    ctx.check("zero client errors across the reload", summary.errors === 0, `${summary.errors} errors, max outage ${summary.maxOutageMs}ms`);
    const restored = await ctx.restoreBase();
    ctx.check("restoring the original pool size is also a reload", find(restored, "pgbouncer") === "reloaded", `got ${find(restored, "pgbouncer")}`);
    ctx.check("original pool size restored", ctx.sh("grep -E '^default_pool_size' /etc/pgbouncer/pgbouncer.ini").includes(String(current)));
  },
};

const pgbouncerRestartUnderLoad: Scenario = {
  id: "pgbouncer-restart-under-load",
  title: "A forced PgBouncer + PostgreSQL restart with live pooled clients completes in seconds",
  why: "Regression guard for the 90 s SIGTERM hang: PgBouncer >= 1.23 waits for every client to disconnect on SIGTERM.",
  async run(ctx) {
    await converge(ctx, "warmup");
    ctx.onCleanup(async () => {
      await ctx.restoreBase();
    });
    // (a) the systemd unit by itself, independent of the deploy engine
    const direct = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(30) });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const t0 = Date.now();
    ctx.sh("systemctl restart pgbouncer", { timeoutMs: 120_000 });
    const direct_ms = Date.now() - t0;
    ctx.measure("systemctl restart pgbouncer with 30 live clients", direct_ms / 1000, "s");
    ctx.check("unit restart is fast (was 90 s with the stock SIGTERM)", direct_ms < ctx.budget(15), `${(direct_ms / 1000).toFixed(1)}s`);
    ctx.check("unit stops on SIGINT (drop-in active)", ctx.sh("systemctl show pgbouncer -p KillSignal --value").trim() === "2");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const directSummary = await direct.stop();
    ctx.check("all clients reconnected after the unit restart", directSummary.unrecovered === 0, `${directSummary.unrecovered} stuck`);
    ctx.measure("longest client outage (unit restart)", directSummary.maxOutageMs / 1000, "s");

    // (b) the deploy engine's forced restart of the whole DB tier
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(30) });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const run = await ctx.deploy({ name: "force-restart", args: ["--update", "--only=pg", "--force-restart"] });
    ctx.measure("deploy --force-restart (PostgreSQL + PgBouncer)", run.ms / 1000, "s");
    ctx.check("deploy succeeds", run.ok, OK(run));
    ctx.check("finishes within budget (3 x 90 s before)", run.ms <= ctx.budget(60), `${(run.ms / 1000).toFixed(1)}s`);
    ctx.check("PostgreSQL restarted", find(run, "postgresql") === "restarted", `got ${find(run, "postgresql")}`);
    ctx.check("PgBouncer restarted", find(run, "pgbouncer") === "restarted", `got ${find(run, "pgbouncer")}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const summary = await load.stop();
    ctx.check("every client recovered", summary.unrecovered === 0, `${summary.unrecovered} stuck`);
    ctx.measure("longest client outage (full DB-tier restart)", summary.maxOutageMs / 1000, "s");
    ctx.check("outage bounded", summary.maxOutageMs <= ctx.budget(30), `${summary.maxOutageMs}ms`);
  },
};

const postgresPendingRestart: Scenario = {
  id: "postgres-pending-restart",
  title: "A postmaster-level setting restarts PostgreSQL exactly once; a reloadable one never does",
  why: "The engine now decides reload vs restart from pg_settings.pending_restart instead of always restarting.",
  async run(ctx) {
    await converge(ctx, "warmup");
    const sharedBuffers = ctx.psql("show shared_buffers");
    ctx.onCleanup(async () => {
      await ctx.restoreBase();
    });
    const before = ctx.snapshot();
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(20) });
    // PG_RAM_GB=16 -> shared_buffers 4GB: needs a restart
    const resized = await ctx.deploy({ name: "ram-16", overrides: { PG_RAM_GB: "16" }, args: ["--update", "--only=storage"] });
    ctx.check("deploy succeeds", resized.ok, OK(resized));
    const mid = ctx.snapshot();
    ctx.check("PostgreSQL restarted once for shared_buffers", ctx.diff(before, mid).includes("pg_start"), `reported ${find(resized, "postgresql")}`);
    ctx.check("shared_buffers now 4GB", ctx.psql("show shared_buffers").trim() === "4GB", ctx.psql("show shared_buffers"));
    ctx.check("nothing left pending_restart", mid.pg_pending_restart === "0", mid.pg_pending_restart);
    ctx.check("PgBouncer followed the restart", ctx.diff(before, mid).includes("pgbouncer"));
    // the same config again: nothing to do
    const again = await ctx.deploy({ name: "ram-16-again", overrides: { PG_RAM_GB: "16" }, args: ["--update", "--only=storage"] });
    ctx.check("redeploying the same config bounces nothing", again.ok && again.bounced.length === 0, again.bounced.join(", "));
    ctx.check("...and the postmaster is the same process", ctx.diff(mid, ctx.snapshot()).length === 0);
    // back to the original
    const restored = await ctx.restoreBase();
    ctx.check("restore succeeds", restored.ok, OK(restored));
    ctx.check(`shared_buffers back to ${sharedBuffers.trim()}`, ctx.psql("show shared_buffers").trim() === sharedBuffers.trim(), ctx.psql("show shared_buffers"));
    ctx.check("nothing pending_restart after restore", ctx.snapshot().pg_pending_restart === "0");
    const summary = await load.stop();
    ctx.check("every client recovered after both restarts", summary.unrecovered === 0, `${summary.unrecovered} stuck`);
    ctx.measure("longest client outage across two PG restarts", summary.maxOutageMs / 1000, "s");
  },
};

const redisConfigChange: Scenario = {
  id: "redis-config-change",
  title: "Redis restarts only when its config changes (the cache survives every other deploy)",
  why: "A restart flushes the L2 cache and the velocity counters; it used to happen on every deploy.",
  async run(ctx) {
    await converge(ctx, "warmup");
    const sentinel = `sentinel-${Date.now()}`;
    ctx.redis(`SET stress:sentinel ${sentinel}`);
    const before = ctx.snapshot();
    ctx.onCleanup(async () => {
      await ctx.restoreBase();
    });
    const same = await ctx.deploy({ name: "redis-same", args: ["--update", "--only=redis"] });
    ctx.check("unchanged redeploy succeeds", same.ok, OK(same));
    ctx.check("unchanged config: no Redis restart", ctx.snapshot().redis_run_id === before.redis_run_id);
    ctx.check("unchanged config: cache key survived", ctx.redis("GET stress:sentinel").trim() === sentinel);
    const original = ctx.base.get("REDIS_MAXMEMORY") ?? "1gb";
    const smaller = original === "512mb" ? "768mb" : "512mb";
    const changed = await ctx.deploy({ name: "redis-maxmem", overrides: { REDIS_MAXMEMORY: smaller }, args: ["--update", "--only=redis"] });
    ctx.check("changed redeploy succeeds", changed.ok, OK(changed));
    const after = ctx.snapshot();
    ctx.check("changed config: Redis restarted", after.redis_run_id !== before.redis_run_id, `outcome ${find(changed, ctx.redisUnit())}`);
    const maxmemory = Number(ctx.redis("CONFIG GET maxmemory").split("\n")[1]?.trim() ?? "0");
    ctx.check(`maxmemory is now ${smaller}`, maxmemory === (smaller === "512mb" ? 512 : 768) * 1024 * 1024, String(maxmemory));
    const restored = await ctx.restoreBase();
    ctx.check("restore succeeds", restored.ok, OK(restored));
    const mem = Number(ctx.redis("CONFIG GET maxmemory").split("\n")[1]?.trim() ?? "0");
    ctx.check(`maxmemory restored to ${original}`, mem === 1024 ** 3 * (original.endsWith("gb") ? Number(original.slice(0, -2)) : Number(original.slice(0, -2)) / 1024), String(mem));
  },
};

interface Fault {
  id: string;
  describe: string;
  inject(ctx: StressContext): void;
  /** Which service the next deploy is expected to bring back (substring of the outcome key). */
  expectStarted?: (ctx: StressContext) => string[];
  verify?(ctx: StressContext, run: DeployRun): void;
}

const FAULTS: Fault[] = [
  { id: "pgbouncer-killed", describe: "kill -9 PgBouncer", inject: (c) => void c.sh("systemctl kill -s KILL pgbouncer; sleep 1"), expectStarted: () => ["pgbouncer"] },
  { id: "postgres-stopped", describe: "stop PostgreSQL", inject: (c) => void c.sh(`systemctl stop ${c.pgUnit}`), expectStarted: (c) => [c.pgUnit, "pgbouncer"] },
  { id: "redis-stopped", describe: "stop Redis", inject: (c) => void c.sh(`systemctl stop ${c.redisUnit()}`), expectStarted: (c) => [c.redisUnit()] },
  { id: "minio-stopped", describe: "stop MinIO", inject: (c) => void c.sh("systemctl stop minio"), verify: (c) => void c.check("MinIO is serving again", c.unitActive("minio")) },
  {
    id: "backup-daemon-stopped",
    describe: "stop the backup daemon",
    inject: (c) => void c.sh("systemctl stop pg-backup-daemon"),
    verify: (c, run) => {
      c.check("daemon reported started", /backup daemon started/.test(run.output));
      c.check("daemon is active again", c.unitActive("pg-backup-daemon"));
    },
  },
  {
    id: "pgbouncer-ini-corrupted",
    describe: "overwrite pgbouncer.ini with garbage",
    inject: (c) => void c.sh("printf 'garbage = yes\\n' > /etc/pgbouncer/pgbouncer.ini"),
    verify: (c) => void c.check("pgbouncer.ini restored", c.sh("grep -c '^pool_mode = transaction' /etc/pgbouncer/pgbouncer.ini").trim() === "1"),
  },
  {
    id: "pgbouncer-dropin-removed",
    describe: "delete the PgBouncer fast-stop drop-in and restart signature",
    inject: (c) => void c.sh("rm -f /etc/systemd/system/pgbouncer.service.d/zz-pg-switch.conf /etc/pgbouncer/.pg-deploy-restart-signature && systemctl daemon-reload"),
    verify: (c) => void c.check("drop-in restored (SIGINT stop)", c.sh("systemctl show pgbouncer -p KillSignal --value").trim() === "2"),
  },
  {
    id: "postgres-conf-edited",
    describe: "hand-edit postgresql.conf (max_connections)",
    inject: (c) => void c.sh(`sed -i 's/^max_connections = .*/max_connections = 120/' /etc/postgresql/18/main/postgresql.conf`),
    verify: (c) => void c.check("max_connections restored to 300 (file and live)", c.psql("show max_connections").trim() === "300"),
  },
  {
    id: "pg-hba-edited",
    describe: "hand-edit pg_hba.conf",
    inject: (c) => void c.sh(`printf '# tampered\\n' >> /etc/postgresql/18/main/pg_hba.conf`),
    verify: (c) => void c.check("pg_hba.conf restored (no tamper marker)", c.sh("grep -c tampered /etc/postgresql/18/main/pg_hba.conf || true").trim() === "0"),
  },
];

const chaosRecovery: Scenario = {
  id: "chaos-recovery",
  title: "The deploy converges every service back from a broken or tampered state",
  why: "An idempotent deploy must repair drift, not only create things.",
  async run(ctx) {
    await converge(ctx, "warmup");
    for (const fault of FAULTS) {
      ctx.note(`fault: ${fault.describe}`);
      fault.inject(ctx);
      const run = await ctx.deploy({ name: `chaos-${fault.id}`, args: ["--update"] });
      ctx.check(`${fault.id}: deploy succeeds`, run.ok, OK(run));
      for (const service of fault.expectStarted?.(ctx) ?? []) {
        const outcome = run.outcomes.find((entry) => entry.service.includes(service))?.outcome;
        ctx.check(`${fault.id}: ${service} brought back`, outcome === "started" || outcome === "restarted", `got ${outcome}`);
      }
      fault.verify?.(ctx, run);
      const snap = ctx.snapshot();
      ctx.check(`${fault.id}: PostgreSQL, PgBouncer, Redis, MinIO and the daemon are all up`, ctx.unitActive(ctx.pgUnit) && ctx.unitActive("pgbouncer") && ctx.unitActive(ctx.redisUnit()) && ctx.unitActive("minio") && ctx.unitActive("pg-backup-daemon"));
      ctx.check(`${fault.id}: nothing pending_restart`, snap.pg_pending_restart === "0", snap.pg_pending_restart);
      ctx.check(`${fault.id}: every pg- app online`, !/:(stopped|errored)/.test(snap.pg_apps), snap.pg_apps);
    }
    // After all of that the system must be quiet again.
    const before = ctx.snapshot();
    const quiet = await ctx.deploy({ name: "chaos-quiet", args: ["--update"] });
    ctx.check("final no-op deploy succeeds", quiet.ok, OK(quiet));
    ctx.check("final no-op deploy bounces nothing", quiet.bounced.length === 0, quiet.bounced.join(", "));
    ctx.check("final snapshot unchanged", ctx.diff(before, ctx.snapshot()).length === 0);
  },
};

const deployUnderTraffic: Scenario = {
  id: "deploy-under-traffic",
  title: "A full deploy under database and portal traffic",
  why: "Measures what users and the database actually see while a release goes out.",
  async run(ctx) {
    await converge(ctx, "warmup");
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(30) });
    const probe = startAvailabilityProbe(EDGE_URLS);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const run = await ctx.deploy({ name: "under-traffic", args: ["--update"] });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const probes = await probe.stop();
    const summary = await load.stop();
    ctx.measure("deploy duration", run.ms / 1000, "s");
    ctx.check("deploy succeeds", run.ok, OK(run));
    ctx.check("database clients saw zero errors", summary.errors === 0, `${summary.errors} errors`);
    for (const entry of probes) {
      ctx.measure(`outage ${entry.url.replace("http://127.0.0.1:", ":")}`, entry.maxOutageMs / 1000, "s");
      ctx.check(`${entry.url} outage bounded`, entry.maxOutageMs <= ctx.budget(20), `${entry.maxOutageMs}ms over ${entry.requests} requests`);
    }
  },
};

const labKeyPath = (): string => process.env.STRESS_SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519_pg_lab_matrix");

const sshTransport: Scenario = {
  id: "ssh-transport",
  title: "The whole deploy over the real ssh + sudo-over-ssh + rsync-over-ssh path",
  why: "On this single machine every target is 'local' and never exercises ssh; 127.0.0.2 does.",
  async run(ctx) {
    const key = labKeyPath();
    if (!existsSync(key)) throw new SkipScenario(`ssh key ${key} not found (set STRESS_SSH_KEY)`);
    const probe = ctx.tryShell(`ssh -i ${key} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes ${ctx.sudoTarget.user}@127.0.0.2 true`, { sudo: false });
    if (!probe.ok) throw new SkipScenario(`cannot ssh to 127.0.0.2 with ${key}: ${probe.out.slice(0, 120)}`);
    await converge(ctx, "warmup");
    const envText = sshLoopbackEnv(ctx.baseText, { keyPath: key });
    const first = await ctx.deploy({ name: "ssh-1", envText, args: ["--update"] });
    ctx.check("first deploy over ssh succeeds", first.ok, OK(first));
    ctx.check("it really used ssh (not the local shortcut)", (first.output.match(/\[ssh\]/g) ?? []).length > 20 && !/\[local\] /.test(first.output.split("Provision storage")[1] ?? ""), "no [ssh] lines");
    const before = ctx.snapshot();
    const second = await ctx.deploy({ name: "ssh-2", envText, args: ["--update"] });
    ctx.measure("no-op deploy over ssh (multiplexed)", second.ms / 1000, "s");
    ctx.check("no-op deploy over ssh succeeds", second.ok, OK(second));
    ctx.check("no-op deploy over ssh bounces nothing", second.bounced.length === 0 && ctx.diff(before, ctx.snapshot()).length === 0, second.bounced.join(", "));
    const plain = await ctx.deploy({ name: "ssh-nomux", envText, args: ["--update"], extraEnv: { PG_DEPLOY_SSH_MUX: "0" } });
    ctx.measure("no-op deploy over ssh (no multiplexing)", plain.ms / 1000, "s");
    ctx.check("no-mux deploy succeeds", plain.ok, OK(plain));
    ctx.check("multiplexing is not slower than a connection per command", second.ms <= plain.ms * 1.25, `${(second.ms / 1000).toFixed(1)}s vs ${(plain.ms / 1000).toFixed(1)}s`);
    const leftovers = ctx.sh("ps -eo args | grep -cE '[s]sh .*ControlPath=/tmp/pg-ssh-' || true", { sudo: false }).trim(); // [s] keeps the grep from matching its own command line
    ctx.check("no ssh control master left running after the deploy", Number(leftovers || "0") === 0, `${leftovers} lingering`);
  },
};

const multiNodeRolling: Scenario = {
  id: "multi-node-rolling",
  title: "Two nodes per tier: a rolling deploy keeps every portal up",
  why: "Rolling batches only help if the other node serves while one restarts.",
  async run(ctx) {
    await converge(ctx, "warmup");
    let envText = ctx.baseText;
    for (const variable of ["CORE_NODES", "ADMIN_NODES", "MERCHANT_NODES", "CHECKOUT_NODES"]) envText = scaleNodes(envText, variable, 2);
    ctx.onCleanup(async () => {
      await ctx.restoreBase(["--update"]);
    });
    const scaleUp = await ctx.deploy({ name: "scale-up", envText, args: ["--update", "--rolling-batch=1"] });
    ctx.check("scaling to two nodes per tier succeeds", scaleUp.ok, OK(scaleUp));
    if (!scaleUp.ok) return;
    const apps = ctx.snapshot().pg_apps;
    ctx.check("both nodes of every tier are online", ["core-1", "core-2", "admin-1", "admin-2", "merch-1", "merch-2", "chk-1", "chk-2"].every((id) => apps.includes(id)), apps);
    const probe = startAvailabilityProbe(EDGE_URLS.slice(0, 3));
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(20) });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const rolling = await ctx.deploy({ name: "rolling", envText, args: ["--update", "--rolling-batch=1"] });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const probes = await probe.stop();
    const summary = await load.stop();
    ctx.measure("rolling deploy duration", rolling.ms / 1000, "s");
    ctx.check("rolling deploy succeeds", rolling.ok, OK(rolling));
    ctx.check("rolling batches of one were used", /rolling batch 1\/2/.test(rolling.output));
    ctx.check("database clients saw zero errors", summary.errors === 0, `${summary.errors}`);
    for (const entry of probes) {
      ctx.measure(`outage ${entry.url.replace("http://127.0.0.1:", ":")}`, entry.maxOutageMs / 1000, "s");
      ctx.check(`${entry.url} stays up during the rolling deploy`, entry.maxOutageMs <= ctx.budget(5), `${entry.maxOutageMs}ms`);
    }
    const down = await ctx.deploy({ name: "scale-down", args: ["--update"] });
    ctx.check("scaling back down succeeds", down.ok, OK(down));
    const left = ctx.snapshot().pg_apps;
    ctx.check("the second nodes were retired", !/-2:/.test(left) && !left.includes("core-2"), left);
  },
};

class SkipScenario extends Error {}

const freshDatabaseStressSeed: Scenario = {
  id: "fresh-database-stress-seed",
  title: "Empty databases -> full deploy with Fake Rails and the STRESS synthetic seed -> backup",
  why: "The slow, realistic path: schema from scratch, seeders, then a real backup of the seeded data.",
  destructive: true,
  async run(ctx) {
    await converge(ctx, "warmup");
    const seedKey = `stress-${Date.now()}`;
    ctx.note("dropping the application, audit and log databases and flushing Redis");
    for (const database of [ctx.target.dbName, ctx.base.get("AUDIT_DB_NAME") ?? "pg_audit_db", ctx.base.get("LOG_DB_NAME") ?? "pg_logs_db"]) {
      ctx.psql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    ctx.redis("FLUSHALL");
    ctx.onCleanup(async () => {
      await ctx.restoreBase(["--update"]);
    });
    const run = await ctx.deploy({
      name: "fresh-seed",
      overrides: { SYNTHETIC_SEED_KEY: seedKey, RUN_SYNTHETIC_HISTORY_SEED: "true", SYNTHETIC_SEED_PROFILE: ctx.base.get("SYNTHETIC_SEED_PROFILE") ?? "STRESS" },
      args: ["--update", "--rebuild"],
      skipBuild: false,
      timeoutMs: 3 * 60 * 60_000,
    });
    ctx.measure("fresh deploy + seed", run.ms / 60_000, "min");
    ctx.check("deploy from empty databases succeeds", run.ok, OK(run));
    if (!run.ok) return;
    ctx.check("synthetic history was seeded", /synthetic history seeded/.test(run.output), "seed line missing");
    const size = ctx.psql(`select pg_size_pretty(pg_database_size('${ctx.target.dbName}'))`);
    ctx.note(`application database size after seeding: ${size.trim()}`);
    const rows = ctx.psql("select relname||'='||n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 5", ctx.target.dbName);
    ctx.note(`largest tables: ${rows.replace(/\n/g, ", ")}`);
    ctx.check("the schema holds real data", Number(ctx.psql("select coalesce(sum(n_live_tup),0) from pg_stat_user_tables", ctx.target.dbName).trim()) > 100_000);
    const trigger = ctx.tryShell("/usr/local/bin/pg-backup-daemon-trigger full postgres_core", { timeoutMs: 20 * 60_000 });
    ctx.check("a full backup of the seeded database succeeds through the daemon", trigger.ok, trigger.out.slice(0, 200));
    const after = await ctx.deploy({ name: "post-seed-noop", args: ["--update"] });
    ctx.check("a no-op deploy after the seed bounces nothing", after.ok && after.bounced.length === 0, after.bounced.join(", "));
  },
};

const soak: Scenario = {
  id: "soak",
  title: "Randomised fault + deploy cycles, again and again",
  why: "Idempotency and repair must hold in any order, not just in the scripted ones.",
  async run(ctx) {
    await converge(ctx, "warmup");
    const load = startDbLoad({ repoRoot: ctx.options.repoRoot, target: ctx.target, workers: ctx.scale(15) });
    const iterations = ctx.scale(6);
    ctx.note(`seed ${ctx.options.seed}, ${iterations} iterations`);
    for (let i = 1; i <= iterations; i += 1) {
      const fault = ctx.pick(FAULTS);
      fault.inject(ctx);
      const run = await ctx.deploy({ name: `soak-${i}-${fault.id}`, args: ["--update"] });
      ctx.check(`#${i} ${fault.id}: deploy succeeds`, run.ok, OK(run));
      fault.verify?.(ctx, run);
      ctx.check(`#${i} ${fault.id}: all storage services up`, ctx.unitActive(ctx.pgUnit) && ctx.unitActive("pgbouncer") && ctx.unitActive(ctx.redisUnit()) && ctx.unitActive("minio") && ctx.unitActive("pg-backup-daemon"));
      ctx.check(`#${i} ${fault.id}: nothing pending_restart`, ctx.snapshot().pg_pending_restart === "0");
    }
    const before = ctx.snapshot();
    const quiet = await ctx.deploy({ name: "soak-quiet", args: ["--update"] });
    ctx.check("closing no-op deploy bounces nothing", quiet.ok && quiet.bounced.length === 0 && ctx.diff(before, ctx.snapshot()).length === 0, quiet.bounced.join(", "));
    const summary = await load.stop();
    ctx.check("every DB client ended healthy", summary.unrecovered === 0, `${summary.unrecovered} stuck`);
    ctx.measure("queries served across the soak", summary.queries, "queries");
    ctx.measure("longest single-client outage", summary.maxOutageMs / 1000, "s");
  },
};

export const SCENARIOS: Scenario[] = [
  noopRedeploy,
  pgbouncerReload,
  pgbouncerRestartUnderLoad,
  postgresPendingRestart,
  redisConfigChange,
  chaosRecovery,
  deployUnderTraffic,
  sshTransport,
  multiNodeRolling,
  soak,
  freshDatabaseStressSeed,
];

export { SkipScenario };
export type { ScenarioResult };
