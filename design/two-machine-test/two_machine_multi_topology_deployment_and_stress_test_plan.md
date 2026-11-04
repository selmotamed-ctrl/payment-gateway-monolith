# EXHAUSTIVE TWO-MACHINE MULTI-TOPOLOGY DEPLOYMENT, REPLICATION, SHARDING, BACKUP & CHAOS STRESS TEST PLAN FOR OPENCODE (`DeepSeek V4.1 Flash Max`)

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`  
**Physical Testbed Hardware:**  
- **`HOST_A` (Local Development & Orchestrator Machine):** Runs OpenCode, `deploy/deploy.ts`, local compute/storage instances, and the stress/chaos test runner. Auto-discovers its LAN IP (`HOST_A_LAN_IP`) on the `10.209.250.0/24` subnet.  
- **`HOST_B` (Remote LAN Server):** `salem@10.209.250.205` · SSH Port `22` · SSH & Sudo Password: `1234`  
**Target Objective:** Deploy, stress-test, chaos-test, and self-heal **8 complete production topology permutations** across `HOST_A` and `HOST_B`—covering single-machine multi-node, cross-machine multi-node, co-located vs. separated DB & Redis, 0/1/2 Postgres 18 Streaming Replicas + 16/32-way Sub-Account Ledger Sharding, co-located vs. isolated `pg_audit_db` & `pg_logs_db`, and both `wal-g` (same-host) and `barman` (cross-host) Backup Engines with live PITR restore drills.

## 1. Architectural Investigation: Critical Nuances & Missing Pieces You Must Account For

Before running multi-node and multi-topology tests across `HOST_A` and `HOST_B`, an investigation of the platform architecture reveals **7 critical technical requirements** that would otherwise cause false failures or port collisions when deploying multiple nodes on the same or separate machines:

### 1.1 Multi-Instance Per-Host Isolation (Running Multiple Nodes of the Same Service on One Machine)
When deploying multiple nodes of `core-back`, `checkout-back`, `merchant-back`, or `admin-back` on the **same machine** (e.g., `core-1` and `core-2` both on `HOST_A`, or `chk-1` and `chk-2` both on `HOST_B`):
- **Unique PM2 Process Names:** PM2 process names MUST be suffixed with `nodeId` (`pg-core-back-core-1`, `pg-core-back-core-2`, `pg-checkout-back-chk-1`, `pg-checkout-back-chk-2`). Otherwise, the second node overwrites the first node in PM2!
- **Per-Node Port & Env Isolation:** Each node on the same machine MUST receive its own `.env.${nodeId}` file binding its unique `PORT` (`4000`, `4001`, `4002` for `core-back`; `4103`, `4113`, `4123` for `checkout-back`; `4102`, `4112` for `merchant-back`; `4101`, `4111` for `admin-back`).
- **Nginx Multi-Upstream Load Balancing Across Local AND Remote Nodes:** Nginx on `HOST_A` and `HOST_B` must dynamically generate `upstream` blocks listing **all** active edge ports (both local `127.0.0.1:<port>` and remote `10.209.250.205:<port>`) with `least_conn;` and `max_fails=2 fail_timeout=3s;`.

### 1.2 Multi-Cluster PostgreSQL 18 Isolation on Debian/Ubuntu (`pg_createcluster`)
When testing multiple PostgreSQL roles on the same machine (such as `PG_PRIMARY` on `:5432`, a local `PG_REPLICA` on `:5433`, `pg_audit_db` on `:5434`, and `pg_logs_db` on `:5435`):
- Use Debian/Ubuntu's native `pg_createcluster 18 <cluster_name> -p <port>` so each cluster has its own independent data directory (`/var/lib/postgresql/18/<cluster_name>`), WAL directory, `postgresql.conf`, `pg_hba.conf`, and `systemd` unit (`postgresql@18-<cluster_name>.service`).
- This allows testing **true physical process isolation and independent crash/restart/backup lifecycles** even when two database roles are co-located on the same physical host!

### 1.3 Including `fake-rails-back` & `fake-rails-front` + Synthetic Seeder in Every Topology
You cannot stress-test real payment state machines (`OTP_PULL`, `REDIRECT`, `LIGHTBOX`, `QR_DISPLAY`, `PUSH_APPROVAL`, asynchronous webhooks, `UNKNOWN` inquiries, refunds, and statement reconciliation) without the **Standalone Fake Payment Rails Service (`fake-rails-back` `:4400` + `fake-rails-front` `:8444`)**:
- In every topology, `deploy.ts` must deploy `fake-rails-back` (with `FAKE_RAILS_ALLOW_IN_PRODUCTION="true"` and `FAKE_RAILS_ALLOWED_HOSTS` including both `HOST_A_LAN_IP` and `10.209.250.205`) so all `core-back` nodes on both machines can execute outbound rail steps against it, and `fake-rails-back` can fire signed webhook callbacks into the load-balanced `checkout-back` nodes!

### 1.4 Multi-Node Concurrent Worker Safety & `pg_audit_db` Linear Hash-Chain Locking
When 2 to 4 `core-back` nodes run simultaneously across `HOST_A` and `HOST_B`:
- **All 10 background workers run concurrently on every `core-back` node.**
- For `AuditShipperWorker`, if `core-1` (`HOST_A`) and `core-2` (`HOST_B`) both read the last `row_hash` from `pg_audit_db` in Node.js and insert concurrently, they will create a **forked hash chain**!
- **Mandatory Architectural Fix:** Compute `prev_hash` and `row_hash` inside a **PostgreSQL `BEFORE INSERT` trigger on `pg_audit_db.audit_records`** protected by `PERFORM pg_advisory_xact_lock(994001);` so even 10 concurrent `core-back` nodes shipping audit batches produce a **100% strictly linear, unbreakable SHA-256 hash chain**!

```sql
-- Mandatory Multi-Node Safe Hash-Chain Trigger on pg_audit_db
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION compute_audit_chain_hash_trg() RETURNS trigger AS $$
DECLARE
  v_prev_hash CHAR(64);
  v_canonical TEXT;
