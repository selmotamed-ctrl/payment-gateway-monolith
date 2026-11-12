# Enterprise Shared Object & Asset Storage Engine — Complete Implementation Specification (`v6.0`)

**Target Audience:** Autonomous Coding Agent (`OpenCode`) & Platform Engineering

**Baseline Repository State:** `REQUIRED_SCHEMA_VERSION = 33` (includes Dynamic Report Studio v32 & Backup Engine v33)

**Target Repository State:** `REQUIRED_SCHEMA_VERSION = 34`

**Core Mandate:** **100% Shared Across Nodes and Records, Multi-Node Ready, Self-Hosted, Recoverable, Fast, Zero External Cloud Subscriptions.** Every line of SQL, Prisma schema, SDK code, first-party mTLS Shared Object Storage Daemon (`deploy/object-storage-daemon`), Multi-Node Deploy Engine provisioner (`deploy/`), Backup Engine integration, Domain Call-Site migration, Admin UI, and Test Suite is specified verbatim below. **Do not skip, abbreviate, or invent shortcuts for any section.**

## 1. Executive Architecture: Why & How Storage Is Shared Across Nodes and Records

### 1.1 Two Levels of "Shared Storage" (Both Mandatory)

1. **Network-Shared Across All Cluster Nodes (Multi-Node Deployment Topology):**

   * In production or multi-node deployments, the platform runs across multiple dedicated servers configured in `deploy/deploy.env`:

     * Multiple stateless `core-back` application nodes (`CORE_NODES="core-1@10.10.10.11:22:10.10.10.11:4000,core-2@10.10.10.12:22:10.10.10.12:4000"`)

     * Primary & Replica PostgreSQL nodes (`PG_PRIMARY_NODE`, `PG_REPLICA_NODES`)

     * Dedicated Backup node (`BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"`)

     * **Dedicated Shared Object Storage node (`OBJECT_STORAGE_NODE="obj-1@10.10.14.10:22:10.10.14.10:4095"`)**

   * **Critical Rule:** An asset uploaded on `core-1` (e.g., a KYB document, a bank statement CSV, a Report Studio template asset, or a payment rail logo) **MUST be immediately readable by `core-2`, `core-3`, background workers on any node, and `backup-1`**. Storing blobs on `core-1`'s local disk without sharing breaks multi-node deployments immediately.

   * **How This Plan Solves Multi-Node Shared Storage Without External Cloud Dependencies:**

     * Just as `BACKUP_NODE` runs our first-party TypeScript/Bun mTLS daemon (`deploy/backup-daemon`), **`OBJECT_STORAGE_NODE` runs our first-party TypeScript/Bun mTLS Shared Object Storage Daemon (`deploy/object-storage-daemon`)** listening on port `4095` (provisioned automatically by `deploy/provisioners/objectStorageProvisioner.ts` using internal PKI certificates minted by `deploy/lib/pkiManager.ts`).

     * Inside `core-back/lib/objectStorageSdk/blobStore.ts`, `createBlobStoreFromEnv()` provides **two drivers behind one identical `BlobStore` interface**:

       1. **`RemoteMtlsBlobStore` (Mandatory Shared Storage Client for Application & Backup Nodes):** Used by every `core-back` node (`core-1`, `core-2`, ...) and `backup-daemon` (`backup-1`) to read, write, stat, trash, and list blobs over mutually-authenticated TLS (`internal-ca.crt` + `object-storage-client.crt` + `object-storage-client.key`) against the dedicated `OBJECT_STORAGE_NODE` host (`https://10.10.14.10:4095`).

       2. **`FsBlobStore` (Daemon Disk Engine & Local Single-Process Test Driver):** Runs **inside `deploy/object-storage-daemon` on the dedicated `OBJECT_STORAGE_NODE` server** (managing `/srv/objects/{hot,cold,quarantine,tmp,.trash}`), and in local single-process `bun test` / dev runs.

     * **HARD INVARIANT — NEVER STORE ON CORE NODES IN MULTI-NODE DEPLOYMENTS:**

       * If `CORE_NODES` has more than 1 node (`coreNodes.length > 1`) OR `BACKUP_NODE` is on a separate host, **`OBJECT_STORAGE_NODE` is strictly mandatory in `deploy/deploy.env`**.

       * If an operator forgets to set `OBJECT_STORAGE_NODE` when deploying multiple core nodes, `parseDeployEnv()`, `buildStoragePlan()`, and `provisionObjectStorageEngine()` **immediately throw a fatal error (`MULTI_NODE_SHARED_STORAGE_REQUIRED`) and abort the deployment** rather than ever falling back to storing files on individual core nodes!

       * Likewise, at `core-back` startup (`createBlobStoreFromEnv()`), if `NODE_ENV === 'production'` (or `CLUSTER_CORE_NODE_COUNT > 1`) and `OBJECT_STORAGE_DAEMON_URL` is missing, `core-back` **throws a fatal startup error (`OBJECT_STORAGE_DAEMON_URL_REQUIRED`)** and refuses to boot.

2. **Record-Shared Inside the Control Plane (`storage_objects` + `storage_object_locks`):**

   * Multiple business records can safely share and lock a single `StorageObject` row via the `storage_object_locks` table (`UNIQUE (object_id, holder_type, holder_id)`).

   * For example, a `Rail` record (`holderType = 'RAIL_LOGO'`, `holderId = rail.id`) and an `Asset` catalog record (`holderType = 'CATALOG_ASSET'`, `holderId = asset.id`) or multiple `RegulatoryReportOutput` / `ReportAssetBundleEntry` records can hold independent locks on the same `objectId`.

   * **Strict Lock Invariant:** As long as **any** active lock (`released_at IS NULL`) exists on `object_id`, OR `legal_hold = true`, OR `retain_until > NOW()`, the PostgreSQL trigger `storage_objects_guard_trg` **forbids transitioning `status` to `PURGED` or `QUARANTINE_REJECTED`**, and forbids `DELETE` on `storage_objects`.

```
                    +-------------------------------------------------------------------+
                    |                   DEDICATED STORAGE HOST (obj-1)                  |
                    |  deploy/object-storage-daemon (Bun + mTLS Port 4095)              |
                    |  Backed by FsBlobStore -> /srv/objects/{hot,cold,quarantine,tmp}  |
                    +-------------------------------------------------------------------+
                                   ^                        ^                        ^
                     mTLS (4095)   |          mTLS (4095)   |          mTLS (4095)   |
        +--------------------------+                        |                        +--------------------------+
        |                                                   |                                                   |
+-------+-------------------------+       +-----------------+-----------------+       +-------------------------+-------+
|     CORE NODE 1 (core-1)        |       +     CORE NODE 2 (core-2)          |       |     BACKUP NODE (backup-1)      |
|  ObjectStorageSdk               |       |  ObjectStorageSdk                 |       |  deploy/backup-daemon           |
|  -> RemoteMtlsBlobStore         |       |  -> RemoteMtlsBlobStore           |       |  -> RemoteMtlsBlobStore         |
|  (Uploads, Downloads, Workers)  |       |  (Uploads, Downloads, Workers)    |       |  (3-2-1 Sync & Restore Drill)   |
+---------------------------------+       +-----------------------------------+       +---------------------------------+
        |                                                   |                                                   |
        +---------------------------------------------------+---------------------------------------------------+
                                                            |
                                                            v
                                    +-----------------------------------------------+
                                    |     PRIMARY POSTGRESQL NODE (pg-primary)      |
                                    |  Control Plane Tables (Schema v34):           |
                                    |  - storage_objects                            |
                                    |  - storage_object_locks                       |
                                    |  - storage_object_access_logs                 |
                                    |  - 2 DB Triggers (No GUC backdoors)           |
                                    +-----------------------------------------------+





```

### 1.2 Architectural Guarantees & Bug Prevention Summary

| Guarantee | Mechanism | 
| ----- | ----- | 
| **No DB Transaction Held During Network/Disk I/O** | `routeClient.stageUpload()` inserts a `STAGING` row in a fast standalone autocommit query, encrypts and streams the ciphertext to `BlobStore` (`FsBlobStore` or `RemoteMtlsBlobStore`) **outside** any caller transaction, and returns `{ objectId, sha256Hex, byteSize }`. Inside `prisma.$transaction(async (tx) => ...)`, the caller only invokes `routeClient.bind(tx, ...)` which executes 2 pure-SQL queries (`UPDATE storage_objects` + `INSERT INTO storage_object_locks`). | 
| **Shared Across All `core-back` Nodes** | Every `core-back` node uses `RemoteMtlsBlobStore` pointing to `OBJECT_STORAGE_NODE` (`https://<privateIp>:4095`) with mTLS client certs when deployed across multiple hosts, or `FsBlobStore` on single-host dev. | 
| **One Upload = One Row = One UUID Storage Key** | Storage path is `{namespace}/{tenant_or_shared}/{yyyy}/{mm}/{objectId}.v1.enc`. Zero content-hash path collisions, zero cross-row DEK sharing, zero dedup race conditions. | 
| **Two-Stage Retention (`STAGING` -> `QUARANTINE_PENDING_AV` / `ACTIVE`)** | Staging rows have `retain_until = NULL`. Retention (`NOW() + policy_days`) is stamped only when `promote(tx, objectId)` activates the object (either synchronously for trusted formats or after `ScanWorker` returns `CLEAN`). Malware or rolled-back uploads never get a 7-year compliance lock. | 
| **Strict Trigger Protection Without GUC Backdoors** | Only 2 small PL/pgSQL triggers exist: `storage_objects_guard_trg` and `storage_object_locks_guard_trg`. Neither reads `current_setting(...)`. Even if an application route has a bug and calls `prisma.storageObject.delete()`, PostgreSQL raises `23503: STORAGE_OBJECT_DELETE_FORBIDDEN`. | 
| **Authenticated Per-Chunk Streaming Encryption (`pgos1`)** | 64 KiB frames encrypted with `AES-256-GCM`, unique 96-bit per-object random `noncePrefix` + `uint32be(chunkIndex)` + `finalFlag`, with \`AAD = objectId (16B) | 
| **Soft-Trash Before Hard Unlink (`GC_ELIGIBLE_AT` + `.trash/YYYY-MM-DD/`)** | Releasing the last lock stamps `gc_eligible_at = GREATEST(COALESCE(retain_until, NOW()), NOW() + 24 hours)`. After 24h, `GcWorker` moves the blob to `.trash/YYYY-MM-DD/` (via `blobStore.moveToTrash`), keeping it recoverable for `OBJECT_STORAGE_TRASH_RETENTION_DAYS` (default 7 days) before hard unlink. | 

## 2. Database Control Plane (Schema v34, Triggers & Migrations)

### 2.1 Update `core-back/prisma/schemaVersion.ts`

Update `REQUIRED_SCHEMA_VERSION` from `33` to `34` in `core-back/prisma/schemaVersion.ts`:

```
// core-back/prisma/schemaVersion.ts
export const REQUIRED_SCHEMA_VERSION = 34;





```

### 2.2 Update `core-back/prisma/schema.prisma`

Add the 4 enums, 3 new control-plane tables (`StorageObject`, `StorageObjectLock`, `StorageObjectAccessLog`), 2 new domain tables (`DisputeAttachment`, `AmlCaseEvidence`), and update the 6 existing domain models (`KybDocument`, `ReconciliationRun`, `RegulatoryReportSchema`, `RegulatoryReportOutput`, `ReportAssetBundleEntry`, `Asset`) in `core-back/prisma/schema.prisma`:

```
// ============================================================================
// ADD TO core-back/prisma/schema.prisma (v34 Object & Asset Storage Engine)
// ============================================================================

enum StorageBucketTier {
  HOT
  COLD
  QUARANTINE
}

enum StorageNamespace {
  KYB_DOCUMENTS
  RECON_STATEMENTS
  REGULATORY_REPORTS
  REPORT_STUDIO_ASSETS
  MERCHANT_STATEMENTS
  DISPUTE_EVIDENCE
  AML_CASE_ATTACHMENTS
  SYSTEM_BRAND_ASSETS
  BACKUP_ARTIFACTS
}

enum StorageObjectStatus {
  STAGING
  QUARANTINE_PENDING_AV
  QUARANTINE_REJECTED
  ACTIVE
  PURGED
}

enum StorageAvScanStatus {
  NOT_REQUIRED
  PENDING
  CLEAN
  INFECTED
  SCAN_ERROR
}

model StorageObject {
  id                  String              @id @default(uuid()) @db.Uuid
  bucket              StorageBucketTier   @default(HOT)
  namespace           StorageNamespace
  storageKey          String              @map("storage_key") @db.VarChar(512)
  status              StorageObjectStatus @default(STAGING)

  // Cryptographic & Integrity Envelope (pgos1)
  sha256Hex           String              @map("sha256_hex") @db.Char(64)
  byteSize            BigInt              @map("byte_size")
  chunkSizeBytes      Int                 @default(65536) @map("chunk_size_bytes")
  chunkCount          Int                 @map("chunk_count")
  detectedMimeType    String              @map("detected_mime_type") @db.VarChar(127)
  originalFilename    String?             @map("original_filename") @db.VarChar(255)
  kekKeyVersion       Int                 @default(1) @map("kek_key_version")
  wrappedDek          Bytes               @map("wrapped_dek")
  dekNonce            Bytes               @map("dek_nonce")
  streamNoncePrefix   Bytes               @map("stream_nonce_prefix")

  // Ownership & Authority Context
  ownerMerchantId     String?             @map("owner_merchant_id") @db.Uuid
  uploadedByActorType String              @map("uploaded_by_actor_type") @db.VarChar(32)
  uploadedByActorId   String              @map("uploaded_by_actor_id") @db.VarChar(128)
  requiredAuthority   String              @map("required_authority") @db.VarChar(128)
  confidentialityTier String              @default("CONFIDENTIAL") @map("confidentiality_tier") @db.VarChar(32)

  // Retention, Legal Hold & Two-Stage GC Grace Window
  retainUntil         DateTime?           @map("retain_until") @db.Timestamptz(6)
  legalHold           Boolean             @default(false) @map("legal_hold")
  legalHoldReason     String?             @map("legal_hold_reason") @db.VarChar(512)
  legalHoldByAdminId  String?             @map("legal_hold_by_admin_id") @db.Uuid
  legalHoldPlacedAt   DateTime?           @map("legal_hold_placed_at") @db.Timestamptz(6)
  gcEligibleAt        DateTime?           @map("gc_eligible_at") @db.Timestamptz(6)

  // Malware / Content Verification State
  avScanStatus        StorageAvScanStatus @default(PENDING) @map("av_scan_status")
  avScannedAt         DateTime?           @map("av_scanned_at") @db.Timestamptz(6)
  avSignature         String?             @map("av_signature") @db.VarChar(255)
  lastScrubbedAt      DateTime?           @map("last_scrubbed_at") @db.Timestamptz(6)
  scrubErrorCount     Int                 @default(0) @map("scrub_error_count")

  metadata            Json?               @default("{}")
  stagingExpiresAt    DateTime            @map("staging_expires_at") @db.Timestamptz(6)
  activatedAt         DateTime?           @map("activated_at") @db.Timestamptz(6)
  purgedAt            DateTime?           @map("purged_at") @db.Timestamptz(6)
  createdAt           DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt           DateTime            @updatedAt @map("updated_at") @db.Timestamptz(6)

  locks               StorageObjectLock[]
  accessLogs          StorageObjectAccessLog[]

  kybDocuments        KybDocument[]
  reconRuns           ReconciliationRun[]
  regReportSchemas    RegulatoryReportSchema[]
  regReportOutputs    RegulatoryReportOutput[]
  reportAssetBundles         ReportAssetBundle[]
  merchantReportAssetBundles MerchantReportAssetBundle[]
  catalogAssets       Asset[]
  disputeAttachments  DisputeAttachment[]
  amlCaseEvidences    AmlCaseEvidence[]

  @@unique([bucket, storageKey], map: "uq_storage_objects_bucket_key")
  @@index([namespace, ownerMerchantId, status], map: "idx_storage_objects_ns_merchant_status")
  @@index([status, stagingExpiresAt], map: "idx_storage_objects_staging_gc")
  @@index([status, gcEligibleAt], map: "idx_storage_objects_active_gc")
  @@index([status, lastScrubbedAt], map: "idx_storage_objects_scrub_queue")
  @@index([kekKeyVersion, status], map: "idx_storage_objects_kek_rotation")
  @@map("storage_objects")
}

model StorageObjectLock {
  id                  String        @id @default(uuid()) @db.Uuid
  objectId            String        @map("object_id") @db.Uuid
  object              StorageObject @relation(fields: [objectId], references: [id], onDelete: Restrict)

  holderType          String        @map("holder_type") @db.VarChar(64)
  holderId            String        @map("holder_id") @db.VarChar(128)
  retentionFloorUntil DateTime?     @map("retention_floor_until") @db.Timestamptz(6)

  acquiredByActorId   String        @map("acquired_by_actor_id") @db.VarChar(128)
  acquiredReason      String        @map("acquired_reason") @db.VarChar(255)
  acquiredAt          DateTime      @default(now()) @map("acquired_at") @db.Timestamptz(6)

  releasedAt          DateTime?     @map("released_at") @db.Timestamptz(6)
  releasedByActorId   String?       @map("released_by_actor_id") @db.VarChar(128)
  releaseReason       String?       @map("release_reason") @db.VarChar(255)

  @@unique([objectId, holderType, holderId], map: "uq_storage_object_locks_holder")
  @@index([objectId, releasedAt], map: "idx_storage_object_locks_active")
  @@index([holderType, holderId], map: "idx_storage_object_locks_lookup")
  @@map("storage_object_locks")
}

model StorageObjectAccessLog {
  id            String        @id @default(uuid()) @db.Uuid
  objectId      String        @map("object_id") @db.Uuid
  object        StorageObject @relation(fields: [objectId], references: [id], onDelete: Restrict)
  actorType     String        @map("actor_type") @db.VarChar(32)
  actorId       String        @map("actor_id") @db.VarChar(128)
  action        String        @db.VarChar(48)
  allowed       Boolean
  denialReason  String?       @map("denial_reason") @db.VarChar(255)
  holderType    String?       @map("holder_type") @db.VarChar(64)
  holderId      String?       @map("holder_id") @db.VarChar(128)
  ipAddress     String?       @map("ip_address") @db.VarChar(64)
  requestId     String?       @map("request_id") @db.VarChar(128)
  bytesServed   BigInt?       @map("bytes_served")
  occurredAt    DateTime      @default(now()) @map("occurred_at") @db.Timestamptz(6)

  @@index([objectId, occurredAt(sort: Desc)], map: "idx_storage_access_logs_object_time")
  @@index([actorId, occurredAt(sort: Desc)], map: "idx_storage_access_logs_actor_time")
  @@map("storage_object_access_logs")
}

model DisputeAttachment {
  id              String        @id @default(uuid()) @db.Uuid
  disputeId       String        @map("dispute_id") @db.Uuid
  merchantId      String        @map("merchant_id") @db.Uuid
  storageObjectId String        @map("storage_object_id") @db.Uuid
  storageObject   StorageObject @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)
  label           String        @db.VarChar(255)
  uploadedById    String        @map("uploaded_by_id") @db.VarChar(128)
  createdAt       DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([disputeId], map: "idx_dispute_attachments_dispute")
  @@index([storageObjectId], map: "idx_dispute_attachments_object")
  @@map("dispute_attachments")
}

model AmlCaseEvidence {
  id              String        @id @default(uuid()) @db.Uuid
  amlCaseId       String        @map("aml_case_id") @db.Uuid
  storageObjectId String        @map("storage_object_id") @db.Uuid
  storageObject   StorageObject @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)
  evidenceType    String        @map("evidence_type") @db.VarChar(64)
  notes           String?       @db.Text
  uploadedById    String        @map("uploaded_by_id") @db.VarChar(128)
  createdAt       DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([amlCaseId], map: "idx_aml_case_evidence_case")
  @@index([storageObjectId], map: "idx_aml_case_evidence_object")
  @@map("aml_case_evidence")
}





```

And add the `storageObjectId` foreign-key relation to the existing domain models in `core-back/prisma/schema.prisma` (matching their exact `@map` table names in `schema.prisma`):

1. **`KybDocument` (`@@map("kyb_documents")`)**:

   * Add `storageObjectId String? @map("storage_object_id") @db.Uuid` and `storageObject StorageObject? @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)`.

2. **`ReconciliationRun` (`@@map("reconciliation_runs")`)**:

   * Remove `fileContent Bytes? @map("file_content") @db.ByteA`.

   * Add `storageObjectId String? @map("storage_object_id") @db.Uuid` and `storageObject StorageObject? @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)`.

3. **`RegulatoryReportSchema` (`@@map("regulatory_report_schemas")`)**:

   * Add `templateObjectId String? @map("template_object_id") @db.Uuid` and `templateObject StorageObject? @relation(fields: [templateObjectId], references: [id], onDelete: Restrict)`.

4. **`RegulatoryReportOutput` (`@@map("regulatory_report_outputs")`)**:

   * Add `storageObjectId String? @map("storage_object_id") @db.Uuid` and `storageObject StorageObject? @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)`.

5. **`ReportAssetBundle` (`@@map("report_asset_bundles")`) & `MerchantReportAssetBundle` (`@@map("merchant_report_asset_bundles")`)**:

   * Add `storageObjectId String? @map("storage_object_id") @db.Uuid` and `storageObject StorageObject? @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)`.

6. **`Asset` (`@@map("assets")`)**:

   * Add `storageObjectId String? @map("storage_object_id") @db.Uuid` and `storageObject StorageObject? @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)`.

storageObjectId\], references: \[id\], onDelete: Restrict)\`.

### 2.3 Complete Migration SQL (`core-back/prisma/migrations/20261112000000_v34_enterprise_object_storage_engine/migration.sql`)

Create `core-back/prisma/migrations/20261112000000_v34_enterprise_object_storage_engine/migration.sql` with the following exact SQL (including the 2 immutable PL/pgSQL triggers and partial indexes):

```
-- ============================================================================
-- Migration: 20261112000000_v34_enterprise_object_storage_engine
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "StorageBucketTier" AS ENUM ('HOT', 'COLD', 'QUARANTINE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StorageNamespace" AS ENUM (
    'KYB_DOCUMENTS',
    'RECON_STATEMENTS',
    'REGULATORY_REPORTS',
    'REPORT_STUDIO_ASSETS',
    'MERCHANT_STATEMENTS',
    'DISPUTE_EVIDENCE',
    'AML_CASE_ATTACHMENTS',
    'SYSTEM_BRAND_ASSETS',
    'BACKUP_ARTIFACTS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StorageObjectStatus" AS ENUM (
    'STAGING',
    'QUARANTINE_PENDING_AV',
    'QUARANTINE_REJECTED',
    'ACTIVE',
    'PURGED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StorageAvScanStatus" AS ENUM (
    'NOT_REQUIRED',
    'PENDING',
    'CLEAN',
    'INFECTED',
    'SCAN_ERROR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "storage_objects" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "bucket"                 "StorageBucketTier" NOT NULL DEFAULT 'HOT',
  "namespace"              "StorageNamespace" NOT NULL,
  "storage_key"            VARCHAR(512) NOT NULL,
  "status"                 "StorageObjectStatus" NOT NULL DEFAULT 'STAGING',
  "sha256_hex"             CHAR(64) NOT NULL,
  "byte_size"              BIGINT NOT NULL CHECK ("byte_size" > 0),
  "chunk_size_bytes"       INTEGER NOT NULL DEFAULT 65536 CHECK ("chunk_size_bytes" >= 4096),
  "chunk_count"            INTEGER NOT NULL CHECK ("chunk_count" >= 1),
  "detected_mime_type"     VARCHAR(127) NOT NULL,
  "original_filename"      VARCHAR(255),
  "kek_key_version"        INTEGER NOT NULL DEFAULT 1,
  "wrapped_dek"            BYTEA NOT NULL,
  "dek_nonce"              BYTEA NOT NULL,
  "stream_nonce_prefix"    BYTEA NOT NULL,
  "owner_merchant_id"      UUID,
  "uploaded_by_actor_type" VARCHAR(32) NOT NULL,
  "uploaded_by_actor_id"   VARCHAR(128) NOT NULL,
  "required_authority"     VARCHAR(128) NOT NULL,
  "confidentiality_tier"   VARCHAR(32) NOT NULL DEFAULT 'CONFIDENTIAL',
  "retain_until"           TIMESTAMPTZ(6),
  "legal_hold"             BOOLEAN NOT NULL DEFAULT FALSE,
  "legal_hold_reason"      VARCHAR(512),
  "legal_hold_by_admin_id" UUID,
  "legal_hold_placed_at"   TIMESTAMPTZ(6),
  "gc_eligible_at"         TIMESTAMPTZ(6),
  "av_scan_status"         "StorageAvScanStatus" NOT NULL DEFAULT 'PENDING',
  "av_scanned_at"          TIMESTAMPTZ(6),
  "av_signature"           VARCHAR(255),
  "last_scrubbed_at"       TIMESTAMPTZ(6),
  "scrub_error_count"      INTEGER NOT NULL DEFAULT 0,
  "metadata"               JSONB DEFAULT '{}'::jsonb,
  "staging_expires_at"     TIMESTAMPTZ(6) NOT NULL,
  "activated_at"           TIMESTAMPTZ(6),
  "purged_at"              TIMESTAMPTZ(6),
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_storage_objects_bucket_key" UNIQUE ("bucket", "storage_key")
);

