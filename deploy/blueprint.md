<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# deploy blueprint

Generated from: `deploy.topology`, `deploy.planner`, `deploy.pki`, `deploy.firewall`, `deploy.pipeline`, `deploy.storage`, `deploy.backup`, `deploy.health`.

## Deploy Topology and Configuration

> Status: `partial` · Last verified: 2026-11-12

## 1. Purpose and scope

This part owns the deployment input contract: `deploy/deploy.env`, its parser, Zod schema, cross-field validation, topology model and the translation from logical roles to concrete hosts. It defines the node grammar, all configuration groups, precedence rules, topology classification and the validation that runs before any SSH connection.

It does not own the host plan itself (see `deploy.planner`), certificate generation (`deploy.pki`), firewall application (`deploy.firewall`), the pipeline (`deploy.pipeline`) or storage provisioning (`deploy.storage`).

The entrypoint is `deploy/deploy.sh`, which requires Bun and a `deploy/deploy.env`, then executes `bun run deploy/deploy.ts`.

## 2. Design intent (extracted and synthesized from ./design)

The design requires a flexible 1..N topology:

- compute tiers `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`;
- one PostgreSQL primary, zero or more streaming replicas and optional PgBouncer;
- optional Redis, dedicated audit and log databases, and a backup node;
- any compute or storage role may share a host, but ports must remain distinct and storage roles may not collide with compute listeners;
- configuration is validated before the first SSH connection, so an invalid IP or missing key fails on the operator workstation rather than halfway through production;
- node arrays override the legacy single-host fields;
- the core certificate SAN and firewall allowlists are derived from the same private IPs.

The design names three topology shapes: fully distributed, split/combined hosts, and a single all-in-one staging box. The code additionally supports horizontal compute arrays.

## 3. As-built architecture

### 3.1 Loading and parsing

`deploy/lib/configSchema.ts` uses a small dotenv parser, not a full dotenv library:

- blank lines and lines starting with `#` are ignored;
- `KEY=value` is required; lines without `=` are ignored;
- single- or double-quoted values end at the first matching quote, so an inline `#` after the quote is not part of the value;
- unquoted values are truncated at ` #`;
- there is no variable expansion, no `export` handling, no escaped-newline handling and no multi-line value support;
- a duplicate key overwrites the earlier value in the parsed record.

The parsed record is validated with `z.strictObject`. Unknown keys are rejected rather than ignored. `loadDeployConfig()` returns either a config plus an empty problem list or a list of Zod issues and cross-field problems.

### 3.2 Node grammar

Every `*_NODES` list, `FAKE_RAILS_NODE`, `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE` and `BACKUP_NODE` uses:

```text
nodeId@sshHost:sshPort:privateIp:servicePort
```

- `nodeId` must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.
- `sshHost` and `privateIp` must be IPv4 addresses. DNS names are not accepted for nodes.
- `sshPort` and `servicePort` must be integers from 1 to 65535.
- Node ids must be unique across every node list.
- A node list rejects duplicate node ids and duplicate `privateIp:servicePort` endpoints. Two nodes may share a private IP when their service ports differ.
- PostgreSQL primary/replica endpoints (`privateIp:servicePort`) must be globally unique.

The node spec carries only host, SSH port, private IP and service port. SSH user, key path and sudo password still come from the tier's legacy fields (`CORE_SSH_USER`, `CORE_SSH_KEY_PATH`, `CORE_SUDO_PASSWORD`, and so on). Two roles on one SSH endpoint must use the same user, key and sudo password.

### 3.3 Configuration groups

| Group | Keys | Purpose |
| :--- | :--- | :--- |
| Global | `DEPLOY_MODE`, `DEPLOY_ENV`, `KEEP_RELEASES`, `ROTATE_MTLS_CERTS`, `MTLS_VALIDITY_DAYS`, `MTLS_RENEW_WITHIN_DAYS`, `LAN_ALLOWED_CIDRS`, `ROLLING_BATCH_SIZE` | Pipeline mode, release retention, certificate rotation and LAN policy. |
| Legacy database | `DB_MANAGE_VIA_SSH`, `DB_SSH_HOST`, `DB_SSH_PORT`, `DB_SSH_USER`, `DB_SSH_KEY_PATH`, `DB_SUDO_PASSWORD`, `DB_PRIVATE_IP`, `DB_ENGINE`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` | Compatibility path for one externally managed PostgreSQL 18 database. |
| Compute node arrays | `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`, `CORE_BACK_URLS` | Horizontal compute tiers and an optional explicit edge upstream list. |
| Core | `CORE_SSH_HOST`, `CORE_SSH_PORT`, `CORE_SSH_USER`, `CORE_SSH_KEY_PATH`, `CORE_SUDO_PASSWORD`, `CORE_PRIVATE_IP`, `CORE_PORT`, `CORE_REMOTE_DIR`, `RUN_PRISMA_SEED` | Core host, listener, release directory and optional seed. |
| Admin | `ADMIN_SSH_*`, `ADMIN_SUDO_PASSWORD`, `ADMIN_PRIVATE_IP`, `ADMIN_BACK_PORT`, `ADMIN_NGINX_LAN_PORT`, `ADMIN_SSL`, `ADMIN_DOMAIN`, `ADMIN_REMOTE_DIR`, `ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS` | Admin host, LAN vhost and runtime UI flags. |
| Merchant | `MERCHANT_SSH_*`, `MERCHANT_SUDO_PASSWORD`, `MERCHANT_PRIVATE_IP`, `MERCHANT_BACK_PORT`, `MERCHANT_HTTP_PORT`, `MERCHANT_HTTPS_PORT`, `MERCHANT_SSL`, `MERCHANT_LAN_PORT`, `MERCHANT_LAN_SSL`, `MERCHANT_DOMAIN`, `MERCHANT_SSL_MODE`, `MERCHANT_SSL_CERT_PATH`, `MERCHANT_SSL_KEY_PATH`, `MERCHANT_REMOTE_DIR` | Merchant host and public/LAN vhosts. |
| Checkout | `CHECKOUT_SSH_*`, `CHECKOUT_SUDO_PASSWORD`, `CHECKOUT_PRIVATE_IP`, `CHECKOUT_BACK_PORT`, `CHECKOUT_HTTP_PORT`, `CHECKOUT_HTTPS_PORT`, `CHECKOUT_SSL`, `CHECKOUT_LAN_PORT`, `CHECKOUT_LAN_SSL`, `CHECKOUT_DOMAIN`, `CHECKOUT_SSL_MODE`, `CHECKOUT_SSL_CERT_PATH`, `CHECKOUT_SSL_KEY_PATH`, `CHECKOUT_REMOTE_DIR` | Checkout host and public/LAN vhosts. |
| Core secrets | `KMS_MASTER_KEY`, `KMS_MASTER_KEY_ID`, `KMS_MASTER_KEY_HEX`, `STORAGE_SHARD_COUNT`, `BASE_CURRENCY`, `GATEWAY_TIMEZONE`, `REDIS_URL` | Delivered only to core; `STORAGE_SHARD_COUNT` selects the 16/32-way GL shard layout. |
| PostgreSQL 18 | `PG_MANAGE_VIA_SSH`, `PG_VERSION`, `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PG_SSH_USER`, `PG_SSH_PORT`, `PG_SSH_KEY_PATH`, `PG_SUDO_PASSWORD`, `PG_DB_NAME`, `PG_DB_USER`, `PG_DB_PASSWORD`, `PG_REPLICATION_USER`, `PG_REPLICATION_PASSWORD`, `PGBOUNCER_ENABLED`, `PGBOUNCER_PORT`, `PGBOUNCER_DEFAULT_POOL_SIZE`, `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_MAX_PREPARED_STATEMENTS`, `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR` | Primary/replica cluster, credentials, pooler and data directories. |
| Redis | `REDIS_MANAGE_VIA_SSH`, `REDIS_NODES`, `REDIS_SSH_USER`, `REDIS_SSH_PORT`, `REDIS_SSH_KEY_PATH`, `REDIS_SUDO_PASSWORD`, `REDIS_PASSWORD`, `REDIS_MAXMEMORY` | Cache/velocity nodes. |
| Audit database | `AUDIT_DB_MANAGE_VIA_SSH`, `AUDIT_DB_NODE`, `AUDIT_DB_SSH_USER`, `AUDIT_DB_SSH_PORT`, `AUDIT_DB_SSH_KEY_PATH`, `AUDIT_DB_SUDO_PASSWORD`, `AUDIT_DB_NAME`, `AUDIT_DB_USER`, `AUDIT_DB_PASSWORD` | Append-only audit database. |
| Log database | `LOG_DB_MANAGE_VIA_SSH`, `LOG_DB_NODE`, `LOG_DB_SSH_USER`, `LOG_DB_SSH_PORT`, `LOG_DB_SSH_KEY_PATH`, `LOG_DB_SUDO_PASSWORD`, `LOG_DB_NAME`, `LOG_DB_USER`, `LOG_DB_PASSWORD`, `LOG_RETENTION_MONTHS` | Partitioned operational log database. |
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE`, `BACKUP_SSH_USER`, `BACKUP_SSH_PORT`, `BACKUP_SSH_KEY_PATH`, `BACKUP_SUDO_PASSWORD`, `BACKUP_ENGINE_MODE` (`pg-native`/`wal-g`/`barman`/`auto`), `BACKUP_LOCAL_REPO_DIR`, `BACKUP_WAL_CLIENT_CNS`, `BACKUP_DAEMON_TIMEOUT_MS`, `BACKUP_COMPRESSION`, `BACKUP_ENCRYPTION_KEY_HEX`, `BACKUP_PRIMARY_S3_*`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET`, cron/retention/alert keys, `BACKUP_DAEMON_*`, `BACKUP_CATALOG_PATH`, `BACKUP_PGPASSFILE`, `BACKUP_SCRATCH_*`, `BACKUP_COMMAND_TIMEOUT_MS`, `BACKUP_ALLOW_INSECURE_HTTP` (daemon protocol), `BACKUP_S3_ALLOW_INSECURE_HTTP` (managed MinIO on http), binary paths, `BARMAN_AUDIT_SERVER` | WAL-G/Barman, daemon listener, catalog, drills and schedule. |
| Fake Rails | `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION`, `FAKE_RAILS_NODE`, `FAKE_RAILS_SSH_*`, `FAKE_RAILS_PRIVATE_IP`, `FAKE_RAILS_BACK_PORT`, `FAKE_RAILS_NGINX_PORT`, `FAKE_RAILS_SSL*`, `FAKE_RAILS_DOMAIN`, `FAKE_RAILS_PUBLIC_BASE_URL`, `FAKE_RAILS_REMOTE_DIR`, `FAKE_RAILS_ALLOWED_CIDRS`, `FAKE_RAILS_ALLOWED_HOSTS`, `FAKE_RAILS_ADMIN_*`, `FAKE_RAILS_JWT_SECRET`, `FAKE_RAILS_SEEDER_TOKEN`, `SEED_FAKE_RAILS_BLUEPRINTS` | Optional emulator and tester portal. |
| Synthetic seeder | `RUN_SYNTHETIC_HISTORY_SEED`, `SYNTHETIC_SEED_PROFILE`, `SYNTHETIC_SEED_KEY`, `SYNTHETIC_YEARS_SPAN` | Test-server-only historical data. |
| Test marker | `IS_TEST_SERVER` | Required for the synthetic seed and used as a test-installation declaration. |

`LAN_ALLOWED_CIDRS` is applied through `withIpv6Loopback()` (`deploy/lib/configSchema.ts`): whenever `127.0.0.1/32` is allowed, `::1/128` is added to the rendered nginx `allow` rules of every LAN vhost (admin, merchant, checkout, Fake Rails) and to `ADMIN_LAN_CIDRS` / `FAKE_RAILS_ALLOWED_CIDRS`. Without it `http://localhost:<port>/` answered `403 Forbidden` (browsers resolve `localhost` to `::1` first and nginx also listens on `[::]`) while `http://127.0.0.1:<port>/` worked. The admin vhost listens on IPv4 only, so clients reach it over `127.0.0.1` after a fallback.

### 3.4 Precedence rules

1. **Node arrays over legacy host fields.** `CORE_NODES` overrides `CORE_SSH_HOST`, `CORE_SSH_PORT`, `CORE_PRIVATE_IP` and `CORE_PORT` for planning. The same applies to admin, merchant and checkout. SSH user/key/sudo are still taken from the legacy fields.
2. **PostgreSQL storage fields over legacy database fields.** When any `PG_*` storage field is configured, `PG_DB_NAME`, `PG_DB_USER` and `PG_DB_PASSWORD` are authoritative. Otherwise `DB_*` is used, falling back to `PG_DB_*`.
3. **Derived database URL.** When the PostgreSQL tier is configured and a host exists, `DATABASE_URL` is derived from the PG credentials, the primary private IP and `PGBOUNCER_PORT` when enabled; otherwise the explicit `DATABASE_URL` is used. The owner/migration URL is derived separately and always uses the session-safe endpoint: an explicit `LEADER_ELECTION_DATABASE_URL` when set, otherwise the deploy-managed `pgw_session` alias, otherwise the direct primary. This applies in the legacy single-role mode too, so Prisma Migrate's advisory lock is never stranded in the transaction pool; the runtime URL does not change. An externally managed pooler is expected to provide the same session route (derived alias or explicit override).
4. **Explicit core URL list.** `CORE_BACK_URLS` wins; otherwise `https://<privateIp>:<servicePort>` for every `CORE_NODES` entry; otherwise the legacy `https://<CORE_PRIVATE_IP>:<CORE_PORT>`.
5. **Node service port over configured backend port.** A node's `servicePort` overrides `CORE_PORT`/`ADMIN_BACK_PORT`/`MERCHANT_BACK_PORT`/`CHECKOUT_BACK_PORT` for that node.
6. **CLI over environment.** `--fresh`, `--update`, `--only`, `--nodes`, `--rolling-batch`, `--keep`, `--rotate-certs`, `--skip-build` and `--skip-verify` override the corresponding configuration for one run.
7. **Admin checklist master flag.** `ADMIN_SHOW_CHECKLISTS` wins over the legacy `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`; the legacy key is the fallback when the master key is absent.

### 3.5 Topology classification

`planHosts()` groups every role target by `sshHost:sshPort`. The topology label is based on the number of unique SSH endpoints, not on the number of roles:

| Unique hosts | Topology |
| :--- | :--- |
| 1 | `single-host` |
| 2 | `split` |
| 3 or more | `distributed` |

A host can carry several roles. Compute services, Nginx sites, certificate bundles and firewall rules are unioned per host. Storage roles are included only when their management flag is enabled (`PG_MANAGE_VIA_SSH`, `REDIS_MANAGE_VIA_SSH`, `AUDIT_DB_MANAGE_VIA_SSH`, `LOG_DB_MANAGE_VIA_SSH`, `BACKUP_ENABLED`), although the storage plan itself is still constructed for display.

### 3.6 Validation rules

Zod field validation:

- IPv4 octets and CIDR syntax are checked.
- Database names, users and replication users must be identifier-safe.
- Remote directories, identifiers and domain names have length and character limits.
- `DB_ENGINE` is restricted to `postgresql`.
- `DEPLOY_MODE` is `auto`, `fresh`, `update` or `rolling_update`.
- `PG_VERSION` is one or two digits (default `18`).
- `BACKUP_ENCRYPTION_KEY_HEX` must be exactly 64 hex characters, or empty; it is required when backups are enabled.
- `BACKUP_PRIMARY_S3_ENDPOINT` must be an absolute HTTP(S) URL when backups are enabled.
- SSL mode is `certbot`, `custom` or `self_signed` for the merchant/checkout public vhosts. The admin vhost has no SSL-mode setting: `ADMIN_SSL` only toggles TLS on the LAN vhost and the deploy mints a self-signed certificate; see `02-pki.md` section 3.8 for the operator-managed public admin front.

Cross-field validation:

- PostgreSQL fields require `DB_ENGINE=postgresql`.
- `PG_REPLICA_NODES` requires exactly one `PG_PRIMARY_NODE`.
- `PG_MANAGE_VIA_SSH=true` requires a primary, an SSH key and a non-empty database password.
- `PGBOUNCER_ENABLED=true` requires the PostgreSQL storage fields.
- Legacy `DB_MANAGE_VIA_SSH=true` without the PG tier requires SSH host, key and private IP.
- When the PG tier is not configured, legacy `DB_NAME`, `DB_USER`, `DB_PASSWORD` and `DATABASE_URL` are required.
- An explicit `DATABASE_URL` must start with `postgresql://`; if `DB_PRIVATE_IP` is set, the URL should contain it.
- Node arrays require the matching `*_SSH_KEY_PATH`.
- Redis/audit/log managed-via-SSH mode requires the node, key and password.
- Backups require `BACKUP_NODE`, an SSH key, a bucket and an encryption key.
- WAL-G backups require `BACKUP_NODE` and `PG_PRIMARY_NODE` to have the same private IP because WAL-G reads the local data directory.
- When the audit database is on a different host from a WAL-G backup node, `PG_AUDIT_DATA_DIR` is required.
- Node ids are unique across all lists; PostgreSQL primary/replica private IPs are unique.
- The same SSH endpoint may not expose the same service port for two compute roles.
- A storage port may not collide with a compute listener on the same SSH endpoint.
- Storage roles on one endpoint may share a port only within the PostgreSQL family (primary, replica, audit, log); Redis, PgBouncer and backup are separate families.
- Merchant and checkout HTTP, HTTPS and LAN ports must differ within each portal; all LAN ports (admin, merchant, checkout) must differ; the two public domains must differ.
- `CORE_PORT` must differ from all three edge backend ports.
- `custom` SSL mode requires both certificate and key paths.
- Fake Rails requires its SSH host/key/private IP/admin credentials/JWT secret/seeder token; it refuses production unless `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`; its backend and Nginx ports must not collide with core/edge/admin ports or public 80/443.
- The synthetic seeder requires `IS_TEST_SERVER=true`, Fake Rails enabled and, in production, the explicit Fake Rails production override.
- `findSshConflicts()` rejects one SSH endpoint with more than one SSH key or user across roles.

### 3.7 Mode behavior

`DEPLOY_MODE` is read as follows:

- `fresh`: bootstrap packages, Bun, PM2 and the firewall;
- `update`: do not bootstrap or change the firewall unless `--enforce-firewall` is passed;
- `auto`: does not stat the remote release directory; in practice it behaves like `update` unless `--fresh` is passed;
- `rolling_update`: accepted by the schema but not treated differently from `auto`.

The CLI `--fresh` always wins; `--update` disables an environment `fresh`.

## 4. Contracts and invariants

- Configuration is validated before any SSH connection.
- The node grammar uses private IPs for peer communication; `sshHost` may be public.
- The same private IP set drives certificate SANs, firewall sources and derived URLs.
- Edge environments never include database or KMS secrets.
- Core environments include `DATABASE_URL`, replication/audit/log URLs, Redis, backup control paths and `KMS_MASTER_KEY` when configured.
- Runtime service environments are forced to `NODE_ENV=production` by the planner even when `DEPLOY_ENV` is development or staging.
- A failure in cross-field validation aborts the run before the plan is rendered.
- `deploy.env` and `deploy/.certs/` are gitignored; the operator must keep the environment file at mode 0600.

## 5. Data / API / config / deployment surface

### CLI

| Flag | Effect |
| :--- | :--- |
| `--env=<path>` | Use another environment file. |
| `--only=core,checkout` | Restrict roles. Storage aliases: `pg`, `pg-primary`, `pg-replica`, `pgbouncer`, `redis`, `audit-db`, `log-db`, `backup`, `storage`. Backend aliases: `core-back`, `admin-back`, `merchant-back`, `checkout-back`, `fake-rails-back`. |
| `--nodes=<id,...>` | Restrict compute units by node id. |
| `--rolling-batch=<n>` | Override `ROLLING_BATCH_SIZE`. |
| `--keep=<n>` | Override `KEEP_RELEASES`. |
| `--fresh`, `--update` | Force bootstrap or no bootstrap. |
| `--enforce-firewall` | Re-apply UFW without a full bootstrap. |
| `--skip-build`, `--skip-verify` | Skip local SPA builds or end-to-end verification. |
| `--rotate-certs` | Rotate the CA and every leaf. |
| `--check-certs` | Print the certificate expiry table and exit 1 when a certificate is missing, expired or inside `MTLS_RENEW_WITHIN_DAYS` (AUTO-28). |
| `--dry-run` | Print commands; execute nothing (preflight prints its checks without connecting). |
| `--preflight-only` | Run the read-only preflight and exit; no build, PKI or deployment. |
| `--skip-preflight` | Skip the preflight gate (emergency use, warns). |
| `--stop-unmanaged` | Allow the preflight to stop safe same-repo dev listeners on selected service ports. |

