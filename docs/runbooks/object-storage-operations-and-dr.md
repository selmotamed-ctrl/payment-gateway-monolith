# Object & Asset Storage — Operations and Disaster Recovery Runbook

Audience: IT operations, security administration, compliance.

## 1. Provision the shared storage node

1. Pick a dedicated host (`obj-1`) and add to `deploy/deploy.env`:

   ```dotenv
   OBJECT_STORAGE_ENABLED="true"
   OBJECT_STORAGE_MANAGE_VIA_SSH="true"
   OBJECT_STORAGE_NODE="obj-1@10.10.14.10:22:10.10.14.10:4095"
   OBJECT_STORAGE_SSH_USER="ubuntu"
   OBJECT_STORAGE_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_obj_storage"
   OBJECT_STORAGE_ROOT_DIR="/var/lib/pg-object-storage/vault"
   OBJECT_STORAGE_KEK_KEYRING="v1:<output of: openssl rand -hex 32>"
   OBJECT_STORAGE_ACTIVE_KEK_VERSION="1"
   ```

2. Run `./deploy/deploy.sh --update --only=object-storage`. The engine:
   - creates the `pgobjstore` service user and the vault directories;
   - mints `object-storage-daemon` and `object-storage-client` certificates;
   - installs `/opt/pg-object-storage-daemon`, the environment file and the
     `pg-object-storage-daemon` unit;
   - opens 4095 only to core and backup private IPs;
   - injects `OBJECT_STORAGE_DAEMON_URL` and the client certificate into all
     core nodes and the backup daemon.
3. Verify from a core host:

   ```bash
   curl -fsS --cacert /var/www/pg-core/shared/certs/internal-ca.crt \
     --cert /var/www/pg-core/shared/certs/object-storage-client.crt \
     --key /var/www/pg-core/shared/certs/object-storage-client.key \
     https://10.10.14.10:4095/v1/health
   ```

   Expect `{"ok":true,...}`. The deploy's health step also probes this from
   every core host and the backup host.

**Multi-node rule:** two or more `CORE_NODES`, or a `BACKUP_NODE` on another
host, without `OBJECT_STORAGE_NODE` fail validation with
`MULTI_NODE_SHARED_STORAGE_REQUIRED`. Never store files on a core node's disk.

## 2. Daily checks

- Admin portal → **System → Object & Asset Storage**.
- Health tab: vault mode, free space, KEK version, scrub errors, active locks.
- Quarantine tab: uploads waiting for AV older than 30 minutes raise a P2 case
  (`quarantine-stuck`). Check `WORKER_KYB_SCAN_*` and the ClamAV daemon.
- Access audit tab: denied reads (`READ_DENIED_TENANT_MISMATCH`,
  `READ_DENIED_AUTHORITY`, `READ_DENIED_QUARANTINE`) show a misconfigured
  authority or a cross-tenant attempt.

## 3. Legal hold

1. Find the object in **Object explorer** (search by storage key, file name or
   id) and open **Inspect**. Confirm the active locks and the holder records.
2. **Place legal hold**, with the case reference / court order / regulatory
   request id in the reason. A legal hold blocks GC and any transition to
   `PURGED` regardless of locks or retention.
3. To release, **Lift legal hold** with the closing reference. Normal retention
   and lock rules then apply again.

## 4. KEK rotation (zero downtime, no blob rewrite)

1. Generate a new key: `openssl rand -hex 32`.
2. Update the deploy environment (keep the old version):

   ```dotenv
   OBJECT_STORAGE_KEK_KEYRING="v1:<old>,v2:<new>"
   OBJECT_STORAGE_ACTIVE_KEK_VERSION="2"
   ```

3. Deploy the core nodes (`--update --only=core`). New uploads immediately use
   `v2`; existing objects still unwrap with `v1`.
4. In **Object & Asset Storage → Health**, run **KEK Rewrap** (or wait for the
   maintenance worker). It unwraps each DEK with its recorded version and
   rewraps it with `v2`; `.v1.enc` files are unchanged.
5. Verify the summary shows `Active KEK version = 2` and that the KEK rotation
   index has no remaining old rows. Only then may `v1` be removed from the
   keyring on a later deploy.

**Never remove a key version that still has objects.**

## 5. Restore a file from soft trash

`GcWorker` moves a purged object's ciphertext to
`OBJECT_STORAGE_ROOT_DIR/.trash/YYYY-MM-DD/{bucket}/{storageKey}`.

1. Locate the file (the StorageObject detail page shows the storage key; the
   purge date is the `.trash` folder).
2. Copy it back to the matching `{bucket}/{storageKey}` path.
3. Restore the database row/status from a backup. The blob is useless without
   the matching `storage_objects` row (DEK envelope and SHA-256).
4. If the trash folder is older than `OBJECT_STORAGE_TRASH_RETENTION_DAYS`, it
   has already been hard-deleted: recover from the backup daemon instead.

## 6. Disaster recovery

1. Restore PostgreSQL with the backup daemon's normal procedure (full +
   WAL/point-in-time).
2. Restore the object store from the same backup run:
   - the repository contains `object-blobs/{HOT|COLD}/{storageKey}` and
     `object-storage/kek-escrow.enc`;
   - copy `object-blobs/*` back to the vault (or restore the whole vault disk
     from the backup host);
   - the escrowed keyring decrypts the blobs when the production keyring is
     unavailable; treat it as a secret.
3. Run a restore drill; the report must include the `objectStorage` check
   (`decrypted and verified N/N sampled object(s)`).
4. Start the daemon and probe `/v1/health` from a core node.
5. If a shard/object is missing, the parity check
   (`OBJECT_STORAGE_BACKUP_PARITY_ERROR`) identifies the affected object ids;
   restore those blobs from the repository before reopening uploads.

## 7. Maintenance jobs

| Job | What it does | Safe on every node? |
| :--- | :--- | :--- |
| `gc` | Purges staging/expired/rejected objects, moves blobs to `.trash`. | Yes (row guards). |
| `sweep` | Moves orphan vault files (no row) to `.trash`, purges old trash. | Yes. |
| `scrub` | Decrypts ACTIVE objects, verifies SHA-256, increments scrub errors. | Yes. |
| `reconcile-locks` | Releases locks whose domain holder row no longer exists. | Yes. |
| `rewrap` | Rewraps DEKs to the active KEK version. | Yes. |
| `av-scan` | Generic EICAR/active-content scan of non-KYB quarantine uploads. | Yes. |

Jobs are available to `system:storage:admin` in the portal and via
`POST /api/v1/admin/object-storage/maintenance/<job>`.

## 8. Incident: vault unreachable

Symptoms: uploads/downloads fail; Platform Monitor opens `object-storage/health`
(P1); `/health` probing fails.

1. `systemctl status pg-object-storage-daemon` on the object host;
   `journalctl -u pg-object-storage-daemon -n 100`.
2. Check disk full (`df -h`, the health payload's `freeBytes`).
3. Check the mTLS certificate expiry (`deploy/deploy.sh --check-certs`) and the
   client CN allow-list (`OBJECT_STORAGE_ALLOWED_CLIENT_CNS`).
4. Do not delete `.trash` or vault files to free space without a backup; run
   `sweep` (it only removes orphan files and old trash).
5. If the host is lost, follow section 6 and point
   `OBJECT_STORAGE_DAEMON_URL` at the recovered host.
