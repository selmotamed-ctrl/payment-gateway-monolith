# Deploy Engine

`deploy/` is the operator workstation for the payment gateway. It validates one
`deploy.env`, builds a host plan, creates the internal PKI, bootstraps hosts,
provisions storage, deploys the Node/Bun services and SPAs from timestamped
releases, runs the Fake Rails and synthetic-seed hooks, verifies the stack and
prints an audit summary.

It is not an application runtime and it does not contain the payment domain. The
canonical design for each area lives under
[`project-design/parts/07-deploy/`](../project-design/parts/07-deploy/); this
README is the practical entrypoint.

## 1. Prerequisites

On the operator workstation:

- Bun (required by `deploy/deploy.sh` and `deploy.ts`);
- OpenSSH and `rsync`;
- the private SSH keys referenced by `deploy.env`;
- network access to every `sshHost`;
- optionally `openssl` for certificate inspection.

On target hosts:

- a Debian/Ubuntu-family or Arch-family OS with `sudo` and systemd;
- ports 22 and the role ports reachable;
- public DNS and certificates if `certbot`/`custom` TLS is selected;
- PostgreSQL 18 packages if the managed `PG_*` tier is used;
- S3/MinIO/R2 and optional secondary-vault credentials if backups are enabled.

`--fresh` installs `nginx`, `rsync`, `ufw`, `curl`, `ca-certificates`, `nodejs`,
Bun, PM2 and enables the firewall. It does not install a PostgreSQL client, so
the pre-migration `pg_dump` described below needs one already present on the core
host.

## 2. Files and entrypoints

| Path | Purpose |
| :--- | :--- |
| `deploy/deploy.sh` | Shell guard: requires Bun and `deploy/deploy.env`, then executes `deploy.ts`. |
| `deploy/deploy.ts` | Fourteen-step orchestrator. |
| `deploy/deploy.env.example` | Fully commented configuration template. |
| `deploy/deploy.env` | Operator file; gitignored, keep at mode 0600. |
| `deploy/lib/configSchema.ts` | Dotenv parser, Zod schema, cross-field validation, node grammar, precedence. |
| `deploy/lib/hostPlanner.ts` | Host deduplication, services, Nginx, certs, firewall, storage plan. |
| `deploy/lib/pkiManager.ts` | Internal CA, leaf certificates, SAN drift, distribution. |
| `deploy/lib/firewallConfigurator.ts` | UFW command generation and application. |
| `deploy/lib/sshRunner.ts` | SSH, sudo, rsync and remote file writes. |
| `deploy/lib/healthVerifier.ts` | Post-deploy and edge-to-core probes. |
| `deploy/provisioners/*.ts` | PostgreSQL 18, Redis, audit/log and backup engine provisioners. |
| `deploy/templates/*.tpl` | Live Nginx templates. |
| `deploy/backup-daemon/` | Backup/PITR control plane source and its own manual. |
| `deploy/.certs/` | Local PKI vault; gitignored, keep private. |

`deploy/package.json` scripts:

```bash
cd deploy
bun run deploy       # bun run deploy.ts (deploy.env required)
bun run typecheck    # tsc --noEmit
bun test             # deploy and planner tests
```

The supported entrypoint is `./deploy/deploy.sh`. Running `bun run deploy.ts`
directly is equivalent once the environment file exists.

## 3. Quick start

```bash
cd /home/salem/payment-gateway
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
$EDITOR deploy/deploy.env

./deploy/deploy.sh --dry-run     # validate, plan, print every command
./deploy/deploy.sh --fresh       # first deploy: bootstrap OS, PKI, firewall, storage, services
./deploy/deploy.sh --update      # later deploys: no OS bootstrap, no firewall change
```

Start with `--dry-run`. It validates the real file, builds the whole plan and
prints the topology map plus every local/remote command without executing
anything.

`DEPLOY_MODE=auto` does **not** inspect the remote release directory. In
practice it behaves like `update` unless `--fresh` is passed. Use `--fresh`
explicitly for a new host.

A minimal all-in-one staging box sets every `*_SSH_HOST` to the same address and
uses one SSH key. Ports still have to be distinct. For a managed storage tier,
set `PG_MANAGE_VIA_SSH=true` and fill `PG_PRIMARY_NODE`; the legacy `DB_*` block
is then only a compatibility fallback.

## 4. Command and flag reference

```bash
./deploy/deploy.sh [flags]
```

| Flag | Effect |
| :--- | :--- |
| `--env=<path>` | Use another environment file. The path is resolved from the repository root. `deploy.sh` still requires the default `deploy/deploy.env` to exist. |
| `--only=<roles>` | Deploy only the selected roles/provisioners. Comma-separated. |
| `--nodes=<id,...>` | Limit compute deployment units to the named node ids. Units without a node id never match. |
| `--rolling-batch=<n>` | Override `ROLLING_BATCH_SIZE` for this run. Must be an integer >= 1. |
| `--keep=<n>` | Override `KEEP_RELEASES` (release directories retained per service). |
| `--fresh` | Bootstrap packages, Bun, PM2 and apply UFW. |
| `--update` | Do not bootstrap; also disables an environment `fresh`. |
| `--enforce-firewall` | Apply the current UFW plan without a full bootstrap. |
| `--skip-build` | Reuse the existing `*/dist` builds. Missing edge dist files fail later. |
| `--rebuild` | Ignore the frontend build cache and rebuild every SPA. |
| `--force-restart` | Restart PostgreSQL, PgBouncer, Redis and the backup daemon even when nothing changed (normally they are only reloaded or restarted when their configuration changed). |
| `--skip-verify` | Skip step 12. A deploy can then report success without a live probe. |
| `--rotate-certs` | Regenerate the internal CA and every leaf certificate. |
| `--check-certs` | Read-only certificate expiry table; exit 1 when something is missing, expired or inside `MTLS_RENEW_WITHIN_DAYS` (for cron/alerts). |
| `--dry-run` | Validate and print commands; execute no remote command and skip local builds/verification. |
| `--preflight-only` | Run only the read-only preflight checks, print the report and exit 0/1. No build, PKI, bootstrap or deployment. |
| `--skip-preflight` | Skip the preflight gate (emergency use only; a warning is printed). |
| `--stop-unmanaged` | Allow the preflight to stop only provably safe same-repo dev listeners on selected service ports. |

