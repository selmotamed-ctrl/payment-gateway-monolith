---
id: deploy.health
title: Health Verification, Rollback and Recovery
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - deploy/lib/healthVerifier.ts
  - deploy/deploy.ts
  - deploy/lib/sshRunner.ts
  - deploy/DEPLOYMENT_GUIDE.md
  - core-back/index.ts
  - admin-back/index.ts
  - merchant-back/index.ts
  - checkout-back/index.ts
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#22-mutual-tls-mtls-inter-service-transport-architecture
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#52-core-back--admin-front-backup-management-api-contract
tests:
  - deploy/test/healthVerifierScale.test.ts
  - deploy/test/pipeline.test.ts
  - deploy/test/rollingDeploy.test.ts
  - deploy/backup-daemon/test/restoreDrillRunner.test.ts
  - deploy/test/security-regressions.test.ts
gaps:
  - A single-node service restart is not zero-downtime; PM2 delete + start creates a gap and the deploy does not drain connections.
  - There is no automatic rollback after a failed batch or failed end-to-end verification.
  - Rolling-batch health checks use only each edge's local /health and each core node's /health; they do not re-test the edge-to-core mTLS path until step 12.
  - The documented symlink + pm2 restart rollback can keep running the old absolute release path because the PM2 config stores an absolute release directory.
  - Database migrations have no down path; an old release may be incompatible with a migrated schema.
  - There is no continuous health monitor or alerting after the deploy exits.
---

# Health Verification, Rollback and Recovery

## 1. Purpose and scope

This part documents the end-to-end verification performed by the deploy engine, the release layout used for rollback, the rollback procedure and its limits, common failure modes and the security constraints around recovery.

It does not own the application health payloads, the storage provisioners or the backup daemon's internal drill. It records how deployment observes them and what an operator can safely do when something fails.

## 2. Design intent (extracted and synthesized from ./design)

The design requires verification stronger than "the process is running":

- every core node answers `/health` over mTLS;
- every edge host completes a mutually authenticated TLS 1.3 handshake with a core node on its own channel;
- every edge backend and public vhost answers;
- PostgreSQL primary/replicas, PgBouncer, Redis, audit/log databases and the backup daemon are reachable;
- a failed rolling batch stops the deploy, leaving the previous release on disk for rollback;
- releases are immutable and `current` is a symlink, so rollback is a pointer change;
- recovery from a bad deploy is possible without rebuilding from scratch.

The design describes zero-downtime rolling updates. The code provides rolling batches with health gates but not connection draining or automatic compensation.

## 3. As-built architecture

### 3.1 Core health

`GET /health` in `core-back/index.ts`:

- is reachable without authentication (but the TLS listener still requires a client certificate);
- reads the background-job queue health when workers are enabled;
- returns `msg: "OK"`, `status: "ok"` when workers are enabled, the queue is reachable and the oldest job is below the threshold;
- returns `msg: "DEGRADED"`, `status: "degraded"` when workers are disabled, the queue cannot be inspected, or the oldest queued job exceeds the threshold;
- stays reachable when the database cannot be read, with `queue.degraded=true` and `QUEUE_HEALTH_UNAVAILABLE`.

`probeCoreHealth()` and `probeCoreService()` run on the core host and use `curl` with the CA and the core certificate as both server and client material. They pass when the body contains `"msg":"OK"` or the literal `OK`. A degraded core fails the probe.

The core certificate also carries clientAuth so this loopback probe can present it.

### 3.2 Edge health

Each edge `GET /health` is unauthenticated and returns `{ status: "ok", service, uptime }`. It does not query core, the database or any dependency.

`probeEdgeService()` and `probeEdgeBackend()` call this endpoint over `http://127.0.0.1:<port>/health` with a 10-second timeout. They pass on `"status":"ok"` or the literal `ok`.

A running edge with a broken core pool therefore passes its local health check; core/SAN/certificate problems are caught only by the cross-host probe or final verification, so the rolling batch gate for edges is liveness, not readiness.

### 3.3 Edge-to-core mTLS

`probeEdgeToCore()` runs on each edge host with that host's own client certificate:

