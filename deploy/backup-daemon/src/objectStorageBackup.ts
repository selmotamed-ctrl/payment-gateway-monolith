import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ArtifactRepository } from "./artifactStore";
import { buildPsqlCommand } from "./backupEngine";
import type { BackupDaemonConfig } from "./config";
import { objectStorageBackupConfigured } from "./config";
import type { CommandRunner } from "./commandRunner";
import { masterKeyFromHex } from "./cryptoEnvelope";
import {
  createBlobStore,
  type BlobStore,
  type StorageBucketTier,
} from "./shared/blobStore";
import { decryptPgos1ToBuffer, InMemoryKeyProvider } from "./shared/crypto";

/**
 * Object & asset storage backup integration.
 *
 * The blob files are immutable, content-addressed `.v1.enc` envelopes, so the
 * backup is an incremental copy: only blobs the repository does not have yet
 * are transferred. After the copy, every `ACTIVE` control-plane row must have
 * its blob in the repository (parity), and the KEK keyring is escrowed
 * encrypted under the backup master key so a restore drill can decrypt a
 * sample without the production environment.
 */

export const OBJECT_BLOB_PREFIX = "object-blobs";
export const OBJECT_STORAGE_ESCROW_KEY = "object-storage/kek-escrow.enc";
/** Per-version escrow keeps old backups decryptable after a version is removed from the live keyring. */
export const objectStorageEscrowKeyForVersion = (version: number): string =>
  `object-storage/kek-escrow-v${version}.enc`;
const ESCROW_MAGIC = Buffer.from("PGOSESC1", "ascii");
const ESCROW_IV_BYTES = 12;
const ESCROW_TAG_BYTES = 16;

export interface ObjectStorageSyncResult {
  enabled: boolean;
  copiedBlobs: number;
  scannedBlobs: number;
  activeObjects: number;
  missingActive: string[];
  escrowWritten: boolean;
  reason?: string;
}

export interface ActiveStorageObject {
  id: string;
  bucket: StorageBucketTier;
  storageKey: string;
  sha256Hex: string;
  byteSize: string;
  chunkSize: number;
  chunkCount: number;
  kekKeyVersion: number;
  wrappedDekHex: string;
  dekNonceHex: string;
  streamNoncePrefixHex: string;
}

const OBJECT_STORAGE_EXISTS_QUERY = "SELECT to_regclass('public.storage_objects') IS NOT NULL;";

const ACTIVE_OBJECTS_QUERY =
  "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.\"createdAt\"), '[]'::json)::text FROM (" +
  "SELECT id::text AS \"id\", bucket::text AS \"bucket\", storage_key AS \"storageKey\", " +
  "sha256_hex AS \"sha256Hex\", byte_size::text AS \"byteSize\", chunk_size_bytes AS \"chunkSize\", " +
  "chunk_count AS \"chunkCount\", kek_key_version AS \"kekKeyVersion\", " +
  "encode(wrapped_dek, 'hex') AS \"wrappedDekHex\", encode(dek_nonce, 'hex') AS \"dekNonceHex\", " +
  "encode(stream_nonce_prefix, 'hex') AS \"streamNoncePrefixHex\", created_at::text AS \"createdAt\" " +
  "FROM storage_objects WHERE status = 'ACTIVE') t;";

/** A bounded, random sample of ACTIVE rows for the restore drill. */
export const objectStorageSampleQuery = (limit: number): string =>
  "SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (" +
  "SELECT id::text AS \"id\", bucket::text AS \"bucket\", storage_key AS \"storageKey\", " +
  "sha256_hex AS \"sha256Hex\", byte_size::text AS \"byteSize\", chunk_size_bytes AS \"chunkSize\", " +
  "chunk_count AS \"chunkCount\", kek_key_version AS \"kekKeyVersion\", " +
  "encode(wrapped_dek, 'hex') AS \"wrappedDekHex\", encode(dek_nonce, 'hex') AS \"dekNonceHex\", " +
  "encode(stream_nonce_prefix, 'hex') AS \"streamNoncePrefixHex\" " +
  `FROM storage_objects WHERE status = 'ACTIVE' ORDER BY random() LIMIT ${Math.max(0, Math.floor(limit))}) t;`;

export const objectBlobKey = (bucket: string, storageKey: string): string =>
  `${OBJECT_BLOB_PREFIX}/${bucket}/${storageKey}`;

