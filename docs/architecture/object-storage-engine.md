# Shared Object & Asset Storage Engine

## 1. What it is

Every uploaded or generated file (KYB documents, reconciliation statements,
regulatory report outputs and templates, Report Studio asset bundles, merchant
statements, dispute evidence, AML case attachments, rail logos and backup
artifacts) is stored in one encrypted, shared vault. PostgreSQL keeps only the
small control plane; the bytes never live in a table column and never on an
individual core node's disk.

The engine has two levels:

1. **Network-shared across nodes.** A dedicated host runs
   `deploy/object-storage-daemon` (`pg-object-storage-daemon`) on port 4095.
   Every `core-back` node and the backup daemon talk to it over mTLS. When more
   than one core node exists, or the backup daemon is on another host,
   `OBJECT_STORAGE_NODE` is mandatory and the deploy refuses to run without it
   (`MULTI_NODE_SHARED_STORAGE_REQUIRED`).
2. **Record-shared inside the control plane.** One `storage_objects` row can be
   held by several business records through `storage_object_locks`
   (`UNIQUE (object_id, holder_type, holder_id)`). A rail logo, for example,
   can hold a `CATALOG_ASSET` lock and several `RAIL_LOGO` locks at once.

## 2. Control plane (schema v36)

| Table | Purpose |
| :--- | :--- |
| `storage_objects` | One row per upload: namespace, storage key, status, SHA-256, size/chunk geometry, wrapped DEK, DEK nonce, stream nonce prefix, owner merchant, uploading actor, required authority, confidentiality tier, retention, legal hold, GC eligibility, AV verdict, scrub state, staging/activation/purge timestamps. |
| `storage_object_locks` | Append-only lock ledger. `released_at IS NULL` is an active lock. `retention_floor_until` can extend the object's retention. |
| `storage_object_access_logs` | Every allowed or denied read with actor, holder, IP, request id, bytes served and denial reason. |
| `report_asset_bundle_entries` | Per-file entries of a Report Studio bundle archive. |
| `dispute_attachments`, `aml_case_evidence` | Domain links that own dispute/AML evidence objects. |

Domain links: `kyb_documents.storage_object_id`,
`reconciliation_runs.storage_object_id`, `regulatory_report_schemas.template_object_id`,
`regulatory_report_outputs.storage_object_id`, `report_asset_bundles.storage_object_id`,
`merchant_report_asset_bundles.storage_object_id`, `assets.storage_object_id`.

### Guard triggers

`storage_objects_guard_trg` (BEFORE UPDATE OR DELETE):

- forbids `DELETE` (`STORAGE_OBJECT_DELETE_FORBIDDEN`, SQLSTATE 23503);
- forbids mutating the cryptographic identity (`id`, `namespace`, `storage_key`,
  `sha256_hex`, `byte_size`, `chunk_size_bytes`, `chunk_count`,
  `stream_nonce_prefix`) (`STORAGE_OBJECT_IMMUTABLE_FIELD`, 23514);
- forbids shortening `retain_until` (`STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN`, 23514);
- refuses `PURGED`/`QUARANTINE_REJECTED` while a legal hold is active, while any
  lock is unreleased, or (for `PURGED`) before `retain_until`.

`storage_object_locks_guard_trg` makes the lock ledger append-only: `DELETE` is
refused and the identity columns (`id`, `object_id`, `holder_type`, `holder_id`)
cannot change. Release a lock by setting `released_at`.

Neither trigger reads a session GUC, so an application bug cannot bypass them.

## 3. Data plane: `pgos1`

Each object is one file: `{namespace}/{tenant-or-shared}/{yyyy}/{mm}/{objectId}.v1.enc`.
The layout is:

```
"pgos1" | frame 0 | frame 1 | ... | final frame

frame = uint32be(plaintextLength) | AES-256-GCM ciphertext | 16-byte tag
```

- A fresh 32-byte Data Encryption Key (DEK) is generated per object; it is
  wrapped by the Key Encryption Key (KEK) with
  `AAD = "dek:{objectId}:v{keyVersion}"`.
- Each chunk uses
  `nonce = streamNoncePrefix(7) | uint32be(chunkIndex) | finalFlag(1)` and
  `AAD = objectId(16 bytes) | uint32be(chunkIndex) | finalFlag`.
- The final frame is marked in both the nonce and the AAD, so truncation,
  reordering, cross-object blob swaps and bit flips all fail authentication.
- Decryption verifies the chunk count, plaintext size and plaintext SHA-256.

Default chunk size is 64 KiB. The parser caps a frame at 16 MiB.

## 4. Lifecycle

1. **Stage (outside every caller transaction).** `stageUpload` inserts a
   `STAGING` row, encrypts the bytes and writes the ciphertext to the blob
   store. `retain_until` is NULL at this point, so a rolled-back or malicious
   upload never receives a compliance retention lock.
2. **Bind (pure SQL, inside the caller transaction).** `bind` upserts the lock,
   then:
   - promotes immediately when the namespace does not require AV, or
   - moves the object to `QUARANTINE_PENDING_AV` and waits for the scanner.
   Promotion stamps `retain_until = NOW() + policy.defaultRetentionDays`,
   never shorter than an existing retention or a lock's `retention_floor_until`.
3. **Release.** Releasing the last active lock stamps
   `gc_eligible_at = GREATEST(retain_until, NOW() + GC grace)`.
4. **GC.** After `gc_eligible_at`, `GcWorker` moves the file to
   `.trash/YYYY-MM-DD/` and marks the row `PURGED`. Trash is purged after
   `OBJECT_STORAGE_TRASH_RETENTION_DAYS` (default 7).