- for each of `admin`, `merchant`, `checkout` present on the host;
- for every derived core URL;
- calls `<coreUrl>/internal/<channel>/health` with `--cacert`, `--cert` and `--key`.

The core channel health routes return `{ status: "ok", channel: "<channel>" }` after the CN guard. The probe passes on `ok` or the channel marker.

This is the critical cross-host check. It verifies:

- DNS/route/reachability to every core node;
- TLS 1.3 handshake and CA trust;
- the server SAN contains the core private IP;
- the client certificate is accepted;
- the CN matches the channel;
- the core process is up.

It does not verify business authorization, database writes or a specific gateway flow.

### 3.4 Public and Fake Rails vhosts

`probePublicVhost()` runs on the edge host and probes every Nginx site except the admin LAN site:

- scheme from the site's `ssl` flag;
- `-k` for self-signed certificates;
- `/health` first, then `/` with an HTTP status fallback;
- passes when any non-empty body is returned.

Fake Rails gets backend and vhost `/health` probes, with `-k` when SSL is enabled. The admin LAN vhost is covered by the edge backend probe; the deploy does not probe it through Nginx.

### 3.5 Storage and backup probes

`probeStorage()` includes:

| Target | Probe |
| :--- | :--- |
| PostgreSQL primary | `pg_isready -h 127.0.0.1 -p <port>` and `psql SELECT 1` with the application user/password. |
| PostgreSQL replicas | Same two probes per replica. |
| PgBouncer | `psql SELECT 1` on `PGBOUNCER_PORT` with the application user/password. |
| Redis | `REDISCLI_AUTH=<password> redis-cli -h 127.0.0.1 -p <port> PING`, expecting `PONG`. |
| Audit DB | `psql SELECT 1` with the audit user/password. |
| Log DB | `psql SELECT 1` with the log user/password. |
| Backup daemon | HTTPS `/health` with the CA and the `backup-client` certificate/key when `BACKUP_ALLOW_INSECURE_HTTP=false`; plain HTTP when it is `true`. With the flag on, the pg-native `archive_command`/`restore_command` also use plain `http://` without a client certificate (the daemon, its health probe and `BACKUP_DAEMON_URL` already followed the flag; the WAL commands hard-coded `https://`, so every archive call failed while the health check passed and `pg_wal` filled the disk). Expects `"status":"ok"` or `ok`. |

The mTLS backup probe presents the `backup-client` certificate/key, matching the daemon's CN allow-list; the daemon's own server certificate is not a client identity and is rejected. When `BACKUP_ALLOW_INSECURE_HTTP=true` the daemon serves plain HTTP and the verifier uses an unauthenticated HTTP probe on the same host/port, so development deployments do not fail on TLS.

### 3.6 Verification aggregation

`verifyDeployment()`:

- probes every core node;
- probes each Fake Rails host;
- for each edge host, probes the edge backends, the edge-to-core handshake for every core URL and the public vhosts;
- appends storage probes;
- returns `{ ok, results }`.

`deploy.ts` prints `PASS`/`FAIL` per result and throws if any result fails. The error message says the previous release is still on disk. It does not switch back automatically.

`--skip-verify` and `--dry-run` skip the step.

### 3.7 Rolling batch gates

For steps 6-10, after deploying every unit in a batch:

- core units use `probeCoreService()`: loopback mTLS `/health` on that service port;
- edge units use `probeEdgeService()`: loopback HTTP `/health`.

A failed probe throws immediately. The cross-host mTLS, public vhost and storage checks run only in step 12 after all roles are deployed.

This means a batch can be declared healthy while the edge cannot reach core, or while the core cannot reach the database. The final verification is the real gate.

### 3.8 Release layout

```text
<REMOTE_DIR>/
├── releases/<TIMESTAMP>/
│   ├── <backend>/            # source, dependencies, .env symlink
│   └── <front>/dist/         # edge hosts
├── shared/
│   ├── .env                  # 0600
│   ├── certs/
│   ├── backups/
│   ├── pm2/<service>.config.cjs
│   └── data/
└── current -> releases/<TIMESTAMP>
```

- Releases are immutable.
- `current` is the only release pointer.
- Nginx static roots use `<remote>/current/<front>/dist`.
- The inline PM2 ecosystem uses an **absolute** `cwd` and script path inside `<releaseDir>`, not the `current` symlink.
- Environment and certificate paths in the service env are absolute after `absoluteEnv()`.