const blobStoreFor = (config: BackupDaemonConfig): BlobStore | null => {
  if (!objectStorageBackupConfigured(config)) return null;
  return createBlobStore({
    daemonUrl: config.OBJECT_STORAGE_DAEMON_URL,
    caCertPath: config.OBJECT_STORAGE_TLS_CA_PATH,
    clientCertPath: config.OBJECT_STORAGE_TLS_CLIENT_CERT_PATH,
    clientKeyPath: config.OBJECT_STORAGE_TLS_CLIENT_KEY_PATH,
    rootDir: config.OBJECT_STORAGE_ROOT_DIR,
    // A single-host lab may keep the vault on the backup host's local disk;
    // a multi-node deployment always supplies OBJECT_STORAGE_DAEMON_URL.
    nodeEnv: config.OBJECT_STORAGE_DAEMON_URL ? "production" : "development",
    coreNodeCount: 1,
    allowInsecureHttp: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP,
  });
};

export const parseObjectStorageKeyring = (config: BackupDaemonConfig): InMemoryKeyProvider => {
  const raw = config.OBJECT_STORAGE_KEK_KEYRING.trim();
  if (!raw) {
    throw new Error("OBJECT_STORAGE_KEK_KEYRING is required for the object storage drill");
  }
  const keysByVersion = new Map<number, Buffer>();
  for (const entry of raw.split(",")) {
    const [versionPart, hexPart] = entry.trim().split(":");
    if (!versionPart || !hexPart) continue;
    const version = Number(versionPart.replace(/^v/i, ""));
    const key = Buffer.from(hexPart, "hex");
    if (!Number.isInteger(version) || version < 1 || key.byteLength !== 32) {
      throw new Error(`Invalid OBJECT_STORAGE_KEK_KEYRING entry: ${versionPart}`);
    }
    keysByVersion.set(version, key);
  }
  if (!keysByVersion.has(config.OBJECT_STORAGE_ACTIVE_KEK_VERSION)) {
    const available = [...keysByVersion.keys()].sort((left, right) => left - right);
    if (available.length === 0) throw new Error("OBJECT_STORAGE_KEK_KEYRING contains no key");
    return new InMemoryKeyProvider({ activeVersion: available[available.length - 1]!, keysByVersion });
  }
  return new InMemoryKeyProvider({ activeVersion: config.OBJECT_STORAGE_ACTIVE_KEK_VERSION, keysByVersion });
};

const escrowKey = (masterHex: string): Buffer =>
  Buffer.from(
    hkdfSync(
      "sha256",
      masterKeyFromHex(masterHex),
      Buffer.from("object-storage-kek-escrow", "utf8"),
      Buffer.from("kek-escrow", "utf8"),
      32,
    ),
  );

/** Self-describing escrow envelope: magic | iv | ciphertext | tag. */
export const sealKekEscrow = (masterHex: string, keyringJson: string): Buffer => {
  const iv = randomBytes(ESCROW_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", escrowKey(masterHex), iv);
  cipher.setAAD(ESCROW_MAGIC);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keyringJson, "utf8")), cipher.final()]);
  return Buffer.concat([ESCROW_MAGIC, iv, ciphertext, cipher.getAuthTag()]);
};

