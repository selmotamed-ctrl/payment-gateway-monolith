# Chapter 7 — Deploy Engine v2 (`pgctl`)

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Replaces `deploy/` (TypeScript, ~16k LOC) with
> `pgctl`, a single Rust binary run from the operator workstation (or CI) that provisions hosts, ships signed Rust
> releases, runs TS and Rust side by side during the port, and then becomes the only deploy path. Task details are
> in chapter 9 (D-items).

---

## 1. Track D overview and dependencies on Track P

| Phase | Delivers | Needed by |
| :--- | :--- | :--- |
| D0 | `pgctl` skeleton, `pgctl.toml` schema, importer from `deploy/deploy.env`, plan/render with no remote changes, golden comparison against the TS planner | P1 |
| D1 | Release artefacts (signed tarball), systemd units for Rust services, install/start/verify of one Rust service (object-storage daemon) next to the TS engine | P1 gate |
| D2 | Side-by-side services: Rust edges, `core-rs` on 4010/4015, route tables and worker lists distribution, implementation switches per service | P2, P3 |
| D3 | Release manifests, SO_REUSEPORT zero-downtime restarts, automatic rollback, post-deploy watch window | P5 |
| D4 | PKI v2 (rcgen, ECDSA, intermediate CA, rotation, hot reload), storage TLS (S-SEC-06), nftables firewall (S-SEC-17), host-key pinning (S-SEC-16), secrets store + systemd credentials (AD-13) | P7 |
| D5 | Storage/backup/HA provisioners ported (PostgreSQL 18 via PGDG, PgBouncer sizing, Redis/Valkey TLS+ACL, ClamAV, MinIO, audit/log DB, backup daemon, object storage, optional Patroni) | P9 |
| D6 | `pgctl lab` (test-matrix port), `pgctl stress` (stress port), `pgctl local up` (localhost + Codespaces), CI integration | P10 |
| D7 | TS deploy engine retired (`deploy/` removed, tag `ts-deploy-final`) | P10 gate |

Until D5 completes, `pgctl` may delegate storage provisioning to the TS engine (`pgctl` invokes
`bun run deploy/deploy.ts --only=storage --skip-build` with a generated env file) so service shipping can move first.

---

## 2. What the current engine does (must all be covered)

- **CLI flags** (`deploy.ts:94-144`): `--env`, `--only` (roles + aliases incl. storage aliases), `--nodes`,
  `--rolling-batch`, `--keep`, `--fresh`, `--force-fresh` (also `DEPLOY_FORCE_FRESH=1`), `--update`,
  `--enforce-firewall`, `--skip-build`, `--rebuild`, `--skip-verify`, `--rotate-certs`, `--check-certs`,
  `--force-restart`, `--dry-run`, `--preflight-only`, `--skip-preflight`, `--stop-unmanaged`; env
  `PG_DEPLOY_SSH_MUX=0`.
- **Pipeline**: config+plan → preflight (SSH/sudo, tools, disk, memory, clock skew, port ownership classification,
  Nginx/PM2 state, dependency probes) → SPA builds (parallel, cache stamp) → PKI → bootstrap+firewall → storage
  (fresh-storage probe/clean with pre-clean dump; PG18+PgBouncer, Redis, ClamAV, audit/log, object storage, backup) →
  services core, fake-rails, admin, merchant, checkout in rolling batches (release dir, rsync, frontend dist +
  `runtime-config.js`, certs, `.env` 0600, `bun install`, `prisma generate`, migration planning with pre-migrate
  `pg_dump`, migrate+seed as owner, symlink, PM2 ecosystem, restart, Nginx render/test/reload, prune) → verify →
  seed (fake rails, synthetic) → summary.
- **Config**: custom dotenv, 282 keys, node grammar `nodeId@sshHost:sshPort:privateIp:servicePort` (IPv4 only),
  per-tier SSH credentials, cross-field validation, production guard, weak-secret check (not covering SMTP/SMS/Google
  secrets), PAN guard.