The PM2 detail matters for rollback: changing `current` changes Nginx static assets immediately, but a `pm2 restart <name>` reuses the absolute script/cwd from the process's original start. It does not automatically follow the new symlink.

## 4. Contracts and invariants

- Verification runs after all deployments and before the deploy is declared successful.
- Any failed probe aborts the run with a non-zero exit.
- A core `/health` response of `DEGRADED` is a failure.
- Edge `/health` success is not a readiness guarantee for core connectivity.
- A batch is not a full verification; step 12 is.
- `KEEP_RELEASES` controls how many release directories remain; pruning happens inside `deployService`.
- Rollback does not revert database migrations or restore the pre-migration dump.

## 5. Data / API / config / deployment surface

### Verification commands

- `curl --cacert ... --cert ... --key ... https://127.0.0.1:<corePort>/health`
- `curl http://127.0.0.1:<edgePort>/health`
- `curl ... https://<coreIp>:<corePort>/internal/<channel>/health`
- `curl -k https://127.0.0.1:<nginxPort>/health` for self-signed public vhosts
- `pg_isready`, `psql SELECT 1`, `redis-cli PING`

### Release paths

| Role | Default remote directory |
| :--- | :--- |
| core | `/var/www/pg-core` |
| admin | `/var/www/pg-admin` |
| merchant | `/var/www/pg-merchant` |
| checkout | `/var/www/pg-checkout` |
| Fake Rails | `/var/www/pg-fake-rails` |

### Flags

| Flag | Effect on verification/recovery |
| :--- | :--- |
| `--skip-verify` | Skips step 12. |
| `--dry-run` | Prints probes as commands, executes none. |
| `--keep=<n>` | Changes how many releases remain for rollback. |
| `--fresh` | Bootstraps hosts; no pre-migration dump. |

## 6. Operational usage

### Normal verification

Run the deploy without `--skip-verify`. The output lists every PASS/FAIL with host and check. Treat any FAIL as a release blocker even if the process started.

### Manual rollback of one host

1. List releases:

```bash
ssh <host>
ls -1dt /var/www/pg-<role>/releases/*/
```

2. Choose the previous timestamp and confirm its `shared` environment is compatible. The release-specific app directory has an `.env` symlink to `<remote>/shared/.env` (or `shared/.env.<nodeId>` on a multi-node tier); the shared env is current, not historical. If the env changed, the old code may not match it.

3. Stop and restart the service from the target release, not with `pm2 restart`:

```bash
TARGET=/var/www/pg-<role>/releases/<previous>
ln -sfn "$TARGET" /var/www/pg-<role>/current
"$HOME/.bun/bin/pm2" delete <service> || true
cd "$TARGET/<backend>"
PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" pm2 start pm2-compatible-start.js   --name <service> --interpreter /usr/local/bin/bun --update-env
"$HOME/.bun/bin/pm2" save
```

The shared PM2 config is regenerated on every deploy and points at the latest release. A plain `pm2 restart` is not sufficient because it reuses the absolute path of the currently running release. Re-running the deploy from the previous commit is the cleanest whole-role rollback.

4. Nginx static files follow `current` immediately; verify the vhost after the switch.

5. Re-run verification for that host or role.

### Rollback of the whole deployment

The reliable path is to check out the previous commit and re-run `./deploy/deploy.sh --update --only=<roles>`. Releases are immutable, but the shared `.env`, PM2 config and Nginx config are rewritten by the new run.

### Database recovery

The pre-migration dump is a `pg_dump -Fc` file in `<CORE_REMOTE_DIR>/shared/backups/pre-migrate-<timestamp>.dump`. It is not restored automatically. Recovery requires an operator decision, a target database and a compatible schema. Migrations are forward-only; restoring an old code release against a migrated schema can fail.

### Backup drill recovery

Use the backup daemon's `/v1/drills/run` or the admin backup control to verify a restore. The drill restores into scratch directories and removes them; it does not restore the live database.

### Common failures

