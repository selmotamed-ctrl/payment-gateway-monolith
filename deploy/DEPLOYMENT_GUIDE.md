# Payment Gateway — Multi-Host Deployment Guide

This guide is the operator manual for `deploy/deploy.ts`. It covers the
horizontally scalable compute tiers, the PostgreSQL 18 storage tiers, the
environment reference, the certificate model, the firewall policy, the 14-step
pipeline, backups/restore drills and the recovery procedures.

> The platform is a 7-service monolith plus its storage and backup tiers:
> `core-back` (the only service with a database credential and the
> `KMS_MASTER_KEY`), the three edge APIs (`admin-back`, `merchant-back`,
> `checkout-back`), the three SPAs (`admin-front`, `merchant-front`,
> `checkout-front`), and the optional PostgreSQL 18 / PgBouncer / Redis /
> audit-DB / log-DB / backup-daemon storage nodes.
>
> PostgreSQL 18 is the only supported runtime database. The legacy single-host
> `DB_*` block is a compatibility path; new deployments use the `PG_*` storage
> tier. MySQL/MariaDB are historical and are not supported by `core-back` at
> runtime.

## 1. Quick start

```bash
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
$EDITOR deploy/deploy.env          # fill in hosts, domains, secrets

./deploy/deploy.sh --dry-run       # validate the config and print every action
./deploy/deploy.sh                 # first deploy (fresh bootstrap)
./deploy/deploy.sh --update        # subsequent deploys (no OS changes)
```

Flags:

| Flag | Meaning |
| :--- | :--- |
| `--env=<path>` | Use another `deploy.env` (default `deploy/deploy.env`). |
| `--only=core,checkout` | Deploy only those roles (comma separated). |
| `--fresh` | Bootstrap the OS (packages, ufw, bun, pm2) and enable the firewall. |
| `--update` | Never touch the OS or the firewall. |
| `--enforce-firewall` | Re-apply the UFW rules without a full bootstrap. |
| `--skip-build` | Reuse the existing `*/dist` builds. |
| `--rebuild` | Ignore the frontend build cache (an unchanged SPA is otherwise not rebuilt). |
| `--force-restart` | Restart PostgreSQL, PgBouncer, Redis and the backup daemon even if nothing changed. |
| `--skip-verify` | Skip the end-to-end mTLS health verification. |
| `--rotate-certs` | Regenerate the internal CA **and** every leaf certificate. |
| `--keep=<n>` | Releases kept per host (default `KEEP_RELEASES`). |
| `--rolling-batch=<n>` | Deploy and health-check `n` compute nodes per batch (default `ROLLING_BATCH_SIZE`, or `1`). |
| `--nodes=<id,...>` | Limit the run to the named compute nodes (for example `--nodes=core-1,chk-2`). |
| `--dry-run` | Print every local and remote command, execute nothing. |

The script refuses to start if `deploy.env` is missing or invalid: every value
is validated with Zod before the first SSH connection.

## 1.1 What the bootstrap installs, and what it configures

A `--fresh` run installs `nginx rsync ufw curl ca-certificates` and `nodejs`
(PM2 runs on Node; the applications run on Bun), installs Bun, installs PM2 and
symlinks Bun to `/usr/local/bin/bun` so the PM2 interpreter always resolves.

Database and TLS settings applied automatically because the schema depends on
them:

* **PostgreSQL 18 storage provisioning.** When the `PG_*` fields are enabled,
  the orchestrator installs PostgreSQL 18, writes the tuned
  `zz-pg-switch.conf` (`io_method = 'io_uring'`, `synchronous_commit = on`,
  `wal_level = replica`, replication slots and `pg_stat_statements`), creates
  the application and replication roles, applies the SCRAM `pg_hba` rules,
  initializes every replica with `pg_basebackup -R`, and optionally installs
  PgBouncer in transaction mode on `6432`.
* **TLS for every vhost**, including the LAN-only admin. When a public vhost is
  in `self_signed` mode, or the admin vhost has no certificate, the deploy mints
  a certificate bound to the server name so `nginx -t` always passes.

Storage services (PostgreSQL, PgBouncer, Redis, the backup daemon) are converged,
not restarted: a config change is applied by reload, and a restart happens only
when a setting genuinely needs one (see "Convergence" in `deploy/README.md`). A
second deploy of an unchanged configuration therefore leaves every storage
process running, keeps the Redis cache, and takes seconds instead of minutes.

PM2 applications are restarted with `pm2 delete` + `pm2 start` on every deploy,
not `startOrReload`: PM2 keeps the old `script`/`cwd` when an app is reloaded by
name, which would leave the previous (eventually pruned) release running. The
restart is sub-second on a single-instance fork app.

### A single staging box

Every role may share one host. For the legacy single-host path, point the
application connection at the PostgreSQL 18 listener and keep `DB_SSH_HOST` at
the box:

```dotenv
DB_SSH_HOST="203.0.113.10"
DB_PRIVATE_IP="127.0.0.1"
DB_ENGINE="postgresql"
DB_PORT="5432"
DATABASE_URL="postgresql://pg_core_user:...@127.0.0.1:5432/payment_gateway_prod"
CORE_PRIVATE_IP="203.0.113.10"     # edge -> core mTLS target
MERCHANT_SSL_MODE="self_signed"    # no public DNS on a test box
CHECKOUT_SSL_MODE="self_signed"
```

For a multi-node storage tier, set `PG_MANAGE_VIA_SSH="true"`,
`PG_PRIMARY_NODE="pg-pri@127.0.0.1:22:127.0.0.1:5432"` and leave the legacy
`DB_*` block disabled.

The planner then reports `topology: single-host (1 host(s))` and applies the
union of every role's firewall rules once.

## 1.2 The first administrator (there is no default password)

`prisma/seed.ts` creates the administrator **accounts** (email, role, authority
set, maker/checker flags) but deliberately leaves `password_hash` NULL and the
status `INVITED`: there is no self-service activation and no default password.
Set the first credential on the core host, which is the only host with database
access:

```bash
ssh core-host
cd /var/www/pg-core/current/core-back
set -a; . ./.env; set +a
ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD='Str0ngPassw0rd!' bun run create-admin
```

Flags work too, and any seeded email can be activated:

```bash
bun run create-admin --email compliance@payment-gateway.internal \
  --password 'Str0ngPassw0rd!' --role COMPLIANCE
```

The password policy is **12+ characters with a lowercase letter, an uppercase
letter and a digit**. The command is idempotent: running it again resets the
password, marks the account `ACTIVE` and clears a stale MFA secret. MFA is
**off** by default (the code is delivered through the notification queue, so
only enable it once SMS is configured); pass `--mfa` to require it.

Sign in at the admin portal with the **email** in the "Email or phone" field.
The seeded roles are `GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`,
`COMPLIANCE`, `MLRO`, `OPERATOR` and `SUPPORT`. The sidebar and the router are
gated by the signed-in role's authorities, so use the matching role for each
area:

| Area | Role / authority |
| :--- | :--- |
| Gateways, rails, routes, checkout help | `GATEWAY_ADMIN` (`gateway:*`, `settings:*`) |
| Operator cases (unknown payments) | `OPERATOR` / `SUPPORT` (`case:read`) |
| Disputes | `FINANCE` (`dispute:read`/`dispute:write`) |
| AML queues and reports | `COMPLIANCE` / `MLRO` |
| Profitability and liquidity | `FINANCE` |
| Approvals queue | `SECURITY_ADMIN` (checker) |

A page the role cannot use is not shown, and a direct URL is redirected to the
dashboard rather than rendering a permission error.

## 1.3 Development-only superusers

For testing the admin and merchant portals there is a dedicated bootstrap that
creates a maker/checker admin pair and a merchant superuser attached to a
seeded dev merchant:

```bash
ssh core-host
cd /var/www/pg-core/current/core-back
set -a; . ./.env; set +a
DEV_PASSWORD='DevPassword123!' bun run create-dev-users
```

It creates or re-provisions:

| Account | Default email | Role | Purpose |
| :--- | :--- | :--- | :--- |
| Admin maker | `dev-admin@payment-gateway.local` | `COMPLIANCE` | Full admin portal, all authorities |
| Admin checker | `dev-checker@payment-gateway.local` | `MLRO` | Second admin for four-eyes approvals |
| Merchant superuser | `dev-merchant@payment-gateway.local` | `MERCHANT_ADMIN` | Full merchant portal, attached to `Development Test Merchant` |

The accounts have every authority, MFA disabled and `ACTIVE` status. The
command is idempotent and resets the password on each run. The password is
never stored in the repository; supply it through `DEV_PASSWORD` or
`--password`.

Production is refused by default. On a staging/test box that runs
`NODE_ENV=production`, opt in explicitly:

```bash
DEV_USERS_ALLOW_PRODUCTION=true DEV_PASSWORD='DevPassword123!' bun run create-dev-users
```

Do not leave these accounts enabled on a real production deployment. Override
the emails with `DEV_ADMIN_EMAIL`, `DEV_CHECKER_EMAIL`, `DEV_MERCHANT_EMAIL`
and the merchant display name with `DEV_MERCHANT_NAME`.

## 1.4 LAN access without a domain name

Every operator portal is also published on a **plain LAN port** so it can be
opened by host IP during staging, with no DNS record and no public certificate:

| Portal | URL | Config | Default |
| :--- | :--- | :--- | :--- |
| Admin back office | `https://<host-ip>:8443` | `ADMIN_NGINX_LAN_PORT` | `8443` |
| Merchant portal | `https://<host-ip>:8081` | `MERCHANT_LAN_PORT` | `8081` |
| Checkout (payer) | `https://<host-ip>:8082` | `CHECKOUT_LAN_PORT` | `8082` |

Set either merchant/checkout LAN port to `0` to disable that listener. With
`MERCHANT_LAN_SSL`/`CHECKOUT_LAN_SSL` (default `true`) the LAN listener is
HTTPS with a self-signed certificate whose **SAN contains the host IP**, so the
IP matches even though the issuer is untrusted (browsers still warn; that is
expected on a staging box). Set the flag to `false` for plain HTTP on that
port. The LAN vhosts serve the same SPA build and proxy `/api/` to the same
backend, including the SSE streams.