- **Planner**: roles (db, core, admin, merchant, checkout, fake-rails, pg-primary, pg-replica, pgbouncer, redis,
  audit-db, log-db, backup, object-storage), grouping by SSH endpoint, naming (`pg-<role>-back[-<node>]`,
  `pg-core-sandbox`), env construction (core vs edge secrets separation), Nginx upstreams `least_conn`.
- **Provisioners**: PostgreSQL 18 from distro archive (multi-cluster, conf.d, self-signed certs, hba, roles, replicas
  via `pg_basebackup -R -S`, journal partition cron), PgBouncer (transaction + session aliases, userlist, restart
  signature), Redis/Valkey (no TLS), ClamAV, audit/log DB, object storage (user, dirs, unit), backup engine (pg-native
  / WAL-G 3.0.9 / Barman 3.10.1, MinIO, archive_command via curl, units, cron, trigger scripts).
- **PKI**: openssl CLI; RSA-4096 CA (10 y), RSA-2048 leaves (825 d); per-service CNs/SANs/EKUs; rotation on SAN
  drift, expiry window, or `--rotate-certs`; storage client certs generated but unused.
- **Firewall**: UFW, deny incoming, per-rule TCP allows, SSH rule required, continue without firewall on install
  failure, no reconciliation/verification.
- **Remote execution**: system `ssh`/`rsync`, ControlMaster, TOFU host keys, sudo password over stdin, local mode for
  loopback targets, secret redaction (some secrets still in argv).
- **Health/rollback**: per-batch health, full verify (core/edges/edge→core/public vhosts/fake rails/PG/PgBouncer/Redis/
  audit/log/backup/object storage, release advertisement); no rollback; unencrypted unverified pre-migrate dumps.
- **Tooling**: test-matrix (12 gates, presets incl. certification 500 TPS p95 < 35 ms, topology families, lab secrets),
  stress (11 scenarios), Codespaces scripts, deploy-localhost.

Every item above maps to a `pgctl` feature in §3–§17 or is explicitly retired (§18).

---

## 3. `pgctl` command surface

```
pgctl init                         # create pgctl.toml + secrets store skeleton
pgctl config import <deploy.env>   # convert today's env file (282 keys) to pgctl.toml + secrets.age
pgctl config validate|print|schema
pgctl plan [--only R] [--nodes N]  # desired-state diff per host (no changes)
pgctl apply [--only R] [--nodes N] [--rolling-batch N] [--fresh|--force-fresh] [--skip-verify] [--dry-run]
pgctl preflight
pgctl hosts enrol <node>           # pin SSH host key, verify sudo, record facts
pgctl release build|sign|verify|list|prune
pgctl deploy <release> [--only R]  # ship + switch + verify + watch (apply minus provisioning)
pgctl rollback [--to RELEASE] [--only R]
pgctl verify [--only R]
pgctl status                       # releases, health, cert expiry, schema version, impl per service
pgctl db migrate|status|rehearse|dump|promote|switchover|failover
pgctl seed base|fake-rails|synthetic
pgctl pki init|issue|renew|rotate|revoke|check|dev
pgctl secrets set|get|rotate <name>|list|rekey
pgctl firewall plan|apply|verify
pgctl route-table get|set|push     # coexistence: per-edge route tables (Track P)
pgctl workers handover <name> --to rs|ts
pgctl lab validate|plan|bootstrap|run|teardown|schema
pgctl stress run <scenario>|list
pgctl local up|down|status [--codespaces]
pgctl backup trigger|drill|status
pgctl logs <service> [--node N] [--since 1h]
```

Global flags: `--config pgctl.toml`, `--secrets secrets.age`, `--identity ~/.config/pgctl/age.key`, `--json`,
`--yes` (non-interactive), `--verbose`. Exit codes as chapter 3 §10.

Flag mapping from the TS engine: `--update` → default behaviour of `apply`; `--enforce-firewall` → `firewall apply`;
`--skip-build`/`--rebuild` → SPA build cache flags on `apply`; `--check-certs` → `pki check`; `--rotate-certs` →
`pki rotate`; `--force-restart` → `apply --restart <roles>`; `--preflight-only` → `preflight`; `--skip-preflight`
retained with a warning; `--stop-unmanaged` → `preflight --stop-unmanaged`; `--keep` → `release prune --keep`.