Unknown options and unknown `--only` roles abort before any SSH connection.
`--only` also accepts backend aliases: `core-back`, `admin-back`, `merchant-back`, `checkout-back`, `fake-rails-back`.

### Preflight (runs before any mutation)

Every deploy runs a read-only preflight inside step 1 after the plan is built and before frontend builds, PKI, bootstrap, storage or PM2. It checks only the selected `--only`/`--nodes` parts plus their required dependencies:

- SSH reachability, key validity and `sudo`;
- OS/tool readiness (fresh installs may bootstrap missing tools; update deploys block);
- disk, memory and clock skew;
- service ports and their owners: free, the current PM2 app (replaceable), an orphan same-tier PM2 app (retireable), a same-repo dev listener (blocked by default, stoppable with `--stop-unmanaged`), or a foreign process (always blocked);
- Nginx ports and `nginx -t`;
- edge-to-core mTLS and database/PgBouncer dependencies when the selected part needs them;
- PostgreSQL data directories, systemd units for storage daemons, and the release identity.

A blocking issue prints PID/cwd/command diagnostics and aborts with **Nothing was built or changed**. The deploy also verifies the new release identity (`APP_RELEASE`/`APP_COMMIT` in `/health`) after each batch and in the final end-to-end verification, so PM2 reporting `online` while an old process serves the port can no longer pass. A partial `--only`/`--nodes` run enforces release identity only on the units it deploys; unchanged tiers remain on their previous release and are health-checked without a release assertion.

```bash
./deploy/deploy.sh --preflight-only --update --only=admin-back
./deploy/deploy.sh --update --stop-unmanaged
```

### Convergence: reload when you can, restart only when you must

Storage services are **converged**, not bounced. Every config file is written
only if its bytes changed (the runner compares before writing), and each service
is then handled by the least disruptive action:

| Service | Down | Config changed | Nothing changed |
| :--- | :--- | :--- | :--- |
| PostgreSQL | start | `reload`, then **restart only if** `pg_settings.pending_restart` | nothing |
| PgBouncer | start | `reload` (SIGHUP); restart only for restart-only settings (`listen_*`, `unix_socket_*`...) or after PostgreSQL restarted | nothing |
| Redis / Valkey | start | restart (this flushes the L2 cache and velocity counters) | nothing |
| Backup daemon | start | restart when its source, env or unit changed | nothing |
| MinIO | install + start | n/a (left alone while healthy) | nothing |

The deploy prints one `services:` line per provisioner (`started`, `restarted`,
`reloaded` or `unchanged`). PgBouncer gets a systemd drop-in
(`KillSignal=SIGINT`, `TimeoutStopSec=15s`): PgBouncer 1.23+ treats SIGTERM as
"wait for every client to disconnect", so a pool with live clients never stopped
and systemd waited out its 90 s timeout (3 times per deploy before this change).
Packages are installed only when missing, and `pacman -Sy` (a partial upgrade)
is never used.

### Frontend builds and the timing report

Frontend builds start in the background at step 2 (in parallel, at most
`ceil(cores/2)` at once) and overlap with storage provisioning; each SPA is
awaited right before the tier that ships it. A build is **skipped** when the
SHA-256 of the frontend source tree plus its deploy-injected build environment
matches the stamp in `dist/.pg-build-stamp` (`--rebuild` forces it). Only the
SPAs of the selected roles are built.

The run ends with the wall-clock time of every step and the slowest remote
commands; any single command over 30 s is flagged as it finishes. Remote
commands over ssh share one multiplexed connection per host
(`PG_DEPLOY_SSH_MUX=0` disables it), and every configured credential value is
masked in logs and error messages.

### Stress-testing the deploy

`bun run stress` (from `deploy/`) drives the real engine against this machine's
real services under load, faults and tampering. See
[`stress/README.md`](stress/README.md).

### Roles accepted by `--only`

Compute: `db`, `core`, `admin`, `merchant`, `checkout`, `fake-rails`.

Storage: `pg`, `pg-primary`, `pg-replica`, `pgbouncer`, `redis`, `audit-db`,
`log-db`, `backup`.

Aggregate: `storage` selects all storage provisioners.

`--only` filters both service deployment and storage provisioning. A run that
excludes `core` also skips the Fake Rails/synthetic seed step; the PG-tier
pre-migration dump is skipped, while the legacy path still takes its dump when
`db` is selected.

## 5. Topology model

Every node list uses:

```text
nodeId@sshHost:sshPort:privateIp:servicePort
```

