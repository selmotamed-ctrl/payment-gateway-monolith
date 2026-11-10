---
id: deploy.topology
title: Deploy Topology and Configuration
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - deploy/test-matrix/topologies.ts
  - deploy/deploy.ts
  - deploy/deploy.sh
  - deploy/lib/configSchema.ts
  - deploy/lib/hostPlanner.ts
  - deploy/deploy.env.example
  - deploy/DEPLOYMENT_GUIDE.md
  - deploy/lib/quoting.ts
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#1-flexible-1n-compute--storage-topology-model-same-server-vs-fully-distributed
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#3-multi-host-configuration-architecture-deployenv--zod-4-validator
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#6-segment-5--horizontal-node-scaling--multi-host-storage-orchestration-in-deploydeployenv--deploydeployts
tests:
  - deploy/test/gap-hardening.test.ts
  - deploy/test/testMatrix.test.ts
  - deploy/test/configScale.test.ts
  - deploy/test/hostPlanner.test.ts
  - deploy/test/hostPlannerScale.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
  - deploy/test/fakeRails.test.ts
  - deploy/test/pipeline.test.ts
  - deploy/test/security-regressions.test.ts
gaps:
  - Two-machine configs require HOST_B reachable; live T1-T8 validation is pending.
  - DEPLOY_MODE=auto does not detect a missing remote directory; it behaves like update unless --fresh is passed.
  - DEPLOY_MODE=rolling_update is accepted by the enum but has no distinct behavior.
  - The deployment guide says legacy DB_* credentials win when both blocks are present; the code makes PG_* authoritative when any PG field is configured.
  - PG_VERSION accepts any one- or two-digit major version even though the project invariant is PostgreSQL 18.
  - Replication password requirements are not enforced when replicas are configured but PG_MANAGE_VIA_SSH is false.
  - Real SHA256 values for WAL-G, bun and barman versions must be supplied by the operator (TRACKER GAP-023).
---

# Deploy Topology and Configuration

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
3. **Derived database URL.** When the PostgreSQL tier is configured and a host exists, `DATABASE_URL` is derived from the PG credentials, the primary private IP and `PGBOUNCER_PORT` when enabled; otherwise the explicit `DATABASE_URL` is used.
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
| `--only=core,checkout` | Restrict roles. Storage aliases: `pg`, `pg-primary`, `pg-replica`, `pgbouncer`, `redis`, `audit-db`, `log-db`, `backup`, `storage`. |
| `--nodes=<id,...>` | Restrict compute units by node id. |
| `--rolling-batch=<n>` | Override `ROLLING_BATCH_SIZE`. |
| `--keep=<n>` | Override `KEEP_RELEASES`. |
| `--fresh`, `--update` | Force bootstrap or no bootstrap. |
| `--enforce-firewall` | Re-apply UFW without a full bootstrap. |
| `--skip-build`, `--skip-verify` | Skip local SPA builds or end-to-end verification. |
| `--rotate-certs` | Rotate the CA and every leaf. |
| `--check-certs` | Print the certificate expiry table and exit 1 when a certificate is missing, expired or inside `MTLS_RENEW_WITHIN_DAYS` (AUTO-28). |
| `--dry-run` | Print commands; execute nothing. |

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

`PG_APP_USER` (default `pgw_app_login`) and `PG_APP_PASSWORD` (at least 12 characters, different from the owner's) enable the role split: the owner (`PG_DB_USER`) runs migrations and seeders through `ownerUrl`, while the running services connect as `PG_APP_USER`, a plain LOGIN member of `pgw_app`. `PG_APP_USER` must not be `postgres`, `pgw_app` or `pgw_ledger_maintenance`, nor equal the owner or replication user. Without `PG_APP_PASSWORD` the legacy single-role behaviour is kept and the deploy warns.
