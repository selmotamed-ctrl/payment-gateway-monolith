# Multi-Machine Topology and Stress Test Plan

> **Supersedes** `design/90-archive/superseded-testing/two_machine_multi_topology_deployment_and_stress_test_plan.md`. Canonical as-built description: `project-design/parts/08-testing/04-multi-machine-matrix.md` (`testing.multi-machine-matrix`). This file is design lineage only.

## 0. Mistakes in the archived plan and implementation, and how this plan fixes them

| # | Mistake | Fix |
| :--- | :--- | :--- |
| 1 | **Security:** the plan hard-coded an SSH/sudo password (a four-digit literal) for `salem@10.209.250.205`; the code defaulted both hosts to it, passed it to `sshpass -p` (visible in the process list) and ran `ssh-copy-id` with `StrictHostKeyChecking=no`. | No password anywhere. Key-based SSH only; sudo is `nopasswd` or read from the env var named in `ssh.sudo.passwordEnv`. Bootstrap verifies access and prints the `ssh-copy-id` command instead of pushing keys. Host-key checking stays on. |
| 2 | Lab secrets (DB/Redis/audit/log passwords, KMS key, backup key, Fake Rails JWT/seeder token, MinIO credentials) were literals committed in `topologies.ts`; MinIO credentials were also on the `docker run` command line. | Generated per lab with a CSPRNG into git-ignored 0600 files; MinIO gets a 0600 `--env-file`. |
| 3 | Reports leaked secrets: only `PASSWORD=` lines were redacted, so KMS keys, JWT secrets and S3 keys were printed. | Redaction covers every secret-looking key and every known secret value. |
| 4 | Every tier used HOST_B's SSH user and HOST_A's sudo password. | One lab-wide SSH identity from the config, applied to all tiers (the deploy engine plans SSH per tier). |
| 5 | `LAN_ALLOWED_CIDRS` was `10.0.0.0/8,192.168.0.0/16`. | Narrowed to the declared machines or `lab.lanCidrs`. |
| 6 | Topologies were eight fixed layouts tied to two hosts. | Topologies are derived per family from machines and roles; the old T1–T8 are aliases on a two-machine config. |
| 7 | Gates passed vacuously: "not T8" and "no replica" returned `ok=true`; `inbound queue drains` passed when the queue was empty; a failed SUPPORT search "did not expose AML". | Checks are `PASS`/`FAIL`/`SKIP`; SKIP is never a pass; a gate that is all-SKIP is `SKIPPED`; a topology needs at least one PASS and no FAIL/NOT_RUN. |
| 8 | "500+ TPS" was a closed-loop burst of 500 requests with no throughput measurement; strict targets hid behind `LAB_STRICT_PERF`. | Open-loop generator (ramp + steady window) measures achieved TPS, p95/p99, error rate and per-node success; targets live in the intensity SLO (`certification` preset carries 500 TPS / p95 35 ms). |
| 9 | Gate 4 disabled all velocity/AML rules permanently. | Only the active rules are suspended and exactly those are restored. |
| 10 | Gate 8 fell back to `systemctl stop postgresql`, stopping every cluster on the host (including a co-located primary). | Stops only the log cluster unit and fails the check if it is still active. |
| 11 | RYOW check accepted any server except the paused replica. | Requires the primary to serve the read. |
| 12 | Ledger drift was parsed as a float and the shard comparison used an inner join. | Exact decimal-string comparison; full outer join. |
| 13 | SQL values were escaped with shell quoting. | Real SQL literal escaping. |
| 14 | Gate 11 (chaos) restarted a core once, stopped a replica and never restored it, and returned success on non-T8 topologies; PITR was claimed but absent. | Faults are scheduled under sustained load, restored in `finally`, verified restored, and recovery time is measured; `primary-pitr` is reported SKIP/unimplemented, never passed. |
| 15 | T7 "scale" ran with `--fresh`, overriding `DEPLOY_MODE=rolling_update`, and used the stopped checkout nodes as targets. | Deploys fresh then `--update` for rolling topologies; a dedicated scale gate drains and restarts nodes during the run. |
| 16 | The report's "2/11" meant "2 gates ran". It recorded no config or intensity. | Passed/failed/skipped/not-run columns; config hash, intensity hash, resolved intensity, git commit, attempt number. |
| 17 | Teardown removed PM2 apps, vhosts and release trees on any reachable host; only cluster removal checked the lab marker. | Every destructive step requires the marker; refused hosts are reported. |
| 18 | `sudo -S bash -c 'cat > file'` fed password+content: with NOPASSWD sudo or a cached timestamp the password became line 1 of the written file (deploy lib). | The remote script reads the password itself and installs a temp copy with `sudo install`. |

## 1. Goal

A repeatable harness that deploys the gateway onto any number (N ≥ 1) of declared machines in several derived topologies, drives measured load and faults against each, and certifies a topology only from evidence. Machines and test intensity are declared in one JSON file.

## 2. Lab config

`deploy/test-matrix/machines.schema.json` (generated from the Zod schema in `labConfig.ts`) describes:

- `ssh`: shared user, port, key path, sudo mode (`nopasswd` or `password` + `passwordEnv`).
- `machines[]`: `id`, IPv4 `address`, optional `privateIp`/`sshPort`, `roles`, `labels`, `capacity.maxNodesPerTier`.
- Roles: `controller`, `app`, `edge`, `db`, `cache`, `logs`, `backup`, `object-store`, `vault`.
- `services.objectStore` (MinIO) and `services.vault` (secondary backup target).
- `topologies`: families, include/exclude, `maxPerFamily`, `shardCount`.
- `intensity`: preset plus overrides.

Rejected at load: literal secret keys, duplicate ids/addresses/IPs, more than one controller, missing required roles, unknown service machines. Examples: `machines.example.json` (3 machines), `machines.two-host-lab.example.json` (the old lab).

## 3. Topology families

`single-host`, `split`, `replicated`, `dmz`, `mesh`, `scale`, `chaos` (see the part file for placement rules). Constraints encoded: WAL-G only on the primary's machine; DMZ backup host stays private; one Redis node (the deploy engine uses only the first); per-machine ports never collide; capacity clamps instances.

## 4. Intensity

Presets `smoke`, `standard`, `soak`, `chaos`, `certification` define duration, ramp, TPS, concurrency, hot-link size, seed volume, search/read samples, gate selection, attempts, chaos faults and SLOs. Overrides deep-merge; the resolved object is hashed and written to the report.

## 5. Gates

1 provisioning/mTLS/DMZ zero-trust, 2 storage routing and RYOW, 3 seeder/Fake Rails/ledger, 4 hot link + sustained throughput + ledger, 5 SSE, 6 workers, 7 audit chain, 8 log-DB outage, 9 search, 10 backup, 11 scale in/out under load, 12 chaos under load. Every threshold comes from the intensity SLO.

## 6. Run flow

`validate` → `plan` (render + validate deploy configs) → `bootstrap` → `run`: per topology teardown → deploy → gates → diagnostics on failure → retry up to `attempts` → report. Exit code is non-zero when any topology is not certified.

## 7. Out of scope / next

Primary PITR restore orchestration, restore-drill completion polling, webhook/confirm race, injected worker queues, 50-client SSE and POS pairing, pagination timing, network fault injection, Redis replication, and per-host SSH identities are not yet implemented (tracked in the part file gaps). The first live run will also have to resolve the admin-auth 403 seen in the last archived T1 run.