- `nodeId` matches `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.
- `sshHost` and `privateIp` must be IPv4 addresses; DNS names are not accepted
  in node lists.
- `sshPort` and `servicePort` are 1-65535.
- Node ids are unique across every list.
- Private IPs are unique within a list; PostgreSQL primary/replica private IPs
  are globally unique.

The node spec contains only SSH host/port, private IP and service port. SSH
user, key path and sudo password still come from the tier's legacy fields
(`CORE_SSH_USER`, `CORE_SSH_KEY_PATH`, `CORE_SUDO_PASSWORD`, etc.). Roles sharing
one SSH endpoint must use the same credentials.

`planHosts()` groups targets by `sshHost:sshPort`. The topology label is based on
unique endpoints:

| Unique SSH endpoints | Topology |
| ---: | :--- |
| 1 | `single-host` |
| 2 | `split` |
| 3 or more | `distributed` |

A host can carry several roles. Services, Nginx sites, certificate bundles and
firewall rules are unioned per host. The deploy order is storage/legacy DB,
core, Fake Rails, admin, merchant, checkout.

### Compute and storage roles

| Role | Default listener(s) | Exposure |
| :--- | :--- | :--- |
| `core` | `core-back :4000` (mTLS 1.3) | Private; core port only from edge private IPs. |
| `admin` | `admin-back :4101`, Nginx `:8443` | LAN only (`LAN_ALLOWED_CIDRS`). |
| `merchant` | `merchant-back :4102`, Nginx `80/443`, LAN `:8081` | Public for 80/443; LAN listener restricted. |
| `checkout` | `checkout-back :4103`, Nginx `80/443`, LAN `:8082` | Public for 80/443; LAN listener restricted. |
| `fake-rails` | `fake-rails-back :4104`, Nginx `:8444` | Test network; sources from `FAKE_RAILS_ALLOWED_CIDRS`, every core private IP and the legacy `CHECKOUT_PRIVATE_IP` when set. |
| `pg-primary` / `pg-replica` | PostgreSQL `:5432` | Replicas/backup/core as configured. |
| `pgbouncer` | `:6432` | Core only. |
| `redis` | `:6379` | Core and backup. |
| `audit-db` / `log-db` | PostgreSQL `:5432` | Core and backup. |
| `backup` | `pg-backup-daemon :4090` (mTLS) | Core only. |

The rendered map is the operator's first confirmation that deduplication and
node arrays mean what was intended:

```bash
./deploy/deploy.sh --dry-run
```

## 6. Configuration groups

`configSchema.ts` uses a small dotenv parser, not a full dotenv library:

- blank lines and `#` comments are ignored;
- `KEY=value` is required;
- quotes end at the first matching quote, so an inline comment after a quote is
  not part of the value;
- unquoted values are truncated at ` #`;
- there is no variable expansion, `export`, escaped newline or multi-line value;
- duplicate keys overwrite earlier values;
- unknown keys are rejected by `z.strictObject`.

| Group | Main keys | Purpose |
| :--- | :--- | :--- |
| Global | `DEPLOY_MODE`, `DEPLOY_ENV`, `ROLLING_BATCH_SIZE`, `KEEP_RELEASES`, `ROTATE_MTLS_CERTS`, `MTLS_VALIDITY_DAYS`, `LAN_ALLOWED_CIDRS` | Run mode, release retention, certificate lifetime, LAN policy. |
| Legacy database | `DB_MANAGE_VIA_SSH`, `DB_SSH_*`, `DB_PRIVATE_IP`, `DB_ENGINE`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` | One externally managed PostgreSQL 18 database. |
| Compute arrays | `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`, `CORE_BACK_URLS` | Horizontal compute units and optional edge upstream override. |
| Core | `CORE_SSH_*`, `CORE_PRIVATE_IP`, `CORE_PORT`, `CORE_REMOTE_DIR`, `RUN_PRISMA_SEED` | Core host, listener, release root and first seed. |
| Admin | `ADMIN_SSH_*`, `ADMIN_PRIVATE_IP`, `ADMIN_BACK_PORT`, `ADMIN_NGINX_LAN_PORT`, `ADMIN_SSL`, `ADMIN_DOMAIN`, `ADMIN_REMOTE_DIR`, `ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_HELP_PANELS` | LAN admin vhost and runtime UI flags. |
| Merchant | `MERCHANT_SSH_*`, `MERCHANT_PRIVATE_IP`, `MERCHANT_BACK_PORT`, `MERCHANT_HTTP_PORT`, `MERCHANT_HTTPS_PORT`, `MERCHANT_SSL`, `MERCHANT_LAN_*`, `MERCHANT_DOMAIN`, `MERCHANT_SSL_MODE`, `MERCHANT_SSL_CERT_PATH`, `MERCHANT_SSL_KEY_PATH`, `MERCHANT_REMOTE_DIR` | Public and LAN merchant vhosts. |
| Checkout | `CHECKOUT_SSH_*`, `CHECKOUT_PRIVATE_IP`, `CHECKOUT_BACK_PORT`, `CHECKOUT_HTTP_PORT`, `CHECKOUT_HTTPS_PORT`, `CHECKOUT_SSL`, `CHECKOUT_LAN_*`, `CHECKOUT_DOMAIN`, `CHECKOUT_SSL_MODE`, `CHECKOUT_SSL_CERT_PATH`, `CHECKOUT_SSL_KEY_PATH`, `CHECKOUT_REMOTE_DIR` | Public and LAN payer vhosts. |
| Core secrets | `KMS_MASTER_KEY`, `BASE_CURRENCY`, `GATEWAY_TIMEZONE`, `REDIS_URL` | Delivered only to the core host. |
| PostgreSQL 18 | `PG_MANAGE_VIA_SSH`, `PG_VERSION`, `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PG_SSH_*`, `PG_DB_*`, `PG_REPLICATION_*`, `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR`, `PGBOUNCER_*` | Primary, streaming replicas, PgBouncer and data directories. |
| Redis | `REDIS_MANAGE_VIA_SSH`, `REDIS_NODES`, `REDIS_SSH_*`, `REDIS_PASSWORD`, `REDIS_MAXMEMORY` | Cache/velocity tier. |
| Audit database | `AUDIT_DB_MANAGE_VIA_SSH`, `AUDIT_DB_NODE`, `AUDIT_DB_SSH_*`, `AUDIT_DB_NAME`, `AUDIT_DB_USER`, `AUDIT_DB_PASSWORD` | Tamper-evident audit database. |
| Log database | `LOG_DB_MANAGE_VIA_SSH`, `LOG_DB_NODE`, `LOG_DB_SSH_*`, `LOG_DB_NAME`, `LOG_DB_USER`, `LOG_DB_PASSWORD`, `LOG_RETENTION_MONTHS` | Partitioned operational log database. |
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE and OBJECT_STORAGE_NODE`, `BACKUP_SSH_*`, `BACKUP_ENGINE_MODE`, `BACKUP_COMPRESSION`, `BACKUP_ENCRYPTION_KEY_HEX`, `BACKUP_PRIMARY_S3_*`, prefixes/secondary, cron/retention/alert, `BACKUP_DAEMON_*`, catalog/scratch/pgpass, binary paths | WAL-G/Barman engine and daemon. |
| Fake Rails | `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION`, `FAKE_RAILS_SSH_*`, `FAKE_RAILS_PRIVATE_IP`, ports, SSL/domain, public base URL, allowed CIDRs/hosts, tester credentials, JWT/seeder secrets, `SEED_FAKE_RAILS_BLUEPRINTS` | Optional emulator and portal. |
| Synthetic seeder | `RUN_SYNTHETIC_HISTORY_SEED`, `SYNTHETIC_SEED_PROFILE`, `SYNTHETIC_SEED_KEY`, `SYNTHETIC_YEARS_SPAN` | Test-server historical data. |
| Test marker | `IS_TEST_SERVER` | Declaration required by the synthetic seed. |

