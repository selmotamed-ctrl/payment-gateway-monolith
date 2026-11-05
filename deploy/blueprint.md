<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# deploy blueprint

Generated from: `deploy.topology`, `deploy.planner`, `deploy.pki`, `deploy.firewall`, `deploy.pipeline`, `deploy.storage`, `deploy.backup`, `deploy.health`.

## Deploy Topology and Configuration

> Status: `partial` · Last verified: 2026-11-05

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
| Global | `DEPLOY_MODE`, `DEPLOY_ENV`, `KEEP_RELEASES`, `ROTATE_MTLS_CERTS`, `MTLS_VALIDITY_DAYS`, `LAN_ALLOWED_CIDRS`, `ROLLING_BATCH_SIZE` | Pipeline mode, release retention, certificate rotation and LAN policy. |
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
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE`, `BACKUP_SSH_USER`, `BACKUP_SSH_PORT`, `BACKUP_SSH_KEY_PATH`, `BACKUP_SUDO_PASSWORD`, `BACKUP_ENGINE_MODE`, `BACKUP_COMPRESSION`, `BACKUP_ENCRYPTION_KEY_HEX`, `BACKUP_PRIMARY_S3_*`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET`, cron/retention/alert keys, `BACKUP_DAEMON_*`, `BACKUP_CATALOG_PATH`, `BACKUP_PGPASSFILE`, `BACKUP_SCRATCH_*`, `BACKUP_COMMAND_TIMEOUT_MS`, `BACKUP_ALLOW_INSECURE_HTTP`, binary paths, `BARMAN_AUDIT_SERVER` | WAL-G/Barman, daemon listener, catalog, drills and schedule. |
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
- SSL mode is `certbot`, `custom` or `self_signed`.

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
- **New optional keys.** `BACKUP_WALG_VERSION` (default 3.0.9), `BACKUP_WALG_ASSET`, `BACKUP_BARMAN_VERSION` (3.10.1), `BUN_VERSION`, `BUN_SHA256`, `BACKUP_ALLOWED_CLIENT_CNS`, `BACKUP_SECONDARY_MIRROR_DELETE`, `PG_RAM_GB`, `PG_IO_METHOD`, `PG_REPLICA_REBUILD`; required `BACKUP_WALG_SHA256` in wal-g mode; lab key `LAB_WALG_SHA256`.
- `PG_REPLICATION_*` is no longer written to the core app env.

## Gap resolutions (2026-11-05)

- **PAN-rail guard (GAP-026, partially resolved).** `loadDeployConfig` runs `panRailGuardProblems` over the environment: a key naming a PAN/CVV/card-number rail (`PAN`, `CVV`, `CVV2`, `CVC`, `CVC2`, `CARD_NUMBER`, `CARD_NO`, `PAN_RAIL(S)`, `CARD_RAIL(S)` as an underscore-delimited token) or a value containing a Luhn-valid 13-19 digit run is refused with a `PAN_RAIL_GUARD` problem. The scope statement is `deploy/docs/pci-scope.md` (see `platform.security`); the core-back guard is still open.
- **GAP-023 remains open:** real WAL-G, bun and barman SHA256 values are operator-supplied.

## Host Planner

> Status: `implemented` · Last verified: 2026-11-05

## 1. Purpose and scope

The host planner converts a validated `DeployConfig` into a `DeployPlan`:

- unique hosts keyed by `sshHost:sshPort`;
- per-host roles, services, Nginx sites, certificate bundles, firewall rules and deploy order;
- per-tier node plans for core, admin, merchant and checkout;
- the PostgreSQL/Redis/audit/log/backup storage plan;
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

> Status: `partial` · Last verified: 2026-11-03

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
| pg-primary / pg-replica / pgbouncer | CA, `pg-client` cert/key |
| Redis | CA, `redis-client` cert/key |
| audit DB | CA, `audit-db-client` cert/key |
| log DB | CA, `log-db-client` cert/key |
| backup | CA, `backup-daemon` cert/key, `pg-client` cert/key, `backup-client` cert/key |

`readMaterial()` returns the certificate for the CA and both certificate and key for non-CA material. The CA private key is never returned for distribution.

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
- Expiry is reported but does not force rotation.
- The backup daemon does not authorize a client CN per route.

### Missing / deferred

- end-to-end storage mTLS configuration (`ssl=on` with internal certs, `clientcert=verify-full`, Redis TLS, PgBouncer client TLS).
- Automatic renewal before expiry.
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
- backup daemon only from core.

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

## Deployment Pipeline

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part documents the actual `deploy/deploy.ts` pipeline: step order, source synchronization, release layout, PM2 and Nginx activation, rolling batches, seeding, verification, pruning, the pre-migration backup and the backup-daemon source deployment.

