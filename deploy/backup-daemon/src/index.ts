#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { createBackupEngine, type EngineDeps } from "./backupEngine";
import { RepositoryCatalogMirror } from "./catalogMirror";
import { CatalogStore, createDefaultPolicy } from "./catalogStore";
import { SpawnCommandRunner } from "./commandRunner";
import { loadBackupDaemonConfig } from "./config";
import { masterKeyFromHex } from "./cryptoEnvelope";
import { acquireInstanceLock } from "./instanceLock";
import { JobQueue } from "./jobQueue";
import { PgNativeEngine } from "./pgNativeEngine";
import { buildRepository } from "./repository";
import { RestoreDrillRunner } from "./restoreDrillRunner";
import { BackupScheduler } from "./scheduler";
import { restoreJobState } from "./startup";
import { startBackupDaemonServer } from "./server";

const main = async (): Promise<void> => {
  const config = loadBackupDaemonConfig();
  const runner = new SpawnCommandRunner({ defaultTimeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS });
  const logger = console;
  const stateDir = dirname(config.BACKUP_CATALOG_PATH);
  // One daemon per state directory: refuse to start next to a live one instead of racing it.
  const lock = await acquireInstanceLock(join(stateDir, "daemon.lock"));

  // The storage tiers exist before the catalog so a replacement host can recover its history from them.
  let repository: ReturnType<typeof buildRepository> | undefined;
  try {
    repository = buildRepository(config, runner);
  } catch (error) {
    if (config.BACKUP_ENGINE_MODE === "pg-native") throw error;
    console.warn(`[pg-backup-daemon] no artifact repository for catalog mirroring: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mirror = repository
    ? new RepositoryCatalogMirror(repository, masterKeyFromHex(config.BACKUP_ENCRYPTION_KEY_HEX), config.BACKUP_STAGING_DIR)
    : undefined;

  const catalog = await CatalogStore.load({
    path: config.BACKUP_CATALOG_PATH,
    defaultPolicy: createDefaultPolicy({
      fullCron: config.BACKUP_FULL_CRON,
      deltaCron: config.BACKUP_DELTA_CRON,
      drillCron: config.BACKUP_DRILL_CRON,
      fullRetentionDays: config.BACKUP_RETENTION_FULL_COUNT * 7,
      walRetentionDays: config.BACKUP_RETENTION_WAL_DAYS,
      alertLagSeconds: config.BACKUP_ALERT_LAG_SECONDS,
      updatedAt: new Date().toISOString(),
    }),
    onWarning: (message) => console.warn(`[pg-backup-daemon] ${message}`),
    mirror,
  });
  if (!catalog.isPersistent()) {
    console.warn(
      `[pg-backup-daemon] catalog is running in memory only: ${catalog.getPersistenceError() ?? "unwritable path"}`,
    );
  }
  if (catalog.recovered) console.log("[pg-backup-daemon] catalog recovered from the signed copy on the storage tiers");

  // Retention follows the live (maker-checker approved) policy, not the boot-time environment.
  const deps: EngineDeps = { repository, getPolicy: () => catalog.getPolicy(), logger };
  const engine = createBackupEngine(config, runner, deps);

  if (engine instanceof PgNativeEngine && catalog.listRuns(1).length === 0) {
    const rebuilt = await engine.reconstructRuns().catch(() => []);
    if (rebuilt.length > 0) {
      await catalog.importRuns(rebuilt);
      console.log(`[pg-backup-daemon] rebuilt ${rebuilt.length} backup run(s) from the repository manifests`);
    }
  }

  const jobs = new JobQueue({ logger, persistPath: join(stateDir, "idempotency-keys.json") });
  const restored = await restoreJobState(catalog, jobs);
  if (restored.interrupted.length > 0) {
    console.warn(`[pg-backup-daemon] marked ${restored.interrupted.length} interrupted run(s) FAILED after the restart`);
  }
  const drillRunner = new RestoreDrillRunner({ config, engine, runner });
  const scheduler = new BackupScheduler({ config, engine, drillRunner, catalog, jobs });
  const server = await startBackupDaemonServer({ config, engine, drillRunner, catalog, scheduler, jobs, logger });
  await engine.start?.();
  if (config.SCHEDULER_ENABLED) scheduler.start();

  console.log(
    `[pg-backup-daemon] listening on ${config.BACKUP_ALLOW_INSECURE_HTTP ? "http" : "https"}://` +
      `${config.BACKUP_DAEMON_BIND_HOST}:${config.BACKUP_DAEMON_PORT} (engine=${config.BACKUP_ENGINE_MODE})`,
  );
  console.log(
    `[pg-backup-daemon] scheduler ${config.SCHEDULER_ENABLED ? "enabled" : "disabled"} ` +
      `(tick=${config.SCHEDULER_TICK_MS}ms)`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pg-backup-daemon] received ${signal}, shutting down`);
    scheduler.stop();
    server.stop(true);
    await Promise.race([
      Promise.all([scheduler.whenIdle(), server.whenIdle()])
        .then(() => engine.stop?.())
        .then(() => Promise.all([catalog.whenMirrored(), jobs.whenPersisted()]))
        .then(() => lock.release()),
      new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
    ]);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error) => {
  console.error(`[pg-backup-daemon] fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