See [`deploy.env.example`](deploy.env.example) for every key, default and
topology example.

### Precedence

1. Node arrays override legacy single-host fields for planning. SSH user/key/
   sudo still come from the legacy fields.
2. When the PG storage tier is configured (`PG_MANAGE_VIA_SSH`, a primary/
   replica node, or `PG_DB_PASSWORD`), `PG_DB_NAME`, `PG_DB_USER` and
   `PG_DB_PASSWORD` are authoritative. Otherwise the legacy `DB_*` values are
   used, falling back to `PG_DB_*`.
3. A derived `DATABASE_URL` uses the PostgreSQL credentials, primary private IP
   and PgBouncer port when enabled; otherwise the explicit `DATABASE_URL` is
   used. `LEADER_ELECTION_DATABASE_URL` is derived separately (the
   `pgw_session` alias, or a direct URL when PgBouncer is disabled); an explicit
   value in the deploy env overrides the derived one.
4. `CORE_BACK_URLS` wins over derived `https://<core-private-ip>:<port>` URLs.
5. A node's `servicePort` overrides the tier backend port for that node.
6. CLI flags override the corresponding environment value for one run.
7. `ADMIN_SHOW_CHECKLISTS` wins over the legacy
   `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`.

### Validation highlights

- IPv4/CIDR syntax, identifier-safe database names/users and port ranges.
- `DB_ENGINE` must be `postgresql`.
- `DEPLOY_MODE` accepts `auto`, `fresh`, `update`, `rolling_update`.
- `PG_VERSION` accepts one or two digits; it is not restricted to 18.
- Backups require a node, SSH key, S3 bucket and a 64-hex encryption key.
- WAL-G requires the backup node and PostgreSQL primary to share a private IP
  because WAL-G reads the local data directory.
- Node/service-port collisions, duplicate node ids/IPs and conflicting SSH
  credentials are rejected.
- Fake Rails requires its SSH/private-IP/tester/secret fields, rejects a
  production deploy without `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`, and checks
  its ports against other roles.
- The synthetic seed requires `IS_TEST_SERVER=true`, Fake Rails enabled and, in
  production, the Fake Rails production override.

Runtime service environments are forced to `NODE_ENV=production` by the planner,
even when `DEPLOY_ENV` is `development` or `staging`.

## 7. Pipeline

`deploy.ts` is strictly ordered:

| Step | Action |
| :--- | :--- |
| 1 | Validate `deploy.env`, detect SSH conflicts, build and print the plan. |
| 2 | Build admin, merchant and checkout SPAs locally; also Fake Rails when enabled. Admin receives the checklist/help build flags. |
| 3 | Create/reuse/re-sign PKI material, print certificate validity, upload storage certificates. |
| 4 | When fresh or `--enforce-firewall`: prove SSH, bootstrap packages/Bun/PM2 (fresh), apply UFW, read back status. |
| 5 | Provision PostgreSQL 18/Redis/audit/log/backup and take a pre-migration dump; deploy the backup-daemon source when enabled. |
| 6 | Deploy core-back. |
| 7 | Deploy Fake Rails (only when enabled). |
| 8 | Deploy admin. |
| 9 | Deploy merchant. |
| 10 | Deploy checkout. |
| 11 | Run end-to-end verification (before the seed: a release that fails its checks must not be followed by a long seed). |
| 12 | Seed Fake Rails blueprints and optional synthetic history. |
| 13 | Log the retained release count. Actual pruning already happened per service. |
| 14 | Print commit, release timestamp, topology, hosts and certificate expiry. |

A failed batch, provisioning step or verification throws and exits non-zero. The
previous release remains on disk, but there is no automatic rollback.

### Release procedure