It does not own configuration validation (`deploy.topology`), planning (`deploy.planner`), PKI (`deploy.pki`), firewall policy (`deploy.firewall`), storage provisioning (`deploy.storage`) or the backup daemon internals (`deploy.backup`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires a strictly ordered deployment so storage and migrations are live before edge traffic switches: validate and plan; build SPAs; ensure PKI; bootstrap hosts and firewall; provision storage and take a pre-migration backup; deploy core; optionally Fake Rails; admin; merchant; checkout; seed; verify; prune; audit summary.

It also requires atomic releases, a symlinked `current`, least-privilege environment/certificate delivery, rolling batches with health checks and a clean rollback path. The code follows this order but differs in several operational details recorded below.

## 3. As-built architecture

### 3.1 Step 1: validate and plan

`main()` parses CLI options, checks that `deploy.env` exists, loads and validates it, runs `findSshConflicts()`, calls `planHosts()`, prints `renderTopology()` and creates an `SshRunner` with `verbose: true`.

A missing file, schema error, cross-field error or SSH credential conflict aborts before any remote command. With `--dry-run`, every later command is logged instead of executed. Every logged command line passes through `redactSecrets` (`deploy/lib/sshRunner.ts`), which masks the value of any `NAME=value` whose name contains PASSWORD, PASSWD, SECRET, TOKEN, AUTH, API_KEY, ACCESS_KEY or MASTER_KEY (for example `PGPASSWORD=`, `REDISCLI_AUTH=`); before 2026-11-04 these were printed in the clear.

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
- if fresh, detect the OS, install `nginx rsync ufw curl ca-certificates nodejs` (or the Arch equivalent), install Bun if absent, symlink Bun/bunx into `/usr/local/bin`, install PM2 if absent and best-effort register `pm2 startup systemd`. For local targets the symlink and `pm2 startup` paths use the orchestrator's OS user/home, not the configured SSH name, which may not exist on the machine;
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

`preMigrationBackup()` resolves the primary direct port (never PgBouncer) and the PG or legacy credentials, then builds `PGPASSFILE=<private passfile> pg_dump -h <host> -p <port> -U <user> -Fc <db> > <target>.dump`. `backupDatabase()` creates `<CORE_REMOTE_DIR>/shared/backups`, chowns it to the effective target user (the SSH user for a remote host, the orchestrator's OS user for a local target), and runs the command on the **core host** as that user. The file is `pre-migrate-<releaseTimestamp>.dump`.

No dump is taken on a fresh install. A failure aborts before migrations. `pg_dump` must already exist (the bootstrap package list omits `postgresql-client`), the password no longer appears on the command line (PGPASSFILE), and the dump is not automatically verified or restored.

#### Backup daemon source deployment

After `provisionBackupEngine()`, `deployBackupDaemon()`:

- creates `/opt/pg-backup-daemon` owned by the effective target user (the SSH user remotely, the orchestrator's OS user locally);
- rsyncs `deploy/backup-daemon` with `--delete`, excluding `node_modules`, `.git`, `dist`, `test`, `*.log` and `.env`;
- chowns the install directory to `postgres:postgres` (the daemon's service user);
- ensures Bun exists and installs a real copy at `/usr/local/bin/bun` (not a symlink through the SSH user's home, which may not be traversable by `postgres`);
- runs `bun install --frozen-lockfile` as `postgres`;
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

No test performs a real multi-host deployment, migration, PM2 restart or Nginx reload. A live staging run is required for those.

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
- **Migrations.** `planMigrations()` is exported; only the first core node migrates. `--fresh` against a non-empty database is refused unless `--force-fresh` or `DEPLOY_FORCE_FRESH=1`. Update deploys run `migrate deploy` when migrations are pending or unknown. The dump is taken before migrating in both modes when the database is non-empty or unknown.
- **sshRunner** local-sudo writes use an `mkdtemp` 0700 directory removed in `finally`.
- **Bun** is installed from a pinned download verified against `BUN_SHA256` (no `curl | bash`).
- **nginx templates**: `server_tokens off` and `limit_req` (with `limit_req_status 429`) in all six; the fakerails vhost gets `allow`/`deny` from `FAKE_RAILS_ALLOWED_CIDRS`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'self'` (previously `'self' *`); the checkout CSP is unchanged.
- **scripts/deploy-localhost.sh** refuses `NODE_ENV=production` unless `LOCAL_TARGET=1`, no longer falls back to default secrets (random secrets via `openssl rand` go to a 0600 `.local/secrets.env` or `LOCAL_SECRETS_FILE`), and requires `DB_PASSWORD`.
- **CI and legacy deploy workflows (GAP-014, RESOLVED 2026-11-05).** `.github/workflows/ci.yml` (jobs `design`, `backend`, `frontend`; triggers push to `main`/`ayoub`, pull requests and manual dispatch; `contents: read`; concurrency-cancelled per ref) runs the AGENTS.md gate: `bun scripts/project-design/build.ts --check`, then for `core-back`, `deploy`, `deploy/backup-daemon`, `admin-back`, `merchant-back`, `checkout-back` and `fake-rails-back` a frozen-lockfile install, typecheck and `bun test`, and for `admin-front`, `merchant-front`, `checkout-front` and `fake-rails-front` a frozen-lockfile install and `bun run build`. Suites that need PostgreSQL 18 and Redis skip themselves when the services are absent. The per-service `*/.github/workflows/deploy.yml` workflows are now legacy and manual only (`workflow_dispatch` with a typed `deploy` confirmation): they run the service typecheck/tests first, run the deploy job in the `legacy-deploy` environment, use `StrictHostKeyChecking=yes` with a pinned `known_hosts` taken from the **`SSH_KNOWN_HOSTS` secret (which operators must now create, with the server's verified host key lines)**, sync additively (no `rsync --delete`) and never scan the host key on first use. The supported deploy path remains the multi-host engine in `deploy/`. Tests: `deploy/test/ci-workflows.test.ts`.
- **Replica pgpass (GAP-028, RESOLVED).** The replica `.pgpass` is streamed over stdin; see `deploy.storage`.
- **Still open.** GAP-023: real WAL-G/bun/barman SHA256 values must be supplied by the operator.

## Storage Provisioners

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part documents the four modular storage provisioners invoked by the deployment pipeline:

- `postgres18Provisioner.ts`: PostgreSQL 18 primary, replicas, replication slots, `pg_hba`, PgBouncer, tuning and journal partition cron;
- `redisProvisioner.ts`: Redis cache/velocity nodes;
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

The provisioner writes `pg_hba.conf`, applies the bootstrap SQL through `su - postgres`, restarts PostgreSQL, and installs `/etc/cron.d/pg-journal-partitions`:

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

When `PGBOUNCER_ENABLED=true`, PgBouncer is installed and configured on the primary and every replica. `/etc/pgbouncer/pgbouncer.ini` sets `listen_addr=0.0.0.0`, `listen_port=6432`, transaction pooling, `server_tls_sslmode=prefer`, the configured client/pool limits, reserve 10, prepared statements, SCRAM auth and `/etc/pgbouncer/userlist.txt`. The userlist contains the application and replication users with plaintext passwords, mode 0600. PgBouncer is restarted after writing it.

After writing both files, the provisioner resolves the service account from `systemctl show -p User --value pgbouncer` (falling back to `pgbouncer`, then `postgres`) and applies `0640` to the ini and `0600` to the userlist. This is required because Ubuntu's unit runs as `postgres` and does not create a `pgbouncer` system user; a root-owned `0640` file otherwise fails with `could not load file "/etc/pgbouncer/pgbouncer.ini": Permission denied`.

Important as-built facts:

- The `[databases]` section maps `PG_DB_NAME` to `127.0.0.1:<primaryPort>` with `PG_DB_USER` and its password, so a client connecting to `:6432` with that database name reaches the local PostgreSQL primary.
- `server_tls_sslmode = prefer` encrypts the PgBouncer-to-PostgreSQL leg when the server offers TLS; it does not verify the server certificate (`verify-full` would) and supplies no client certificate.
- There is no `client_tls_sslmode`, `client_tls_cert_file` or `client_tls_key_file`; clients are not required to present a certificate.
- `listen_addr = 0.0.0.0` is protected by UFW only; the plan opens 6432 to core sources.

The core environment points `PG_PRIMARY_PORT` and `DATABASE_REPLICA_URLS` at `PGBOUNCER_PORT` when the pooler is enabled; the generated `[databases]` mapping keeps that route working.

### 3.4 Redis

`redisProvisioner.ts` installs `redis-server`, enables it, and writes both `/etc/redis/redis.conf.d/zz-pg-switch.conf` and `/etc/redis/redis.conf` with a deduplicated private-IP + loopback bind, `protected-mode yes`, the node port, `requirepass <REDIS_PASSWORD>`, `save 3600 1`, maxmemory/policy `allkeys-lru`, no append-only file, `daemonize no`, `supervised systemd` and `dir /var/lib/pg-redis`. It writes a systemd drop-in for `redis-server` and `valkey` granting `ReadWritePaths=/var/lib/pg-redis`, runs `systemctl daemon-reload`, runs `ufw allow` for core and backup sources, restarts Redis and verifies with `REDISCLI_AUTH=<password> redis-cli -p <port> PING`.

There is no `tls-port`, `tls-cert-file`, `tls-key-file`, `tls-ca-cert-file` or `tls-auth-clients` setting. Redis traffic is plaintext inside the private network. The generated `redis-client` certificate is unused.

### 3.5 Audit database

`auditAndLogDbProvisioner.ts` installs PostgreSQL on `AUDIT_DB_NODE` when `AUDIT_DB_MANAGE_VIA_SSH` is true, applies a minimal PostgreSQL config (`listen_addresses='*'`, `wal_level=replica`, senders/slots), writes a `pg_hba` restricted to core and backup sources, restarts PostgreSQL, creates the audit role/database, and applies:

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

- `barman`, `zstd`, `lz4`, `brotli`, `xz-utils`, `rclone`, `curl`, `ca-certificates`;
- WAL-G when `BACKUP_ENGINE_MODE=wal-g`, by downloading the pinned asset (`BACKUP_WALG_VERSION`, `BACKUP_WALG_ASSET`) and verifying it against the required `BACKUP_WALG_SHA256` (fail closed), then chmod +x;
- the `pgbackup` system user and `/var/lib/pg-backup`, log and cert directories;
- `/etc/pg-backup/backup.env` from `backupDaemonEnv()`;
- `/etc/pg-backup/wal-g.env` for the core target;
- the systemd unit and `/etc/cron.d/pg-backup`;
- `/usr/local/bin/pg-backup-daemon-trigger` and `/usr/local/bin/pg-backup-restore-drill`;
- Barman configuration and `.pgpass` in Barman mode;
- target reachability checks.

Archive configuration:

- WAL-G: writes `/etc/pg-backup/wal-g-core.env` on the primary and sets `archive_mode=on`, `archive_command` to `wal-g wal-push %p` with the core prefix, `restore_command` to `wal-g wal-fetch`, and `archive_timeout=60s`; restarts PostgreSQL.
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
- Config validation (managed only): access key ≥3 chars, secret ≥8, bucket `s3://dns-bucket[/prefix]`, http endpoint requires `BACKUP_ALLOW_INSECURE_HTTP=true`, https endpoints are rejected (no TLS is provisioned; use `external`).
- `BACKUP_ENGINE_MODE=auto` resolves at load time: `wal-g` when `BACKUP_NODE` shares the PG primary's private IP, `barman` when it is a different host. Explicit `wal-g`/`barman` unchanged.
- `BACKUP_ENGINE_MODE=auto` and `BACKUP_S3_MODE` keys are validated at load; MinIO install order and failure behaviour are described above (and in `04-pipeline.md` §13).
- The two-machine test matrix sets `BACKUP_S3_MODE=external` because it provisions its own object store.

The systemd unit runs `bun run src/index.ts` as `pgbackup` with `EnvironmentFile=/etc/pg-backup/backup.env`, `ProtectSystem=strict`, `NoNewPrivileges=true`, and `ReadWritePaths` for the backup, log, catalog, cert, scratch and pgpass directories.

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
| Backup | `BACKUP_ENABLED`, `BACKUP_NODE`, `BACKUP_ENGINE_MODE` (`wal-g`/`barman`/`auto`), `BACKUP_PRIMARY_S3_*`, `BACKUP_S3_MODE`, `BACKUP_MINIO_*`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET`, `BACKUP_FULL_CRON`, `BACKUP_DELTA_CRON`, `BACKUP_DRILL_CRON`, retention/alert keys, `BACKUP_WALG_BIN`, `BACKUP_BARMAN_BIN`, `BACKUP_BARMAN_CLOUD_BIN` |

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

If PgBouncer is enabled, add a `[databases]` section to `pgbouncer.ini` and restart it before declaring the pooler usable.

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
- The backup provisioner restarts PostgreSQL after changing `archive_command`; a failure can leave the cluster stopped.

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

- `provisionPostgres18()` waits for `pg_isready` on the primary port after restarting PostgreSQL.
- `provisionBackupEngine()` waits after the core and audit archive restarts, restarts PgBouncer after the last PostgreSQL restart, and waits for PgBouncer on `PGBOUNCER_PORT`. The audit target can share the primary cluster, so its restart could otherwise leave PgBouncer caching `the database system is shutting down (server_login_retry)` when the core release runs migrations through `:6432`.
- These waits prevent the core migration step from racing a PostgreSQL restart on single-machine and co-located audit deployments.

## Security hardening (2026-11-05)

- **Quoting.** Provisioners (postgres18, auditAndLogDb, backupEngine) use `deploy/lib/quoting.ts`: SQL literals are escaped, DO blocks use collision-free dollar tags, and `pgbouncer.ini`, `userlist` and `.pgpass` are escaped. `backup.env` and `wal-g.env` are rendered `KEY='value'` (a single quote in a value is rejected).
- **Credentials.** `pg_basebackup` uses `PGPASSFILE`, never `PGPASSWORD`. Bootstrap/audit/log/archive SQL lives in a private 0700 postgres-owned directory, mode 0600, removed by trap/finally.
- **WAL-G.** `restore_command` is a valid `postgresql.conf` literal (inner quotes doubled). The daemon setting `WALG_ENV_FILE` keeps S3/encryption secrets out of that line; the provisioner writes `/etc/pg-backup/wal-g.env` 0640 root:postgres. WAL-G is pinned (`BACKUP_WALG_VERSION=3.0.9`, `BACKUP_WALG_ASSET`) and sha256-verified fail-closed with required `BACKUP_WALG_SHA256`; barman is pinned (`BACKUP_BARMAN_VERSION=3.10.1`).
- **Mirror and restore.** The off-site mirror uses `rclone copy`/`rsync` without `--delete` unless `BACKUP_SECONDARY_MIRROR_DELETE=true`. The scratch restore cluster starts with `-c archive_mode=off`.
- **PostgreSQL.** `listen_addresses = 127.0.0.1,<private IP>`; memory settings derive from optional `PG_RAM_GB` (unset keeps 8GB/24GB/1GB); `PG_IO_METHOD` defaults to `worker` (io_uring is opt-in); an existing standby (PG_VERSION and `standby.signal` present) is not rebuilt unless `PG_REPLICA_REBUILD=true`.
- **Still open.** Real SHA256 values for WAL-G/bun/barman must be supplied by the operator (GAP-023). GAP-022 and GAP-028 are resolved (see the gap resolutions below).

## Gap resolutions (2026-11-05)

- **PostgreSQL TLS and hostssl-only (GAP-022, RESOLVED).** `postgresTlsSnippet` appends `ssl = on`, `ssl_cert_file`/`ssl_key_file` under `<cluster hba dir>/tls`, `ssl_min_protocol_version = 'TLSv1.2'` and `password_encryption = 'scram-sha-256'` to each cluster's configuration. `pgTlsCommands` idempotently creates a self-signed RSA-4096 certificate (825 days, 0600 key owned by `postgres`) on the primary and replicas unless an operator already installed one. `pgHbaSnippet` now emits only `hostssl` rules (loopback `127.0.0.1/32` and `::1/128`, every allowed source for data and replication); the plain `host` rules were removed. Replica `pg_basebackup` runs with `PGSSLMODE=require` and PgBouncer uses `server_tls_sslmode = require`.
- **Backup daemon user (GAP-022).** The backup engine provisioner runs the daemon systemd unit as `User=pgbackup`/`Group=pgbackup` with `SupplementaryGroups=postgres`, adds `postgres` to the `pgbackup` group, and owns `/var/lib/pg-backup`, the daemon certificate directory, the log directory, the barman state directory, `BACKUP_PGPASSFILE` and `/etc/pg-backup/wal-g.env` (`root:pgbackup`, 0640) accordingly.
- **Replica pgpass over stdin (GAP-028, RESOLVED).** `replicaPgpassContent` renders the replication `.pgpass` line and `provisionPostgres18` streams it to `/var/lib/postgresql/.pgpass` (0600) with the remote-file writer; the replication password no longer appears in any command argv. `replicaCommands` only checks and `chown`/`chmod`s the file.
- **UTC (GAP-030).** The cluster configuration also sets `timezone = 'UTC'` and `log_timezone = 'UTC'` (the engine pins its own sessions, see `core.storage`).
- **Still open.** GAP-023: real SHA256 values for WAL-G, bun and barman (`BACKUP_WALG_SHA256`, `BUN_SHA256`) must be supplied by the operator for each release.

## Backup Daemon

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

`pg-backup-daemon` is the backup and point-in-time-recovery control plane for the storage tier. It wraps WAL-G or Barman, owns the full/delta/drill schedule, keeps a local catalog, exposes an mTLS HTTP API and runs scratch restore plus ledger/audit invariant drills.

It owns engine selection, scheduling, the catalog, the HTTP API, target/WAL health and drills. It does not own the PostgreSQL cluster, archive configuration (the provisioner does), the admin approval workflow (core does) or the admin UI.

## 2. Design intent (extracted and synthesized from ./design)

The design calls for a Bun service that supports WAL-G on the database host and Barman on a dedicated backup host, streams WAL with compression and client-side encryption, takes weekly full and daily delta backups for core and audit, snapshots Redis, mirrors to an optional secondary vault, and runs a weekly scratch restore that verifies double-entry zero drift, sharded balance parity and the audit hash chain before signing and cleaning up.

It exposes overview, trigger, policy, run and drill endpoints over mTLS to core, which surfaces them to the admin portal. Policy changes require core-side maker-checker. The historical design's Tripoli 03:00 and hourly Redis claims are superseded; the code uses UTC cron expressions and triggered Redis snapshots.

## 3. As-built architecture

### 3.1 Process lifecycle

`src/index.ts` loads and validates the environment, creates a `SpawnCommandRunner`, creates the WAL-G/Barman engine, loads the catalog (or falls back to memory), builds a default policy, creates the drill runner, scheduler and server, starts the scheduler when enabled, and logs the listener/engine/scheduler state. SIGTERM/SIGINT stops the scheduler and server, waits up to 15 seconds for in-flight work and exits.

### 3.2 HTTP server and mTLS

`src/server.ts` uses `Bun.serve` with a JSON handler:

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/health` | Liveness, engine mode and version. Does not run engine health checks. |
| GET | `/v1/overview` | Engine health, WAL lag, targets, schedule/policy, scheduler state, recent backups and drills. |
| POST | `/v1/backups/trigger` | Validates `{ target, kind }`, queues a run and returns 202. |
| PUT | `/v1/policy` | Persists cron/retention/lag and returns the policy. |
| GET | `/v1/runs`, `/v1/drills` | Recent records with `limit` 1-500. |
| POST | `/v1/drills/run` | Queues a drill and returns 202. |

Bodies are capped at 256 KiB. Responses use `cache-control: no-store` and recursively redact credential-shaped keys/values. `HttpError` becomes a JSON envelope; unexpected errors become a generic 500 with a request id.

`loadTlsOptions()` returns plain HTTP only when `BACKUP_ALLOW_INSECURE_HTTP=true`. Otherwise it requires the server certificate, key and CA and sets `requestCert: true`, `rejectUnauthorized: true`. The daemon verifies the client chain but does not inspect the client CN; any CA-signed client can call every route. Core presents `backup-client`.

### 3.3 Engines

`createBackupEngine()` selects `WalGEngine` or `BarmanEngine`.

**WAL-G**:

- `triggerBackup("all", kind)` expands to `postgres_core`, `audit_db` and, when `REDIS_URL` is set, `redis`;
- refuses `audit_db` when `PG_AUDIT_DATA_DIR` is empty;
- runs `wal-g backup-push <dataDir>` for full, `--delta` for delta;
- verifies the bucket with `wal-g st ls <prefix>`;
- mirrors with `rclone sync` or `rsync -a --delete` when a secondary target exists;
- `prune("all","full")` runs `wal-g delete retain FULL <count> --confirm`; delta pruning is a no-op;
- lists with `wal-g backup-list --json`; `recover()` fetches the latest base backup and returns a recovery fragment;
- Redis backup runs `BGSAVE`, `redis-cli --rdb <tmp>` and `rclone copyto <tmp> <corePrefix>/redis/dump.rdb`, then removes the temp file.

Health checks the S3 target with `wal-g st ls`, PostgreSQL with `psql SELECT 1`, optional secondary/Redis, WAL lag from the first replica or primary, and archive lag/bytes from `pg_stat_archiver`. It is healthy when every target passes and archive lag is within `BACKUP_ALERT_LAG_SECONDS`.

**Barman**:

- `triggerBackup` expands `all` the same way (including audit), runs `barman check`, `barman backup`/`--incremental`, then `barman-cloud-backup`; it reports only `primary-s3`, with no secondary mirror;
- lists with `barman list-backup`; `recover()` picks the latest and runs `barman recover --target-time`; `prune()` is a no-op because Barman applies server-side retention.

Barman health runs `barman check` for core and audit, checks S3 with the **WAL-G** `st ls` command, checks PostgreSQL, and adds optional secondary/Redis. Barman health therefore requires WAL-G and does not prove Barman's cloud/retention path. This document does not claim complete Barman health.

### 3.4 Scheduler

`src/scheduler.ts` uses a strict five-field cron parser (no macros or seconds), computes the next full/delta/drill slots, ticks every `SCHEDULER_TICK_MS` (default 30 seconds), reloads policy from the catalog, skips a due job when another job is running, records runs as `QUEUED`/`RUNNING`/`PASSED`/`FAILED`, reserves unique ids, attempts a full prune after a successful full backup, and records signed drill reports. A policy update through `PUT /v1/policy` takes effect on the next tick without a restart.

### 3.5 Catalog

`src/catalogStore.ts` stores runs, drills and policy in one JSON file (`BACKUP_CATALOG_PATH`), writes atomically via temp file + rename, serializes writes, keeps at most 500 runs and 100 drills, validates on load, falls back to in-memory operation when unwritable or corrupt, and reports the persistence error. The catalog is not encrypted and is not backed up by the daemon.

### 3.6 Restore drill

`src/restoreDrillRunner.ts`:

1. Sets `targetTime = now - 5 minutes` and stops/removes prior scratch clusters.
2. Calls `engine.recover()` for `postgres_core` and `audit_db`.
3. Refuses `initdb` over a failed restore unless the engine explicitly reports an initialized empty directory.
4. Writes `recovery.conf` into `postgresql.auto.conf`, creates `recovery.signal`, and starts both clusters on the configured ports over loopback.
5. Runs the double-entry zero-drift query, the sharded-balance parity query and the audit hash-chain query.
6. Builds a report with status, duration, target time, replayed LSN, drift, mismatch counts, broken links and per-check details.
7. Signs it with HMAC-SHA256 using `BACKUP_ENCRYPTION_KEY_HEX`.
8. Stops and removes both scratch clusters in `finally`.

A failed restore, start or check still produces a signed `FAILED` report through the scheduler or HTTP path. The drill requires an audit recovery target; without an audit database or `PG_AUDIT_DATA_DIR`, the audit recovery fails and the drill fails.

### 3.7 Core and admin integration

`core-back/lib/storageEngine/backupControlClient.ts` builds a TLS 1.3 keep-alive agent with the internal CA and `backup-client` cert/key and calls overview/health/trigger/drill/policy/runs/drills.

`core-back/api/internal/backups.ts`:

- `GET /overview` requires `security:read` or `gateway:read`, fetches daemon health and upserts runs/drills with `Promise.allSettled`;
- `POST /trigger` and `POST /drill` require `security:write`, require a configured daemon, call it and insert a local queued row;
- `PUT /policy` requires `security:write`; without `approvalRequestId` it creates a `BACKUP_POLICY` approval (`PENDING_REVIEW`, 7-day expiry) and returns 202; with an id it checks subject type, state and maker != checker, sends the **approved payload** to the daemon, marks the approval `EXECUTED`, bumps the base version and writes an audit record;
- `GET /catalog` returns local runs/drills.

`admin-back/api/protected/backups.ts` applies `security:read`/`security:write` at the edge, forwards overview/trigger/drill/policy and relays core status. The daemon's own `PUT /v1/policy` has no maker-checker, so a direct mTLS client can bypass the core approval workflow.

### 3.8 Systemd and source deployment

`backupEngineProvisioner.ts` writes `/etc/systemd/system/pg-backup-daemon.service`: `User/Group=pgbackup`, `WorkingDirectory=/opt/pg-backup-daemon`, `EnvironmentFile=/etc/pg-backup/backup.env`, `ExecStart=/usr/local/bin/bun run src/index.ts`, `Restart=always`, `RestartSec=3`, `LimitNOFILE=65536`, `NoNewPrivileges=true`, `ProtectSystem=strict`, and `ReadWritePaths` for backup, log, catalog, cert, scratch and pgpass directories.

`deploy.ts` copies `deploy/backup-daemon` to `/opt/pg-backup-daemon` with rsync `--delete`, excludes `node_modules`, `.git`, `dist`, `test`, `*.log` and `.env`, chowns to `pgbackup`, runs `bun install --frozen-lockfile` as `pgbackup`, and enables/restarts the unit.

The provisioner writes `/etc/cron.d/pg-backup`: when the scheduler is enabled only a comment; otherwise full/delta trigger lines as `pgbackup` and the drill script as root. `/usr/local/bin/pg-backup-restore-drill` restores core and checks double-entry only; it is narrower than the in-process drill.

## 4. Contracts and invariants

- The daemon listens over mTLS by default and refuses plain HTTP unless explicitly allowed for development.
- Core presents a CA-signed `backup-client` certificate; the daemon does not authorize a CN per route.
- Trigger and drill return 202 and complete asynchronously; the catalog is the state store.
- Scheduled jobs do not overlap; HTTP triggers are not globally serialized.
- Catalog writes are atomic; a failed write does not crash the daemon.
- Secrets are redacted from responses and error messages.
- Full backups are followed by a best-effort prune; delta pruning is non-destructive.
- Audit backups require `PG_AUDIT_DATA_DIR`; the daemon never substitutes the core data directory.
- Drills restore core and audit, check three invariants, sign the report and always clean up scratch clusters.
- Policy changes through core require maker-checker; the daemon endpoint itself does not.

## 5. Data / API / config / deployment surface

| Group | Keys |
| :--- | :--- |
| Engine/encryption | `BACKUP_ENGINE_MODE`, `BACKUP_COMPRESSION`, `BACKUP_ENCRYPTION_KEY_HEX`, `BACKUP_ALLOW_INSECURE_HTTP`, `BACKUP_COMMAND_TIMEOUT_MS` |
| S3/secondary | `BACKUP_PRIMARY_S3_ENDPOINT`, `BACKUP_PRIMARY_S3_BUCKET`, `BACKUP_PRIMARY_S3_ACCESS_KEY`, `BACKUP_PRIMARY_S3_SECRET_KEY`, `BACKUP_CORE_S3_PREFIX`, `BACKUP_AUDIT_S3_PREFIX`, `BACKUP_SECONDARY_SSH_TARGET` |
| Schedule/retention | `BACKUP_FULL_CRON`, `BACKUP_DELTA_CRON`, `BACKUP_DRILL_CRON`, `BACKUP_RETENTION_FULL_COUNT`, `BACKUP_RETENTION_WAL_DAYS`, `BACKUP_ALERT_LAG_SECONDS`, `SCHEDULER_ENABLED`, `SCHEDULER_TICK_MS` |
| Listener/mTLS | `BACKUP_DAEMON_PORT`, `BACKUP_DAEMON_BIND_HOST`, `BACKUP_DAEMON_CERT_PATH`, `BACKUP_DAEMON_KEY_PATH`, `BACKUP_DAEMON_CA_CERT_PATH` |
| PostgreSQL | `PG_PRIMARY_HOST`, `PG_PRIMARY_PORT`, `PG_PRIMARY_USER`, `PG_PRIMARY_PASSWORD`, `PG_PRIMARY_DB_NAME`, `PG_AUDIT_DB_NAME`, `PG_REPLICA_NODES`, `PG_DATA_DIR`, `PG_AUDIT_DATA_DIR`, `PG_BIN_DIR` |
| Catalog/scratch | `BACKUP_CATALOG_PATH`, `BACKUP_SCRATCH_DIR`, `BACKUP_SCRATCH_PORT`, `BACKUP_SCRATCH_AUDIT_DIR`, `BACKUP_SCRATCH_AUDIT_PORT`, `PGPASSFILE` |
| Binaries | `WALG_BIN`, `BARMAN_BIN`, `BARMAN_CLOUD_BIN`, `BARMAN_SERVER`, `BARMAN_AUDIT_SERVER` |
| Redis | `REDIS_URL`, `REDIS_CLI_BIN` |

`BACKUP_ENCRYPTION_KEY_HEX` must be hex, at least 16 bytes and even length; the deploy requires exactly 64 hex characters. `backup.env.example` is a local/troubleshooting reference; a deployment generates `/etc/pg-backup/backup.env` from `deploy.env`.

## 6. Operational usage

```bash
cd deploy/backup-daemon
bun install
bun run start
bun test
bun run typecheck
```

On a deployed host, use `systemctl status pg-backup-daemon`, `journalctl -u pg-backup-daemon`, and a curl request with `internal-ca.crt`, `backup-client.crt` and `backup-client.key` to `/v1/overview`. Admin triggers and policy changes go through core; policy changes require a second user.

## 7. Status and deviations

### Implemented

- WAL-G/Barman full/delta backup, listing, restore, verification and cloud copy.
- Optional Redis snapshot.
- S3 primary and optional secondary mirror for WAL-G.
- In-process cron scheduler with policy reload and overlap skipping.
- Atomic JSON catalog with in-memory fallback.
- Core+audit drill with double-entry, balance parity and audit-chain checks and HMAC-signed reports.
- mTLS server with client-certificate verification and secret redaction.
- Core proxy/approval integration and admin edge routes.
- Provisioner-generated env, systemd unit, cron and source deployment.

### Partial

- Barman health depends on WAL-G for the S3 target.
- No per-CN daemon authorization.
- The shell drill is narrower than the in-process drill.
- The catalog is one unencrypted JSON file with count-based retention.

### Missing / deferred

- Log-database backup target.
- HTTP trigger serialization/backpressure.
- Automatic certificate/key ownership correction for `pgbackup`.
- Catalog backup and encryption.
- A verify-only restore mode.

### Known bugs / risks

- `all` includes `audit_db` without checking whether audit is configured; WAL-G needs `PG_AUDIT_DATA_DIR` and Barman needs an audit server.
- A Barman-only installation reports the primary S3 target unhealthy because health uses WAL-G.
- The backup cert/key may be root-owned and unreadable by `pgbackup`, preventing mTLS startup and failing the deploy probe.
- Any CA-signed certificate can call the policy endpoint directly and bypass maker-checker.
- Concurrent HTTP triggers are not serialized.
- The drill requires audit recovery even for a core-only intent.
- An interrupted cleanup can leave scratch clusters/directories.
- The catalog may contain host/run metadata and is not encrypted.

## 8. Verification and tests

```bash
cd deploy/backup-daemon && bun run typecheck && bun test
cd deploy && bun test test/provisioners.test.ts
```

Covered: WAL-G/Barman command builders and target routing; audit data-directory refusal; scheduler policy reload/overlap; catalog atomicity/corruption/retention; cron parsing; HTTP contract/validation/redaction; mTLS refusal of plain HTTP; drill success/failure, initdb guard, audit-chain verification and cleanup; provisioner env/unit/cron/scripts.

Not covered: a real WAL-G/Barman backup or restore; a real PostgreSQL 18 scratch drill; daemon startup as `pgbackup` with deployed cert ownership; Barman-only health; core maker-checker against the daemon.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 5.1 and 5.2.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6, deployment pipeline.

### Code paths

- `deploy/backup-daemon/src/index.ts`, `server.ts`, `backupEngine.ts`, `scheduler.ts`, `catalogStore.ts`, `restoreDrillRunner.ts`, `config.ts`.
- `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/deploy.ts`.
- `core-back/lib/storageEngine/backupControlClient.ts`, `core-back/api/internal/backups.ts`.
- `admin-back/api/protected/backups.ts`.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

- **mTLS authorization.** In TLS mode a `node:tls` front listener verifies the client certificate and checks its CN or DNS SAN against `BACKUP_ALLOWED_CLIENT_CNS` (default `backup-client`); anything else gets 403. It is bridged to `Bun.serve` over a private unix socket (a loopback port on win32). Verified live on Windows only; the Linux unix-socket path is untested.
- New daemon setting `WALG_ENV_FILE` keeps secrets out of the `restore_command` line. The daemon mirror does not delete unless `BACKUP_SECONDARY_MIRROR_DELETE=true`.
- **Daemon user (GAP-022, RESOLVED 2026-11-05).** The provisioned systemd unit runs as `pgbackup` (`SupplementaryGroups=postgres`) instead of `postgres`, and PostgreSQL accepts only TLS connections (`hostssl`-only `pg_hba`, see `deploy.storage`). The daemon code itself is unchanged.

## Health Verification, Rollback and Recovery

> Status: `partial` · Last verified: 2026-11-05

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
| Backup daemon | HTTPS `/health` with the CA and the `backup-daemon` certificate/key when `BACKUP_ALLOW_INSECURE_HTTP=false`; plain HTTP when it is `true`. Expects `"status":"ok"` or `ok`. |

The mTLS backup probe uses the daemon's server certificate (which also has clientAuth) rather than `backup-client`. It depends on the daemon being able to read its own 0600 key; if the key is root-owned and the daemon runs as `postgres`, the probe fails. When `BACKUP_ALLOW_INSECURE_HTTP=true` the daemon serves plain HTTP and the verifier uses an unauthenticated HTTP probe on the same host/port, so development deployments do not fail on TLS.

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