CREATE INDEX IF NOT EXISTS "idx_storage_objects_ns_merchant_status"
  ON "storage_objects" ("namespace", "owner_merchant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_storage_objects_staging_gc"
  ON "storage_objects" ("status", "staging_expires_at")
  WHERE "status" IN ('STAGING', 'QUARANTINE_REJECTED');
CREATE INDEX IF NOT EXISTS "idx_storage_objects_active_gc"
  ON "storage_objects" ("status", "gc_eligible_at")
  WHERE "status" = 'ACTIVE' AND "gc_eligible_at" IS NOT NULL AND "legal_hold" = FALSE;
CREATE INDEX IF NOT EXISTS "idx_storage_objects_scrub_queue"
  ON "storage_objects" ("status", "last_scrubbed_at" NULLS FIRST)
  WHERE "status" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "idx_storage_objects_kek_rotation"
  ON "storage_objects" ("kek_key_version", "status")
  WHERE "status" != 'PURGED';

CREATE TABLE IF NOT EXISTS "storage_object_locks" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "object_id"             UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT,
  "holder_type"           VARCHAR(64) NOT NULL,
  "holder_id"             VARCHAR(128) NOT NULL,
  "retention_floor_until" TIMESTAMPTZ(6),
  "acquired_by_actor_id"  VARCHAR(128) NOT NULL,
  "acquired_reason"       VARCHAR(255) NOT NULL,
  "acquired_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "released_at"           TIMESTAMPTZ(6),
  "released_by_actor_id"  VARCHAR(128),
  "release_reason"        VARCHAR(255),
  CONSTRAINT "uq_storage_object_locks_holder" UNIQUE ("object_id", "holder_type", "holder_id")
);

CREATE INDEX IF NOT EXISTS "idx_storage_object_locks_active"
  ON "storage_object_locks" ("object_id")
  WHERE "released_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_storage_object_locks_lookup"
  ON "storage_object_locks" ("holder_type", "holder_id")
  WHERE "released_at" IS NULL;

CREATE TABLE IF NOT EXISTS "storage_object_access_logs" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "object_id"     UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT,
  "actor_type"    VARCHAR(32) NOT NULL,
  "actor_id"      VARCHAR(128) NOT NULL,
  "action"        VARCHAR(48) NOT NULL,
  "allowed"       BOOLEAN NOT NULL,
  "denial_reason" VARCHAR(255),
  "holder_type"   VARCHAR(64),
  "holder_id"     VARCHAR(128),
  "ip_address"    VARCHAR(64),
  "request_id"    VARCHAR(128),
  "bytes_served"  BIGINT,
  "occurred_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_storage_access_logs_object_time"
  ON "storage_object_access_logs" ("object_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_access_logs_actor_time"
  ON "storage_object_access_logs" ("actor_id", "occurred_at" DESC);

CREATE TABLE IF NOT EXISTS "dispute_attachments" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dispute_id"        UUID NOT NULL,
  "merchant_id"       UUID NOT NULL,
  "storage_object_id" UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT,
  "label"             VARCHAR(255) NOT NULL,
  "uploaded_by_id"    VARCHAR(128) NOT NULL,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_dispute_attachments_dispute" ON "dispute_attachments" ("dispute_id");
CREATE INDEX IF NOT EXISTS "idx_dispute_attachments_object"  ON "dispute_attachments" ("storage_object_id");

CREATE TABLE IF NOT EXISTS "aml_case_evidence" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "aml_case_id"       UUID NOT NULL,
  "storage_object_id" UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT,
  "evidence_type"     VARCHAR(64) NOT NULL,
  "notes"             TEXT,
  "uploaded_by_id"    VARCHAR(128) NOT NULL,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_aml_case_evidence_case"   ON "aml_case_evidence" ("aml_case_id");
CREATE INDEX IF NOT EXISTS "idx_aml_case_evidence_object" ON "aml_case_evidence" ("storage_object_id");

-- Domain table FK links to storage_objects (matching exact @map table names in schema.prisma)
ALTER TABLE "kyb_documents"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_kyb_documents_storage_object" ON "kyb_documents" ("storage_object_id");

ALTER TABLE "reconciliation_runs"
  DROP COLUMN IF EXISTS "file_content",
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_storage_object" ON "reconciliation_runs" ("storage_object_id");

ALTER TABLE "regulatory_report_schemas"
  ADD COLUMN IF NOT EXISTS "template_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_reg_report_schemas_template_object" ON "regulatory_report_schemas" ("template_object_id");

ALTER TABLE "regulatory_report_outputs"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_reg_report_outputs_storage_object" ON "regulatory_report_outputs" ("storage_object_id");

ALTER TABLE "report_asset_bundles"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_report_asset_bundles_storage_object" ON "report_asset_bundles" ("storage_object_id");

ALTER TABLE "merchant_report_asset_bundles"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_merchant_report_asset_bundles_storage_object" ON "merchant_report_asset_bundles" ("storage_object_id");

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "idx_assets_storage_object" ON "assets" ("storage_object_id");

-- ============================================================================
-- TRIGGER 1: storage_objects_guard_trg (No GUC backdoors)
-- ============================================================================
CREATE OR REPLACE FUNCTION enforce_storage_object_invariants()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_active_locks INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_DELETE_FORBIDDEN: storage_objects rows cannot be deleted (object_id=%). Transition to PURGED instead.', OLD.id
      USING ERRCODE = '23503';
  END IF;

  -- Immutable identity & content-integrity columns (kek_key_version, wrapped_dek, dek_nonce may rotate via RewrapWorker)
  IF NEW.id != OLD.id
     OR NEW.namespace != OLD.namespace
     OR NEW.storage_key != OLD.storage_key
     OR NEW.sha256_hex != OLD.sha256_hex
     OR NEW.byte_size != OLD.byte_size
     OR NEW.chunk_size_bytes != OLD.chunk_size_bytes
     OR NEW.chunk_count != OLD.chunk_count
     OR NEW.stream_nonce_prefix != OLD.stream_nonce_prefix THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_IMMUTABLE_FIELD: cannot mutate cryptographic identity of object_id=%', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- Monotonic retention_until (never shortened once set)
  IF OLD.retain_until IS NOT NULL AND (NEW.retain_until IS NULL OR NEW.retain_until < OLD.retain_until) THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN: cannot shorten retain_until from % to % on object_id=%',
      OLD.retain_until, NEW.retain_until, OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- Transition to PURGED or QUARANTINE_REJECTED requires zero active locks, legal_hold = false, and expired retention
  IF NEW.status IN ('PURGED', 'QUARANTINE_REJECTED') AND OLD.status != NEW.status THEN
    IF NEW.legal_hold = TRUE OR OLD.legal_hold = TRUE THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LEGAL_HOLD_ACTIVE: cannot purge/reject object_id=% while legal_hold is true', OLD.id
        USING ERRCODE = '23503';
    END IF;

    SELECT COUNT(*) INTO v_active_locks
      FROM "storage_object_locks"
     WHERE "object_id" = OLD.id
       AND "released_at" IS NULL;

    IF v_active_locks > 0 THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LOCKED: cannot transition object_id=% to % while % active lock(s) exist',
        OLD.id, NEW.status, v_active_locks
        USING ERRCODE = '23503';
    END IF;

    IF NEW.status = 'PURGED' AND OLD.retain_until IS NOT NULL AND OLD.retain_until > NOW() THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_ACTIVE: cannot purge object_id=% before retain_until=%',
        OLD.id, OLD.retain_until
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "storage_objects_guard_trg" ON "storage_objects";
CREATE TRIGGER "storage_objects_guard_trg"
BEFORE UPDATE OR DELETE ON "storage_objects"
FOR EACH ROW EXECUTE FUNCTION enforce_storage_object_invariants();

-- ============================================================================
-- TRIGGER 2: storage_object_locks_guard_trg (Append-Only Lock Ledger)
-- ============================================================================
CREATE OR REPLACE FUNCTION enforce_storage_lock_invariants()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STORAGE_LOCK_DELETE_FORBIDDEN: storage_object_locks is append-only (lock_id=%). Set released_at instead.', OLD.id
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id != OLD.id
       OR NEW.object_id != OLD.object_id
       OR NEW.holder_type != OLD.holder_type
       OR NEW.holder_id != OLD.holder_id THEN
      RAISE EXCEPTION 'STORAGE_LOCK_IMMUTABLE_IDENTITY: cannot alter lock identity columns on lock_id=%', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "storage_object_locks_guard_trg" ON "storage_object_locks";
CREATE TRIGGER "storage_object_locks_guard_trg"
BEFORE UPDATE OR DELETE ON "storage_object_locks"
FOR EACH ROW EXECUTE FUNCTION enforce_storage_lock_invariants();

-- Bump singleton schema_versions row to 34 (checked by ensureSchemaVersion in core-back/prisma/client/index.ts)
UPDATE "schema_versions" SET "version" = 34 WHERE "id" = 1;





```

### 2.4 Update `core-back/test/exhaustive/_dbFactory.ts`

In `core-back/test/exhaustive/_dbFactory.ts`, `Suite 01 · model & column fidelity` (`core-back/test/exhaustive/01-schema/models-and-columns.test.ts`) automatically introspects every model in `prisma/schema.prisma` and inserts a test row via `buildRow()`. Because `storage_objects` has `CHECK ("byte_size" > 0)` and `CHECK ("chunk_size_bytes" >= 4096)` and `CHECK ("chunk_count" >= 1)`, add `storage_objects` to `FACTORY_DEFAULTS` in `core-back/test/exhaustive/_dbFactory.ts`:

```
// core-back/test/exhaustive/_dbFactory.ts
const FACTORY_DEFAULTS: Record<string, Record<string, unknown>> = {
  gl_account_shards: { shard_id: 1 },
  journal_lines: { shard_id: 0, shard_seq: 1 },
  // The CHECK constraints of the append-only repair history accept only these values.
  gl_shard_repairs: { kind: "RECOMPUTE", mode: "AUTO" },
  // Satisfy CHECK (byte_size > 0), CHECK (chunk_size_bytes >= 4096), CHECK (chunk_count >= 1)
  storage_objects: { byte_size: 1024, chunk_size_bytes: 65536, chunk_count: 1 },
};

```

Also in `core-back/test/exhaustive/01-schema/check-constraints-and-triggers.test.ts`, when testing delete/update guards, note that `storage_objects_guard_trg` and `storage_object_locks_guard_trg` intentionally block `DELETE` on `storage_objects` and `storage_object_locks` (use `TRUNCATE TABLE storage_object_access_logs, storage_object_locks, storage_objects RESTART IDENTITY CASCADE` when resetting test tables).

## 3. Complete `core-back/lib/objectStorageSdk/` Implementation

Create the following 6 files in `core-back/lib/objectStorageSdk/`. Every file is shown in full below.

### 3.1 `core-back/lib/objectStorageSdk/types.ts`

```
// core-back/lib/objectStorageSdk/types.ts
import type {
  Prisma,
  PrismaClient,
  StorageAvScanStatus,
  StorageBucketTier,
  StorageNamespace,
  StorageObjectStatus,
} from '../../generated/prisma/client'

export type DbTxClient = Prisma.TransactionClient | PrismaClient

export type StorageHolderType =
  | 'KYB_DOCUMENT'
  | 'RECON_RUN'
  | 'REG_REPORT_SCHEMA'
  | 'REG_REPORT_OUTPUT'
  | 'REPORT_ASSET_ENTRY'
  | 'CATALOG_ASSET'
  | 'RAIL_LOGO'
  | 'DISPUTE_ATTACHMENT'
  | 'AML_CASE_EVIDENCE'

export interface NamespacePolicy {
  namespace: StorageNamespace
  defaultBucket: StorageBucketTier
  allowedMimeTypes: readonly string[]
  maxByteSize: number
  requiresAsyncAvScan: boolean
  defaultRetentionDays: number // Applied ONLY at promote() time, never at stageUpload()
  requiredAuthority: string
  confidentialityTier: 'PUBLIC_BRAND' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED_PII'
}

export const NAMESPACE_POLICIES: Record<StorageNamespace, NamespacePolicy> = {
  KYB_DOCUMENTS: {
    namespace: 'KYB_DOCUMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
    maxByteSize: 25 * 1024 * 1024,
    requiresAsyncAvScan: true,
    defaultRetentionDays: 365 * 7, // 7 years after activation
    requiredAuthority: 'kyb:read',
    confidentialityTier: 'RESTRICTED_PII',
  },
  RECON_STATEMENTS: {
    namespace: 'RECON_STATEMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['text/csv', 'text/plain', 'application/xml', 'application/json'],
    maxByteSize: 100 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 7,
    requiredAuthority: 'reconciliation:read',
    confidentialityTier: 'CONFIDENTIAL',
  },
  REGULATORY_REPORTS: {
    namespace: 'REGULATORY_REPORTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'text/csv', 'application/xml', 'application/json', 'text/plain'],
    maxByteSize: 100 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 10,
    requiredAuthority: 'compliance:reports:read',
    confidentialityTier: 'RESTRICTED_PII',
  },
  REPORT_STUDIO_ASSETS: {
    namespace: 'REPORT_STUDIO_ASSETS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'font/ttf', 'font/woff2'],
    maxByteSize: 10 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 5,
    requiredAuthority: 'reports.studio.read',
    confidentialityTier: 'INTERNAL',
  },
  MERCHANT_STATEMENTS: {
    namespace: 'MERCHANT_STATEMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'text/csv', 'application/json'],
    maxByteSize: 50 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365 * 7,
    requiredAuthority: 'reports:read',
    confidentialityTier: 'CONFIDENTIAL',
  },
  DISPUTE_EVIDENCE: {
    namespace: 'DISPUTE_EVIDENCE',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
    maxByteSize: 25 * 1024 * 1024,
    requiresAsyncAvScan: true,
    defaultRetentionDays: 365 * 7,
    requiredAuthority: 'disputes:read',
    confidentialityTier: 'CONFIDENTIAL',
  },
  AML_CASE_ATTACHMENTS: {
    namespace: 'AML_CASE_ATTACHMENTS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'application/json'],
    maxByteSize: 50 * 1024 * 1024,
    requiresAsyncAvScan: true,
    defaultRetentionDays: 365 * 10,
    requiredAuthority: 'compliance:aml:read',
    confidentialityTier: 'RESTRICTED_PII',
  },
  SYSTEM_BRAND_ASSETS: {
    namespace: 'SYSTEM_BRAND_ASSETS',
    defaultBucket: 'HOT',
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
    maxByteSize: 5 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 365,
    requiredAuthority: 'system:assets:read',
    confidentialityTier: 'PUBLIC_BRAND',
  },
  BACKUP_ARTIFACTS: {
    namespace: 'BACKUP_ARTIFACTS',
    defaultBucket: 'COLD',
    allowedMimeTypes: ['application/octet-stream', 'application/gzip', 'application/json'],
    maxByteSize: 1024 * 1024 * 1024,
    requiresAsyncAvScan: false,
    defaultRetentionDays: 90,
    requiredAuthority: 'system:storage:admin',
    confidentialityTier: 'RESTRICTED_PII',
  },
}

export interface StorageActorContext {
  actorType: 'ADMIN' | 'MERCHANT_USER' | 'SYSTEM_WORKER'
  actorId: string
  merchantId?: string | null
  authorities: readonly string[]
  ipAddress?: string | null
  requestId?: string | null
}

export interface StageUploadInput {
  namespace: StorageNamespace
  data: Uint8Array | Buffer | ReadableStream<Uint8Array>
  originalFilename?: string | null
  claimedMimeType?: string | null
  ownerMerchantId?: string | null
  actor: StorageActorContext
  metadata?: Record<string, unknown>
}

export interface StagedObjectHandle {
  objectId: string
  bucket: StorageBucketTier
  storageKey: string
  sha256Hex: string
  byteSize: bigint
  detectedMimeType: string
  requiresAsyncAvScan: boolean
}

export interface BindLockInput {
  objectId: string
  holderType: StorageHolderType
  holderId: string
  actorId: string
  reason: string
  retentionFloorUntil?: Date | null
  autoPromoteIfNoAvRequired?: boolean
}

export interface ReleaseLockInput {
  objectId: string
  holderType: StorageHolderType
  holderId: string
  actorId: string
  reason: string
}

export interface ReadAuthorizedInput {
  objectId: string
  actor: StorageActorContext
  holderContext?: {
    holderType: StorageHolderType
    holderId: string
  }
}

export interface ReadObjectResult {
  objectId: string
  detectedMimeType: string
  originalFilename: string | null
  byteSize: bigint
  sha256Hex: string
  bytes: Uint8Array
  stream: () => ReadableStream<Uint8Array>
}

export type StorageErrorCode =
  | 'STORAGE_MIME_FORBIDDEN'
  | 'STORAGE_SVG_UNSAFE'
  | 'STORAGE_SIZE_EXCEEDED'
  | 'STORAGE_EMPTY_PAYLOAD'
  | 'STORAGE_OBJECT_NOT_FOUND'
  | 'STORAGE_OBJECT_QUARANTINED'
  | 'STORAGE_OBJECT_STAGING_NOT_READY'
  | 'STORAGE_OBJECT_PURGED'
  | 'STORAGE_ACCESS_DENIED'
  | 'STORAGE_TENANT_MISMATCH'
  | 'STORAGE_INTEGRITY_CORRUPTED'
  | 'STORAGE_LOCKED_CANNOT_DELETE'
  | 'STORAGE_LEGAL_HOLD_ACTIVE'

export class ObjectStorageError extends Error {
  public readonly code: StorageErrorCode
  public readonly httpStatus: number

  constructor(code: StorageErrorCode, message: string, httpStatus = 400) {
    super(message)
    this.name = 'ObjectStorageError'
    this.code = code
    this.httpStatus = httpStatus
  }
}





```

### 3.2 `core-back/lib/objectStorageSdk/sniff.ts`

```
// core-back/lib/objectStorageSdk/sniff.ts
import { ObjectStorageError } from './types'

const UNSAFE_SVG_PATTERNS: readonly RegExp[] = [
  /<script\b/i,
  /\bon[a-z]+\s*=/i,
  /<foreignObject\b/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /<iframe\b/i,
  /<embed\b/i,
  /<object\b/i,
]

export function sanitizeAndValidateSvg(rawBytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes)
  if (!text.includes('<svg')) {
    throw new ObjectStorageError('STORAGE_MIME_FORBIDDEN', 'Invalid SVG container', 415)
  }
  for (const pattern of UNSAFE_SVG_PATTERNS) {
    if (pattern.test(text)) {
      throw new ObjectStorageError(
        'STORAGE_SVG_UNSAFE',
        `SVG rejected due to forbidden active content matching ${pattern.source}`,
        415
      )
    }
  }
}

export function detectMimeTypeFromMagicBytes(
  header: Uint8Array,
  claimedMimeType?: string | null,
  originalFilename?: string | null
): string {
  if (header.byteLength === 0) {
    throw new ObjectStorageError('STORAGE_EMPTY_PAYLOAD', 'Cannot upload an empty 0-byte payload', 400)
  }

  // 1. PDF: %PDF-
  if (
    header.byteLength >= 5 &&
    header[0] === 0x25 &&
    header[1] === 0x50 &&
    header[2] === 0x44 &&
    header[3] === 0x46 &&
    header[4] === 0x2d
  ) {
    return 'application/pdf'
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    header.byteLength >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'image/png'
  }

  // 3. JPEG: FF D8 FF
  if (header.byteLength >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg'
  }

  // 4. WEBP: RIFF....WEBP
  if (
    header.byteLength >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'image/webp'
  }

  // 5. GZIP: 1F 8B
  if (header.byteLength >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
    return 'application/gzip'
  }

  // 6. WOFF2: wOF2 (77 4F 46 32)
  if (
    header.byteLength >= 4 &&
    header[0] === 0x77 &&
    header[1] === 0x4f &&
    header[2] === 0x46 &&
    header[3] === 0x32
  ) {
    return 'font/woff2'
  }

  // 7. TTF: 00 01 00 00
  if (
    header.byteLength >= 4 &&
    header[0] === 0x00 &&
    header[1] === 0x01 &&
    header[2] === 0x00 &&
    header[3] === 0x00
  ) {
    return 'font/ttf'
  }

  // 8. Reject executable headers immediately (ELF, MZ/PE, Mach-O)
  if (
    (header.byteLength >= 4 &&
      header[0] === 0x7f &&
      header[1] === 0x45 &&
      header[2] === 0x4c &&
      header[3] === 0x46) ||
    (header.byteLength >= 2 && header[0] === 0x4d && header[1] === 0x5a)
  ) {
    throw new ObjectStorageError('STORAGE_MIME_FORBIDDEN', 'Executable binary uploads are strictly forbidden', 415)
  }

  // 9. Text-based formats (SVG, XML, JSON, CSV, plain text)
  const sample = new TextDecoder('utf-8', { fatal: false })
    .decode(header.subarray(0, Math.min(header.byteLength, 2048)))
    .trimStart()

  if (sample.startsWith('<svg') || (sample.startsWith('<?xml') && sample.includes('<svg'))) {
    return 'image/svg+xml'
  }
  if (sample.startsWith('<?xml') || sample.startsWith('<Document') || sample.startsWith('<BkToCstmrStmt')) {
    return 'application/xml'
  }
  if (sample.startsWith('{') || sample.startsWith('[')) {
    return 'application/json'
  }

  let nonPrintable = 0
  const checkLen = Math.min(header.byteLength, 512)
  for (let i = 0; i < checkLen; i++) {
    const b = header[i]!
    if (b === 0x00) {
      nonPrintable++
      break
    }
  }

  if (nonPrintable === 0) {
    const lowerName = (originalFilename ?? '').toLowerCase()
    if (claimedMimeType === 'text/csv' || lowerName.endsWith('.csv') || sample.includes(',')) {
      return 'text/csv'
    }
    return 'text/plain'
  }

  return 'application/octet-stream'
}





```

### 3.3 `core-back/lib/objectStorageSdk/crypto.ts`

```
// core-back/lib/objectStorageSdk/crypto.ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ObjectStorageError } from './types'

export const PGOS_MAGIC = Buffer.from('pgos1', 'ascii') // 5 bytes
export const DEFAULT_CHUNK_SIZE = 65536 // 64 KiB
const GCM_TAG_BYTES = 16

export interface KeyringMaterial {
  activeVersion: number
  keysByVersion: Map<number, Buffer> // 32-byte AES-256 KEKs
}

export class InMemoryKeyProvider {
  private readonly keyring: KeyringMaterial

  constructor(keyring: KeyringMaterial) {
    if (!keyring.keysByVersion.has(keyring.activeVersion)) {
      throw new Error(`Active KEK version ${keyring.activeVersion} is missing from keyring`)
    }
    this.keyring = keyring
  }

  static fromEnv(): InMemoryKeyProvider {
    const rawKeyring = process.env.OBJECT_STORAGE_KEK_KEYRING?.trim()
    const activeVer = Number(process.env.OBJECT_STORAGE_ACTIVE_KEK_VERSION ?? '1')
    const map = new Map<number, Buffer>()

    if (rawKeyring) {
      // Format: "v1:64hexchars,v2:64hexchars"
      for (const entry of rawKeyring.split(',')) {
        const [verPart, hexPart] = entry.trim().split(':')
        if (!verPart || !hexPart) continue
        const v = Number(verPart.replace(/^v/i, ''))
        const buf = Buffer.from(hexPart, 'hex')
        if (buf.byteLength !== 32) {
          throw new Error(`Invalid KEK length for version ${v}: expected 32 bytes (64 hex chars)`)
        }
        map.set(v, buf)
      }
    } else {
      const fallback = createHash('sha256')
        .update(process.env.DATABASE_URL ?? 'pg-monolith-default-dev-kek-v1')
        .digest()
      map.set(1, fallback)
    }

    return new InMemoryKeyProvider({
      activeVersion: map.has(activeVer) ? activeVer : Array.from(map.keys())[0]!,
      keysByVersion: map,
    })
  }