### Ports and TLS are configurable

Every listener has an explicit port, and TLS is optional per portal:

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `ADMIN_NGINX_LAN_PORT` / `ADMIN_SSL` | `8443` / `true` | Admin listener and whether it terminates TLS. |
| `MERCHANT_HTTP_PORT` / `MERCHANT_HTTPS_PORT` | `80` / `443` | Public merchant ports. |
| `MERCHANT_SSL` | `true` | `false` serves plain HTTP on `MERCHANT_HTTP_PORT` with no redirect and no certificate. |
| `MERCHANT_SSL_MODE` | `certbot` | `certbot` / `custom` / `self_signed`; only used when `MERCHANT_SSL=true`. |
| `CHECKOUT_HTTP_PORT` / `CHECKOUT_HTTPS_PORT` / `CHECKOUT_SSL` | `80` / `443` / `true` | Same for the payer portal. |

With TLS off the deployer owns certificate setup (there is none); the deploy
does not request, install or renew certificates, and the vhost listens on the
plain port. With `self_signed` it mints one; with `certbot` it verifies the
certificate exists and prints the exact `certbot` command if it does not.
Ports must be distinct within a portal, and the merchant and checkout LAN ports
must differ from each other and from the admin port.

Access is restricted by UFW to `LAN_ALLOWED_CIDRS`, so the LAN ports are never
reachable from outside the LAN even though they listen on `0.0.0.0`. The
shipped default covers every private range:

```dotenv
LAN_ALLOWED_CIDRS="127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
```

(Class A `10/8`, Class B `172.16/12`, Class C `192.168/16`, plus loopback.)
The same list is applied to the Nginx `allow` rules and the UFW rules. The
public vhosts stay domain-based and are unaffected.

`ADMIN_DOMAIN`, `MERCHANT_DOMAIN` and `CHECKOUT_DOMAIN` accept a FQDN, a bare
IP, or `_` (the Nginx catch-all). Set `ADMIN_DOMAIN="_"` when the admin portal
is only reached by IP.

## 2. Compute tiers and storage tiers

The orchestrator groups every compute and storage role by its SSH endpoint
(`sshHost:sshPort`). Roles that share an endpoint are one machine; every entry
in a node array still receives its own service plan and PM2/Nginx identity.

### Compute tiers (`1..N` nodes each)

| Tier | Runs | Public exposure |
| :--- | :--- | :--- |
| `CORE_NODES` | `core-back` `:4000` (mTLS 1.3) | **Never** public. Accepts `:4000` only from the edge private IPs. |
| `ADMIN_NODES` | `admin-back` `:4101` + `admin-front` via Nginx `:8443` | LAN only (`LAN_ALLOWED_CIDRS`). |
| `MERCHANT_NODES` | `merchant-back` `:4102` + `merchant-front` via Nginx `80/443` | Public HTTPS. |
| `CHECKOUT_NODES` | `checkout-back` `:4103` + `checkout-front` via Nginx `80/443` | Public HTTPS. |

### Storage tiers (optional, independently scalable)

| Tier | Runs | Exposure |
| :--- | :--- | :--- |
| `PG_PRIMARY_NODE` | PostgreSQL 18 primary | Accepts `5432` from replicas and, when PgBouncer is disabled, core nodes. |
| `PG_REPLICA_NODES` | Streaming read replicas (`1..M`) | Replication from primary/replicas; reads from core nodes or PgBouncer. |
| `PGBOUNCER_ENABLED` | PgBouncer on the primary and each replica, port `6432` | Accepts `6432` from core nodes only. |
| `REDIS_NODES` | Redis 7.4+ cache and velocity engine | Accepts `6379` from core and backup nodes. |
| `AUDIT_DB_NODE` | Dedicated tamper-evident `pg_audit_db` | Accepts PostgreSQL from core and backup nodes. |
| `LOG_DB_NODE` | Dedicated partitioned `pg_logs_db` | Accepts PostgreSQL from core and backup nodes. |
| `BACKUP_NODE` | `pg-backup-daemon` (`:4090` mTLS) + WAL-G/Barman | Accepts `4090` from core nodes only. |

Supported shapes:

- **A — fully distributed:** every compute array and storage node has its own
  host.
- **B — combined compute hosts:** for example admin and core share an internal
  box, merchant and checkout share a public edge box. The script bootstraps
  each host once and merges PM2 apps, Nginx vhosts and firewall rules.
- **C — one staging box:** every role shares one IP; ports stay distinct, mTLS
  is still enforced, and storage roles may co-locate on `5432`.
- **D — horizontal compute:** add `core-2`, `merch-2`, `chk-2`, etc. to the
  node arrays. Edge nodes receive the derived `CORE_BACK_URLS` list and each
  core server certificate SAN contains every core private IP.