### Files

- `deploy/deploy.env.example`: documented template with every group and topology examples.
- `deploy/deploy.env`: operator file, gitignored.
- `deploy/DEPLOYMENT_GUIDE.md`: operator manual; it contains a few stale paragraphs (see `project-design/appendices/stale-claims-register.md`).
- `deploy/.certs/`: local PKI vault, gitignored.

## 6. Operational usage

```bash
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
./deploy/deploy.sh --dry-run
./deploy/deploy.sh --fresh
./deploy/deploy.sh --update
./deploy/deploy.sh --only=checkout --nodes=chk-2 --rolling-batch=1
```

Start with `--dry-run`: it validates the real file, builds the plan and prints every remote command, including the topology map. Do not assume `DEPLOY_MODE=auto` will bootstrap a new host; use `--fresh` explicitly.

## 7. Status and deviations

### Implemented

- Strict Zod schema with unknown-key rejection.
- IPv4/CIDR, identifier, port and key-path validation.
- Node grammar for compute and storage tiers.
- Node-array precedence over legacy host fields.
- PG precedence over legacy DB credentials.
- Cross-role SSH conflicts and port-collision detection.
- Topology classification and multi-host planning.
- Fake Rails and synthetic-seed safety guards.

### Partial

- `auto` mode does not implement the documented remote-directory detection.
- `rolling_update` is a schema-only mode.
- The deployment guide contains inconsistent precedence statements.

### Missing / deferred

- No JSON schema export or `deploy.env` autocomplete.
- No validation of explicit `CORE_BACK_URLS` entries in the deploy schema (they are passed through and later used by the edge env).
- No requirement that `PG_VERSION` be exactly `18`.
- No explicit requirement for `PG_REPLICATION_PASSWORD` when replicas are configured (the replica `.pgpass` is now streamed over stdin, GAP-028).

### Known bugs / risks

- A `PG_*` field such as `PG_DB_PASSWORD` alone can make the PostgreSQL tier "configured" without a primary node; the derived `DATABASE_URL` may then be empty while the legacy database fields are no longer required.
- The guide's statement that legacy `DB_*` credentials win over `PG_*` is wrong for the current code.
- `deploy.env.example` describes `DEPLOY_MODE=auto` as "fresh when the remote dir is absent"; the code does not check the remote directory.
- Node arrays share one SSH key/user per tier; per-node SSH credentials are not supported.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test
```

Relevant suites:

- `deploy/test/configScale.test.ts`: node parsing, derived URLs, topology configs.
- `deploy/test/hostPlanner.test.ts`: env parsing, defaults, validation, topology scenarios.
- `deploy/test/hostPlannerScale.test.ts`: multi-node planning and rendering.
- `deploy/test/exhaustive-deploy-matrix.test.ts`: broad topology/config matrix.
- `deploy/test/fakeRails.test.ts`: Fake Rails safety and ports.
- `deploy/test/pipeline.test.ts`: pre-migration and daemon deployment ordering.

These tests run without PostgreSQL/Redis or remote hosts. A real deploy requires SSH access and the target OS packages.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` sections 1-3.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2, service topology.

### Code paths

- `deploy/deploy.sh`: CLI guard.
- `deploy/deploy.ts`: option parsing and pipeline entry.
- `deploy/lib/configSchema.ts`: parser, schema, node grammar, precedence, validation.
- `deploy/lib/hostPlanner.ts`: grouping, unioning, topology classification.
- `deploy/deploy.env.example`: full key reference.
- `deploy/DEPLOYMENT_GUIDE.md`: operator manual.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Two-machine lab additions (2026-11-03)

- Node lists now allow multiple nodes on one private IP when their `servicePort` differs. Duplicate node ids and duplicate `privateIp:servicePort` endpoints are still rejected.
- PostgreSQL duplicate-IP validation now compares `privateIp:servicePort`, so a co-located primary/replica pair is valid.
- New keys: `FAKE_RAILS_NODE` (one node spec, overrides the legacy Fake Rails host/port/private IP), `STORAGE_SHARD_COUNT` (1-32), `KMS_MASTER_KEY_ID` and `KMS_MASTER_KEY_HEX`.
- `FAKE_RAILS_NODE` is accepted by the real deploy schema and feeds the Fake Rails service, Nginx upstream, firewall and core allowlist.
- `deploy/test-matrix/topologies.ts` renders every topology derived from the multi-machine lab config (see `testing.multi-machine-matrix`; the two-host example keeps the T1-T8 aliases) and `deploy/test/testMatrix.test.ts` validates every rendered file through `loadDeployConfig` and `planHosts`.
- The node grammar accepts only IPv4 for `sshHost` and `privateIp`, and SSH user/key/sudo are per tier, not per host; the lab config enforces both.

## Security hardening (2026-11-05)

- **Environment.** `DEPLOY_ENV` now defaults to `production` and gains `test`. In production `FAKE_RAILS_ENABLED`, `IS_TEST_SERVER`, `FAKE_RAILS_ALLOW_IN_PRODUCTION=true` and the synthetic seeder are refused. `deploy.env.example` ships `DEPLOY_ENV=production` and placeholders, so it deliberately fails validation until replaced.
- **Secrets.** `weakSecretReason` rejects placeholders (`change-me`, `password`, `admin`, `example`...), repeated/sequential patterns and low entropy. `KMS_MASTER_KEY` needs at least 32 characters; the JWT secret must differ from the seeder token.
- **Schema.** Charsets are restricted for secrets, SSH users, `*_REMOTE_DIR`, `PG_DATA_DIR`, backup/cert paths (absolute, no `..`), cron expressions, binary names and hosts.
- **New optional keys.** `BACKUP_WALG_VERSION` (default 3.0.9), `BACKUP_WALG_ASSET`, `BACKUP_BARMAN_VERSION` (3.10.1), `BUN_VERSION`, `BUN_SHA256`, `BACKUP_ALLOWED_CLIENT_CNS`, `BACKUP_SECONDARY_MIRROR_DELETE`, `BACKUP_S3_ALLOW_INSECURE_HTTP`, `KYB_SCANNER_MODE` (`eicar` content gate by default, `disabled` leaves documents PENDING), `PG_RAM_GB`, `PG_IO_METHOD`, `PG_REPLICA_REBUILD`; `BACKUP_WALG_SHA256` is required only when WAL-G has to be downloaded (an installed binary is reused); lab key `LAB_WALG_SHA256`.
- `PG_REPLICATION_*` is no longer written to the core app env.

## Gap resolutions (2026-11-05)

- **PAN-rail guard (GAP-026, partially resolved).** `loadDeployConfig` runs `panRailGuardProblems` over the environment: a key naming a PAN/CVV/card-number rail (`PAN`, `CVV`, `CVV2`, `CVC`, `CVC2`, `CARD_NUMBER`, `CARD_NO`, `PAN_RAIL(S)`, `CARD_RAIL(S)` as an underscore-delimited token) or a value containing a Luhn-valid 13-19 digit run is refused with a `PAN_RAIL_GUARD` problem. The scope statement is `deploy/docs/pci-scope.md` (see `platform.security`); the core-back guard is still open.
- **GAP-023 remains open:** real WAL-G, bun and barman SHA256 values are operator-supplied.

## Remediation round 2 (2026-11-08): app role and host probe configuration