For each role/node, `deployService()`:

1. Creates `releases/<timestamp>/` and `shared/{certs,backups,pm2,data}`.
2. Rsyncs the backend source, excluding dependencies, tests, builds, generated
   files and local env/certs.
3. Rsyncs the locally built frontend `dist` for edge/Fake Rails roles and writes
   admin `runtime-config.js`.
4. Writes the host's certificate set and `shared/.env` (mode 0600), then
   symlinks `.env` into the release.
5. Runs `bun install --frozen-lockfile`; core also runs `prisma generate`,
   `migrate-deploy` and optional `db-seed`.
6. Switches `current` to the new release.
7. Writes the inline PM2 ecosystem and runs `pm2 delete` + `pm2 start
   --update-env` + `pm2 save`.
8. Renders only that role's Nginx sites, tests and reloads Nginx.
9. Prunes older releases for that service.

Release layout:

```text
<REMOTE_DIR>/
├── releases/<TIMESTAMP>/
│   ├── <backend>/          # source + .env symlink
│   └── <front>/dist/       # edge/Fake Rails
├── shared/
│   ├── .env                # 0600
│   ├── certs/
│   ├── backups/
│   ├── pm2/<service>.config.cjs
│   └── data/
└── current -> releases/<TIMESTAMP>
```

PM2 runs one fork instance per service with `/usr/local/bin/bun`,
`pm2-compatible-start.js` and an **absolute** release `cwd`. There is no cluster
mode and no connection draining.

`deploy/templates/pm2.core.config.cjs.tpl` and
`deploy/templates/pm2.edge.config.cjs.tpl` are dead files. `deploy.ts` generates
the ecosystem inline; do not use those templates as a reference.

## 8. Rolling updates and node selection

Steps 6-10 split the deployment units of each role into batches:

- batch size is `--rolling-batch` or `ROLLING_BATCH_SIZE` (default 1);
- units inside a batch deploy sequentially;
- after the batch, each unit is health-checked;
- a failed probe stops the run; later batches are not deployed;
- `--nodes` filters compute units by node id, but the plan is still built for the
  whole configuration.

A `--nodes` filter that matches nothing skips the role. A batch size greater than
one can take multiple core nodes down before the post-batch check, reducing
failover capacity.

Batch checks are local liveness only: core uses loopback mTLS `/health`, edges
use loopback HTTP `/health`. The cross-host edge-to-core mTLS and storage checks
run only in step 12.

## 9. Storage provisioning

Storage provisioning runs in step 5 and is gated by the management flags and
`--only`.

### PostgreSQL 18

`postgres18Provisioner.ts` installs `postgresql-<PG_VERSION>`,
`postgresql-contrib` and PgBouncer, writes a tuned `zz-pg-switch.conf`, creates
the application and replication roles, creates physical replication slots, and
initializes each replica with `pg_basebackup -R`. It writes SCRAM `pg_hba`
rules with `hostssl` for remote sources and installs the journal-partition cron.

The provisioner does not write PostgreSQL `ssl`/`ssl_cert_file` settings. Remote
connections require TLS by `pg_hba`, but the effective TLS material depends on
the distribution defaults.

### PgBouncer

PgBouncer runs in transaction mode for the application database on the primary
and replicas. The generated `pgbouncer.ini` maps `PG_DB_NAME` to the local
PostgreSQL port, and adds `pgw_session`, a second alias to the same database
with `pool_mode=session`. The session alias exists for the singleton-worker
leader election (`LEADER_ELECTION_DATABASE_URL`) and for migrations/seeders:
Prisma Migrate takes a session advisory lock (`pg_advisory_lock(72707369)`) that
transaction pooling can strand on a reused backend, producing P1002 on the next
run. The deploy writes the owner/migration URL to a temporary `.env.owner` using
the same session endpoint; the runtime `DATABASE_URL` stays transaction-pooled.
The provisioner proves a login through both aliases before core starts. An
explicit `LEADER_ELECTION_DATABASE_URL` in the deploy env overrides the derived
URL for an external database or pooler; migrations reuse its endpoint with the
owner credentials, and an external pooler must allow the owner on that route.

### Redis

Redis is bound to the private IP plus loopback, requires a password, uses an
RDB snapshot and an LRU memory policy. There is no TLS listener, so the
generated `redis-client` certificate is unused.

### Audit and log databases

The audit database has `audit_records`, a SHA-256 hash chain, an immutability
trigger and append-only grants. The log database has monthly
`attempt_step_logs` and `http_access_logs` partitions, six months of initial
partitions, a retention function and cron. Remote authentication is SCRAM over
`hostssl`; no client certificate is requested.

### Backup engine

`backupEngineProvisioner.ts` installs Barman, compression tools, rclone and
(optionally) WAL-G, creates the `pgbackup` user and directories, writes
`/etc/pg-backup/backup.env`, the WAL-G environment files and the systemd unit,
configures core/audit archiving, verifies targets and deploys the daemon source.
The WAL-G binary is a moving GitHub "latest" Ubuntu 20.04 download and is not
checksum-verified.

## 10. Verification

Step 12 checks:

- every core node `/health` over loopback mTLS; a `DEGRADED` response fails;
- every edge backend `/health` over loopback (liveness only);
- each edge host's own client certificate against every derived core URL on
  `/internal/<channel>/health`;
- public merchant/checkout vhosts from the host (the admin LAN vhost is skipped);
- Fake Rails backend and vhost `/health` when enabled;
- PostgreSQL primary/replicas with `pg_isready` and `psql SELECT 1`;
- PgBouncer `SELECT 1`, Redis `PING`, audit/log `SELECT 1`;
- the backup daemon `/health` over mTLS when configured.