export const openKekEscrow = (masterHex: string, envelope: Buffer): string => {
  if (envelope.byteLength < ESCROW_MAGIC.byteLength + ESCROW_IV_BYTES + ESCROW_TAG_BYTES) {
    throw new Error("kek-escrow.enc is truncated");
  }
  if (!envelope.subarray(0, ESCROW_MAGIC.byteLength).equals(ESCROW_MAGIC)) {
    throw new Error("kek-escrow.enc has an invalid magic header");
  }
  const iv = envelope.subarray(ESCROW_MAGIC.byteLength, ESCROW_MAGIC.byteLength + ESCROW_IV_BYTES);
  const tagStart = envelope.byteLength - ESCROW_TAG_BYTES;
  const ciphertext = envelope.subarray(ESCROW_MAGIC.byteLength + ESCROW_IV_BYTES, tagStart);
  const tag = envelope.subarray(tagStart);
  const decipher = createDecipheriv("aes-256-gcm", escrowKey(masterHex), iv);
  decipher.setAAD(ESCROW_MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};

const runPsql = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  query: string,
): Promise<string> => {
  const command = buildPsqlCommand(config, query, config.PG_PRIMARY_DB_NAME);
  const result = await runner.run(command.command, command.args, {
    env: command.env,
    timeoutMs: command.timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(`object-storage psql query failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  }
  return result.stdout.trim();
};

export const fetchActiveStorageObjects = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
): Promise<ActiveStorageObject[] | null> => {
  const present = await runPsql(config, runner, OBJECT_STORAGE_EXISTS_QUERY);
  if (present !== "t" && present !== "true") return null;
  const raw = await runPsql(config, runner, ACTIVE_OBJECTS_QUERY);
  const parsed = JSON.parse(raw || "[]") as unknown;
  if (!Array.isArray(parsed)) throw new Error("storage_objects manifest query did not return an array");
  return parsed as ActiveStorageObject[];
};

export const syncObjectStorageBackup = async (input: {
  config: BackupDaemonConfig;
  repository: ArtifactRepository;
  runner: CommandRunner;
  blobStore?: BlobStore;
  logger?: Pick<Console, "info" | "warn" | "error">;
}): Promise<ObjectStorageSyncResult> => {
  const { config, repository, runner } = input;
  if (!objectStorageBackupConfigured(config)) {
    return {
      enabled: false,
      copiedBlobs: 0,
      scannedBlobs: 0,
      activeObjects: 0,
      missingActive: [],
      escrowWritten: false,
      reason: "object storage is not configured on the backup daemon",
    };
  }

  const blobStore = input.blobStore ?? blobStoreFor(config);
  if (!blobStore) {
    return {
      enabled: false,
      copiedBlobs: 0,
      scannedBlobs: 0,
      activeObjects: 0,
      missingActive: [],
      escrowWritten: false,
      reason: "object storage is not configured on the backup daemon",
    };
  }

  const activeObjects = await fetchActiveStorageObjects(config, runner);
  if (!activeObjects) {
    input.logger?.warn("[pg-backup-daemon] the database has no storage_objects table yet; object backup skipped");
    return {
      enabled: false,
      copiedBlobs: 0,
      scannedBlobs: 0,
      activeObjects: 0,
      missingActive: [],
      escrowWritten: false,
      reason: "schema does not contain storage_objects",
    };
  }

  let copiedBlobs = 0;
  let scannedBlobs = 0;
  for (const bucket of ["HOT", "COLD"] as StorageBucketTier[]) {
    const blobs = await blobStore.list(bucket);
    for (const blob of blobs) {
      if (!blob.relPath.endsWith(".v1.enc")) continue;
      scannedBlobs++;
      const key = objectBlobKey(bucket, blob.relPath);
      const missing = await repository.missingStores(key);
      if (missing.length === 0) continue;
      const bytes = await blobStore.readBytes(bucket, blob.relPath);
      // Repair every tier independently: a blob present only on the local tier
      // must still be copied to S3/off-site.
      for (const storeId of missing) {
        await repository.putBuffer(key, bytes, [storeId]);
      }
      copiedBlobs++;
    }
  }

  const requiredIds = new Set(repository.requiredStoreIds);
  const missingActive: string[] = [];
  if (config.OBJECT_STORAGE_VERIFY_PARITY) {
    for (const object of activeObjects) {
      const key = objectBlobKey(object.bucket, object.storageKey);
      const missing = (await repository.missingStores(key)).filter((id) => requiredIds.has(id));
      if (missing.length > 0) missingActive.push(object.id);
    }
    if (missingActive.length > 0) {
      throw new Error(
        `OBJECT_STORAGE_BACKUP_PARITY_ERROR: ${missingActive.length} ACTIVE storage object(s) have no blob in the backup repository (first: ${missingActive.slice(0, 5).join(", ")})`,
      );
    }
  }

  const keyringProvider = parseObjectStorageKeyring(config);
  const keys = Object.fromEntries(
    config.OBJECT_STORAGE_KEK_KEYRING.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [versionPart, hexPart] = entry.split(":");
        return [versionPart!.replace(/^v/i, ""), hexPart!.toLowerCase()];
      }),
  );
  // Keep one escrow per version (a later rotation must not make an older
  // backup undecryptable) plus the legacy single-file key for compatibility.
  for (const [version, hex] of Object.entries(keys)) {
    await repository.putBuffer(
      objectStorageEscrowKeyForVersion(Number(version)),
      sealKekEscrow(config.BACKUP_ENCRYPTION_KEY_HEX, JSON.stringify({ activeVersion: Number(version), keys: { [version]: hex } })),
    );
  }
  const keyringJson = JSON.stringify({ activeVersion: keyringProvider.getActiveVersion(), keys });
  await repository.putBuffer(
    OBJECT_STORAGE_ESCROW_KEY,
    sealKekEscrow(config.BACKUP_ENCRYPTION_KEY_HEX, keyringJson),
  );

  return {
    enabled: true,
    copiedBlobs,
    scannedBlobs,
    activeObjects: activeObjects.length,
    missingActive,
    escrowWritten: true,
  };
};

/**
 * The restore-drill half: samples restored control-plane rows, reads their
 * encrypted blobs from the BACKUP repository (not the live vault) and proves
 * that the escrowed keyring decrypts them to the recorded SHA-256.
 */
export const runObjectStorageDrill = async (input: {
  config: BackupDaemonConfig;
  repository: ArtifactRepository;
  /** Runs one SQL query against the restored scratch cluster and returns stdout. */
  query: (sql: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<{ ok: boolean; detail: string; sampled: number } | null> => {
  const { config, repository, query } = input;
  if (!objectStorageBackupConfigured(config)) return null;
  const present = await query("SELECT to_regclass('public.storage_objects') IS NOT NULL;");
  if (present.code !== 0) {
    return { ok: false, detail: `storage_objects presence check failed: ${(present.stderr || present.stdout).trim().slice(0, 200)}`, sampled: 0 };
  }
  if (present.stdout.trim() !== "t") {
    return { ok: true, detail: "the restored schema has no storage_objects table", sampled: 0 };
  }
  const sample = await query(objectStorageSampleQuery(config.OBJECT_STORAGE_DRILL_SAMPLE));
  if (sample.code !== 0) {
    return { ok: false, detail: `object sample query failed: ${(sample.stderr || sample.stdout).trim().slice(0, 200)}`, sampled: 0 };
  }
  const rows = JSON.parse(sample.stdout.trim() || "[]") as ActiveStorageObject[];
  if (rows.length === 0) return { ok: true, detail: "no ACTIVE storage objects to sample", sampled: 0 };

  const keyrings = new Map<number, InMemoryKeyProvider>();
  const keyringFor = async (version: number): Promise<InMemoryKeyProvider> => {
    const cached = keyrings.get(version);
    if (cached) return cached;
    const perVersion = objectStorageEscrowKeyForVersion(version);
    const escrow = await repository.getBufferVerified(perVersion, (value) => {
      JSON.parse(openKekEscrow(config.BACKUP_ENCRYPTION_KEY_HEX, value));
    }) ?? await repository.getBufferVerified(OBJECT_STORAGE_ESCROW_KEY, (value) => {
      const parsed = JSON.parse(openKekEscrow(config.BACKUP_ENCRYPTION_KEY_HEX, value)) as { keys?: Record<string, string> };
      if (!parsed.keys?.[String(version)]) throw new Error(`legacy escrow has no key version ${version}`);
    });
    if (!escrow) throw new Error(`the backup repository has no escrow for KEK version ${version}`);
    const escrowed = JSON.parse(openKekEscrow(config.BACKUP_ENCRYPTION_KEY_HEX, escrow)) as {
      activeVersion: number;
      keys: Record<string, string>;
    };
    const key = escrowed.keys[String(version)];
    if (!key) throw new Error(`escrow has no key version ${version}`);
    const provider = new InMemoryKeyProvider({
      activeVersion: version,
      keysByVersion: new Map([[version, Buffer.from(key, "hex")]]),
    });
    keyrings.set(version, provider);
    return provider;
  };

  let verified = 0;
  for (const object of rows) {
    try {
      const keyring = await keyringFor(object.kekKeyVersion);
      const ciphertext = await repository.getBufferVerified(
        objectBlobKey(object.bucket, object.storageKey),
        (value) => {
          decryptPgos1ToBuffer({
            ciphertext: value,
            objectId: object.id,
            kekKeyVersion: object.kekKeyVersion,
            wrappedDek: Buffer.from(object.wrappedDekHex, "hex"),
            dekNonce: Buffer.from(object.dekNonceHex, "hex"),
            streamNoncePrefix: Buffer.from(object.streamNoncePrefixHex, "hex"),
            expectedChunkCount: object.chunkCount,
            expectedByteSize: BigInt(object.byteSize),
            expectedSha256Hex: object.sha256Hex,
            keyProvider: keyring,
          });
        },
      );
      if (!ciphertext) {
        return { ok: false, detail: `the backup repository is missing ${object.storageKey}`, sampled: rows.length };
      }
      verified++;
    } catch (error) {
      return { ok: false, detail: `object ${object.id} failed its decryption check: ${(error as Error).message}`, sampled: rows.length };
    }
  }
  return { ok: true, detail: `decrypted and verified ${verified}/${rows.length} sampled object(s)`, sampled: rows.length };
};
