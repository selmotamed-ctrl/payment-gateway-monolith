#!/usr/bin/env bun
/**
 * PostgreSQL `restore_command` helper:  bun walFetchCli.ts <target> <wal-file> <destination-path>
 *
 * Reads the daemon's environment (inherited from the process that started the
 * scratch cluster), finds the WAL file on the first storage tier that has it,
 * decrypts it and writes it to the path PostgreSQL asked for. Exit code 1 means
 * "file not available" (PostgreSQL treats that as the end of the archive).
 * Nothing secret is ever printed.
 */
import { promises as nodeFs } from "node:fs";
import { dirname, join } from "node:path";
import { SpawnCommandRunner } from "./commandRunner";
import { loadBackupDaemonConfig } from "./config";
import { masterKeyFromHex, openToFile } from "./cryptoEnvelope";
import { buildRepository } from "./repository";
import { errorMessage, pathExists, tempSibling } from "./util";
import { walKey } from "./walArchive";
import { isArchivableWalFile, isWalSegmentName, isWalTarget } from "./walNames";

const main = async (): Promise<number> => {
  const [target, file, destination] = process.argv.slice(2);
  if (!target || !file || !destination || !isWalTarget(target) || !isArchivableWalFile(file)) {
    console.error("usage: walFetchCli.ts <postgres_core|audit_db> <wal-file> <destination>");
    return 2;
  }
  const config = loadBackupDaemonConfig();
  const repository = buildRepository(config, new SpawnCommandRunner());
  const master = masterKeyFromHex(config.BACKUP_ENCRYPTION_KEY_HEX);
  const key = walKey(target, file);

  const sealed = tempSibling(`${destination}.sealed`);
  try {
    await nodeFs.mkdir(dirname(destination), { recursive: true });
    await repository.getFile(key, sealed);
    await openToFile(sealed, destination, { master, target: `wal:${target}`, id: `wal/${file}` });
    return 0;
  } catch (error) {
    const missing = /not available on any storage tier/.test(errorMessage(error));
    if (!missing) {
      console.error(`walFetch ${file}: ${errorMessage(error).slice(0, 300)}`);
      return 3;
    }
  } finally {
    await nodeFs.rm(sealed, { force: true }).catch(() => undefined);
  }

  // The newest WAL may still be the streamed `.partial` file (pg_receivewal pre-pads it to a full segment).
  if (isWalSegmentName(file)) {
    const partial = join(config.BACKUP_WAL_SPOOL_DIR, target, `${file}.partial`);
    if (await pathExists(partial)) {
      await nodeFs.copyFile(partial, destination);
      return 0;
    }
  }
  console.error(`walFetch ${file}: not found in the archive`);
  return 1;
};

main().then((code) => process.exit(code), (error) => {
  console.error(`walFetch failed: ${errorMessage(error).slice(0, 300)}`);
  process.exit(3);
});
