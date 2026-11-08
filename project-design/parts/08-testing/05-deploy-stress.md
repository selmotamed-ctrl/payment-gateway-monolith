---
id: testing.deploy-stress
title: Deploy Stress Harness
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 1d91a3a+working-tree
code:
  - deploy/stress/**
  - deploy/lib/converge.ts
  - deploy/lib/frontendBuild.ts
  - deploy/lib/sshRunner.ts
  - deploy/deploy.ts
  - deploy/package.json
tests:
  - deploy/test/stress-harness.test.ts
  - deploy/test/converge.test.ts
  - deploy/test/frontendBuild.test.ts
gaps:
  - The destructive `fresh-database-stress-seed` scenario has not completed end to end: its first attempt exposed the PgBouncer cached-login defect (fixed), and the next run was killed by the host's low-memory protection mid-seed, so the seeded-data backup step has never been exercised by it.
  - It exercises one machine. Real ssh is covered through the `127.0.0.2` loopback hop, but separate-machine firewalls, latency and independent failures remain the job of the multi-machine matrix (`testing.multi-machine-matrix`).
  - Single-node PM2 services restart with delete + start; the harness measures the portal gap (about 0.4 s on the dev box) and bounds it, it does not remove it. Only multi-node tiers are zero-downtime.
  - The destructive scenario takes a full backup through the daemon but does not run a restore drill on the seeded data.
---

# Deploy Stress Harness

## 1. Purpose

`deploy/stress` drives the **real** `deploy/deploy.ts` against **this machine's real services** (PostgreSQL, PgBouncer, Redis/Valkey, MinIO, the backup daemon, PM2, nginx, Fake Rails) under database load, portal traffic, injected faults and config tampering, and asserts on what the services actually did. Nothing is mocked: process identity, `pg_settings.pending_restart`, journal lines and measured outage windows are the evidence. It exists because the unit tests mock the runner and therefore could not see that every deploy restarted PgBouncer three times at 90 s each (see `deploy.storage` section 16).

## 2. How it works

- `bun run stress` (from `deploy/`) reads `deploy/deploy.env` (`--env=` to override) and never modifies it. Every scenario deploys a throw-away copy with its overrides (`stress/env.ts`, parsed with the engine's own `parseDeployEnv`) and always re-deploys the original in cleanup. Derived env files carry the lab's secrets and are deleted when the run ends.
- Deploys run as child processes (async) so in-process load generators keep running: `startDbLoad` holds long-lived pooled connections through PgBouncer (small query every 50-250 ms, idle in between, which is exactly the shape that hangs a stock `systemctl restart pgbouncer`) and records errors and per-worker outage time; `startAvailabilityProbe` hits the four portal vhosts every 100 ms (a connection error or 502/503/504 is "down"; a 404 from the backend means it is up).
- A snapshot (`stress/probes.ts`) captures every service's identity in one sudo round trip (postmaster start time, `pending_restart` count, archive-command hash, `MainPID` + start timestamp of PgBouncer/MinIO/the daemon/nginx, Redis `run_id`) plus the deploy user's `pg-` PM2 apps. Two snapshots differing on a bounce key prove a service was restarted.
- Reports: `stress/reports/<runId>/report.{md,json}` (commit, host, seed, per-scenario checks and measurements); per-deploy logs in `stress/.work/<runId>/`. Both are git-ignored.
- `--destructive` gates the scenario that drops databases; `--intensity`, `--budget-factor` and `--seed` scale load, time budgets and the soak's reproducible fault choice.

## 3. Scenarios

| Id | Asserts |
| :--- | :--- |
| `noop-redeploy` | Repeated no-op deploys start/restart nothing, change no service identity, flag no slow command, keep a Redis sentinel key, raise zero DB-client errors, stay within budget. |
| `pgbouncer-reload` | A pool-size change reloads PgBouncer (same process, SIGHUP in the journal, new value on disk, zero client errors); restoring it is also a reload. |
| `pgbouncer-restart-under-load` | `systemctl restart pgbouncer` with 30 live clients is fast and the unit stops on SIGINT; `--force-restart` of PostgreSQL + PgBouncer completes in seconds and every client recovers. |
| `postgres-pending-restart` | `PG_RAM_GB=16` restarts PostgreSQL exactly once (`shared_buffers` 4GB), PgBouncer follows, nothing stays `pending_restart`; repeating it bounces nothing; the original value is restored. |
| `redis-config-change` | An unchanged redeploy keeps the Redis process and a cache key; a `maxmemory` change restarts it and is applied. |
| `chaos-recovery` | Nine faults, each repaired by one deploy: kill -9 PgBouncer, stop PostgreSQL/Redis/MinIO/the daemon, corrupt `pgbouncer.ini`, delete the PgBouncer drop-in and signature, hand-edit `postgresql.conf` and `pg_hba.conf`; then a final no-op bounces nothing. |
| `deploy-under-traffic` | DB clients see zero errors and each portal outage window is bounded while a full deploy runs. |
| `ssh-transport` | The whole deploy over real ssh + sudo-over-ssh + rsync-over-ssh (`127.0.0.2` as the hop, the real services stay on `127.0.0.1`); a no-op over ssh bounces nothing; multiplexing is not slower; no control master is left behind. |
| `multi-node-rolling` | Two nodes per tier with `--rolling-batch=1`: portals stay up; scaling back retires the orphaned PM2 apps. |
| `soak` | Seeded random fault + deploy cycles under DB load, then a closing no-op that must bounce nothing. |
| `fresh-database-stress-seed` (destructive) | Drops the application, audit and log databases, flushes Redis, deploys from empty with Fake Rails and the `STRESS` synthetic seed, takes a full backup through the daemon, then a no-op deploy must bounce nothing. |

## 4. Measured results (dev box, 8 cores, 31 GB, live data ~2.8 GB)

| Measurement | Before | After |
| :--- | ---: | ---: |
| Storage-tier no-op deploy | 4m53s | 5.1 s |
| Full no-op `--update` (build cache warm) | 5m14s (`--skip-build`) | 21-23 s |
| `systemctl restart pgbouncer`, 30 live clients | 90 s (SIGKILL after timeout) | 0.19 s |
| Forced restart of PostgreSQL + PgBouncer (`--force-restart`) | n/a | 4.8 s, longest client outage 2.0 s |
| Longest client outage across two PostgreSQL restarts | n/a | 2.6 s |
| Single-node portal outage during a full deploy | not measured | 0.41 s (`:8080/:8081/:8082`), 0.31 s (Fake Rails) |
| Rolling deploy, two nodes per tier | not measured | 0 s outage on every portal, 0 DB errors, 36 s |
| No-op deploy over ssh | not measured | 31 s multiplexed vs 80 s with one connection per command |
| Soak (6 random faults) | n/a | 15,664 queries, longest single-client outage 3.1 s |

## 5. Defects the harness found in the engine

- **Redis alias unit:** on Arch `redis.service` is a symlink to `valkey.service`; the new unit detector picked `redis`, and `systemctl enable` refuses linked units, so a stopped Redis could not be brought back. Detection now ignores symlinks and the start path does `enable || true` then `start`.
- It also confirmed, with live evidence, the original defects fixed in `deploy.storage` section 16 (SIGTERM hang, unconditional restarts, the flip-flopping `archive_command`).

## 6. Running it

```bash
cd deploy
bun run stress:list
bun run stress                          # non-destructive
bun run stress -- --destructive         # + fresh database + STRESS seed + backup
```

Operator notes live in `deploy/stress/README.md`.
