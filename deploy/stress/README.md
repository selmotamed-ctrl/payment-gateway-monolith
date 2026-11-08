# Deploy stress test

Drives the **real** `deploy.ts` against **this machine's real services** —
PostgreSQL, PgBouncer, Redis/Valkey, MinIO, the backup daemon, PM2, nginx and
Fake Rails — under database load, portal traffic, injected faults and config
tampering, and asserts on what the services actually did (process identity,
`pg_settings.pending_restart`, journal lines, outage windows). Nothing is mocked.

```bash
cd deploy
bun run stress:list                                   # scenarios and why each exists
bun run stress                                        # every non-destructive scenario
bun run stress -- --scenarios=noop-redeploy,chaos-recovery
bun run stress -- --intensity=3 --seed=42             # more workers/iterations, reproducible soak
bun run stress -- --destructive                       # + drop DBs, STRESS seed, real backup
```

It reads `deploy/deploy.env` (override with `--env=`) and never modifies it:
every scenario deploys a throw-away copy with its overrides, and always
re-deploys the original afterwards. Derived env files hold the lab's secrets and
are deleted when the run ends. Reports go to `stress/reports/<runId>/report.{md,json}`
and per-deploy logs to `stress/.work/<runId>/` (both git-ignored).

## Scenarios

| Id | What it proves |
| :--- | :--- |
| `noop-redeploy` | Repeated no-op deploys start/restart nothing, keep the Redis cache, raise zero DB-client errors under load and finish within budget. |
| `pgbouncer-reload` | A pool-size change is applied by SIGHUP reload: same process, zero client errors. |
| `pgbouncer-restart-under-load` | `systemctl restart pgbouncer` with 30 live pooled clients takes seconds (was 90 s), and a forced restart of the whole DB tier recovers every client. |
| `postgres-pending-restart` | `PG_RAM_GB` (a postmaster setting) restarts PostgreSQL exactly once, a repeat restarts nothing, nothing is left `pending_restart`. |
| `redis-config-change` | Redis restarts only when its config changes; the cache survives every other deploy. |
| `chaos-recovery` | Nine faults (kill -9 PgBouncer, stop PostgreSQL/Redis/MinIO/daemon, corrupt `pgbouncer.ini`, delete the drop-in, hand-edit `postgresql.conf` / `pg_hba.conf`) are each repaired by one deploy, then the system is quiet. |
| `deploy-under-traffic` | DB clients and the four portal vhosts are probed every 100 ms during a full deploy; outage windows are measured and bounded. |
| `ssh-transport` | The whole deploy over real ssh + sudo-over-ssh + rsync-over-ssh, using `127.0.0.2` as the ssh hop; no-op over ssh bounces nothing; connection multiplexing is not slower; no control master is left behind. |
| `multi-node-rolling` | Two nodes per tier, `--rolling-batch=1`: portals stay up while nodes restart; scaling back down retires the orphans. |
| `soak` | Random fault + deploy cycles (seeded), then a closing no-op that must bounce nothing. |
| `fresh-database-stress-seed` (**destructive**) | Drops the app/audit/log databases, flushes Redis, deploys from empty with Fake Rails and the `STRESS` synthetic seed, takes a full backup through the daemon, then a no-op must bounce nothing. |

## Knobs

| Flag | Meaning |
| :--- | :--- |
| `--intensity=<x>` | Multiplies DB-load workers and iteration counts. |
| `--budget-factor=<x>` | Multiplies every time budget (slow or busy machine). |
| `--seed=<n>` | Seeds the soak's fault choice so a failure is reproducible. |
| `--destructive` | Enables scenarios that drop databases. |
| `STRESS_SSH_KEY` | Key for the `ssh-transport` scenario (default `~/.ssh/id_ed25519_pg_lab_matrix`; skipped if it cannot ssh to 127.0.0.2). |

## Safety

- Only touches `pg-` PM2 apps and the services the deploy itself manages.
- `ssh-transport` adds `127.0.0.2` to your `~/.ssh/known_hosts` (`StrictHostKeyChecking=accept-new`).
- `--destructive` **drops databases**; it is never part of the default run.
- Time budgets are generous defaults for an 8-core box; raise `--budget-factor` rather than editing them.