`./deploy/deploy.sh --dry-run` prints the resulting **Host Topology Map**,
which is the fastest way to confirm that your deduplication and node arrays are
what you meant.

## 3. Environment reference

### Global

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `DEPLOY_MODE` | `auto` | `auto` (fresh when the remote dir is absent), `fresh`, `update`. |
| `KEEP_RELEASES` | `5` | Releases kept per host; older ones are pruned in step 11. |
| `ROTATE_MTLS_CERTS` | `false` | Force a CA + leaf regeneration. |
| `MTLS_VALIDITY_DAYS` | `825` | Leaf certificate validity. |
| `LAN_ALLOWED_CIDRS` | `127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Nginx allowlist and `ADMIN_LAN_CIDRS` for the admin host. |

### Database (`DB_*`, legacy single-host compatibility path)

| Variable | Notes |
| :--- | :--- |
| `DB_MANAGE_VIA_SSH` | When `true`, the script creates the PostgreSQL 18 database and application role on the DB host through its own sudo access. |
| `DB_SSH_HOST` / `_PORT` / `_USER` / `_KEY_PATH` / `_SUDO_PASSWORD` | SSH target of the database host. |
| `DB_PRIVATE_IP` | The address the core connects to. |
| `DB_ENGINE` | Keep `postgresql`. PostgreSQL 18 is the only supported runtime engine. |
| `DB_PORT` | `5432`. |
| `DB_NAME` / `DB_USER` | Identifier-safe database and role names. |
| `DB_PASSWORD` | The application role password (≥ 8 chars). |
| `DATABASE_URL` | The `postgresql://` connection string the core uses. |

### PostgreSQL 18 storage tier (`PG_*`, `PGBOUNCER_*`, `REDIS_*`, audit/log/backup)

| Variable | Notes |
| :--- | :--- |
| `PG_MANAGE_VIA_SSH` | Install/manage PostgreSQL 18 on the storage nodes. Requires `PG_PRIMARY_NODE`, `PG_SSH_KEY_PATH` and `PG_DB_PASSWORD`. |
| `PG_VERSION` | PostgreSQL major version, default `18`. |
| `PG_PRIMARY_NODE` | One node in `nodeId@sshHost:sshPort:privateIp:servicePort` format. |
| `PG_REPLICA_NODES` | Zero or more streaming replicas in the same format; requires a primary. |
| `PG_DB_NAME` / `PG_DB_USER` / `PG_DB_PASSWORD` | Application database and role. |
| `PG_REPLICATION_USER` / `PG_REPLICATION_PASSWORD` | Physical replication role. Required when replicas are configured. |
| `PGBOUNCER_ENABLED` | Install PgBouncer in transaction mode on the primary and every replica. Requires the `PG_*` storage fields. |
| `PGBOUNCER_PORT` / `PGBOUNCER_DEFAULT_POOL_SIZE` / `PGBOUNCER_MAX_CLIENT_CONN` / `PGBOUNCER_MAX_PREPARED_STATEMENTS` | Pooler listener and limits, defaults `6432` / `50` / `2000` / `256`. |
| `REDIS_MANAGE_VIA_SSH` / `REDIS_NODES` / `REDIS_PASSWORD` / `REDIS_MAXMEMORY` | Dedicated Redis cache/velocity tier; nodes use the same format. `REDIS_URL` remains available for an external Redis. |
| `AUDIT_DB_MANAGE_VIA_SSH` / `AUDIT_DB_NODE` / `AUDIT_DB_NAME` / `AUDIT_DB_USER` / `AUDIT_DB_PASSWORD` | Tamper-evident audit database. |
| `LOG_DB_MANAGE_VIA_SSH` / `LOG_DB_NODE` / `LOG_DB_NAME` / `LOG_DB_USER` / `LOG_DB_PASSWORD` / `LOG_RETENTION_MONTHS` | Partitioned operational/step-log database. |
| `BACKUP_ENABLED` / `BACKUP_NODE` | Enable the backup daemon and its mTLS control plane. Requires an SSH key, S3 bucket and encryption key. |
| `BACKUP_ENGINE_MODE` / `BACKUP_COMPRESSION` / `BACKUP_ENCRYPTION_KEY_HEX` | `wal-g` or `barman`; `zstd`, `lz4`, `lzma`, `brotli` or `none`; exactly 64 hex characters. |
| `BACKUP_PRIMARY_S3_*` / `BACKUP_SECONDARY_SSH_TARGET` | Primary S3/MinIO/R2 target and optional secondary remote vault. |
| `BACKUP_FULL_CRON` / `BACKUP_DELTA_CRON` / `BACKUP_DRILL_CRON` | Full, delta and restore/invariant drill schedules. |
| `BACKUP_RETENTION_FULL_COUNT` / `BACKUP_RETENTION_WAL_DAYS` / `BACKUP_ALERT_LAG_SECONDS` / `BACKUP_DAEMON_PORT` | Retention, lag alert and daemon port, defaults `8` / `14` / `300` / `4090`. |
| `BACKUP_SCHEDULER_ENABLED` / `BACKUP_SCHEDULER_TICK_MS` | Daemon-owned schedule; `false` uses `/etc/cron.d/pg-backup`. |
| `BACKUP_DAEMON_CERT_DIR` / `BACKUP_CATALOG_PATH` / `BACKUP_PGPASSFILE` | Generated daemon mTLS material, catalog and libpq password-file paths. |
| `BACKUP_SCRATCH_DIR` / `BACKUP_SCRATCH_AUDIT_DIR` / `BACKUP_SCRATCH_PORT` / `BACKUP_SCRATCH_AUDIT_PORT` | Core and audit restore-drill scratch paths/ports. |
| `BACKUP_COMMAND_TIMEOUT_MS` / `BACKUP_ALLOW_INSECURE_HTTP` | WAL-G/Barman command timeout and the explicit development-only plain-HTTP switch. |
| `BACKUP_WALG_BIN` / `BACKUP_BARMAN_BIN` / `BACKUP_BARMAN_CLOUD_BIN` / `BACKUP_REDIS_CLI_BIN` | Daemon command binaries. |

