#!/usr/bin/env bun
import { createBackupEngine } from "./backupEngine";
import { CatalogStore, createDefaultPolicy } from "./catalogStore";
import { SpawnCommandRunner } from "./commandRunner";
import { loadBackupDaemonConfig } from "./config";
import { RestoreDrillRunner } from "./restoreDrillRunner";
import { BackupScheduler } from "./scheduler";
import { startBackupDaemonServer } from "./server";

const main = async (): Promise<void> => {
  const config = loadBackupDaemonConfig();
  const runner = new SpawnCommandRunner({ defaultTimeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS });
  const engine = createBackupEngine(config, runner);
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
  });
  if (!catalog.isPersistent()) {
    console.warn(
      `[pg-backup-daemon] catalog is running in memory only: ${catalog.getPersistenceError() ?? "unwritable path"}`,
    );
  }

  const drillRunner = new RestoreDrillRunner({ config, engine, runner });
  const scheduler = new BackupScheduler({ config, engine, drillRunner, catalog });
  const server = await startBackupDaemonServer({ config, engine, drillRunner, catalog, scheduler });
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
    await Promise.race([Promise.all([scheduler.whenIdle(), server.whenIdle()]), new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error) => {
  console.error(`[pg-backup-daemon] fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