---

## 4. Architecture

| Crate | Responsibility |
| :--- | :--- |
| `pg-deploy-config` | `pgctl.toml` model (serde, JSON Schema via `schemars`), validation (all current cross-field rules + new ones), importer from `deploy.env` |
| `pg-deploy-secrets` | `age`-encrypted secrets store, generation, rotation, credential rendering |
| `pg-deploy-plan` | host planner (roles → hosts → services, ports, names, env/credentials per service, Nginx sites), desired state per host |
| `pg-deploy-ssh` | russh client, host-key pinning, sudo, command runner with timeouts, file transfer, local mode |
| `pg-deploy-render` | minijinja templates: systemd units, Nginx sites, PostgreSQL/PgBouncer/Redis/ClamAV/MinIO configs, nftables ruleset, cron files |
| `pg-deploy-pki` | rcgen-based CA/intermediate/leaf issuance, inventory, renewal, CRL |
| `pg-deploy-provision` | idempotent converge modules per component (§9) with "changed/unchanged/restarted/reloaded" reporting |
| `pg-deploy-release` | artefact build/sign/verify, release manifests, upload, switch, rollback |
| `pg-deploy-verify` | health and verification suite, watch window |
| `pg-deploy-state` | local state file `pgctl.state.json` (last applied plan hash per host, releases per node, cert inventory) + remote state `/var/lib/pgctl/state.json` per host |
| `pg-deploy-lab`, `pg-deploy-stress` | test-matrix and stress ports |

Execution model: async (Tokio), per-host parallelism with bounded concurrency (`--parallel`, default 8), deterministic
ordering inside a host. Every remote action is a typed `Step { id, host, description, idempotency_check, apply,
verify, sensitive_inputs }` so `--dry-run` prints the exact plan and logs never include sensitive inputs.

---

## 5. Remote execution

- **Transport**: `russh` 0.65 (pure Rust SSH client). Keys from `pgctl.toml` per node (fixes "per-tier only"),
  agent support, ed25519/ECDSA/RSA.
- **Host-key pinning** (S-SEC-16): `pgctl hosts enrol` records the host key fingerprint after out-of-band
  confirmation (operator compares with the console or a provided fingerprint); every connection verifies against
  `pgctl.known_hosts`; mismatch aborts.
- **Commands** run via `bash -euo pipefail -c` with a timeout per step (default 15 min, configurable); output
  streamed to the log with secret redaction (values registered from the secrets store are masked wherever they
  appear).
- **Sudo**: `sudo -S -p ''` with the password written to the channel's stdin (never argv); or passwordless sudo when
  configured. Secrets for remote commands are passed via stdin or 0600 temp files created with `umask 077` in a 0700
  directory and removed in a `trap` (S-SEC-15). `PGPASSFILE` for psql, `REDISCLI_AUTH` only via stdin-fed `env -i`.
- **File transfer**: content streamed over the SSH channel to `install -m <mode> -o <owner> /dev/stdin <tmp>` then
  atomic rename; SHA-256 verified remotely; "changed" reported by comparing hashes first (no rsync dependency).
  Release tarballs uploaded once per host and unpacked into the release directory.
- **Local mode** when the target is loopback or a local interface (same semantics as today).
- **Concurrency safety**: a per-host lock file `/var/lib/pgctl/lock` (flock) prevents two `pgctl` runs on one host.

---

## 6. PKI v2

- In-process issuance with `rcgen` 0.14 (no openssl binary needed on the workstation).
- Hierarchy: root CA (ECDSA P-384, 10 years, generated by `pgctl pki init`, private key exportable to offline storage
  and removable from the workstation); per-environment intermediate (ECDSA P-256, 3 years) used for all leaves.
