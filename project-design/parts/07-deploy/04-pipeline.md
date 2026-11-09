---
id: deploy.pipeline
title: Deployment Pipeline
status: partial
confidence: high
last_verified: 2026-11-07
verified_against: d695518+working-tree
code:
  - deploy/deploy.ts
  - deploy/deploy.sh
  - deploy/lib/frontendBuild.ts
  - deploy/lib/converge.ts
  - deploy/lib/sshRunner.ts
  - deploy/lib/healthVerifier.ts
  - deploy/templates/**
  - deploy/DEPLOYMENT_GUIDE.md
  - deploy/lib/quoting.ts
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#2-complete-deploy-directory-structure
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#61-upgraded-deploydeployenvexample-horizontal-node-arrays--individual-storage-solutions
tests:
  - deploy/test/frontendBuild.test.ts
  - deploy/test/converge.test.ts
  - deploy/test/redactSecrets.test.ts
  - deploy/stress/**
  - deploy/test/ci-workflows.test.ts
  - deploy/test/pipeline.test.ts
  - deploy/test/rollingDeploy.test.ts
  - deploy/test/templates.test.ts
  - deploy/test/healthVerifierScale.test.ts
  - deploy/test/provisioners.test.ts
  - deploy/test/security-regressions.test.ts
gaps:
  - The deployment guide says pruning happens in step 13 and in step 11; the code prunes inside deployService and step 13 only logs the retained count.
  - deploy/templates/pm2.core.config.cjs.tpl and pm2.edge.config.cjs.tpl are dead; PM2 config is generated inline.
  - The pre-migration backup runs pg_dump on the core host, but the fresh bootstrap installs no PostgreSQL client package (the dump now authenticates through a PGPASSFILE rather than PGPASSWORD; see Security hardening).
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

`--force-restart` and `--rebuild` are the two engine-level overrides of the convergence and build-cache behaviour. After loading the config, the runner registers every credential value (any key matching PASSWORD/SECRET/TOKEN/MASTER_KEY/ACCESS_KEY/ENCRYPTION_KEY/JWT/SEED_KEY with a value of at least 8 characters) and masks it **wherever it appears** in logs, the timing report, thrown error messages, the verification report and the final failure line. `redactSecrets` alone only recognised `NAME=value`; the health verifier's pgpass lines (`host:port:db:user:PASSWORD`) and connection URLs were printed in clear before this change.

A missing file, schema error, cross-field error or SSH credential conflict aborts before any remote command. With `--dry-run`, every later command is logged instead of executed. Every logged command line passes through `redactSecrets` (`deploy/lib/sshRunner.ts`), which masks the value of any `NAME=value` whose name contains PASSWORD, PASSWD, SECRET, TOKEN, AUTH, API_KEY, ACCESS_KEY or MASTER_KEY (for example `PGPASSWORD=`, `REDISCLI_AUTH=`); before 2026-11-04 these were printed in the clear.

### 3.2 Step 2: build SPAs locally (background, cached)

`startFrontendBuilds()` (`deploy/lib/frontendBuild.ts`) starts `bun run build` for the SPAs of the **selected roles** (`admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front` when enabled; an `--only=core` run builds none) and **returns immediately**: at most `ceil(cores/2)` (max 4) run at once, output goes to a log file (never a pipe, so a parent blocked in a synchronous ssh call cannot stall a build), and the main loop `await`s each SPA right before the tier that ships it, so the builds overlap with storage provisioning (step 5). A failing build rejects with its log tail where it is awaited; on a failed deploy the remaining builds are killed. Admin builds receive `VITE_SHOW_CHECKLISTS`, `VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST` and `VITE_SHOW_HELP_PANELS`; merchant and Fake Rails builds receive their checkout origin.

**Build cache:** the fingerprint is the SHA-256 of the frontend's source tree (file paths and bytes; `node_modules`, `dist`, `.vite`, coverage and `*.log` excluded; `.env*` included) plus the sorted deploy-injected build environment. A build is skipped when `dist/index.html` exists and `dist/.pg-build-stamp` equals the fingerprint. The stamp records the **post-build** state, because some builds rewrite tracked sources (`unplugin-vue-components` regenerates `src/components.d.ts`), which made a pre-build stamp miss on every run. `--rebuild` ignores the cache; `--skip-build` and `--dry-run` skip the step. `.pg-build-stamp` is excluded from the rsync of `dist`.

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
- if fresh, detect the OS, install `nginx rsync ufw curl ca-certificates nodejs` (or the Arch equivalent), install Bun if absent, symlink Bun/bunx into `/usr/local/bin`, install PM2 if absent and best-effort register `pm2 startup systemd`. For local targets the symlink and `pm2 startup` paths use the orchestrator's OS user/home, not the configured SSH name, which may not exist on the machine;
- apply UFW, print the command count and read back `ufw status verbose`.

The firewall is only applied in fresh or enforce mode. An ordinary `--update` does not reconcile it.

### 3.5 Step 5: storage and pre-migration backup

The step requires a core host in the plan.

Provisioning **converges** rather than restarts (see `deploy.storage` section 16): a second run with unchanged configuration leaves PostgreSQL, PgBouncer, Redis and the backup daemon running and the step takes seconds (it took 4m53s when every service was restarted and PgBouncer waited out three 90 s stop timeouts). Each provisioner reports `started` / `restarted` / `reloaded` / `unchanged` per service on a `services:` line; `--force-restart` restarts them regardless.

Provisioning is gated by `--only` and by the management flags:

- PostgreSQL 18 primary/replicas/PgBouncer when `PG_MANAGE_VIA_SSH` and the relevant `--only` selection;
- Redis when `REDIS_MANAGE_VIA_SSH`;
- audit/log databases when either management flag is set;
- backup engine plus daemon when `BACKUP_ENABLED`.

The legacy path creates the database/role when `DB_MANAGE_VIA_SSH` and no PG tier is configured. The PG path takes a pre-migration dump from the primary's direct port (never PgBouncer) when the run is not fresh and core is selected. The legacy path takes the dump after database provisioning.

#### Pre-migration backup details

`preMigrationBackup()` resolves the primary direct port (never PgBouncer) and the PG or legacy credentials, then builds `PGPASSFILE=<private passfile> pg_dump -h <host> -p <port> -U <user> -Fc <db> > <target>.dump`. `backupDatabase()` creates `<CORE_REMOTE_DIR>/shared/backups`, chowns it to the effective target user (the SSH user for a remote host, the orchestrator's OS user for a local target), and runs the command on the **core host** as that user. The file is `pre-migrate-<releaseTimestamp>.dump`.

No dump is taken on a fresh install. A failure aborts before migrations. `pg_dump` must already exist (the bootstrap package list omits `postgresql-client`), the password no longer appears on the command line (PGPASSFILE), and the dump is not automatically verified or restored.

#### Backup daemon source deployment

After `provisionBackupEngine()`, `deployBackupDaemon()`:

- creates `/opt/pg-backup-daemon` owned by the effective target user (the SSH user remotely, the orchestrator's OS user locally) and hands the source tree (not `node_modules`) to that user for the rsync;
- rsyncs `deploy/backup-daemon` with `--delete`, excluding `node_modules`, `.git`, `dist`, `test`, `*.log` and `.env`;
- hands the source tree back to `postgres:postgres` (the daemon's service user);
- ensures Bun exists and installs a real copy at `/usr/local/bin/bun` (not a symlink through the SSH user's home, which may not be traversable by `postgres`);
- runs `bun install --frozen-lockfile` as `postgres` only when the rsync changed something or `node_modules` is missing;
- chowns the source tree and `/var/lib/pg-backup/.bun-cache` to the daemon account (`backupDaemonUser()`: `postgres` only for WAL-G co-located with the primary, else `pgbackup`) and runs `bun install` as that account with `HOME` and `BUN_INSTALL_CACHE_DIR` set;
- runs `systemctl daemon-reload && systemctl enable pg-backup-daemon`, then **starts the unit if it is down and restarts it only if the source, env, unit or archive environment changed** (or `--force-restart`), logging `backup daemon started|restarted|unchanged`.

After the start/restart decision the same remote script runs `daemonReadinessWait()`: it polls up to 10 s for the unit to be active and to stay active for one more second (so `Restart=always` cannot hide a crash loop), and on failure prints `journalctl -u pg-backup-daemon -n 40 --no-pager` to stderr and exits 1, so a startup failure surfaces in step 5 instead of at the first health probe.

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
3. Writes the host's certificate set and the 0600 per-node environment (`shared/.env` for a single node, `shared/.env.<nodeId>` for a multi-node tier), then symlinks it to `.env` in the release app directory.
4. Runs `bun install --frozen-lockfile`; for core also `bunx prisma generate`, `bun run migrate-deploy` and optional `db-seed`. Migrations run on the first core node in every mode (fresh and update), after step 5's pre-migration dump; other core nodes in a multi-node tier skip them.
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
- PgBouncer `SELECT 1` when enabled, through both the application database and the `pgw_session` leader-election alias;
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

### 3.11a Runner behaviour and the timing report

- **Timings:** every command and write is timed (secrets scrubbed). A command that takes 30 s or more is flagged as it finishes (`! slow command`). After step 14 the deploy prints wall-clock per step and the slowest commands over 1 s.
- **Change detection:** `writeRemoteFile()` returns whether the content changed; `sync()` returns `{ changed, files }` from `rsync --itemize-changes` (directory mtime touches do not count).
- **Multiplexing:** remote targets share one ssh connection per host (`ControlMaster=auto`, `ControlPersist=120`, sockets in a private 0700 `mkdtemp` directory, closed by `SshRunner.close()` at the end or on failure). `PG_DEPLOY_SSH_MUX=0` disables it. Local targets and dry runs never use it.

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
- `deploy/lib/sshRunner.ts`: SSH/sudo/rsync/file streaming. A sudo `writeRemoteFile` to a remote host reads the password line in a small remote script and installs a 0600 temp copy with `sudo install`, so the password can never be written into the file (2026-11-04 fix: the previous `sudo -S bash -c 'cat > file'` wrote the password as line 1 when sudo was NOPASSWD or had a cached timestamp). `capture()` now forwards `timeoutMs`.
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

- The pre-migrate dump uses a PGPASSFILE (no PGPASSWORD on the command line). Credential handling of the health-step storage probes was not re-audited in this change.
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

The unit tests mock the runner. `deploy/stress` (see `testing.deploy-stress`) drives the real engine against real services on the dev box, including the real ssh transport (via `127.0.0.2`), PM2 restarts, Nginx reloads and multi-node rolling deploys; a genuinely separate-machine run is still the job of the multi-machine matrix.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6, 14-step pipeline.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 2, directory structure.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.1, horizontal deployment.

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

## 11. Per-node release isolation (2026-11-03)

`deployService()` now writes `shared/.env.<nodeId>` and points the release's `.env` symlink at it. Releases live under `releases/<nodeId>/<timestamp>` and the atomic switch updates `current-<nodeId>`. The prune command is scoped to that node's release root, so deploying `core-2` cannot delete `core-1`'s current release. Nginx is rendered with the plan's upstream list rather than a single loopback backend port.

## 12. Single-machine ownership and migration fixes (2026-11-04)

- `effectiveTargetUser()`/`effectiveTargetHome()` were added to `deploy/lib/sshRunner.ts`. Release trees, pre-migration backup directories, the backup-daemon install tree and bootstrap Bun/PM2 paths now use the orchestrator's OS user when the target is local, instead of a configured SSH name that may not exist on the machine.
- The backup daemon installs a real `/usr/local/bin/bun` copy so the `postgres` service user can execute it even when the orchestrator's home is not world-traversable.
- Core migrations now run on the first core node in `auto`/`update` mode as well as `fresh` mode. Previously `RUN_PRISMA_SEED=true` could run the seed against a database whose migrations had never been applied.
- The deploy no longer trips over a stale empty migration directory; only committed `migration.sql` files are applied.
- A real single-machine run completed all 14 steps, including core/admin/merchant/checkout releases, Nginx, PM2, storage probes and final verification.

## 13. Backup object store, ownership, orphaned apps (2026-11-04)

Found by deploying the single-machine `deploy/deploy.env` repeatedly until it completed (14/14, Verification OK):

- **Object store**: see `05-storage-provisioners.md` ("Object store provisioning"). The engine installs/starts MinIO when the S3 endpoint is the backup host. MinIO no longer publishes binaries (`dl.min.io` returns 410), so the install uses an existing binary, `BACKUP_MINIO_BINARY_URL`, or a Go source build (~6 min). The install script now fails loudly (an earlier version used `[ -x ] || { a && b; }` under `set -e`, which silently continued past a failed download and started a unit with no binary). Buckets are created with a SigV4-signed `curl`; `mc` is not needed.
- **Database ownership**: `primaryBootstrapSql` ends with `ownershipReconcileSql`: `ALTER DATABASE ... OWNER TO <PG_DB_USER>` and `REASSIGN OWNED` for any non-superuser role owning `public` objects. A database created by an earlier deploy under another role (`core_user` vs `gw_core_user`) otherwise fails the pre-migration `pg_dump` with `permission denied for table _prisma_migrations`.
- **Orphaned PM2 apps**: `retireOrphanedPm2Apps` runs before each service start and deletes same-tier PM2 apps (`<base>` or `<base>-*`) that are not in the plan. Leftover `pg-core-back-core-1/2` and `pg-checkout-back-chk-1/2` from an earlier two-instance topology kept ports 4000/4001 bound with stale credentials, so the new core died with `EADDRINUSE` while `/health` probes hit the stale process and reported `QUEUE_HEALTH_UNAVAILABLE`.
- **Synthetic seed**: an already-seeded database under another seed key is skipped instead of failing (see `01-core-back/10-synthetic-seeder.md` §3.10); the deploy log reports it as skipped.

## Security hardening (2026-11-05)

- **Quoting.** `deploy/lib/quoting.ts` is the single helper set (`shellQuote`, `sqlLiteral`, `sqlIdent`, `dollarTag`, `pgbouncerQuoted`, `pgpassField`, `assertSingleLine`, `envAssign`). Paths are shell-quoted in rm/chown/mkdir/ln/xargs/pm2 commands.
- **Pre-migrate dump.** `pg_dump` uses `PGPASSFILE` (never `PGPASSWORD`), runs under `umask 077` into a 0700 backups directory, and only the newest `KEEP_RELEASES` dumps are kept. The earlier statements in this part that the dump embeds `PGPASSWORD` are superseded.
- **Migrations.** `planMigrations()` is exported; only the first core node migrates. `--fresh` against a non-empty database is refused unless `--force-fresh` or `DEPLOY_FORCE_FRESH=1`; since 2026-11-08 it is refused as well when the emptiness probe FAILED (no PostgreSQL client on the core host, refused connection: `databaseNonEmpty` unknown is no longer treated as empty), except in `--dry-run`. The frontend builds started in step 2 are all awaited (`builds.waitAll()`) before the first service is deployed, so a failed SPA build aborts before the database is migrated and core is switched. Update deploys run `migrate deploy` when migrations are pending or unknown. The dump is taken before migrating in both modes when the database is non-empty or unknown.
- **sshRunner** local-sudo writes use an `mkdtemp` 0700 directory removed in `finally`.
- **Bun** is installed from a pinned download verified against `BUN_SHA256` (no `curl | bash`); the fresh-host bootstrap installs `unzip`, and an existing `/usr/local/bin/bun` or `~/.bun/bin/bun` is reused.
- **Frontend build env**: the deploy injects `VITE_CHECKOUT_BASE_URL` into merchant-front and `VITE_CHECKOUT_ORIGIN` into fake-rails-front from `CHECKOUT_DOMAIN`/ports, so checkout links and hosted-widget postMessage targets do not fall back to the wrong origin.
- **nginx templates**: `server_tokens off` and `limit_req` (with `limit_req_status 429`) in all six; the fakerails vhost gets `allow`/`deny` from `FAKE_RAILS_ALLOWED_CIDRS`, `script-src 'self'`, `object-src 'none'`, and a computed `frame-ancestors` list (self + merchant/checkout origins + loopback) so the hosted widget can still be embedded; the checkout CSP is unchanged.
- **scripts/deploy-localhost.sh** refuses `NODE_ENV=production` unless `LOCAL_TARGET=1`, no longer falls back to default secrets (random secrets via `openssl rand` go to a 0600 `.local/secrets.env` or `LOCAL_SECRETS_FILE`), and requires `DB_PASSWORD`.
- **CI and legacy deploy workflows (GAP-014, RESOLVED 2026-11-05).** `.github/workflows/ci.yml` (jobs `design`, `core-back`, `backend`, `frontend`; triggers push to `master` (the default branch; `main` and `ayoub` are kept), pull requests and manual dispatch; `contents: read`; concurrency-cancelled per ref) runs the AGENTS.md gate: `bun scripts/project-design/build.ts --check`, then for `deploy`, `deploy/backup-daemon`, `admin-back`, `merchant-back`, `checkout-back` and `fake-rails-back` a frozen-lockfile install, typecheck and `bun test`, and for `admin-front`, `merchant-front`, `checkout-front` and `fake-rails-front` a frozen-lockfile install and `bun run build`. **Update 2026-11-08:** the workflow used to list `main`/`ayoub` only, so a push to `master` never ran CI, and it had no database, so every PostgreSQL/Redis suite skipped itself and a ledger regression could pass green. `core-back` now has its own job with `postgres:18` and `redis:7` service containers on the harness ports (`55432`, `56379`), generates the Prisma client and the mTLS test certificates, checks `server_version_num >= 180000`, applies the migrations to the test database, typechecks, runs `bun test` and then FAILS the job when bun reports any skipped test (the full suite reports 0 skips with the services present). The `backend` matrix no longer contains `core-back`. The companion workflow (`companion.yml`) only receives `ANDROID_KEYSTORE_BASE64` and `COMPANION_CONTENT_SIGNING_KEY` on the default branch (job-level `env` is empty elsewhere, so every `if: env.X != ''` step skips): a feature-branch push touching `companion-app/**` can no longer produce a production-signed APK, a signed content update or a release. The per-service `*/.github/workflows/deploy.yml` workflows are now legacy and manual only (`workflow_dispatch` with a typed `deploy` confirmation): they run the service typecheck/tests first, run the deploy job in the `legacy-deploy` environment, use `StrictHostKeyChecking=yes` with a pinned `known_hosts` taken from the **`SSH_KNOWN_HOSTS` secret (which operators must now create, with the server's verified host key lines)**, sync additively (no `rsync --delete`) and never scan the host key on first use. The supported deploy path remains the multi-host engine in `deploy/`. Tests: `deploy/test/ci-workflows.test.ts` (matrix, `master` trigger, the `core-back` job with services and the skip guard, companion secret gating, legacy deploy workflows).
- **Replica pgpass (GAP-028, RESOLVED).** The replica `.pgpass` is streamed over stdin; see `deploy.storage`.
- **Still open.** GAP-023: real WAL-G/bun/barman SHA256 values must be supplied by the operator.

## Remediation round 2 (2026-11-08): auto probe, preflight and step order

`DEPLOY_MODE=auto` now probes every host read-only in step 4 (`lib/hostProbe.ts`, a pure `bootstrapGaps()` over the probe output) and resolves each host to fresh, update or refuse (an edge host whose core has not been migrated is refused before anything changes). A resource preflight warns when PostgreSQL sizing (`PG_RAM_GB`) exceeds the host's memory. Verification (formerly step 12) now runs before the long seed (formerly step 11). `runAsDatabaseOwner` runs migrations and seeders with the owner URL. Tests: `deploy/test/hostProbe.test.ts`, `pipeline.test.ts`.