  getActiveVersion(): number {
    return this.keyring.activeVersion
  }

  wrapDek(dek: Buffer, objectId: string, keyVersion = this.keyring.activeVersion): {
    kekKeyVersion: number
    wrappedDek: Buffer
    dekNonce: Buffer
  } {
    const kek = this.keyring.keysByVersion.get(keyVersion)
    if (!kek) {
      throw new Error(`KEK version ${keyVersion} not found in keyring`)
    }
    const dekNonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', kek, dekNonce)
    cipher.setAAD(Buffer.from(`dek:${objectId}:v${keyVersion}`, 'utf8'))
    const ct = Buffer.concat([cipher.update(dek), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      kekKeyVersion: keyVersion,
      wrappedDek: Buffer.concat([ct, tag]),
      dekNonce,
    }
  }

  unwrapDek(wrappedDek: Uint8Array, dekNonce: Uint8Array, objectId: string, keyVersion: number): Buffer {
    const kek = this.keyring.keysByVersion.get(keyVersion)
    if (!kek) {
      throw new ObjectStorageError(
        'STORAGE_INTEGRITY_CORRUPTED',
        `Cannot unwrap DEK: KEK version ${keyVersion} not loaded`,
        500
      )
    }
    const buf = Buffer.from(wrappedDek)
    if (buf.byteLength < GCM_TAG_BYTES + 32) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Malformed wrapped DEK length', 500)
    }
    const ct = buf.subarray(0, buf.byteLength - GCM_TAG_BYTES)
    const tag = buf.subarray(buf.byteLength - GCM_TAG_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(dekNonce))
      decipher.setAAD(Buffer.from(`dek:${objectId}:v${keyVersion}`, 'utf8'))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()])
    } catch {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'DEK unwrap authentication tag mismatch', 500)
    }
  }
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) {
    return createHash('md5').update(uuid).digest()
  }
  return Buffer.from(hex, 'hex')
}

function buildChunkNonce(streamNoncePrefix: Uint8Array, chunkIndex: number, isFinal: boolean): Buffer {
  const nonce = Buffer.allocUnsafe(12)
  Buffer.from(streamNoncePrefix).copy(nonce, 0, 0, 7)
  nonce.writeUInt32BE(chunkIndex >>> 0, 7)
  nonce.writeUInt8(isFinal ? 1 : 0, 11)
  return nonce
}

function buildChunkAad(objectId: string, chunkIndex: number, isFinal: boolean): Buffer {
  const aad = Buffer.allocUnsafe(21)
  uuidToBytes(objectId).copy(aad, 0, 0, 16)
  aad.writeUInt32BE(chunkIndex >>> 0, 16)
  aad.writeUInt8(isFinal ? 1 : 0, 20)
  return aad
}

export interface EncryptedEnvelopeResult {
  ciphertextBytes: Buffer
  plaintextSha256Hex: string
  plaintextByteSize: bigint
  chunkSizeBytes: number
  chunkCount: number
  kekKeyVersion: number
  wrappedDek: Buffer
  dekNonce: Buffer
  streamNoncePrefix: Buffer
}

export function encryptBufferToPgos1(
  plaintext: Uint8Array,
  objectId: string,
  keyProvider: InMemoryKeyProvider,
  chunkSizeBytes = DEFAULT_CHUNK_SIZE
): EncryptedEnvelopeResult {
  if (plaintext.byteLength === 0) {
    throw new ObjectStorageError('STORAGE_EMPTY_PAYLOAD', 'Cannot encrypt empty 0-byte payload', 400)
  }

  const dek = randomBytes(32)
  const streamNoncePrefix = randomBytes(7)
  const { kekKeyVersion, wrappedDek, dekNonce } = keyProvider.wrapDek(dek, objectId)
  const sha256 = createHash('sha256')
  sha256.update(plaintext)
  const plaintextSha256Hex = sha256.digest('hex')

  const totalChunks = Math.ceil(plaintext.byteLength / chunkSizeBytes)
  const parts: Buffer[] = [PGOS_MAGIC]

  for (let idx = 0; idx < totalChunks; idx++) {
    const start = idx * chunkSizeBytes
    const end = Math.min(start + chunkSizeBytes, plaintext.byteLength)
    const slice = plaintext.subarray(start, end)
    const isFinal = idx === totalChunks - 1

    const nonce = buildChunkNonce(streamNoncePrefix, idx, isFinal)
    const aad = buildChunkAad(objectId, idx, isFinal)
    const cipher = createCipheriv('aes-256-gcm', dek, nonce)
    cipher.setAAD(aad)
    const ct = Buffer.concat([cipher.update(slice), cipher.final()])
    const tag = cipher.getAuthTag()

    const frameHeader = Buffer.allocUnsafe(4)
    frameHeader.writeUInt32BE(slice.byteLength, 0)
    parts.push(frameHeader, ct, tag)
  }

  return {
    ciphertextBytes: Buffer.concat(parts),
    plaintextSha256Hex,
    plaintextByteSize: BigInt(plaintext.byteLength),
    chunkSizeBytes,
    chunkCount: totalChunks,
    kekKeyVersion,
    wrappedDek,
    dekNonce,
    streamNoncePrefix,
  }
}

export function decryptPgos1ToBuffer(params: {
  ciphertext: Uint8Array
  objectId: string
  kekKeyVersion: number
  wrappedDek: Uint8Array
  dekNonce: Uint8Array
  streamNoncePrefix: Uint8Array
  expectedChunkCount: number
  expectedByteSize: bigint
  expectedSha256Hex: string
  keyProvider: InMemoryKeyProvider
}): Buffer {
  const {
    ciphertext,
    objectId,
    kekKeyVersion,
    wrappedDek,
    dekNonce,
    streamNoncePrefix,
    expectedChunkCount,
    expectedByteSize,
    expectedSha256Hex,
    keyProvider,
  } = params

  const buf = Buffer.from(ciphertext)
  if (buf.byteLength < PGOS_MAGIC.byteLength) {
    throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Ciphertext shorter than pgos1 magic header', 500)
  }
  const magic = buf.subarray(0, PGOS_MAGIC.byteLength)
  if (!magic.equals(PGOS_MAGIC)) {
    throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Invalid pgos1 magic header', 500)
  }

  const dek = keyProvider.unwrapDek(wrappedDek, dekNonce, objectId, kekKeyVersion)
  let offset = PGOS_MAGIC.byteLength
  let chunkIdx = 0
  let sawFinalChunk = false
  const plaintextChunks: Buffer[] = []
  const sha256 = createHash('sha256')

  while (offset < buf.byteLength) {
    if (offset + 4 > buf.byteLength) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Truncated frame header in pgos1 stream', 500)
    }
    const plainLen = buf.readUInt32BE(offset)
    offset += 4
    const frameEnd = offset + plainLen + GCM_TAG_BYTES
    if (frameEnd > buf.byteLength) {
      throw new ObjectStorageError('STORAGE_INTEGRITY_CORRUPTED', 'Truncated ciphertext frame in pgos1 stream', 500)
    }

    const ctSlice = buf.subarray(offset, offset + plainLen)
    const tagSlice = buf.subarray(offset + plainLen, frameEnd)
    offset = frameEnd

    const isFinal = offset === buf.byteLength
    const nonce = buildChunkNonce(streamNoncePrefix, chunkIdx, isFinal)
    const aad = buildChunkAad(objectId, chunkIdx, isFinal)

    let decryptedChunk: Buffer
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, nonce)
      decipher.setAAD(aad)
      decipher.setAuthTag(tagSlice)
      decryptedChunk = Buffer.concat([decipher.update(ctSlice), decipher.final()])
    } catch {
      throw new ObjectStorageError(
        'STORAGE_INTEGRITY_CORRUPTED',
        `GCM authentication failed at chunk ${chunkIdx} of object ${objectId}`,
        500
      )
    }

    plaintextChunks.push(decryptedChunk)
    sha256.update(decryptedChunk)
    if (isFinal) {
      sawFinalChunk = true
    }
    chunkIdx++
  }

  if (!sawFinalChunk || chunkIdx !== expectedChunkCount) {
    throw new ObjectStorageError(
      'STORAGE_INTEGRITY_CORRUPTED',
      `Chunk count mismatch on object ${objectId}: expected ${expectedChunkCount}, got ${chunkIdx}`,
      500
    )
  }

  const fullPlaintext = Buffer.concat(plaintextChunks)
  if (BigInt(fullPlaintext.byteLength) !== expectedByteSize) {
    throw new ObjectStorageError(
      'STORAGE_INTEGRITY_CORRUPTED',
      `Plaintext size mismatch on object ${objectId}: expected ${expectedByteSize}, got ${fullPlaintext.byteLength}`,
      500
    )
  }

  const computedSha = sha256.digest('hex')
  if (computedSha !== expectedSha256Hex) {
    throw new ObjectStorageError(
      'STORAGE_INTEGRITY_CORRUPTED',
      `Plaintext SHA-256 mismatch on object ${objectId}: expected ${expectedSha256Hex}, got ${computedSha}`,
      500
    )
  }

  return fullPlaintext
}





```

### 3.4 `core-back/lib/objectStorageSdk/blobStore.ts` (Includes Both `FsBlobStore` and Multi-Node `RemoteMtlsBlobStore`)

```
// core-back/lib/objectStorageSdk/blobStore.ts
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as https from 'node:https'
import * as http from 'node:http'
import * as path from 'node:path'
import type { StorageBucketTier } from '../../generated/prisma/client'

export interface BlobListEntry {
  bucket: StorageBucketTier
  relPath: string
  byteSize: number
  mtimeMs: number
}

export interface BlobHealthReport {
  ok: boolean
  mode: 'FS_LOCAL' | 'REMOTE_MTLS'
  rootDirOrUrl: string
  freeBytes: number
  latencyMs: number
  error?: string
}

export interface BlobStore {
  put(bucket: StorageBucketTier, relPath: string, data: Uint8Array): Promise<{ byteSize: number; sha256Hex: string }>
  readBytes(bucket: StorageBucketTier, relPath: string): Promise<Buffer>
  stat(bucket: StorageBucketTier, relPath: string): Promise<{ exists: boolean; byteSize: number }>
  moveToTrash(bucket: StorageBucketTier, relPath: string, trashDateIso?: string): Promise<void>
  purgeTrashOlderThan(cutoffDateIso: string): Promise<number>
  list(bucket: StorageBucketTier, prefix?: string): Promise<BlobListEntry[]>
  healthCheck(): Promise<BlobHealthReport>
}

const BUCKET_DIRS: Record<StorageBucketTier, string> = {
  HOT: 'hot',
  COLD: 'cold',
  QUARANTINE: 'quarantine',
}

function sanitizeRelPath(relPath: string): string {
  const normalized = path.posix.normalize(relPath).replace(/^\/+/, '')
  if (!normalized || normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\0')) {
    throw new Error(`Unsafe storage relative path rejected: "${relPath}"`)
  }
  return normalized
}

/**
 * 1. FsBlobStore: Direct atomic POSIX storage driver.
 * Used directly by:
 *   - deploy/object-storage-daemon on the dedicated OBJECT_STORAGE_NODE host (/srv/objects)
 *   - core-back in single-host deployments or local dev/test when OBJECT_STORAGE_DAEMON_URL is unset
 */
export class FsBlobStore implements BlobStore {
  public readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
    for (const sub of ['hot', 'cold', 'quarantine', 'tmp', '.trash']) {
      fs.mkdirSync(path.join(this.rootDir, sub), { recursive: true })
    }
  }

  private resolveTargetPath(bucket: StorageBucketTier, relPath: string): string {
    const safeRel = sanitizeRelPath(relPath)
    const bucketRoot = path.join(this.rootDir, BUCKET_DIRS[bucket])
    const resolved = path.resolve(bucketRoot, safeRel)
    if (!resolved.startsWith(bucketRoot + path.sep)) {
      throw new Error(`Path traversal outside bucket root rejected: ${relPath}`)
    }
    return resolved
  }

  async put(bucket: StorageBucketTier, relPath: string, data: Uint8Array): Promise<{ byteSize: number; sha256Hex: string }> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    const tmpPath = path.join(this.rootDir, 'tmp', `${randomUUID()}.part`)
    const sha256Hex = createHash('sha256').update(data).digest('hex')

    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    const handle = await fsp.open(tmpPath, 'w', 0o640)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }

    await fsp.rename(tmpPath, targetPath)
    return { byteSize: data.byteLength, sha256Hex }
  }

  async readBytes(bucket: StorageBucketTier, relPath: string): Promise<Buffer> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    return fsp.readFile(targetPath)
  }

  async stat(bucket: StorageBucketTier, relPath: string): Promise<{ exists: boolean; byteSize: number }> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    try {
      const st = await fsp.stat(targetPath)
      return { exists: st.isFile(), byteSize: st.size }
    } catch {
      return { exists: false, byteSize: 0 }
    }
  }

  async moveToTrash(bucket: StorageBucketTier, relPath: string, trashDateIso?: string): Promise<void> {
    const targetPath = this.resolveTargetPath(bucket, relPath)
    const dayFolder = (trashDateIso ?? new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '')
    const safeRel = sanitizeRelPath(relPath)
    const trashTarget = path.join(this.rootDir, '.trash', dayFolder, BUCKET_DIRS[bucket], safeRel)
    try {
      await fsp.mkdir(path.dirname(trashTarget), { recursive: true })
      await fsp.rename(targetPath, trashTarget)
    } catch (err: any) {
      if (err?.code === 'ENOENT') return
      throw err
    }
  }

  async purgeTrashOlderThan(cutoffDateIso: string): Promise<number> {
    const trashRoot = path.join(this.rootDir, '.trash')
    let purgedDirs = 0
    let entries: fs.Dirent[] = []
    try {
      entries = await fsp.readdir(trashRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name < cutoffDateIso) {
        await fsp.rm(path.join(trashRoot, entry.name), { recursive: true, force: true })
        purgedDirs++
      }
    }
    return purgedDirs
  }

  async list(bucket: StorageBucketTier, prefix = ''): Promise<BlobListEntry[]> {
    const bucketRoot = path.join(this.rootDir, BUCKET_DIRS[bucket])
    const results: BlobListEntry[] = []
    const cleanPrefix = prefix ? sanitizeRelPath(prefix) : ''

    const walk = async (currentDir: string) => {
      let entries: fs.Dirent[] = []
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.isFile()) {
          const rel = path.relative(bucketRoot, fullPath).split(path.sep).join('/')
          if (!cleanPrefix || rel.startsWith(cleanPrefix)) {
            const st = await fsp.stat(fullPath)
            results.push({
              bucket,
              relPath: rel,
              byteSize: st.size,
              mtimeMs: st.mtimeMs,
            })
          }
        }
      }
    }

    await walk(bucketRoot)
    return results
  }

  async healthCheck(): Promise<BlobHealthReport> {
    const start = performance.now()
    try {
      const probePath = path.join(this.rootDir, 'tmp', `.health-${randomUUID()}`)
      await fsp.writeFile(probePath, 'ok')
      await fsp.unlink(probePath)
      let freeBytes = 10 * 1024 * 1024 * 1024
      if (typeof fsp.statfs === 'function') {
        const st = await fsp.statfs(this.rootDir)
        freeBytes = Number(st.bavail) * Number(st.bsize)
      }
      return {
        ok: true,
        mode: 'FS_LOCAL',
        rootDirOrUrl: this.rootDir,
        freeBytes,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      }
    } catch (err: any) {
      return {
        ok: false,
        mode: 'FS_LOCAL',
        rootDirOrUrl: this.rootDir,
        freeBytes: 0,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
        error: err?.message ?? String(err),
      }
    }
  }
}

/**
 * 2. RemoteMtlsBlobStore: Network-Shared Storage Driver for Multi-Node Clusters.
 * Connects every stateless core-back node (core-1, core-2, ...) and backup-daemon (backup-1)
 * to the dedicated OBJECT_STORAGE_NODE running deploy/object-storage-daemon over mTLS.
 */
export interface RemoteMtlsBlobStoreConfig {
  baseUrl: string // e.g., "https://10.10.14.10:4095" or "http://127.0.0.1:4095" in local tests
  caCertPath?: string | null
  clientCertPath?: string | null
  clientKeyPath?: string | null
  timeoutMs?: number
}

export class RemoteMtlsBlobStore implements BlobStore {
  private readonly baseUrl: URL
  private readonly agent: https.Agent | http.Agent
  private readonly timeoutMs: number

  constructor(config: RemoteMtlsBlobStoreConfig) {
    this.baseUrl = new URL(config.baseUrl.replace(/\/+$/, ''))
    this.timeoutMs = config.timeoutMs ?? 30_000

    if (this.baseUrl.protocol === 'https:') {
      const ca = config.caCertPath && fs.existsSync(config.caCertPath) ? fs.readFileSync(config.caCertPath) : undefined
      const cert =
        config.clientCertPath && fs.existsSync(config.clientCertPath)
          ? fs.readFileSync(config.clientCertPath)
          : undefined
      const key =
        config.clientKeyPath && fs.existsSync(config.clientKeyPath) ? fs.readFileSync(config.clientKeyPath) : undefined
      this.agent = new https.Agent({
        keepAlive: true,
        ca,
        cert,
        key,
        rejectUnauthorized: Boolean(ca),
      })
    } else {
      this.agent = new http.Agent({ keepAlive: true })
    }
  }