- Leaves: ECDSA P-256 (RSA-2048 only if `pki.compat_rsa = true` for a component that needs it); default validity 90
  days (`pki.leaf_days`), renewal at 2/3 lifetime on every `apply` and by `pgctl pki renew` (cron/systemd timer on the
  operator host recommended).
- Inventory (`pgctl.state.json`): serial, subject, SANs, EKU, not-after, deployed-to hosts, file paths, owner/mode.
- Leaf catalogue: today's set (`core-back.internal`, `backup-daemon`, `object-storage-daemon`, `fake-rails`,
  `admin-back`, `merchant-back`, `checkout-back`, `pg-client`, `redis-client`, `audit-db-client`, `log-db-client`,
  `backup-client`, `wal-archive-client`, `object-storage-client`) plus **server certificates for PostgreSQL clusters,
  PgBouncer and Redis** (replacing self-signed ones), `backup-admin` (S-SEC-09), `fake-rails-client` (S-SEC-10).
- Distribution: per process least privilege (not per host): each systemd unit receives only its own key through
  `LoadCredential=`; storage daemons get files owned by their user, mode 0400.
- Hot reload: after renewal pgctl sends `systemctl reload <unit>` (Rust services reload TLS on SIGHUP; PostgreSQL
  `pg_ctl reload`; PgBouncer `RELOAD`; Redis `CONFIG SET` + `CONFIG REWRITE`).
- CRL: `pgctl pki revoke <serial>` regenerates the CRL and distributes it to PostgreSQL (`ssl_crl_file`), Rust
  services (CRL path option) and daemons.
- `pgctl pki dev` replaces `core-back` `generate-mtls-certs` for local/CI use (same output paths so existing tests keep
  working); core's startup hint text changes under S-OPS-03.

---

## 7. Configuration v2 (`pgctl.toml`)

Declarative desired state, validated against a JSON Schema (`pgctl config schema`). Secrets never appear in the TOML;
they are referenced by name from the secrets store. Example (abridged):

```toml
version = 1
environment = "production"            # production | staging | test (replaces DEPLOY_ENV/IS_TEST_SERVER)
jurisdiction = "LY"

[release]
channel = "stable"
keep = 5
target_cpu = "auto"                   # auto | x86-64-v2 | x86-64-v3

[[node]]
id = "core-1"
ssh = { host = "10.0.0.11", port = 22, user = "deploy", key = "~/.ssh/pg_core" }
private_ip = "10.0.0.11"
roles = ["core", "pgbouncer"]

[[node]]
id = "db-1"
ssh = { host = "10.0.0.21", user = "deploy", key = "~/.ssh/pg_db", sudo_password = "secret:db1_sudo" }
private_ip = "10.0.0.21"
roles = ["pg-primary", "audit-db", "log-db", "backup"]

[services.core]
port = 4000
sandbox = { enabled = true, port = 4005, database = "payment_gateway_sandbox" }
impl = "rs"                           # ts | rs | both (coexistence: rs listens on 4010/4015)
workers_rs = ["OutboxRelayWorker"]    # coexistence worker hand-off lists
workers_ts_disabled = ["OutboxRelayWorker"]

[services.admin]   { port = 4101, impl = "rs", lan_cidrs = ["10.0.0.0/24"] }
[services.merchant]{ port = 4102, impl = "rs", public_host = "merchant.example.ly", tls = "certbot" }
[services.checkout]{ port = 4103, impl = "rs", public_host = "pay.example.ly", tls = "certbot" }

[postgres]
version = 18
source = "pgdg"                       # pgdg | distro
ram_gb = 32
io_method = "auto"                    # auto (io_uring if supported) | worker | sync
synchronous_commit = "on"
sync_standbys = "ANY 1"
max_slot_wal_keep_size = "64GB"
ha = "none"                           # none | manual-standby | patroni

[pgbouncer]
max_client_conn = 2000

[redis]
engine = "valkey"                     # redis | valkey
tls = true
acl = true

[backup]
engine = "pg-native"                  # pg-native | wal-g | barman
s3 = { mode = "managed-minio", bucket = "pg-backups" }
schedule = { full = "0 2 * * 0", incremental = "0 2 * * 1-6" }

[pki]
leaf_days = 90
compat_rsa = false

[firewall]
engine = "nftables"
extra_allow = [{ from = "10.0.0.0/24", port = 9100, proto = "tcp", comment = "node exporter" }]

[observability]
enabled = true
metrics_bind = "127.0.0.1:9600"
stack = "prometheus"                  # none | prometheus (pgctl provisions Prometheus + Alertmanager + Grafana on the monitor node)
```