`PG_APP_USER` (default `pgw_app_login`) and `PG_APP_PASSWORD` (at least 12 characters, different from the owner's) enable the role split: the owner (`PG_DB_USER`) runs migrations and seeders through `ownerUrl`, while the running services connect as `PG_APP_USER`, a plain LOGIN member of `pgw_app`. `PG_APP_USER` must not be `postgres`, `pgw_app` or `pgw_ledger_maintenance`, nor equal the owner or replication user. Without `PG_APP_PASSWORD` the legacy single-role runtime behaviour is kept and the deploy warns; migrations and seeders still use the session-safe `ownerUrl`.

## Shared object storage topology

`OBJECT_STORAGE_NODE` (same `nodeId@sshHost:sshPort:privateIp:servicePort`
format) adds `object-storage` to the storage roles. It is mandatory when
`CORE_NODES` has more than one node or the backup daemon is on a separate host;
otherwise validation fails with `MULTI_NODE_SHARED_STORAGE_REQUIRED`.
`OBJECT_STORAGE_ENABLED`, `OBJECT_STORAGE_MANAGE_VIA_SSH` or a non-empty node
auto-detect the tier. Core and backup daemon receive
`OBJECT_STORAGE_DAEMON_URL` plus `object-storage-client` mTLS paths, and the
core receives `CLUSTER_CORE_NODE_COUNT` and the KEK keyring.

## Host Planner

> Status: `implemented` · Last verified: 2026-11-05

## 1. Purpose and scope

The host planner converts a validated `DeployConfig` into a `DeployPlan`:

- unique hosts keyed by `sshHost:sshPort`;
- per-host roles, services, Nginx sites, certificate bundles, firewall rules and deploy order;
- per-tier node plans for core, admin, merchant and checkout;
- the PostgreSQL/Redis/audit/log/backup/object-storage storage plan;
- the backup plan and topology label.

It owns grouping and unioning only. It does not validate the raw environment (that is `deploy.topology`), generate certificates (`deploy.pki`), apply firewall rules (`deploy.firewall`) or execute the pipeline (`deploy.pipeline`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires "smart host deduplication": if two roles share an SSH endpoint, they are one machine. The planner must bootstrap that machine once, merge PM2 services, Nginx vhosts, certificate material and UFW rules, and still keep each horizontal node as its own service identity.

Storage roles are independently scalable. A PostgreSQL primary, replicas, PgBouncer, Redis, audit DB, log DB and backup daemon may be dedicated or co-located. The plan must preserve the intended network policy: the database only accepts core/replica/backup sources, the core only accepts edge sources, and edge backends bind their private IP with a LAN-scoped firewall rule so local or remote Nginx upstreams can reach them.

The rendered topology is intended to be the operator's first confirmation that deduplication and node arrays mean what they intended.

## 3. As-built architecture

### 3.1 Target collection

`planHosts()` starts from `findSshConflicts()`. Any endpoint shared by roles with different SSH keys or users aborts planning.

`allTargets()` builds a `RoleTarget` for:

1. every compute node from `buildComputeNodes()`, with its service, Nginx sites and firewall rules;
2. legacy database role (only when `DB_MANAGE_VIA_SSH` and the legacy DB path is active);
3. Fake Rails (only when enabled and configured);
4. managed storage nodes from `storageTargets()`.

A compute node is built from the node array when present, otherwise from the legacy single-host fields. A single-node tier keeps the base service name (`pg-core-back`, `pg-admin-back`, `pg-merchant-back`, `pg-checkout-back`, `pg-fake-rails-back`). A multi-node tier appends `-<slug(nodeId)>` to every node, including the first, so two instances can never share a PM2 name. A node's `servicePort` becomes the service port.

### 3.2 SSH endpoint grouping

The grouping key is `sshHost:sshPort` only. Hostnames, private IPs and role names do not participate. For every target:

- a new host gets the target's service, Nginx sites, certs, firewall and `deployOrder`;
- an existing host appends missing roles, unions certs, merges firewall rules, appends services by unique name, appends Nginx sites by unique site name, and takes the minimum role order.

`ROLE_ORDER` places storage and legacy database first (1), core second (2), Fake Rails third (3), admin fourth (4), merchant fifth (5), checkout sixth (6). Hosts are sorted by `deployOrder` and then by key. This is the order used by `renderTopology` and by compute deployment through the explicit pipeline steps, not a generic host loop.

### 3.3 Service plans

`buildService()` combines the tier's `sourceDir` and `remoteDir` with the node's port and environment:

- core receives `coreEnv()`: database URL, mTLS server material, KMS key, Redis URL, storage environment, `STORAGE_SHARD_COUNT`, Fake Rails and seed flags;
- edge roles receive `edgeEnv()`: core URL list, own client certificate paths, LAN CIDRs for admin, PG-live prefix for merchant, checkout front URL for checkout;
- Fake Rails receives `fakeRailsEnv()`.

Edge environments are built from a base that deliberately excludes `DATABASE_URL`, `KMS_MASTER_KEY` and storage credentials. `NODE_ENV` is forced to `production`. Multi-node services also carry `envFileName`, `releaseSuffix` and `currentLink` so the pipeline can isolate them on disk.

### 3.4 Nginx plans

`buildNginx()` always produces:

- `admin-lan` on `ADMIN_NGINX_LAN_PORT`, SSL by default, server name `ADMIN_DOMAIN`, static root from the admin release;
- `merchant-public` on HTTP/HTTPS ports, with certbot/custom/self-signed mode;
- `checkout-public` on HTTP/HTTPS ports, with certbot/custom/self-signed mode;
- optional `merchant-lan` when `MERCHANT_LAN_PORT > 0`;
- optional `checkout-lan` when `CHECKOUT_LAN_PORT > 0`;
- optional `fake-rails` when enabled.

Nginx plans are filtered per role and attached to the matching compute host(s). The public merchant/checkout vhosts use the configured domains; the LAN vhosts use the node private IP or `_`. The admin vhost is not attached to a non-admin host. Every site carries an `upstreamName` and all local/remote node addresses; the renderer emits a `least_conn` upstream with `max_fails=2 fail_timeout=3s`. Upstream names are unique per site: `pg_admin_backend`, `pg_merchant_public_backend`, `pg_merchant_lan_backend`, `pg_checkout_public_backend`, `pg_checkout_lan_backend` and `pg_fake_rails_backend`. Nginx requires names to be unique across the whole `http` context, so public and LAN vhosts cannot share one.

### 3.5 Certificate bundles

`buildCertBundles(role, config)` determines the display bundle for a host role:

- core: `core-server`, plus all four storage client bundle names when any storage feature is enabled;
- admin/merchant/checkout: their own client bundle;
- Fake Rails: `fake-rails-server`;
- backup: `backup-server` and `pg-client`;
- PostgreSQL roles: `pg-client`;
- Redis: `redis-client`;
- audit: `audit-db-client`;
- log: `log-db-client`.

`coreEnv()` spreads `backupCoreEnv(config)` right after `storageEnv(config)`: whenever `BACKUP_ENABLED` core receives `BACKUP_DAEMON_URL` (https unless `BACKUP_ALLOW_INSECURE_HTTP`), the CA/client cert/key paths and `BACKUP_DAEMON_TIMEOUT_MS`, independent of `pgStorageConfigured()` (before this, a `DB_*` deployment got `503 BACKUP_DAEMON_NOT_CONFIGURED` because `storageEnv` returned early). The backup host's firewall rule for `BACKUP_DAEMON_PORT` also admits the PostgreSQL primary and dedicated audit IPs so their `archive_command` can reach the WAL ingest route.

Display bundles are not the same as actual distribution. `certFilesForHost()` in `deploy/lib/pkiManager.ts` filters the generated storage clients by what actually exists and adds `backup-client` for the backup role. The cert bundle display can therefore list a storage client name that was not generated when that storage feature is disabled; the actual upload loop is driven by `certFilesForHost`.

A host that runs several roles receives the union of their bundles. A co-located edge host receives the client certificates for every edge role on that host, in each service's `shared/certs` directory, because `deployService()` calls `certFilesForHost(pki, host.roles)`.

### 3.6 Firewall plans

`buildComputeFirewall()` and `buildStorageFirewall()` produce abstract `FirewallRulePlan` entries (`port`, `proto: "tcp"`, optional source CIDRs, comment). They do not execute `ufw`. The host planner unions them; `deploy/lib/firewallConfigurator.ts` converts them to commands.

The union (`mergeFirewall()`):

- adds a new rule when the port/proto pair is absent;
- if either existing or new rule is unrestricted, deletes `fromCidrs` so the broader rule wins;
- otherwise unions CIDR lists and concatenates comments.

See `deploy.firewall` for the role matrix and command semantics.

### 3.7 Storage plan

`buildStoragePlan()` parses:

- exactly one `PG_PRIMARY_NODE`;
- zero or more `PG_REPLICA_NODES`;
- PgBouncer clones on the primary and every replica when `PGBOUNCER_ENABLED`;
- every `REDIS_NODES` entry;
- one audit node, one log node and one backup node.

It returns both a nested `postgres` view and flat role keys. `storage.nodes` is the concatenation of primary, replicas, PgBouncer clones, Redis, audit, log and backup. PgBouncer clones reuse the underlying node id and private IP with `role: "pgbouncer"`; they are not distinct machines.

`storageTargets()` only creates host targets for enabled management flags:

- PostgreSQL primary/replicas/PgBouncer: `PG_MANAGE_VIA_SSH`;
- Redis: `REDIS_MANAGE_VIA_SSH`;
- audit/log: their `*_MANAGE_VIA_SSH`;
- backup: `BACKUP_ENABLED`.

A configured but unmanaged storage node still appears in `plan.storage` and in the rendered map, but is not bootstrapped, firewalled or provisioned by this run.

### 3.8 Port collisions and validation boundary

The planner relies on `validateDeployConfig()` for collision checks. It does not re-check them. The validation rules relevant to the plan are:

- compute roles on the same SSH endpoint may not claim the same service port;
- a storage listener may not collide with a compute listener on the same endpoint;
- storage roles on the same endpoint may share a port only inside the PostgreSQL family (`pg-primary`, `pg-replica`, `audit-db`, `log-db`); PgBouncer, Redis and backup are separate families;
- PostgreSQL primary/replica private IPs are unique;
- node ids are unique across all lists;
- merchant/checkout/admin LAN and public ports are distinct;
- the two public domains differ;
- core and edge backend ports differ.

If `planHosts()` is called with a hand-built `DeployConfig` that bypassed validation, it can emit a plan with collisions; the pipeline normally calls `loadDeployConfig()` first.

### 3.9 Topology rendering

`renderTopology(plan)` prints:

```text
Topology: <single-host|split|distributed> (N host(s))

  user@sshHost:sshPort  [role, role]
    - pm2 <service> :<port>  (<sourceDir> -> <remoteDir>)
    - nginx <site> :<port>  <serverName>
    - certs <bundle,...>
    - ufw <port><=<cidr|cidr> ...
  storage <role>: <nodeId>@<privateIp>:<port>
```

It is printed in step 1 before any remote command. In `--dry-run` it is the fastest way to verify grouping and node arrays.

### 3.10 Role assignment map

`plan.roles` maps each compute role to the first host that carries it. It is informational; deployment iterates `plan.nodes` and `HostPlan.services`, not `roles`. Storage roles are not included in `roles`.

## 4. Contracts and invariants

- A host key is `sshHost:sshPort`; roles sharing it are one machine and must share SSH user/key/sudo.
- Every compute node gets a distinct service name; duplicate node ids are rejected before planning.
- A host's firewall is the union of its roles' rules; an unrestricted rule widens the result.
- Nginx sites are unique by site name per host.
- Certificates are the union of role bundles for display and the least-privilege set from `certFilesForHost()` for upload.
- Storage plan structure is stable even when management is disabled.
- `plan.topology` depends on unique host count only.
- Edge service env never contains database or KMS material.
- The planner does not mutate the config and does not touch the network.

## 5. Data / API / config / deployment surface

### Types

- `SshTarget`: host, port, user, key path, sudo password.
- `ServicePlan`: name, role, source/remote dir, port, env, optional node id/private IP.
- `NginxPlan`: site, role, template, listen/http/https ports, SSL flag/mode, server name, cert/key paths, static root.
- `FirewallRulePlan`: port, TCP, optional source CIDRs, comment.
- `NodePlan`: node id, role, SSH target, host, private IP, service port, service name, host key.
- `StorageNodePlan`: storage role, node id, SSH fields, private IP, service port.
- `HostPlan`: key, display name, SSH target, roles, services, Nginx sites, certs, firewall, keep releases, deploy order.
- `DeployPlan`: topology, hosts, role map, database view, compute node arrays, storage plan, replicas, backup plan.

### Inputs

All keys are from `deploy.env` (see `deploy.topology`). The planner reads the validated `DeployConfig` only.

## 6. Operational usage

```bash
./deploy/deploy.sh --dry-run
```

Inspect the printed map:

- each SSH endpoint appears once;
- each expected PM2 service appears with the intended port;
- Nginx sites appear on the intended host;
- the cert list matches the role;
- the UFW line shows the intended sources;
- storage lines show the intended roles and private IPs.

Use `--only` and `--nodes` to limit a later real run, but note that the plan is still built for the whole configuration.

## 7. Status and deviations

### Implemented

- SSH endpoint grouping and role union.
- Per-node service names and ports.
- Nginx, certificate and firewall unioning.
- Storage plan for primary/replicas/PgBouncer/Redis/audit/log/backup.
- Topology classification and human-readable rendering.
- Legacy database and Fake Rails targets.
- SSH credential conflict detection.

### Partial

- Storage nodes are displayed even when not managed.
- Certificate display bundles can name storage certs that were not generated.
- The plan has no stable JSON schema or machine-readable output.

### Missing / deferred

- Per-node SSH credentials.
- Independent storage node arrays for multiple audit/log/backup nodes (one each).
- Automatic detection of a port collision at plan time if validation was bypassed.
- A plan diff against the previous run.

### Known bugs / risks

- PgBouncer clones duplicate storage node ids/IPs in `storage.nodes`; consumers that assume uniqueness by node id can be confused.
- A host with several roles gets the union of their client certificates; the service-level least privilege is host-level, not process-level.
- `renderTopology` does not mark unmanaged storage as unmanaged.
- If a role is configured but its management flag is off, the host may not exist in `plan.hosts` while its storage entry appears in the map.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/hostPlanner.test.ts test/hostPlannerScale.test.ts test/configScale.test.ts test/exhaustive-deploy-matrix.test.ts
```

The suites cover five-host, two-host and single-host scenarios; firewall source sets; edge env isolation; multi-IP core SAN planning; node arrays; Fake Rails; and topology rendering. They do not require remote hosts.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` sections 1-2.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall union intent.

### Code paths

- `deploy/lib/hostPlanner.ts`: all planning, grouping and rendering.
- `deploy/lib/configSchema.ts`: input schema and validation.
- `deploy/deploy.ts`: plan consumption and deployment units.
- `deploy/lib/firewallConfigurator.ts`: rule-to-command conversion.
- `deploy/lib/pkiManager.ts`: actual least-privilege certificate distribution.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Multi-instance isolation (2026-11-03)

- A multi-node tier names every PM2 process with the node id (`pg-core-back-core-1`, `pg-core-back-core-2`); a single-node tier keeps the historical unsuffixed name.
- Every service carries `envFileName`, `releaseSuffix` and `currentLink`. The pipeline writes `shared/.env.<nodeId>`, `releases/<nodeId>/<timestamp>` and `current-<nodeId>`.
- `NginxPlan` carries `upstreamName` and `upstreamServers`. The renderer emits `upstream` blocks with `least_conn` and `max_fails=2 fail_timeout=3s` over all local and remote nodes.
- Edge backends bind the node private IP instead of loopback. The planner adds a LAN-scoped firewall rule for each edge backend port so a remote Nginx upstream can reach it.
- Replica read URLs use the replica's own PostgreSQL port, not a single PgBouncer port that would point a co-located replica back at the primary.

## 12. Unique Nginx upstream names (2026-11-04)

- Merchant and checkout each render both a public and a LAN vhost. Both previously used `pg_<role>_backend`, so `nginx -t` failed with `duplicate upstream`.
- `upstreamFor()` now accepts a site suffix; public and LAN sites render distinct upstreams while still targeting the same backend node pool.
- Admin remains `pg_admin_backend` because it has a single vhost; Fake Rails remains `pg_fake_rails_backend`.

## Security hardening (2026-11-05)

The planner's config validation now rejects weak secrets and restricts charsets for hosts, users, remote dirs and paths (see `deploy.topology`). `DEPLOY_ENV` defaults to `production`. Runtime services are still forced to `NODE_ENV=production`. Edge `TRUSTED_PROXY_CIDRS` is written as `127.0.0.1/32,::1/128`.

## Internal PKI and mTLS Certificates

> Status: `partial` · Last verified: 2026-11-12

## 1. Purpose and scope

This part owns the internal certificate authority, leaf certificate generation, SAN binding, rotation, SAN-drift handling, verification and least-privilege distribution.

It does not own the TLS server implementations. It documents how `core-back`, the three edge BFFs, the backup daemon, Fake Rails and the storage provisioners do or do not consume the generated material.

The implementation is `deploy/lib/pkiManager.ts`. The default vault is `deploy/.certs/`, gitignored and mode 0700. The CA private key never leaves the deployment workstation.

## 2. Design intent (extracted and synthesized from ./design)

The design requires:

- one offline internal root CA;
- a core server certificate whose SAN contains every core private IP, loopback and `core-back.internal`;
- client certificates with exact CNs `admin-back`, `merchant-back` and `checkout-back`;
- a backup-daemon server certificate bound to the backup private IP and loopback;
- a Fake Rails server certificate bound to its domain and private IP;
- optional `pg-client`, `redis-client`, `audit-db-client`, `log-db-client` and `backup-client` certificates for storage/backup mTLS links;
- TLS 1.3 with `requestCert: true`, `rejectUnauthorized: true` on core; the edge verifies the core certificate against the CA;
- least-privilege distribution: edge hosts receive only their own client certificate, storage hosts only their own client certificate, and no host receives the CA private key.

The design describes storage mTLS as provisioned end to end. The code generates the material but does not wire it into the database engines; see the deviations below.

## 3. As-built architecture

### 3.1 Root CA

`buildPki()` creates `internal-ca.crt` and `internal-ca.key` with:

- RSA 4096;
- 3650-day validity;
- `basicConstraints=critical,CA:TRUE`;
- `keyUsage=critical,keyCertSign,cRLSign`;
- subject `/CN=Payment Gateway Internal CA/O=Payment Gateway/OU=Internal PKI`;
- private key mode 0600;
- directory mode 0700.

The CA is created only when the files are absent or `rotate` is set. `ROTATE_MTLS_CERTS=true` or `--rotate-certs` regenerates the CA and all leaves.

### 3.2 Leaf generation

Leaves are RSA 2048, signed by the internal CA, with:

- `basicConstraints=critical,CA:FALSE`;
- `keyUsage=critical,digitalSignature,keyEncipherment`;
- `extendedKeyUsage` per certificate;
- optional `subjectAltName`;
- validity `MTLS_VALIDITY_DAYS` (default 825);
- certificate mode 0644, key mode 0600.

| Certificate | CN | SAN | EKU | Generated when |
| :--- | :--- | :--- | :--- | :--- |
| `core-back` | `core-back.internal` | every core private IP, `127.0.0.1`, `core-back.internal` | serverAuth + clientAuth | always |
| `backup-daemon` | `backup-daemon.internal` | backup private IP, `127.0.0.1`, `backup-daemon.internal` | serverAuth + clientAuth | always in the bundle; distributed when backup is enabled |
| `fake-rails` | `FAKE_RAILS_DOMAIN` or `fakerails.internal` for `_` | domain, private IP, `127.0.0.1` | serverAuth | always in the bundle |
| `admin-back-client` | `admin-back` | none | clientAuth | always |
| `merchant-back-client` | `merchant-back` | none | clientAuth | always |
| `checkout-back-client` | `checkout-back` | none | clientAuth | always |
| `pg-client` | `pg-client` | none | clientAuth | PostgreSQL storage configured |
| `redis-client` | `redis-client` | none | clientAuth | Redis configured |
| `audit-db-client` | `audit-db-client` | none | clientAuth | audit DB configured |
| `log-db-client` | `log-db-client` | none | clientAuth | log DB configured |
| `backup-client` | `backup-client` | none | clientAuth | backup configured |
| `wal-archive-client` | `wal-archive-client` | none | clientAuth | backup configured |

The core certificate also carries clientAuth so the core host can use it as a client for its own loopback `/health` probe. The backup server certificate also carries clientAuth because the deploy health probe presents it as a client.

Storage client certificates carry no SAN; they are only useful with a server configured to request a client certificate and verify the chain.

### 3.3 Idempotence and SAN drift

`buildPki()` first checks whether every expected certificate and key exists. If they do and `rotate` is false, it inspects the server certificates:

- `core-back` must contain every configured core private IP, `127.0.0.1` and `core-back.internal`;
- `backup-daemon` must contain the configured backup private IP, loopback and DNS name;
- `fake-rails` must contain its domain and private IP.

If all three cover their intended SANs, the existing bundle is verified and returned. If any SAN is missing, the leaves are re-signed from the existing CA (the CA is not rotated), covering all current leaves. This is how a private-IP change is handled without `--rotate-certs`.

Expiry is not part of the reuse decision. `verifyPki()` reports remaining days, but an expired leaf whose SANs match is still reused. `inspectCertificate()` marks `valid: expiresInDays > 0`; the deploy logs the value but does not force regeneration.

### 3.4 Verification

`verifyPki()` inspects the CA, core server, Fake Rails, backup daemon, edge clients and storage clients. `inspectCertificate()` uses `openssl x509` and extracts subject, dates and SANs. The deploy prints every certificate and its remaining validity in step 3 and again in the audit summary.

### 3.5 Least-privilege distribution

`certFilesForHost(bundle, roles)` returns the exact files for a host:

| Host roles | Files |
| :--- | :--- |
| core | CA certificate, core server cert/key, every generated storage client cert/key (including `backup-client`) |
| admin | CA, `admin-back-client` cert/key |
| merchant | CA, `merchant-back-client` cert/key |
| checkout | CA, `checkout-back-client` cert/key |
| Fake Rails | CA, `fake-rails` cert/key |
| pg-primary / pg-replica / pgbouncer | CA, `pg-client` cert/key (pg-primary also `wal-archive-client` cert/key) |
| Redis | CA, `redis-client` cert/key |
| audit DB | CA, `audit-db-client` cert/key, `wal-archive-client` cert/key |
| log DB | CA, `log-db-client` cert/key |
| backup | CA, `backup-daemon` cert/key, `pg-client` cert/key, `backup-client` cert/key |

`readMaterial()` returns the certificate for the CA and both certificate and key for non-CA material. The CA private key is never returned for distribution.

`wal-archive-client` (CN `wal-archive-client`) exists so a database host can push WAL to the backup daemon with a certificate that can do nothing else: the daemon maps it to the `wal` role (only `PUT /v1/wal/...`), while `backup-client` is the `control` role. It is deliberately distributed only to `pg-primary` and `audit-db` hosts, never to core or the backup host, and is installed in `/etc/pg-deploy/certs` with the key group-readable by `postgres` (`archive_command` runs as that user). Existing client leaves are not re-issued when only another file is missing.

`deploy.ts` calls `uploadStorageCertificates()` in step 3 for hosts with a storage role. It writes to `/etc/pg-deploy/certs` for storage hosts, or `BACKUP_DAEMON_CERT_DIR` for a backup host. Compute services later receive `certFilesForHost()` under `<remoteDir>/shared/certs` in `deployService()`.

A co-located edge host receives the union for all edge roles on that host, in each service's shared cert directory. This is host-level least privilege, not per-process isolation.

### 3.6 Consumption map

| Consumer | Material | Status |
| :--- | :--- | :--- |
| `core-back` TLS server | `core-back.crt/.key`, CA | Consumed. `core-back/index.ts` uses `tls.createServer` with `requestCert: true`, `rejectUnauthorized: true`, TLS 1.3, and the CA. |
| Core channel guard | peer certificate CN | Consumed. `requireEdgeIdentity()` checks `admin-back`, `merchant-back`, `checkout-back` per internal namespace. |
| `admin-back` / `merchant-back` / `checkout-back` | own client cert/key, CA | Consumed by the shared `https.Agent`. |
| Core backup control client | CA, `backup-client.crt/.key` | Consumed when `BACKUP_DAEMON_URL` and the cert paths are set. `deploy/lib/hostPlanner.ts` supplies them when `BACKUP_ENABLED`. |
| `pg-backup-daemon` | `backup-daemon.crt/.key`, CA | Consumed by `loadTlsOptions()` when the cert/key/CA are present and `BACKUP_ALLOW_INSECURE_HTTP` is false. Requires `requestCert` and `rejectUnauthorized`. |
| Fake Rails Nginx | `fake-rails.crt/.key` | Consumed by the Fake Rails vhost when SSL is enabled. |
| Core outbound to Fake Rails | CA via `NODE_EXTRA_CA_CERTS` | Consumed when Fake Rails SSL is enabled. |
| PostgreSQL | generated `pg-client` | **Not consumed.** The provisioner writes no `ssl_cert_file`/`ssl_key_file`, and `pg_hba` uses `hostssl ... scram-sha-256` without `clientcert`. |
| PgBouncer | generated `pg-client` | **Not consumed.** `server_tls_sslmode = require` encrypts the server leg without CA verification or a client certificate; no `client_tls_sslmode` is configured. |
| Redis | generated `redis-client` | **Not consumed.** The Redis config has no TLS listener and no certificate paths. |
| Audit DB / log DB | generated `audit-db-client` / `log-db-client` | **Not consumed.** Same `pg_hba` pattern as PostgreSQL, no client certificate requirement. |

### 3.7 Backup certificate ownership

`uploadStorageCertificates()` writes certificate files with `sudo: true`. The backup host path is `BACKUP_DAEMON_CERT_DIR` (default `/var/lib/pg-backup/shared/certs`). Certificates are mode 0644, keys 0600, owned by root because they are written through sudo.

The provisioner creates the directory for `pgbackup` and `deployBackupDaemon()` chowns `/opt/pg-backup-daemon`, but neither step chowns the certificate files. The systemd unit runs `User=pgbackup`. As written, the daemon may be unable to read the 0600 server key. The deploy health probe would then fail, but the deploy does not repair ownership. This is an open readiness gap; storage/backup mTLS must not be described as proven until a staging run confirms the effective ownership and startup.

### 3.8 Public portal certificates (operator-managed, 2026-11-09)

The internal PKI in sections 3.1-3.7 covers mTLS between the services. The public merchant, checkout and admin URLs use a separate, publicly trusted certificate, and this split matters operationally:

- `MERCHANT_SSL_MODE` and `CHECKOUT_SSL_MODE` accept `certbot`, `custom` and `self_signed`. In `certbot` mode the deploy verifies that the certificate file already exists (it does not request it), writes the `pg-certbot-renew.timer`, the `pg-certbot-renew.service` and the Nginx reload hook, and enables the timer. In `custom` mode it uses the configured certificate and key paths and does not schedule renewal.
- The certificate is not generated by the deploy. The operator issues it (for example `certbot certonly --webroot` with the Nginx `/.well-known/acme-challenge/` location) before switching the mode from `self_signed`, then reruns `--only=merchant,checkout`.
- One SAN certificate can cover every public hostname. The merchant vhost can use `certbot` mode with the default lineage path `/etc/letsencrypt/live/<MERCHANT_DOMAIN>/`; the checkout vhost points `CHECKOUT_SSL_CERT_PATH`/`CHECKOUT_SSL_KEY_PATH` at the same lineage. Renewal of that one lineage updates both vhosts through the deploy hook.
- The admin vhost has no public-certificate setting. `ADMIN_SSL=true` only enables TLS on the LAN vhost and the deploy mints a self-signed certificate for `ADMIN_DOMAIN`. To make the admin URL warning-free without a code change, add an operator-managed Nginx vhost on `443` with the trusted SAN certificate, `server_name <admin-domain>`, and `proxy_pass https://127.0.0.1:<ADMIN_NGINX_LAN_PORT>` with `proxy_ssl_verify off`. Add a `real_ip` snippet (`set_real_ip_from 127.0.0.1; set_real_ip_from <host-ip>; real_ip_header X-Forwarded-For; real_ip_recursive on;`) so the inner admin vhost forwards the real client address to `admin-back`. Name the file so it sorts after the deploy-managed public vhosts (for example `zz-pg-admin-tls.conf`) so the merchant/checkout default server is unchanged. This file is outside the deploy engine and persists across deploys; the deploy's Nginx reload picks up its renewed certificate.
- Test-server verification (2026-11-09): one Let's Encrypt SAN certificate for three DuckDNS names, `MERCHANT_SSL_MODE=certbot`, `CHECKOUT_SSL_MODE=custom`, the manual admin front, `certbot renew --dry-run --no-random-sleep-on-renew` succeeded, and `https://merchant...`, `https://checkout...` and `https://admin...` all returned 200 with the trusted issuer.

## 4. Contracts and invariants

- The internal CA private key is never copied to a target host.
- Every edge client CN must be exactly the service name expected by the core channel guard.
- The core server SAN must include every configured core private IP; a rolling core deploy must not invalidate mTLS on the other nodes.
- The backup daemon certificate SAN must include the backup private IP when the daemon binds to it.
- Fake Rails SAN must include its configured domain or the fallback `fakerails.internal`.
- TLS 1.3 is required between edges and core.
- Edge hosts receive no database credential, KMS key or other service's private key.
- Rotation is explicit. A normal deploy reuses existing material unless SAN drift requires re-signing.
- `verifyPki()` is advisory; a failed or expiring certificate does not block the deploy.

## 5. Data / API / config / deployment surface

### PKI inputs

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `ROTATE_MTLS_CERTS` | `false` | Regenerate CA and all leaves. |
| `MTLS_VALIDITY_DAYS` | `825` | Leaf validity. |
| `MTLS_RENEW_WITHIN_DAYS` | `30` (0 = off) | A deploy re-issues leaves expiring within this many days with the same CA (AUTO-28). |
| `CORE_NODES` / `CORE_PRIVATE_IP` | required | Core SAN IPs. |
| `BACKUP_NODE` | optional | Backup SAN IP. |
| `FAKE_RAILS_DOMAIN`, `FAKE_RAILS_PRIVATE_IP` | optional | Fake Rails SAN. |
| `PG_*`, `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE`, `BACKUP_ENABLED` | optional | Which storage client certificates are generated. |

### Files

- `deploy/.certs/internal-ca.crt`, `internal-ca.key`
- `deploy/.certs/core-back.crt`, `core-back.key`
- `deploy/.certs/backup-daemon.crt`, `backup-daemon.key`
- `deploy/.certs/fake-rails.crt`, `fake-rails.key`
- `deploy/.certs/admin-back-client.crt`, `.key`
- `deploy/.certs/merchant-back-client.crt`, `.key`
- `deploy/.certs/checkout-back-client.crt`, `.key`
- `deploy/.certs/pg-client.crt`, `.key`
- `deploy/.certs/redis-client.crt`, `.key`
- `deploy/.certs/audit-db-client.crt`, `.key`
- `deploy/.certs/log-db-client.crt`, `.key`
- `deploy/.certs/backup-client.crt`, `.key`

### Target paths

- Edge/core: `<REMOTE_DIR>/shared/certs/`.
- Storage hosts: `/etc/pg-deploy/certs/`.
- Backup daemon: `BACKUP_DAEMON_CERT_DIR`, default `/var/lib/pg-backup/shared/certs/`.

## 6. Operational usage

```bash
# Normal deploy: create missing material, reuse and verify existing material
./deploy/deploy.sh --update

# Force a full CA and leaf rotation
./deploy/deploy.sh --update --rotate-certs

# Inspect a certificate manually
openssl x509 -in deploy/.certs/core-back.crt -noout -subject -dates -ext subjectAltName
```

Changing a private IP:

1. Update every `*_PRIVATE_IP` and node-array `privateIp` in `deploy/deploy.env`.
2. Run `./deploy/deploy.sh --update --enforce-firewall`.
3. The PKI step detects SAN drift and re-signs the leaves from the existing CA.
4. Restart or redeploy processes that cache the certificate material; the edge pool does not reload files in place.

Keep `deploy/deploy.env` and `deploy/.certs/` at restrictive permissions. Do not copy `internal-ca.key` to a target host.

## 7. Status and deviations

### Implemented

- Offline RSA CA with a 10-year validity.
- Multi-SAN core server certificate covering every core private IP.
- Exact edge client CNs, backup daemon and Fake Rails server certificates.
- Optional storage client certificates.
- SAN-drift detection and leaf re-signing without CA rotation.
- Explicit CA/leaf rotation.
- `certFilesForHost()` least-privilege distribution.
- CA private key never distributed.
- Real consumption by core TLS, edge clients, backup daemon and Fake Rails.

### Partial

- Storage client certificates exist but are not consumed by PostgreSQL, PgBouncer, Redis, audit DB or log DB.
- The backup daemon's cert/key ownership is not aligned with its `pgbackup` user.
- A CA that nears its end is reported (`--check-certs`, the deploy warning) but never replaced automatically: replacing it is a rotation of every certificate (`--rotate-certs`).
- The backup daemon does not authorize a client CN per route.
- The admin vhost has no deploy-managed public certificate; a warning-free admin URL needs the operator-managed 443 front described in section 3.8, or a code change adding admin certificate settings.

### Missing / deferred

- end-to-end storage mTLS configuration (`ssl=on` with internal certs, `clientcert=verify-full`, Redis TLS, PgBouncer client TLS).
- (Done, AUTO-28) Leaf renewal before expiry: a normal deploy re-issues, with the existing CA, every leaf that expires within `MTLS_RENEW_WITHIN_DAYS` (default 30; 0 = off) and leaves the other files byte-identical; `deploy.ts --check-certs` prints the expiry table (`ok`, `RENEW`, `ROTATE-CA`, `EXPIRED`, `MISSING`) and exits 1 when anything needs attention, for cron or an alert hook. Still manual: nothing runs the deploy by itself, so a leaf is only renewed when somebody deploys within the window; the core's `platform.certificate` monitor check (AUTO-03) raises the case that tells them to.
- A CRL/OCSP or short-lived certificate workflow.
- Per-service certificate isolation on a co-located edge host.
- Client-CN authorization on the backup daemon.

### Known bugs / risks

- A deploy can complete its PKI step and still fail the backup daemon mTLS probe because the key is unreadable by `pgbackup`.
- `verifyPki()` does not gate the deploy on expired or soon-to-expire certificates.
- The storage certificate material is uploaded to `/etc/pg-deploy/certs` but no storage provisioner references that directory.
- `core-back` trusts any certificate signed by the internal CA for the TLS handshake; the CN guard is the only channel authorization.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/pkiScale.test.ts test/exhaustive-deploy-matrix.test.ts test/provisioners.test.ts
cd deploy/backup-daemon && bun test test/server.test.ts
```

Covered:

- core SAN includes every core private IP, loopback and DNS name;
- backup SAN includes the backup private IP;
- storage client certificates are created only for configured tiers;
- `certFilesForHost()` distributes only allowed leaves;
- SAN drift re-signs leaves without rotating the CA;
- backup daemon refuses plain HTTP unless explicitly allowed and requires CA + server pair;
- mTLS requires a client certificate when a CA is configured.

Not covered by automated tests:

- a real TLS handshake from an edge host to a core node;
- PostgreSQL/PgBouncer/Redis consumption of the storage certificates;
- backup daemon startup as `pgbackup` with the deployed file ownership.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.2, mTLS and certificate roles.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 4, PKI generation and distribution.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 4, storage DDL.

### Code paths

- `deploy/lib/pkiManager.ts`: CA, leaves, SAN drift, verification, distribution.
- `deploy/deploy.ts`: PKI step, upload, service certificate distribution, audit summary.
- `deploy/lib/hostPlanner.ts`: certificate bundles and env paths.
- `core-back/index.ts`: core TLS server.
- `core-back/api/middleware/mtlsGuard.ts`: CN channel guard.
- `deploy/backup-daemon/src/server.ts`: daemon TLS options.
- `core-back/lib/storageEngine/backupControlClient.ts`: core-to-daemon mTLS client.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## Object storage certificates

`buildPki` mints `object-storage-daemon.crt` (server; CN
`object-storage-daemon.internal`, SANs `IP:<OBJECT_STORAGE_NODE private IP>`,
`IP:127.0.0.1`, `DNS:object-storage-daemon.internal`) and, when object storage is
configured, the `object-storage-client` client certificate. `certFilesForHost`
gives the storage host its server + client material; core hosts and the backup
host receive `internal-ca.crt` and `object-storage-client.*`. Certificate placement is per consumer: a co-located core/backup host does not receive the object-storage server key, and the backup host receives the client leaf in its own cert directory. Renewal/SAN drift
handling includes the object-storage server leaf.

## Firewall Policy and Application

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part owns the host-aware UFW policy: the abstract rules derived by the planner, the merge behavior for co-located roles, the exact `ufw` commands, installation and application order.

It does not own the host plan, the service bind addresses or the Nginx `allow`/`deny` rules, although the two layers share `LAN_ALLOWED_CIDRS` and the same private IPs.

## 2. Design intent (extracted and synthesized from ./design)

Every host gets a default-deny inbound policy. Only role-specific ports are opened, and private services are restricted to the private IPs that need them:

- database only from core (and replicas/backup);
- core only from the three edge tiers;
- admin only from the LAN;
- merchant/checkout public ports open, backends loopback-only;
- storage services only from core, backup and peer storage nodes;
- backup daemon only from core and, for WAL ingest (`PUT /v1/wal`), the PostgreSQL primary and dedicated audit hosts.

If several roles share a host, the rules are the union of the role rules. The SSH rule is always emitted first and `ufw --force enable` is last, so a failed rule cannot lock the operator out.

## 3. As-built architecture

### 3.1 Base policy

`baseUfwCommands()` emits, in order:

```text
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
```

Every rule is `tcp`. No UDP rule is generated. The base policy is applied before role rules.

### 3.2 Rule model

`FirewallRulePlan` has:

- `port`;
- `proto: "tcp"`;
- optional `fromCidrs`;
- a human-readable comment.

`ufwCommandsForRule()`:

- if `fromCidrs` is absent or empty: `ufw allow <port>/tcp comment <comment>`;
- otherwise one command per CIDR: `ufw allow from <cidr> to any port <port> proto tcp comment <comment>`.

CIDRs are not coalesced or deduplicated at command generation; the planner's union deduplicates source lists.

### 3.3 Role matrix

`buildComputeFirewall()`:

| Role | Opened ports | Sources |
| :--- | :--- | :--- |
| `db` (legacy) | SSH, `DB_PORT` | DB port only from every core private IP. |
| `core` | SSH, core service port | Core port only from every admin/merchant/checkout private IP (node arrays or legacy). |
| `admin` | SSH, `ADMIN_NGINX_LAN_PORT` | Admin vhost only from `LAN_ALLOWED_CIDRS`. Backend `ADMIN_BACK_PORT` is not opened; it binds loopback. |
| `merchant` | SSH, `MERCHANT_HTTP_PORT`, `MERCHANT_HTTPS_PORT` when SSL, `MERCHANT_LAN_PORT` when > 0 | HTTP/HTTPS unrestricted; LAN port from `LAN_ALLOWED_CIDRS`. Backend port is not opened. |
| `checkout` | SSH, `CHECKOUT_HTTP_PORT`, `CHECKOUT_HTTPS_PORT` when SSL, `CHECKOUT_LAN_PORT` when > 0 | HTTP/HTTPS unrestricted; LAN port from `LAN_ALLOWED_CIDRS`. Backend port is not opened. |
| `fake-rails` | SSH, `FAKE_RAILS_NGINX_PORT` | From `FAKE_RAILS_ALLOWED_CIDRS`, every core private IP, and the legacy `CHECKOUT_PRIVATE_IP` when set. |

`buildStorageFirewall()`:

| Role | Opened ports | Sources |
| :--- | :--- | :--- |
| `pg-primary` | SSH, PostgreSQL port, PgBouncer port when enabled | PostgreSQL from replicas + backup + core (core omitted when PgBouncer is enabled); PgBouncer from core. |
| `pg-replica` | SSH, PostgreSQL port, PgBouncer port when enabled | PostgreSQL from the other PostgreSQL nodes + backup + core (core omitted when PgBouncer is enabled); PgBouncer from core. |
| `pgbouncer` | PgBouncer port | Core only. |
| `redis` | SSH, Redis port | Core + backup. |
| `audit-db` | SSH, PostgreSQL port | Core + backup. |
| `log-db` | SSH, PostgreSQL port | Core + backup. |
| `backup` | SSH, `BACKUP_DAEMON_PORT` | Core only. |

The `core` rule does not include Fake Rails or backup IPs: the core initiates backup calls and Fake Rails calls outbound, so neither needs inbound access to core.

The Fake Rails rule uses `allCorePrivateIps(config)` but only `CHECKOUT_PRIVATE_IP`, not the checkout node-array IPs. On a multi-node checkout tier, additional checkout nodes may not be able to reach Fake Rails unless they are also in `FAKE_RAILS_ALLOWED_CIDRS`.

### 3.4 Co-located hosts and union

`HostPlan.firewall` starts as the first target's rules and is merged with each additional role's rules by `mergeFirewall()`:

- same port/proto: union the CIDR lists;
- if either rule is unrestricted, remove the source restriction so the broader access wins;
- concatenate comments with `; `.

Examples:

- core + admin on one host: core port restricted to all edge IPs, admin LAN port restricted to the LAN, both SSH rules collapse to one port;
- merchant + checkout on one host: public HTTP/HTTPS likely produce one unrestricted rule per port after merging; both LAN ports are separate;
- PostgreSQL primary + audit + log on one host: all three may share port 5432 because they are in the same PostgreSQL family (this is checked by config validation, not by the merge).

The union can widen access. A role that opens a port publicly (merchant/checkout HTTP/HTTPS) makes that port public for the entire host, including any co-located role. Port collisions are rejected before planning when they cross families.

### 3.5 Application

`applyFirewall()`:

1. Builds the complete command list.
2. Requires an SSH rule whose port equals `host.ssh.port`; otherwise it refuses to enable UFW.
3. In dry-run, logs every `ufw` command through the runner and returns.
4. Checks whether `ufw` exists.
5. If absent, detects the OS (`deploy/lib/osDetector.ts`) and installs `ufw` with `apt-get` or `pacman`.
6. Re-checks; if still absent, logs a warning and skips firewall application.
7. Runs every command with sudo in order, with `ufw --force enable` last.
8. `deploy.ts` reads back `ufw status verbose` and prints the first 12 lines.

The installer supports Debian/Ubuntu-family and Arch-family hosts. Unknown OSes get no automatic install.

### 3.6 When rules are applied

`deploy.ts` applies the firewall only when:

- `--fresh` or `DEPLOY_MODE=fresh`, or
- `--enforce-firewall`.

`--update` alone skips bootstrap and firewall changes. `--dry-run` prints commands without executing them.

## 4. Contracts and invariants

- Default inbound is deny.
- The SSH port is always allowed before UFW is enabled; enabling without an SSH rule is refused.
- Only TCP rules are generated.
- Private services are source-restricted by private IPs or LAN CIDRs.
- Backend ports (`4101`, `4102`, `4103`, core `4000`) are not publicly opened.
- An unrestricted rule wins over a restricted rule for the same port on a co-located host.
- `LAN_ALLOWED_CIDRS` is shared by admin UFW rules, LAN vhost UFW rules and Nginx allow rules.
- The firewall is the outer network ring; mTLS and core authorization are independent inner controls.
- `--update` is not a firewall reconciliation mode; use `--enforce-firewall`.

## 5. Data / API / config / deployment surface

### Inputs

| Key | Meaning |
| :--- | :--- |
| `LAN_ALLOWED_CIDRS` | Admin and LAN vhost sources. |
| `FAKE_RAILS_ALLOWED_CIDRS` | Additional Fake Rails sources. |
| `CORE_NODES` / `CORE_PRIVATE_IP` | Core sources and core host identity. |
| `ADMIN_NODES` / `MERCHANT_NODES` / `CHECKOUT_NODES` and legacy private IPs | Edge sources for core. |
| `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PGBOUNCER_ENABLED`, `BACKUP_NODE` | Storage rule sources. |
| `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE` | Storage rule sources. |
| `BACKUP_DAEMON_PORT` | Backup control-plane port. |
| `FAKE_RAILS_NGINX_PORT` | Fake Rails ingress port. |
| `*_HTTP_PORT`, `*_HTTPS_PORT`, `*_LAN_PORT`, `ADMIN_NGINX_LAN_PORT` | Public and LAN listeners. |

### Generated artifacts

- `HostPlan.firewall`: abstract rules used by the deployment audit and the renderer.
- UFW commands in `deploy/lib/firewallConfigurator.ts`.
- `ufw status verbose` readback in the deployment log.

## 6. Operational usage

```bash
# Re-apply the plan after changing private IPs or ports
./deploy/deploy.sh --update --enforce-firewall

# Preview without executing
./deploy/deploy.sh --dry-run

# Inspect a host
ssh <host> 'sudo ufw status verbose'
```

If a host becomes unreachable after a firewall change, use the provider console. The SSH rule should prevent lockout, but a wrong `*_SSH_PORT`, an external security group, or a missing route can still block access.

## 7. Status and deviations

### Implemented

- Default-deny inbound, allow outgoing, deny routed.
- Role-specific source restrictions for compute and storage.
- Co-located union with unrestricted-rule precedence.
- SSH-rule prerequisite before enabling UFW.
- OS-aware UFW installation.
- Enable-last ordering.
- Dry-run command logging.
- Post-apply status readback.

### Partial

- Application is best-effort: no firewall is installed if the package manager is unknown or installation fails.
- Rules are not reconciled or diffed against a previously applied set; a stale rule from an older plan remains.
- The readback is printed, not parsed as a gate.

### Missing / deferred

- UDP policy.
- IPv6-specific rules.
- Automatic removal of obsolete rules.
- A per-host firewall diff or rollback.
- An explicit Fake Rails allowlist union for every checkout node.

### Known bugs / risks

- A broad rule from one co-located role widens the same port for every role on that host.
- Fake Rails may reject checkout traffic from additional `CHECKOUT_NODES` private IPs because only the legacy `CHECKOUT_PRIVATE_IP` is unioned.
- The isolated `pgbouncer` rule set contains no SSH rule. In the current plan PgBouncer is emitted on a PostgreSQL host, which supplies SSH; a future standalone PgBouncer plan would be refused by `applyFirewall()`.
- The firewall does not protect against a compromised host on an allowed source CIDR; mTLS and core authorization are still required.
- `--update` does not enforce the current policy, which can leave an old, wider rule in place.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/hostPlanner.test.ts test/hostPlannerScale.test.ts test/exhaustive-deploy-matrix.test.ts test/fakeRails.test.ts
```

Covered:

- single-host union includes core, admin and public ports;
- database port sources are restricted to core;
- core port sources are the three edge private IPs;
- merchant public HTTP/HTTPS plus LAN port rules;
- LAN listeners can be HTTP;
- Fake Rails sources and ports;
- exhaustive matrix rule generation.

Not covered:

- a real `ufw` apply on a remote host;
- rule persistence across reboot;
- removal of stale rules;
- provider-level firewall interaction.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall matrix.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6, step 4.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.3, reverse proxy exposure.

### Code paths

- `deploy/lib/firewallConfigurator.ts`: command building and apply.
- `deploy/lib/hostPlanner.ts`: role rules and union.
- `deploy/lib/osDetector.ts`: package-manager detection.
- `deploy/lib/sshRunner.ts`: sudo command execution.
- `deploy/deploy.ts`: when the firewall runs and the status readback.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

The Fake Rails nginx vhost now also applies `allow`/`deny` rules from `FAKE_RAILS_ALLOWED_CIDRS` (the application-level check compares `socket.remoteAddress`, not `X-Forwarded-For`). All six nginx templates set `server_tokens off` and `limit_req` with `limit_req_status 429`. UFW rules are unchanged.


## Object storage

TCP 4095 is opened only to core and backup private IPs. The deploy health step probes `/v1/health` over mTLS from every core and backup host.

## Deployment Pipeline

> Status: `partial` · Last verified: 2026-11-12

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

### 3.1a Step 1b: read-only preflight

After the host plan is built (and before step 2), `runPreflight()` executes a read-only check of only the selected `--only`/`--nodes` parts and their required dependencies. `--preflight-only` runs this phase and exits without building or touching a host; `--skip-preflight` bypasses it with a warning.

The preflight checks SSH reachability, key validity and sudo on every selected host; OS/tool readiness (missing bootstrap packages are informational in fresh/auto mode and blocking in update mode); disk, memory and clock skew; service ports and Nginx ports; current Nginx configuration; PM2 state; and the dependency paths (edge-to-core mTLS, core-to-database/PgBouncer, and storage prerequisites). Database/object-storage/backup probes are read-only and reuse the health verifier.

Port ownership is classified as `free`, `managed-current` (the current PM2 app for the planned service), `managed-orphan` (an old same-tier PM2 app), `managed-service` (the expected Nginx/PostgreSQL/Redis/PgBouncer/systemd daemon), `unmanaged-same-repo` (a non-PM2 Bun/Node dev process whose cwd/package matches the service), or `foreign`. Only `managed-*` and `free` pass. `unmanaged-same-repo` fails by default and can be stopped with `--stop-unmanaged`, but only after every other blocking check passes; the stop uses a PID/cwd re-check, SIGTERM, and a post-stop port re-read. Foreign processes, databases, Redis, Nginx and systemd services are never stopped.

`--only` accepts the backend aliases `core-back`, `admin-back`, `merchant-back`, `checkout-back` and `fake-rails-back` in addition to the canonical tier names. The selection helpers are shared with the deployment loop, so an admin-only deploy checks `4101`/`8080` and the core dependency but never core's `4000`.

A blocking preflight result aborts with "Nothing was built or changed". The final verification and the rolling batch probes also assert the new release identity (`APP_RELEASE`/`APP_COMMIT` in `/health`), so a stale listener cannot satisfy verification even if PM2 reports the new app online.

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

The dependency tree is reused across deploys, but a tree owned by a different account (for example after switching from WAL-G's `postgres` to pg-native's `pgbackup`) is removed and reinstalled as the current account instead of failing with `Failed to link <pkg>: EEXIST`. The restart decision also compares the running process account with `backupDaemonUser()` and honours `systemd`'s `NeedDaemonReload`, so a deploy that failed after writing the unit but before restarting cannot leave the old engine running.

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
4. Runs `bun install --frozen-lockfile`; for core also `bunx prisma generate`, `bun run migrate-deploy` and optional `db-seed`. Migrations run on the first core node in every mode (fresh and update), after step 5's pre-migration dump; other core nodes in a multi-node tier skip them. Migrations and seeders run as the database owner through a temporary `.env.owner` whenever that session-safe URL differs from the runtime one. The URL follows an explicit `LEADER_ELECTION_DATABASE_URL` when set, otherwise the deploy-managed `pgw_session` alias, otherwise the direct primary. This applies in the legacy single-role mode too, because Prisma Migrate's `pg_advisory_lock(72707369)` cannot survive transaction pooling (it would leave a stale lock and the next run fails with P1002). An externally managed pooler must provide the same session route; the deploy warns if `LEADER_ELECTION_DATABASE_URL` is omitted. The same temporary file sets `WORKER_ENABLED=false`: migrations and seeders do not start workers, and the core loader would otherwise reject the session-pooled owner `DATABASE_URL` for sharing the leader-election endpoint.
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

## Object storage step

Step 5 provisions the shared object-storage tier before the backup engine:
`provisionObjectStorageEngine` validates the node/KEK, then
`deployObjectStorageDaemon` syncs and starts the daemon. Health verification
probes `systemctl is-active pg-object-storage-daemon` on the storage host and
`GET /v1/health` over mTLS from every core host and the backup host. The deploy
fails before any core is touched when multiple core nodes or a separate backup
host are configured without `OBJECT_STORAGE_NODE`.

## Storage Provisioners

> Status: `partial` · Last verified: 2026-11-12

## 1. Purpose and scope

This part documents the four modular storage provisioners invoked by the deployment pipeline:

- `postgres18Provisioner.ts`: PostgreSQL 18 primary, replicas, replication slots, `pg_hba`, PgBouncer, tuning and journal partition cron;
- `redisProvisioner.ts`: Redis cache/velocity nodes;
- `clamavProvisioner.ts` (AUTO-06): ClamAV for the KYB document scan on every core host when `KYB_SCANNER_MODE=clamd` and no external `KYB_CLAMD_ADDRESS` is set. Installs `clamav-daemon` + `clamav-freshclam` (Arch: `clamav`) only when missing; writes a managed `/etc/clamav/clamd.conf` (TCP on `127.0.0.1:3310` only, local socket kept, `StreamMaxLength` and `MaxFileSize` 32M); downloads the first signature set (clamd will not start without one); disables Debian's `clamav-daemon.socket` (socket activation would own the sockets); starts clamd, or restarts it only when the configuration changed or on `--force-restart`; waits for `zPING`. The core env gets `KYB_CLAMD_ADDRESS=127.0.0.1:3310`. A host below 2 GB RAM or a failed first download (offline lab) is a warning, never a failed deploy: documents stay `PENDING` and the core's `kyb_scan_backlog` monitor check reports it. Not built: an offline signature mirror (`DatabaseMirror` is the ClamAV default) and a separate scanning host shared by several core nodes.
- `auditAndLogDbProvisioner.ts`: append-only audit database and partitioned log database;
- `backupEngineProvisioner.ts`: WAL-G/Barman archive engine, daemon environment/unit, schedules and S3/secondary target checks.

It covers what is installed, what is written, what is not consumed (especially TLS/mTLS) and the operational consequences.

It does not own the backup daemon runtime (`deploy.backup`), the host plan (`deploy.planner`), the firewall (`deploy.firewall`) or the pipeline ordering (`deploy.pipeline`).

## 2. Design intent (extracted and synthesized from ./design)

The storage plane is PostgreSQL 18 only. The design specifies:

- a tuned primary with streaming replicas initialized by `pg_basebackup -R` and physical replication slots;
- PgBouncer in transaction mode on the primary and replicas;
- SCRAM authentication and TLS-only remote database connections;
- Redis bound to the private LAN with a password and no public exposure;
- an append-only audit database with a SHA-256 hash chain and immutable rows;
- a monthly-partitioned log database with a retention function and cron;
- WAL-G or Barman for continuous WAL archiving and full/delta backups, with an S3 primary and optional secondary vault;
- journal-line partition maintenance on a daily cron;
- storage client certificates for mTLS links.

The code implements most of the topology, authentication and scheduling. The TLS/mTLS wiring is incomplete and is recorded explicitly below.

## 3. As-built architecture

### 3.1 PostgreSQL 18

`bootstrapCommands()` installs `postgresql-${PG_VERSION}`, `postgresql-contrib-${PG_VERSION}` and `pgbouncer` with `apt-get`, ensures the Debian cluster (`main` on 5432, or a named cluster on another port) exists, starts it, enables `postgresql@18-<cluster>` and PgBouncer where applicable, and creates the data directory with owner `postgres`.

The version comes from `PG_VERSION` (default `18`). The schema allows any one- or two-digit major version; there is no runtime assertion that it is exactly 18.

`postgresConfigSnippet()` writes `/etc/postgresql/<version>/<cluster>/conf.d/zz-pg-switch.conf` (where `<cluster>` is `main`, `replica_<nodeId>`, `audit` or `log`) with `listen_addresses='*'`, 300 connections, 8 GB shared buffers, 24 GB effective cache, 32 MB work memory, 1 GB maintenance memory, `io_method='io_uring'`, `synchronous_commit=on`, `wal_level=replica`, 16 WAL senders/slots, 16 GB max WAL, `pg_stat_statements` and `track_io_timing=on`.

The file contains no `ssl`, `ssl_cert_file`, `ssl_key_file`, `ssl_ca_file` or `ssl_crl_file` settings. The database listens on all interfaces and relies on UFW plus `pg_hba`.

`primaryBootstrapSql()`:

- creates the application role if absent, otherwise resets its password;
- creates the application database owned by that role if absent;
- creates the replication role with `REPLICATION LOGIN`, or resets its password;
- creates one physical replication slot per replica using a sanitized node id;
- emits a comment listing the intended `pg_hba` sources.

`pgHbaSnippet()` writes `local ... peer`, loopback `host ... scram-sha-256`, and `hostssl` all/replication lines with `scram-sha-256` for every allowed source. There is no `clientcert=verify-full` and no `cert` auth method, so the generated `pg-client` certificate is not part of database authentication.

The primary source list includes the primary itself, every replica, every core private IP, and the backup/audit/log node private IPs. The replica source list includes the primary and the backup nodes.

The provisioner writes `postgresql.conf` and `pg_hba.conf` (only when their bytes changed), **applies the cluster** (section 16: start if down, reload on change, restart only on `pending_restart`), then runs the bootstrap SQL through `runuser -u postgres -- psql -p <port>` against the now-running cluster, and installs `/etc/cron.d/pg-journal-partitions`:

```text
30 1 * * * root su - postgres -c "psql -d <PG_DB_NAME> -c 'SELECT ensure_journal_line_partitions(18)'" >/var/log/pg-journal-partitions.log 2>&1
```

The function `ensure_journal_line_partitions` must already exist from the core migrations. The same cron file is also written by the backup provisioner; the last writer wins with identical content.

### 3.2 Replicas and slots

For each replica, `replicaCommands()`:

- creates `/var/lib/postgresql` and writes `/var/lib/postgresql/.pgpass` with the replication credentials;
- stops the empty cluster, replaces its data directory with `pg_basebackup -h <primary> -p <port> -U <replicationUser> -D <dataDir> -Fp -Xs -P -R -S <slot>`, writes the slot into `postgresql.auto.conf`, starts the cluster and enables its systemd unit;
- ensures `primary_slot_name` in `postgresql.auto.conf`;
- enables and starts PostgreSQL.

The slots are created on the primary by `primaryBootstrapSql()`. Replication is asynchronous; `synchronous_commit=on` is local commit durability, not synchronous replication. There is no quorum or automatic failover.

`pg_basebackup` and the replica `.pgpass` use the replication password. The `.pgpass` is created under `/var/lib/postgresql` with a restrictive umask.

### 3.3 PgBouncer

When `PGBOUNCER_ENABLED=true`, PgBouncer is installed and configured on the primary and every replica. `/etc/pgbouncer/pgbouncer.ini` sets `listen_addr=0.0.0.0`, `listen_port=6432`, transaction pooling for the application database, `server_tls_sslmode=require`, the configured client/pool limits, reserve 10, prepared statements, SCRAM auth and `/etc/pgbouncer/userlist.txt`. The userlist contains the application and replication users with plaintext passwords, mode 0600. PgBouncer is applied by reload, or restarted only when needed (section 16).

The `[databases]` section also contains a session-scoped alias, `pgw_session`, mapping to the same real database with `pool_mode=session` and `pool_size = max(8, 2 × core nodes + 4)`. It carries the two advisory-lock consumers: the singleton-worker leader election (`LEADER_ELECTION_DATABASE_URL`) and the owner/migration URL used by `migrate deploy` and the seeders. Prisma Migrate takes a session advisory lock (`pg_advisory_lock(72707369)`); on a transaction-pooled route the lock can be left on a pooled backend and the next migration times out with P1002. The ordinary `PG_DB_NAME` entry stays transaction-pooled for application traffic. After PgBouncer is applied, the provisioner proves a login through both the application database and `pgw_session`; if the alias is not yet served after a reload, it restarts PgBouncer once and retries, so core never starts against a missing session route.

After writing both files, the provisioner resolves the service account from `systemctl show -p User --value pgbouncer` (falling back to `pgbouncer`, then `postgres`) and applies `0640` to the ini and `0600` to the userlist. This is required because Ubuntu's unit runs as `postgres` and does not create a `pgbouncer` system user; a root-owned `0640` file otherwise fails with `could not load file "/etc/pgbouncer/pgbouncer.ini": Permission denied`.

Important as-built facts:

- The `[databases]` section maps `PG_DB_NAME` to `127.0.0.1:<primaryPort>` with `PG_DB_USER` and its password, so a client connecting to `:6432` with that database name reaches the local PostgreSQL primary.
- `pgw_session` is a second alias to the same database with `pool_mode=session`; deploy writes `LEADER_ELECTION_DATABASE_URL=postgresql://…@<primary>:6432/pgw_session` into the core environment (or a direct PostgreSQL URL with `sslmode=no-verify` when PgBouncer is disabled). An explicit `LEADER_ELECTION_DATABASE_URL` in the deploy env overrides the derived value for an external database/pooler.
- The owner URL in the temporary `.env.owner` uses the same session endpoint as the leader election: the explicit `LEADER_ELECTION_DATABASE_URL` when set (including an external pooler), otherwise the deploy-managed `pgw_session` alias, otherwise the direct primary. It applies to the legacy single-role mode too; the runtime `DATABASE_URL` stays transaction-pooled, so Prisma's migration advisory lock and the seeders keep one backend for the whole session. An external pooler must allow the owner on its session route; the deploy warns when no explicit `LEADER_ELECTION_DATABASE_URL` is configured.
- `server_tls_sslmode = require` encrypts the PgBouncer-to-PostgreSQL leg; it does not verify the server certificate (`verify-full` would) and supplies no client certificate.
- There is no `client_tls_sslmode`, `client_tls_cert_file` or `client_tls_key_file`; clients are not required to present a certificate.
- `listen_addr = 0.0.0.0` is protected by UFW only; the plan opens 6432 to core sources.

The core environment points `PG_PRIMARY_PORT` and `DATABASE_REPLICA_URLS` at `PGBOUNCER_PORT` when the pooler is enabled; the generated `[databases]` mapping keeps that route working.

### 3.4 Redis

`redisProvisioner.ts` installs `redis-server`, enables it, and writes both `/etc/redis/redis.conf.d/zz-pg-switch.conf` and `/etc/redis/redis.conf` with a deduplicated private-IP + loopback bind, `protected-mode yes`, the node port, `requirepass <REDIS_PASSWORD>`, `save 3600 1`, maxmemory/policy `allkeys-lru`, no append-only file, `daemonize no`, `supervised systemd` and `dir /var/lib/pg-redis`. It writes a systemd drop-in for `redis-server` and `valkey` granting `ReadWritePaths=/var/lib/pg-redis`, runs `systemctl daemon-reload`, runs `ufw allow` for core and backup sources, restarts Redis **only if its effective config or drop-in changed (or it is down)** and verifies with `REDISCLI_AUTH=<password> redis-cli -p <port> PING`.

There is no `tls-port`, `tls-cert-file`, `tls-key-file`, `tls-ca-cert-file` or `tls-auth-clients` setting. Redis traffic is plaintext inside the private network. The generated `redis-client` certificate is unused.

### 3.5 Audit database

`auditAndLogDbProvisioner.ts` installs PostgreSQL on `AUDIT_DB_NODE` when `AUDIT_DB_MANAGE_VIA_SSH` is true, applies a minimal PostgreSQL config (`listen_addresses='*'`, `wal_level=replica`, senders/slots), writes a `pg_hba` restricted to core and backup sources (both skipped when the node is the primary's own cluster; see section 16), applies the cluster, creates the audit role/database, and applies:

- `pg_trgm`;
- `audit_records` with `seq_no` identity, UUID primary key, actor/action/entity fields, before/after JSON, `prev_hash`, `row_hash`;
- entity, actor, BRIN and trigram GIN indexes;
- `forbid_audit_mutation()` and `trg_audit_immutable` on UPDATE, DELETE and TRUNCATE;
- least-privilege grants: `SELECT, INSERT` only for the audit writer, plus sequence usage and default privileges.

The audit DDL is applied to the audit database. The `pg_hba` has the same `hostssl`-without-client-cert pattern as the core database.

### 3.6 Log database

The log provisioner installs PostgreSQL on `LOG_DB_NODE` when `LOG_DB_MANAGE_VIA_SSH` is true and applies:

- `attempt_step_logs` with a `(id, created_at)` primary key, partitioned by `RANGE (created_at)`;
- `http_access_logs` with a `(id, created_at)` primary key, partitioned by `RANGE (created_at)`;
- attempt/created indexes and BRIN indexes;
- `ensure_log_partitions(months_ahead, retention_months)`, which creates missing monthly partitions and drops partitions older than the retention cutoff;
- initial partitions six months ahead;
- `GRANT SELECT, INSERT` only for the log writer;
- `/etc/cron.d/pg-log-partitions` at `15 1 * * *` calling `ensure_log_partitions(6, <LOG_RETENTION_MONTHS>)`.

The retention function only drops partitions whose names match the monthly suffix pattern; it never drops the default partition or non-monthly tables. The log database `pg_hba` is restricted to core and backup sources and has no client-certificate requirement.

### 3.7 Backup engine provisioner

`provisionBackupEngine()` installs:

- `barman` (not for pg-native), `zstd`, `lz4`, `brotli`, `xz-utils`, `rclone`, `curl`, `ca-certificates`, and the PostgreSQL 18 client AND server packages (`postgresServerPackages()`), because the daemon runs `pg_basebackup`, `pg_receivewal`, `pg_verifybackup`, `pg_combinebackup`, `pg_dump`, `pg_restore`, `pg_ctl`, `initdb` and `psql` even on a dedicated backup host; on a host that runs no managed PostgreSQL cluster the default `postgresql` service is disabled and masked;
- WAL-G when `BACKUP_ENGINE_MODE=wal-g`: an already installed `wal-g` is reused; otherwise the pinned asset (`BACKUP_WALG_VERSION`, `BACKUP_WALG_ASSET`) is downloaded and verified against `BACKUP_WALG_SHA256` (fail closed when no checksum is supplied), then chmod +x;
- the `pgbackup` system user and `/var/lib/pg-backup`, log and cert directories;
- `/etc/pg-backup/backup.env` from `backupDaemonEnv()`;
- `/etc/pg-backup/wal-g.env` for the core target;
- the systemd unit and `/etc/cron.d/pg-backup`;
- `/usr/local/bin/pg-backup-daemon-trigger` and `/usr/local/bin/pg-backup-restore-drill`;
- Barman configuration and `.pgpass` in Barman mode;
- target reachability checks.

Archive configuration:

- WAL-G: writes `/etc/pg-backup/wal-g-core.env` on the primary and sets `archive_mode=on`, `archive_command` to `wal-g wal-push %p` with the core prefix, `restore_command` to `wal-g wal-fetch`, and `archive_timeout=60s`; the cluster is reloaded only if `postgresql.auto.conf` changed and restarted only if a setting is `pending_restart` (`archive_mode` off -> on on the first deploy).
- Barman: sets `wal_level=replica`, `archive_mode=off`, creates the `barman` slot and uses `barman-wal-archive <backupIp> <server> %p` from `streaming_archiver=on`. It writes `/etc/barman.conf` with a server section using the replication user, a `slot_name`, and `backup_method=postgres`.

The same archive configuration is applied to the audit database when `AUDIT_DB_MANAGE_VIA_SSH` is true, with `archive_command` targeting the audit prefix/server.

The provisioner also runs `verifyBackupTargetCommands()`:

- managed MinIO: `curl -fsS <BACKUP_PRIMARY_S3_ENDPOINT>/minio/health/live`; external S3 (R2/AWS/another host): any HTTP response from the endpoint (those services have no MinIO route), with an actionable error otherwise;
- an SSH `true` to the secondary target when configured;
- a non-empty encryption key check.

The MinIO health check verifies the local S3-compatible endpoint without requiring an rclone remote configuration.

### Object store provisioning and engine auto-selection (2026-11-04)

Before verification, `ensureObjectStore()` runs on the backup host:

- `BACKUP_S3_MODE` = `auto` (default) | `managed-minio` | `external`. `auto` resolves to `managed-minio` when the endpoint host is loopback, the backup node private IP or its SSH host, otherwise `external` (`resolveBackupS3Mode`).
- `external`: never touched, only verified.
- `managed-minio`: a healthy endpoint is left running; otherwise the engine installs `minio` (MinIO no longer publishes binaries and `dl.min.io` answers 410, so: an existing `minio` on the host, else `BACKUP_MINIO_BINARY_URL` (http(s):// or file://), else a source build with Go, `go install github.com/minio/minio@BACKUP_MINIO_VERSION`, several minutes; with none of these it fails with an actionable message), creates the `minio-user` account and `BACKUP_MINIO_DATA_DIR`, writes `/etc/default/minio` (0640 root:minio-user; root user/password = `BACKUP_PRIMARY_S3_ACCESS_KEY`/`SECRET_KEY`) and a `minio.service` unit, starts it, waits for health and creates the bucket from `BACKUP_PRIMARY_S3_BUCKET` (SigV4-signed `curl -X PUT`, HTTP 200/409 accepted; no `mc` needed). Install steps fail loudly: an earlier version continued past a failed download and started a unit with no binary. Loopback endpoints bind 127.0.0.1 only; others bind 0.0.0.0. Console port: `BACKUP_MINIO_CONSOLE_PORT`.
- Config validation (managed only): access key ≥3 chars, secret ≥8, bucket `s3://dns-bucket[/prefix]`, an http endpoint requires `BACKUP_S3_ALLOW_INSECURE_HTTP=true` (independent of the daemon's `BACKUP_ALLOW_INSECURE_HTTP`), https endpoints are rejected (no TLS is provisioned; use `external`).
- `BACKUP_ENGINE_MODE` defaults to `pg-native` and `auto` resolves to `pg-native` (ADR-0004): it works on the primary's host and on a dedicated backup host, needs no S3 and no external backup tool. Explicit `wal-g`/`barman` are unchanged; the rule forbidding `wal-g` on a separate host still applies to `wal-g` only.
- pg-native cluster settings (`pgNativeArchiveSql`): `wal_level=replica`, `archive_mode=on`, `archive_command = curl --fail ... --cert /etc/pg-deploy/certs/wal-archive-client.crt ... --upload-file %p https://<backup>:<port>/v1/wal/<postgres_core|audit_db>/%f`, `archive_timeout=60s`, `summarize_wal=on`, `max_wal_senders`/`max_replication_slots` raised to 10 only when below 4, `RESET restore_command`, and the replication role (`replicationRoleSql`). The provisioner checks that the `postgres` OS user can read the WAL client key and fails the deploy otherwise. Managed clusters already carry a `hostssl replication` rule for the backup node; an externally managed PostgreSQL needs it added by hand.
- `barmanStreamingSql(config, target)` creates `barman_audit` on a dedicated audit cluster (or on the core cluster when the audit database shares it), never a dangling slot on the primary.
- `BACKUP_ENGINE_MODE=auto` and `BACKUP_S3_MODE` keys are validated at load; MinIO install order and failure behaviour are described above (and in `04-pipeline.md` §13).
- The two-machine test matrix sets `BACKUP_S3_MODE=external` because it provisions its own object store.

The systemd unit runs `bun run src/index.ts` as `postgres` (WAL-G co-located with the primary) or `pgbackup` (everything else), with no `SupplementaryGroups` (which stopped systemd with status 216/GROUP on a host without a `postgres` group), `HOME`/`BUN_INSTALL_CACHE_DIR` under `/var/lib/pg-backup`, `EnvironmentFile=/etc/pg-backup/backup.env`, `ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, and `ReadWritePaths` for the backup, log, catalog, cert, scratch and pgpass directories.

## 4. Contracts and invariants

- PostgreSQL 18 is the only runtime database; `DB_ENGINE` is restricted to `postgresql`.
- Application and replication roles use SCRAM passwords; replication slots are physical.
- Replicas are initialized only when the data directory is empty.
- Remote database connections use `hostssl` rules; loopback uses SCRAM without TLS.
- The audit table is append-only at the trigger and grant level.
- Log partitions are monthly; retention only affects matching monthly partitions.
- Redis is bound to the private IP plus loopback and requires a password.
- No storage provisioner writes database credentials to an edge host.
- The journal partition cron is installed on the primary and must call an existing database function.
- Backup archiving is configured on the primary/audit database, not on replicas.

## 5. Data / API / config / deployment surface

### Key configuration

| Area | Keys |
| :--- | :--- |
| PostgreSQL | `PG_MANAGE_VIA_SSH`, `PG_VERSION`, `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PG_SSH_*`, `PG_DB_*`, `PG_REPLICATION_*`, `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR` |
| PgBouncer | `PGBOUNCER_ENABLED`, `PGBOUNCER_PORT`, `PGBOUNCER_DEFAULT_POOL_SIZE`, `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_MAX_PREPARED_STATEMENTS` |
| Redis | `REDIS_MANAGE_VIA_SSH`, `REDIS_NODES`, `REDIS_SSH_*`, `REDIS_PASSWORD`, `REDIS_MAXMEMORY`, `REDIS_URL` |
| Audit | `AUDIT_DB_MANAGE_VIA_SSH`, `AUDIT_DB_NODE`, `AUDIT_DB_SSH_*`, `AUDIT_DB_NAME`, `AUDIT_DB_USER`, `AUDIT_DB_PASSWORD` |
| Log | `LOG_DB_MANAGE_VIA_SSH`, `LOG_DB_NODE`, `LOG_DB_SSH_*`, `LOG_DB_NAME`, `LOG_DB_USER`, `LOG_DB_PASSWORD`, `LOG_RETENTION_MONTHS` |
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE`, `BACKUP_ENGINE_MODE` (`pg-native` default / `wal-g` / `barman` / `auto` = `pg-native`), `BACKUP_PRIMARY_S3_*`, `BACKUP_S3_MODE`, `BACKUP_MINIO_*`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET`, `BACKUP_FULL_CRON`, `BACKUP_DELTA_CRON`, `BACKUP_DRILL_CRON`, retention/alert keys, `BACKUP_WALG_BIN`, `BACKUP_BARMAN_BIN`, `BACKUP_BARMAN_CLOUD_BIN` |

### Generated files

- `/etc/postgresql/<version>/<cluster>/conf.d/zz-pg-switch.conf`
- `/etc/postgresql/<version>/main/pg_hba.conf`
- `/etc/pgbouncer/pgbouncer.ini`, `/etc/pgbouncer/userlist.txt`
- `/etc/redis/redis.conf`, `/etc/redis/redis.conf.d/zz-pg-switch.conf`
- `/etc/pg-backup/backup.env`, `/etc/pg-backup/wal-g.env`, `/etc/pg-backup/wal-g-core.env`, `/etc/pg-backup/wal-g-audit.env`
- `/etc/systemd/system/pg-backup-daemon.service`
- `/etc/barman.conf` and the Barman `.pgpass`
- `/etc/cron.d/pg-backup`, `/etc/cron.d/pg-log-partitions`, `/etc/cron.d/pg-journal-partitions`
- `/usr/local/bin/pg-backup-daemon-trigger`, `/usr/local/bin/pg-backup-restore-drill`
- `/etc/pg-deploy/certs/` (storage certificates, currently not consumed)

## 6. Operational usage

```bash
# Provision only the storage tier
./deploy/deploy.sh --only=pg,redis,audit-db,log-db,backup

# Or the aggregate
./deploy/deploy.sh --only=storage

# Inspect the primary
ssh <pg-primary>
sudo -u postgres psql -c 'select * from pg_replication_slots'
sudo -u postgres psql -c 'select application_name, state, sync_state from pg_stat_replication'

# Inspect PgBouncer
sudo systemctl status pgbouncer
sudo -u postgres psql -h 127.0.0.1 -p 6432 -U <user> -d <db> -c 'select 1'

# Inspect Redis
REDISCLI_AUTH='<password>' redis-cli -h <privateIp> -p <port> PING

# Inspect backup daemon
sudo systemctl status pg-backup-daemon
sudo journalctl -u pg-backup-daemon --since '1 hour ago'
```

If PgBouncer is enabled, add a `[databases]` section to `pgbouncer.ini` and reload (or, if a restart-only setting changed, restart) it before declaring the pooler usable.

## 7. Status and deviations

### Implemented

- PostgreSQL 18 installation and tuning.
- Application/replication roles, physical slots and `pg_basebackup -R` replicas.
- SCRAM `pg_hba` with `hostssl` for remote sources.
- PgBouncer installation and transaction-mode settings.
- Redis private bind, password, RDB snapshot and memory policy.
- Audit hash-chain table, immutability trigger and append-only grants.
- Log tables, monthly partitions, retention function and cron.
- WAL-G/Barman installation, archive/restore commands, daemon environment/unit, backups schedule and target checks.
- Journal and log partition cron entries.
- Storage health probes.

### Partial

- TLS is required for remote PostgreSQL connections by `hostssl`, but the provisioner does not configure the server certificate or a client-certificate requirement.
- PgBouncer is installed but has no `[databases]` mapping.
- Backup target verification depends on the MinIO endpoint and the secondary SSH target being reachable.
- WAL-G installation is unpinned.

### Missing / deferred

- Storage mTLS end to end (`ssl=on` with internal certs, `clientcert=verify-full`, Redis TLS, PgBouncer client TLS).
- Automatic failover or promotion of a replica.
- Backup restoration from the pre-migration dump.
- A PostgreSQL client package in the default bootstrap for `pg_dump`.
- `ensure_journal_line_partitions` creation in the deploy path (it assumes the core migration has run).

### Known bugs / risks

- Enabling PgBouncer points core at `:6432`, but the generated PgBouncer has no database route. This can make the deployed core unable to connect.
- The WAL-G binary URL is a moving `latest` Ubuntu 20.04 artifact; it is not checksum-verified and may not match the host distribution.
- `server_tls_sslmode=require` encrypts but does not verify the PostgreSQL server certificate.
- The Redis password is written into the config file and into `redis://` URLs in generated environments; protect those files.
- The audit/log `pg_hba` uses `hostssl` but the provisioner does not set SSL files, so the effective TLS depends on distribution defaults.
- The log retention function is destructive; a bad `LOG_RETENTION_MONTHS` can drop recent partitions.
- `listen_addresses='*'` with UFW-only protection means a firewall misconfiguration exposes the database ports.
- The backup provisioner restarts PostgreSQL only when `archive_mode` (or another postmaster setting) actually changes; that first restart can still fail and leave the cluster stopped.

## 8. Verification and tests

```bash
cd deploy && bun run typecheck && bun test test/provisioners.test.ts test/exhaustive-deploy-matrix.test.ts test/healthVerifierScale.test.ts test/configScale.test.ts
```

Covered:

- PostgreSQL tuning and `pg_hba` snippets;
- application/replication roles, slots and `pg_basebackup -R`;
- PgBouncer settings;
- Redis config and firewall commands;
- audit/log DDL and partition statements;
- backup daemon env/unit/cron/scripts;
- WAL-G/Barman command builders;
- health probe aggregation.

Not covered:

- a real PostgreSQL 18 install or replica streaming;
- a real PgBouncer connection with the generated config;
- TLS/mTLS database connections;
- a live WAL-G/Barman backup or restore;
- MinIO health and secondary-target reachability.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 4, DDL.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.3, provisioners.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 9, storage and backup.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall.

### Code paths

- `deploy/provisioners/postgres18Provisioner.ts`
- `deploy/provisioners/redisProvisioner.ts`
- `deploy/provisioners/clamavProvisioner.ts`
- `deploy/provisioners/auditAndLogDbProvisioner.ts`
- `deploy/provisioners/backupEngineProvisioner.ts`
- `deploy/lib/hostPlanner.ts`: storage env, URLs and node plans.
- `deploy/lib/healthVerifier.ts`: probes.
- `deploy/backup-daemon/src/config.ts`: daemon env contract.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Multi-cluster and audit-trigger additions (2026-11-03)

- `pgClusterFor()` maps port 5432 to the Debian `main` cluster and every other role to an independent cluster (`replica_<nodeId>`, `audit`, `log`) with its own data directory, config directory, HBA and `postgresql@18-<cluster>` unit.
- Replica initialization creates the cluster first, stops it, replaces the empty data directory with `pg_basebackup -R`, then starts the cluster.
- PgBouncer is provisioned once per host and now has a `[databases]` mapping to the local PostgreSQL port.
- The audit DDL installs `pgcrypto`, the `compute_audit_chain_hash_trg` BEFORE INSERT trigger with `pg_advisory_xact_lock(994001)`, and `verify_audit_chain()` for the multi-machine matrix audit gate (`testing.multi-machine-matrix`). The trigger derives `seq_no` from the previous row under the advisory lock (2026-11-04 fix): the earlier `NEW.seq_no := nextval(...)` ran after the identity default had already consumed a value, so every insert burned two numbers and `seq_no` had gaps, which defeats gap-based deletion detection. `seq_no` is now gap-free.
- `backupDaemonEnv()` derives `PG_DATA_DIR` and `PG_AUDIT_DATA_DIR` from the real cluster names.

## 12. Cluster-aware cron and port fixes (2026-11-03)

- Journal partition cron uses the primary cluster port (`psql -p <port>`), not the default 5432.
- Log partition cron uses the log cluster port (`psql -p <port>`), so a log cluster on 5435 is maintained instead of accidentally touching the main cluster.
- Postgres bootstrap reconciles database/object ownership to `PG_DB_USER` (see `04-pipeline.md` §13).
- Backup target verification checks the MinIO health endpoint instead of an unconfigured rclone remote.

## 13. PgBouncer config ownership fix (2026-11-04)

- PgBouncer config ownership is derived from the installed systemd unit instead of assuming a `pgbouncer` user exists.
- The ownership command resolves `systemctl show -p User --value pgbouncer`, falls back to the `pgbouncer` account, then to `postgres`, and enforces `0640` on `pgbouncer.ini` plus `0600` on `userlist.txt`.
- Fixes Ubuntu hosts where `pgbouncer.service` runs as `User=postgres`; the previous `chown pgbouncer:pgbouncer ... || true` silently failed and left the config unreadable.

## 14. Redis single-machine and sandbox fixes (2026-11-04)

- `bind` addresses are deduplicated. A loopback-only node (`REDIS_NODES="...:127.0.0.1:6379"`) previously rendered `bind 127.0.0.1 127.0.0.1`; Redis bound the first socket and aborted on the duplicate with `Address already in use`.
- The provisioner writes `redis-server.service.d/zz-pg-switch.conf` and `valkey.service.d/zz-pg-switch.conf` with `ReadWritePaths=/var/lib/pg-redis`. Debian's unit uses `ProtectSystem=strict` and otherwise makes the configured `dir` read-only, so RDB saves failed with `Read-only file system`.
- The restart/health step runs `systemctl daemon-reload`, targets the configured node port, and authenticates the `PING` with `REDISCLI_AUTH` instead of an unauthenticated `redis-cli PING`.
- Before restarting, the step disables save-on-shutdown on the currently running instance (`CONFIG SET save ""`). A sandboxed instance with a read-only dir otherwise refuses to exit when its shutdown save fails, which hangs `systemctl` because Debian's unit sets `TimeoutStopSec=0`; the newly written config restores `save 3600 1`.

## 15. PostgreSQL/pooler readiness (2026-11-04)

- `applyPostgresCluster()` waits for `pg_isready` on the cluster port after every start/reload/restart.
- `provisionBackupEngine()` waits after an archive-config restart, re-applies PgBouncer (restart) only if a PostgreSQL cluster actually restarted, and waits for PgBouncer on `PGBOUNCER_PORT`. The audit target can share the primary cluster, so its restart could otherwise leave PgBouncer caching `the database system is shutting down (server_login_retry)` when the core release runs migrations through `:6432`.
- These waits prevent the core migration step from racing a PostgreSQL restart on single-machine and co-located audit deployments.

## 16. Convergence instead of restarts (2026-11-05)

**Problem (measured):** a no-op `--update` storage deploy took 4m53s. PgBouncer 1.26 handles `SIGTERM` as "wait for all clients to disconnect"; core-back keeps pooled client connections open, so `systemctl restart pgbouncer` waited out systemd's 90 s `TimeoutStopSec` and then `SIGKILL`ed it. The deploy restarted PgBouncer three times per run (PostgreSQL provisioner, then the backup provisioner twice), PostgreSQL up to three times, Redis (flushing the L2 cache and velocity counters) and the backup daemon (possibly mid-backup), all unconditionally.

**Design (`deploy/lib/converge.ts`, pure script builders; applied by the provisioners):**

- `SshRunner.writeRemoteFile()` returns whether the bytes changed (remote `cmp -s`, then `install`/atomic `mv`; the mode is re-asserted when unchanged). A runner that returns nothing (test fakes) counts as "changed".
- PostgreSQL (`applyPostgresCluster`): inactive -> `systemctl reset-failed` then `enable --now` (a failed boot leaves the unit in `start-limit-hit`, where a plain start is refused with "start request repeated too quickly"); `--force-restart` -> restart; config/hba/auto.conf changed -> `systemctl reload`, wait for `pg_conf_load_time()` to move, then restart **only if** `count(*) FROM pg_settings WHERE pending_restart` is non-zero; else nothing. Always waits for `pg_isready`. The cluster is now applied before the bootstrap SQL runs (the SQL needs a running server and uses `-p <cluster port>`).
- PgBouncer (`applyPgbouncer`): writes `pgbouncer.ini`, `userlist.txt`, the drop-in and a restart signature. The drop-in `/etc/systemd/system/pgbouncer.service.d/zz-pg-switch.conf` sets `KillSignal=SIGINT` (safe shutdown, exits in ~0.1 s with idle clients attached; verified against SIGTERM, which never exits) and `TimeoutStopSec=15s`. Down -> start; PostgreSQL restarted in this run, the restart signature (`listen_addr`, `listen_port`, `unix_socket_*`, `so_reuseport`, `pidfile`, `logfile`) changed, or `--force-restart` -> restart; any other ini/userlist change -> `reload`; else nothing.
- Redis/Valkey: the installed unit is detected from real unit files (`redis-server`, `redis`, `valkey`; a drop-in-only stub does not count). Only that flavour's config files and drop-in decide the restart, which still runs `CONFIG SET save ""` first.
- Backup daemon (`deployBackupDaemon`): rsync reports changes (`--itemize-changes`); the unit is started if down and restarted only if the source, `backup.env`, the unit or the archive environment changed. Ownership of the source tree is handed to the deploy user and back without touching `node_modules`.
- Packages: `ensurePackagesScript` installs only what is missing (`dpkg-query` / `pacman -Qq`); `apt-get update` runs only when something is missing; `pacman -Sy <pkg>` (an unsupported partial upgrade) is never used (also removed from `bootstrapPackagesCommand`); the pinned barman `pip install` is skipped when the version already matches.
- Audit/log databases whose node is the primary's own cluster (`isSameCluster`: same SSH host and service port) no longer rewrite that cluster's `postgresql.conf`/`pg_hba.conf` (the primary's source list is a superset; the two provisioners used to flip-flop the file and reload twice). Likewise the backup provisioner no longer re-points the shared cluster's `archive_command` at the `audit_db` prefix after setting the `postgres_core` one: before this change a co-located deploy left the cluster archiving WAL to `<bucket>/audit_db` and changed `archive_command` twice per run. The core target now owns the stream.
- Pooler login verification (`poolerLoginScript`): after PgBouncer is applied, the PostgreSQL provisioner proves a real login and `SELECT 1` through `:<PGBOUNCER_PORT>` (up to 45 s, private 0600 PGPASSFILE). PgBouncer caches a failed server login for `server_login_retry` (15 s), so after a database is dropped and recreated (fresh seed, restore) it answers `database "x" does not exist` and an immediately following `prisma migrate deploy` fails; the old unconditional restart hid this. Found by the destructive stress scenario.
- Latent bugs fixed on the way: the generated Arch/custom-cluster unit had `ExecReload=/bin/kill -HUP ` (the unquoted heredoc expanded `$MAINPID` to nothing, so `systemctl reload` could not work) and no `KillSignal`; replica clusters now get their config applied (they were only started); a bootstrap `psql` ran without `-p`, so a non-5432 primary would have bootstrapped the wrong cluster.

**Result on the dev box (live, same stack):** first run after the change 6.9 s (one deliberate, fast PgBouncer restart to install the drop-in), every later no-op storage run 5.1-5.4 s with every service `unchanged`; full no-op update 23 s, of which 11 s is the core release. See `testing.deploy-stress` for the repeatable proof.

## 17. Direct PostgreSQL URLs must use TLS (audit-logs 500, 2026-11-05)

**Symptom:** `GET /api/v1/admin/audit-logs` returned 500 on the admin portal while `/audit-logs/summary` returned 200. Core's audit store failed with `no pg_hba.conf entry for host "127.0.0.1", user "gw_audit_user", database "pg_audit_db", no encryption`.

**Root cause (pre-existing, not an environment problem):** commit `167aec5` (GAP-022) made `pgHbaSnippet()` emit only `hostssl` rules, but `hostPlanner` still generated `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL` and `DATABASE_REPLICA_URLS` without a TLS parameter. Core's audit/log pools are plain `pg.Pool({ connectionString })`, so as soon as a deploy applied the new `pg_hba.conf` every direct connection was rejected: the audit-log list/export/detail reads, and the audit and log writers behind the same pools. Only the PgBouncer-fronted `DATABASE_URL` kept working (PgBouncer's client side is plain; it speaks TLS to PostgreSQL itself). No test tied the generated URLs to the generated `pg_hba`.

**Fix:** `directTlsQuery()` in `hostPlanner.ts` appends `?sslmode=no-verify` to those three URLs when the deploy manages the target (`PG_MANAGE_VIA_SSH`, `AUDIT_DB_MANAGE_VIA_SSH`, `LOG_DB_MANAGE_VIA_SSH`). `no-verify` is the mode node-postgres (`pg-connection-string` 2.x) maps to `ssl: { rejectUnauthorized: false }`: encrypted, certificate not verified, which is exactly the documented posture of the self-signed per-cluster certificate; `require` would reject that certificate. Externally managed databases keep the operator's URL. Regression tests (`deploy/test/converge.test.ts`) assert that the generated `pg_hba` has no non-TLS rule, that all three URLs carry the parameter for managed clusters and not for external ones, and that the parameter parses to `rejectUnauthorized: false`.

**Still open:** `DATABASE_URL` when `PGBOUNCER_ENABLED=false` goes straight to PostgreSQL without TLS and would be rejected the same way; it cannot simply take `sslmode=no-verify` because Prisma's schema engine does not understand that value. Verifying server certificates (`verify-full` with a CA-signed server certificate) remains GAP-022.

## Security hardening (2026-11-05)

- **Quoting.** Provisioners (postgres18, auditAndLogDb, backupEngine) use `deploy/lib/quoting.ts`: SQL literals are escaped, DO blocks use collision-free dollar tags, and `pgbouncer.ini`, `userlist` and `.pgpass` are escaped. `backup.env` and `wal-g.env` are rendered `KEY='value'` (a single quote in a value is rejected).
- **Credentials.** `pg_basebackup` uses `PGPASSFILE`, never `PGPASSWORD`. Bootstrap/audit/log/archive SQL lives in a private 0700 postgres-owned directory, mode 0600, removed by trap/finally.
- **WAL-G.** `restore_command` is a valid `postgresql.conf` literal (inner quotes doubled). The daemon settings `WALG_ENV_FILE`/`WALG_ENV_FILE_AUDIT` keep S3/encryption secrets out of that line; the provisioner writes `/etc/pg-backup/wal-g-core.env` and `/etc/pg-backup/wal-g-audit.env` (0640 root:postgres), so the audit restore uses the audit prefix instead of the core prefix. WAL-G is pinned (`BACKUP_WALG_VERSION=3.0.9`, `BACKUP_WALG_ASSET`) and sha256-verified fail-closed when it must be downloaded; barman is pinned (`BACKUP_BARMAN_VERSION=3.10.1`).
- **Mirror and restore.** The off-site mirror uses `rclone copy`/`rsync` without `--delete` unless `BACKUP_SECONDARY_MIRROR_DELETE=true`. The scratch restore cluster starts with `-c archive_mode=off`.
- **PostgreSQL.** `listen_addresses = 127.0.0.1,<private IP>`, de-duplicated (`postgresListenAddresses`) so a single-host install where the private IP is `127.0.0.1` emits one entry; memory settings derive from optional `PG_RAM_GB` (unset keeps 8GB/24GB/1GB); `PG_IO_METHOD` defaults to `worker` (io_uring is opt-in); an existing standby (PG_VERSION and `standby.signal` present) is not rebuilt unless `PG_REPLICA_REBUILD=true`.
- **Still open.** Real SHA256 values for WAL-G/bun/barman must be supplied by the operator (GAP-023). GAP-022 and GAP-028 are resolved (see the gap resolutions below).

## Gap resolutions (2026-11-05)

- **PostgreSQL TLS and hostssl-only (GAP-022, RESOLVED).** `postgresTlsSnippet` appends `ssl = on`, `ssl_cert_file`/`ssl_key_file` under `<cluster hba dir>/tls`, `ssl_min_protocol_version = 'TLSv1.2'` and `password_encryption = 'scram-sha-256'` to each cluster's configuration. `pgTlsCommands` idempotently creates a self-signed RSA-4096 certificate (825 days, 0600 key owned by `postgres`) on the primary and replicas unless an operator already installed one. `pgHbaSnippet` now emits only `hostssl` rules (loopback `127.0.0.1/32` and `::1/128`, every allowed source for data and replication); the plain `host` rules were removed. Replica `pg_basebackup` runs with `PGSSLMODE=require` and PgBouncer uses `server_tls_sslmode = require`.
- **Backup daemon user (GAP-022, corrected 2026-11-06; refined 2026-11-06).** `backupDaemonUser()` returns `postgres` only for WAL-G co-located with the primary (`isBackupColocatedWithPrimary`) and `pgbackup` otherwise; the earlier statement below that it returns `postgres` in WAL-G mode regardless of host is superseded. Original: `backupDaemonUser()` returns `postgres` in WAL-G mode (base backups read PGDATA and use peer auth, so a dedicated account cannot work) and `pgbackup` in Barman mode; the unit also sets `PrivateTmp=true` so the mTLS front can create its socket. Verified live: the daemon answers mTLS only (no client certificate and plain HTTP are refused) and a full WAL-G backup reaches MinIO. In Barman mode the provisioner runs the daemon systemd unit as `User=pgbackup`/`Group=pgbackup` with `SupplementaryGroups=postgres`, adds `postgres` to the `pgbackup` group, and owns `/var/lib/pg-backup`, the daemon certificate directory, the log directory, the barman state directory, `BACKUP_PGPASSFILE` and `/etc/pg-backup/wal-g.env` (`root:pgbackup`, 0640) accordingly.
- **Replica pgpass over stdin (GAP-028, RESOLVED).** `replicaPgpassContent` renders the replication `.pgpass` line and `provisionPostgres18` streams it to `/var/lib/postgresql/.pgpass` (0600) with the remote-file writer; the replication password no longer appears in any command argv. `replicaCommands` only checks and `chown`/`chmod`s the file.
- **UTC (GAP-030).** The cluster configuration also sets `timezone = 'UTC'` and `log_timezone = 'UTC'` (the engine pins its own sessions, see `core.storage`).
- **Still open.** GAP-023: real SHA256 values for WAL-G, bun and barman (`BACKUP_WALG_SHA256`, `BUN_SHA256`) must be supplied by the operator for each release.

## 18. PostgreSQL did not survive a reboot on a single Arch/Garuda host (2026-11-06)

**Symptom:** every database-backed command failed with `Transaction API error: Unable to start a transaction in the given time` (Prisma `$transaction` maxWait) while PgBouncer logged `client_login_timeout (server down)`. `systemctl status postgresql@18-*` showed `start-limit-hit`.

**Root cause (two generated-config defects, both only on the Arch/custom-cluster path):**

1. On a single-host deploy `DB_PRIVATE_IP` is `127.0.0.1`, and `postgresMainConfigSnippet` rendered `listen_addresses = '127.0.0.1,127.0.0.1'`. PostgreSQL binds the first entry, then fails the duplicate with `could not bind IPv4 address "127.0.0.1": Address already in use` and exits.
2. The generated `postgresql@18-<cluster>.service` had no `RuntimeDirectory`, and `/run` is a tmpfs, so after every reboot `/run/postgresql` did not exist and the postmaster died with `could not create lock file "/run/postgresql/.s.PGSQL.<port>.lock"`. `ensureClusterScript` only created the directory during bootstrap. The start limit then left the unit refusing further starts.

**Fix:** `postgresListenAddresses()` de-duplicates loopback + private IP (`127.0.0.1` stays a single entry); the generated unit sets `RuntimeDirectory=postgresql` and `RuntimeDirectoryMode=2775`, so systemd recreates the socket directory before every start; and `postgresApplyScript` runs `systemctl reset-failed "$unit"` before starting an inactive cluster so a start-limit from an earlier boot cannot block recovery.

**Verified live:** `./deploy/deploy.sh --update --skip-build --only=storage` brought the primary cluster, Redis and PgBouncer back (`Verification OK`); `/etc/postgresql/18/main/postgresql.conf` then had `listen_addresses = '127.0.0.1'`, the unit had `RuntimeDirectory=postgresql`, and `create-dev-users` completed against the pooler.

## Backup engine reliability (2026-11-06)

- **`pg-native` engine wiring.** `backupDaemonEnv()` emits `BACKUP_LOCAL_REPO_DIR` (pg-native), `BACKUP_WAL_CLIENT_CNS`, `PG_AUDIT_HOST` (only for a dedicated audit cluster), `PG_AUDIT_USER/_PASSWORD`, `PG_LOG_DB_NAME`, `PG_REPLICATION_USER/_PASSWORD`, `PG_REPLICATION_SLOT=pg_backup_core` and `PG_SSLMODE=require`; S3 prefixes are empty when no S3 is configured. S3 (`ensureObjectStore`, `verifyBackupTargetCommands`) is skipped when `BACKUP_PRIMARY_S3_ENDPOINT` is empty in pg-native mode, which is the air-gapped LAN setup.
- **Certificate and ownership fixes.** `uploadStorageCertificates()` chowns the daemon certificate directory to the daemon user (0750 dir, 0640 certs, 0600 keys) and `deployBackupDaemon()` uses `backupDaemonUser()` for ownership and `bun install` (run with `HOME` and `BUN_INSTALL_CACHE_DIR`), then waits up to 10 s for the unit to stay active; on failure it prints `journalctl -u pg-backup-daemon -n 40` and exits 1. Ownership under `/var/lib/pg-backup` is fixed with `find ... ! -user/-group` so a multi-terabyte local repository is not re-chowned on every deploy.
- **Lab.** `LAB_BACKUP_MODE=pg-native` selects the engine in the multi-machine lab; `BACKUP_WALG_SHA256` is only set when `LAB_WALG_SHA256` is (an all-zero checksum could never verify and aborted the install).
- **Reserved role names (fixed).** `AUDIT_DB_USER`/`LOG_DB_USER` used to default to `pg_audit_writer`/`pg_log_writer`; PostgreSQL reserves the `pg_` prefix, so `CREATE ROLE` always failed for a deployment relying on the defaults. The defaults are now `gw_audit_writer`/`gw_log_writer` and a `pg_`-prefixed value is rejected at config load.
- **More reserved defaults (found by the two-host lab).** `PG_DB_USER` and `PG_REPLICATION_USER` also defaulted to `pg_core_user`/`pg_replicator`; they are now `gw_core_user`/`gw_replicator` and all role settings (`DB_USER`, `PG_DB_USER`, `PG_REPLICATION_USER`, `AUDIT_DB_USER`, `LOG_DB_USER`) reject a `pg_` prefix.
- **Bun for the service user.** `bunInstallCommand` installs a REAL `/usr/local/bin/bun` (temp file + `mv`, so a running daemon is not hit by "text file busy") and converts an existing symlink, because a symlink into `/home/<user>/.bun` cannot be executed by the unprivileged daemon user.
- **Cron drill fallback.** `pg-backup-restore-drill` now asks the daemon for a drill for every engine (the root shell script that restored without WAL replay is removed).

## PgBouncer session alias for leader election (2026-11-07)

- The generated `[databases]` section now contains `pgw_session`, an alias to the same database with `pool_mode=session` and `pool_size=max(8, 2 × CORE_NODES + 4)`; the application database remains `pool_mode=transaction`.
- Core receives `LEADER_ELECTION_DATABASE_URL` (derived as `postgresql://…@<primary>:<PGBOUNCER_PORT>/pgw_session`; direct PostgreSQL with `sslmode=no-verify` when PgBouncer is disabled). An explicit deploy-env value overrides it.
- After `applyPgbouncer()`, the provisioner logs in through `pgw_session`; a reload normally publishes the new alias, otherwise it restarts PgBouncer once and retries. Core refuses to boot if the session endpoint is missing or transaction-pooled.
- No firewall change: the alias uses the existing `PGBOUNCER_PORT` rule from core nodes; PostgreSQL's own port remains closed to core when PgBouncer is enabled.

## Remediation round 2 (2026-11-08): role split, PgBouncer TLS, Redis

- PgBouncer authenticates each client as its own user (per-client userlist entry for `PG_APP_USER`) instead of forcing the owner, and terminates TLS on the client leg (`client_tls_sslmode`, self-signed certificate); `DATABASE_URL` carries `sslmode=no-verify` whenever the deploy manages the cluster (encrypted, not identity-verified; certificate verification remains open).
- The bootstrap SQL creates the app login role as a member of `pgw_app` with no UPDATE/DELETE/TRUNCATE on the ledger and audit tables and no DDL. Validated end to end on a TLS PostgreSQL 18 with a real PgBouncer (owner migrations, app-role privilege probes, core's Prisma client). It has not run on a multi-host lab (GAP-057 stays partial).
- Redis (`redisProvisioner.ts`): `maxmemory-policy volatile-ttl` plus AOF, so only keys with a TTL are evictable and a restart does not lose revoke flags; every durable key must carry a TTL.

## Object storage provisioner (v36)

`deploy/provisioners/objectStorageProvisioner.ts` creates the `pgobjstore`
system user, `/var/lib/pg-object-storage` and the vault subdirectories
(`hot`, `cold`, `quarantine`, `tmp`, `.trash`), writes
`/etc/pg-object-storage/object-storage.env` and
`pg-object-storage-daemon.service` (Bun, `ProtectSystem=strict`,
`PrivateTmp=true`, `ReadWritePaths` for the vault and cert directories).
`deployObjectStorageDaemon` installs pinned Bun, syncs `deploy/object-storage-daemon` to
`/opt/pg-object-storage-daemon` and starts/restarts it only on change. The
provisioner creates the user first, hands only the dedicated certificate files
to `pgobjstore`, and refuses multiple core nodes without a configured
object-storage node. Storage roots and cert directories are restricted to
`/var/lib/pg-object-storage/`.


The fresh-host sequence is tested with a fake runner; the real two-host lab remains manual.

## Backup Daemon

> Status: `partial` · Last verified: 2026-11-12

## 1. Purpose and scope

`pg-backup-daemon` is the backup and point-in-time-recovery (PITR) control plane for the storage tier. It takes full and incremental backups, archives WAL continuously, keeps an encrypted multi-tier repository, owns the full/delta/drill schedule, keeps a signed catalog, exposes an mTLS HTTP API and runs scratch-cluster restore drills that check the ledger and audit invariants.

It does not own the PostgreSQL cluster or its archive settings (the provisioner does), the admin approval workflow (core does) or the admin UI.

## 2. Design intent (extracted and synthesized from ./design)

The original design called for a Bun service wrapping WAL-G (same host) or Barman (separate host). `design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md` (2026-11-06) added a root-cause audit and a topology-agnostic `pg-native` engine. It was implemented with the deviations in section 9.

## 3. As-built architecture

### 3.1 Process lifecycle

`src/index.ts` loads and validates the environment, builds the storage tiers (`buildRepository`), loads the catalog with an encrypted mirror (recovering from it on a fresh host), builds the engine with the live policy as retention source, rebuilds run history from manifests when no catalog exists, creates one shared `JobQueue`, the drill runner, the scheduler and the server, then starts the engine's background workers (WAL streaming, WAL mirroring) and the scheduler. On SIGTERM/SIGINT it stops the scheduler and server, waits up to 15 seconds for in-flight work, stops the workers and flushes the catalog mirror.

### 3.2 Engines

`createBackupEngine()` selects `PgNativeEngine`, `WalGEngine` or `BarmanEngine` from `BACKUP_ENGINE_MODE`.

| Engine | Where it runs | Needs |
| :--- | :--- | :--- |
| `pg-native` | same host or a dedicated backup host | PostgreSQL 18 client/server binaries, `zstd`, `tar`; S3 optional |
| `wal-g` | same host as the primary (reads `PGDATA`, peer auth as `postgres`) | `wal-g`, S3 |
| `barman` | dedicated backup host | `barman`, `barman-cloud-backup`, S3 |

**Cluster topology** (`config.ts`): `isAuditDedicatedCluster()` is true when `PG_AUDIT_DATA_DIR` is set or `PG_AUDIT_HOST` differs from `PG_PRIMARY_HOST`. `PG_AUDIT_PORT` is deliberately not used (it defaults to 5434 and would make every shared deployment look dedicated). `target=all` expands to `postgres_core`, `audit_db` (when an audit database is configured) and `redis` (when `REDIS_URL` is set). In a shared cluster `audit_db` is a logical dump plus signed manifest (skipped for `all` when the database is absent, an error for an explicit request); in a dedicated cluster it is a physical backup plus a dump. This applies to all three engines, so `PG_AUDIT_DATA_DIR is required` no longer occurs. `backupDaemonEnv()` leaves `PG_AUDIT_DATA_DIR` empty when the audit node resolves to the primary's own cluster (same SSH host and service port), so the shared-cluster logical-dump path is actually selected; a dedicated audit node or an explicit `PG_AUDIT_DATA_DIR` still selects the physical audit backup. On Arch-family hosts the daemon's `PG_BIN_DIR` (`/usr/lib/postgresql/<version>/bin`, a Debian layout) must resolve to the PostgreSQL tools; the single-box local setup aliases it to `/usr/bin`.

**pg-native backups**

- Tablespaces: a cluster with non-default tablespaces is refused before any backup is produced (and a produced backup containing anything but `base.tar`/`pg_wal.tar`/`backup_manifest` is refused), because the native restore would silently lose them.
- Full: `pg_basebackup --format=tar --wal-method=stream --checkpoint=fast --manifest-checksums=SHA256`, verified with `pg_verifybackup --format=tar --no-parse-wal` (tar verification cannot parse WAL), then `tar -> zstd -6 -> AES-256-GCM` into every tier. A logical `pg_dump --format=custom --compress=zstd:6` of the core and audit databases is stored with every full backup and checked with `pg_restore --list`.
- Delta: `pg_basebackup --incremental=<parent backup_manifest>` (PostgreSQL 17+). It requires `summarize_wal = on` and a previous verified backup and otherwise fails; it never silently becomes a full. The parent's `backup_manifest` is kept under `<catalog dir>/manifests/` and recovered from the parent artifact when local state is gone.
- The signed manifest is written last; a failed run deletes everything it wrote.
- Redis is dumped with `redis-cli --rdb` and stored encrypted in the repository.

**Continuous WAL** has two de-duplicated paths. `pg_receivewal --synchronous` runs supervised (restart with backoff, interruptible on stop) against a persistent slot (`PG_REPLICATION_SLOT`, created with `--if-not-exists`); finished segments are encrypted into the repository and leave the private 0700 spool, the `.partial` segment stays so a restore can use it. Independently the database's `archive_command` runs `curl --upload-file` to `PUT /v1/wal/:target/:file` over mTLS with the `wal-archive-client` certificate. Ingest is idempotent (same bytes acknowledged), refuses different bytes for an existing name with 409 (the archive is never overwritten) and is acknowledged once stored on the first tier; other tiers are mirrored asynchronously with retry and a periodic reconcile. A streamed segment that conflicts is quarantined under the spool `conflicts/` directory.

**Disaster recovery ("latest")**: `RecoverRequest.latest` (HTTP `POST /v1/drills/run {"latest": true}`, exclusive with `targetTime`) omits `recovery_target_*` so PostgreSQL replays every archived segment plus the streamed `.partial` one and promotes when the WAL runs out. It is supported by all three engines (Barman omits `--target-time`). It is how a lost primary is rehearsed from the backup host alone.

**Restore** picks the newest verified backup finished at or before the target time, resolves its chain to a full backup, fetches each artifact from the first tier whose copy matches the signed SHA-256 (a damaged local copy falls through to the next tier), decrypts and extracts it, runs `pg_combinebackup` for chains, extracts the newest backup's `pg_wal.tar`, and returns a recovery fragment whose `restore_command` is `bun src/walFetchCli.ts <target> %f %p`. `walFetchCli` reads the daemon environment (inherited by the scratch PostgreSQL), takes the WAL from the first tier that has it, decrypts it, and falls back to the streamed `.partial` file. `recovery_target_time` uses a numeric UTC offset because PostgreSQL rejects an ISO `Z` suffix while reading its configuration.

**Retention** (`prune`) follows the live maker-checker policy: whole backup chains older than `fullRetentionDays` are removed with their artifacts and dumps, the newest full backup and its deltas are never removed, WAL older than the first segment of the oldest retained full backup (and older than `walRetentionDays` on the local tier) is removed, timeline history files are kept, tampered manifests are ignored and never trigger deletes. WAL-G prunes `retain FULL ceil(days/7)` from the same policy; Barman keeps server-side retention.

**WAL-G and Barman** keep their command builders. WAL-G talks to PostgreSQL over the local socket as `postgres`; it is intentionally NOT pointed at `PG_PRIMARY_HOST`/`PG_PRIMARY_USER` (that is the application role, which cannot start a backup). Barman health runs `barman check` (audit only for a dedicated cluster) and proves the object store with the daemon's own S3 client; it never calls `wal-g`.

**Archive lag** only counts while archiving is genuinely behind: time since the last archive is reported when a COMPLETED segment is waiting (current segment > last archived + 1) or the archiver is failing (`last_failed_time` newer than `last_archived_time`); the segment currently being written is not late, so an idle database (no WAL) no longer alarms.

**WAL stream lag**: the `wal-stream-<target>` health target shows how far the stream is behind the primary, read from `pg_replication_slots.restart_lsn` (visible to every role, unlike `pg_stat_replication`), and is unhealthy above `BACKUP_STREAM_ALERT_BYTES` (default 256 MiB). A running stream that is a gigabyte behind is not protecting the data; `pg_stat_archiver` lag alone did not show that.

**Health** reports every storage tier (local repository, S3, off-site vault), the primary (and dedicated audit) cluster, Redis, `wal-stream-<target>` and a WAL mirror backlog, plus WAL lag from `pg_stat_archiver`. `last_archived_wal` is a segment file name; the byte lag is computed from segment numbers (`walNames.ts`) and the file name is never passed to `pg_wal_lsn_diff()`.

### 3.3 Storage tiers and encryption

`artifactStore.ts` defines three tiers behind one interface, addressed by relative keys (`backups/<target>/<id>.tar.zst.enc`, `wal/<target>/<segment>.zst.enc`, `logical/<db>/<id>.dump.enc`, `catalog/catalog.json.enc`): a local repository (atomic temp+rename), S3/MinIO/R2 through `Bun.S3Client` (SigV4), and an off-site vault (`rsync` with a remote `sha256sum` check, or `rclone`). The vault is append-only unless `BACKUP_SECONDARY_MIRROR_DELETE=true`. Local and S3 are required for a write to succeed; the vault is best effort. S3 is optional for `pg-native`.

`cryptoEnvelope.ts`: `"PGBKv2" | version | salt(16) | iv(12) | AES-256-GCM ciphertext | tag(16)`; payload key `HKDF-SHA256(master, salt, "pg-backup-v2:payload:<target>:<id>")`; the header and `<target>:<id>` are GCM additional data; compression precedes encryption; any modification fails closed and leaves no partial plaintext. Manifest times (`startedAt`/`completedAt`) come from the PRIMARY's `clock_timestamp()` (falling back to the local clock), because recovery targets are the primary's commit times and a dedicated backup host's clock can disagree. Manifests (`BackupManifest`, schema 2) record LSNs, WAL range, parent, sizes, SHA-256 of plaintext and ciphertext, encryption metadata, the `pg_verifybackup` result and tiers, and are HMAC-SHA256 signed under `HKDF(master, "pg-backup-v2-catalog", "manifest-hmac-sha256")`. A manifest that does not verify is ignored.

### 3.4 HTTP server, roles and job queue

`src/server.ts` serves JSON; bodies other than WAL are capped at 256 KiB, responses are `no-store` with recursive credential redaction.

| Method | Path | Role | Purpose |
| :--- | :--- | :--- | :--- |
| GET | `/health` | control | liveness, engine mode, version |
| GET | `/v1/overview` | control | health, WAL, targets, policy, scheduler, `jobs`, `walArchive`, recent runs/drills |
| POST | `/v1/backups/trigger` | control | `{ target, kind }` -> 202 `{ backupJobId, queuePosition }` |
| POST | `/v1/drills/run` | control | `{ requestedBy?, targetTime? }` -> 202 `{ drillId, queuePosition }` |
| PUT | `/v1/policy` | control | full policy object |
| GET | `/v1/runs`, `/v1/drills` | control | `limit` 1-500 |
| PUT | `/v1/wal/:target/:file` | wal | raw WAL body <= `BACKUP_WAL_PUSH_MAX_BYTES`; 200/409/413/400/501 |

**mTLS roles.** The public listener is a `node:tls` server (Bun's `node:https` has no `getPeerCertificate()`; verified on Bun 1.4) that verifies the client chain, classifies the certificate CN/DNS SAN and bridges the decrypted stream to a per-role inner Bun listener on a private unix socket (loopback port on win32): `BACKUP_ALLOWED_CLIENT_CNS` (default `backup-client`) -> `control` (every route except WAL upload); `BACKUP_WAL_CLIENT_CNS` (default `wal-archive-client`) -> `wal` (only WAL upload); anything else 403. No HTTP is parsed in the gateway. The `wal-archive-client` certificate lives on the database hosts, so a compromised database host can push WAL but cannot read the catalog, change the policy or trigger jobs. Plain HTTP exists only with `BACKUP_ALLOW_INSECURE_HTTP=true` (role `open`).

**Job queue** (`jobQueue.ts`): every backup and drill, HTTP or scheduled, runs through one FIFO queue, one job at a time; a scheduled slot that finds the queue busy is skipped with a warning; the queue holds 25 waiting jobs, beyond which a request gets 429 and a FAILED run row. `Idempotency-Key` (1-128 chars of `[A-Za-z0-9._:-]`) returns 202 with the original job id and `deduplicated: true`; keys are scoped per route, expire after 24 h and the dedupe check and enqueue are atomic.

**Restart behavior** (`startup.ts`, `instanceLock.ts`): keys are persisted to `<catalog dir>/idempotency-keys.json`. At boot, runs left `QUEUED`/`RUNNING` by the previous process are marked `FAILED` ("interrupted: the daemon restarted...") instead of staying `RUNNING` forever, and keys are restored only for jobs that really finished: an interrupted job's key is dropped, so a client retry starts a fresh job instead of being handed the id of one that died with the old process. A pid lock (`<catalog dir>/daemon.lock`) refuses a second daemon on the same state directory (a stale or recycled-pid lock is taken over); it does not detect a daemon on another host.

### 3.5 Scheduler, catalog and mirror

`scheduler.ts` is unchanged except that it enqueues through the shared queue. `catalogStore.ts` keeps runs, drills and policy in one atomically written JSON file and, when a mirror is configured, uploads an encrypted, HMAC-signed copy to every tier after each save (latest-wins, never blocks or breaks a write). With no local catalog the store recovers from the first tier whose copy decrypts and verifies; a tampered or wrong-key copy is ignored. `importRuns` merges history rebuilt from manifests.

### 3.6 Restore drill

`restoreDrillRunner.ts` (`targetTime` defaults to now - 5 minutes and may be supplied, never in the future):

1. Stops and clears scratch; recovers the core cluster (and the audit cluster only when dedicated).
2. Makes the data directory startable: a physical backup holds `PGDATA` only and Debian-style clusters keep `postgresql.conf`/`pg_hba.conf` outside it, so a minimal config is generated, sized from `pg_controldata` (hot standby refuses to start below the primary's `max_connections` and related settings).
3. Appends the recovery settings and forces archiving off (`archive_mode=off`, `archive_command=''`, no slot/standby names, `ssl=off`). The restored `postgresql.auto.conf` carries the production `archive_command`; without this a promoted scratch cluster pushed `00000002.history` and timeline-2 WAL into the production archive in the live test and every later restore failed.
4. Starts on loopback and waits for recovery to finish and promote (`pg_is_in_recovery() = f`, up to `BACKUP_RECOVERY_TIMEOUT_MS`); a failed start includes the server-log tail.
5. Runs three checks: double-entry zero drift, sharded balance parity, and the audit hash chain. Core queries run as `PG_PRIMARY_USER`; audit queries always run as `PG_AUDIT_USER` (the primary role when unset), because only the audit role is granted on the audit database and a dedicated audit cluster does not have the core application role.
6. Signs the report with HMAC-SHA256 and destroys the scratch cluster.

The audit chain accepts either canonical form: the database's own `before_json::text`/`after_json::text` with the timestamp formatted as the trigger formats it (what the trigger hashes), or the application's stable-JSON form; `seq_no` must be gap-free so a deleted row is detected. In a shared cluster a missing audit database is restored from the newest logical dump into the same scratch cluster.

### 3.7 Two-host lab

`deploy/backup-daemon/test/lab/two-host.lab.test.ts` (skipped unless `LAB_B_HOST`, `LAB_B_USER`, `LAB_B_PASSWORD` are set; credentials only from the environment; `LAB_KEEP=1` leaves host B provisioned) puts a throwaway primary on this machine (Debian-style config, TLS on, scram, `hostssl`-only for host B) and the daemon alone on a second machine as the `pg-backup-daemon` systemd service running as `pgbackup`, with no PostgreSQL server running there. The backup env, the systemd unit, the `archive_command` and the cluster SQL are rendered by the REAL provisioner functions; the only substitution is host A's certificate directory (no root on A). It also runs the deploy engine's `bunInstallCommand` and opens the daemon port in the host's ufw to host A alone, as the deploy firewall policy does. Verified: B is a dedicated backup host (no PostgreSQL server, nothing on 5432, daemon user `pgbackup`); mTLS across the LAN with `wal-archive-client` limited to WAL; full backup over `hostssl` + scram with `pg_dump` as the least-privilege audit role; WAL by both paths; delta; 24 restore drills on B in 41 s while the primary held 3,005 tps / 0.08 ms before and 2,995 tps / 0.09 ms during; and host A total loss (`kill -9`, data deleted) recovered from B alone: 128 of 128 ledger lines including commits never archived, 84 audit rows, drift 0.0000.

### 3.8 Core, edge and deploy integration

`core-back` forwards a well-formed `Idempotency-Key` to the daemon and returns `deduplicated` without a new local row; `GET /overview` adds `walArchiveHealthy` (daemon healthy and archive lag within the policy alert threshold). `admin-back` relays the key and exposes `GET /system/backups/catalog`. `hostPlanner.backupCoreEnv()` injects `BACKUP_DAEMON_URL`, cert paths and `BACKUP_DAEMON_TIMEOUT_MS` into core whenever `BACKUP_ENABLED`, independent of `pgStorageConfigured`.

`backupEngineProvisioner.ts` writes `backup.env`, the unit and (pg-native) the DB-host settings (`archive_mode=on`, `archive_command` via curl, `archive_timeout=60s`, `summarize_wal=on`, the replication role); it installs the PostgreSQL client and server binaries on the backup host and masks the default `postgresql` service on a host that runs no managed cluster. `backupDaemonUser()` is `postgres` only for wal-g co-located with the primary, otherwise `pgbackup`. The unit has no `SupplementaryGroups`, sets `HOME` and `BUN_INSTALL_CACHE_DIR` under `/var/lib/pg-backup` and includes the local repository in `ReadWritePaths`. The cron drill fallback (`pg-backup-restore-drill`, used only when the daemon scheduler is disabled) asks the daemon for a drill for EVERY engine; the former root shell script (latest base backup, no WAL replay, double-entry only) is gone. `deploy.ts` chowns the daemon certificate directory to the daemon user, installs `wal-archive-client` and the CA in `/etc/pg-deploy/certs` on PostgreSQL hosts (key group-readable by `postgres`), runs `bun install` as the daemon user and waits up to 10 s for the unit to stay active, printing `journalctl` and exiting 1 on failure. `pkiManager` issues `wal-archive-client` (CN `wal-archive-client`) and distributes it only to `pg-primary` and `audit-db` hosts.

## 4. Contracts and invariants

- The daemon listens over mTLS by default and refuses plain HTTP unless explicitly allowed.
- Control routes require a `backup-client` CN; WAL upload requires a `wal-archive-client` CN and nothing else; the lists must be disjoint.
- Backups, drills and scheduled slots never overlap; trigger and drill return 202 and complete asynchronously; the catalog is the state store.
- A stored WAL file is never overwritten; a backup does not exist until its signed manifest does.
- Every artifact is authenticated-encrypted; a tampered manifest, ciphertext or catalog copy fails closed.
- A drill never writes into the production archive and always destroys its scratch cluster.
- Secrets are redacted from responses and error text; passwords travel only in child environments.
- Retention follows the live policy and never removes the newest full backup.

## 5. Data / API / config / deployment surface

See `deploy/backup-daemon/README.md` section 7 for the full key table. Additions in this change: `BACKUP_ENGINE_MODE=pg-native`; `BACKUP_LOCAL_REPO_DIR`, `BACKUP_WAL_SPOOL_DIR`, `BACKUP_STAGING_DIR`, `BACKUP_WAL_CLIENT_CNS`, `BACKUP_WAL_PUSH_MAX_BYTES`, `BACKUP_WAL_STREAMING_ENABLED`, `BACKUP_RECOVERY_TIMEOUT_MS`; `PG_AUDIT_HOST/_USER/_PASSWORD`, `PG_LOG_DB_NAME`, `PG_REPLICATION_USER/_PASSWORD`, `PG_REPLICATION_SLOT`, `PG_AUDIT_REPLICATION_SLOT`, `PG_SSLMODE`. `BACKUP_PRIMARY_S3_ENDPOINT/_BUCKET` are optional for `pg-native` and required for the others. Deploy-side keys: `BACKUP_LOCAL_REPO_DIR`, `BACKUP_WAL_CLIENT_CNS`, `BACKUP_DAEMON_TIMEOUT_MS`.

## 6. Operational usage

```bash
cd deploy/backup-daemon && bun install && bun run typecheck && bun test
```

On a deployed host use `systemctl status pg-backup-daemon`, `journalctl -u pg-backup-daemon` and a `curl` with `internal-ca.crt`, `backup-client.crt` and `backup-client.key`. Admin triggers and policy changes go through core; policy changes require a second user. A manual drill accepts `targetTime` directly on the daemon.

## 6a. Engine default (ADR-0004)

`BACKUP_ENGINE_MODE` defaults to `pg-native` and `auto` means `pg-native`; `wal-g` and `barman` must be chosen explicitly and keep their rules (wal-g only on the primary's host). S3 is optional for pg-native and required for the others. See `DECISIONS.md` ADR-0004 for the evidence and the consequences.

## 7. Status and deviations

### Implemented

- pg-native full/delta/logical backups, signed manifests, three-tier storage, chain restore, live-policy retention, continuous WAL (mTLS push + `pg_receivewal`), job queue and idempotency, per-role mTLS, catalog mirror and recovery.
- WAL-G/Barman fixes (shared audit, Barman health, archive status query, policy retention) and the drill fixes (JSONB-text audit hashes, gap check, shared cluster, config bootstrap, archive neutralization, promotion wait, target time).
- Deploy wiring fixes and gate 10 completion polling.

### Partial

- The deploy engine's SSH execution of the pg-native provisioning has not been run end to end against a host (see the gaps).

### Missing / deferred

- Log-database backup target, a verify-only restore mode, multi-tablespace restore (refused at backup time).

### Resolved by the two-host lab (same day)

- Host-loss recovery with zero loss of committed data ("latest" mode), restore drills not stalling the primary, and the dedicated-host provisioning path on a real systemd host; WAL stream lag now visible in health; manifest times independent of the backup host's clock; the daemon no longer logs a client disconnect as an unhandled failure.

### Resolved after the first implementation pass (same day)

- Idle-database false lag alarms; idempotency keys lost on restart and runs stuck `RUNNING` after a crash; second daemon on one state directory; unrestorable backups of clusters with extra tablespaces; the narrow root shell drill; drill role mapping for audit queries (dedicated and shared); the reserved `pg_audit_writer`/`pg_log_writer` default role names; least-privilege audit dump.

## 8. Verification and tests

```bash
cd deploy/backup-daemon && bun run typecheck && bun test
cd deploy && bun run typecheck && bun test
cd core-back && bun test test/backup-admin      # DB-backed: needs a private PostgreSQL
cd admin-back && bun test test/backups.test.ts
```

`live-pg18-pitr.test.ts` runs a private throwaway PostgreSQL under `/tmp` (Debian-style external config, `ALTER SYSTEM` archive settings, `max_connections=150`) with the real daemon over mTLS, `curl` as `archive_command` and real `pg_receivewal`. It covers: full backup with logical dumps, ciphertext and manifest checks, PITR to a point before an injected operator error (the error is excluded, 64 journal lines recovered), a full+delta chain restored through `pg_combinebackup`, the production archive staying free of timeline-2 files, a double-entry drift, a shard drift, a tampered audit row and a deleted audit row each failing exactly the right check, and a one-byte corrupted local copy surviving through the S3 copy while corrupting both fails at the integrity gate. A negative control (archive safety removed) makes it fail as expected. It skips when the PostgreSQL 17+ binaries, `zstd`, `curl`, `tar` or `openssl` are missing.

The live test also runs the audit database as the deployment's least-privilege role (`PG_AUDIT_USER`, SELECT/INSERT on `audit_records` only) for both the logical dump and the drill's chain check, and asserts that role cannot read the ledger or delete audit rows.

Not covered: the dedicated-backup-host and host-loss topologies on real machines, a dedicated audit cluster drill live (unit-tested), S3 against a real MinIO (a fake `S3ClientLike` and `Bun.S3Client` contract only), the off-site vault against a real SSH host.

## 9. Deviations from the 2026-11-06 reliability design

| Design claim | What was found and done |
| :--- | :--- |
| RC-05: the node:tls to unix-socket bridge drops frames | Not reproduced: 50 sequential and 50 concurrent keep-alive TLS 1.3 requests plus a POST passed on Linux. The bridge is kept. |
| Fix 3: use `node:https` and `req.socket.getPeerCertificate()` | `getPeerCertificate` is `undefined` on Bun 1.4's `node:https`. Authorization is done by classifying the certificate in the `node:tls` front and bridging to per-role inner listeners. |
| `pg_verifybackup` on tar backups | Requires `--no-parse-wal`; the drill proves the WAL. |
| `isAuditDedicatedCluster` includes `PG_AUDIT_PORT !== PG_PRIMARY_PORT` | The port defaults to 5434, so every shared deployment would look dedicated; the port is excluded. |
| `walGEnvironment` should use `PG_PRIMARY_HOST`/`PG_PRIMARY_USER` | Rejected: that is the application role and cannot start a backup; WAL-G runs as `postgres` on the local socket. |
| DB hosts push WAL with `pg-client` or `backup-client` | A dedicated `wal-archive-client` certificate is used. `pg-client`'s key also lives on core hosts and `backup-client` has full control-plane authority. |
| `recovery_target_time` as ISO with `Z` | PostgreSQL rejects it at startup; a numeric UTC offset is used (also fixes WAL-G's recovery config). |
| (not in the design) scratch cluster inherits `archive_command` | Archiving is forced off in every scratch cluster. |
| (not in the design) restored `PGDATA` has no configuration on Debian layouts | A minimal config sized from `pg_controldata` is generated. |
| Fix 6: academy question ids `q-m10-004..008` | They collided with existing questions; new ids continue the sequence. |
| (not in the design) default PostgreSQL role names | `PG_DB_USER` (`pg_core_user`) and `PG_REPLICATION_USER` (`pg_replicator`) defaulted to reserved `pg_*` names too, found when the lab rendered the real provisioner SQL. Defaults are now `gw_core_user`/`gw_replicator`, every role setting rejects `pg_*`, and test fixtures that used `pg_owner`/`pg_authoritative_user` were renamed. |
| (not in the design) `bunInstallCommand` symlinked bun into a home directory | The lab's first real run failed with `status=203/EXEC`: `/usr/local/bin/bun` was a symlink into `/home/<user>/.bun` (home is 0750), unreadable by the service user. The command now installs a real copy atomically and converts an existing symlink. |
| (not in the design) default audit/log role names | `AUDIT_DB_USER`/`LOG_DB_USER` defaulted to `pg_audit_writer`/`pg_log_writer`; PostgreSQL reserves `pg_*` so `CREATE ROLE` always failed. Defaults are now `gw_audit_writer`/`gw_log_writer` and `pg_*` is rejected at config load. |
| `BACKUP_ENGINE_MODE` default becomes `pg-native` | Adopted on 2026-11-06 (ADR-0004), after the single-host live test and the two-host lab. It was first left unchanged: `auto` keeps wal-g/barman until the two-host lab has run pg-native. |
| RC-03 root cause | Narrower than claimed: a full run re-chowned the certificate directory later in the storage step; it affected partial and rotate-only runs. |
| RC-07 `go install @latest` | Already a pinned version; only the lab's all-zero `BACKUP_WALG_SHA256` fallback was a defect. |
| Design 5.1/5.2 "5-gate" drill | The drill has three invariant checks; guide and academy content say so. |

## 10. Source references

### Old design sections

- `design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` sections 5.1 and 5.2.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6.

### Code paths

- `deploy/backup-daemon/src/`: `index.ts`, `server.ts`, `jobQueue.ts`, `backupEngine.ts`, `pgNativeEngine.ts`, `pgTools.ts`, `walArchive.ts`, `walNames.ts`, `walFetchCli.ts`, `logicalDump.ts`, `artifactStore.ts`, `repository.ts`, `cryptoEnvelope.ts`, `catalogStore.ts`, `catalogMirror.ts`, `restoreDrillRunner.ts`, `scheduler.ts`, `config.ts`, `util.ts`.
- `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/provisioners/postgres18Provisioner.ts`, `deploy/deploy.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/pkiManager.ts`, `deploy/test-matrix/gates.ts`.
- `core-back/lib/storageEngine/backupControlClient.ts`, `core-back/api/internal/backups.ts`, `admin-back/api/protected/backups.ts`.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 11. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.
- 2026-11-05: mTLS per-CN authorization, WAL-G env files, mirror delete opt-in.
- 2026-11-06: two-host lab pass: "latest" recovery, primary-clock manifests, stream lag health, `AbortError` handling, reserved default role names (`PG_DB_USER`, `PG_REPLICATION_USER`), real-copy bun install, the lab itself.
- 2026-11-06: gap-closure pass: idle lag, restart state and instance lock, tablespace guard, drill role mapping, cron fallback drill, reserved default role names, least-privilege live coverage.
- 2026-11-06: backup engine reliability implementation (previous revision): pg-native engine, three-tier encrypted repository, signed manifests and catalog mirror, WAL ingest over mTLS plus streaming, shared job queue and idempotency, per-role mTLS, topology-aware audit handling, drill fixes, deploy wiring fixes; section 9 lists where the design was corrected.

## Object storage parity, escrow and drill

`deploy/backup-daemon/src/objectStorageBackup.ts` copies new HOT/COLD
`.v1.enc` blobs into `object-blobs/{bucket}/{storageKey}` (immutable, so the
copy is incremental), fails with `OBJECT_STORAGE_BACKUP_PARITY_ERROR` when an
ACTIVE row has no blob on every required tier, repairs missing tier copies, and writes per-KEK-version escrows plus the legacy `object-storage/kek-escrow.enc` (AES-256-GCM
under the backup master key). The restore drill samples up to
`OBJECT_STORAGE_DRILL_SAMPLE` ACTIVE rows, decrypts them with the escrowed
keyring and compares the SHA-256; the report's `checks.objectStorage` carries the
result; the drill tries every tier and the escrow for the row's KEK version. The daemon receives the object-storage URL/client certs/KEK keyring from
the deploy engine.

## Health Verification, Rollback and Recovery

> Status: `partial` · Last verified: 2026-11-12

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
- stays reachable when the database cannot be read, with `queue.degraded=true` and `QUEUE_HEALTH_UNAVAILABLE`;
- advertises the deploy identity (`release`, `commit`) from `APP_RELEASE`/`APP_COMMIT`; the batch probes and final verification require the expected release, so a stale process behind the port fails even if its `/health` says `OK`.

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
- checks core-node, edge-backend, edge-to-core and Fake Rails health against the expected release identity;
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


## Object storage probes

Every storage-only deploy checks `systemctl is-active pg-object-storage-daemon` on the storage host and `/v1/health` over mTLS from every core and backup host. A missing or unhealthy daemon fails verification.