Every storage node uses the same `nodeId@sshHost:sshPort:privateIp:servicePort`
format. A PostgreSQL-family role (primary, replica, audit DB, log DB) may
co-locate on `5432`; a storage listener may never collide with a compute
listener on the same SSH endpoint.

### Core (`CORE_*`)

`CORE_SSH_HOST`, `CORE_SSH_PORT`, `CORE_SSH_USER`, `CORE_SSH_KEY_PATH`,
`CORE_SUDO_PASSWORD`, `CORE_PRIVATE_IP` (bound and in the certificate SAN),
`CORE_PORT` (default 4000), `CORE_REMOTE_DIR` (default `/var/www/pg-core`),
`RUN_PRISMA_SEED` (`true` on the first deploy only).

### Admin (`ADMIN_*`)

`ADMIN_SSH_*`, `ADMIN_SUDO_PASSWORD`, `ADMIN_PRIVATE_IP`,
`ADMIN_BACK_PORT` (4101), `ADMIN_NGINX_LAN_PORT` (8443), `ADMIN_DOMAIN`,
`ADMIN_REMOTE_DIR`, `ADMIN_SHOW_CHECKLISTS` (`true` by default; set `false` to
hide every action/export checklist in the admin portal), and
`ADMIN_SHOW_HELP_PANELS` (`true` by default; set `false` to hide the KYB,
approvals and merchants help expansion panels). The legacy
`ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST` key is still honored when the master key
is omitted. The value is written into the release as `runtime-config.js`, so it
takes effect on the next deploy without rebuilding the SPA.

### Merchant (`MERCHANT_*`) and Checkout (`CHECKOUT_*`)

`*_SSH_*`, `*_SUDO_PASSWORD`, `*_PRIVATE_IP`, `*_BACK_PORT` (4102 / 4103),
`*_DOMAIN`, `*_SSL_MODE` (`certbot` | `custom` | `self_signed`),
`*_SSL_CERT_PATH` / `*_SSL_KEY_PATH` (required for `custom`),
`*_REMOTE_DIR`.

### Core-only secrets

| Variable | Notes |
| :--- | :--- |
| `KMS_MASTER_KEY` | Root key for the AES-256-GCM vault and the session signing. **Never** delivered to an edge host. |
| `BASE_CURRENCY` / `GATEWAY_TIMEZONE` | Defaults `LYD` / `Africa/Tripoli`. |
| `REDIS_URL` | Optional external Redis URL; enables the L2 cache, velocity counters and cross-node `InvalidationBus`. When empty, `REDIS_NODES` is used. |

## 4. Certificates (mTLS 1.3)

`deploy/lib/pkiManager.ts` creates the whole PKI in `deploy/.certs/`
(`chmod 600`, gitignored):

- `internal-ca.crt` / `internal-ca.key` — the offline root CA.
- `core-back.crt` / `.key` — the **server** certificate. Its SAN contains
  `IP:<every CORE_NODES private IP>`, `IP:127.0.0.1` and
  `DNS:core-back.internal`. The multi-IP SAN is mandatory: edge hosts reach the
  core nodes by private IP and TLS 1.3 verifies the hostname, so a rolling core
  deploy never breaks mTLS on the remaining nodes.
- `admin-back-client`, `merchant-back-client`, `checkout-back-client` — the
  **client** certificates, `CN=admin-back|merchant-back|checkout-back`.
- `backup-daemon.crt` / `.key` — the backup daemon mTLS **server**
  certificate, SAN-bound to `BACKUP_NODE` and `127.0.0.1`.
- `pg-client`, `redis-client`, `audit-db-client`, `log-db-client` and
  `backup-client` — optional **client** certificates for the storage/backup
  mTLS links, generated only when the corresponding storage tier is enabled.

Least-privilege distribution:

| Host | Receives |
| :--- | :--- |
| `CORE_NODES` | `internal-ca.crt`, `core-back.crt/.key`, and the enabled storage client certificates |
| `ADMIN_NODES` | `internal-ca.crt`, `admin-back-client.crt/.key` |
| `MERCHANT_NODES` | `internal-ca.crt`, `merchant-back-client.crt/.key` |
| `CHECKOUT_NODES` | `internal-ca.crt`, `checkout-back-client.crt/.key` |
| `BACKUP_NODE` | `internal-ca.crt`, `backup-daemon.crt/.key`, `backup-client.crt/.key`, `pg-client.crt/.key` |
| PostgreSQL / Redis / audit / log storage nodes | Only their own storage client certificate and the internal CA |

`internal-ca.key` **never leaves the deployment workstation**. An edge host has
no database credential, no `KMS_MASTER_KEY` and no other host's client key, so
compromising one public host does not compromise the platform.

Rotate: `./deploy/deploy.sh --rotate-certs` (all hosts are updated in the same
run). Certificates are inspected in step 3 and again in the audit summary, with
the remaining validity in days.

### Changing the server IP

The private IP is part of the core certificate SAN, the nginx vhosts, the DB
grants and the UFW rules, so a new LAN address needs one coordinated run:

1. Update every `*_PRIVATE_IP` / `*_SSH_HOST` and every node-array `privateIp`
   in `deploy/deploy.env` to the new address (all roles on one box share it).
2. Run `./deploy/deploy.sh --update --enforce-firewall`. The `--update` flag
   skips OS bootstrap; `--enforce-firewall` re-emits UFW for the new sources.
3. The deploy detects the SAN drift automatically: if `core-back.crt` does not
   contain `IP:<CORE_PRIVATE_IP>`, it re-signs the server **and** client leaf
   certificates from the existing CA (no CA rotation) before distribution, so
   mTLS keeps working without a manual `--rotate-certs`.
4. The LAN self-signed vhost certificates are regenerated on every run with the
   current host IP in their SAN.

The deploy cannot guess the new address, so step 1 is always manual. Live
Playwright specs accept overrides: `PG_ADMIN_URL`, `PG_MERCHANT_URL`,
`PG_CHECKOUT_URL`.

## 5. Firewall policy (UFW)

| Host | Opened | Bound to |
| :--- | :--- | :--- |
| Legacy `DB_HOST` | SSH, `DB_PORT` from `CORE_PRIVATE_IP` | — |
| `CORE_NODES` | SSH, `CORE_PORT` from the admin/merchant/checkout private IPs | — |
| `ADMIN_NODES` | SSH, `ADMIN_NGINX_LAN_PORT` from `LAN_ALLOWED_CIDRS` | `admin-back` on `127.0.0.1` |
| `MERCHANT_NODES` | SSH, 80, 443 | `merchant-back` on `127.0.0.1` |
| `CHECKOUT_NODES` | SSH, 80, 443 | `checkout-back` on `127.0.0.1` |
| PostgreSQL primary | SSH, `5432` from replicas (and from core nodes when PgBouncer is off), `6432` from core nodes when PgBouncer is on | — |
| PostgreSQL replica | SSH, `5432` from primary/other replicas (and core when PgBouncer is off), `6432` from core nodes when PgBouncer is on | — |
| Redis | SSH, `6379` from core and backup nodes | — |
| Audit DB / log DB | SSH, PostgreSQL port from core and backup nodes | — |
| `BACKUP_NODE` | SSH, `BACKUP_DAEMON_PORT` (`4090`) from core nodes | — |

A host that runs several roles gets the union of its rules. The SSH rule is
always emitted, and `ufw --force enable` is the **last** command, so the deploy
can never lock itself out.

## 6. The 14-step pipeline

1. Validate `deploy.env` and print the topology map.
2. Build the SPAs locally (`bun run build`).
3. Generate or verify the multi-node PKI.
4. Bootstrap each unique host (`--fresh`) and apply UFW.
5. Provision the storage engines (PostgreSQL 18 primary/replicas + PgBouncer,
   Redis, audit/log databases, backup engine). On the legacy single-host path,
   create the database/role and take a compressed pre-migration backup into
   `CORE_REMOTE_DIR/shared/backups/`.
6. Deploy `core-back`: rsync, certs, `.env`, `bun install --frozen-lockfile`,
   `prisma generate`, `migrate-deploy`, optional seed, atomic `current`
   symlink, PM2 reload.
7. Optional: deploy `fake-rails-back` + `fake-rails-front`.
8. Deploy `admin-back` + `admin-front` on the LAN vhost.
9. Deploy `merchant-back` + `merchant-front` (unbuffered POS SSE).
10. Deploy `checkout-back` + `checkout-front` (unbuffered payer SSE, strict CSP).
11. Seed Fake Rails blueprints and optional synthetic operational history.
12. Verify: every core node `/health` over mTLS, each edge backend `/health`,
    each edge host completing an mTLS handshake to a healthy core node, the
    public vhosts, PostgreSQL primary/replicas with `pg_isready` + `SELECT 1`,
    PgBouncer, Redis `PING`, audit/log `SELECT 1`, and the backup-daemon
    `/health` over mTLS when configured.
13. Prune old releases.
14. Print the audit summary (commit, release timestamp, hosts, certificate
    expiry).