  private requestRaw(
    method: string,
    urlPath: string,
    headers: Record<string, string> = {},
    body?: Uint8Array
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const target = new URL(urlPath, this.baseUrl)
      const mod = target.protocol === 'https:' ? https : http
      const req = mod.request(
        target,
        {
          method,
          agent: this.agent,
          headers: {
            ...headers,
            ...(body ? { 'content-length': String(body.byteLength) } : {}),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: res.headers,
              body: Buffer.concat(chunks),
            })
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error(`RemoteMtlsBlobStore request timed out after ${this.timeoutMs}ms: ${method} ${urlPath}`))
      })
      if (body) {
        req.write(Buffer.from(body))
      }
      req.end()
    })
  }

  async put(bucket: StorageBucketTier, relPath: string, data: Uint8Array): Promise<{ byteSize: number; sha256Hex: string }> {
    const safeRel = sanitizeRelPath(relPath)
    const sha256Hex = createHash('sha256').update(data).digest('hex')
    const res = await this.requestRaw(
      'PUT',
      `/v1/blobs/${encodeURIComponent(bucket)}/${safeRel}`,
      {
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha256Hex,
      },
      data
    )
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore PUT failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    return { byteSize: data.byteLength, sha256Hex }
  }

  async readBytes(bucket: StorageBucketTier, relPath: string): Promise<Buffer> {
    const safeRel = sanitizeRelPath(relPath)
    const res = await this.requestRaw('GET', `/v1/blobs/${encodeURIComponent(bucket)}/${safeRel}`)
    if (res.statusCode === 404) {
      const err: any = new Error(`Remote blob not found: ${bucket}/${safeRel}`)
      err.code = 'ENOENT'
      throw err
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore GET failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    return res.body
  }

  async stat(bucket: StorageBucketTier, relPath: string): Promise<{ exists: boolean; byteSize: number }> {
    const safeRel = sanitizeRelPath(relPath)
    const res = await this.requestRaw('HEAD', `/v1/blobs/${encodeURIComponent(bucket)}/${safeRel}`)
    if (res.statusCode === 404) {
      return { exists: false, byteSize: 0 }
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore HEAD failed (${res.statusCode})`)
    }
    return {
      exists: true,
      byteSize: Number(res.headers['x-blob-byte-size'] ?? res.headers['content-length'] ?? 0),
    }
  }

  async moveToTrash(bucket: StorageBucketTier, relPath: string, trashDateIso?: string): Promise<void> {
    const safeRel = sanitizeRelPath(relPath)
    const payload = Buffer.from(JSON.stringify({ trashDateIso }), 'utf8')
    const res = await this.requestRaw(
      'POST',
      `/v1/trash/${encodeURIComponent(bucket)}/${safeRel}`,
      { 'content-type': 'application/json' },
      payload
    )
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore moveToTrash failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
  }

  async purgeTrashOlderThan(cutoffDateIso: string): Promise<number> {
    const payload = Buffer.from(JSON.stringify({ cutoffDateIso }), 'utf8')
    const res = await this.requestRaw('POST', `/v1/purge-trash`, { 'content-type': 'application/json' }, payload)
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore purgeTrashOlderThan failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    const parsed = JSON.parse(res.body.toString('utf8')) as { purgedCount: number }
    return parsed.purgedCount ?? 0
  }

  async list(bucket: StorageBucketTier, prefix = ''): Promise<BlobListEntry[]> {
    const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
    const res = await this.requestRaw('GET', `/v1/list/${encodeURIComponent(bucket)}${qs}`)
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`RemoteMtlsBlobStore list failed (${res.statusCode}): ${res.body.toString('utf8')}`)
    }
    const parsed = JSON.parse(res.body.toString('utf8')) as { items: BlobListEntry[] }
    return parsed.items ?? []
  }

  async healthCheck(): Promise<BlobHealthReport> {
    const start = performance.now()
    try {
      const res = await this.requestRaw('GET', '/v1/health')
      if (res.statusCode !== 200) {
        return {
          ok: false,
          mode: 'REMOTE_MTLS',
          rootDirOrUrl: this.baseUrl.toString(),
          freeBytes: 0,
          latencyMs: Math.round((performance.now() - start) * 100) / 100,
          error: `HTTP ${res.statusCode}`,
        }
      }
      const data = JSON.parse(res.body.toString('utf8')) as { ok: boolean; freeBytes: number }
      return {
        ok: Boolean(data.ok),
        mode: 'REMOTE_MTLS',
        rootDirOrUrl: this.baseUrl.toString(),
        freeBytes: Number(data.freeBytes ?? 0),
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      }
    } catch (err: any) {
      return {
        ok: false,
        mode: 'REMOTE_MTLS',
        rootDirOrUrl: this.baseUrl.toString(),
        freeBytes: 0,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
        error: err?.message ?? String(err),
      }
    }
  }
}

export function createBlobStoreFromEnv(): BlobStore {
  const daemonUrl = process.env.OBJECT_STORAGE_DAEMON_URL?.trim()
  if (daemonUrl) {
    return new RemoteMtlsBlobStore({
      baseUrl: daemonUrl,
      caCertPath: process.env.OBJECT_STORAGE_TLS_CA_PATH ?? null,
      clientCertPath: process.env.OBJECT_STORAGE_TLS_CLIENT_CERT_PATH ?? null,
      clientKeyPath: process.env.OBJECT_STORAGE_TLS_CLIENT_KEY_PATH ?? null,
    })
  }

  // HARD GUARD: Never allow a production or multi-node core-back instance to silently write to its own local disk!
  const coreNodeCount = Number(process.env.CLUSTER_CORE_NODE_COUNT ?? '1')
  if (process.env.NODE_ENV === 'production' || coreNodeCount > 1) {
    throw new Error(
      'OBJECT_STORAGE_DAEMON_URL_REQUIRED: Shared storage is mandatory. Refusing to store blobs on a core node local disk in production or multi-node mode. Please configure OBJECT_STORAGE_NODE in deploy/deploy.env so all services read and write to the shared storage server.'
    )
  }

  // Allowed ONLY for single-process local development / unit tests
  const rootDir = process.env.OBJECT_STORAGE_ROOT_DIR?.trim() || '/tmp/pg-object-storage-dev'
  return new FsBlobStore(rootDir)
}





```

### 3.5 `core-back/lib/objectStorageSdk/holderRegistry.ts`

```
// core-back/lib/objectStorageSdk/holderRegistry.ts
import type { PrismaClient } from '../../generated/prisma/client'
import type { StorageHolderType } from './types'

/**
 * Maps every StorageHolderType to a batch existence query used by the daily
 * LockReconciler worker to detect and auto-release dangling locks if a domain
 * row was ever removed outside standard SDK release flows.
 */
export async function checkHoldersExistInDb(
  prisma: PrismaClient,
  holderType: StorageHolderType,
  holderIds: string[]
): Promise<Set<string>> {
  if (holderIds.length === 0) return new Set()

  switch (holderType) {
    case 'KYB_DOCUMENT': {
      const rows = await prisma.kybDocument.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'RECON_RUN': {
      const rows = await prisma.reconciliationRun.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'REG_REPORT_SCHEMA': {
      const rows = await prisma.regulatoryReportSchema.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'REG_REPORT_OUTPUT': {
      const rows = await prisma.regulatoryReportOutput.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'REPORT_ASSET_ENTRY': {
      const [staffBundles, merchantBundles] = await Promise.all([
        prisma.reportAssetBundle.findMany({
          where: { id: { in: holderIds } },
          select: { id: true },
        }),
        prisma.merchantReportAssetBundle.findMany({
          where: { id: { in: holderIds } },
          select: { id: true },
        }),
      ])
      return new Set([...staffBundles.map((r) => r.id), ...merchantBundles.map((r) => r.id)])
    }
    case 'CATALOG_ASSET': {
      const rows = await prisma.asset.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'RAIL_LOGO': {
      const rows = await prisma.rail.findMany({
        where: { id: { in: holderIds }, logoAssetId: { not: null } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'DISPUTE_ATTACHMENT': {
      const rows = await prisma.disputeAttachment.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
    case 'AML_CASE_EVIDENCE': {
      const rows = await prisma.amlCaseEvidence.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      })
      return new Set(rows.map((r) => r.id))
    }
  }
}





```

### 3.6 `core-back/lib/objectStorageSdk/index.ts` (Complete SDK: `routeClient` + `workerClient`)

```
// core-back/lib/objectStorageSdk/index.ts
import { randomUUID } from 'node:crypto'
import type { PrismaClient, StorageBucketTier, StorageNamespace } from '../../generated/prisma/client'
import { type BlobStore, createBlobStoreFromEnv } from './blobStore'
import { decryptPgos1ToBuffer, encryptBufferToPgos1, InMemoryKeyProvider } from './crypto'
import { checkHoldersExistInDb } from './holderRegistry'
import { detectMimeTypeFromMagicBytes, sanitizeAndValidateSvg } from './sniff'
import {
  type BindLockInput,
  type DbTxClient,
  NAMESPACE_POLICIES,
  ObjectStorageError,
  type ReadAuthorizedInput,
  type ReadObjectResult,
  type ReleaseLockInput,
  type StagedObjectHandle,
  type StageUploadInput,
  type StorageActorContext,
  type StorageHolderType,
} from './types'

export * from './types'
export * from './blobStore'
export * from './crypto'
export * from './sniff'
export * from './holderRegistry'

async function toUint8Array(data: Uint8Array | Buffer | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  const reader = data.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged
}

function buildStorageKey(namespace: StorageNamespace, ownerMerchantId: string | null | undefined, objectId: string): string {
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const tenantSegment = ownerMerchantId ? ownerMerchantId : 'shared'
  return `${namespace.toLowerCase()}/${tenantSegment}/${yyyy}/${mm}/${objectId}.v1.enc`
}

export interface ObjectStorageSdkOptions {
  prisma: PrismaClient
  blobStore?: BlobStore
  keyProvider?: InMemoryKeyProvider
  gcGraceHours?: number
  stagingTtlMinutes?: number
}

export function createObjectStorageSdk(options: ObjectStorageSdkOptions) {
  const prisma = options.prisma
  const blobStore = options.blobStore ?? createBlobStoreFromEnv()
  const keyProvider = options.keyProvider ?? InMemoryKeyProvider.fromEnv()
  const gcGraceMs = (options.gcGraceHours ?? 24) * 3600 * 1000
  const stagingTtlMs = (options.stagingTtlMinutes ?? 30) * 60 * 1000

  async function writeAccessLog(params: {
    objectId: string
    actor: StorageActorContext
    action: string
    allowed: boolean
    denialReason?: string | null
    holderType?: string | null
    holderId?: string | null
    bytesServed?: bigint | null
  }): Promise<void> {
    try {
      await prisma.storageObjectAccessLog.create({
        data: {
          objectId: params.objectId,
          actorType: params.actor.actorType,
          actorId: params.actor.actorId,
          action: params.action,
          allowed: params.allowed,
          denialReason: params.denialReason ?? null,
          holderType: params.holderType ?? null,
          holderId: params.holderId ?? null,
          ipAddress: params.actor.ipAddress ?? null,
          requestId: params.actor.requestId ?? null,
          bytesServed: params.bytesServed ?? null,
        },
      })
    } catch {
      // Non-fatal if objectId does not exist yet
    }
  }

  /**
   * Core staging logic (runs OUTSIDE any caller DB transaction).
   * Notice its signature does NOT accept a `tx` parameter, making network/disk I/O inside a DB tx impossible by construction.
   */
  async function stageUploadInternal(input: StageUploadInput, forceCleanAv = false): Promise<StagedObjectHandle> {
    const policy = NAMESPACE_POLICIES[input.namespace]
    const rawBytes = await toUint8Array(input.data)

    if (rawBytes.byteLength === 0) {
      throw new ObjectStorageError('STORAGE_EMPTY_PAYLOAD', 'Cannot stage an empty 0-byte file', 400)
    }
    if (rawBytes.byteLength > policy.maxByteSize) {
      throw new ObjectStorageError(
        'STORAGE_SIZE_EXCEEDED',
        `Payload size ${rawBytes.byteLength} exceeds max allowed ${policy.maxByteSize} for namespace ${input.namespace}`,
        413
      )
    }

    const detectedMimeType = detectMimeTypeFromMagicBytes(
      rawBytes.subarray(0, Math.min(rawBytes.byteLength, 4096)),
      input.claimedMimeType,
      input.originalFilename
    )

    if (!policy.allowedMimeTypes.includes(detectedMimeType)) {
      throw new ObjectStorageError(
        'STORAGE_MIME_FORBIDDEN',
        `Detected MIME type "${detectedMimeType}" is not permitted in namespace ${input.namespace}`,
        415
      )
    }

    if (detectedMimeType === 'image/svg+xml') {
      sanitizeAndValidateSvg(rawBytes)
    }

    const objectId = randomUUID()
    const bucket: StorageBucketTier = policy.defaultBucket
    const storageKey = buildStorageKey(input.namespace, input.ownerMerchantId, objectId)

    // 1. Encrypt in memory using pgos1 chunked AES-256-GCM envelope
    const encrypted = encryptBufferToPgos1(rawBytes, objectId, keyProvider)

    // 2. Insert STAGING intent row BEFORE writing blob to disk/remote daemon (prevents orphan blobs if process crashes)
    const requiresAv = policy.requiresAsyncAvScan && !forceCleanAv
    const stagingExpiresAt = new Date(Date.now() + stagingTtlMs)

    await prisma.storageObject.create({
      data: {
        id: objectId,
        bucket,
        namespace: input.namespace,
        storageKey,
        status: 'STAGING',
        sha256Hex: encrypted.plaintextSha256Hex,
        byteSize: encrypted.plaintextByteSize,
        chunkSizeBytes: encrypted.chunkSizeBytes,
        chunkCount: encrypted.chunkCount,
        detectedMimeType,
        originalFilename: input.originalFilename ?? null,
        kekKeyVersion: encrypted.kekKeyVersion,
        wrappedDek: encrypted.wrappedDek,
        dekNonce: encrypted.dekNonce,
        streamNoncePrefix: encrypted.streamNoncePrefix,
        ownerMerchantId: input.ownerMerchantId ?? null,
        uploadedByActorType: input.actor.actorType,
        uploadedByActorId: input.actor.actorId,
        requiredAuthority: policy.requiredAuthority,
        confidentialityTier: policy.confidentialityTier,
        retainUntil: null, // Retention is ONLY stamped at promote() time!
        avScanStatus: requiresAv ? 'PENDING' : 'NOT_REQUIRED',
        metadata: (input.metadata ?? {}) as any,
        stagingExpiresAt,
      },
    })

    // 3. Stream ciphertext to BlobStore (FsBlobStore or RemoteMtlsBlobStore on dedicated OBJECT_STORAGE_NODE)
    await blobStore.put(bucket, storageKey, encrypted.ciphertextBytes)

    return {
      objectId,
      bucket,
      storageKey,
      sha256Hex: encrypted.plaintextSha256Hex,
      byteSize: encrypted.plaintextByteSize,
      detectedMimeType,
      requiresAsyncAvScan: requiresAv,
    }
  }

  /**
   * Pure-SQL promote(): transitions object to ACTIVE and stamps retainUntil = GREATEST(existing, NOW() + policyDays, max lock floor)
   */
  async function promoteInTx(tx: DbTxClient, objectId: string): Promise<void> {
    const obj = await tx.storageObject.findUnique({
      where: { id: objectId },
      include: { locks: { where: { releasedAt: null } } },
    })
    if (!obj) {
      throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `StorageObject ${objectId} not found`, 404)
    }
    const policy = NAMESPACE_POLICIES[obj.namespace]
    const defaultRetainUntil = new Date(Date.now() + policy.defaultRetentionDays * 86400 * 1000)

    let maxRetain = defaultRetainUntil
    if (obj.retainUntil && obj.retainUntil > maxRetain) {
      maxRetain = obj.retainUntil
    }
    for (const lock of obj.locks) {
      if (lock.retentionFloorUntil && lock.retentionFloorUntil > maxRetain) {
        maxRetain = lock.retentionFloorUntil
      }
    }

    await tx.storageObject.update({
      where: { id: objectId },
      data: {
        status: 'ACTIVE',
        activatedAt: obj.activatedAt ?? new Date(),
        retainUntil: maxRetain,
        gcEligibleAt: null,
      },
    })
  }

  /**
   * Pure-SQL bind(): runs INSIDE caller's prisma.$transaction(async (tx) => ...)
   */
  async function bindInTx(tx: DbTxClient, input: BindLockInput): Promise<void> {
    const obj = await tx.storageObject.findUnique({ where: { id: input.objectId } })
    if (!obj) {
      throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `StorageObject ${input.objectId} not found`, 404)
    }
    if (obj.status === 'PURGED' || obj.status === 'QUARANTINE_REJECTED') {
      throw new ObjectStorageError(
        'STORAGE_OBJECT_PURGED',
        `Cannot bind lock to ${obj.status} object ${input.objectId}`,
        409
      )
    }

    await tx.storageObjectLock.upsert({
      where: {
        objectId_holderType_holderId: {
          objectId: input.objectId,
          holderType: input.holderType,
          holderId: input.holderId,
        },
      },
      create: {
        objectId: input.objectId,
        holderType: input.holderType,
        holderId: input.holderId,
        retentionFloorUntil: input.retentionFloorUntil ?? null,
        acquiredByActorId: input.actorId,
        acquiredReason: input.reason,
      },
      update: {
        releasedAt: null,
        releasedByActorId: null,
        releaseReason: null,
        acquiredByActorId: input.actorId,
        acquiredReason: input.reason,
        retentionFloorUntil: input.retentionFloorUntil ?? undefined,
      },
    })

    const policy = NAMESPACE_POLICIES[obj.namespace]
    const shouldPromoteNow =
      input.autoPromoteIfNoAvRequired !== false &&
      (!policy.requiresAsyncAvScan || obj.avScanStatus === 'CLEAN' || obj.avScanStatus === 'NOT_REQUIRED')

    if (shouldPromoteNow) {
      await promoteInTx(tx, input.objectId)
    } else if (obj.status === 'STAGING') {
      await tx.storageObject.update({
        where: { id: input.objectId },
        data: { status: 'QUARANTINE_PENDING_AV', gcEligibleAt: null },
      })
    } else if (obj.gcEligibleAt !== null) {
      await tx.storageObject.update({
        where: { id: input.objectId },
        data: { gcEligibleAt: null },
      })
    }
  }

  /**
   * Pure-SQL release(): marks the lock row released and, if zero active locks remain, stamps gc_eligible_at.
   */
  async function releaseInTx(tx: DbTxClient, input: ReleaseLockInput): Promise<{ remainingActiveLocks: number }> {
    await tx.storageObjectLock.updateMany({
      where: {
        objectId: input.objectId,
        holderType: input.holderType,
        holderId: input.holderId,
        releasedAt: null,
      },
      data: {
        releasedAt: new Date(),
        releasedByActorId: input.actorId,
        releaseReason: input.reason,
      },
    })

    const remainingActiveLocks = await tx.storageObjectLock.count({
      where: { objectId: input.objectId, releasedAt: null },
    })

    if (remainingActiveLocks === 0) {
      const obj = await tx.storageObject.findUnique({ where: { id: input.objectId } })
      if (obj && obj.status !== 'PURGED') {
        const graceTime = new Date(Date.now() + gcGraceMs)
        const gcEligibleAt = obj.retainUntil && obj.retainUntil > graceTime ? obj.retainUntil : graceTime
        await tx.storageObject.update({
          where: { id: input.objectId },
          data: { gcEligibleAt },
        })
      }
    }

    return { remainingActiveLocks }
  }

  async function discardStaged(objectId: string): Promise<void> {
    const obj = await prisma.storageObject.findUnique({
      where: { id: objectId },
      include: { locks: { where: { releasedAt: null } } },
    })
    if (!obj || obj.locks.length > 0 || obj.status === 'ACTIVE' || obj.status === 'PURGED') {
      return
    }
    await blobStore.moveToTrash(obj.bucket, obj.storageKey)
    await prisma.storageObject.update({
      where: { id: objectId },
      data: { status: 'PURGED', purgedAt: new Date() },
    })
  }

  const routeClient = {
    stageUpload: (input: StageUploadInput) => stageUploadInternal(input, false),

    bind: (tx: DbTxClient, input: BindLockInput) => bindInTx(tx, input),

    promote: (tx: DbTxClient, objectId: string) => promoteInTx(tx, objectId),

    release: (tx: DbTxClient, input: ReleaseLockInput) => releaseInTx(tx, input),

    discardStaged,

    /**
     * Convenience helper that stages BEFORE the DB transaction, executes fn(staged) inside/with the caller's DB logic,
     * and automatically cleans up the staged blob if fn() throws or rolls back!
     */
    async withStagedUpload<T>(input: StageUploadInput, fn: (staged: StagedObjectHandle) => Promise<T>): Promise<T> {
      const staged = await stageUploadInternal(input, false)
      try {
        return await fn(staged)
      } catch (err) {
        await discardStaged(staged.objectId).catch(() => {})
        throw err
      }
    },

    async readAuthorized(input: ReadAuthorizedInput): Promise<ReadObjectResult> {
      const obj = await prisma.storageObject.findUnique({
        where: { id: input.objectId },
        include: { locks: { where: { releasedAt: null } } },
      })

      if (!obj) {
        throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `Object ${input.objectId} not found`, 404)
      }

      if (obj.status === 'QUARANTINE_PENDING_AV' || obj.status === 'QUARANTINE_REJECTED') {
        await writeAccessLog({
          objectId: obj.id,
          actor: input.actor,
          action: 'READ_DENIED_QUARANTINE',
          allowed: false,
          denialReason: `Object status is ${obj.status}`,
          holderType: input.holderContext?.holderType,
          holderId: input.holderContext?.holderId,
        })
        throw new ObjectStorageError(
          'STORAGE_OBJECT_QUARANTINED',
          `Object ${obj.id} cannot be downloaded while in ${obj.status} state`,
          423
        )
      }

      if (obj.status !== 'ACTIVE') {
        await writeAccessLog({
          objectId: obj.id,
          actor: input.actor,
          action: 'READ_DENIED_STATUS',
          allowed: false,
          denialReason: `Object status is ${obj.status}`,
        })
        throw new ObjectStorageError(
          obj.status === 'PURGED' ? 'STORAGE_OBJECT_PURGED' : 'STORAGE_OBJECT_STAGING_NOT_READY',
          `Object ${obj.id} is in ${obj.status} state`,
          409
        )
      }

      if (input.holderContext) {
        const hasMatchingLock = obj.locks.some(
          (l) => l.holderType === input.holderContext!.holderType && l.holderId === input.holderContext!.holderId
        )
        if (!hasMatchingLock) {
          await writeAccessLog({
            objectId: obj.id,
            actor: input.actor,
            action: 'READ_DENIED_HOLDER_MISMATCH',
            allowed: false,
            denialReason: `Object ${obj.id} is not locked by ${input.holderContext.holderType}:${input.holderContext.holderId}`,
            holderType: input.holderContext.holderType,
            holderId: input.holderContext.holderId,
          })
          throw new ObjectStorageError(
            'STORAGE_ACCESS_DENIED',
            'Requested object is not bound to the specified domain record',
            403
          )
        }
      }

      if (input.actor.actorType === 'MERCHANT_USER') {
        if (!input.actor.merchantId || obj.ownerMerchantId !== input.actor.merchantId) {
          await writeAccessLog({
            objectId: obj.id,
            actor: input.actor,
            action: 'READ_DENIED_TENANT_MISMATCH',
            allowed: false,
            denialReason: `Actor merchant ${input.actor.merchantId} != object owner ${obj.ownerMerchantId}`,
          })
          throw new ObjectStorageError(
            'STORAGE_TENANT_MISMATCH',
            'Cross-tenant access to storage object is forbidden',
            403
          )
        }
      }

      const hasSuperAdmin = input.actor.authorities.includes('*') || input.actor.authorities.includes('system:storage:admin')
      const hasRequiredAuthority =
        hasSuperAdmin ||
        obj.confidentialityTier === 'PUBLIC_BRAND' ||
        input.actor.authorities.includes(obj.requiredAuthority)

      if (!hasRequiredAuthority) {
        await writeAccessLog({
          objectId: obj.id,
          actor: input.actor,
          action: 'READ_DENIED_AUTHORITY',
          allowed: false,
          denialReason: `Missing required authority: ${obj.requiredAuthority}`,
        })
        throw new ObjectStorageError(
          'STORAGE_ACCESS_DENIED',
          `Actor lacks required authority "${obj.requiredAuthority}" to read object ${obj.id}`,
          403
        )
      }

      const ciphertext = await blobStore.readBytes(obj.bucket, obj.storageKey)
      const decrypted = decryptPgos1ToBuffer({
        ciphertext,
        objectId: obj.id,
        kekKeyVersion: obj.kekKeyVersion,
        wrappedDek: obj.wrappedDek,
        dekNonce: obj.dekNonce,
        streamNoncePrefix: obj.streamNoncePrefix,
        expectedChunkCount: obj.chunkCount,
        expectedByteSize: obj.byteSize,
        expectedSha256Hex: obj.sha256Hex,
        keyProvider,
      })

      await writeAccessLog({
        objectId: obj.id,
        actor: input.actor,
        action: 'READ_AUTHORIZED',
        allowed: true,
        holderType: input.holderContext?.holderType,
        holderId: input.holderContext?.holderId,
        bytesServed: obj.byteSize,
      })

      return {
        objectId: obj.id,
        detectedMimeType: obj.detectedMimeType,
        originalFilename: obj.originalFilename,
        byteSize: obj.byteSize,
        sha256Hex: obj.sha256Hex,
        bytes: new Uint8Array(decrypted),
        stream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(decrypted))
              controller.close()
            },
          }),
      }
    },

    async placeLegalHold(params: { objectId: string; adminId: string; reason: string }) {
      const updated = await prisma.storageObject.update({
        where: { id: params.objectId },
        data: {
          legalHold: true,
          legalHoldReason: params.reason,
          legalHoldByAdminId: params.adminId,
          legalHoldPlacedAt: new Date(),
        },
      })
      await writeAccessLog({
        objectId: params.objectId,
        actor: { actorType: 'ADMIN', actorId: params.adminId, authorities: ['system:storage:legal-hold'] },
        action: 'PLACE_LEGAL_HOLD',
        allowed: true,
      })
      return updated
    },

    async liftLegalHold(params: { objectId: string; adminId: string; reason: string }) {
      const updated = await prisma.storageObject.update({
        where: { id: params.objectId },
        data: {
          legalHold: false,
          legalHoldReason: params.reason,
        },
      })
      await writeAccessLog({
        objectId: params.objectId,
        actor: { actorType: 'ADMIN', actorId: params.adminId, authorities: ['system:storage:legal-hold'] },
        action: 'LIFT_LEGAL_HOLD',
        allowed: true,
      })
      return updated
    },
  }

  // ============================================================================
  // workerClient: System Workers, AV Scanner, GC, Scrubber, Rewrap & Backup
  // ============================================================================
  const workerClient = {
    stageSystemGenerated: (input: Omit<StageUploadInput, 'actor'> & { actorId?: string }) =>
      stageUploadInternal(
        {
          ...input,
          actor: {
            actorType: 'SYSTEM_WORKER',
            actorId: input.actorId ?? 'system-worker',
            authorities: ['*'],
          },
        },
        true
      ),

    async readInternal(objectId: string, workerName: string): Promise<ReadObjectResult> {
      const obj = await prisma.storageObject.findUnique({ where: { id: objectId } })
      if (!obj) {
        throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `Object ${objectId} not found`, 404)
      }
      if (obj.status !== 'ACTIVE') {
        throw new ObjectStorageError(
          'STORAGE_OBJECT_QUARANTINED',
          `Worker ${workerName} cannot read non-ACTIVE object ${objectId} (status=${obj.status})`,
          423
        )
      }
      const ciphertext = await blobStore.readBytes(obj.bucket, obj.storageKey)
      const decrypted = decryptPgos1ToBuffer({
        ciphertext,
        objectId: obj.id,
        kekKeyVersion: obj.kekKeyVersion,
        wrappedDek: obj.wrappedDek,
        dekNonce: obj.dekNonce,
        streamNoncePrefix: obj.streamNoncePrefix,
        expectedChunkCount: obj.chunkCount,
        expectedByteSize: obj.byteSize,
        expectedSha256Hex: obj.sha256Hex,
        keyProvider,
      })
      await writeAccessLog({
        objectId: obj.id,
        actor: { actorType: 'SYSTEM_WORKER', actorId: workerName, authorities: ['*'] },
        action: 'READ_INTERNAL_WORKER',
        allowed: true,
        bytesServed: obj.byteSize,
      })
      return {
        objectId: obj.id,
        detectedMimeType: obj.detectedMimeType,
        originalFilename: obj.originalFilename,
        byteSize: obj.byteSize,
        sha256Hex: obj.sha256Hex,
        bytes: new Uint8Array(decrypted),
        stream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(decrypted))
              controller.close()
            },
          }),
      }
    },

    async readForScan(objectId: string): Promise<{ objectId: string; bytes: Buffer; detectedMimeType: string }> {
      const obj = await prisma.storageObject.findUnique({ where: { id: objectId } })
      if (!obj) {
        throw new ObjectStorageError('STORAGE_OBJECT_NOT_FOUND', `Object ${objectId} not found`, 404)
      }
      const ciphertext = await blobStore.readBytes(obj.bucket, obj.storageKey)
      const decrypted = decryptPgos1ToBuffer({
        ciphertext,
        objectId: obj.id,
        kekKeyVersion: obj.kekKeyVersion,
        wrappedDek: obj.wrappedDek,
        dekNonce: obj.dekNonce,
        streamNoncePrefix: obj.streamNoncePrefix,
        expectedChunkCount: obj.chunkCount,
        expectedByteSize: obj.byteSize,
        expectedSha256Hex: obj.sha256Hex,
        keyProvider,
      })
      return { objectId: obj.id, bytes: decrypted, detectedMimeType: obj.detectedMimeType }
    },

    async applyScanVerdict(params: {
      objectId: string
      verdict: 'CLEAN' | 'INFECTED'
      signature?: string | null
    }): Promise<void> {
      await prisma.$transaction(async (tx) => {
        if (params.verdict === 'CLEAN') {
          await tx.storageObject.update({
            where: { id: params.objectId },
            data: {
              avScanStatus: 'CLEAN',
              avScannedAt: new Date(),
              avSignature: null,
            },
          })
          await promoteInTx(tx, params.objectId)
        } else {
          await tx.storageObjectLock.updateMany({
            where: { objectId: params.objectId, releasedAt: null },
            data: {
              releasedAt: new Date(),
              releasedByActorId: 'av-scan-worker',
              releaseReason: `AV_INFECTED:${params.signature ?? 'MALWARE'}`,
            },
          })
          await tx.storageObject.update({
            where: { id: params.objectId },
            data: {
              status: 'QUARANTINE_REJECTED',
              avScanStatus: 'INFECTED',
              avScannedAt: new Date(),
              avSignature: params.signature ?? 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
              stagingExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            },
          })
        }
      })
    },

    async runGcBatch(now = new Date()): Promise<{ purgedObjectIds: string[] }> {
      const candidates = await prisma.storageObject.findMany({
        where: {
          legalHold: false,
          OR: [
            { status: 'STAGING', stagingExpiresAt: { lte: now } },
            { status: 'QUARANTINE_REJECTED', stagingExpiresAt: { lte: now } },
            {
              status: 'ACTIVE',
              gcEligibleAt: { lte: now },
              OR: [{ retainUntil: null }, { retainUntil: { lte: now } }],
            },
          ],
        },
        include: { locks: { where: { releasedAt: null } } },
        take: 100,
      })

      const purgedObjectIds: string[] = []
      for (const obj of candidates) {
        if (obj.locks.length > 0) continue
        await blobStore.moveToTrash(obj.bucket, obj.storageKey, now.toISOString().slice(0, 10))
        await prisma.storageObject.update({
          where: { id: obj.id },
          data: { status: 'PURGED', purgedAt: now },
        })
        purgedObjectIds.push(obj.id)
      }
      return { purgedObjectIds }
    },

    async runBlobSweep(params?: { minAgeMs?: number; trashRetentionDays?: number }): Promise<{
      trashedOrphans: string[]
      purgedTrashFolders: number
    }> {
      const minAgeMs = params?.minAgeMs ?? 3600 * 1000
      const trashRetentionDays = params?.trashRetentionDays ?? Number(process.env.OBJECT_STORAGE_TRASH_RETENTION_DAYS ?? '7')
      const cutoffMs = Date.now() - minAgeMs
      const trashedOrphans: string[] = []

      for (const bucket of ['HOT', 'COLD', 'QUARANTINE'] as StorageBucketTier[]) {
        const files = await blobStore.list(bucket)
        for (const f of files) {
          if (f.mtimeMs > cutoffMs) continue
          const row = await prisma.storageObject.findUnique({
            where: { bucket_storageKey: { bucket, storageKey: f.relPath } },
            select: { id: true, status: true },
          })
          if (!row || row.status === 'PURGED') {
            await blobStore.moveToTrash(bucket, f.relPath)
            trashedOrphans.push(`${bucket}:${f.relPath}`)
          }
        }
      }

      const cutoffDateIso = new Date(Date.now() - trashRetentionDays * 86400 * 1000).toISOString().slice(0, 10)
      const purgedTrashFolders = await blobStore.purgeTrashOlderThan(cutoffDateIso)
      return { trashedOrphans, purgedTrashFolders }
    },

    async runIntegrityScrubBatch(batchSize = 50): Promise<{
      verifiedCount: number
      corruptedObjectIds: string[]
    }> {
      const rows = await prisma.storageObject.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ lastScrubbedAt: 'asc' }, { createdAt: 'asc' }],
        take: batchSize,
      })

      let verifiedCount = 0
      const corruptedObjectIds: string[] = []

      for (const obj of rows) {
        try {
          const ciphertext = await blobStore.readBytes(obj.bucket, obj.storageKey)
          decryptPgos1ToBuffer({
            ciphertext,
            objectId: obj.id,
            kekKeyVersion: obj.kekKeyVersion,
            wrappedDek: obj.wrappedDek,
            dekNonce: obj.dekNonce,
            streamNoncePrefix: obj.streamNoncePrefix,
            expectedChunkCount: obj.chunkCount,
            expectedByteSize: obj.byteSize,
            expectedSha256Hex: obj.sha256Hex,
            keyProvider,
          })
          await prisma.storageObject.update({
            where: { id: obj.id },
            data: { lastScrubbedAt: new Date() },
          })
          verifiedCount++
        } catch {
          corruptedObjectIds.push(obj.id)
          await prisma.storageObject.update({
            where: { id: obj.id },
            data: {
              lastScrubbedAt: new Date(),
              scrubErrorCount: { increment: 1 },
            },
          })
        }
      }

      return { verifiedCount, corruptedObjectIds }
    },

    async runLockReconcile(): Promise<{ releasedDanglingLocks: number }> {
      const activeLocks = await prisma.storageObjectLock.findMany({
        where: { releasedAt: null },
      })
      const byType = new Map<StorageHolderType, typeof activeLocks>()
      for (const lock of activeLocks) {
        const ht = lock.holderType as StorageHolderType
        const list = byType.get(ht) ?? []
        list.push(lock)
        byType.set(ht, list)
      }

      let releasedDanglingLocks = 0
      for (const [holderType, locks] of byType.entries()) {
        const holderIds = Array.from(new Set(locks.map((l) => l.holderId)))
        const existingSet = await checkHoldersExistInDb(prisma, holderType, holderIds)
        for (const lock of locks) {
          if (!existingSet.has(lock.holderId)) {
            await prisma.$transaction(async (tx) => {
              await releaseInTx(tx, {
                objectId: lock.objectId,
                holderType,
                holderId: lock.holderId,
                actorId: 'lock-reconciler-worker',
                reason: 'HOLDER_ROW_MISSING_RECONCILED',
              })
            })
            releasedDanglingLocks++
          }
        }
      }
      return { releasedDanglingLocks }
    },

    async runRewrapBatch(batchSize = 100): Promise<{ rewrappedCount: number; targetVersion: number }> {
      const targetVersion = keyProvider.getActiveVersion()
      const rows = await prisma.storageObject.findMany({
        where: {
          status: { not: 'PURGED' },
          kekKeyVersion: { not: targetVersion },
        },
        take: batchSize,
      })

      let rewrappedCount = 0
      for (const obj of rows) {
        const dek = keyProvider.unwrapDek(obj.wrappedDek, obj.dekNonce, obj.id, obj.kekKeyVersion)
        const rewrapped = keyProvider.wrapDek(dek, obj.id, targetVersion)
        await prisma.storageObject.update({
          where: { id: obj.id },
          data: {
            kekKeyVersion: rewrapped.kekKeyVersion,
            wrappedDek: rewrapped.wrappedDek,
            dekNonce: rewrapped.dekNonce,
          },
        })
        rewrappedCount++
      }
      return { rewrappedCount, targetVersion }
    },

    async exportManifest(): Promise<
      Array<{
        id: string
        bucket: StorageBucketTier
        storageKey: string
        sha256Hex: string
        byteSize: string
        chunkCount: number
        kekKeyVersion: number
        wrappedDekHex: string
        dekNonceHex: string
        streamNoncePrefixHex: string
      }>
    > {
      const active = await prisma.storageObject.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      })
      return active.map((o) => ({
        id: o.id,
        bucket: o.bucket,
        storageKey: o.storageKey,
        sha256Hex: o.sha256Hex,
        byteSize: o.byteSize.toString(),
        chunkCount: o.chunkCount,
        kekKeyVersion: o.kekKeyVersion,
        wrappedDekHex: Buffer.from(o.wrappedDek).toString('hex'),
        dekNonceHex: Buffer.from(o.dekNonce).toString('hex'),
        streamNoncePrefixHex: Buffer.from(o.streamNoncePrefix).toString('hex'),
      }))
    },
  }

  return {
    blobStore,
    keyProvider,
    routeClient,
    workerClient,
  }
}

export type ObjectStorageSdk = ReturnType<typeof createObjectStorageSdk>





```

## 4. Dedicated Multi-Node Shared Storage Server (`deploy/object-storage-daemon/`)

To ensure zero external binary dependencies (`garage`, `minio`, or `ceph` are not required) and 100% compatibility with our existing `deploy/backup-daemon/` architecture, create the first-party **Shared Object Storage Daemon** in `deploy/object-storage-daemon/`.

When `OBJECT_STORAGE_NODE="obj-1@10.10.14.10:22:10.10.14.10:4095"` is configured in `deploy/deploy.env`:

* `deploy/provisioners/objectStorageProvisioner.ts` deploys `deploy/object-storage-daemon` to `obj-1`, provisions `/srv/objects/{hot,cold,quarantine,tmp,.trash}`, installs `pg-object-storage-daemon.service`, and configures mTLS (`internal-ca.crt` + `object-storage-daemon.crt` + `object-storage-daemon.key`).

* Every `core-back` node (`core-1`, `core-2`, ...) and `backup-daemon` (`backup-1`) automatically receives `OBJECT_STORAGE_DAEMON_URL="https://10.10.14.10:4095"` and mTLS client certificates (`object-storage-client.crt`, `object-storage-client.key`), sharing the exact same storage vault over mTLS.

### 4.1 `deploy/object-storage-daemon/package.json`

```
{
  "name": "@payment-gateway/object-storage-daemon",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "test": "bun test"
  }
}





```

### 4.2 `deploy/object-storage-daemon/src/config.ts`

```
// deploy/object-storage-daemon/src/config.ts
export interface ObjectStorageDaemonConfig {
  bindHost: string
  port: number
  rootDir: string
  tlsCaCertPath: string | null
  tlsServerCertPath: string | null
  tlsServerKeyPath: string | null
  allowedClientCns: string[]
  requireMtls: boolean
}

export function loadDaemonConfigFromEnv(overrides?: Partial<ObjectStorageDaemonConfig>): ObjectStorageDaemonConfig {
  const tlsCaCertPath = process.env.OBJECT_STORAGE_DAEMON_TLS_CA_PATH?.trim() || null
  const tlsServerCertPath = process.env.OBJECT_STORAGE_DAEMON_TLS_CERT_PATH?.trim() || null
  const tlsServerKeyPath = process.env.OBJECT_STORAGE_DAEMON_TLS_KEY_PATH?.trim() || null
  const allowedClientCns = (process.env.OBJECT_STORAGE_ALLOWED_CLIENT_CNS ?? 'object-storage-client,backup-daemon')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    bindHost: process.env.OBJECT_STORAGE_DAEMON_BIND_HOST ?? '0.0.0.0',
    port: Number(process.env.OBJECT_STORAGE_DAEMON_PORT ?? '4095'),
    rootDir: process.env.OBJECT_STORAGE_ROOT_DIR ?? '/srv/objects',
    tlsCaCertPath,
    tlsServerCertPath,
    tlsServerKeyPath,
    allowedClientCns,
    requireMtls: Boolean(tlsCaCertPath && tlsServerCertPath && tlsServerKeyPath),
    ...overrides,
  }
}





```

### 4.3 `deploy/object-storage-daemon/src/server.ts`

```
// deploy/object-storage-daemon/src/server.ts
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { StorageBucketTier } from '../../generated/prisma/client'
import { FsBlobStore } from '../../../core-back/lib/objectStorageSdk/blobStore'
import { loadDaemonConfigFromEnv, type ObjectStorageDaemonConfig } from './config'

const VALID_BUCKETS = new Set<StorageBucketTier>(['HOT', 'COLD', 'QUARANTINE'])

function parseBucket(raw: string): StorageBucketTier {
  const upper = raw.toUpperCase() as StorageBucketTier
  if (!VALID_BUCKETS.has(upper)) {
    throw new Error(`Invalid storage bucket tier: ${raw}`)
  }
  return upper
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  res.end(body)
}

export interface RunningObjectStorageDaemon {
  server: http.Server | https.Server
  port: number
  baseUrl: string
  store: FsBlobStore
  close: () => Promise<void>
}

export async function startObjectStorageDaemon(
  customConfig?: Partial<ObjectStorageDaemonConfig>
): Promise<RunningObjectStorageDaemon> {
  const config = loadDaemonConfigFromEnv(customConfig)
  const store = new FsBlobStore(config.rootDir)

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (config.requireMtls) {
        const tlsSocket = req.socket as TLSSocket
        if (!tlsSocket.authorized) {
          return sendJson(res, 401, { error: 'MTLS_CLIENT_UNAUTHORIZED' })
        }
        const peer = tlsSocket.getPeerCertificate()
        const cn = Array.isArray(peer?.subject?.CN) ? peer.subject.CN[0] : peer?.subject?.CN
        if (!cn || !config.allowedClientCns.includes(cn)) {
          return sendJson(res, 403, { error: `MTLS_CLIENT_CN_FORBIDDEN:${cn ?? 'none'}` })
        }
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const method = req.method ?? 'GET'

      // 1. GET /v1/health
      if (method === 'GET' && url.pathname === '/v1/health') {
        const health = await store.healthCheck()
        return sendJson(res, health.ok ? 200 : 503, health)
      }

      // 2. PUT / GET / HEAD /v1/blobs/:bucket/*relPath
      if (url.pathname.startsWith('/v1/blobs/')) {
        const rest = url.pathname.slice('/v1/blobs/'.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx <= 0) {
          return sendJson(res, 400, { error: 'MISSING_BUCKET_OR_PATH' })
        }
        const bucket = parseBucket(decodeURIComponent(rest.slice(0, slashIdx)))
        const relPath = rest.slice(slashIdx + 1)

        if (method === 'PUT') {
          const body = await readRequestBody(req)
          const expectedSha = req.headers['x-content-sha256']
          if (typeof expectedSha === 'string' && expectedSha.length === 64) {
            const actualSha = createHash('sha256').update(body).digest('hex')
            if (actualSha !== expectedSha) {
              return sendJson(res, 400, { error: 'SHA256_MISMATCH_ON_PUT', expectedSha, actualSha })
            }
          }
          const result = await store.put(bucket, relPath, body)
          return sendJson(res, 201, result)
        }

        if (method === 'HEAD') {
          const st = await store.stat(bucket, relPath)
          if (!st.exists) {
            res.writeHead(404)
            return res.end()
          }
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(st.byteSize),
            'x-blob-byte-size': String(st.byteSize),
          })
          return res.end()
        }

        if (method === 'GET') {
          try {
            const bytes = await store.readBytes(bucket, relPath)
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes.byteLength),
            })
            return res.end(bytes)
          } catch (err: any) {
            if (err?.code === 'ENOENT') {
              return sendJson(res, 404, { error: 'BLOB_NOT_FOUND' })
            }
            throw err
          }
        }
      }

      // 3. POST /v1/trash/:bucket/*relPath
      if (method === 'POST' && url.pathname.startsWith('/v1/trash/')) {
        const rest = url.pathname.slice('/v1/trash/'.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx <= 0) {
          return sendJson(res, 400, { error: 'MISSING_BUCKET_OR_PATH' })
        }
        const bucket = parseBucket(decodeURIComponent(rest.slice(0, slashIdx)))
        const relPath = rest.slice(slashIdx + 1)
        const rawBody = await readRequestBody(req)
        const parsed = rawBody.byteLength > 0 ? (JSON.parse(rawBody.toString('utf8')) as { trashDateIso?: string }) : {}
        await store.moveToTrash(bucket, relPath, parsed.trashDateIso)
        return sendJson(res, 200, { ok: true })
      }

      // 4. POST /v1/purge-trash
      if (method === 'POST' && url.pathname === '/v1/purge-trash') {
        const rawBody = await readRequestBody(req)
        const parsed = JSON.parse(rawBody.toString('utf8')) as { cutoffDateIso: string }
        const purgedCount = await store.purgeTrashOlderThan(parsed.cutoffDateIso)
        return sendJson(res, 200, { ok: true, purgedCount })
      }

      // 5. GET /v1/list/:bucket?prefix=...
      if (method === 'GET' && url.pathname.startsWith('/v1/list/')) {
        const bucketRaw = decodeURIComponent(url.pathname.slice('/v1/list/'.length))
        const bucket = parseBucket(bucketRaw)
        const prefix = url.searchParams.get('prefix') ?? ''
        const items = await store.list(bucket, prefix)
        return sendJson(res, 200, { items })
      }

      return sendJson(res, 404, { error: 'ROUTE_NOT_FOUND', path: url.pathname })
    } catch (err: any) {
      return sendJson(res, 500, { error: err?.message ?? String(err) })
    }
  }

  const server = config.requireMtls
    ? https.createServer(
        {
          ca: fs.readFileSync(config.tlsCaCertPath!),
          cert: fs.readFileSync(config.tlsServerCertPath!),
          key: fs.readFileSync(config.tlsServerKeyPath!),
          requestCert: true,
          rejectUnauthorized: true,
        },
        handler
      )
    : http.createServer(handler)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.bindHost, () => resolve())
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : config.port
  const protocol = config.requireMtls ? 'https' : 'http'
  const hostForUrl = config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost

  return {
    server,
    port: actualPort,
    baseUrl: `${protocol}://${hostForUrl}:${actualPort}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}





```

### 4.4 `deploy/object-storage-daemon/src/index.ts`

```
// deploy/object-storage-daemon/src/index.ts
import { startObjectStorageDaemon } from './server'

const daemon = await startObjectStorageDaemon()
console.log(`[object-storage-daemon] listening on ${daemon.baseUrl} (rootDir=${daemon.store.rootDir})`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[object-storage-daemon] received ${sig}, shutting down...`)
    await daemon.close()
    process.exit(0)
  })
}





```

## 5. Complete Multi-Node Deploy Engine Integration (`deploy/`)

This section matches the exact types (`DeployConfig`, `HostRole`, `StorageRole`, `CertBundle`, `StoragePlan`, `HostPlan`), helper functions (`parseNodeList`, `objectStorageConfigured`, `validateDeployConfig`, `objectStorageCoreEnv`, `buildPki`, `certFilesForHost`, `uploadStorageCertificates`, `deployObjectStorageDaemon`), and conventions used by `PG_PRIMARY_NODE` and `BACKUP_NODE` in `deploy/`.

### 5.1 `deploy/deploy.env.example` — Add Section `5f`

Add Section `5f` right after Section `5e. BACKUP & PITR VERIFICATION ENGINE` in `deploy/deploy.env.example`:

```
# --- 5f. SHARED OBJECT & ASSET STORAGE ENGINE (v34+) --------------------------
# Dedicated or co-located mTLS shared object vault (`pg-object-storage-daemon`).
# Same node format as PG_PRIMARY_NODE and BACKUP_NODE:
#   OBJECT_STORAGE_NODE="obj-1@10.10.14.10:22:10.10.14.10:4095"
#
# Automatic Detection:
# Whenever OBJECT_STORAGE_ENABLED="true", OBJECT_STORAGE_MANAGE_VIA_SSH="true",
# or OBJECT_STORAGE_NODE is non-empty, `objectStorageConfigured(config)` is true
# and the deploy engine automatically:
#   1. Validates SSH credentials, KEK keyring entropy/versions, node IDs & ports.
#   2. Mints `object-storage-daemon` (server) and `object-storage-client` (client)
#      mTLS certificates signed by `internal-ca.crt`.
#   3. Creates the unprivileged `pgobjstore` service user and vault directories
#      (`${OBJECT_STORAGE_ROOT_DIR}/{hot,cold,quarantine,tmp,.trash}`), installs
#      Bun, syncs `deploy/object-storage-daemon` to `/opt/pg-object-storage-daemon`,
#      writes `/etc/pg-object-storage/object-storage.env` and systemd unit
#      `pg-object-storage-daemon.service`, and locks UFW port 4095 to core-back
#      and backup-daemon private IPs only.
#   4. Injects `OBJECT_STORAGE_DAEMON_URL`, client mTLS cert paths, and the KEK
#      keyring into every `core-back` node and `backup-daemon` node.
#
# HARD SHARED-STORAGE GUARD:
# Whenever more than one core node is configured (`CORE_NODES` has >= 2 nodes) OR
# `BACKUP_ENABLED="true"` runs on a separate host from core, `OBJECT_STORAGE_NODE`
# is REQUIRED — `validateDeployConfig()` rejects the configuration with
# `MULTI_NODE_SHARED_STORAGE_REQUIRED` rather than ever storing blobs on core nodes.
OBJECT_STORAGE_ENABLED="false"
OBJECT_STORAGE_MANAGE_VIA_SSH="false"
OBJECT_STORAGE_NODE=""
OBJECT_STORAGE_SSH_USER="ubuntu"
OBJECT_STORAGE_SSH_PORT="22"
OBJECT_STORAGE_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_obj_storage"
OBJECT_STORAGE_SUDO_PASSWORD="change-me-obj-storage-sudo"
OBJECT_STORAGE_ROOT_DIR="/var/lib/pg-object-storage/vault"
OBJECT_STORAGE_DAEMON_PORT="4095"
OBJECT_STORAGE_DAEMON_BIND_HOST=""
OBJECT_STORAGE_DAEMON_CERT_DIR="/var/lib/pg-object-storage/shared/certs"
OBJECT_STORAGE_ALLOWED_CLIENT_CNS="object-storage-client,backup-client"
OBJECT_STORAGE_DAEMON_TIMEOUT_MS="30000"
OBJECT_STORAGE_ALLOW_INSECURE_HTTP="false"
# Format: "v1:<64-hex-chars>[,v2:<64-hex-chars>]". Generate with: openssl rand -hex 32
OBJECT_STORAGE_KEK_KEYRING="v1:change-me-64-hex-char-aes-256-kek-generate-with-openssl-rand-hex-32"
OBJECT_STORAGE_ACTIVE_KEK_VERSION="1"
OBJECT_STORAGE_TRASH_RETENTION_DAYS="7"
OBJECT_STORAGE_GC_GRACE_HOURS="24"



```

### 5.2 Update `deploy/lib/configSchema.ts`

Make the following exact additions in `deploy/lib/configSchema.ts`:

1. **Extend `StorageRole` union:**

```
export type StorageRole =
  | "pg-primary"
  | "pg-replica"
  | "pgbouncer"
  | "redis"
  | "audit-db"
  | "log-db"
  | "backup"
  | "object-storage";



```

2. **Add Section `13b. Shared Object & Asset Storage Engine` to the Zod `base` schema (right after `BARMAN_AUDIT_SERVER`):**

```
  // 13b. Shared Object & Asset Storage Engine (v34+)
  OBJECT_STORAGE_ENABLED: booleanish.default(false),
  OBJECT_STORAGE_MANAGE_VIA_SSH: booleanish.default(false),
  OBJECT_STORAGE_NODE: z.string().trim().max(500).default(""),
  OBJECT_STORAGE_SSH_USER: unixUser.default("ubuntu"),
  OBJECT_STORAGE_SSH_PORT: port.default(22),
  OBJECT_STORAGE_SSH_KEY_PATH: sshPath.optional(),
  OBJECT_STORAGE_SUDO_PASSWORD: z.string().max(256).default(""),
  OBJECT_STORAGE_ROOT_DIR: safeDir(300).default("/var/lib/pg-object-storage/vault"),
  OBJECT_STORAGE_DAEMON_PORT: port.default(4095),
  OBJECT_STORAGE_DAEMON_BIND_HOST: hostLike.default(""),
  OBJECT_STORAGE_DAEMON_CERT_DIR: safeDir(300).default("/var/lib/pg-object-storage/shared/certs"),
  OBJECT_STORAGE_ALLOWED_CLIENT_CNS: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/, "must be a comma separated list of certificate names")
    .default("object-storage-client,backup-client"),
  OBJECT_STORAGE_DAEMON_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  OBJECT_STORAGE_ALLOW_INSECURE_HTTP: booleanish.default(false),
  OBJECT_STORAGE_KEK_KEYRING: z
    .string()
    .trim()
    .regex(/^v\d+:[0-9a-fA-F]{64}(,v\d+:[0-9a-fA-F]{64})*$/, "must be v<N>:<64-hex>[,v<M>:<64-hex>]")
    .or(z.literal(""))
    .default(""),
  OBJECT_STORAGE_ACTIVE_KEK_VERSION: z.coerce.number().int().positive().default(1),
  OBJECT_STORAGE_TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  OBJECT_STORAGE_GC_GRACE_HOURS: z.coerce.number().int().min(1).max(720).default(24),



```

3. **Export the auto-detection helper `objectStorageConfigured` (right next to `backupStorageConfigured`):**

```
/**
 * True when the Shared Object & Asset Storage Engine tier is configured.
 * Automatically detected whenever OBJECT_STORAGE_ENABLED, OBJECT_STORAGE_MANAGE_VIA_SSH,
 * or OBJECT_STORAGE_NODE is set in deploy.env.
 */
export const objectStorageConfigured = (config: DeployConfig): boolean =>
  config.OBJECT_STORAGE_ENABLED
  || config.OBJECT_STORAGE_MANAGE_VIA_SSH
  || config.OBJECT_STORAGE_NODE.trim().length > 0;



```

4. **Check `OBJECT_STORAGE_KEK_KEYRING` in `weakSecretProblems(config: DeployConfig)`:**

```
  if (config.OBJECT_STORAGE_KEK_KEYRING) {
    for (const part of config.OBJECT_STORAGE_KEK_KEYRING.split(",")) {
      const hex = part.split(":")[1] ?? "";
      const reason = weakSecretReason(hex);
      if (reason) problems.push(`OBJECT_STORAGE_KEK_KEYRING ${reason}`);
    }
  }



```

5. **Enforce strict validation in `validateDeployConfig(config: DeployConfig)`:**

   * Add `["OBJECT_STORAGE_NODE", config.OBJECT_STORAGE_NODE]` to the `storageNodes` loop (around line 965).

   * Add `"object-storage"` family to `storagePortClaims` so port collisions are caught automatically.

   * Add the following validation block right after the `if (config.BACKUP_ENABLED) { ... }` block:

```
  const objConfigured = objectStorageConfigured(config);
  const objNodes = storageNodes.find((entry) => entry.label === "OBJECT_STORAGE_NODE")?.nodes ?? [];
  const coreNodesList = parsedTiers.get("CORE_NODES") ?? [];
  const backupNodesList = storageNodes.find((entry) => entry.label === "BACKUP_NODE")?.nodes ?? [];
  const singleCoreIp = coreNodesList[0]?.privateIp ?? config.CORE_PRIVATE_IP;
  const backupOnSeparateHost =
    config.BACKUP_ENABLED
    && backupNodesList.length > 0
    && Boolean(singleCoreIp)
    && backupNodesList[0]!.privateIp !== singleCoreIp;

  // HARD SHARED-STORAGE ENFORCEMENT:
  // If more than 1 core node is configured OR backup-daemon runs on a separate host,
  // storing objects on a core node's local disk is strictly forbidden!
  if ((coreNodesList.length > 1 || backupOnSeparateHost) && (!objConfigured || objNodes.length === 0)) {
    problems.push(
      "MULTI_NODE_SHARED_STORAGE_REQUIRED: OBJECT_STORAGE_NODE is required when deploying multiple CORE_NODES or a separate BACKUP_NODE. Storing objects on individual core nodes is strictly forbidden — set OBJECT_STORAGE_NODE (e.g. obj-1@10.10.14.10:22:10.10.14.10:4095) so all services point to and read/write from the shared storage server.",
    );
  }

  if (objConfigured) {
    if (objNodes.length === 0) {
      problems.push("OBJECT_STORAGE_NODE is required when object storage is enabled");
    }
    if (objNodes.length > 1) {
      problems.push("OBJECT_STORAGE_NODE must describe exactly one node");
    }
    if (!config.OBJECT_STORAGE_SSH_KEY_PATH) {
      problems.push("OBJECT_STORAGE_SSH_KEY_PATH is required when object storage is enabled");
    }
    if (!config.OBJECT_STORAGE_KEK_KEYRING) {
      problems.push("OBJECT_STORAGE_KEK_KEYRING is required when object storage is enabled");
    }
  }

  if (config.OBJECT_STORAGE_KEK_KEYRING) {
    const activePrefix = `v${config.OBJECT_STORAGE_ACTIVE_KEK_VERSION}:`;
    const hasActive = config.OBJECT_STORAGE_KEK_KEYRING
      .split(",")
      .some((entry) => entry.trim().startsWith(activePrefix));
    if (!hasActive) {
      problems.push(
        `OBJECT_STORAGE_ACTIVE_KEK_VERSION=${config.OBJECT_STORAGE_ACTIVE_KEK_VERSION} is not present in OBJECT_STORAGE_KEK_KEYRING`,
      );
    }
  }



```

### 5.3 Update `deploy/lib/pkiManager.ts`

In `deploy/lib/pkiManager.ts`:

1. Import `objectStorageConfigured` from `./configSchema`.

2. Add `objectStorage: CertMaterial;` to `PkiBundle` (right after `backup: CertMaterial;`).

3. Inside `buildPki(options: PkiOptions)`:

   * Define `objectStorage` server certificate material (exact twin of `backup`):

```
  const objectStorageIp = parseNodeList(config.OBJECT_STORAGE_NODE)[0]?.privateIp;
  const objectStorage: CertMaterial = {
    name: "object-storage-daemon",
    certPath: join(directory, "object-storage-daemon.crt"),
    keyPath: join(directory, "object-storage-daemon.key"),
    kind: "server",
    cn: "object-storage-daemon.internal",
    sans: [
      ...(objectStorageIp ? [`IP:${objectStorageIp}`] : []),
      "IP:127.0.0.1",
      "DNS:object-storage-daemon.internal",
    ],
  };



```

* Add `object-storage-client` to `storageClients` when `objectStorageConfigured(config)` is true:

```
  if (objectStorageConfigured(config) && !storageClients.some((client) => client.name === "object-storage-client")) {
    storageClients.push({
      name: "object-storage-client",
      certPath: join(directory, "object-storage-client.crt"),
      keyPath: join(directory, "object-storage-client.key"),
      kind: "client",
      cn: "object-storage-client",
    });
  }



```

* Include `objectStorage` in `bundle`, `everythingExists`, `renewNames`, `sanDrift`, `verifyPki`, and `checkPkiExpiry`, and sign it right after `backup`:

```
  // ---- 2c. The object-storage-daemon mTLS server certificate -------------
  if (signServer(objectStorage)) signLeaf({
    run,
    directory,
    material: objectStorage,
    ou: "object-storage",
    sans: objectStorage.sans ?? [],
    extendedKeyUsage: "serverAuth,clientAuth",
    validityDays: config.MTLS_VALIDITY_DAYS,
  });



```

* In `certFilesForHost(bundle, roles)`:

```
    if (role === "backup") {
      files.push(
        bundle.backup,
        ...bundle.storageClients.filter(
          (client) =>
            client.name === "pg-client"
            || client.name === "backup-client"
            || client.name === "object-storage-client",
        ),
      );
    }
    if (role === "object-storage") {
      files.push(
        bundle.objectStorage,
        ...bundle.storageClients.filter((client) => client.name === "object-storage-client"),
      );
    }



```

### 5.4 Update `deploy/lib/hostPlanner.ts`

In `deploy/lib/hostPlanner.ts`:

1. Import `objectStorageConfigured` from `./configSchema`.

2. Add `"object-storage-server" | "object-storage-client"` to `CertBundle`.

3. Add `objectStorage: StorageNodePlan | null;` to `StoragePlan`.

4. Add `objectStoragePrivateIp` and `objectStorageCoreEnv` right after `backupCoreEnv`:

```
const objectStorageSpec = (config: DeployConfig): NodeSpec | null =>
  parseNodeList(config.OBJECT_STORAGE_NODE)[0] ?? null;

const objectStoragePrivateIp = (config: DeployConfig): string | null =>
  objectStorageSpec(config)?.privateIp ?? null;

const objectStoragePort = (config: DeployConfig): number =>
  objectStorageSpec(config)?.servicePort ?? config.OBJECT_STORAGE_DAEMON_PORT;

/**
 * core-back's object-storage-daemon client settings and cryptographic keyring.
 * Note: relative `shared/certs/...` paths are rewritten to `${remote}/shared/certs/...`
 * by `absoluteEnv()` in `deploy.ts`, matching `backupCoreEnv()`.
 */
export const objectStorageCoreEnv = (config: DeployConfig): Record<string, string> => {
  const coreNodeCount = Math.max(1, parseNodeList(config.CORE_NODES).length);
  const base: Record<string, string> = {
    CLUSTER_CORE_NODE_COUNT: String(coreNodeCount),
    OBJECT_STORAGE_ROOT_DIR: config.OBJECT_STORAGE_ROOT_DIR,
    ...(config.OBJECT_STORAGE_KEK_KEYRING
      ? { OBJECT_STORAGE_KEK_KEYRING: config.OBJECT_STORAGE_KEK_KEYRING }
      : {}),
    OBJECT_STORAGE_ACTIVE_KEK_VERSION: String(config.OBJECT_STORAGE_ACTIVE_KEK_VERSION),
    OBJECT_STORAGE_TRASH_RETENTION_DAYS: String(config.OBJECT_STORAGE_TRASH_RETENTION_DAYS),
    OBJECT_STORAGE_GC_GRACE_HOURS: String(config.OBJECT_STORAGE_GC_GRACE_HOURS),
  };
  if (!objectStorageConfigured(config)) return base;
  const scheme = config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP ? "http" : "https";
  return {
    ...base,
    OBJECT_STORAGE_DAEMON_URL: `${scheme}://${objectStoragePrivateIp(config) ?? "127.0.0.1"}:${objectStoragePort(config)}`,
    OBJECT_STORAGE_TLS_CA_PATH: "shared/certs/internal-ca.crt",
    OBJECT_STORAGE_TLS_CLIENT_CERT_PATH: "shared/certs/object-storage-client.crt",
    OBJECT_STORAGE_TLS_CLIENT_KEY_PATH: "shared/certs/object-storage-client.key",
    OBJECT_STORAGE_DAEMON_TIMEOUT_MS: String(config.OBJECT_STORAGE_DAEMON_TIMEOUT_MS),
  };
};



```

5. Merge `...objectStorageCoreEnv(config)` into `coreEnv(config, node)`.

6. In `buildCertBundles(role: HostRole, config?: DeployConfig)`:

   * Add `if (config && objectStorageConfigured(config)) storageCerts.push("object-storage-client");`

   * Add `case "object-storage": return ["object-storage-server", "object-storage-client"];`

   * Update `case "backup":` to include `"object-storage-client"` when `config && objectStorageConfigured(config)`.

7. In `buildStoragePlan(config: DeployConfig)`:

```
  const objSpec = parseSingleNode(config.OBJECT_STORAGE_NODE, "OBJECT_STORAGE_NODE");
  const objectStorage = objSpec
    ? storageNode({
        config,
        role: "object-storage",
        spec: objSpec,
        user: config.OBJECT_STORAGE_SSH_USER,
        keyPath: config.OBJECT_STORAGE_SSH_KEY_PATH,
        sudoPassword: config.OBJECT_STORAGE_SUDO_PASSWORD,
      })
    : null;



```

Include `objectStorage` in `nodes` and return `objectStorage` on `StoragePlan`.
8. In `buildStorageFirewall`:

```
    case "object-storage":
      return [
        sshRule,
        {
          port: node.servicePort || config.OBJECT_STORAGE_DAEMON_PORT,
          proto: "tcp",
          fromCidrs: [...new Set([...coreIps, ...(backupIp ? [backupIp] : [])])],
          comment: "object-storage-daemon mTLS from core + backup nodes",
        },
      ];



```

9. In `storageTargets(config: DeployConfig, storage: StoragePlan)`:
   Add `[storage.objectStorage, objectStorageConfigured(config)]` to `managed`.

### 5.5 Create `deploy/provisioners/objectStorageProvisioner.ts`

Create `deploy/provisioners/objectStorageProvisioner.ts` following the exact structure of `deploy/provisioners/backupEngineProvisioner.ts`:

```
// deploy/provisioners/objectStorageProvisioner.ts
import { objectStorageConfigured, parseNodeList, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { envAssign, shellQuote } from "../lib/quoting";
import { isChanged, parseApplyOutcome, type ProvisionRunner } from "../lib/converge";
import type { ProvisionReport } from "./postgres18Provisioner";

export const OBJECT_STORAGE_SERVICE_USER = "pgobjstore";
export const OBJECT_STORAGE_ENV_PATH = "/etc/pg-object-storage/object-storage.env";
export const OBJECT_STORAGE_UNIT_PATH = "/etc/systemd/system/pg-object-storage-daemon.service";

const objectStorageSpec = (config: DeployConfig) =>
  parseNodeList(config.OBJECT_STORAGE_NODE)[0] ?? null;

const objectStorageSsh = (config: DeployConfig): SshTarget | null => {
  const spec = objectStorageSpec(config);
  if (!spec) return null;
  return {
    host: spec.sshHost,
    port: spec.sshPort,
    user: config.OBJECT_STORAGE_SSH_USER,
    keyPath: config.OBJECT_STORAGE_SSH_KEY_PATH ?? "",
    sudoPassword: config.OBJECT_STORAGE_SUDO_PASSWORD,
  };
};

export const objectStorageBindHost = (config: DeployConfig): string =>
  config.OBJECT_STORAGE_DAEMON_BIND_HOST.trim()
  || objectStorageSpec(config)?.privateIp
  || "127.0.0.1";

export const objectStoragePort = (config: DeployConfig): number =>
  objectStorageSpec(config)?.servicePort ?? config.OBJECT_STORAGE_DAEMON_PORT;

export const objectStorageDaemonEnv = (config: DeployConfig): Record<string, string> => ({
  NODE_ENV: "production",
  OBJECT_STORAGE_DAEMON_BIND_HOST: objectStorageBindHost(config),
  OBJECT_STORAGE_DAEMON_PORT: String(objectStoragePort(config)),
  OBJECT_STORAGE_ROOT_DIR: config.OBJECT_STORAGE_ROOT_DIR,
  OBJECT_STORAGE_DAEMON_TLS_CA_PATH: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP
    ? ""
    : `${config.OBJECT_STORAGE_DAEMON_CERT_DIR}/internal-ca.crt`,
  OBJECT_STORAGE_DAEMON_TLS_CERT_PATH: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP
    ? ""
    : `${config.OBJECT_STORAGE_DAEMON_CERT_DIR}/object-storage-daemon.crt`,
  OBJECT_STORAGE_DAEMON_TLS_KEY_PATH: config.OBJECT_STORAGE_ALLOW_INSECURE_HTTP
    ? ""
    : `${config.OBJECT_STORAGE_DAEMON_CERT_DIR}/object-storage-daemon.key`,
  OBJECT_STORAGE_ALLOWED_CLIENT_CNS: config.OBJECT_STORAGE_ALLOWED_CLIENT_CNS,
});

export const renderObjectStorageEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env)
    .map(([k, v]) => envAssign(k, v))
    .join("\n")}\n`;

export const objectStorageDaemonSystemdUnit = (config: DeployConfig): string => `[Unit]
Description=Payment Gateway Shared Object Storage mTLS Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OBJECT_STORAGE_SERVICE_USER}
Group=${OBJECT_STORAGE_SERVICE_USER}
WorkingDirectory=/opt/pg-object-storage-daemon
EnvironmentFile=${OBJECT_STORAGE_ENV_PATH}
Environment=HOME=/var/lib/pg-object-storage
Environment=BUN_INSTALL_CACHE_DIR=/var/lib/pg-object-storage/.bun-cache
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/pg-object-storage ${config.OBJECT_STORAGE_ROOT_DIR} ${config.OBJECT_STORAGE_DAEMON_CERT_DIR}