5. **Legal hold** blocks purge regardless of locks and retention until a
   compliance/security admin lifts it with a recorded reason.
6. **KEK rotation.** Add `v2` to `OBJECT_STORAGE_KEK_KEYRING`, set
   `OBJECT_STORAGE_ACTIVE_KEK_VERSION=2`, deploy, and run **KEK Rewrap**. Only
   the wrapped DEK in the database changes; `.v1.enc` files are never
   rewritten.

## 5. Namespace policies

Each namespace fixes the bucket, allowed MIME types, maximum size, whether AV
is required, default retention, the authority required to read, and the
confidentiality tier. The authoritative table is
`core-back/lib/objectStorageSdk/types.ts` (`NAMESPACE_POLICIES`). Highlights:

| Namespace | Max | AV | Retention |
| :--- | ---: | :--- | ---: |
| `KYB_DOCUMENTS` | 25 MiB | async | 7 years |
| `RECON_STATEMENTS` | 100 MiB | no | 7 years |
| `REGULATORY_REPORTS` | 100 MiB | no | 10 years |
| `REPORT_STUDIO_ASSETS` | 10 MiB | no | 5 years |
| `MERCHANT_STATEMENTS` | 50 MiB | no | 7 years |
| `DISPUTE_EVIDENCE` | 25 MiB | async | 7 years |
| `AML_CASE_ATTACHMENTS` | 50 MiB | async | 10 years |
| `SYSTEM_BRAND_ASSETS` | 5 MiB | no | 1 year |
| `BACKUP_ARTIFACTS` | 1 GiB | no | 90 days |

SVG uploads are rejected when they contain `<script>`, event handler
attributes, `<foreignObject>`, `javascript:`, HTML data URLs, embedded frames,
or external `href`/`xlink:href` references (`STORAGE_SVG_UNSAFE`).
Executable headers (ELF, PE/MZ, Mach-O) are refused at staging
(`STORAGE_MIME_FORBIDDEN`).

## 6. Upload/download call sites

Use only the SDK operations:

- **Upload and bind** (route):
  `objectStorage.routeClient.withStagedUpload(input, async (staged) => prisma.$transaction(async (tx) => { ...; await objectStorage.routeClient.bind(tx, {...}) }))`.
  Network/disk I/O happens before/outside the transaction by construction.
- **Share an object across records:** inside a transaction call `bind` again
  with the second holder type/id. Each holder gets an independent lock.
- **Read (user/admin):** `routeClient.readAuthorized({ objectId, actor, holderContext })`.
  The SDK enforces ACTIVE status, the holder lock, the merchant tenant match
  and the object's required authority.
- **Read (background worker):** `workerClient.readInternal(objectId, workerName)`.
- **Delete/unlink:** delete the domain row, then `release` inside the same
  transaction. Releasing the last lock starts the GC grace window.

### 4-step playbook for a new asset-backed feature

1. Add `storageObjectId` to the Prisma model with
   `storageObject StorageObject @relation(..., onDelete: Restrict)`.
2. Register a holder type in `StorageHolderType`, and either use an existing
   namespace or add one with a policy.
3. Add the holder existence query to `checkHoldersExistInDb` (the exhaustive
   switch fails compilation without it). The lock reconciler uses it daily.
4. Use only the four SDK operations above. Never add a `Bytes` column, never
   write an authoritative file to local disk.

## 7. Backup and disaster recovery

The backup daemon:

- copies new HOT/COLD `.v1.enc` blobs into the artifact repository under
  `object-blobs/{bucket}/{storageKey}` (immutable → incremental);
- fails the run with `OBJECT_STORAGE_BACKUP_PARITY_ERROR` when any ACTIVE row
  has no blob in the repository;
- escrows the KEK keyring at `object-storage/kek-escrow.enc` encrypted under
  the backup master key;
- samples up to `OBJECT_STORAGE_DRILL_SAMPLE` ACTIVE rows during every restore
  drill, reads their blobs from the backup repository, unwraps the escrowed
  KEK, decrypts `pgos1`, and compares the SHA-256 with the restored row.

`OBJECT_STORAGE_PARITY_AND_SCRUB_HEALTH` (Platform Monitor) raises keyed cases
for an unreachable vault, non-zero scrub errors and uploads stuck in
`QUARANTINE_PENDING_AV` for more than 30 minutes.

## 8. Environment

| Key | Meaning |
| :--- | :--- |
| `OBJECT_STORAGE_DAEMON_URL` | `https://<object-node>:4095`. Required in production or multi-node mode; core refuses to boot without it. |
| `OBJECT_STORAGE_TLS_CA_PATH` / `_CLIENT_CERT_PATH` / `_CLIENT_KEY_PATH` | mTLS material. |
| `OBJECT_STORAGE_KEK_KEYRING` | `v1:<64 hex>[,v2:<64 hex>]` AES-256 KEKs. |
| `OBJECT_STORAGE_ACTIVE_KEK_VERSION` | Version used for new DEK wraps. |
| `OBJECT_STORAGE_ROOT_DIR` | Vault root (`{hot,cold,quarantine,tmp,.trash}`). |
| `OBJECT_STORAGE_TRASH_RETENTION_DAYS` | Soft-trash recovery window. |
| `OBJECT_STORAGE_GC_GRACE_HOURS` | Grace after the last lock release. |
| `CLUSTER_CORE_NODE_COUNT` | Enforces the shared-storage guard. |
| `WORKER_OBJECT_STORAGE_*` | Maintenance worker enable/interval/batch. |