Steps 6-10 support rolling batches (`--rolling-batch=<n>`), and each batch is
health-checked before the next one starts. `--nodes=<id,...>` limits a run to
named compute nodes. `--only` accepts `core`, `admin`, `merchant`, `checkout`,
`fake-rails`, and the storage targets `pg`, `pg-primary`, `pg-replica`,
`pgbouncer`, `redis`, `audit-db`, `log-db`, `backup` and `storage`.

Release layout on every host:

```
<REMOTE_DIR>/
├── releases/<TIMESTAMP>/
│   ├── <back>/            # the backend source (+ .env symlink)
│   └── <front>/dist/      # the built SPA (edge hosts only)
├── shared/
│   ├── .env               # 0600, symlinked into every release
│   ├── certs/             # only the host's allowed certificate material
│   ├── pm2/<app>.config.cjs
│   └── backups/
└── current -> releases/<TIMESTAMP>
```

## 7. Verification and recovery

If step 10 fails the deploy exits non-zero; the previous release is still on
disk. Roll back one host:

```bash
ssh <host>
ls -1dt /var/www/pg-<role>/releases/*/
ln -sfn /var/www/pg-<role>/releases/<previous> /var/www/pg-<role>/current
pm2 restart pg-<role>-back
```

Roll back every host by re-running `./deploy/deploy.sh --only=...` from a
checkout at the previous commit (the releases are immutable).

Common failures:

| Symptom | Cause / fix |
| :--- | :--- |
| `SSH key '…' does not exist` | Fix `*_SSH_KEY_PATH`; the key must exist on the workstation. |
| `Invalid deploy.env: DATABASE_URL must start with postgresql://` | `DATABASE_URL` must be a PostgreSQL URL. Set `DB_ENGINE="postgresql"` and `DB_PORT="5432"`. |
| `DB_ENGINE must be 'postgresql' when PostgreSQL 18 storage fields are configured` | A `PG_*` field is set while `DB_ENGINE` still says something else. |
| `PG_REPLICA_NODES requires PG_PRIMARY_NODE` | Add exactly one `PG_PRIMARY_NODE` before configuring replicas. |
| `PGBOUNCER_ENABLED requires the PostgreSQL 18 storage fields` | PgBouncer is part of the `PG_*` storage tier; fill `PG_PRIMARY_NODE`/`PG_DB_PASSWORD` or disable the pooler. |
| `missing certificate /etc/letsencrypt/…` | Issue it: `certbot --nginx -d <domain> --agree-tos -m ops@<domain>`. |
| `core /health (mTLS) FAIL` | The core did not start: `pm2 logs pg-core-back`, then check `shared/.env` and the PostgreSQL connectivity. |
| `mTLS -> core /internal/admin/health FAIL` | The client certificate does not match the channel (`CN=admin-back` is required on `/internal/admin`). |
| `backup-daemon /health FAIL` | Check `systemctl status pg-backup-daemon`, `/etc/pg-backup/backup.env`, the S3 bucket credentials and the daemon certificate paths. |
| The whole deploy aborts after step 12 | No host was left broken; the previous release is still on disk. |

## 8. Security notes

- `deploy.env` and `deploy/.certs/` are gitignored; keep `deploy.env` at `0600`.
- A secret is written over SSH stdin (`cat > file`), never via a local temp
  file and never on a command line.
- The core listens on `0.0.0.0` **inside the private network only**; UFW is the
  outer ring and the mTLS CN guard is the inner one.
- `TRUST_PROXY=false` on the core: the edge resolves the client IP and forwards
  it in `x-real-client-ip`, and the core treats it as advisory (the per-token
  CIDR check still applies).
- The edge `.env` files contain no `DATABASE_URL`, no `KMS_MASTER_KEY` and no
  other host's certificate.

## 9. Horizontal multi-node, storage and backup

Every compute tier can be scaled from one host to `1..N` nodes without changing
the service code. Add nodes to the comma-separated arrays in `deploy.env`:

```dotenv
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
MERCHANT_NODES="merch-1@203.0.113.11:22:10.10.3.11:4102,merch-2@203.0.113.12:22:10.10.3.12:4102"
CHECKOUT_NODES="chk-1@203.0.113.21:22:10.10.4.11:4103,chk-2@203.0.113.22:22:10.10.4.12:4103"
```

The format is `nodeId@sshHost:sshPort:privateIp:servicePort`. Node arrays
override the legacy single-host `*_SSH_HOST` / `*_PRIVATE_IP` / `*_BACK_PORT`
fields for planning. Node ids must be unique; private IPs must be unique within
one tier. Roles that share an SSH endpoint are merged into one host, but each
node still receives its own PM2 service and a unique service suffix.

`deploy.ts` derives `CORE_BACK_URLS` as
`https://<core-private-ip>:<core-port>,...` for every edge `.env` and keeps
`CORE_BACK_URL` pointing at the first core node for compatibility. The core
server certificate SAN contains **all** core private IPs, so a rolling deploy
of one core node never breaks mTLS on the others.