[Install]
WantedBy=multi-user.target
`;

export interface ObjectStorageProvisionReport extends ProvisionReport {
  daemonConfigChanged: boolean;
}

export const provisionObjectStorageEngine = (input: {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
  forceRestart?: boolean;
}): ObjectStorageProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const outcomes: Record<string, string> = {};

  if (!objectStorageConfigured(config)) {
    const coreCount = parseNodeList(config.CORE_NODES).length;
    if (coreCount > 1) {
      throw new Error(
        "MULTI_NODE_SHARED_STORAGE_REQUIRED: Refusing to provision without OBJECT_STORAGE_NODE when multiple CORE_NODES are configured.",
      );
    }
    return { nodes: [], commands, outcomes, daemonConfigChanged: false };
  }

  const spec = objectStorageSpec(config);
  const ssh = objectStorageSsh(config);
  if (!spec || !ssh) {
    throw new Error("OBJECT_STORAGE_NODE is required when object storage is enabled");
  }

  const rootDir = config.OBJECT_STORAGE_ROOT_DIR;
  const certDir = config.OBJECT_STORAGE_DAEMON_CERT_DIR;
  const userSetupCmd = [
    `getent group ${OBJECT_STORAGE_SERVICE_USER} >/dev/null 2>&1 || groupadd --system ${OBJECT_STORAGE_SERVICE_USER}`,
    `id -u ${OBJECT_STORAGE_SERVICE_USER} >/dev/null 2>&1 || useradd --system --gid ${OBJECT_STORAGE_SERVICE_USER} --home /var/lib/pg-object-storage --shell /usr/sbin/nologin ${OBJECT_STORAGE_SERVICE_USER}`,
    `install -d -m 0750 -o ${OBJECT_STORAGE_SERVICE_USER} -g ${OBJECT_STORAGE_SERVICE_USER} /var/lib/pg-object-storage ${shellQuote(rootDir)} ${shellQuote(`${rootDir}/hot`)} ${shellQuote(`${rootDir}/cold`)} ${shellQuote(`${rootDir}/quarantine`)} ${shellQuote(`${rootDir}/tmp`)} ${shellQuote(`${rootDir}/.trash`)} ${shellQuote(certDir)}`,
    `install -d -m 0750 -o root -g ${OBJECT_STORAGE_SERVICE_USER} /etc/pg-object-storage`,
  ].join(" && ");

  runner.run(ssh, userSetupCmd, { sudo: true });
  commands.push(userSetupCmd);

  const envWritten = runner.writeRemoteFile({
    target: ssh,
    path: OBJECT_STORAGE_ENV_PATH,
    content: renderObjectStorageEnvFile(objectStorageDaemonEnv(config)),
    mode: 0o640,
    sudo: true,
  });
  runner.run(ssh, `chown root:${OBJECT_STORAGE_SERVICE_USER} ${shellQuote(OBJECT_STORAGE_ENV_PATH)}`, { sudo: true });

  const unitWritten = runner.writeRemoteFile({
    target: ssh,
    path: OBJECT_STORAGE_UNIT_PATH,
    content: objectStorageDaemonSystemdUnit(config),
    mode: 0o644,
    sudo: true,
  });

  const daemonConfigChanged = isChanged(envWritten) || isChanged(unitWritten);
  outcomes["pg-object-storage-daemon-config"] = daemonConfigChanged ? "updated" : "unchanged";

  return {
    nodes: [`${spec.nodeId}@${spec.privateIp}:${spec.servicePort}`],
    commands,
    outcomes,
    daemonConfigChanged,
  };
};



```