BEGIN
  -- Serialize hash-chain linking across all concurrent core-back shippers
  PERFORM pg_advisory_xact_lock(994001);

  SELECT row_hash INTO v_prev_hash
  FROM audit_records
  ORDER BY seq_no DESC
  LIMIT 1;

  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);
  END IF;

  NEW.prev_hash := v_prev_hash;
  v_canonical := concat_ws(
    '|',
    NEW.prev_hash,
    NEW.id::text,
    to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    NEW.actor_id::text,
    NEW.action,
    NEW.entity_type,
    NEW.entity_id,
    NEW.before_json::text,
    NEW.after_json::text
  );
  NEW.row_hash := encode(digest(v_canonical, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_chain_compute ON audit_records;
CREATE TRIGGER trg_audit_chain_compute
  BEFORE INSERT ON audit_records
  FOR EACH ROW EXECUTE FUNCTION compute_audit_chain_hash_trg();
```

### 1.5 Cross-Node SSE & POS Screen Event Bridging via Redis Pub/Sub
When `checkout-back` or `merchant-back` scales to multiple nodes across `HOST_A` and `HOST_B`:
- A customer's browser may open `GET /api/v1/pay/:linkKey/stream` (SSE) on `chk-1` (`HOST_A`), while the webhook or confirm request lands on `chk-2` (`HOST_B`) -> `core-2` (`HOST_B`).
- Every `core-back` node MUST publish `attempt.transitioned` and `pos.screen_updated` events to **Redis Pub/Sub (`pg:events:realtime`)**, and every `core-back` SSE stream subscriber listens to Redis Pub/Sub so SSE updates arrive in `< 10ms` regardless of which node processed the payment!

### 1.6 Local S3-Compatible Object Storage (`MinIO`) + SSH Vault for Backup Testing
To test `wal-g` and `barman` S3 bucket archiving AND secondary SSH vault replication on the 2-machine LAN without requiring external AWS credentials:
- Provision a local **MinIO S3-compatible server (`:9000`)** on `HOST_B` (or `HOST_A`) with bucket `s3://pg-backups-test` (`AWS_ENDPOINT=http://<HOST_IP>:9000`, `AWS_S3_FORCE_PATH_STYLE=true`) alongside a secondary SSH/rsync vault directory on the opposite machine (`/var/backups/pg-secondary-vault`).
- This exercises 100% of the real S3 multipart upload, `zstd` compression, AES-256-GCM encryption, and PITR restore pipelines over the real LAN!

## 2. Automated Pre-Flight & SSH Key Bootstrap Between `HOST_A` and `HOST_B` (`salem@10.209.250.205`)

Before running the 8 topology matrices, OpenCode must execute `deploy/test-matrix/bootstrapTwoMachineLab.ts` to prepare both machines automatically:

```ts
// deploy/test-matrix/bootstrapTwoMachineLab.ts
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export interface LabHostsConfig {
  hostALanIp: string;
  hostASshUser: string;
  hostASudoPass: string;
  hostBLanIp: string;
  hostBSshUser: string;
  hostBSudoPass: string;
  sshKeyPath: string;
}

export function discoverHostALanIp(targetIp = '10.209.250.205'): string {
  const out = execSync(`ip -4 route get ${targetIp}`, { encoding: 'utf8' });
  const match = /src\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
  if (!match?.[1]) {
    throw new Error(`Could not determine local LAN IP toward ${targetIp}: ${out}`);
  }
  return match[1];
}

export function bootstrapSshAndLabAccess(): LabHostsConfig {
  const hostALanIp = discoverHostALanIp('10.209.250.205');
  const hostBLanIp = '10.209.250.205';
  const hostBSshUser = 'salem';
  const hostBSudoPass = '1234';
  const hostASshUser = process.env.USER || 'ubuntu';
  const hostASudoPass = process.env.LOCAL_SUDO_PASS || '1234';

  const sshDir = join(process.env.HOME || '/root', '.ssh');
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  const sshKeyPath = join(sshDir, 'id_ed25519_pg_lab_matrix');
  if (!existsSync(sshKeyPath)) {
    execSync(`ssh-keygen -t ed25519 -N "" -f "${sshKeyPath}" -C "pg-lab-matrix"`);
    chmodSync(sshKeyPath, 0o600);
  }

  // Ensure sshpass is installed locally to push the key non-interactively using password "1234"
  try {
    execSync('which sshpass', { stdio: 'ignore' });
  } catch {
    execSync(
      `echo "${hostASudoPass}" | sudo -S apt-get update && echo "${hostASudoPass}" | sudo -S apt-get install -y sshpass`,
      { stdio: 'inherit' }
    );
  }

  // Authorize key on HOST_A (local loopback + HOST_A_LAN_IP)
  execSync(
    `cat "${sshKeyPath}.pub" >> "${join(sshDir, 'authorized_keys')}" && chmod 600 "${join(sshDir, 'authorized_keys')}"`
  );

  // Authorize key on HOST_B (salem@10.209.250.205 with password 1234)
  execSync(
    `sshpass -p "${hostBSudoPass}" ssh-copy-id -i "${sshKeyPath}.pub" -o StrictHostKeyChecking=no ${hostBSshUser}@${hostBLanIp}`,
    { stdio: 'inherit' }
  );

  // Also allow passwordless key SSH from HOST_B <-> HOST_A (needed for Barman & pg_basebackup!)
  execSync(
    `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no ${hostBSshUser}@${hostBLanIp} ` +
      `"mkdir -p ~/.ssh && chmod 700 ~/.ssh && rm -f ~/.ssh/id_ed25519_pg_peer && ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519_pg_peer"`
  );
  const hostBPubKey = execSync(
    `ssh -i "${sshKeyPath}" ${hostBSshUser}@${hostBLanIp} "cat ~/.ssh/id_ed25519_pg_peer.pub"`,
    { encoding: 'utf8' }
  ).trim();
  execSync(`echo "${hostBPubKey}" >> "${join(sshDir, 'authorized_keys')}"`);

  return {
    hostALanIp,
    hostASshUser,
    hostASudoPass,
    hostBLanIp,
    hostBSshUser,
    hostBSudoPass,
    sshKeyPath,
  };
}
```

## 3. The 8 Production Deployment Topology Matrices (`T1` through `T8`)

OpenCode must automatically generate `deploy/test-matrix/configs/deploy.T1.env` through `deploy.T8.env`, deploy each topology from scratch, run the complete Functional + Stress + Chaos Verification Suite (§4), fix any failure encountered, and record the benchmark report before advancing to the next topology:

| Matrix ID | Topology Name | Compute Node Distribution (`HOST_A` vs `HOST_B` `10.209.250.205`) | Database, Replica & Shard Configuration | Redis, Audit DB & Log DB Placement | Backup Engine Mode & Host Placement |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`T1`** | **Single-Host Multi-Node Density & Co-Located Storage** | **`HOST_A`:**<br>• `core-1` (`:4000`), `core-2` (`:4001`)<br>• `chk-1` (`:4103`), `chk-2` (`:4113`)<br>• `merch-1` (`:4102`), `admin-1` (`:4101`)<br>• `fake-rails` (`:4400`) | **`HOST_A`:**<br>• `PG_PRIMARY` (`:5432`)<br>• `PG_REPLICA_1` (`:5433` same host)<br>• `PgBouncer` (`:6432`, `:6433`)<br>• `16` GL Account Shards | **Co-Located with DB (`HOST_A`):**<br>• `Redis` (`:6379`) on same host as DB<br>• `pg_audit_db` (`:5434`)<br>• `pg_logs_db` (`:5435`) | **Mode 1: `wal-g` on Same DB Host (`HOST_A:4090`)** pushing to MinIO S3 (`HOST_B:9000`) + SSH vault on `HOST_B`. |
| **`T2`** | **Compute-on-A / Storage-on-B Split + Cross-Host Barman** | **`HOST_A`:**<br>• `core-1` (`:4000`), `core-2` (`:4001`), `core-3` (`:4002`)<br>• `chk-1` (`:4103`), `chk-2` (`:4113`)<br>• `merch-1` (`:4102`), `merch-2` (`:4112`)<br>• `admin-1` (`:4101`), `fake-rails` (`:4400`) | **`HOST_B` (`10.209.250.205`):**<br>• `PG_PRIMARY` (`:5432`)<br>• `0` Replicas (Primary-only read routing verification)<br>• `PgBouncer` (`:6432`)<br>• `16` GL Account Shards | **Co-Located with DB (`HOST_B`):**<br>• `Redis` (`:6379`) on `HOST_B`<br>• `pg_audit_db` (`:5434`) on `HOST_B`<br>• `pg_logs_db` (`:5435`) on `HOST_B` | **Mode 2: `barman` on Separate Host (`HOST_A:4090`)** pulling streaming WAL & base backups over LAN from `HOST_B:5432` + running scratch PITR drill on `HOST_A:55432`! |
| **`T3`** | **DB & Redis Separated + Cross-Host Streaming Replica + `wal-g`** | **Split Compute:**<br>• **`HOST_A`:** `core-1` (`:4000`), `chk-1` (`:4103`), `admin-1` (`:4101`)<br>• **`HOST_B`:** `core-2` (`:4000`), `chk-2` (`:4103`), `merch-1` (`:4102`), `fake-rails` (`:4400`) | **Cross-Host Replication:**<br>• `PG_PRIMARY` on **`HOST_A:5432`**<br>• `PG_REPLICA_1` on **`HOST_B:5432`** (LAN streaming)<br>• `PgBouncer` on both hosts<br>• `16` GL Account Shards | **DB & Redis Separated:**<br>• `Redis` on **`HOST_B:6379`** (separate from `PG_PRIMARY` on `HOST_A`!)<br>• `pg_audit_db` on `HOST_B:5434`<br>• `pg_logs_db` on `HOST_B:5435` | **Mode 1: `wal-g` on Same DB Host (`HOST_A:4090`)** pushing to S3 on `HOST_B:9000` + scratch PITR drill on `HOST_A:55432`. |
| **`T4`** | **Reversed DB/Redis Separation + Dual Replicas (1 Local + 1 Remote) + Standby-Offloaded `barman`** | **Split Compute:**<br>• **`HOST_A`:** `core-1` (`:4000`), `core-2` (`:4001`), `merch-1` (`:4102`)<br>• **`HOST_B`:** `core-3` (`:4000`), `chk-1` (`:4103`), `chk-2` (`:4113`), `admin-1` (`:4101`) | **Dual-Replica Topology:**<br>• `PG_PRIMARY` on **`HOST_B:5432`**<br>• `PG_REPLICA_1` on **`HOST_B:5433`** (local replica)<br>• `PG_REPLICA_2` on **`HOST_A:5432`** (remote LAN replica)<br>• `32` GL Account Shards | **DB & Redis Separated (Reversed):**<br>• `Redis` on **`HOST_A:6379`** (separate from `PG_PRIMARY` on `HOST_B`!)<br>• `pg_audit_db` on `HOST_A:5434`<br>• `pg_logs_db` on `HOST_A:5435` | **Mode 2: `barman` on Separate Host (`HOST_A:4090`)** pulling base backup from `PG_REPLICA` (`--standby-mode` zero Primary load!) + streaming WAL from `HOST_B`. |
| **`T5`** | **Production DMZ Edge Isolation (`HOST_B` Public Edge DMZ, `HOST_A` Private Core/Vault)** | **Strict Zone Split:**<br>• **`HOST_A` (Private Zone):** `core-1` (`:4000`), `core-2` (`:4001`), `admin-1` (`:4101` LAN `:8443`)<br>• **`HOST_B` (Public DMZ):** `chk-1` (`:4103`), `chk-2` (`:4113`), `chk-3` (`:4123`), `merch-1` (`:4102`), `merch-2` (`:4112`) | **`HOST_A` (Private Zone):**<br>• `PG_PRIMARY` (`:5432`)<br>• `PG_REPLICA_1` (`:5433`)<br>• `PgBouncer` (`:6432`, `:6433`)<br>• `UFW` blocks `HOST_B` from `:5432/:6432`! | **`HOST_A` (Private Zone):**<br>• `Redis` (`:6379`)<br>• `pg_audit_db` (`:5434`)<br>• `pg_logs_db` (`:5435`)<br>• `UFW` blocks `HOST_B` from all DB/Redis ports! | **Mode 2: `barman` on `HOST_B:4090`** granted explicit UFW rule ONLY for replication user `pg_replicator` + mTLS `:4090` from `HOST_A`. |
| **`T6`** | **Full Symmetric High-Availability Mesh (4 Core, 4 Checkout, 4 Merchant, 2 Admin, 2 Replicas, Redis Replica)** | **Symmetric Across Both Hosts:**<br>• **`HOST_A`:** `core-1`, `core-2`, `chk-1`, `chk-2`, `merch-1`, `merch-2`, `admin-1`<br>• **`HOST_B`:** `core-3`, `core-4`, `chk-3`, `chk-4`, `merch-3`, `merch-4`, `admin-2` | **Full Replicated Core:**<br>• `PG_PRIMARY` (`HOST_A:5432`)<br>• `PG_REPLICA_1` (`HOST_A:5433`)<br>• `PG_REPLICA_2` (`HOST_B:5432`)<br>• `32` GL Account Shards | **Distributed Storage:**<br>• `Redis Primary` (`HOST_B:6379`) + `Redis Replica` (`HOST_A:6380`)<br>• `pg_audit_db` (`HOST_B:5434`)<br>• `pg_logs_db` (`HOST_B:5435`) | **Both Tested Sequentially:**<br>• Run 6A: `wal-g` on `HOST_A:4090`<br>• Run 6B: `barman` on `HOST_B:4090` |
| **`T7`** | **Live Rolling Horizontal Scale-Out & Scale-In Under 500 TPS Load** | Starts `1 × core` + `1 × chk` on `HOST_A` -> live scales to `4 × core` + `4 × chk` across `HOST_A` + `HOST_B` -> live scales down to `2 × core` while traffic runs nonstop! | `PG_PRIMARY` (`HOST_A:5432`) + `PG_REPLICA_1` (`HOST_B:5432`) + dynamically scaled PgBouncer pools | `Redis` (`HOST_B:6379`), `pg_audit_db` (`HOST_B:5434`), `pg_logs_db` (`HOST_B:5435`) | `barman` on `HOST_B:4090` monitoring continuous WAL archiving during live rolling deploys. |
| **`T8`** | **Chaos Engineering, Node Kill, Replica Lag Injection & Full PITR Disaster Recovery** | Symmetric Mesh (`T6`) subjected to live process kills, network blackholes (`iptables`/`tc netem`), and Primary DB destruction + PITR recovery. | Primary + 2 Replicas + simulated 3,000ms lag on Replica 1 + simulated crash on Replica 2 + Primary wipe & PITR restore! | Simulated 15s Redis outage + simulated 15s `pg_logs_db` outage + `pg_audit_db` tamper attack test. | Full **End-to-End PITR Restore** of `PG_PRIMARY` from `wal-g` and `barman` archives after 5,000 live payments! |

## 4. The 11-Gate Per-Topology Verification, Stress & Chaos Suite

For **every single topology (`T1` through `T8`)**, the test runner (`deploy/test-matrix/runAllTopologiesAndHeal.ts`) must execute all **11 Verification Gates** in sequence. If any assertion in any gate fails, OpenCode must immediately enter the **Self-Healing Diagnostic & Fix Loop (§6)** before proceeding.

### Gate 1 — Multi-Host Provisioning, UFW Zero-Trust & SAN mTLS Handshake Gate
1. Verify every configured PM2 process (`pg-core-back-*`, `pg-admin-back-*`, `pg-merchant-back-*`, `pg-checkout-back-*`, `pg-fake-rails-*`, `pg-backup-daemon`) is `online` with `0` unexpected restarts on both `HOST_A` and `HOST_B`.
2. Verify every `admin-back`, `merchant-back`, and `checkout-back` instance can complete an mTLS 1.3 handshake to **every** `core-back` instance across `HOST_A` and `HOST_B` (`GET /health` returns HTTP `200`).
3. **Negative mTLS & UFW Penetration Checks:**
   - Attempt to connect to `core-back:4000` without a client certificate -> MUST fail at TLS handshake.
   - Attempt to call `/internal/admin/*` on `core-back` using `checkout-back-client.crt` -> MUST return HTTP `403 FORBIDDEN_CHANNEL`.
   - In `T5` (DMZ split), attempt a raw TCP connection from `HOST_B` (`10.209.250.205`) to `HOST_A:5432` (Postgres), `HOST_A:6432` (PgBouncer), and `HOST_A:6379` (Redis) -> MUST time out / be rejected by UFW!

### Gate 2 — Storage Driver Engine & LSN-Aware Read-Your-Own-Writes Gate
1. **Replica Routing Check:** Issue 20 list queries (`GET /api/v1/admin/merchants`) and 20 Global Deep Search queries (`POST /api/v1/admin/search`) across `core-back` nodes; verify via response telemetry (`x-pg-served-by`) that in topologies with replicas (`T1`, `T3`, `T4`, `T5`, `T6`, `T7`, `T8`), 100% of read-only list and search queries are served by `pg-rep-1` / `pg-rep-2` (and in `T2` with `0` replicas, 100% fall back cleanly to `primary`).
2. **LSN Read-Your-Own-Writes (RYOW) Check Under Simulated Replication Pause:**
   - On `PG_REPLICA_1`, execute `SELECT pg_wal_replay_pause();` so the replica freezes behind Primary.
   - Create a new Merchant or Payment Link on `core-1` (which returns `commitLsn` in `x-pg-lsn`).
   - Immediately query that record on `core-2` passing `x-pg-min-lsn: <commitLsn>`:
     - Verify `PostgresReplicaReadStore` detects `replica.lastReplayLsn < commitLsn` and **automatically routes the read to Primary** (or a caught-up replica `pg-rep-2` in `T4`/`T6`), returning the newly created record with **zero stale-read 404s**!
   - Execute `SELECT pg_wal_replay_resume();` on `PG_REPLICA_1` and verify it catches up within `< 200ms` and resumes serving reads.

### Gate 3 — Fake Rails & Multi-Year Synthetic Seeder Gate
1. Run the Synthetic Operational Data Seeder (`COMPACT` profile: 15,000 attempts across 3.5 simulated years on `T1`–`T5`, and `STANDARD` profile: 120,000 attempts on `T6`) against the deployed topology.
2. Verify that `fake-rails-back` receives all synchronized transactions (`POST /portal-api/internal/bulk-seed`).
3. Verify `gl_account_shards` sum matches `journal_lines` across all 67 tables and `InvariantVerifier.verifySystemInvariant()` reports exactly **`0.0000 LYD` drift**.

### Gate 4 — High-Concurrency Multi-Node Checkout & Sharded Ledger Stress Gate (`500+ TPS`)
Launch the concurrent load generator (`deploy/test-matrix/stressWorkload.ts`) driving **2,500 concurrent end-to-end payment flows** across all active `checkout-back` and `core-back` nodes simultaneously:
1. **Hot-Link Contention Test (`infiniteUse = true` & Bounded `useCount = 50` Links):**
   - Fire 200 simultaneous `POST /api/v1/pay/:linkKey/initiate` requests against a single `useCount = 50` link distributed across `chk-1..chk-4` (`HOST_A` and `HOST_B`):
     - Assert **exactly 50 attempts succeed** (`active_locked_count = 50`) and **150 receive HTTP `409 LINK_EXHAUSTED`**—zero over-allocations, zero negative slot counts, and zero database deadlocks!
2. **16/32-Way Sub-Account Sharded Ledger Confirmation Burst:**
   - Confirm 1,000 payments concurrently across `Sadad`, `Edfali`, `Moamalat Lightbox`, `LYPay QR`, `T-LYNC`, and `NeomPay` across multiple `core-back` nodes.
   - Assert **zero AB-BA deadlocks** on `gl_account_shards`, **p95 confirm latency `< 35ms`**, and **exact `0.0000 LYD` double-entry trial balance** across all 16/32 shards of `TREASURY`, `PLATFORM_INCOME`, and `GATEWAY_CLEARING`.
3. **Concurrent Webhook + Poll + Browser Confirm Race Test:**
   - For 100 in-flight attempts, simultaneously fire the signed webhook into `checkout-back` on `HOST_B` AND trigger `POST /confirm` on `checkout-back` on `HOST_A` at the exact same millisecond:
     - Assert that **every attempt posts to the ledger once and only once** (`journal_entries` unique `(ref_type, ref_id)` + idempotent state transition), with zero double-credits!

### Gate 5 — Cross-Node SSE Realtime Stream & POS Screen Pairing Gate
1. Open 50 concurrent Checkout SSE streams (`GET /api/v1/pay/:linkKey/stream`) pinned to `checkout-back` on `HOST_A`.
2. Trigger payment confirmations via `fake-rails-back` webhooks landing on `checkout-back` on `HOST_B` -> processed by `core-back` on `HOST_B`.
3. Assert all 50 SSE clients on `HOST_A` receive the terminal `SUCCEEDED` event within **`< 150ms`** via the Redis Pub/Sub bridge without waiting for the fallback poll timer!
4. Repeat for **POS Terminal Screen Pairing** (`merchant-back` on `HOST_A` paired screen receiving instant QR code push when cashier creates a POS link on `merchant-back` on `HOST_B`).

### Gate 6 — Multi-Node Concurrent Background Workers (`FOR UPDATE SKIP LOCKED`) Gate
With 2 to 4 `core-back` nodes running all 10 background workers simultaneously across `HOST_A` and `HOST_B`:
1. Inject 300 expired `AWAITING_CUSTOMER` attempts (`expires_at <= now()`), 400 unprocessed `inbound_events`, 200 due `PollWorker` attempts (`next_check_at <= now()`), and 500 `outbox_events`.
2. Let all `core-back` nodes drain the queues concurrently.
3. Assert:
   - Every expired attempt releases its `payment_links.active_locked_count` slot **exactly once**.
   - Every `inbound_event` is processed **exactly once**.
   - `fake-rails-back` receives **exactly 1** status-check inquiry per due attempt (proving `PollWorker`'s transactional `FOR UPDATE SKIP LOCKED` lease prevents two `core-back` nodes from calling the external gateway twice for the same attempt!).

### Gate 7 — Dedicated `pg_audit_db` Immutability & Multi-Node Linear Hash-Chain Gate
1. Wait for `AuditShipperWorker` across all active `core-back` nodes (`HOST_A` + `HOST_B`) to drain `audit_outbox` into `pg_audit_db.audit_records`.
2. Attempt `UPDATE audit_records SET action = 'HACKED' WHERE seq_no = 1` and `DELETE FROM audit_records WHERE seq_no = 1` using `pg_audit_writer` -> Assert PostgreSQL rejects both with `AUDIT_TAMPER_PROHIBITED` / permission denied.
3. Call `storage.auditStore.verifyHashChainIntegrity(10000)` -> Assert **`valid === true`** across all shipped rows (proving the `pg_advisory_xact_lock(994001)` trigger in `pg_audit_db` serialized concurrent multi-node batches into a single unbroken cryptographic chain!).

### Gate 8 — Dedicated `pg_logs_db` High-Rate Batching & Outage Resilience Gate
1. Verify `attempt_step_logs` and `http_access_logs` from all `core-back` nodes on both machines are present in `pg_logs_db` and queryable via the Admin Transaction Step Log drawer.
2. **Log DB Outage Injection:** Stop the `pg_logs_db` PostgreSQL cluster (`systemctl stop postgresql@18-logs_cluster`) while running 200 checkouts over 10 seconds:
   - Assert **100% of the 200 checkouts succeed** with zero increase in p95 latency (`DedicatedPostgresLogSink` buffers in memory without blocking).
3. Restart `pg_logs_db` and wait 1 second -> Assert all buffered `attempt_step_logs` flush cleanly into `pg_logs_db` with zero lost payment step logs!

### Gate 9 — Uncompromised 20-Group Global Deep Search & Keyset Pagination Under Load Gate
While background write load (50 TPS checkouts) is running on `PG_PRIMARY`:
1. Fire 200 concurrent `POST /api/v1/admin/search` requests across all 20 search groups (testing exact IDs, partial Arabic trade names `"شركة"`, partial English trade names, Libyan phone numbers `091...` / `+21891...`, SHA-256 KYB document hashes, and `audit_log` actions).
2. Assert:
   - **p95 latency `< 25ms`** (served from `PG_REPLICA` `pg_trgm` GIN indexes + `pg_audit_db`),
   - **100% authority redaction** (`SUPPORT` never sees `aml_*` groups or merchant tax/reg matches),
   - Keyset cursor pagination (`?cursor=...`) across 10 pages of `payment_attempts` executes in **`< 8ms` per page** with zero duplicate or skipped rows.

### Gate 10 — Dual-Mode Backup Engine (`wal-g` & `barman`), Admin Control Plane & Scratch PITR Drill Gate
1. **Admin Backup Control Plane Verification:**
   - Call `GET /api/v1/admin/system/backups/overview` -> Verify `walArchiveHealthy === true`, `primaryTargetReachable === true` (MinIO S3), and `secondaryTargetReachable === true` (cross-machine SSH vault).
2. **On-Demand Full + Delta Backup Trigger:**
   - Call `POST /api/v1/admin/system/backups/trigger` (`{ target: 'all', kind: 'full' }`) -> Wait for completion.
   - Insert 200 new confirmed payments (and 200 new audit records), force a WAL switch (`SELECT pg_switch_wal()`), and trigger a `delta` / incremental backup.
3. **Live Scratch-Instance Point-in-Time Recovery (PITR) & Invariant Drill:**
   - Call `POST /api/v1/admin/system/backups/drill` -> Verify `pg-backup-daemon` (`wal-g` in `T1`/`T3`/`T6A`; `barman` in `T2`/`T4`/`T5`/`T6B`/`T7`) spins up the temporary Postgres 18 instance on `:55432`, restores from the bucket/vault, replays WAL through the 200 post-backup payments, runs the 3 mandatory invariant checks (`Debits == Credits == 0.0000 LYD`, `gl_account_shards == journal_lines`, and `pg_audit_db` hash chain intact), and returns **`status: 'PASSED'`**!

### Gate 11 — Chaos Engineering, Node Failover & Full Primary DB Disaster Recovery Gate (`T8`)
1. **`core-back` Mid-Flight Process Kill:** While driving 100 TPS through `checkout-back`, execute `kill -9` on `core-2` (`HOST_B`). Verify `checkout-back`'s `coreInternalClient` detects the dead socket, marks `core-2` unhealthy, retries in-flight idempotent requests on `core-1` / `core-3`, and achieves **`0` failed checkouts**. Restart `core-2` and verify automatic re-join.
2. **Streaming Replica Crash Failover:** Execute `systemctl stop postgresql@18-replica` on `HOST_B` during active Deep Search & list traffic. Verify `PostgresReplicaReadStore` circuit-breaks to the remaining replica or Primary within 1 request with **`0` user-facing 500 errors**.
3. **Redis Crash & Recovery Under Load:** Execute `systemctl stop redis-server` on the Redis host for 10 seconds during checkout load. Verify the Storage Engine's Redis circuit breaker falls back to L1 cache + DB guard checks so **checkouts continue succeeding**, then restart Redis and verify L2 cache & Lua velocity counters resume automatically.
4. **Full Primary Database Wipe & Bare-Metal PITR Recovery:**
   - Record the exact count of `payment_attempts`, `journal_lines`, and every merchant's wallet balance at timestamp `T_CRASH`.
   - Stop `PG_PRIMARY`, move its data directory aside (`mv /var/lib/postgresql/18/main /var/lib/postgresql/18/main.crashed`), and invoke `pg-backup-daemon`'s **Full Primary PITR Restore** from the external archive up to `T_CRASH`.
   - Start `PG_PRIMARY`, verify streaming replicas reconnect, and assert that **100% of committed transactions up to `T_CRASH` are recovered** and `InvariantVerifier` reports **`0.0000 LYD` drift**!

## 5. Executable Topology Matrix Generator & Runner (`deploy/test-matrix/runAllTopologiesAndHeal.ts`)

Create `deploy/test-matrix/generateTopologyConfigs.ts` and `deploy/test-matrix/runAllTopologiesAndHeal.ts` so OpenCode can programmatically generate the exact `deploy.env` files for all 8 topologies using `HOST_A_LAN_IP` and `salem@10.209.250.205` (`1234`), deploy each topology, run all 11 verification gates, and produce a comprehensive report:

```ts
// deploy/test-matrix/generateTopologyConfigs.ts
import type { LabHostsConfig } from './bootstrapTwoMachineLab';

export interface TopologyMatrixSpec {
  id: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
  name: string;
  description: string;
  glShardCount: 16 | 32;
  seedProfile: 'COMPACT' | 'STANDARD';
  backupMode: 'wal-g' | 'barman';
  buildEnv: (lab: LabHostsConfig) => Record<string, string>;
}

export function buildAllTopologySpecs(): TopologyMatrixSpec[] {
  const baseSecrets = (lab: LabHostsConfig) => ({
    DEPLOY_MODE: 'fresh',
    ROLLING_BATCH_SIZE: '1',
    KEEP_RELEASES: '3',
    LAN_ALLOWED_CIDRS: '10.0.0.0/8,192.168.0.0/16,127.0.0.0/8',
    KMS_MASTER_KEY_ID: 'v1',
    KMS_MASTER_KEY_HEX: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    JWT_ADMIN_SECRET: 'a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8',
    JWT_MERCHANT_SECRET: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
    BASE_CURRENCY: 'LYD',
    GATEWAY_TIMEZONE: 'Africa/Tripoli',
    IS_TEST_SERVER: 'true',
    FAKE_RAILS_ENABLED: 'true',
    FAKE_RAILS_ALLOW_IN_PRODUCTION: 'true',
    FAKE_RAILS_ALLOWED_HOSTS: `${lab.hostALanIp},${lab.hostBLanIp},127.0.0.1,localhost`,
    FAKE_RAILS_ADMIN_USER: 'tester',
    FAKE_RAILS_ADMIN_PASS: '1234',
    FAKE_RAILS_SEEDER_TOKEN: 'seeder-secret-token-2026',
    RUN_PRISMA_SEED: 'true',
    RUN_SYNTHETIC_HISTORY_SEED: 'true',
    SYNTHETIC_SEED_PROFILE: 'COMPACT',
    PG_VERSION: '18',
    PG_DB_NAME: 'payment_gateway_prod',
    PG_DB_USER: 'pg_core_user',
    PG_DB_PASSWORD: 'pg_core_pass_1234',
    PG_REPLICATION_USER: 'pg_replicator',
    PG_REPLICATION_PASSWORD: 'pg_repl_pass_1234',
    PGBOUNCER_ENABLED: 'true',
    PGBOUNCER_DEFAULT_POOL_SIZE: '40',
    PGBOUNCER_MAX_CLIENT_CONN: '1000',
    PGBOUNCER_MAX_PREPARED_STATEMENTS: '256',
    REDIS_PASSWORD: 'pg_redis_pass_1234',
    AUDIT_DB_NAME: 'pg_audit_db',
    AUDIT_DB_USER: 'pg_audit_writer',
    AUDIT_DB_PASSWORD: 'pg_audit_pass_1234',
    LOG_DB_NAME: 'pg_logs_db',
    LOG_DB_USER: 'pg_log_writer',
    LOG_DB_PASSWORD: 'pg_log_pass_1234',
    BACKUP_ENABLED: 'true',
    BACKUP_COMPRESSION: 'zstd',
    BACKUP_ENCRYPTION_KEY_HEX: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    BACKUP_PRIMARY_S3_ENDPOINT: `http://${lab.hostBLanIp}:9000`,
    BACKUP_PRIMARY_S3_BUCKET: 's3://pg-backups-test',
    BACKUP_PRIMARY_S3_ACCESS_KEY: 'minioadmin',
    BACKUP_PRIMARY_S3_SECRET_KEY: 'minioadmin1234',
  });

  const A = (lab: LabHostsConfig) => lab.hostALanIp;
  const B = (lab: LabHostsConfig) => lab.hostBLanIp;

  return [
    {
      id: 'T1',
      name: 'Single-Host Multi-Node Density & Co-Located Storage (WAL-G on Same Host)',
      description: '2 Core, 2 Checkout, 1 Merchant, 1 Admin, Primary+Local Replica, Redis, Audit/Log DB & WAL-G all on HOST_A',
      glShardCount: 16,
      seedProfile: 'COMPACT',
      backupMode: 'wal-g',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${A(lab)}:22:${A(lab)}:4102`,
        CHECKOUT_NODES: `chk-1@${A(lab)}:22:${A(lab)}:4103,chk-2@${A(lab)}:22:${A(lab)}:4113`,
        FAKE_RAILS_NODE: `fakerails-1@${A(lab)}:22:${A(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${A(lab)}:22:${A(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-local@${A(lab)}:22:${A(lab)}:5433`,
        REDIS_NODES: `redis-1@${A(lab)}:22:${A(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${A(lab)}:22:${A(lab)}:5434`,
        LOG_DB_NODE: `log-1@${A(lab)}:22:${A(lab)}:5435`,
        BACKUP_NODE: `backup-1@${A(lab)}:22:${A(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'wal-g',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostBSshUser}@${B(lab)}:/var/backups/pg-vault-t1`,
      }),
    },
    {
      id: 'T2',
      name: 'Compute-on-A / Storage-on-B Split + Cross-Host Barman Backup',
      description: '3 Core & 4 Edge nodes on HOST_A; Primary DB, Redis, Audit & Log DB on HOST_B (10.209.250.205); Barman on HOST_A',
      glShardCount: 16,
      seedProfile: 'COMPACT',
      backupMode: 'barman',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001,core-3@${A(lab)}:22:${A(lab)}:4002`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${A(lab)}:22:${A(lab)}:4102,merch-2@${A(lab)}:22:${A(lab)}:4112`,
        CHECKOUT_NODES: `chk-1@${A(lab)}:22:${A(lab)}:4103,chk-2@${A(lab)}:22:${A(lab)}:4113`,
        FAKE_RAILS_NODE: `fakerails-1@${A(lab)}:22:${A(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${B(lab)}:22:${B(lab)}:5432`,
        PG_REPLICA_NODES: '',
        REDIS_NODES: `redis-1@${B(lab)}:22:${B(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${B(lab)}:22:${B(lab)}:5434`,
        LOG_DB_NODE: `log-1@${B(lab)}:22:${B(lab)}:5435`,
        BACKUP_NODE: `backup-1@${A(lab)}:22:${A(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'barman',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostASshUser}@${A(lab)}:/var/backups/pg-vault-t2`,
      }),
    },
    {
      id: 'T3',
      name: 'DB & Redis Separated + Cross-Host Streaming Replica + WAL-G',
      description: 'PG_PRIMARY on HOST_A; REDIS + PG_REPLICA_1 + Audit/Log DB on HOST_B; Core & Checkout split across both machines',
      glShardCount: 16,
      seedProfile: 'COMPACT',
      backupMode: 'wal-g',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${B(lab)}:22:${B(lab)}:4000`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${B(lab)}:22:${B(lab)}:4102`,
        CHECKOUT_NODES: `chk-1@${A(lab)}:22:${A(lab)}:4103,chk-2@${B(lab)}:22:${B(lab)}:4103`,
        FAKE_RAILS_NODE: `fakerails-1@${B(lab)}:22:${B(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${A(lab)}:22:${A(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-1@${B(lab)}:22:${B(lab)}:5432`,
        REDIS_NODES: `redis-1@${B(lab)}:22:${B(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${B(lab)}:22:${B(lab)}:5434`,
        LOG_DB_NODE: `log-1@${B(lab)}:22:${B(lab)}:5435`,
        BACKUP_NODE: `backup-1@${A(lab)}:22:${A(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'wal-g',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostBSshUser}@${B(lab)}:/var/backups/pg-vault-t3`,
      }),
    },
    {
      id: 'T4',
      name: 'Reversed DB/Redis Separation + Dual Replicas (1 Local + 1 Remote) + Standby Barman',
      description: 'PG_PRIMARY on HOST_B; PG_REPLICA_1 on HOST_B:5433 + PG_REPLICA_2 on HOST_A:5432; REDIS on HOST_A; Barman on HOST_A',
      glShardCount: 32,
      seedProfile: 'COMPACT',
      backupMode: 'barman',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001,core-3@${B(lab)}:22:${B(lab)}:4000`,
        ADMIN_NODES: `admin-1@${B(lab)}:22:${B(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${A(lab)}:22:${A(lab)}:4102`,
        CHECKOUT_NODES: `chk-1@${B(lab)}:22:${B(lab)}:4103,chk-2@${B(lab)}:22:${B(lab)}:4113`,
        FAKE_RAILS_NODE: `fakerails-1@${A(lab)}:22:${A(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${B(lab)}:22:${B(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-1@${B(lab)}:22:${B(lab)}:5433,pg-rep-2@${A(lab)}:22:${A(lab)}:5432`,
        REDIS_NODES: `redis-1@${A(lab)}:22:${A(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${A(lab)}:22:${A(lab)}:5434`,
        LOG_DB_NODE: `log-1@${A(lab)}:22:${A(lab)}:5435`,
        BACKUP_NODE: `backup-1@${A(lab)}:22:${A(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'barman',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostASshUser}@${A(lab)}:/var/backups/pg-vault-t4`,
      }),
    },
    {
      id: 'T5',
      name: 'Production DMZ Edge Split (Public Edge on HOST_B, Private Core/Vault on HOST_A)',
      description: 'All Checkout & Merchant edge nodes on HOST_B; Core, Admin, DBs & Redis locked inside HOST_A private zone',
      glShardCount: 16,
      seedProfile: 'COMPACT',
      backupMode: 'barman',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${B(lab)}:22:${B(lab)}:4102,merch-2@${B(lab)}:22:${B(lab)}:4112`,
        CHECKOUT_NODES: `chk-1@${B(lab)}:22:${B(lab)}:4103,chk-2@${B(lab)}:22:${B(lab)}:4113,chk-3@${B(lab)}:22:${B(lab)}:4123`,
        FAKE_RAILS_NODE: `fakerails-1@${B(lab)}:22:${B(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${A(lab)}:22:${A(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-1@${A(lab)}:22:${A(lab)}:5433`,
        REDIS_NODES: `redis-1@${A(lab)}:22:${A(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${A(lab)}:22:${A(lab)}:5434`,
        LOG_DB_NODE: `log-1@${A(lab)}:22:${A(lab)}:5435`,
        BACKUP_NODE: `backup-1@${B(lab)}:22:${B(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'barman',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostBSshUser}@${B(lab)}:/var/backups/pg-vault-t5`,
      }),
    },
    {
      id: 'T6',
      name: 'Full Symmetric High-Availability Mesh (4 Core, 4 Checkout, 4 Merchant, 2 Admin, 2 Replicas, STANDARD 120k Seed)',
      description: 'Every compute tier horizontally scaled across BOTH HOST_A and HOST_B with 32-shard ledger & STANDARD 120k seed',
      glShardCount: 32,
      seedProfile: 'STANDARD',
      backupMode: 'barman',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        SYNTHETIC_SEED_PROFILE: 'STANDARD',
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001,core-3@${B(lab)}:22:${B(lab)}:4000,core-4@${B(lab)}:22:${B(lab)}:4001`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101,admin-2@${B(lab)}:22:${B(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${A(lab)}:22:${A(lab)}:4102,merch-2@${A(lab)}:22:${A(lab)}:4112,merch-3@${B(lab)}:22:${B(lab)}:4102,merch-4@${B(lab)}:22:${B(lab)}:4112`,
        CHECKOUT_NODES: `chk-1@${A(lab)}:22:${A(lab)}:4103,chk-2@${A(lab)}:22:${A(lab)}:4113,chk-3@${B(lab)}:22:${B(lab)}:4103,chk-4@${B(lab)}:22:${B(lab)}:4113`,
        FAKE_RAILS_NODE: `fakerails-1@${B(lab)}:22:${B(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${A(lab)}:22:${A(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-1@${A(lab)}:22:${A(lab)}:5433,pg-rep-2@${B(lab)}:22:${B(lab)}:5432`,
        REDIS_NODES: `redis-pri@${B(lab)}:22:${B(lab)}:6379,redis-rep@${A(lab)}:22:${A(lab)}:6380`,
        AUDIT_DB_NODE: `audit-1@${B(lab)}:22:${B(lab)}:5434`,
        LOG_DB_NODE: `log-1@${B(lab)}:22:${B(lab)}:5435`,
        BACKUP_NODE: `backup-1@${B(lab)}:22:${B(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'barman',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostBSshUser}@${B(lab)}:/var/backups/pg-vault-t6`,
      }),
    },
    {
      id: 'T7',
      name: 'Live Rolling Scale-Out (1->4 Nodes) & Scale-In (4->2 Nodes) Under Active 500 TPS Load',
      description: 'Tests zero-downtime horizontal node addition and removal during continuous payment processing',
      glShardCount: 32,
      seedProfile: 'COMPACT',
      backupMode: 'barman',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        DEPLOY_MODE: 'rolling_update',
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001,core-3@${B(lab)}:22:${B(lab)}:4000,core-4@${B(lab)}:22:${B(lab)}:4001`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${A(lab)}:22:${A(lab)}:4102,merch-2@${B(lab)}:22:${B(lab)}:4102`,
        CHECKOUT_NODES: `chk-1@${A(lab)}:22:${A(lab)}:4103,chk-2@${A(lab)}:22:${A(lab)}:4113,chk-3@${B(lab)}:22:${B(lab)}:4103,chk-4@${B(lab)}:22:${B(lab)}:4113`,
        FAKE_RAILS_NODE: `fakerails-1@${B(lab)}:22:${B(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${A(lab)}:22:${A(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-1@${B(lab)}:22:${B(lab)}:5432`,
        REDIS_NODES: `redis-1@${B(lab)}:22:${B(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${B(lab)}:22:${B(lab)}:5434`,
        LOG_DB_NODE: `log-1@${B(lab)}:22:${B(lab)}:5435`,
        BACKUP_NODE: `backup-1@${B(lab)}:22:${B(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'barman',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostBSshUser}@${B(lab)}:/var/backups/pg-vault-t7`,
      }),
    },
    {
      id: 'T8',
      name: 'Chaos Engineering, Node Kill, Replica Lag & Full Primary PITR Disaster Recovery Gauntlet',
      description: 'Executes mid-flight kills of core-back, PG_REPLICA, Redis, and PG_LOG_DB, plus full PG_PRIMARY wipe & PITR restore',
      glShardCount: 32,
      seedProfile: 'COMPACT',
      backupMode: 'wal-g',
      buildEnv: (lab) => ({
        ...baseSecrets(lab),
        CORE_NODES: `core-1@${A(lab)}:22:${A(lab)}:4000,core-2@${A(lab)}:22:${A(lab)}:4001,core-3@${B(lab)}:22:${B(lab)}:4000,core-4@${B(lab)}:22:${B(lab)}:4001`,
        ADMIN_NODES: `admin-1@${A(lab)}:22:${A(lab)}:4101,admin-2@${B(lab)}:22:${B(lab)}:4101`,
        MERCHANT_NODES: `merch-1@${A(lab)}:22:${A(lab)}:4102,merch-2@${B(lab)}:22:${B(lab)}:4102`,
        CHECKOUT_NODES: `chk-1@${A(lab)}:22:${A(lab)}:4103,chk-2@${B(lab)}:22:${B(lab)}:4103`,
        FAKE_RAILS_NODE: `fakerails-1@${B(lab)}:22:${B(lab)}:4400`,
        PG_PRIMARY_NODE: `pg-pri@${A(lab)}:22:${A(lab)}:5432`,
        PG_REPLICA_NODES: `pg-rep-1@${A(lab)}:22:${A(lab)}:5433,pg-rep-2@${B(lab)}:22:${B(lab)}:5432`,
        REDIS_NODES: `redis-1@${B(lab)}:22:${B(lab)}:6379`,
        AUDIT_DB_NODE: `audit-1@${B(lab)}:22:${B(lab)}:5434`,
        LOG_DB_NODE: `log-1@${B(lab)}:22:${B(lab)}:5435`,
        BACKUP_NODE: `backup-1@${A(lab)}:22:${A(lab)}:4090`,
        BACKUP_ENGINE_MODE: 'wal-g',
        BACKUP_SECONDARY_SSH_TARGET: `${lab.hostBSshUser}@${B(lab)}:/var/backups/pg-vault-t8`,
      }),
    },
  ];
}
```

## 6. Mandatory Autonomous "Test -> Diagnose -> Fix -> Re-Verify" Self-Healing Loop for OpenCode

When OpenCode runs the 8-topology test matrix, **stopping on an error and reporting failure to the user is forbidden**. OpenCode must follow this autonomous self-healing loop for every gate in `T1` through `T8`:

1. **Step 1 — Capture Structured Failure Telemetry:**
   - If any deployment step or verification gate fails, automatically collect:
     - SSH stdout/stderr from the failed command on `HOST_A` or `HOST_B` (`salem@10.209.250.205`),
     - PM2 logs (`pm2 logs --nostream --lines 100`) from the relevant node,
     - PostgreSQL 18 / PgBouncer / Barman / WAL-G / Nginx journal logs (`sudo -S journalctl -u <service> -n 80 --no-pager`).
2. **Step 2 — Root-Cause Classification & Immediate Code/Config Remediation:**
   - **Case A — Port Collision or Stale Process Between Topologies:** Update `deploy/test-matrix/teardownTopology.ts` to cleanly stop previous topology PM2 apps, release ports, and reset test clusters before starting the next topology.
   - **Case B — `pg_hba.conf` or `listen_addresses` Rejection Across LAN (`HOST_A <-> 10.209.250.205`):** Patch `postgres18Provisioner.ts` to ensure `host all all <LAN_SUBNET>/24 scram-sha-256` and `host replication pg_replicator <LAN_SUBNET>/24 scram-sha-256` are present before reloading Postgres.
   - **Case C — mTLS Certificate `ERR_TLS_CERT_ALTNAME_INVALID` on Multi-Node:** Patch `pkiManager.ts` so every IP in `CORE_NODES`, `BACKUP_NODE`, `127.0.0.1`, and `localhost` is included in the X.509 `subjectAltName` extension and redistribute certs.
   - **Case D —PgBouncer Prepared Statement Error (`prepared statement "s0" already exists` or `does not exist`):** Verify `pool_mode = transaction` and `max_prepared_statements = 256` in `pgbouncer.ini` and reload PgBouncer.
   - **Case E — Multi-Node Worker Duplicate Execution or Lock Contention:** Patch the worker's SQL claim query to wrap `SELECT ... FOR UPDATE SKIP LOCKED` and the status/lease `UPDATE` inside a single `storage.uow.run()` transaction.
   - **Case F — WAL-G or Barman Archive/Restore Failure:** Inspect bucket/SSH permissions, `archive_command`, or `pg_receivewal` slot initialization in `backupEngineProvisioner.ts`, fix the script, and re-run the backup and scratch PITR restore drill.
3. **Step 3 — Re-Run the Failed Gate + Full Topology Regression:**
   - After applying the fix, re-deploy the current topology and re-run **all 11 gates (`Gate 1` to `Gate 11`)** from the beginning of that topology to confirm the fix did not introduce any regression.

## 7. OpenCode Execution Checklist

- [ ] **Task 1 — Implement Multi-Instance & Multi-Cluster Support in `deploy/`:** Ensure PM2 process names, `.env.<nodeId>` files, Nginx upstreams, and Debian/Ubuntu `pg_createcluster 18 <name> -p <port>` support running multiple nodes of any service or database role on the same machine (`HOST_A` or `HOST_B`) as well as across separate machines.
- [ ] **Task 2 — Bootstrap Two-Machine Lab (`HOST_A` <-> `salem@10.209.250.205` pass `1234`):** Run `bootstrapTwoMachineLab.ts` to auto-discover `HOST_A_LAN_IP`, establish bidirectional Ed25519 SSH keys between `HOST_A` and `salem@10.209.250.205`, verify passwordless/stdin-sudo (`1234`), and provision the local MinIO S3 test bucket (`:9000`) + SSH backup vault directory on `HOST_B`.
- [ ] **Task 3 — Execute & Verify Topologies `T1`, `T2`, `T3`, and `T4`:** Run all 11 verification gates across `T1` (Single-Host Multi-Node + `wal-g`), `T2` (Compute on A / Storage on B + `barman`), `T3` (DB & Redis Separated + Cross-Host Streaming Replica + `wal-g`), and `T4` (Reversed DB/Redis Separation + 2 Replicas + Standby-Offloaded `barman`), healing any issues discovered.
- [ ] **Task 4 — Execute & Verify Topologies `T5`, `T6`, `T7`, and `T8`:** Run all 11 verification gates across `T5` (DMZ Edge Isolation + UFW Penetration Test), `T6` (Full Symmetric 4-Core / 4-Checkout / 4-Merchant / 2-Admin / 2-Replica Mesh with 120,000-attempt `STANDARD` seed), `T7` (Live Rolling Horizontal Scale-Out & Scale-In under 500 TPS load), and `T8` (Chaos Engineering Node/Replica/Redis/LogDB Kills + Full Primary DB Wipe & PITR Recovery).
- [ ] **Task 5 — Emit Final Multi-Topology Benchmark & Certification Report:** Write `deploy/test-matrix/TOPOLOGY_CERTIFICATION_REPORT.md` recording the measured p50/p95/p99 latencies, sustained TPS, replica failover times, PITR restore durations, and `0.0000 LYD` ledger invariant proofs across all 8 topologies.