Rolling batches are enabled with `--rolling-batch=<n>` (default
`ROLLING_BATCH_SIZE`, or `1`). Within each role the nodes are deployed one
batch at a time, and the batch is health-checked before the next batch starts.
`--nodes=core-1,chk-2` limits a run to named nodes; `--only` accepts the new
storage targets `pg`, `redis`, `audit-db`, `log-db`, `backup` and the aggregate
`storage`.

### Storage provisioning

Enable the dedicated storage fields and set `DB_ENGINE="postgresql"` whenever
any `PG_*` field is in use:

```dotenv
DB_ENGINE="postgresql"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432,pg-rep-2@10.10.10.12:22:10.10.10.12:5432"
PGBOUNCER_ENABLED="true"
PGBOUNCER_PORT="6432"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@10.10.12.10:22:10.10.12.10:5432"
LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@10.10.12.20:22:10.10.12.20:5432"
```

When both the legacy `DB_*` block and the `PG_*` block are present, the planner
derives the connection URL from `DB_NAME` / `DB_USER` / `DB_PASSWORD` (they win
over `PG_DB_*`), so keep the two blocks aligned or use only one path.

After the OS bootstrap the orchestrator runs the modular provisioners:

| Provisioner | What it applies |
| :--- | :--- |
| `postgres18Provisioner` | PostgreSQL 18 install, the exact `zz-pg-switch.conf` tuning (`io_method='io_uring'`, `synchronous_commit=on`, `wal_level=replica`, ...), application/replication roles, SCRAM `pg_hba`, physical replication slots, `pg_basebackup -R` on every replica and PgBouncer transaction pooling (`6432`, `max_prepared_statements=256`). |
| `redisProvisioner` | Redis bound to the node's private IP, `requirepass`, `save 3600 1`, `maxmemory`, and UFW `6379` only from the core + backup nodes. |
| `auditAndLogDbProvisioner` | `pg_audit_db` with the hash-chain table, immutable trigger, least-privilege `SELECT, INSERT` grants and `REVOKE UPDATE, DELETE, TRUNCATE`; `pg_logs_db` with monthly `attempt_step_logs` / `http_access_logs` partitions, six months ahead, the `ensure_log_partitions` retention function and its cron. |
| `backupEngineProvisioner` | WAL-G/Barman, `zstd`, `rclone`, backup-daemon environment + systemd unit (`:4090` mTLS), `archive_command` on the primary and audit DB, S3/secondary-SSH verification, full/delta/drill cron and the scratch-restore invariant verifier. |

The firewall matrix is generated from the same plan: `5432` primary↔replicas,
`6432` from core nodes, `6379` from core + backup, audit/log `5432` from
core + backup, and backup-daemon `4090` from core nodes.

### Backups and restore drills

```dotenv
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_ENGINE_MODE="barman"          # or "wal-g" (co-located with the PG primary)
BACKUP_COMPRESSION="zstd"
BACKUP_ENCRYPTION_KEY_HEX="<64 hex chars; openssl rand -hex 32>"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.example.invalid"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
BACKUP_CORE_S3_PREFIX=""             # default <bucket>/postgres_core
BACKUP_AUDIT_S3_PREFIX=""            # default <bucket>/audit_db
BACKUP_SECONDARY_SSH_TARGET="backup-vault@198.51.100.99:/mnt/offsite-vault/pg"
BACKUP_ALERT_LAG_SECONDS="300"
BACKUP_DAEMON_BIND_HOST=""           # default BACKUP_NODE private IP
BACKUP_FULL_CRON="0 2 * * 0"
BACKUP_DELTA_CRON="0 2 * * 1-6"
BACKUP_DRILL_CRON="0 4 * * 0"
BACKUP_SCHEDULER_ENABLED="true"      # daemon owns the schedule; false uses /etc/cron.d/pg-backup
```

`BACKUP_ENGINE_MODE="wal-g"` requires `BACKUP_NODE` to be co-located with the
PostgreSQL primary because WAL-G reads the local data directory. `barman` is the
supported dedicated-backup-host mode: the provisioner configures Barman
streaming archiving for both the core and audit databases. Restore drills restore
both databases into separate scratch clusters before checking the ledger and
audit-chain invariants.

`BACKUP_ENABLED=true` requires `BACKUP_NODE`, an absolute http(s) S3 endpoint,
an S3 bucket and a 64-hex encryption key. The deploy engine is the single source
of truth: `backupEngineProvisioner` writes `/etc/pg-backup/backup.env` from
`deploy.env`, `deploy.ts` syncs the daemon to `/opt/pg-backup-daemon`, and the
systemd unit is enabled automatically. `deploy/backup-daemon/backup.env.example`
is only a local/troubleshooting reference and must not be copied manually in
production.
The health verifier additionally probes every core node, every
edge node against every core URL, `pg_isready` + `SELECT 1` on the primary and
replicas, PgBouncer on `6432`, Redis `PING`, audit/log `SELECT 1`, and the
backup-daemon `/health` over mTLS. When no storage fields are configured the
original probes and behavior are unchanged.