### 5.6 Update `deploy/deploy.ts` and `deploy/lib/healthVerifier.ts`

In `deploy/deploy.ts`:

1. Import `objectStorageConfigured` from `./lib/configSchema` and `OBJECT_STORAGE_SERVICE_USER, provisionObjectStorageEngine` from `./provisioners/objectStorageProvisioner`.

2. Add `"object-storage"` to `StorageOnlyRole`, `ONLY_ROLES`, and `isStorageRole`:

```
const isStorageRole = (role: string): boolean =>
  ["pg-primary", "pg-replica", "pgbouncer", "redis", "audit-db", "log-db", "backup", "object-storage"].includes(role);



```

3. In `uploadStorageCertificates()`:

   * When `host.roles.includes("object-storage")`, upload `internal-ca.crt`, `object-storage-daemon.crt`, `object-storage-daemon.key`, `object-storage-client.crt`, and `object-storage-client.key` into `config.OBJECT_STORAGE_DAEMON_CERT_DIR` and `chown ${OBJECT_STORAGE_SERVICE_USER}:${OBJECT_STORAGE_SERVICE_USER}`.

4. Add `deployObjectStorageDaemon()` (exact twin of `deployBackupDaemon()` at line 589 of `deploy/deploy.ts`):

```
export const deployObjectStorageDaemon = (input: {
  runner: SshRunner;
  config: DeployConfig;
  host: HostPlan;
  configChanged?: boolean;
  forceRestart?: boolean;
}): void => {
  const { runner, config, host } = input;
  const installDir = "/opt/pg-object-storage-daemon";
  const sourceDir = join(REPO_ROOT, "deploy", "object-storage-daemon");
  const targetUser = effectiveTargetUser(host.ssh);
  const daemonUser = OBJECT_STORAGE_SERVICE_USER;
  const daemonOwner = `${daemonUser}:${daemonUser}`;
  const bunCacheDir = "/var/lib/pg-object-storage/.bun-cache";
  const chownSource = (owner: string): string =>
    `find ${shellQuote(installDir)} -path ${shellQuote(`${installDir}/node_modules`)} -prune -o -exec chown ${shellQuote(owner)} {} +`;
  runner.run(
    host.ssh,
    `install -d -m 0755 -o ${shellQuote(targetUser)} -g ${shellQuote(targetUser)} ${shellQuote(installDir)} && ${chownSource(`${targetUser}:${targetUser}`)}`,
    { sudo: true },
  );
  const synced = runner.sync({
    target: host.ssh,
    local: sourceDir,
    remote: installDir,
    delete: true,
    excludes: ["node_modules", ".git", "dist", "test", "*.log", ".env"],
  });
  runner.run(host.ssh, bunInstallCommand(config), { sudo: true });
  runner.run(
    host.ssh,
    `${chownSource(daemonOwner)}; install -d -m 0755 -o ${shellQuote(daemonUser)} -g ${shellQuote(daemonUser)} ${shellQuote(bunCacheDir)}; if [ ${synced.changed ? 1 : 0} = 1 ] || [ ! -d ${shellQuote(`${installDir}/node_modules`)} ]; then install -d -o ${shellQuote(daemonUser)} -g ${shellQuote(daemonUser)} ${shellQuote(`${installDir}/node_modules`)} && cd ${shellQuote(installDir)} && runuser -u ${shellQuote(daemonUser)} -- env HOME=/var/lib/pg-object-storage BUN_INSTALL_CACHE_DIR=${shellQuote(bunCacheDir)} /usr/local/bin/bun install --frozen-lockfile; fi`,
    { sudo: true },
  );
  const restart = input.forceRestart === true || synced.changed || input.configChanged !== false;
  const outcome = parseApplyOutcome(
    runner.capture(
      host.ssh,
      `systemctl daemon-reload && systemctl enable pg-object-storage-daemon >/dev/null 2>&1
if ! systemctl is-active --quiet pg-object-storage-daemon; then systemctl start pg-object-storage-daemon; echo __PG_APPLY__=started
elif [ ${restart ? 1 : 0} = 1 ]; then systemctl restart pg-object-storage-daemon; echo __PG_APPLY__=restarted
else echo __PG_APPLY__=unchanged; fi
${daemonReadinessWait("pg-object-storage-daemon")}`,
      { sudo: true },
    ),
  );
  log(
    `  object-storage daemon ${outcome === "unknown" ? "applied" : outcome} -> ${host.ssh.host}:${installDir}`,
  );
};



```

5. In `main()` Step 5 (`Provision storage engines`), right before `if (config.BACKUP_ENABLED ...)`:

```
  if (objectStorageConfigured(config) && shouldRunStorage(options, ["object-storage"])) {
    const report = provisionObjectStorageEngine({
      runner,
      config,
      dryRun: options.dryRun,
      forceRestart: options.forceRestart,
    });
    log(`  Object storage engine on: ${report.nodes.join(", ") || "none"}`);
    logOutcomes(report.outcomes);
    const objHost = plan.hosts.find((host) => host.roles.includes("object-storage"));
    if (objHost) {
      deployObjectStorageDaemon({
        runner,
        config,
        host: objHost,
        configChanged: report.daemonConfigChanged,
        forceRestart: options.forceRestart,
      });
    }
  }



```

6. In `deploy/lib/healthVerifier.ts`:
   When `plan.storage.objectStorage` is present, probe `systemctl is-active pg-object-storage-daemon` and `curl --fail --silent --cacert <ca> --cert <object-storage-client.crt> --key <object-storage-client.key> https://<privateIp>:<port>/v1/health` from each `core` host and `backup` host to verify end-to-end mTLS reachability.

### 5.7 Update `deploy/test-matrix/topologies.ts` and `deploy/test/testMatrix.test.ts`

In `deploy/test-matrix/topologies.ts`:

* Add `OBJECT_STORAGE_ENABLED: "true"`, `OBJECT_STORAGE_MANAGE_VIA_SSH: "true"`, `OBJECT_STORAGE_NODE: "obj-1@10.10.14.10:22:10.10.14.10:4095"`, `OBJECT_STORAGE_SSH_KEY_PATH: "~/.ssh/id_ed25519_pg_obj_storage"`, and a valid random 64-hex `OBJECT_STORAGE_KEK_KEYRING` to all multi-node topologies in `deploy/test-matrix/topologies.ts`.

## 6. Backup Engine & Restore Drill Integration (`deploy/backup-daemon/` & `core-back/lib/storageEngine/`)

### 6.1 How Object Storage Backups Work Across Single-Node and Multi-Node Clusters

`deploy/backup-daemon` (`BACKUP_NODE`) already backs up PostgreSQL (`pg-primary`), Audit DB, and Log DB into the 3-2-1 `ArtifactRepository` (`deploy/backup-daemon/src/artifactStore.ts`). We extend it to back up and verify all shared object storage blobs:

1. **Connecting `backup-daemon` to Shared Storage:**

   * `backup-daemon` uses `createBlobStoreFromEnv()` from `core-back/lib/objectStorageSdk/blobStore.ts`.

   * In a multi-node cluster (`OBJECT_STORAGE_NODE` configured), `backup-daemon` automatically uses `RemoteMtlsBlobStore` (`OBJECT_STORAGE_DAEMON_URL=https://10.10.14.10:4095`) to list and stream encrypted `.v1.enc` blobs over mTLS from `obj-1`.

   * In a single-host cluster, `backup-daemon` reads `/srv/objects` via `FsBlobStore`.

2. **Incremental Content-Addressed Sync (`syncObjectStorageBlobs` in `deploy/backup-daemon/src/backupEngine.ts`):**

   * Because every `.v1.enc` file is immutable once written, `backupEngine.ts` lists `HOT` and `COLD` buckets via `blobStore.list(bucket)` and copies only newly created `.v1.enc` blobs that do not yet exist in the backup repository's `object-blobs/{bucket}/{relPath}` tree.

   * It then compares the `ACTIVE` manifest (`exportManifest()`) against the backed-up blobs: if any `ACTIVE` `StorageObject` row in the database snapshot is missing its `.v1.enc` blob in the backup target, the backup run fails with `OBJECT_STORAGE_BACKUP_PARITY_ERROR`.

3. **KEK Keyring Escrow & Weekly Decryption Drill (`deploy/backup-daemon/src/restoreDrillRunner.ts`):**

   * `OBJECT_STORAGE_KEK_KEYRING` is encrypted under `BACKUP_ENCRYPTION_KEY_HEX` and stored alongside the backup manifest (`kek-escrow.enc`).

   * During `restoreDrillRunner.ts`, after restoring the PostgreSQL backup into the temporary verification container, the drill selects up to 10 random `ACTIVE` rows from `storage_objects`, loads their `.v1.enc` files from the backup repository, unwraps their DEK using the escrowed keyring, runs `decryptPgos1ToBuffer(...)`, and asserts `computedSha256 === row.sha256_hex`.

4. **Health Monitoring (`core-back/engine/workers/backupMonitorChecks.ts`):**

   * Add check `OBJECT_STORAGE_PARITY_AND_SCRUB_HEALTH` which verifies:

     * `blobStore.healthCheck().ok === true`

     * `scrubErrorCount === 0` across all `ACTIVE` `StorageObject` rows

     * Zero `QUARANTINE_PENDING_AV` objects stuck for more than `30` minutes.

## 7. Complete Domain Call-Site Migrations Across `core-back`

Every existing feature that stores or reads files/assets must be migrated to `ObjectStorageSdk`. **Zero `Bytes` columns remain in PostgreSQL domain tables.**

### 7.1 Background Workers Registration (`core-back/engine/workers/ObjectStorageWorkers.ts`)

Create `core-back/engine/workers/ObjectStorageWorkers.ts` and register it in `core-back/engine/workers/productionRuntime.ts`:

```
// core-back/engine/workers/ObjectStorageWorkers.ts
import type { ObjectStorageSdk } from '../../lib/objectStorageSdk'

export function createObjectStorageWorkers(sdk: ObjectStorageSdk) {
  return {
    /**
     * Scans QUARANTINE_PENDING_AV objects. Detects EICAR signature or clamav daemon verdict,
     * then calls applyScanVerdict('CLEAN' | 'INFECTED').
     */
    async runAvScanBatch(prismaClient: any): Promise<{ scanned: number; clean: number; infected: number }> {
      const pending = await prismaClient.storageObject.findMany({
        where: { status: 'QUARANTINE_PENDING_AV', avScanStatus: 'PENDING' },
        take: 25,
      })
      let clean = 0
      let infected = 0
      for (const obj of pending) {
        const { bytes } = await sdk.workerClient.readForScan(obj.id)
        const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096)).toString('utf8')
        const isEicar = sample.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
        if (isEicar) {
          await sdk.workerClient.applyScanVerdict({
            objectId: obj.id,
            verdict: 'INFECTED',
            signature: 'EICAR-Test-Signature',
          })
          infected++
        } else {
          await sdk.workerClient.applyScanVerdict({
            objectId: obj.id,
            verdict: 'CLEAN',
          })
          clean++
        }
      }
      return { scanned: pending.length, clean, infected }
    },

    runGcBatch: () => sdk.workerClient.runGcBatch(),
    runBlobSweep: () => sdk.workerClient.runBlobSweep(),
    runIntegrityScrubBatch: () => sdk.workerClient.runIntegrityScrubBatch(),
    runLockReconcile: () => sdk.workerClient.runLockReconcile(),
    runRewrapBatch: () => sdk.workerClient.runRewrapBatch(),
  }
}





```

### 7.2 KYB Documents (`KybDocument`)

Update the following 5 files:

1. **`core-back/api/internal/merchant.ts` & `core-back/api/internal/admin.ts` (KYB Upload & Download):**

   * On upload:

     ```
     const kybDoc = await objectStorage.routeClient.withStagedUpload(
       {
         namespace: 'KYB_DOCUMENTS',
         data: uploadedBuffer,
         originalFilename: file.name,
         claimedMimeType: file.type,
         ownerMerchantId: merchantId,
         actor: {
           actorType: isMerchant ? 'MERCHANT_USER' : 'ADMIN',
           actorId: actor.id,
           merchantId: isMerchant ? merchantId : null,
           authorities: actor.authorities,
         },
       },
       async (staged) => {
         return prisma.$transaction(async (tx) => {
           const doc = await tx.kybDocument.create({
             data: {
               merchantId,
               documentType,
               fileName: file.name,
               mimeType: staged.detectedMimeType,
               fileSize: Number(staged.byteSize),
               fileHash: staged.sha256Hex,
               storageObjectId: staged.objectId,
               storagePath: staged.storageKey,
               avScanStatus: 'PENDING',
             },
           })
           await objectStorage.routeClient.bind(tx, {
             objectId: staged.objectId,
             holderType: 'KYB_DOCUMENT',
             holderId: doc.id,
             actorId: actor.id,
             reason: 'KYB_DOCUMENT_UPLOAD',
             autoPromoteIfNoAvRequired: false, // KYB requires async AV scan
           })
           return doc
         })
       }
     )
     
     
     
     
     
     ```

   * On download (`GET /kyb-documents/:id/download`):

     ```
     const doc = await prisma.kybDocument.findUniqueOrThrow({ where: { id: docId } })
     const result = await objectStorage.routeClient.readAuthorized({
       objectId: doc.storageObjectId,
       actor: currentActorContext,
       holderContext: { holderType: 'KYB_DOCUMENT', holderId: doc.id },
     })
     
     
     
     
     
     ```

2. **`core-back/engine/workers/KybScanWorker.ts`:**

   * Read bytes via `objectStorage.workerClient.readForScan(doc.storageObjectId)` and call `objectStorage.workerClient.applyScanVerdict({ objectId: doc.storageObjectId, verdict, signature })` alongside updating `KybDocument.avScanStatus`.

3. **`core-back/engine/governance/GovernanceExecution.ts` (`KYB_DELETE_DOCUMENT`):**

   * Inside the governance execution transaction:

     ```
     const doc = await tx.kybDocument.findUniqueOrThrow({ where: { id: documentId } })
     await tx.kybDocument.delete({ where: { id: doc.id } })
     await objectStorage.routeClient.release(tx, {
       objectId: doc.storageObjectId,
       holderType: 'KYB_DOCUMENT',
       holderId: doc.id,
       actorId: executorAdminId,
       reason: 'GOVERNANCE_KYB_DELETE_DOCUMENT',
     })
     
     
     
     
     
     ```

4. **`core-back/prisma/syntheticSeeder/sync/enrichKybDocuments.ts`:**

   * Include `storageObjectId`, `avScanStatus`, and `fileHash` in the enriched DTO without selecting `fileContent`.

### 7.3 Reconciliation Statements (`ReconciliationRun`)

Update the following 3 files:

1. **`core-back/api/internal/reconciliationUpload.ts`:**

   * Stage the statement file via `objectStorage.routeClient.withStagedUpload({ namespace: 'RECON_STATEMENTS', ... })`, create `ReconciliationRun` with `storageObjectId: staged.objectId` inside `prisma.$transaction`, and call `objectStorage.routeClient.bind(tx, { objectId: staged.objectId, holderType: 'RECON_RUN', holderId: run.id, actorId: admin.id, reason: 'RECON_STATEMENT_INGEST' })` (since `RECON_STATEMENTS` has `requiresAsyncAvScan: false`, `bind()` promotes it to `ACTIVE` immediately in pure SQL).

2. **`core-back/engine/workers/BackgroundJobHandlers.ts` (`RECONCILIATION_PARSE_RUN`):**

   * Replace reading `run.rawFileContent` with:

     ```
     const blob = await objectStorage.workerClient.readInternal(run.storageObjectId!, 'recon-parse-worker')
     const rawText = Buffer.from(blob.bytes).toString('utf8')
     
     
     
     
     
     ```

3. **`core-back/prisma/syntheticSeeder/generators/06_reconAndStatements.ts`:**

   * Stage sample reconciliation CSV via `objectStorage.workerClient.stageSystemGenerated({ namespace: 'RECON_STATEMENTS', ... })` and bind to the seeded `ReconciliationRun`.

### 7.4 Regulatory Reports (`RegulatoryReportSchema` & `RegulatoryReportOutput`)

Update `core-back/engine/compliance/reporting/ReportGenerationService.ts` and `core-back/api/internal/admin.ts`:

* When uploading a `RegulatoryReportSchema` template, stage in `REGULATORY_REPORTS` and bind with `holderType = 'REG_REPORT_SCHEMA'`, `holderId = schema.id`.

* When `ReportGenerationService.ts` generates a regulatory XML/PDF/CSV output, stage via `objectStorage.workerClient.stageSystemGenerated({ namespace: 'REGULATORY_REPORTS', ... })`, insert `RegulatoryReportOutput` with `storageObjectId: staged.objectId`, and bind with `holderType = 'REG_REPORT_OUTPUT'`, `holderId = output.id`.

* Serve downloads via `objectStorage.routeClient.readAuthorized({ objectId: output.storageObjectId, actor, holderContext: { holderType: 'REG_REPORT_OUTPUT', holderId: output.id } })`.

### 7.5 Dynamic Report Studio Assets (`ReportAssetBundleEntry` in `core-back/engine/reportStudio/assetStorage.ts`)

Update `core-back/engine/reportStudio/assetStorage.ts`, `core-back/api/internal/adminReportEngine.ts`, and `core-back/api/internal/merchantReportEngine.ts`:

* When a Report Studio bundle or asset is uploaded, stage each asset via `objectStorage.routeClient.stageUpload({ namespace: 'REPORT_STUDIO_ASSETS', ... })` **before** opening the DB transaction, then create `ReportAssetBundleEntry` (`storageObjectId: staged.objectId`) and call `objectStorage.routeClient.bind(tx, { objectId: staged.objectId, holderType: 'REPORT_ASSET_ENTRY', holderId: entry.id, ... })`.

* When rendering a report (`adminReportEngine.ts` or `merchantReportEngine.ts`), load bundle entry bytes via `objectStorage.workerClient.readInternal(entry.storageObjectId, 'report-studio-renderer')`.

* When deleting or superseding a report asset entry, call `objectStorage.routeClient.release(tx, { objectId: entry.storageObjectId, holderType: 'REPORT_ASSET_ENTRY', holderId: entry.id, ... })`.

### 7.6 System Brand Assets & Payment Rail Logos (`Asset` & `Rail.logoAssetId`)

Update `core-back/api/internal/admin.ts` and `core-back/engine/specImporter/SpecMaterializer.ts`:

* Uploading an `Asset` stages in `SYSTEM_BRAND_ASSETS`, creates the `Asset` row with `storageObjectId: staged.objectId`, and binds `holderType = 'CATALOG_ASSET'`, `holderId = asset.id`.

* When assigning `rail.logoAssetId = asset.id` (in `admin.ts` or `SpecMaterializer.ts`), also bind a second lock on `asset.storageObjectId` with `holderType = 'RAIL_LOGO'`, `holderId = rail.id` (demonstrating shared multi-record locking!). If a rail changes its logo or is deleted, release the `'RAIL_LOGO'` lock for the old `storageObjectId`.

* Attempting to delete an `Asset` whose `storageObjectId` is still locked by an active `Rail` (`holderType = 'RAIL_LOGO'`) will release `'CATALOG_ASSET'`, see `remainingActiveLocks > 0` (or if the route checks active locks on `storageObjectId` before deleting `Asset`), and reject deletion of the underlying `StorageObject` until no `Rail` references it.

### 7.7 Dispute Evidence (`DisputeAttachment`) & AML Case Attachments (`AmlCaseEvidence`)

In `core-back/api/internal/merchant.ts` and `core-back/api/internal/admin.ts`:

```
// 1. Upload Dispute Evidence (Merchant or Admin)
const attachment = await objectStorage.routeClient.withStagedUpload(
  {
    namespace: 'DISPUTE_EVIDENCE',
    data: fileBytes,
    originalFilename: fileName,
    claimedMimeType: mimeType,
    ownerMerchantId: dispute.merchantId,
    actor: currentActor,
  },
  async (staged) => {
    return prisma.$transaction(async (tx) => {
      const row = await tx.disputeAttachment.create({
        data: {
          disputeId: dispute.id,
          merchantId: dispute.merchantId,
          storageObjectId: staged.objectId,
          label,
          uploadedById: currentActor.actorId,
        },
      })
      await objectStorage.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType: 'DISPUTE_ATTACHMENT',
        holderId: row.id,
        actorId: currentActor.actorId,
        reason: 'DISPUTE_EVIDENCE_UPLOAD',
        autoPromoteIfNoAvRequired: false, // Scanned asynchronously by AvScanWorker
      })
      return row
    })
  }
)

// 2. Upload AML Case Evidence (Compliance Admin)
const evidence = await objectStorage.routeClient.withStagedUpload(
  {
    namespace: 'AML_CASE_ATTACHMENTS',
    data: fileBytes,
    originalFilename: fileName,
    claimedMimeType: mimeType,
    ownerMerchantId: null,
    actor: adminActor,
  },
  async (staged) => {
    return prisma.$transaction(async (tx) => {
      const row = await tx.amlCaseEvidence.create({
        data: {
          amlCaseId,
          storageObjectId: staged.objectId,
          evidenceType,
          notes,
          uploadedById: adminActor.actorId,
        },
      })
      await objectStorage.routeClient.bind(tx, {
        objectId: staged.objectId,
        holderType: 'AML_CASE_EVIDENCE',
        holderId: row.id,
        actorId: adminActor.actorId,
        reason: 'AML_EVIDENCE_UPLOAD',
        autoPromoteIfNoAvRequired: false,
      })
      return row
    })
  }
)




```

### 7.8 Mandatory Codebase-Wide Asset Sweep & 4-Step Playbook for Integrating Unmentioned or Future Asset Features

#### Part A: Mandatory Repo-Wide Audit for Any Unmentioned Asset Code

Before running final tests, `OpenCode` **must** execute the following repository-wide discovery check to ensure zero unmentioned files, routes, seeders, or helpers still use raw DB byte columns or local disk writes:

```
# 1. Verify zero remaining Bytes columns in Prisma domain models (only StorageObject.wrappedDek, dekNonce, streamNoncePrefix are allowed):
grep -n "Bytes" core-back/prisma/schema.prisma

# 2. Search for any unmentioned file/buffer/base64 upload handlers or direct fs writes in core-back, admin-back, and merchant-back:
grep -rnE "fileContent|rawFileContent|templateContent|content_bytes|fs\.writeFile|fsp\.writeFile" core-back/src core-back/api core-back/engine admin-back merchant-back



```

If any route, worker, or helper outside Sections `7.2`–`7.7` is found storing or reading binary assets directly, migrate it immediately using the 4-Step Playbook in Part B below.

#### Part B: 4-Step Playbook to Integrate ANY New or Future Asset-Backed Feature

Whenever a future feature, engine, or table needs to store, share, lock, or serve files/assets, **never add a `Bytes` column to PostgreSQL and never write to local disk**. Follow this exact 4-step protocol:

1. **Step 1 — Add `storageObjectId` FK to Your Prisma Model (`core-back/prisma/schema.prisma`):**

   ```
   model MyNewFeatureRecord {
     id              String        @id @default(uuid()) @db.Uuid
     storageObjectId String        @map("storage_object_id") @db.Uuid
     storageObject   StorageObject @relation(fields: [storageObjectId], references: [id], onDelete: Restrict)
     // ... your other domain columns
   }
   
   
   
   
   ```

   *(Always use `onDelete: Restrict` so PostgreSQL forbids deleting the `StorageObject` while your record references it).*

2. **Step 2 — Register the Holder Type & Namespace Policy (`core-back/lib/objectStorageSdk/types.ts`):**

   * Add your holder identifier (e.g., `'MY_NEW_FEATURE'`) to the `StorageHolderType` union in `core-back/lib/objectStorageSdk/types.ts`.

   * Either use an existing `StorageNamespace` or add a new enum value to `StorageNamespace` and configure its `NAMESPACE_POLICIES` entry (`allowedMimeTypes`, `maxByteSize`, `requiresAsyncAvScan`, `defaultRetentionDays`, `requiredAuthority`, `confidentialityTier`).

3. **Step 3 — Register the Holder Existence Check in `core-back/lib/objectStorageSdk/holderRegistry.ts`:**

   * Add a `case 'MY_NEW_FEATURE':` branch inside `checkHoldersExistInDb()` in `core-back/lib/objectStorageSdk/holderRegistry.ts`:

     ```
     case 'MY_NEW_FEATURE': {
       const rows = await prisma.myNewFeatureRecord.findMany({
         where: { id: { in: holderIds } },
         select: { id: true },
       })
       return new Set(rows.map((r) => r.id))
     }
     
     
     
     
     ```

   * TypeScript's exhaustive `switch` check on `StorageHolderType` will fail compilation if you forget this step, guaranteeing `LockReconciler` always knows how to verify your table!

4. **Step 4 — Use Only the 4 SDK Operations in Routes & Workers:**

   * **Upload & Bind (User/Admin Route):** Wrap in `objectStorage.routeClient.withStagedUpload(stageInput, async (staged) => prisma.$transaction(async (tx) => { ... await objectStorage.routeClient.bind(tx, { objectId: staged.objectId, holderType: 'MY_NEW_FEATURE', holderId: row.id, ... }) }))`.

   * **Share an Existing Asset Across Another Record (e.g., linking an existing catalog asset to a second entity):** Inside `prisma.$transaction(async (tx) => ...)`, call `await objectStorage.routeClient.bind(tx, { objectId: existingObjectId, holderType: 'MY_SECOND_HOLDER', holderId: secondRow.id, actorId, reason })`. Both records now hold independent active locks on the same shared object!

   * **Download / View (User/Admin Route):** Call `await objectStorage.routeClient.readAuthorized({ objectId: row.storageObjectId, actor, holderContext: { holderType: 'MY_NEW_FEATURE', holderId: row.id } })`.

   * **Background Worker Read:** Call `await objectStorage.workerClient.readInternal(row.storageObjectId, 'my-worker-name')`.

   * **Delete / Unlink Record:** Inside `prisma.$transaction(async (tx) => ...)`, delete or unlink your domain row first, then call `await objectStorage.routeClient.release(tx, { objectId: row.storageObjectId, holderType: 'MY_NEW_FEATURE', holderId: row.id, actorId, reason })`.

### 7.9 AI Transcript Onboarding Integration (Report Studio & Smart Gateway)

Update both AI onboarding transcript generators so external AI assistants generating specs with assets follow the v34 Object Storage Engine contract:

1. **`core-back/lib/reportEngineSdk/transcript/ReportTranscriptBuilder.ts`:**

   * Update the "Asset Bundle & Static Media Rules" section of the generated Markdown transcript to instruct the AI:

     * All embedded logos, watermarks, signatures, and custom fonts (`image/png`, `image/jpeg`, `image/webp`, `image/svg+xml`, `font/ttf`, `font/woff2`) uploaded with a Report Studio bundle are stored in the shared `REPORT_STUDIO_ASSETS` vault (`StorageObject` + `ReportAssetBundleEntry.storageObjectId` locked via `holderType = 'REPORT_ASSET_ENTRY'`).

     * Active SVGs (`<script>`, `onload=`, `<foreignObject>`, external URLs) are rejected by `sanitizeAndValidateSvg()` at staging time with `415 STORAGE_SVG_UNSAFE`.

     * Inside the Report DSL template, reference bundle assets strictly via `asset://bundle/<entryKey>`.

2. **`core-back/engine/specImporter/TranscriptBuilder.ts`:**

   * Update the "Payment Rail Brand Assets (`logoAssetId`)" section of the Smart Gateway transcript to specify that rail logos must reference an active `Asset.id` backed by a `SYSTEM_BRAND_ASSETS` `StorageObject`, and that `SpecMaterializer.ts` automatically binds a shared `RAIL_LOGO` lock (`holderType = 'RAIL_LOGO'`, `holderId = rail.id`) so the logo cannot be purged while any payment rail uses it.

## 8. Admin Monitoring API, Admin-Front UI & 22-Test Verification Suite

### 8.1 Admin Backend API (`core-back/api/internal/objectStorage.ts` & `admin-back/api/protected/objectStorage.ts`)

Expose the following protected admin endpoints (requiring `system:storage:read`, `system:storage:admin`, or `system:storage:legal-hold`):

1. `GET /api/admin/object-storage/summary`:

   * Returns `{ health: await objectStorage.blobStore.healthCheck(), countsByStatus, bytesByNamespace, activeLocksCount, legalHoldCount, quarantinePendingCount, scrubErrorsCount }`.

2. `GET /api/admin/object-storage/objects`:

   * Paginated filterable list by `namespace`, `status`, `bucket`, `ownerMerchantId`, `legalHold`, `sha256Hex`, including active `locks`.

3. `GET /api/admin/object-storage/objects/:id`:

   * Returns full metadata, active & historical `locks`, and the latest 50 `accessLogs`.

4. `POST /api/admin/object-storage/objects/:id/legal-hold`:

   * Calls `objectStorage.routeClient.placeLegalHold({ objectId, adminId, reason })`.

5. `DELETE /api/admin/object-storage/objects/:id/legal-hold`:

   * Calls `objectStorage.routeClient.liftLegalHold({ objectId, adminId, reason })`.

6. `POST /api/admin/object-storage/maintenance/:job`:

   * Triggers `gc`, `sweep`, `scrub`, `reconcile-locks`, `rewrap`, or `av-scan` on demand and returns the worker result JSON.

### 8.2 Admin-Front UI (`admin-front/src/pages/system/object-storage/index.tsx`)

Create `admin-front/src/pages/system/object-storage/index.tsx` and wire it into:

* `admin-front/src/router/index.ts`: route `/system/object-storage`

* `admin-front/src/layouts/sections.tsx`: navigation item under System (`Object & Asset Storage`)

* `admin-front/src/utils/routeAuthorities.ts`: required authority `'system:storage:read'`

The page renders 4 tabs:

1. **Cluster & Shared Daemon Health:** Shows whether the cluster is running in `REMOTE_MTLS` (Dedicated Storage Node) or `FS_LOCAL` mode, free disk bytes, latency, KEK active version, and buttons to run Maintenance Jobs (`GC`, `Blob Sweep`, `Integrity Scrub`, `Lock Reconcile`, `KEK Rewrap`).

2. **Object Explorer & Lock Inspector:** Filterable table of `storage_objects` showing `id`, `namespace`, `status`, `detectedMimeType`, `byteSize`, `retainUntil`, `legalHold` badge, and active lock badges (`KYB_DOCUMENT`, `RAIL_LOGO`, `REPORT_ASSET_ENTRY`, etc.).

3. **Quarantine & AV Queue:** Shows `QUARANTINE_PENDING_AV` and `QUARANTINE_REJECTED` objects with malware signatures.

4. **Access Audit Trail:** Live stream of `storage_object_access_logs` showing granted and denied read attempts (`READ_AUTHORIZED`, `READ_DENIED_TENANT_MISMATCH`, `READ_DENIED_AUTHORITY`, `READ_DENIED_QUARANTINE`).

### 8.3 Complete 22-Test Suite (`T01`–`T22`)

Create `core-back/test/objectStorageEngine.test.ts` and `deploy/test/objectStorageDeploy.test.ts` covering all 22 mandatory scenarios:

| Test ID | Test Name | Exact Assertion | 
| ----- | ----- | ----- | 
| **T01** | `stage_bind_promote_read_roundtrip` | `stageUpload` -> `bind` inside `$transaction` -> `readAuthorized` returns byte-for-byte identical payload and SHA-256; logs `READ_AUTHORIZED`. | 
| **T02** | `chunk_tamper_detected_by_gcm` | Flipping 1 bit in chunk 0 or chunk 1 of the `.v1.enc` file causes `readAuthorized` to throw `STORAGE_INTEGRITY_CORRUPTED`. | 
| **T03** | `chunk_truncation_and_reorder_detected` | Truncating the final chunk or swapping chunk 0 and chunk 1 fails GCM AAD authentication (`chunkIndex` + `isFinal` bound in AAD). | 
| **T04** | `cross_object_blob_swap_detected` | Copying Object B's `.v1.enc` file over Object A's storageKey fails decryption because `objectId` (16 bytes) is bound in both DEK AAD and chunk AAD. | 
| **T05** | `withStagedUpload_cleans_up_on_tx_rollback` | When `prisma.$transaction` throws after `stageUpload`, `withStagedUpload` automatically moves the staged blob to `.trash` and marks the row `PURGED`. | 
| **T06** | `direct_sql_delete_blocked_by_trigger` | Executing `prisma.storageObject.delete({ where: { id } })` throws PostgreSQL error `23503: STORAGE_OBJECT_DELETE_FORBIDDEN`. | 
| **T07** | `purge_blocked_while_active_lock_exists` | Updating `status = 'PURGED'` while any `storage_object_locks` row has `released_at IS NULL` throws `23503: STORAGE_OBJECT_LOCKED`. | 
| **T08** | `shared_multi_holder_lock_ref_counting` | Binding both `CATALOG_ASSET` and `RAIL_LOGO` to the same `objectId`, then releasing `CATALOG_ASSET`, leaves `remainingActiveLocks = 1` and `gcEligibleAt = null`; releasing `RAIL_LOGO` sets `gcEligibleAt`. | 
| **T09** | `retention_floor_prevents_early_purge` | Attempting to transition `ACTIVE` -> `PURGED` while `retain_until > NOW()` throws `23503: STORAGE_OBJECT_RETENTION_ACTIVE`; shortening `retain_until` throws `23514: STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN`. | 
| **T10** | `legal_hold_blocks_gc_and_purge` | Placing `legalHold = true` blocks `runGcBatch()` and blocks SQL `status = 'PURGED'` (`STORAGE_OBJECT_LEGAL_HOLD_ACTIVE`) even after `retain_until` expires and all locks are released. | 
| **T11** | `quarantine_pending_av_blocks_download_and_has_null_retention` | A newly bound `KYB_DOCUMENTS` object has `status = 'QUARANTINE_PENDING_AV'` and `retainUntil = null`; `readAuthorized` throws `STORAGE_OBJECT_QUARANTINED` (HTTP 423). | 
| **T12** | `eicar_malware_verdict_releases_locks_and_rejects` | Uploading EICAR test string into `KYB_DOCUMENTS` and running `runAvScanBatch` releases the lock, transitions to `QUARANTINE_REJECTED` with `retainUntil = null`, and allows GC after 24h. | 
| **T13** | `svg_xss_payload_rejected_at_stage` | Uploading an SVG containing `<script>`, `onload=`, or `<foreignObject>` into `REPORT_STUDIO_ASSETS` or `SYSTEM_BRAND_ASSETS` throws `STORAGE_SVG_UNSAFE` (HTTP 415). | 
| **T14** | `executable_spoofed_as_pdf_rejected` | Uploading an ELF or PE binary named `invoice.pdf` throws `STORAGE_MIME_FORBIDDEN` (HTTP 415). | 
| **T15** | `merchant_cross_tenant_isolation` | Merchant B attempting `readAuthorized` on Merchant A's object throws `STORAGE_TENANT_MISMATCH` (HTTP 403) and records `READ_DENIED_TENANT_MISMATCH` in `storage_object_access_logs`. | 
| **T16** | `admin_missing_authority_denied` | Admin without `compliance:reports:read` attempting `readAuthorized` on a `REGULATORY_REPORTS` object throws `STORAGE_ACCESS_DENIED` (HTTP 403) and logs `READ_DENIED_AUTHORITY`. | 
| **T17** | `kek_rotation_rewrap_without_blob_rewrite` | Adding `v2` to `InMemoryKeyProvider` and running `runRewrapBatch()` updates `kek_key_version = 2` in DB without modifying `.v1.enc` mtime, and `readAuthorized` decrypts seamlessly. | 
| **T18** | `gc_grace_window_and_soft_trash_recovery` | Releasing the last lock sets `gc_eligible_at = NOW() + 24h`; once eligible, `runGcBatch()` moves the blob to `.trash/YYYY-MM-DD/` and marks `PURGED`. | 
| **T19** | `lock_reconciler_releases_dangling_holder` | Deleting a domain row in a test setup and running `runLockReconcile()` detects the missing holder via `HOLDER_REGISTRY` and releases the dangling lock. | 
| **T20** | `multi_node_shared_daemon_concurrent_nodes` | Starts `startObjectStorageDaemon()` (`deploy/object-storage-daemon`), instantiates two separate `ObjectStorageSdk` instances (`node1`, `node2`) using `RemoteMtlsBlobStore` pointing to the daemon URL: `node1` uploads & binds a KYB doc and a Report Studio asset; `node2` immediately reads and decrypts both over the network! | 
| **T21** | `deploy_topology_derivation_and_multi_node_guard` | (a) Setting `OBJECT_STORAGE_NODE="obj-1@10.10.14.10:22:10.10.14.10:4095"` in `parseDeployEnv` + `buildStoragePlan` populates `plan.objectStorageNode`, injects `OBJECT_STORAGE_DAEMON_URL="https://10.10.14.10:4095"` into `coreEnv` and `backupDaemonEnv`, mints `object-storage-daemon` and `object-storage-client` mTLS certs, and generates TCP 4095 firewall rules; (b) Passing 2+ `CORE_NODES` with an empty `OBJECT_STORAGE_NODE=""` throws `MULTI_NODE_SHARED_STORAGE_REQUIRED` so blobs are never stored on core nodes. | 
| **T22** | `backup_manifest_parity_and_escrowed_kek_decrypt_drill` | `exportManifest()` + `RemoteMtlsBlobStore` sync into backup repository verifies 100% blob parity and decrypts sampled objects using the escrowed KEK keyring. | 

## 9. Complete Guide, Academy & IT Documentation Updates (Verbatim Blocks & Extractor Pipeline)

In this repository, the Admin Interactive Guide (`/guide`) and Employee Academy (`/academy`) are powered by:

1. Canonical source files in `design/07-guides-and-academy/guide_system_design_and_content.md` and `design/07-guides-and-academy/academy_system_design_and_content.md` (compiled into `admin-front/src/content/guide/generated/*.json`, `admin-front/src/content/academy/generated/*.json`, and `core-back/content/academy/exam-bank.json` via `bun run admin-front/scripts/extract-guide-content.ts` and `bun run admin-front/scripts/extract-academy-content.ts`).

2. Book and glossary definitions in `admin-front/src/content/guide/booksPart2.ts` and `admin-front/src/content/guide/glossaryData.ts` (tested by `admin-front/src/content/__tests__/content-completeness.test.ts`).

### 9.1 Verbatim Guide Additions (`design/07-guides-and-academy/guide_system_design_and_content.md`)

Insert the following `@@article`, `@@card`, `@@term`, `@@faq`, and `@@map` blocks before `<!-- CONTENT:END -->` in `design/07-guides-and-academy/guide_system_design_and_content.md`:

```
@@article id=b12-12 book=12 order=12 title="Shared Object & Asset Storage: how files, locks, quarantine and retention work" roles=SECURITY_ADMIN,GATEWAY_ADMIN,COMPLIANCE,FINANCE minutes=4 ui=AVAILABLE related=b12-09,b12-10,b12-13
:::summary Big picture in 20 seconds
Every uploaded document, statement, report output and brand logo lives in the encrypted Shared Object Storage vault (`OBJECT_STORAGE_NODE`), never inside PostgreSQL table rows and never on individual core nodes.
:::

### Why files never live on core nodes or inside PostgreSQL
In a multi-node deployment, several `core-back` servers and a dedicated `backup-daemon` server work together. If `core-1` saved a KYB PDF on its own disk, `core-2` and `backup-1` could not read it. Therefore:
* The deploy engine requires a shared **Object Storage Node** (`OBJECT_STORAGE_NODE`, running `pg-object-storage-daemon` over mTLS on port `4095`). If someone configures multiple core nodes without `OBJECT_STORAGE_NODE`, deployment refuses to start (`MULTI_NODE_SHARED_STORAGE_REQUIRED`).
* Every file is encrypted in 64 KiB `AES-256-GCM` chunks (`pgos1`) with its own 256-bit Data Encryption Key (DEK) wrapped by the Key Encryption Keyring (`OBJECT_STORAGE_KEK_KEYRING`).
* PostgreSQL stores only the small control-plane ledger: `storage_objects`, `storage_object_locks` and `storage_object_access_logs`.

### Shared multi-record locks (`storage_object_locks`)
One file can be locked by more than one record at the same time. For example, a payment rail logo uploaded into the Asset Catalog (`CATALOG_ASSET`) and assigned to two payment rails (`RAIL_LOGO`) has three active locks.
* Database trigger `storage_objects_guard_trg` forbids deleting rows from `storage_objects` and forbids transitioning an object to `PURGED` while **any** active lock (`released_at IS NULL`) exists, while `legal_hold = true`, or while `retain_until` is in the future.
* When the last active lock is released, the object enters a 24-hour grace window (`gc_eligible_at`). After 24 hours (and after `retain_until` expires), `GcWorker` moves the ciphertext file to `.trash/YYYY-MM-DD/` for 7 days before permanent removal.

### Two-stage retention and malware quarantine
When a merchant or operator uploads a KYB document, dispute attachment or AML evidence file:
1. It is staged and bound in `QUARANTINE_PENDING_AV` state with `retain_until = NULL`. While in quarantine, nobody can download it (`423 STORAGE_OBJECT_QUARANTINED`).
2. `AvScanWorker` decrypts and scans the file. If clean, it promotes the object to `ACTIVE` and stamps its compliance retention window (`retain_until`). If infected, it releases the lock and marks the object `QUARANTINE_REJECTED` so malware never receives a 7-year compliance lock.
@@end

@@article id=b12-13 book=12 order=13 title="Operating the Object & Asset Storage screen: legal holds, KEK rotation and maintenance jobs" roles=SECURITY_ADMIN,GATEWAY_ADMIN,COMPLIANCE minutes=3 ui=AVAILABLE related=b12-12,b12-10,b12-11
:::summary Big picture in 20 seconds
Use `/system/object-storage` to inspect shared storage health, check active locks on any file, place or lift legal holds, and trigger maintenance jobs (`Integrity Scrub`, `KEK Rewrap`, `Lock Reconcile`, `GC`).
:::

### Who may do what on `/system/object-storage`
* **View health, objects, locks and access logs:** `system:storage:read`.
* **Place or lift a Legal Hold:** `system:storage:legal-hold` (Security Admin / Compliance).
* **Trigger maintenance jobs (`scrub`, `rewrap`, `reconcile-locks`, `gc`, `sweep`):** `system:storage:admin`.

### Placing and lifting a Legal Hold
During an investigation, dispute or audit, a Compliance or Security Admin can place a **Legal Hold** on any object with a mandatory written reason. While `legal_hold = true`, database trigger `storage_objects_guard_trg` and `GcWorker` refuse to purge the object even if all domain locks are released and `retain_until` has passed. Checklist: [[c:sg-place-legal-hold|Place or lift a storage legal hold]].

### Zero-downtime KEK key rotation (`RewrapWorker`)
When IT rotates `OBJECT_STORAGE_KEK_KEYRING` from `v1` to `v2`, the encrypted `.v1.enc` files on disk do not need to be rewritten. Running the **KEK Rewrap** job unwraps each object's 32-byte DEK with `v1` and re-wraps it with `v2` in `storage_objects`.
@@end

@@card id=sg-place-legal-hold title="Place or lift a storage legal hold" screen=SystemObjectStorage risk=HIGH irreversible=false
Place a legal hold whenever an uploaded KYB document, statement, report or evidence file is subject to an active investigation, court order or regulatory audit.
* Confirm the exact `objectId` and inspect its active `storage_object_locks` holders first.
* Record the case reference or regulatory request ID in the legal hold reason.
* Lifting a legal hold allows `GcWorker` to purge the object if all locks are released and `retain_until` has expired.
@@end

@@term slug=object-storage-vault term="Object Storage Vault" aliases="OBJECT_STORAGE_NODE,pg-object-storage-daemon" related=storage-object-lock,legal-hold
short: The dedicated mTLS service (`pg-object-storage-daemon`) that stores chunk-encrypted (`pgos1`) files shared across all core-back nodes and backup-daemon.
@@end

@@term slug=storage-object-lock term="Storage Object Lock" aliases="storage_object_locks,holder lock" related=object-storage-vault,legal-hold
short: An append-only reference in `storage_object_locks` binding a business record (such as `KYB_DOCUMENT` or `RAIL_LOGO`) to a `StorageObject` so it cannot be purged while in use.
@@end

@@term slug=legal-hold term="Legal Hold" aliases="legal_hold" related=object-storage-vault,storage-object-lock
short: A compliance flag on `storage_objects` that freezes an asset against garbage collection or purging regardless of lock count or retention expiry.
@@end

@@faq id=q-059 article=b12-12
Q: Can two core-back servers store uploaded files on their own local disks?
No. Multi-node deployments must configure `OBJECT_STORAGE_NODE` so every core server and backup daemon reads and writes to the shared mTLS storage vault.
@@end

@@faq id=q-060 article=b12-13
Q: Why can't I download a newly uploaded KYB document right away?
It is in `QUARANTINE_PENDING_AV` until the antivirus scan worker verifies it is clean and promotes it to `ACTIVE`.
@@end



```

Also add the `SystemObjectStorage` screen entry inside the `@@map id=context-map` JSON array in `design/07-guides-and-academy/guide_system_design_and_content.md`:

```
  {
   "screenId": "SystemObjectStorage",
   "routeNames": [
    "SystemObjectStorage"
   ],
   "pageDir": "pages/system/object-storage",
   "summary": "Shared Object & Asset Storage console: inspect mTLS storage daemon health, browse encrypted objects and their active record locks, review AV quarantine items, place or lift legal holds, and audit every allowed or denied file read.",
   "articles": [
    "b12-12",
    "b12-13",
    "b12-10"
   ],
   "cards": [
    "sg-place-legal-hold"
   ],
   "situations": []
  }



```

### 9.2 Verbatim Academy Additions (`design/07-guides-and-academy/academy_system_design_and_content.md`)

Insert Lesson `l-m10-5`, practice checks `c-l-m10-5-1` & `c-l-m10-5-2`, and exam questions `q-m10-118` & `q-m10-119` into `design/07-guides-and-academy/academy_system_design_and_content.md`:

```
@@lesson id=l-m10-5 module=m10 order=5 title="Shared Object & Asset Storage: multi-node vault, locks, quarantine and legal holds" minutes=20 tracks=GATEWAY_ADMIN,SECURITY_ADMIN,COMPLIANCE reading=b12-12,b12-13
### You will be able to
- Explain why uploaded files are stored in the shared `pg-object-storage-daemon` vault (`OBJECT_STORAGE_NODE`) rather than inside PostgreSQL or on individual core nodes.
- Explain how `storage_object_locks`, `retain_until` and `legal_hold` work together to prevent premature deletion.
- Explain why `QUARANTINE_PENDING_AV` objects have `retain_until = NULL` until the malware scan succeeds.

### Key ideas
- **Storage is always shared across nodes.** Every `core-back` node and `backup-daemon` connects over mTLS to `OBJECT_STORAGE_NODE` (`pg-object-storage-daemon`). Configuring multiple core nodes without `OBJECT_STORAGE_NODE` is rejected by deployment validation (`MULTI_NODE_SHARED_STORAGE_REQUIRED`).
- **One upload = one encrypted `.v1.enc` envelope (`pgos1`).** Files are encrypted in 64 KiB `AES-256-GCM` chunks with a unique per-object DEK wrapped by `OBJECT_STORAGE_KEK_KEYRING`.
- **Multiple records can lock the same object.** `storage_object_locks` tracks every domain holder (`KYB_DOCUMENT`, `RECON_RUN`, `REG_REPORT_OUTPUT`, `REPORT_ASSET_ENTRY`, `CATALOG_ASSET`, `RAIL_LOGO`, `DISPUTE_ATTACHMENT`, `AML_CASE_EVIDENCE`). PostgreSQL trigger `storage_objects_guard_trg` blocks purging while any active lock exists.
- **Quarantine comes before compliance retention.** Untrusted uploads start in `QUARANTINE_PENDING_AV` with `retain_until = NULL`. Only after `AvScanWorker` marks the file `CLEAN` does `promote()` activate the object and stamp `retain_until`.
- **Backups verify object parity and KEK decryption.** `backup-daemon` syncs immutable `.v1.enc` blobs over mTLS, checks manifest parity against `ACTIVE` database rows, and tests decryption using the escrowed KEK keyring during weekly restore drills.

### A worked example
1. An admin uploads a bank logo on `core-1` (`CATALOG_ASSET` lock) and assigns it to two payment rails (`RAIL_LOGO` locks).
2. `core-2` serves the logo immediately over mTLS from `obj-1`.
3. Later, an admin tries to purge the logo while one rail still uses it. PostgreSQL trigger `storage_objects_guard_trg` rejects the purge (`STORAGE_OBJECT_LOCKED`) because an active `RAIL_LOGO` lock remains.

### Common mistakes
- Leaving `OBJECT_STORAGE_NODE` empty when scaling `CORE_NODES` past one server.
- Expecting a `QUARANTINE_PENDING_AV` KYB file to be downloadable before `AvScanWorker` finishes.

### Read now
- [[a:b12-12|Shared Object & Asset Storage: how files, locks, quarantine and retention work]]
- [[a:b12-13|Operating the Object & Asset Storage screen]]

### Check yourself
Questions: c-l-m10-5-1, c-l-m10-5-2
@@end

@@q id=c-l-m10-5-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-5 tracks=GATEWAY_ADMIN,SECURITY_ADMIN,COMPLIANCE refs=b12-12
Stem: What happens if an operator configures two `CORE_NODES` in `deploy.env` and leaves `OBJECT_STORAGE_NODE` empty?
- [x] Deployment validation fails with `MULTI_NODE_SHARED_STORAGE_REQUIRED` because core nodes are forbidden from storing blobs on their own local disks.
- [ ] Each core node stores half of the uploaded files on its own local disk.
- [ ] Files are stored inside PostgreSQL `BYTEA` columns instead.
Why: Every multi-node deployment must point all core nodes and the backup daemon at the shared `OBJECT_STORAGE_NODE` server.
@@end

@@q id=c-l-m10-5-2 module=m10 type=single difficulty=2 critical=false exam=false lesson=l-m10-5 tracks=GATEWAY_ADMIN,SECURITY_ADMIN,COMPLIANCE refs=b12-12,b12-13
Stem: When is the multi-year compliance `retain_until` timestamp stamped on a newly uploaded KYB document?
- [x] Only when `promote()` activates the object after the antivirus scan passes (`CLEAN`).
- [ ] Before the file is scanned for malware.
- [ ] Only when a Legal Hold is placed.
Why: Stamping compliance retention before AV scanning would make malware undeletable; retention is stamped at promotion time.
@@end

@@q id=q-m10-118 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-12
Stem: An asset in `storage_objects` has two active locks (`CATALOG_ASSET` and `RAIL_LOGO`). If the catalog entry is released while the payment rail still uses the logo, can the object be purged?
- [x] No; `storage_objects_guard_trg` forbids transitioning to `PURGED` while any active lock (`released_at IS NULL`) remains.
- [ ] Yes; releasing the first lock deletes the file from disk immediately.
- [ ] Yes, if an administrator passes a PostgreSQL session GUC override.
Why: There are no GUC backdoors, and an object cannot be purged until active locks reach zero, `legal_hold` is false, and `retain_until` has expired.
@@end



```

### 9.3 Update `admin-front/src/content/guide/booksPart2.ts` & `glossaryData.ts` and Run Extractors

1. In `admin-front/src/content/guide/booksPart2.ts`, add Chapter `12.2` (`"Shared Object & Asset Storage Engine (/system/object-storage)"`) to `book-12` explaining the shared mTLS storage node (`OBJECT_STORAGE_NODE`), `pgos1` chunked AES-256-GCM encryption, `storage_object_locks`, AV quarantine, legal holds, and 3-2-1 backup parity drills.

2. In `admin-front/src/content/guide/glossaryData.ts`, add `"MULTI_NODE_SHARED_STORAGE_REQUIRED"` and `"STORAGE_OBJECT_QUARANTINED"` to `ERROR_CODE_GLOSSARY`.

3. Run the deterministic content extractors and verify the content completeness test suite:

```
bun run admin-front/scripts/extract-guide-content.ts
bun run admin-front/scripts/extract-academy-content.ts
bun test admin-front/src/content/__tests__/content-completeness.test.ts



```

### 9.4 Create IT Department Architecture & Operations Runbooks (`docs/`)

Create:

1. `docs/architecture/object-storage-engine.md`: Full technical reference for the IT department covering the control-plane/data-plane split, `pgos1` framing, `OBJECT_STORAGE_NODE` mTLS architecture, and the 4-Step Developer Integration Playbook from Section `7.8`.

2. `docs/runbooks/object-storage-operations-and-dr.md`: Step-by-step IT operational runbooks for provisioning `OBJECT_STORAGE_NODE`, rotating `OBJECT_STORAGE_KEK_KEYRING` zero-downtime via `RewrapWorker`, recovering files from `.trash/YYYY-MM-DD/`, and running disaster recovery from `backup-daemon`.

## 10. Step-by-Step Execution Order for `OpenCode`

Execute the implementation in this exact order so the project compiles and passes tests at every checkpoint:

1. **Step 1 (Schema & Migration):** Update `core-back/prisma/schemaVersion.ts` (`34`), update `core-back/prisma/schema.prisma`, create `core-back/prisma/migrations/20261112000000_v34_enterprise_object_storage_engine/migration.sql`, run `bunx prisma generate`, and update `core-back/test/exhaustive/_dbFactory.ts`.

2. **Step 2 (Object Storage SDK):** Create `core-back/lib/objectStorageSdk/{types.ts,sniff.ts,crypto.ts,blobStore.ts,holderRegistry.ts,index.ts}` and `core-back/engine/workers/ObjectStorageWorkers.ts`.

3. **Step 3 (Dedicated Shared Storage Daemon):** Create `deploy/object-storage-daemon/{package.json,src/config.ts,src/server.ts,src/index.ts}`.

4. **Step 4 (Deploy Engine Integration & Multi-Node Guard):** Update `deploy/deploy.env.example`, `deploy/lib/configSchema.ts`, `deploy/lib/pkiManager.ts`, `deploy/lib/hostPlanner.ts`, `deploy/provisioners/objectStorageProvisioner.ts`, `deploy/deploy.ts`, `deploy/lib/healthVerifier.ts`, and `deploy/test-matrix/topologies.ts`.

5. **Step 5 (Domain Call-Sites, AI Transcripts & Backup Engine):** Migrate `KybDocument`, `ReconciliationRun`, `RegulatoryReportSchema`, `RegulatoryReportOutput`, `ReportAssetBundleEntry`, `Asset` / `Rail.logoAssetId`, `DisputeAttachment`, and `AmlCaseEvidence` call sites in `core-back`, update `transcriptBuilder.ts` and `transcriptGenerator.ts`, and wire `deploy/backup-daemon` parity sync.

6. **Step 6 (Admin API, UI, Docs, Academy & Tests):** Add `core-back/api/internal/objectStorage.ts`, `admin-back/api/protected/objectStorage.ts`, `admin-front/src/pages/system/object-storage/index.tsx`, update the `admin-front` Academy curriculum (`admin-front/src/pages/academy/`), create `docs/architecture/object-storage-engine.md` and `docs/runbooks/object-storage-operations-and-dr.md`, and run `bun test` on `core-back/test/objectStorageEngine.test.ts` and `deploy/test/objectStorageDeploy.test.ts`.