- Importer: maps every one of the 282 `deploy.env` keys (table generated in D0-T02 and committed as
  `docs/pgctl/env-import-map.md`); unknown or ambiguous keys stop the import with an explanation; secrets move into
  `secrets.age`; node strings `id@host:port:ip:svcport` become `[[node]]` blocks; per-tier SSH settings become
  per-node.
- Validation keeps every current rule (port collisions, conditional requirements, cron syntax, path safety, production
  guard, PAN guard) and adds: weak-secret check for **all** secrets incl. SMTP/SMS/Google; IPv6 and DNS names
  allowed; PostgreSQL major pinned to 18; PgBouncer pool budget vs `max_connections`; N-1 schema compatibility;
  `impl` and worker lists consistent (a worker cannot be enabled in neither implementation).

---

## 8. Secrets

- Store: `secrets.age` encrypted with one or more operator age recipients (and optionally a CI recipient); edited
  only through `pgctl secrets`.
- Generation: `pgctl init` generates strong random values for DB passwords, Redis ACL passwords, `KMS_MASTER_KEY`,
  KEK keyring, backup key, fake-rails secrets; operator-supplied secrets (SMTP, SMS, Google, sudo) are entered
  interactively or from stdin.
- Delivery: rendered into per-service credential files under `/etc/pg/credentials/<service>/` (root 0400) and loaded
  by systemd `LoadCredential=` into `$CREDENTIALS_DIRECTORY` (AD-13); TS services during coexistence receive them as
  env through `EnvironmentFile=` with 0600 files (TS cannot read credentials directory).
- Rotation: `pgctl secrets rotate <name>` implements the procedure from chapter 5 §6 per secret type (DB role
  password with dual-password window via SCRAM `ALTER ROLE` + PgBouncer userlist reload + rolling restart; Redis ACL
  dual password; KEK new version + rewrap; etc.).

---

## 9. Provisioners (D5)

Each provisioner is an idempotent converge module: read facts → render desired config → diff → apply → reload or
restart only when needed → verify. All config files carry a header `# managed by pgctl <version>, do not edit`.