Any failed result aborts the deploy. `--skip-verify` and `--dry-run` skip the
step, so a run can report success without a live probe.

The storage probes were not re-audited for credential exposure in the security pass; treat verbose runner output as sensitive. `pg_basebackup` and the pre-migration `pg_dump` use a `PGPASSFILE`, never `PGPASSWORD`.

## 11. Certificates

`pkiManager.ts` creates a local RSA CA and leaves under `deploy/.certs/`:

- `internal-ca.crt/.key`;
- `core-back.crt/.key` (SAN includes every core private IP, loopback and
  `core-back.internal`);
- `backup-daemon.crt/.key`;
- `fake-rails.crt/.key`;
- `admin-back-client`, `merchant-back-client`, `checkout-back-client`;
- optional `pg-client`, `redis-client`, `audit-db-client`, `log-db-client`,
  `backup-client`.

The CA private key never leaves the workstation. Distribution is host-level:

- core receives the CA, core server pair and generated storage client pairs;
- each edge receives the CA and its own client pair;
- Fake Rails receives the CA and its server pair;
- each storage host receives the CA and its own client pair;
- the backup host receives the CA, backup-daemon server pair, `pg-client` and
  `backup-client`.

Changing a private IP requires updating every `*_PRIVATE_IP`/node-array
`privateIp` and running `--update --enforce-firewall`. The PKI step detects SAN
drift and re-signs leaves from the existing CA. A leaf that expires within
`MTLS_RENEW_WITHIN_DAYS` (default 30) is re-issued by the same CA on the next
deploy; a CA near its end is reported and needs `--rotate-certs`. Public
`certbot` vhosts get a twice-daily `pg-certbot-renew.timer` and an Nginx reload
hook (`/etc/letsencrypt/renewal-hooks/deploy/pg-reload-nginx.sh`).

### Storage mTLS is not consumed

The storage client certificates are generated and uploaded to
`/etc/pg-deploy/certs`, but PostgreSQL, PgBouncer, Redis, audit and log do not
request or verify client certificates. PgBouncer's server leg uses
`server_tls_sslmode=require` without CA verification. Treat storage mTLS as
provisioned material, not an enforced control, until a staging run proves the
engine configuration.

### Certificate ownership

Storage and backup certificates are uploaded through sudo. The backup host path
is `BACKUP_DAEMON_CERT_DIR` (default `/var/lib/pg-backup/shared/certs`).
Certificates are mode 0644, keys 0600 and owned by root. The daemon runs as
`pgbackup`, and the deploy does not chown those files. The daemon may therefore
be unable to read its 0600 key. This is an open readiness gap; a staging run must
confirm effective ownership and startup before backup mTLS is described as
proven.

## 12. Recovery and rollback

### Releases

Releases are immutable and `current` is a symlink. Nginx static roots follow
`current` immediately. Backend PM2 processes do not: the inline ecosystem uses
an absolute release `cwd`, so a plain `pm2 restart` reuses the old release path.

Manual rollback of one host:

```bash
ssh <host>
ls -1dt /var/www/pg-<role>/releases/*/
TARGET=/var/www/pg-<role>/releases/<previous>
ln -sfn "$TARGET" /var/www/pg-<role>/current
"$HOME/.bun/bin/pm2" delete <service> || true
cd "$TARGET/<backend>"
PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" pm2 start pm2-compatible-start.js \
  --name <service> --interpreter /usr/local/bin/bun --update-env
"$HOME/.bun/bin/pm2" save
```

The shared `shared/.env` is current, not historical. If configuration changed,
the old code may not match it. Re-running the deploy from the previous commit is
the cleaner whole-role rollback.

### Pre-migration dump

On a non-fresh deploy with core selected, step 5 runs `pg_dump -Fc` on the core
host against the primary's direct port (never PgBouncer) into:

```text
<CORE_REMOTE_DIR>/shared/backups/pre-migrate-<timestamp>.dump
```

The command authenticates through a private `PGPASSFILE` (no `PGPASSWORD` on the command line), runs under `umask 077` into a 0700 directory, and only the newest `KEEP_RELEASES` dumps are kept. The dump is taken before `migrate deploy` whenever the database is non-empty or unknown. The fresh bootstrap
does **not** install `postgresql-client`, so `pg_dump` must already exist. The
dump is not verified, encrypted, copied off-host or restored automatically. A
fresh install takes no dump. Migrations are forward-only; there is no down path.

### Database and backup recovery

The pre-migration dump is a manual operator decision: choose a target database
and a compatible schema. The backup daemon's drill restores into scratch
clusters and removes them; it does not restore the live database. There is no
automatic restore from the dump.

### Failure behaviour

- A failed batch stops later batches; earlier batches remain on the new release.
- A failed step 12 leaves the new release as `current` on every deployed host.
- There is no automatic rollback or compensation.
- `--skip-verify` can report success with a broken core/edge path.

## 13. Security

- `deploy.env` and `deploy/.certs/` are gitignored. Keep the env file at 0600
  and the vault private.
- The CA private key is never copied to a target host.
- Secrets are streamed over SSH stdin, not written to local temp files.
- Edge environments never receive `DATABASE_URL`, `KMS_MASTER_KEY` or another
  host's client key.
- Core listens on the private network; UFW is the outer ring and mTLS plus the
  channel CN guard are the inner controls.
- Storage probe passwords may still appear in verbose command output; treat
  deploy logs as sensitive. The pre-migration dump and `pg_basebackup` use `PGPASSFILE`.
