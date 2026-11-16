import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadDeployConfig, objectStorageConfigured } from "../lib/configSchema";
import { deployObjectStorageDaemon, uploadStorageCertificates } from "../deploy";
import { planHosts } from "../lib/hostPlanner";
import { buildPki, certFilesForHost } from "../lib/pkiManager";
import { objectStorageCoreEnv } from "../lib/hostPlanner";
import {
  objectStorageDaemonEnv,
  objectStorageDaemonSystemdUnit,
  provisionObjectStorageEngine,
} from "../provisioners/objectStorageProvisioner";
import { ArtifactRepository, type ArtifactStore, type StoreHealth } from "../backup-daemon/src/artifactStore";
import { validateBackupDaemonConfig } from "../backup-daemon/src/config";
import type { CommandResult, CommandRunner } from "../backup-daemon/src/commandRunner";
import {
  objectBlobKey,
  OBJECT_STORAGE_ESCROW_KEY,
  runObjectStorageDrill,
  syncObjectStorageBackup,
  type ActiveStorageObject,
} from "../backup-daemon/src/objectStorageBackup";
import { encryptBufferToPgos1, InMemoryKeyProvider } from "../backup-daemon/src/shared/crypto";
import { FsBlobStore } from "../backup-daemon/src/shared/blobStore";

const BASE = `
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_KEY_PATH="~/.ssh/db"
DB_PRIVATE_IP="10.10.0.10"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.0.10:5432/gateway"
CORE_SSH_HOST="10.10.0.20"
CORE_SSH_KEY_PATH="~/.ssh/core"
CORE_PRIVATE_IP="10.10.0.20"
ADMIN_SSH_HOST="10.10.0.30"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
ADMIN_PRIVATE_IP="10.10.0.30"
MERCHANT_SSH_HOST="203.0.113.10"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_PRIVATE_IP="10.10.0.40"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_SSH_HOST="203.0.113.20"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_PRIVATE_IP="10.10.0.50"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
`;

const OBJECT_STORAGE = `
OBJECT_STORAGE_ENABLED="true"
OBJECT_STORAGE_MANAGE_VIA_SSH="true"
OBJECT_STORAGE_NODE="obj-1@10.10.14.10:22:10.10.14.10:4095"
OBJECT_STORAGE_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_obj_storage"
OBJECT_STORAGE_SUDO_PASSWORD="object-storage-sudo-K7p2Zq9w"
OBJECT_STORAGE_KEK_KEYRING="v1:7e1f4b9a3c6d2058e1a7b4c9d3f6082a5b1c8e4d7a0f3b6c9e2d5a8f1b4c7e03"
OBJECT_STORAGE_ACTIVE_KEK_VERSION="1"
`;

const requireConfig = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

describe("shared blob store copies stay identical", () => {
  test("the daemon and backup-daemon copies match the canonical core SDK file", async () => {
    const root = path.join(import.meta.dirname, "..", "..");
    const canonical = await fsp.readFile(path.join(root, "core-back/lib/objectStorageSdk/blobStore.ts"), "utf8");
    const daemonCopy = await fsp.readFile(path.join(root, "deploy/object-storage-daemon/src/shared/blobStore.ts"), "utf8");
    const backupCopy = await fsp.readFile(path.join(root, "deploy/backup-daemon/src/shared/blobStore.ts"), "utf8");
    expect(daemonCopy).toBe(canonical);
    expect(backupCopy).toBe(canonical);
  });
});