| Component | Changes vs TS engine |
| :--- | :--- |
| OS bootstrap | packages via apt (Debian 12+/Ubuntu 24.04+) or pacman; no Bun/PM2/Node for Rust services; `systemd-timesyncd`/chrony check; sysctl tuning (`net.core.somaxconn`, `fs.file-max`, `vm.swappiness`) |
| PostgreSQL 18 | PGDG apt repository pinned (fixes hosts without distro `postgresql-18`); clusters via `pg_createcluster`; config from chapter 4 (S-DB-05/11/12); internal-CA server cert, `ssl_ca_file`, `ssl_crl_file`, `hostssl … clientcert=verify-full` for app roles; data checksums verified; `io_method = io_uring` when kernel ≥ 5.6 and liburing present; replicas via `pg_basebackup -R -S` with `verify-full`; journal partition cron kept until E removes it |
| Patroni (optional `ha = "patroni"`) | Patroni + etcd (3 members, may be co-located on core/db nodes) or Patroni Raft; synchronous mode; PgBouncer targets the leader via Patroni REST health (`/primary`) through HAProxy or a VIP (keepalived); `pgctl db switchover/failover` wrap `patronictl` |
| PgBouncer | pools computed (S-DB-11); `client_tls_sslmode=verify-full` for app clients with internal CA; `server_tls_sslmode=verify-full`; per-role users; session alias for leader election and migrations |
| Redis / Valkey | `tls-port` with internal-CA certs, `tls-auth-clients yes`, `port 0` (TLS only); ACL users `core`, `worker`, `backup` with minimal command sets; AOF; optional Sentinel (3) for `redis.ha = "sentinel"` |
| ClamAV | as today (clamd TCP 127.0.0.1:3310, freshclam); health `zPING` |
| Audit / log DB | DDL moved from `auditAndLogDbProvisioner.ts` into `db/audit/*.sql` and `db/log/*.sql` migrations run by `core-rs migrate --database audit|log`; S-DB-04 DEFAULT partitions; S-DB-14 chain head; databases owned by `pgw_owner` |
| Object storage daemon | Rust binary, systemd unit, user `pgobjstore`, vault dirs; mTLS certs via credentials |
| Backup daemon | Rust binary; engines unchanged; WAL-G/Barman pinned with checksums **built into pgctl** (fixes GAP-023 operator-supplied hashes); MinIO managed or external S3; `archive_command` with curl + client cert (unchanged contract) or `wal-push`; scheduler inside the daemon (cron file removed when equivalent) |
| Nginx | minijinja templates (current 6 sites) + security headers (E-SEC-10); certbot timer or custom certs; `nginx -t` before reload; upstream ports from the plan |
| Fake rails | Rust binary; SQLite under `/var/lib/pg-fake-rails`; TLS (S-SEC-10); refused when `environment = "production"` unless explicitly allowed |
| Observability (optional) | node_exporter on all hosts; Prometheus + Alertmanager + Grafana on a monitor node with scrape configs for `METRICS_BIND` endpoints, postgres_exporter, redis_exporter; alert rules (error rate, latency, outbox lag, replica lag, cert expiry < 14 d, backup age, disk) |

---

## 10. Services, releases, zero-downtime

- **Release artefact**: `pg-release-<version>-<git sha>.tar.zst` containing `bin/*` (all Rust binaries),
  `share/` (Nginx templates are rendered by pgctl, not shipped), `frontends/<portal>/dist` (built SPAs),
  `manifest.json` (version, commit, schema compatibility `[min,max]`, binaries SHA-256, SBOM reference), signed with
  minisign (`.minisig`). Built by CI (`pgctl release build`) or locally.
- **Host layout**: `/opt/pg/releases/<version>/` (immutable, root-owned), `/opt/pg/current -> releases/<version>`
  per node, `/etc/pg/<service>/config.env` (non-secret config), `/etc/pg/credentials/<service>/*`, state dirs
  `/var/lib/pg-<service>/`, logs to journald.
- **systemd units** (template): `ExecStart=/opt/pg/current/bin/core-rs serve`, `Type=notify`, `Restart=always`,
  `RestartSec=3`, `TimeoutStopSec=15`, `LimitNOFILE=1048576`, `EnvironmentFile=/etc/pg/core/config.env`,
  `LoadCredential=…`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `ReadWritePaths=/var/lib/pg-core`, `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`,
  `MemoryDenyWriteExecute=yes` except wasmtime-enabled core (E-F07)). Units reference `/opt/pg/current`, never an
  absolute release path (fixes the PM2 rollback trap).
- **Zero-downtime restart (single node)**: every Rust server binds with `SO_REUSEPORT` (socket2). Upgrade sequence:
  start the new version as a second instance (`<unit>@next` template unit) → it binds the same port and reports
  `READY=1` → pgctl health-checks it on a private health port → signal the old instance (`SIGTERM`) → it stops
  accepting, drains (≤ 10 s), releases leader locks, exits → `@next` becomes the main unit via rename/swap. N and N+1
  overlap briefly, which the N-1 compatibility rule allows. Fixes GAP-039 (≈0.4 s gap).
- **Multi-node tiers**: rolling batches (`--rolling-batch`), per batch: deploy, health, edge→core probe, error-rate
  check from metrics.
- **Coexistence (D2)**: TS services still run under PM2 (current mechanics) when `impl = "ts"` or `both`; Rust core
  runs on `4010/4015` when `both`; pgctl renders the route table YAML per edge and worker lists per core and pushes
  them with `systemctl reload` (route tables hot-reload on SIGHUP).

