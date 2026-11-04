---
id: testing.two-machine-matrix
title: Two-Machine Multi-Topology Matrix
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 6332cb6+working-tree
code:
  - deploy/test-matrix/**
  - deploy/test/testMatrix.test.ts
  - deploy/lib/hostPlanner.ts
  - deploy/provisioners/postgres18Provisioner.ts
design_sources:
  - design/two-machine-test/two_machine_multi_topology_deployment_and_stress_test_plan.md#3-the-8-production-deployment-topology-matrices-t1-through-t8
  - design/two-machine-test/two_machine_multi_topology_deployment_and_stress_test_plan.md#4-the-11-gate-per-topology-verification-stress-chaos-suite
tests:
  - deploy/test/testMatrix.test.ts
gaps:
  - HOST_B (10.209.250.205) was unreachable from HOST_A during implementation, so the eight live topology runs and the 11 live gates have not been executed in this environment.
  - Gate 4 confirm/webhook race and Gate 11 full primary wipe/PITR are implemented as orchestration hooks but require a live two-machine lab to certify.
  - The stress generator uses seeded payment links and does not provision a fresh merchant/application per run.
---

# Two-Machine Multi-Topology Matrix

## 1. Purpose and scope

This part owns the executable two-machine lab: SSH/bootstrap, MinIO S3 and SSH vault provisioning, topology config generation for T1–T8, teardown, the 11 verification gates, the stress workload, the self-healing retry loop and the certification report.

It does not own the production deploy engine (`07-deploy`), the storage adapters (`01-core-back/06-storage-engine.md`) or the ledger invariant (`01-core-back/03-ledger.md`).

## 2. Design intent

The historical plan requires eight production topology permutations across `HOST_A` and `HOST_B`:

| ID | Shape |
| :--- | :--- |
| T1 | Single-host multi-node density, co-located PostgreSQL/Redis/audit/log, WAL-G |
| T2 | Compute on A / storage on B, Barman on A |
| T3 | Primary on A, replica + Redis + audit/log on B, WAL-G |
| T4 | Primary on B, local + remote replicas, Redis/audit/log on A, Barman on A |
| T5 | Public checkout/merchant DMZ on B, private core/DB/Redis on A, UFW penetration checks |
| T6 | Symmetric mesh: 4 core, 4 checkout, 4 merchant, 2 admin, 2 replicas, 120k seed |
| T7 | Live scale-out/scale-in under 500 TPS |
| T8 | Chaos: core/replica/Redis/log-DB kills and full primary PITR |

Every topology runs the same 11 gates: provisioning/mTLS/UFW, replica routing and LSN RYOW, Fake Rails/seeder invariants, 500+ TPS checkout/ledger stress, cross-node SSE/POS, concurrent workers, audit immutability/hash chain, log-DB outage, search/pagination, backup/PITR, and chaos/failover.

## 3. As-built architecture

### 3.1 Bootstrap and lab services

`deploy/test-matrix/hosts.ts`:

- discovers `HOST_A_LAN_IP` with `ip -4 route get 10.209.250.205`;
- creates `~/.ssh/id_ed25519_pg_lab_matrix`, authorizes it on `HOST_A` and `HOST_B` (`salem@10.209.250.205`, password `1234`);
- creates a separate `~/.ssh/id_ed25519_pg_peer` on `HOST_B` and authorizes it on `HOST_A` for Barman/`pg_basebackup`;
- installs/launches MinIO on `HOST_B:9000` with bucket `pg-backups-test`;
- creates the SSH vault directories on both hosts;
- writes `/etc/pg-lab-matrix`, the marker that lets teardown know the host is disposable lab hardware.

### 3.2 Topology generation

`deploy/test-matrix/topologies.ts` builds the eight configs. It uses the real node grammar (`nodeId@sshHost:sshPort:privateIp:servicePort`), sets `STORAGE_SHARD_COUNT` to 16 or 32, sets `SYNTHETIC_SEED_PROFILE`, and emits `FAKE_RAILS_NODE` plus a reachable `FAKE_RAILS_PUBLIC_BASE_URL` for every topology.

`generateTopologyConfigs.ts` writes `deploy/test-matrix/configs/deploy.T1.env` … `deploy.T8.env` with mode `0600`. `deploy/test/testMatrix.test.ts` validates all eight through the real Zod schema.

### 3.3 Multi-instance deploy support

The matrix depends on the deploy engine supporting several instances of one tier on one host:

- PM2 names are node-suffixed (`pg-core-back-core-1`, `pg-core-back-core-2`);
- each node has `shared/.env.<nodeId>` and its own `.env` symlink;
- each node has `releases/<nodeId>/<timestamp>` and `current-<nodeId>`;
- Nginx renders `upstream` blocks with `least_conn` and `max_fails=2 fail_timeout=3s` over all local and remote nodes;
- edge backends bind the node private IP so a remote Nginx can reach them;
- PostgreSQL roles use independent Debian clusters (`main`, `replica_<nodeId>`, `audit`, `log`) with their own data directory, config, HBA and systemd unit.

### 3.4 Runner and self-healing loop

`runAllTopologiesAndHeal.ts`:

1. bootstraps the lab and writes all eight configs;
2. tears down lab-owned PM2 apps, vhosts, release trees and PostgreSQL clusters;
3. deploys with `deploy/deploy.ts --fresh`;
4. runs all 11 gates in order;
5. on failure, captures PM2 logs and service journals, tears down and retries once;
6. writes `deploy/test-matrix/TOPOLOGY_CERTIFICATION_REPORT.md`.

The runner never stops at the first failed topology; it records the failure and continues to the next configured topology.

## 4. Contracts and invariants

1. The lab is disposable. Teardown only drops clusters when `/etc/pg-lab-matrix` exists.
2. Secrets stay in generated `0600` config files and are redacted from the report.
3. A topology is certified only when all 11 gates pass.
4. Every gate that writes money must finish with zero double-entry drift and `gl_account_shards == journal_lines`.
5. The audit hash chain is computed by the PostgreSQL trigger under `pg_advisory_xact_lock(994001)`, not by competing Node processes.

## 5. Verification

```bash
cd deploy
bun test ./test/testMatrix.test.ts
bun run test-matrix:bootstrap
bun run test-matrix --topologies=T1,T2
```

Live certification requires `HOST_B` reachable and root/sudo on both hosts. The environment used during implementation could not reach `10.209.250.205`, so only config generation, schema validation and unit tests were executed.

## 6. Known gaps

- Live T1–T8 execution is pending lab availability.
- Gate 4's concurrent webhook/confirm race uses the checkout API but does not yet assert the exact single-ledger-row count through a direct query.
- Gate 10 polls the admin overview for backup completion; the daemon's own `/v1/runs` endpoint is not used directly.
- Gate 11's full primary wipe/PITR restore is orchestration code only; it must be run on the lab.