- Fake Rails is an isolated test service. It has no gateway database credential,
  no direct TLS listener and no inbound rail authentication. Keep it off
  untrusted networks.
- Storage client certificates are not yet consumed, so do not claim end-to-end
  storage mTLS.
- The backup daemon verifies any CA-signed client certificate but does not bind
  a client CN to an operation; a direct mTLS client can call the policy endpoint
  and bypass the core maker-checker workflow.

## 14. Known gaps and caveats

| Gap | Impact |
| :--- | :--- |
| Storage client certificates are generated but not consumed by PostgreSQL, PgBouncer, Redis, audit or log. | Storage mTLS is not an enforced authentication control. |
| Backup/storage certificate files can remain root-owned under a `pgbackup` daemon. | The daemon may fail to read its 0600 key; mTLS startup/probe readiness is unproven. |
| Release pruning happens inside `deployService()`; step 13 only logs the retained count. | The guide's "prune in step 11/13" wording is stale. A multi-service host prunes each service tree separately. |
| `pm2.core.config.cjs.tpl` and `pm2.edge.config.cjs.tpl` are not read. | They are dead templates; the inline ecosystem is authoritative. |
| The fresh bootstrap omits a PostgreSQL client. | The non-fresh pre-migration `pg_dump` can fail on a minimal core host. |
| PgBouncer is provisioned without a `[databases]` mapping. | Core connections to `:6432` can fail. |
| `DEPLOY_MODE=auto` does not detect a missing remote directory. | A new host needs `--fresh`; otherwise the run behaves like an update. |
| `DEPLOY_MODE=rolling_update` is accepted but has no distinct behavior. | It does not provide a different strategy from `auto`/`update`. |
| No automatic rollback or connection draining. | A failed batch/verification leaves the new release current; a single-node restart has a gap. |
| PKI expiry is reported but not enforced. | Expired leaves with matching SANs can be reused. |
| WAL-G is downloaded from a moving "latest" Ubuntu 20.04 URL. | The binary is unpinned, unchecked and may not match the host distribution. |
| Backup target verification uses rclone against the bucket string. | A raw S3 URL with no rclone configuration fails the deploy. |
| Backup "all" includes `audit_db` even when audit is not configured. | A scheduled/triggered full or delta can fail on a core-only installation. |
| Barman health uses the WAL-G `st ls` command. | Barman-only mode can report the S3 target unhealthy and needs WAL-G installed. |
| The weekly shell restore drill only checks the core double-entry invariant. | It is narrower than the daemon's core+audit drill. |
| The embedded Fake Rails widget is blocked by the checkout renderer allowlist/CSP and the seeded SRI array is empty. | The embedded flow cannot load end to end. |
| Fake Rails LYPay/Evo Pay route keys do not match descriptor gateway codes, and the default webhook URL has an extra segment. | Four seeded core flows and default callbacks do not work. See [`fake-rails-back/README.md`](../fake-rails-back/README.md). |

`DEPLOYMENT_GUIDE.md` remains a useful long-form operator guide, but several
paragraphs are stale: `DEPLOY_MODE=auto` detection, prune location, legacy
`DB_*` precedence, and the rollback `pm2 restart` shortcut. The canonical parts
under `project-design/parts/07-deploy/` take precedence.

## 15. Tests

```bash
cd deploy
bun run typecheck
bun test
```

The deploy suites run without PostgreSQL, Redis or remote hosts:

- `test/configScale.test.ts` (13)
- `test/hostPlanner.test.ts` (23)
- `test/hostPlannerScale.test.ts` (6)
- `test/exhaustive-deploy-matrix.test.ts` (20)
- `test/fakeRails.test.ts` (7)
- `test/pipeline.test.ts` (4)
- `test/rollingDeploy.test.ts` (5)
- `test/templates.test.ts` (15)
- `test/pkiScale.test.ts` (5)
- `test/provisioners.test.ts` (18)
- `test/healthVerifierScale.test.ts` (3)

Backup daemon suites:

```bash
cd deploy/backup-daemon
bun run typecheck
bun test
```

Object storage daemon suites:

```bash
cd deploy/object-storage-daemon
bun run typecheck
bun test
```

They include raw mTLS tests (allowed, denied, missing and untrusted certificates,
TLS 1.3 enforcement, a PUT/GET through the TLS-to-HTTP bridge) and a
`RemoteMtlsBlobStore` client test. The openssl-backed cases skip when the CLI is
unavailable; the HTTP surface tests always run. The workspace is part of the
root CI backend matrix.

No test performs a real multi-host deployment, migration, PM2 restart, Nginx
reload, edge-to-core handshake, filesystem/certificate ownership check or live
backup/restore drill. A staging run is required for those.

## 16. Design and operator links

Canonical deploy design:

- [`project-design/parts/07-deploy/00-topology-and-config.md`](../project-design/parts/07-deploy/00-topology-and-config.md)
- [`project-design/parts/07-deploy/01-host-planner.md`](../project-design/parts/07-deploy/01-host-planner.md)
- [`project-design/parts/07-deploy/02-pki.md`](../project-design/parts/07-deploy/02-pki.md)
- [`project-design/parts/07-deploy/03-firewall.md`](../project-design/parts/07-deploy/03-firewall.md)
- [`project-design/parts/07-deploy/04-pipeline.md`](../project-design/parts/07-deploy/04-pipeline.md)
- [`project-design/parts/07-deploy/05-storage-provisioners.md`](../project-design/parts/07-deploy/05-storage-provisioners.md)
- [`project-design/parts/07-deploy/06-backup-daemon.md`](../project-design/parts/07-deploy/06-backup-daemon.md)
- [`project-design/parts/07-deploy/07-health-rollback-and-recovery.md`](../project-design/parts/07-deploy/07-health-rollback-and-recovery.md)