---

## 11. Migrations and seeds orchestration

- Until P10-T01: pgctl calls the TS migrator on the first core node (`bunx prisma migrate deploy` via the existing
  owner-env mechanism) — Bun stays installed on core nodes only for this and for seeds until P9/P10 land (the
  "no bun install" rule applies from P10).
- From P10-T01: `core-rs migrate deploy` (chapter 4 §5) for main, sandbox, audit and log databases.
- Pre-migration safety: encrypted dump through the backup daemon (`POST /v1/backups/trigger` with a `pre-migration`
  label, wait for completion, verify manifest) instead of an unencrypted local `pg_dump`; fallback to a local
  `pg_dump -Fc` encrypted with the backup key and copied off-host when no backup daemon exists.
- Ordering by compatibility: if the release's `schema_min` > current version → migrate first; if the new schema is
  outside the running release's range → refuse unless `--allow-incompatible` with a maintenance window.
- Optional `pgctl db rehearse` restores the latest backup into a scratch cluster and runs the migrations with timing.
- Seeds: `pgctl seed base|fake-rails|synthetic` call `core-rs seed …` on the first core node (TS scripts until P9-T05/T06).
- Production bootstrap: `pgctl admin create` wraps `core-rs admin create` (replaces the documented `create-admin`).

---

## 12. Rollback

- `pgctl rollback [--to <version>]`: verifies the target release is still on disk and compatible with the current
  schema (`schema_max ≥ current`), switches `current`, performs the zero-downtime restart per service, re-renders
  configs from the release manifest (env/units/Nginx are versioned in `/opt/pg/releases/<version>/rendered/`),
  verifies.
- Automatic rollback: after `deploy`, a **watch window** (default 10 min, `--watch`) monitors health, 5xx rate,
  latency p99 and worker errors from the metrics endpoints; breaching thresholds triggers automatic rollback of the
  services changed in this deploy (never of migrations).
- Contract migrations are never rolled back automatically; they are only applied in a later release after the
  previous release no longer needs the old structure (N-1 rule).

---

## 13. Verification

Superset of `deploy/lib/healthVerifier.ts`:

- Core `/health` (mTLS, release, `msg:"OK"`), channel health from each edge, edge `/health`, public vhosts, fake rails,
  PostgreSQL (`pg_isready`, `SELECT 1`, `SHOW ssl`, certificate chain verification), PgBouncer (app and session aliases),
  Redis (TLS PING with ACL user), audit/log DB, backup daemon `/health` (mTLS), object storage `/v1/health` from core
  and backup.
- New: `impl` and release per service, schema version vs release range, certificate expiry and chain checks per
  endpoint, firewall ruleset matches the rendered one, systemd units active and not restarting, disk/memory headroom,
  time sync, replica lag and sync standby state, backup age, worker leaders present for every singleton.
- Output: human table + `--json`; written to `/var/lib/pgctl/verify-<timestamp>.json` on the operator host.

---

## 14. Firewall (nftables)

- Ruleset rendered per host from the plan: default drop inbound, allow established/related, loopback, ICMP essentials,
  SSH from configured management CIDRs, per-role service ports from specific source IPs (current role matrix from
  `07-deploy/03-firewall.md` §3.3), optional UDP where needed, IPv6 equivalents.
- Applied atomically (`nft -f` of a complete ruleset in table `inet pgctl`), with a rollback timer: pgctl applies with
  a 60 s auto-revert job, reconnects over SSH, confirms, then cancels the revert (prevents lock-out).
- Verified by `nft -j list table inet pgctl` compared to the rendered ruleset; stale rules removed (reconciliation).
- UFW is disabled by pgctl when migrating a host (rules imported for review).

---

## 15. Lab and stress (D6)

