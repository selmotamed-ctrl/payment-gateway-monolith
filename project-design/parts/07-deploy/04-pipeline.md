---
id: deploy.pipeline
title: Deployment Pipeline
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - deploy/deploy.ts
  - deploy/deploy.sh
  - deploy/lib/sshRunner.ts
  - deploy/lib/healthVerifier.ts
  - deploy/templates/**
  - deploy/DEPLOYMENT_GUIDE.md
design_sources:
  - design/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
  - design/payment_gateway_deployment_and_guides_architecture.md#2-complete-deploy-directory-structure
  - design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#61-upgraded-deploydeployenvexample-horizontal-node-arrays--individual-storage-solutions
tests:
  - deploy/test/pipeline.test.ts
  - deploy/test/rollingDeploy.test.ts
  - deploy/test/templates.test.ts
  - deploy/test/healthVerifierScale.test.ts
  - deploy/test/provisioners.test.ts
gaps:
  - The deployment guide says pruning happens in step 13 and in step 11; the code prunes inside deployService and step 13 only logs the retained count.
  - deploy/templates/pm2.core.config.cjs.tpl and pm2.edge.config.cjs.tpl are dead; PM2 config is generated inline.
  - The pre-migration backup runs pg_dump on the core host, but the fresh bootstrap installs no PostgreSQL client package and the command embeds PGPASSWORD in the remote command line.
  - There is no automatic rollback after a failed batch or failed verification; earlier batches remain on the new release.
  - Single-node services restart with pm2 delete + pm2 start, so a single-node edge or core restart is not zero-downtime.
  - The deployment guide's DEPLOY_MODE=auto description does not match the code.
---

# Deployment Pipeline

## 1. Purpose and scope

This part documents the actual `deploy/deploy.ts` pipeline: step order, source synchronization, release layout, PM2 and Nginx activation, rolling batches, seeding, verification, pruning, the pre-migration backup and the backup-daemon source deployment.

It does not own configuration validation (`deploy.topology`), planning (`deploy.planner`), PKI (`deploy.pki`), firewall policy (`deploy.firewall`), storage provisioning (`deploy.storage`) or the backup daemon internals (`deploy.backup`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires a strictly ordered deployment so storage and migrations are live before edge traffic switches: validate and plan; build SPAs; ensure PKI; bootstrap hosts and firewall; provision storage and take a pre-migration backup; deploy core; optionally Fake Rails; admin; merchant; checkout; seed; verify; prune; audit summary.

It also requires atomic releases, a symlinked `current`, least-privilege environment/certificate delivery, rolling batches with health checks and a clean rollback path. The code follows this order but differs in several operational details recorded below.

## 3. As-built architecture

### 3.1 Step 1: validate and plan

`main()` parses CLI options, checks that `deploy.env` exists, loads and validates it, runs `findSshConflicts()`, calls `planHosts()`, prints `renderTopology()` and creates an `SshRunner` with `verbose: true`.

A missing file, schema error, cross-field error or SSH credential conflict aborts before any remote command. With `--dry-run`, every later command is logged instead of executed.

### 3.2 Step 2: build SPAs locally

`buildFrontends()` runs `bun run build` locally for `admin-front`, `merchant-front`, `checkout-front` and, when enabled, `fake-rails-front`. Admin builds receive `VITE_SHOW_CHECKLISTS`, `VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST` and `VITE_SHOW_HELP_PANELS` from the deploy config. The step is skipped with `--skip-build` or `--dry-run`; it builds all three SPAs regardless of `--only`.

### 3.3 Step 3: PKI

`buildPki()` creates missing material, reuses valid SAN-covering material, or re-signs leaves on SAN drift. `verifyPki()` prints every certificate and remaining days. `uploadStorageCertificates()` writes storage/backup certificate material to `/etc/pg-deploy/certs` or `BACKUP_DAEMON_CERT_DIR` for hosts that carry a storage role.

See `deploy.pki` for certificate roles, distribution and the known storage/backup ownership gaps.

### 3.4 Step 4: bootstrap and firewall

`fresh` is computed as:

```text
options.fresh || (options.update ? false : config.DEPLOY_MODE === "fresh")
```

It is **not** `auto` detection of a missing remote directory.

For every host, when `fresh` or `--enforce-firewall`:

- assert the SSH key exists (unless dry-run);
- run `true` to prove connectivity;
- if fresh, detect the OS, install `nginx rsync ufw curl ca-certificates nodejs` (or the Arch equivalent), install Bun if absent, symlink Bun/bunx into `/usr/local/bin`, install PM2 if absent and best-effort register `pm2 startup systemd`;
- apply UFW, print the command count and read back `ufw status verbose`.

The firewall is only applied in fresh or enforce mode. An ordinary `--update` does not reconcile it.

### 3.5 Step 5: storage and pre-migration backup

The step requires a core host in the plan.

Provisioning is gated by `--only` and by the management flags:

- PostgreSQL 18 primary/replicas/PgBouncer when `PG_MANAGE_VIA_SSH` and the relevant `--only` selection;
- Redis when `REDIS_MANAGE_VIA_SSH`;
- audit/log databases when either management flag is set;
- backup engine plus daemon when `BACKUP_ENABLED`.

The legacy path creates the database/role when `DB_MANAGE_VIA_SSH` and no PG tier is configured. The PG path takes a pre-migration dump from the primary's direct port (never PgBouncer) when the run is not fresh and core is selected. The legacy path takes the dump after database provisioning.

#### Pre-migration backup details

`preMigrationBackup()` resolves the primary direct port (never PgBouncer) and the PG or legacy credentials, then builds `PGPASSWORD="<password>" pg_dump -h <host> -p <port> -U <user> -Fc <db> > <target>.dump`. `backupDatabase()` creates `<CORE_REMOTE_DIR>/shared/backups`, chowns it to the SSH user, and runs the command on the **core host** as that user. The file is `pre-migrate-<releaseTimestamp>.dump`.

No dump is taken on a fresh install. A failure aborts before migrations. `pg_dump` must already exist (the bootstrap package list omits `postgresql-client`), `PGPASSWORD` appears in the verbose remote command, and the dump is not automatically verified or restored.

#### Backup daemon source deployment

After `provisionBackupEngine()`, `deployBackupDaemon()`:

- creates `/opt/pg-backup-daemon` owned by the SSH user;
- rsyncs `deploy/backup-daemon` with `--delete`, excluding `node_modules`, `.git`, `dist`, `test`, `*.log` and `.env`;
- chowns the install directory to `pgbackup:pgbackup`;
- ensures `/usr/local/bin/bun` exists;
- runs `bun install --frozen-lockfile` as `pgbackup`;
- runs `systemctl daemon-reload && systemctl enable pg-backup-daemon && systemctl restart pg-backup-daemon`.

The systemd unit and `/etc/pg-backup/backup.env` are written by the provisioner, not by `deployBackupDaemon()`. If `BACKUP_ENABLED` is true but the plan has no backup host, the deploy warns and skips the daemon; validation normally prevents that.

### 3.6 Steps 6-10: service deployment

The role order is fixed:

| Step | Role | Title |
| :--- | :--- | :--- |
| 6 | core | Deploy core-back to CORE_HOST |
| 7 | fake-rails | Deploy fake-rails-back + fake-rails-front (only when enabled) |
| 8 | admin | Deploy admin-back + admin-front |
| 9 | merchant | Deploy merchant-back + merchant-front |
| 10 | checkout | Deploy checkout-back + checkout-front |

For each role, the pipeline skips excluded roles, collects units for that role (filtered by `--nodes`), splits them into batches of `--rolling-batch` or `ROLLING_BATCH_SIZE` (default 1), deploys each batch sequentially, then probes every unit in the batch. The first failure throws and later batches do not run. A `--nodes` filter that matches nothing skips the role. Units without a node id never match a node filter.

### 3.7 Per-service release procedure

`deployService()`:

1. Creates the timestamped release and `shared/{certs,backups,pm2,data}` directories and chowns the remote tree.
2. Syncs the backend source with rsync, excluding `node_modules`, `.git`, `dist`, `generated`, `test`, `certs`, `.certs`, `*.log` and `.env`; syncs the locally built frontend `dist` for edge roles and writes admin `runtime-config.js`.
3. Writes the host's certificate set and the 0600 `shared/.env`, then symlinks `.env` into the app directory.
4. Runs `bun install --frozen-lockfile`; for core also `bunx prisma generate`, `bun run migrate-deploy` and optional `db-seed`.
5. Switches `current` with `ln -sfn`, writes the inline PM2 ecosystem, runs `pm2 delete`, `pm2 start --update-env` and `pm2 save`.
6. Renders the Nginx sites for that role, symlinks them, removes the default site, runs `nginx -t` and reloads.
7. Prunes with `ls -1dt <remote>/releases/*/ | tail -n +<keep+1> | xargs -r rm -rf`.

The PM2 config uses `pm2-compatible-start.js`, the `/usr/local/bin/bun` interpreter, the absolute release app directory as `cwd`, one fork instance, autorestart with 10 restarts, a 3-second delay and a 15-second kill timeout. There is no cluster mode and no connection draining.

### 3.8 Release layout

```text
<REMOTE_DIR>/
├── releases/<TIMESTAMP>/{<backend>/,<frontend>/dist/}
├── shared/{.env,certs/,backups/,pm2/,data/}
└── current -> releases/<TIMESTAMP>
```

The timestamp is generated once per run and reused across services and hosts. Releases are immutable; `current` is the only mutable pointer.

### 3.9 Step 11: seed

When Fake Rails is enabled and core is selected:

- `bun run seed-fake-rails` in `<CORE_REMOTE_DIR>/current/core-back` when `SEED_FAKE_RAILS_BLUEPRINTS` is true, with a 30-minute timeout;
- `bun run seed-synthetic-history` when `RUN_SYNTHETIC_HISTORY_SEED` is true, with a 60-minute timeout, and a log summary.

The synthetic seed requires `IS_TEST_SERVER=true` and Fake Rails enabled at config validation. The step is skipped in dry-run, when Fake Rails is disabled, or when `--only` excludes core.

### 3.10 Step 12: verify

`verifyDeployment()` collects:

- every core node `/health` over mTLS from that core host (loopback);
- every edge backend `/health` over loopback;
- each edge host's `admin-back`, `merchant-back` and `checkout-back` client certificate against every derived core URL on its channel health endpoint;
- public merchant/checkout vhosts from the host itself (admin LAN vhost skipped);
- Fake Rails backend and vhost when enabled;
- PostgreSQL primary/replicas with `pg_isready` and `psql SELECT 1`;
- PgBouncer `SELECT 1` when enabled;
- Redis `PING` with `REDISCLI_AUTH`;
- audit/log `SELECT 1`;
- backup-daemon `/health` over mTLS when configured.

The run throws if any probe fails. With `--skip-verify` or `--dry-run`, the step is skipped and the deploy can report success without a live probe.

### 3.11 Step 13: prune

Step 13 only logs:

```text
Prune old releases
  kept the last <N> release(s) per host