Other operator docs:

- [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) - long-form guide with some stale sections.
- [`backup-daemon/README.md`](backup-daemon/README.md) - backup/PITR control-plane manual.
- [`deploy.env.example`](deploy.env.example) - every deploy key and topology example.
- [`project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md) - generated env catalog.

## 17. Multi-machine topology lab

`deploy/test-matrix/` is a JSON-configured lab harness for any number of machines (see [`test-matrix/README.md`](test-matrix/README.md) and `project-design/parts/08-testing/04-multi-machine-matrix.md`).

```bash
cd deploy
cp test-matrix/machines.example.json test-matrix/machines.local.json   # edit machines/roles/intensity
bun run test-matrix:validate           # schema + derived topologies, no SSH
export LAB_SUDO_PASS                   # only when ssh.sudo.mode = "password"
bun run test-matrix:plan               # write 0600 deploy configs, validate each
bun run test-matrix:bootstrap          # verify key SSH + sudo, peer keys, MinIO, vault
bun run test-matrix --topologies=T1 --intensity=smoke
```

- Topologies are derived from machine roles per family (`single-host`, `split`, `replicated`, `dmz`, `mesh`, `scale`, `chaos`); `machines.two-host-lab.example.json` reproduces the old T1-T8 lab as aliases.
- No password is stored in the JSON or the repo; the sudo password is read from the env var named by `ssh.sudo.passwordEnv`, lab secrets are generated into git-ignored `test-matrix/configs/`.
- Reports are written to `test-matrix/reports/<runId>/` with the config hash and resolved intensity.

## Security hardening notes (deploy.env)

- `DEPLOY_ENV` unset means `production`: Fake Rails, `IS_TEST_SERVER`, `FAKE_RAILS_ALLOW_IN_PRODUCTION` and the synthetic seeder are refused. Use `development|staging|test` explicitly.
- Placeholder / low-entropy secrets (`change-me`, `password`, `admin`, repeated or sequential patterns) are rejected; `KMS_MASTER_KEY` needs >= 32 chars. Secrets may not contain quotes, backslash, `$`, backtick or whitespace.
- `BACKUP_WALG_SHA256` (SHA-256 of the pinned WAL-G asset) is required only when WAL-G must be downloaded; an already installed binary is reused. `BUN_SHA256` is needed to install bun (otherwise an existing `/usr/local/bin/bun` or `~/.bun/bin/bun` is reused).
- `--fresh` against a non-empty database is refused unless `--force-fresh` (or `DEPLOY_FORCE_FRESH=1`). Update deploys run `migrate deploy` on the first core node when migrations are pending, after a pre-migration dump.
- PostgreSQL binds `127.0.0.1,<node private IP>`; `PG_RAM_GB` derives memory settings; `PG_IO_METHOD` defaults to `worker`; `PG_REPLICA_REBUILD=true` is needed to re-clone an existing standby.

### Additional hardening notes (2026-11-05)

- `deploy/lib/quoting.ts` is the single quoting helper set used by the provisioners and `deploy.ts`; `backup.env` and `wal-g.env` are rendered `KEY='value'` and a single quote in a value is rejected.
- WAL-G is pinned (`BACKUP_WALG_VERSION=3.0.9`, `BACKUP_WALG_ASSET`) and sha256-verified fail-closed when downloaded; supply `BACKUP_WALG_SHA256` for a fresh install (an installed `wal-g` is reused). barman is pinned (`BACKUP_BARMAN_VERSION=3.10.1`); bun installs from a pinned download verified against `BUN_SHA256` (`BUN_VERSION`), with `unzip` installed by the fresh-host bootstrap.
- The off-site mirror uses `rclone copy`/`rsync` without `--delete` unless `BACKUP_SECONDARY_MIRROR_DELETE=true`.
- The backup daemon authorizes mTLS clients by certificate CN or DNS SAN against `BACKUP_ALLOWED_CLIENT_CNS` (default `backup-client`); verified live on Windows only.
- New optional keys: `BACKUP_WALG_VERSION`, `BACKUP_WALG_ASSET`, `BACKUP_BARMAN_VERSION`, `BUN_VERSION`, `BUN_SHA256`, `BACKUP_ALLOWED_CLIENT_CNS`, `BACKUP_SECONDARY_MIRROR_DELETE`, `BACKUP_S3_ALLOW_INSECURE_HTTP` (managed MinIO over http; independent of the daemon protocol), `KYB_SCANNER_MODE` (`eicar` content gate by default), `PG_RAM_GB`, `PG_IO_METHOD`, `PG_REPLICA_REBUILD`; lab: `LAB_WALG_SHA256`.
- `deploy.env.example` ships `DEPLOY_ENV=production` and placeholder secrets, so it fails validation until you replace them.
- Open: legacy per-service `deploy.yml` workflows deploy without tests, with `StrictHostKeyChecking=no` and `rsync --delete`; the backup daemon runs as the `postgres` user; PostgreSQL TLS is not provisioned. See `project-design/TRACKER.md`.


## Object storage

`OBJECT_STORAGE_NODE` runs `deploy/object-storage-daemon` on port 4095 over mTLS. The deploy installs Bun, creates `pgobjstore`, provisions the vault and certs, opens 4095 only to core and backup private IPs and injects the client cert/KEK into every core and backup host. Certificate distribution is per consumer: a co-located core/backup host never receives the object-storage server key. See `docs/architecture/object-storage-engine.md` and `docs/runbooks/object-storage-operations-and-dr.md`.
