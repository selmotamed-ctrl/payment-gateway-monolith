---
id: core.object-storage
title: Shared Object & Asset Storage Engine
status: implemented
confidence: high
last_verified: 2026-11-12
verified_against: working-tree
code:
  - core-back/lib/objectStorageSdk/**
  - core-back/api/internal/objectStorage.ts
  - core-back/engine/workers/ObjectStorageWorkers.ts
  - core-back/engine/workers/objectStorageMonitorChecks.ts
  - core-back/engine/reportStudio/assetStorage.ts
  - core-back/engine/compliance/reporting/ReportGenerationService.ts
  - deploy/object-storage-daemon/**
  - deploy/provisioners/objectStorageProvisioner.ts
  - deploy/backup-daemon/src/objectStorageBackup.ts
  - admin-back/api/protected/objectStorage.ts
  - admin-front/src/pages/system/object-storage/index.tsx
tests:
  - core-back/test/objectStorageEngine.test.ts
  - deploy/test/objectStorageDeploy.test.ts
  - deploy/object-storage-daemon/test/server.test.ts
design_sources:
  - design/02-storage-and-performance/enterprise_object_and_asset_storage_engine_plan_v6.md
gaps:
  - Backup parity/drill proof runs on the backup daemon and is covered with an in-memory repository; a live two-host parity drill is not automated in this tree.
  - Backup artifacts (`BACKUP_ARTIFACTS`) are a policy namespace but the daemon keeps its own encrypted artifact repository; the namespace is reserved for future core-managed artifacts.
  - SERVER_PDF rendering is still client-side (Paged.js/Chrome); report assets are stored and served but not rendered server-side.
---

# Shared Object & Asset Storage Engine

## 1. Purpose and scope

The engine is the single encrypted storage plane for every uploaded or generated
file in the platform. It replaces asset `bytea`/base64 columns and local-disk
writes with:

- a shared, network-accessible vault (`deploy/object-storage-daemon`) used by
  every `core-back` node and the backup daemon;
- a PostgreSQL control plane (`storage_objects`, `storage_object_locks`,
  `storage_object_access_logs`) with append-only/guard triggers;
- a host-agnostic SDK (`core-back/lib/objectStorageSdk/**`) used by all domain
  call sites.

The engine does not own PostgreSQL backups (see `core.backup`) or the API
authority model (`core.api`); it enforces the authority recorded on each object
as defence in depth.

## 2. Database control plane (schema version 36)

Migration `20261112000000_v36_enterprise_object_storage_engine` adds:

| Table | Notes |
| :--- | :--- |
| `storage_objects` | One row per upload. `byte_size > 0`, `chunk_size_bytes >= 4096`, `chunk_count >= 1`; unique `(bucket, storage_key)`. |
| `storage_object_locks` | Append-only lock ledger with unique `(object_id, holder_type, holder_id)`. |
| `storage_object_access_logs` | Allowed and denied read attempts. |
| `report_asset_bundle_entries` | Per-file entries of Report Studio bundle archives. |
| `dispute_attachments`, `aml_case_evidence` | Evidence links (FKs to disputes/merchants/AML cases). |

Domain links: `kyb_documents.storage_object_id`,
`reconciliation_runs.storage_object_id` (replaces `file_content`),
`regulatory_report_schemas.template_object_id`,
`regulatory_report_outputs.storage_object_id`,
`report_asset_bundles.storage_object_id`,
`merchant_report_asset_bundles.storage_object_id`, `assets.storage_object_id`.

All new FKs are `ON DELETE RESTRICT ON UPDATE CASCADE`; timestamps are
`TIMESTAMPTZ(3)` to match the repo convention.

### Guard triggers (no GUC backdoors)

`storage_objects_guard_trg` forbids `DELETE` (`STORAGE_OBJECT_DELETE_FORBIDDEN`,
23503), mutating cryptographic identity (`STORAGE_OBJECT_IMMUTABLE_FIELD`,
23514), shortening `retain_until` (`STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN`,
23514), and `PURGED`/`QUARANTINE_REJECTED` while a legal hold is active, an
active lock exists, or (for `PURGED`) `retain_until` is in the future
(`STORAGE_OBJECT_LEGAL_HOLD_ACTIVE`, `STORAGE_OBJECT_LOCKED`,
`STORAGE_OBJECT_RETENTION_ACTIVE`).

`storage_object_locks_guard_trg` forbids `DELETE` and mutation of
`id/object_id/holder_type/holder_id`; lock release is an `UPDATE` of
`released_at`.

## 3. Data plane: `pgos1`

One object is one immutable file:
`{namespace}/{tenant-or-shared}/{yyyy}/{mm}/{objectId}.v1.enc`.

```
"pgos1" | frame 0 | ... | final frame
frame = uint32be(plaintextLength) | AES-256-GCM ciphertext | 16-byte tag
```

- Per-object random 32-byte DEK wrapped by a KEK with
  `AAD = "dek:{objectId}:v{version}"`.
- Chunk nonce `streamNoncePrefix(7) | uint32be(index) | finalFlag`;
  chunk AAD `objectId(16) | uint32be(index) | finalFlag`.
- Tampering, truncation, reordering, cross-object swaps, size/count/SHA-256
  mismatches and missing blobs raise `STORAGE_INTEGRITY_CORRUPTED`.
- Default chunk size 64 KiB; the reader caps a frame at 16 MiB.

## 4. Lifecycle and policies

`NAMESPACE_POLICIES` in `types.ts` defines bucket, MIME allow-list, max size,
async AV, default retention, required authority and confidentiality tier for
KYB, reconciliation, regulatory, Report Studio, merchant statements, dispute,
AML, brand assets and backup artifacts.

`stageUpload` (no DB transaction) inserts `STAGING`, encrypts and writes to the
`BlobStore`. `bind` (inside a caller transaction) upserts the lock and either
promotes immediately or moves to `QUARANTINE_PENDING_AV`. Promotion stamps
`retain_until` as the maximum of the policy retention, the existing retention
and every lock's `retention_floor_until`. Releasing the last lock stamps
`gc_eligible_at = GREATEST(retain_until, NOW() + grace)`. `runGcBatch` moves
eligible blobs to `.trash/YYYY-MM-DD/` and marks them `PURGED`; trash is purged
after `OBJECT_STORAGE_TRASH_RETENTION_DAYS`.

SVG uploads are sanitised (script/event handlers/foreignObject/javascript/data
HTML/iframes/embedded objects/external hrefs -> `STORAGE_SVG_UNSAFE`).
Executable headers are refused at sniff time.

## 5. SDK

Files: `types.ts`, `sniff.ts`, `crypto.ts`, `blobStore.ts`,
`holderRegistry.ts`, `index.ts`, `runtime.ts`.

`BlobStore` has two drivers: `FsBlobStore` (daemon/local test) and
`RemoteMtlsBlobStore` (all core nodes and the backup daemon). The daemon and
backup-daemon keep byte-identical copies under `src/shared/blobStore.ts`; the
deploy test asserts they match the canonical core file.

`createObjectStorageSdk` exposes:

- `routeClient`: `stageUpload`, `bind`, `promote`, `release`, `discardStaged`,
  `withStagedUpload`, `readAuthorized`, `placeLegalHold`, `liftLegalHold`.
- `workerClient`: `stageSystemGenerated`, `readInternal`, `readForScan`,
  `applyScanVerdict`, `runGcBatch`, `runBlobSweep`,
  `runIntegrityScrubBatch`, `runLockReconcile`, `runRewrapBatch`,
  `exportManifest`.

`readAuthorized` checks ACTIVE status, the holder lock, the merchant tenant and
the object's required authority, and writes a `storage_object_access_logs` row
for every outcome. `createBlobStore` refuses to fall back to local disk in
production or when `CLUSTER_CORE_NODE_COUNT > 1`
(`OBJECT_STORAGE_DAEMON_URL_REQUIRED`).

## 6. Domain call sites

- KYB upload/download and the join-request flow use `KYB_DOCUMENTS`; the
  `KybScanWorker` applies the scanner verdict to both the document and the
  storage object.
- Reconciliation upload stages `RECON_STATEMENTS` before the DB transaction and
  binds `RECON_RUN`; the parse worker reads the vault object.
- Regulatory templates/outputs use `REGULATORY_REPORTS`; output generation
  stages and binds `REG_REPORT_OUTPUT`, replacing/superseding rows releases the
  old lock.
- Report Studio bundles become one `application/zip` `REPORT_STUDIO_ASSETS`
  object; rendering extracts files in memory.
- Catalog assets upload to `SYSTEM_BRAND_ASSETS` with a `CATALOG_ASSET` lock;
  assigning a rail logo adds a `RAIL_LOGO` lock (shared multi-record lock).
- Dispute and AML evidence use `DISPUTE_EVIDENCE`/`AML_CASE_ATTACHMENTS` and
  wait for AV (`QUARANTINE_PENDING_AV`).
- The synthetic seeder stages preview KYB PDFs and reconciliation statements and
  binds them.

## 7. Workers and monitoring

`ObjectStorageMaintenanceWorker` (enabled by `WORKER_OBJECT_STORAGE_ENABLED`,
interval/batch env) runs the generic AV fallback (EICAR + active content, not
KYB), staging/expired GC, integrity scrub, lock reconcile, periodic blob sweep
and KEK rewrap. It is not a cluster singleton; the DB guards make each action
idempotent.

`createObjectStorageMonitorCheck` (`object_storage`) raises keyed findings for
an unreachable vault (P1), scrub errors (P1) and quarantine uploads older than
30 minutes (P2).

## 8. Backup integration

The backup daemon copies new HOT/COLD `.v1.enc` files into
`object-blobs/{bucket}/{storageKey}` in the artifact repository, verifies every
ACTIVE row has its blob (`OBJECT_STORAGE_BACKUP_PARITY_ERROR`), writes the KEK
keyring as an AES-256-GCM escrow (`object-storage/kek-escrow.enc`) under the
backup master key, and samples up to `OBJECT_STORAGE_DRILL_SAMPLE` ACTIVE rows
in the restore drill, decrypting them with the escrowed keyring and comparing
the SHA-256.

## 9. Deploy and operations

- `OBJECT_STORAGE_NODE` is mandatory for >1 core node or a backup host on
  another host; validation fails with `MULTI_NODE_SHARED_STORAGE_REQUIRED`.
- `deploy/provisioners/objectStorageProvisioner.ts` creates the `pgobjstore`
  user, vault directories, environment file and `pg-object-storage-daemon`
  unit; `deployObjectStorageDaemon` syncs and starts the daemon.
- PKI mints `object-storage-daemon.crt` (SANs: storage private IP, 127.0.0.1,
  `object-storage-daemon.internal`) and `object-storage-client.crt`.
- Firewall opens 4095 only to core and backup private IPs.
- Health probes run `systemctl is-active` on the storage host and
  `/v1/health` over mTLS from every core host and the backup host.
- Admin API: `GET /object-storage/summary`, list/detail objects, access logs,
  POST/DELETE legal holds, POST maintenance jobs. The admin portal route
  `/system/object-storage` renders the four tabs.

## 10. Tests

`core-back/test/objectStorageEngine.test.ts` covers T01–T20 end to end against
live PostgreSQL (round-trip, chunk tamper/truncation/reorder, cross-object swap,
rollback cleanup, trigger guards, multi-holder ref counting, retention, legal
hold, quarantine/no-retention, infected verdict, SVG/executable rejection,
tenant/authority denial logs, KEK rewrap, GC/trash, lock reconciler, two-node
shared daemon) plus DB-free envelope/sniff tests.

`deploy/test/objectStorageDeploy.test.ts` covers T21 (topology derivation, core
env, PKI, firewall, multi-node guard/provisioner refusal, shared-copy drift) and
T22 (incremental blob sync, parity failure, KEK escrow and drill decryption).
`deploy/object-storage-daemon/test/server.test.ts` covers the daemon HTTP
surface and path-traversal refusal.

## 11. Status and deviations

Implemented end to end. Deviations recorded:

- Regulatory schema templates and outputs keep their nullable legacy encrypted
  text columns as a fallback for rows created before v36; new writes use the
  shared vault and all readers prefer `storageObjectId`/`templateObjectId`.
- Report Studio bundles are stored as one encrypted ZIP object rather than one
  row per file; `report_asset_bundle_entries` and the `REPORT_ASSET_ENTRY`
  holder type are available for future per-file extraction.
- Backup artifacts are not yet uploaded through the core SDK; the backup daemon
  keeps its own established encrypted artifact repository.