- `pgctl lab` ports `deploy/test-matrix`: same JSON lab schema (validated with `jsonschema`), presets (smoke,
  standard, soak, chaos, certification), topology families (single-host, split, replicated, dmz, mesh, scale, chaos,
  plus `ha`), lab secrets generation (0600, never committed), marker-file-guarded teardown, the 12 gates (provisioning,
  storage-routing, seeder-invariants, checkout-stress, realtime-sse, workers, audit-chain, log-db-outage, search,
  backup, scale, chaos) plus new gates (tls-verification, zero-downtime-restart, rollback, worker-handover,
  route-table-shadow), reports `reports/<runId>/report.{md,json}` in the same format. The checkout-stress load
  generator is implemented in Rust (open-loop, coordinated-omission-safe, HDR histograms).
- `pgctl stress` ports the 11 deploy stress scenarios (noop redeploy, PgBouncer reload/restart under load, PostgreSQL
  pending restart, Redis config change, chaos recovery with 9 faults, deploy under traffic, SSH transport, multi-node
  rolling, soak, fresh-database stress seed) measuring outage windows with 100 ms probes and restart detection.
- Fix known lab gaps: admin-authenticated gates 2/9/10 (GAP-009), `primary-pitr` chaos fault, no secrets in argv.

---

## 16. Local development and Codespaces

- `pgctl local up [--codespaces]` replaces `scripts/deploy-localhost.sh` and `scripts/codespaces-start.sh`: starts
  PostgreSQL/Redis (system or containers), runs migrations and seeds, generates dev PKI (`pgctl pki dev`), starts all
  Rust services (or TS ones during coexistence) as child processes with a supervisor (restart on crash — fixes the
  Codespaces "no supervisor" gap), object-storage daemon included (GAP-083), Maildev optional.
- `.devcontainer`: add the pinned Rust toolchain, `cargo-nextest`, `sqlx-cli`; cache `target/` in a volume.
- `scripts/codespaces-smoke.ts` replaced by `pgctl local smoke`.

---

## 17. CI

- Jobs: `rs-check` (fmt, clippy, deny, audit), `rs-test` (nextest with PostgreSQL 18 + Redis service containers),
  `rs-golden` (golden vectors), `rs-parity` (edge suites against Rust binaries; core parity replay), `rs-bench-smoke`
  (criterion smoke + regression threshold), `release` (build, SBOM, sign).
- Update `deploy/test/ci-workflows.test.ts` expectations in the same change (it asserts CI job layout) until D7, then
  port the assertion into `pgctl` tests.

---

## 18. Gap → fix map (deploy)

| Gap (source) | Fix |
| :--- | :--- |
| No rollback; PM2 absolute paths (07-deploy/04, /07) | §12, units on `/opt/pg/current` |
| Single-node restart gap ~0.4 s (GAP-039) | SO_REUSEPORT handoff §10 |
| `rolling_update` no-op | removed; rolling batches are the mechanism |
| TOFU SSH | host-key pinning §5 |
| Secrets in argv | §5, §8 |
| Firewall optional/unverified/TCP only | §14 |
| Self-signed PG, no Redis TLS, storage client certs unused (GAP-022/037/057) | §6, §9 |
| Operator-supplied WAL-G/Barman/Bun hashes (GAP-023) | pinned in pgctl; Bun no longer needed after P10 |
| PG18 only from distro archive | PGDG source |
| Per-tier SSH credentials only | per-node SSH in `pgctl.toml` |
| IPv4-only node grammar | IPv4/IPv6/DNS |
| Weak-secret check misses SMTP/SMS/Google | §7 |
| Unencrypted, unverified, local pre-migrate dumps | §11 |
| No post-deploy monitoring | watch window §12, observability stack §9 |
| Audit/log cluster names hard-coded, log DB not backed up (GAP-049) | names from config; log DB added as an optional backup target |
| PgBouncer pools can exceed `max_connections` | S-DB-11 computed budgets |
| Dead PM2 templates, stale step docs | removed with `deploy/` at D7 |
| Codespaces never run, no supervisor, no object storage (GAP-079/083) | §16 |
| Test-matrix never run live, gates 2/9/10 admin 403 (GAP-009) | §15 |
