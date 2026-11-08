import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  ArtifactRepository,
  LocalRepoStore,
  S3ObjectStore,
  VaultStore,
  type ArtifactStore,
  type PutOutcome,
} from "./artifactStore";
import type { CommandRunner } from "./commandRunner";
import type { BackupDaemonConfig } from "./config";
import { sealStream, type SealOptions, type SealResult } from "./cryptoEnvelope";

/** Credentials the rclone-based vault reads from the environment. */
export const rcloneEnvironment = (config: BackupDaemonConfig): Record<string, string> => {
  const env: Record<string, string> = {
    AWS_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_ENDPOINT_URL: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_ENDPOINT_URL_S3: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_S3_FORCE_PATH_STYLE: "true",
    AWS_REGION: "us-east-1",
  };
  if (config.BACKUP_PRIMARY_S3_ACCESS_KEY) env.AWS_ACCESS_KEY_ID = config.BACKUP_PRIMARY_S3_ACCESS_KEY;
  if (config.BACKUP_PRIMARY_S3_SECRET_KEY) env.AWS_SECRET_ACCESS_KEY = config.BACKUP_PRIMARY_S3_SECRET_KEY;
  return env;
};

/**
 * Builds the configured storage tiers, in restore-preference order:
 * local repository (instant drill source) -> S3/MinIO -> off-site vault.
 */
export const buildRepository = (config: BackupDaemonConfig, runner: CommandRunner): ArtifactRepository => {
  const stores: ArtifactStore[] = [];
  if (config.BACKUP_LOCAL_REPO_DIR) stores.push(new LocalRepoStore(config.BACKUP_LOCAL_REPO_DIR));
  if (config.BACKUP_PRIMARY_S3_ENDPOINT && config.BACKUP_PRIMARY_S3_BUCKET) {
    stores.push(
      new S3ObjectStore({
        endpoint: config.BACKUP_PRIMARY_S3_ENDPOINT,
        bucketSpec: config.BACKUP_PRIMARY_S3_BUCKET,
        accessKeyId: config.BACKUP_PRIMARY_S3_ACCESS_KEY,
        secretAccessKey: config.BACKUP_PRIMARY_S3_SECRET_KEY,
      }),
    );
  }
  if (config.BACKUP_SECONDARY_SSH_TARGET) {
    stores.push(
      new VaultStore({
        target: config.BACKUP_SECONDARY_SSH_TARGET,
        runner,
        allowDelete: config.BACKUP_SECONDARY_MIRROR_DELETE,
        env: rcloneEnvironment(config),
        timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
      }),
    );
  }
  if (stores.length === 0) {
    throw new Error("no backup storage tier is configured: set BACKUP_LOCAL_REPO_DIR and/or BACKUP_PRIMARY_S3_ENDPOINT + BACKUP_PRIMARY_S3_BUCKET");
  }
  return new ArtifactRepository(stores);
};

export interface SealIntoRepositoryOptions extends SealOptions {
  /** Where to build the artifact when there is no local repository tier. */
  stagingDir: string;
  /** Restrict the write to these tiers (the rest are mirrored later). */
  onlyIds?: string[];
}

/**
 * Encrypts `source` straight into the local repository (when there is one) so
 * the artifact is built once, then fans it out to the remaining tiers. A
 * failed required tier removes the half-stored artifact again: an artifact
 * without a manifest is never considered a backup.
 */
export const sealIntoRepository = async (
  repository: ArtifactRepository,
  key: string,
  source: Readable,
  options: SealIntoRepositoryOptions,
): Promise<{ seal: SealResult; outcome: PutOutcome }> => {
  const local = repository.local;
  const dest = local ? local.pathFor(key) : join(options.stagingDir, `${randomUUID()}.sealing`);
  if (!local) await nodeFs.mkdir(options.stagingDir, { recursive: true, mode: 0o700 });
  const seal = await sealStream(source, dest, options);
  try {
    const outcome = await repository.putFile(key, dest, options.onlyIds);
    return { seal, outcome };
  } catch (error) {
    await repository.delete(key).catch(() => undefined);
    throw error;
  } finally {
    if (!local) await nodeFs.rm(dest, { force: true }).catch(() => undefined);
  }
};