| Symptom | Likely cause |
| :--- | :--- |
| `SSH key ... does not exist` | The `*_SSH_KEY_PATH` is wrong or missing on the workstation. |
| `core /health (mTLS) FAIL` | Core did not start, DB credentials are wrong, or workers/queue are degraded. |
| `mTLS -> core /internal/... FAIL` | Wrong client CN/cert, core SAN missing the target IP, or core down. |
| `backup-daemon /health FAIL` | Certificate ownership, missing S3/Barman prerequisite, or daemon config. |
| Pre-migration dump fails | `pg_dump` is absent on the core host or the primary is unreachable. |
| PgBouncer connection fails | No `[databases]` mapping in the generated `pgbouncer.ini`. |

### Security notes

- Keep `deploy.env` at 0600 and `deploy/.certs` private; the CA key never leaves the workstation. Secrets are streamed over SSH stdin, but (superseded for the pre-migration dump, which now uses a PGPASSFILE) the following was recorded earlier: the pre-migration `PGPASSWORD` was embedded in the verbose command and may appear in logs.
- The core port is private and mTLS-only; edge hosts never receive `DATABASE_URL` or `KMS_MASTER_KEY`.
- Protect the edge host and make the backup key readable by `pgbackup`.
- The deploy's `--skip-verify` is not a security control and should not be used for production acceptance.

## 7. Status and deviations

### Implemented

- Core loopback mTLS health.
- Edge local health.
- Edge-to-core mTLS channel health across every core URL.
- Public merchant/checkout vhost probes.
- Fake Rails backend and vhost probes.
- PostgreSQL, PgBouncer, Redis, audit/log and backup-daemon probes.
- Batch-level health gate and final fail-fast verification.
- Immutable release layout and `current` pointer.
- Pre-migration dump artifact.

### Partial

- Batch gates are liveness-only for edges and do not test cross-host mTLS.
- The guide's symlink + `pm2 restart` rollback is incomplete for backend processes.

### Missing / deferred

- Automatic rollback on a failed batch or failed verification.
- Connection draining and a zero-downtime single-node switch.
- Blue/green or canary routing.
- Database down-migrations or an automated point-in-time restore path.
- Post-deploy alerting or a health history.

### Known bugs, risks and limits

- A single-node service has a restart gap; a core restart can make all edges fail for the cooldown window.
- A failed verification leaves the new release as `current` on every deployed host.
- `--skip-verify` can report success with a broken core/edge path.
- Shared `.env` is not versioned per release; backup probe failures can be cert ownership.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/healthVerifierScale.test.ts test/pipeline.test.ts test/rollingDeploy.test.ts
cd deploy/backup-daemon && bun test test/restoreDrillRunner.test.ts
```

Covered:

- probe aggregation at scale;
- pipeline presence and daemon deployment ordering;
- rolling batch splitting;
- restore drill invariant checks and cleanup.

Not covered: a real edge-to-core handshake, Nginx reload/vhost probe, PostgreSQL/PgBouncer/Redis probe, PM2 rollback or live backup-daemon mTLS probe.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6, pipeline verification and recovery.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 5.2, backup/restore control.

### Code paths

- `deploy/lib/healthVerifier.ts`, `deploy/deploy.ts`, `deploy/backup-daemon/src/restoreDrillRunner.ts`.
- Core and edge `index.ts` health payloads; `deploy/DEPLOYMENT_GUIDE.md` rollback text.

### Generated appendices

- `project-design/appendices/stale-claims-register.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Backup-daemon probe follows the HTTP setting (2026-11-04)

- `probeBackupDaemon()` now branches on `BACKUP_ALLOW_INSECURE_HTTP`. The previous unconditional HTTPS probe failed with `wrong version number` against a daemon explicitly configured for plain HTTP.
- The probe label is `backup-daemon /health (mTLS)` or `backup-daemon /health (HTTP)` so the verification report shows which mode was tested.
- The mTLS path is unchanged and remains the default.

## Security hardening (2026-11-05)

The pre-migration dump is taken before migrating in both modes when the database is non-empty or unknown, uses `PGPASSFILE`, and only the newest `KEEP_RELEASES` dumps are kept (see the pipeline part). Migrations remain forward-only. Real WAL-G/bun/barman SHA256 values must be supplied before recovery tooling can be installed (GAP-023).