```

Actual pruning already happened inside each `deployService()` call. The guide's statements that pruning is step 13 or step 11 are historical/wrong. Because pruning is per service, a host with several services prunes each service's release tree separately.

### 3.12 Step 14: audit summary

The final step prints:

- short git commit, if `git` is available;
- release timestamp;
- topology and host count;
- every host and its roles;
- certificate expiry for every PKI certificate, unless dry-run.

It then prints `Deployment complete.` There is no post-deploy state file and no automatic notification.

### 3.13 Dead PM2 templates

`deploy/templates/pm2.core.config.cjs.tpl` and `deploy/templates/pm2.edge.config.cjs.tpl` exist in the repository but are not read by any code path. `deploy.ts` generates the ecosystem file inline in `pm2Ecosystem()`. Treat the templates as dead/deprecated.

## 4. Contracts and invariants

- Steps run in dependency order: storage before core, core before edges.
- A release is assembled in a timestamped directory; `current` switches only after dependencies and env are in place.
- Environment and key material are written with mode 0600.
- Edge `.env` files never contain database or KMS secrets.
- Core migrations run before the core process starts on the new release.
- A failed batch stops later batches.
- Pruning keeps the configured number of most recent release directories per service.
- No deploy step restores the pre-migration dump automatically.

## 5. Data / API / config / deployment surface

### CLI flags

| Flag | Pipeline effect |
| :--- | :--- |
| `--env=<path>` | Select the environment file. |
| `--only=<roles>` | Skip roles and storage provisioners. |
| `--nodes=<ids>` | Filter compute units by node id. |
| `--rolling-batch=<n>` | Batch size. |
| `--keep=<n>` | Release retention override. |
| `--fresh` | Bootstrap packages/Bun/PM2 and apply firewall. |
| `--update` | Do not bootstrap; disables `fresh`. |
| `--enforce-firewall` | Apply firewall without full bootstrap. |
| `--skip-build` | Reuse existing SPA dist. |
| `--skip-verify` | Skip live probes. |
| `--rotate-certs` | Rotate CA and leaves. |
| `--dry-run` | Log commands; no remote execution. |

### Files and commands

- `deploy/deploy.sh`: Bun/env preflight and `exec bun run deploy.ts`.
- `deploy/deploy.ts`: pipeline.
- `deploy/lib/sshRunner.ts`: SSH/sudo/rsync/file streaming.
- `deploy/lib/healthVerifier.ts`: probes.
- `deploy/templates/**`: live Nginx templates and dead PM2 templates.
- Generated release tree on each host.

## 6. Operational usage

```bash
./deploy/deploy.sh --dry-run
./deploy/deploy.sh --fresh
./deploy/deploy.sh --update
./deploy/deploy.sh --only=core --nodes=core-1
./deploy/deploy.sh --only=checkout --rolling-batch=1
./deploy/deploy.sh --update --skip-verify
```

## 7. Status and deviations

### Implemented

- Ordered 14-step pipeline with optional Fake Rails step.
- Strict config/plan validation before SSH.
- Local SPA builds.
- PKI generation/verification and host-level distribution.
- Fresh bootstrap and UFW application.
- Storage provisioning hooks and pre-migration dump.
- Atomic release directories and `current` symlink.
- PM2 inline ecosystem, delete/start/save.
- Nginx template rendering and reload.
- Rolling batches and post-batch probes.
- Fake Rails and synthetic seed hooks.
- End-to-end mTLS/HTTP/storage verification.
- Release pruning per service.
- Audit summary.

### Partial

- `--skip-verify` allows an unverified success.
- Nginx is re-rendered and reloaded once per service role on a multi-service host.
- The local build always builds all SPAs, even for a single-role `--only` run.
- The pre-migration dump is taken but not verified.

### Missing / deferred

- Automatic rollback on a failed batch or failed verification.
- Connection draining or blue/green switching for a single-node edge.
- Migration rollback or automatic restore from the pre-migration dump.
- A machine-readable deployment state/audit artifact.
- Pre-migration dump encryption or off-host copying.

### Known bugs / risks

- `PGPASSWORD` is embedded in the remote command string and can appear in verbose logs.
- The pre-migration dump can fail on a minimal core host without PostgreSQL client tools.
- A rolling batch failure leaves earlier batches on the new release and later batches untouched; there is no automatic compensation.
- `pm2 delete` + `pm2 start` creates a restart gap for a single-node service; the deploy itself does not provide zero downtime.
- A core batch size greater than 1 can take multiple core nodes down before the post-batch check, reducing failover capacity.
- The guide's `DEPLOY_MODE=auto` and prune-step descriptions are stale.
- The PM2 templates are dead code and should not be used as a reference.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test
```

Relevant suites:

- `deploy/test/pipeline.test.ts`: 14-step presence, pg_dump path and backup-daemon deployment ordering.
- `deploy/test/rollingDeploy.test.ts`: batch splitting.
- `deploy/test/templates.test.ts`: environment rendering, PM2 generator, Nginx template rendering.
- `deploy/test/provisioners.test.ts`: provisioner command builders.
- `deploy/test/exhaustive-deploy-matrix.test.ts`: broad plan behavior.

No test performs a real multi-host deployment, migration, PM2 restart or Nginx reload. A live staging run is required for those.

## 9. Source references

### Old design sections

- `design/payment_gateway_deployment_and_guides_architecture.md` section 6, 14-step pipeline.
- `design/payment_gateway_deployment_and_guides_architecture.md` section 2, directory structure.
- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.1, horizontal deployment.

### Code paths

- `deploy/deploy.sh`: entrypoint.
- `deploy/deploy.ts`: all steps, PM2 generator, pre-migration backup and daemon deployment.
- `deploy/lib/sshRunner.ts`: SSH, sudo, rsync and file streaming.
- `deploy/lib/healthVerifier.ts`: verification.
- `deploy/templates/**`: Nginx templates and dead PM2 templates.
- `deploy/DEPLOYMENT_GUIDE.md`: operator manual with stale sections.

### Generated appendices

- `project-design/appendices/stale-claims-register.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.