describe("T21 object storage deploy topology", () => {
  test("derives the storage node, core env, PKI material, certificates and firewall", () => {
    const config = requireConfig(`${BASE}\n${OBJECT_STORAGE}`);
    expect(objectStorageConfigured(config)).toBe(true);
    const plan = planHosts(config);
    expect(plan.storage.objectStorage?.privateIp).toBe("10.10.14.10");
    expect(plan.storage.objectStorage?.servicePort).toBe(4095);
    const coreEnv = objectStorageCoreEnv(config);
    expect(coreEnv.OBJECT_STORAGE_DAEMON_URL).toBe("https://10.10.14.10:4095");
    expect(coreEnv.OBJECT_STORAGE_TLS_CLIENT_CERT_PATH).toBe("shared/certs/object-storage-client.crt");
    expect(coreEnv.CLUSTER_CORE_NODE_COUNT).toBe("1");
    const host = plan.hosts.find((candidate) => candidate.roles.includes("object-storage"));
    expect(host).toBeDefined();
    expect(host!.firewall.some((rule) => rule.port === 4095)).toBe(true);

    const directory = path.join(os.tmpdir(), `pki-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const pki = buildPki({ config, directory, dryRun: true });
    expect(pki.objectStorage.name).toBe("object-storage-daemon");
    expect(pki.objectStorage.sans).toContain("IP:10.10.14.10");
    expect(pki.storageClients.map((client) => client.name)).toContain("object-storage-client");
    const files = certFilesForHost(pki, ["object-storage"]).map((material) => material.name);
    expect(files).toContain("object-storage-daemon");
    expect(files).toContain("object-storage-client");
    const coreFiles = certFilesForHost(pki, ["core"]).map((material) => material.name);
    expect(coreFiles).toContain("object-storage-client");
    const backupFiles = certFilesForHost(pki, ["backup"]).map((material) => material.name);
    expect(backupFiles).toContain("object-storage-client");
  });

  test("the daemon env and unit point at the private IP, vault and mTLS certificates", () => {
    const config = requireConfig(`${BASE}\n${OBJECT_STORAGE}`);
    const env = objectStorageDaemonEnv(config);
    expect(env.OBJECT_STORAGE_DAEMON_BIND_HOST).toBe("10.10.14.10");
    expect(env.OBJECT_STORAGE_DAEMON_PORT).toBe("4095");
    expect(env.OBJECT_STORAGE_ROOT_DIR).toBe("/var/lib/pg-object-storage/vault");
    expect(env.OBJECT_STORAGE_DAEMON_TLS_CERT_PATH).toContain("object-storage-daemon.crt");
    const unit = objectStorageDaemonSystemdUnit(config);
    expect(unit).toContain("User=pgobjstore");
    expect(unit).toContain("ExecStart=/usr/local/bin/bun run src/index.ts");
    expect(unit).toContain("PrivateTmp=true");
  });

  test("a co-located object-storage host never receives core private keys", () => {
    const config = requireConfig(`${BASE}\n${OBJECT_STORAGE.replace("10.10.14.10", "10.10.0.20")}\nOBJECT_STORAGE_SSH_KEY_PATH="~/.ssh/core"`);
    const plan = planHosts(config);
    const pki = buildPki({ config, directory: path.join(os.tmpdir(), `pki-dry-${Date.now()}`), dryRun: true });
    const writes: Array<{ path: string; target: unknown }> = [];
    const runner = {
      run: () => undefined,
      capture: () => "__PG_APPLY__=unchanged",
      writeRemoteFile: (input: { path: string; target: unknown }) => {
        writes.push(input);
        return false;
      },
    } as never;
    uploadStorageCertificates(runner, plan, pki, config, true);
    expect(writes.some((entry) => entry.path.includes("/pg-object-storage/shared/certs/object-storage-daemon.crt"))).toBe(true);
    expect(writes.some((entry) => entry.path.includes("/pg-object-storage/shared/certs/core-back.crt"))).toBe(false);
    expect(writes.some((entry) => entry.path.includes("/pg-object-storage/shared/certs/object-storage-client.crt"))).toBe(false);
    expect(writes.some((entry) => entry.path.includes("/var/www/pg-core/shared/certs/object-storage-client.crt"))).toBe(true);
  });

  test("the daemon deploy installs Bun before starting the unit", () => {
    const config = requireConfig(`${BASE}\n${OBJECT_STORAGE}`);
    const plan = planHosts(config);
    const host = plan.hosts.find((candidate) => candidate.roles.includes("object-storage"))!;
    const commands: string[] = [];
    let synced = false;
    const runner = {
      run: (_target: unknown, command: string) => { commands.push(command); },
      capture: (_target: unknown, command: string) => { commands.push(command); return "__PG_APPLY__=unchanged"; },
      sync: () => { synced = true; return { changed: false }; },
      writeRemoteFile: () => false,
    } as never;
    deployObjectStorageDaemon({ runner, config, host, forceRestart: false });
    expect(synced).toBe(true);
    expect(commands.some((command) => command.includes("/usr/local/bin/bun"))).toBe(true);
    expect(commands.some((command) => command.includes("systemctl"))).toBe(true);
  });

  test("rejects root/system storage paths, v0 KEKs and an undersized client CN list", () => {
    expect(loadDeployConfig(`${BASE}\n${OBJECT_STORAGE}\nOBJECT_STORAGE_ROOT_DIR="/"`).ok).toBe(false);
    expect(loadDeployConfig(`${BASE}\n${OBJECT_STORAGE.replace("v1:7e1f4b9a3c6d2058e1a7b4c9d3f6082a5b1c8e4d7a0f3b6c9e2d5a8f1b4c7e03", "v0:7e1f4b9a3c6d2058e1a7b4c9d3f6082a5b1c8e4d7a0f3b6c9e2d5a8f1b4c7e03")}`).ok).toBe(false);
    expect(loadDeployConfig(`${BASE}\n${OBJECT_STORAGE}\nOBJECT_STORAGE_ALLOWED_CLIENT_CNS="backup-client"`).ok).toBe(false);
  });

  test("two core nodes without a shared object storage node are refused", () => {
    const result = loadDeployConfig(`${BASE}
CORE_NODES="core-1@10.0.0.11:22:10.1.0.11:4000,core-2@10.0.0.12:22:10.1.0.12:4000"
`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("MULTI_NODE_SHARED_STORAGE_REQUIRED");
  });

  test("the provisioner refuses to run without shared storage for multiple cores", () => {
    const base = requireConfig(`${BASE}\n${OBJECT_STORAGE}`);
    const config = {
      ...base,
      CORE_NODES: "core-1@10.0.0.11:22:10.1.0.11:4000,core-2@10.0.0.12:22:10.1.0.12:4000",
      OBJECT_STORAGE_ENABLED: false,
      OBJECT_STORAGE_MANAGE_VIA_SSH: false,
      OBJECT_STORAGE_NODE: "",
    };
    const runner = {
      run: () => undefined,
      capture: () => "",
      writeRemoteFile: () => false,
    };
    expect(() => provisionObjectStorageEngine({ runner, config })).toThrow("MULTI_NODE_SHARED_STORAGE_REQUIRED");
  });
});

/* -------------------------------------------------------------------------- */
/* T22 backup parity, KEK escrow and restore-drill decryption                  */
/* -------------------------------------------------------------------------- */

class MemoryStore implements ArtifactStore {
  readonly id = "memory";
  readonly name = "Memory";
  readonly kind = "local" as const;
  readonly allowDelete = true;
  readonly data = new Map<string, Buffer>();
  async putFile(_key: string, _localPath: string): Promise<void> {
    throw new Error("not used");
  }
  async putBuffer(key: string, data: Uint8Array): Promise<void> {
    this.data.set(key, Buffer.from(data));
  }
  async getFile(_key: string, _destPath: string): Promise<void> {
    throw new Error("not used");
  }
  async getBuffer(key: string): Promise<Buffer | null> {
    return this.data.get(key) ?? null;
  }
  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async health(): Promise<StoreHealth> {
    return { healthy: true, detail: "memory" };
  }
}

const KEK = createHash("sha256").update("deploy-test-kek").digest();

const activeRow = (input: {
  id: string;
  bucket: "HOT" | "COLD";
  storageKey: string;
  sha256Hex: string;
  byteSize: bigint;
  chunkCount: number;
  wrappedDek: Buffer;
  dekNonce: Buffer;
  streamNoncePrefix: Buffer;
}): ActiveStorageObject => ({
  id: input.id,
  bucket: input.bucket,
  storageKey: input.storageKey,
  sha256Hex: input.sha256Hex,
  byteSize: input.byteSize.toString(),
  chunkSize: 65536,
  chunkCount: input.chunkCount,
  kekKeyVersion: 1,
  wrappedDekHex: input.wrappedDek.toString("hex"),
  dekNonceHex: input.dekNonce.toString("hex"),
  streamNoncePrefixHex: input.streamNoncePrefix.toString("hex"),
});

const fakePsql = (rows: ActiveStorageObject[]): CommandRunner => ({
  async run(_command: string, args: string[]): Promise<CommandResult> {
    const query = args[args.length - 1] ?? "";
    if (query.includes("to_regclass")) return { code: 0, stdout: "t\n", stderr: "" };
    if (query.includes("ORDER BY random()")) {
      return { code: 0, stdout: `${JSON.stringify(rows)}\n`, stderr: "" };
    }
    if (query.includes("json_agg")) {
      return { code: 0, stdout: `${JSON.stringify(rows)}\n`, stderr: "" };
    }
    return { code: 0, stdout: "\n", stderr: "" };
  },
});

describe("T22 backup parity, KEK escrow and restore drill", () => {
  test("copies new blobs, checks ACTIVE parity, escrows the KEK and decrypts a sample", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pg-object-backup-test-"));
    const config = validateBackupDaemonConfig({
      BACKUP_ENGINE_MODE: "pg-native",
      BACKUP_ENCRYPTION_KEY_HEX: "b".repeat(64),
      BACKUP_LOCAL_REPO_DIR: "/unused",
      OBJECT_STORAGE_ROOT_DIR: root,
      OBJECT_STORAGE_KEK_KEYRING: `v1:${KEK.toString("hex")}`,
      OBJECT_STORAGE_ACTIVE_KEK_VERSION: "1",
      OBJECT_STORAGE_DRILL_SAMPLE: "5",
      PG_PRIMARY_DB_NAME: "payment_gateway_prod",
    });
    const store = new FsBlobStore(root);
    const provider = new InMemoryKeyProvider({ activeVersion: 1, keysByVersion: new Map([[1, KEK]]) });
    const payload = Buffer.from("%PDF-1.4\nobject storage backup test\n%%EOF\n", "utf8");
    const objectId = "11111111-1111-4111-8111-111111111111";
    const encrypted = encryptBufferToPgos1(payload, objectId, provider);
    const storageKey = `kyb_documents/shared/2026/11/${objectId}.v1.enc`;
    await store.put("HOT", storageKey, encrypted.ciphertextBytes);
    await store.put("COLD", "cold-only/shared/2026/11/orphan.v1.enc", Buffer.from("cold"));
    const rows = [
      activeRow({
        id: objectId,
        bucket: "HOT",
        storageKey,
        sha256Hex: encrypted.plaintextSha256Hex,
        byteSize: encrypted.plaintextByteSize,
        chunkCount: encrypted.chunkCount,
        wrappedDek: encrypted.wrappedDek,
        dekNonce: encrypted.dekNonce,
        streamNoncePrefix: encrypted.streamNoncePrefix,
      }),
    ];
    const repository = new ArtifactRepository([new MemoryStore()]);
    const runner = fakePsql(rows);
    const sync = await syncObjectStorageBackup({ config, repository, runner, blobStore: store });
    expect(sync.enabled).toBe(true);
    expect(sync.copiedBlobs).toBe(2);
    expect(sync.activeObjects).toBe(1);
    expect(sync.missingActive).toEqual([]);
    expect(await repository.getBuffer(objectBlobKey("HOT", storageKey))).not.toBeNull();
    expect(await repository.getBuffer(objectBlobKey("COLD", "cold-only/shared/2026/11/orphan.v1.enc"))).not.toBeNull();
    expect(await repository.getBuffer(OBJECT_STORAGE_ESCROW_KEY)).not.toBeNull();

    const drill = await runObjectStorageDrill({
      config,
      repository,
      query: async (sqlText) => {
        if (sqlText.includes("to_regclass")) return { code: 0, stdout: "t\n", stderr: "" };
        return { code: 0, stdout: `${JSON.stringify(rows)}\n`, stderr: "" };
      },
    });
    expect(drill).not.toBeNull();
    expect(drill!.ok).toBe(true);
    expect(drill!.sampled).toBe(1);

    // A missing repository blob fails parity before the drill. Delete it from
    // the live vault too, so the incremental copy cannot restore parity.
    const memory = repository.stores[0] as MemoryStore;
    await memory.delete(objectBlobKey("HOT", storageKey));
    await fsp.rm(path.join(root, "hot", storageKey), { force: true });
    await expect(syncObjectStorageBackup({ config, repository, runner, blobStore: store })).rejects.toThrow(
      /OBJECT_STORAGE_BACKUP_PARITY_ERROR/,
    );
    await fsp.rm(root, { recursive: true, force: true });
  });
});
