# backend-rs

Rust/ntex port of the payment-gateway backend. The plan is `design/14-rust-port/porting_to_ntex_rust.md`.

**Status: foundation + P1 pilot.** The object-storage daemon is complete; the core and edge binaries
are health/config scaffolds and every unported route answers `501 NOT_IMPLEMENTED_ROUTE`. The domain,
report, compliance and deploy crates are being ported in parallel. See `IMPLEMENTATION_TRACKER.md`,
`PARITY.md` and `DEVIATIONS.md`.

## Layout

```
crates/
  pg-config pg-types pg-crypto pg-http pg-mtls pg-db pg-redis pg-objstore pg-upstream pg-edge
  pg-domain-auth pg-domain-flow pg-domain-ledger pg-domain-gov pg-domain-comms pg-domain-recon
  pg-domain-academy pg-egress pg-workers pg-report-engine pg-compliance pg-office pg-search
  pg-deploy-config pg-deploy-plan
bins/
  core-rs admin-edge merchant-edge checkout-edge fake-rails-rs backup-daemon-rs
  wal-fetch object-storage-daemon-rs pgctl
tests/  golden-vectors/ (to fill in P0-T06)
tools/  (codegen, golden vectors, parity — to fill in P0)
db/     (migrations after P10)
```

## Build and test

```bash
cd backend-rs
cargo check --workspace
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Root shortcuts: `bun run rs:check`, `bun run rs:test`, `bun run rs:build`.

Parity tooling (run from the repository root):

```bash
bun backend-rs/tools/route-inventory/index.ts --check   # P0-T04 inventories
bun backend-rs/tools/golden/check.ts                    # P0-T06 cross-language vectors
```

The eight golden suites live in `crates/{pg-crypto,pg-types,pg-objstore}/tests/golden_*.rs` and
open payloads produced by the real TypeScript code.

## Run the object-storage daemon

Local development (no TLS):

```bash
cd backend-rs
OBJECT_STORAGE_REQUIRE_MTLS=false \
OBJECT_STORAGE_ROOT_DIR=/tmp/pg-objects \
OBJECT_STORAGE_DAEMON_PORT=4095 \
cargo run -p object-storage-daemon-rs -- serve
```

Production requires all three of `OBJECT_STORAGE_DAEMON_TLS_CA_PATH`,
`OBJECT_STORAGE_DAEMON_TLS_CERT_PATH`, `OBJECT_STORAGE_DAEMON_TLS_KEY_PATH`, and the client CNs in
`OBJECT_STORAGE_ALLOWED_CLIENT_CNS` (default `object-storage-client,backup-daemon,backup-client`).

`fsck`:

```bash
OBJECT_STORAGE_ROOT_DIR=/srv/objects cargo run -p object-storage-daemon-rs -- fsck --json
```

## Deploy engine (`pgctl`)

`pgctl` is the Rust replacement for `deploy/` (chapter 7). Status: **D0 complete; D1/D2 and D3-T03
implemented behind dry-run defaults; D5 storage provision plans complete (PostgreSQL, PgBouncer,
Redis, audit/log, ClamAV); D3-T02 (SO_REUSEPORT handoff), D4 (PKI), D5 execution (package
installation/SSH convergence) and D6 (lab/stress) are not implemented yet.**

```bash
# Desired state
pgctl config import --env-file ../deploy/deploy.env --out pgctl.toml
pgctl config validate --file pgctl.toml
pgctl config schema > pgctl.schema.json
pgctl plan --file pgctl.toml --json

# Release artefacts (needs the system tar and zstd binaries)
pgctl release build --file pgctl.toml --out dist --bin-dir target/release --epoch 0
pgctl release sign --file dist/pg-release-<version>-<commit>.tar.zst   # MINISIGN_PASSWORD for an encrypted key
pgctl release verify --file dist/pg-release-<version>-<commit>.tar.zst

# Hosts and one Rust service (D1-T02/T03; prints the steps unless --execute)
pgctl hosts enrol --file pgctl.toml --host core-1 --fingerprint SHA256:...
pgctl service install --file pgctl.toml pg-object-storage-daemon [--execute]

# Coexistence (D2): route table + worker handover + push (dry-run unless --execute)
pgctl route-table --file pgctl.toml --out dist
pgctl workers handover --file pgctl.toml --to rs --out dist
pgctl push --file pgctl.toml --artifact route-table --source-dir dist [--execute]

# Releases and the watch window (D3-T03)
pgctl deploy --archive dist/pg-release-<version>-<commit>.tar.zst --state state.json
pgctl rollback [--to <version>] --state state.json
pgctl watch --file pgctl.toml --samples samples.json   # exit 3 = rollback recommended

# Storage provision plans (D5; prints JSON, never touches a host)
pgctl provision plan --file pgctl.toml --target postgres --mode fresh
pgctl provision plan --file pgctl.toml --target pgbouncer|redis|audit-log|clamav [--out plan.json]
```

Details:

- **Release**: deterministic ordering, `SOURCE_DATE_EPOCH` aware, `bin/` + `rendered/` (plan,
  route table, workers, Rust units) + `manifest.json` + SPDX-lite `sbom.json`; the archive is built
  with `tar --sort=name --mtime=@<epoch> --owner=0 --group=0` piped to `zstd -19`.
  Signatures are standard `.minisig` (minisign crate, prehashed).
- **SSH runner**: russh with pinned SHA-256 host keys (`~/.config/pgctl/known_hosts`), per-node keys
  from `hosts[].ssh_key`, sudo password from `PGCTL_SUDO_PASSWORD` (stdin, never argv), uploads
  verified by remote SHA-256, per-host `flock` lock. `local://` or `ssh_user = "local"` uses the
  local transport. Tests use a scripted transport; they never open a connection.
- **Coexistence**: `impl = "ts" | "rs" | "rust" | "both"`; `both` plans the TypeScript core on
  4000/4005 and the Rust core on 4010/4015, and every edge receives both pool URLs.
- **Units**: `/opt/pg/current` (never an absolute release path), `LoadCredential=` for TLS/keys,
  `Type=notify`, `Restart=always`, `TimeoutStopSec=15`, `ReadWritePaths`, `SystemCallFilter`.
  SO_REUSEPORT itself is set by the service listener (chapter 7 §10), not by systemd.
- **Rollback/watch**: `pgctl.state.json` (0600) tracks releases; the watch policy is
  `[deployment.watch]` (window, error bps, p95 ms, worker errors, auto-rollback). Migrations are
  never rolled back automatically (N-1 rule).

### Storage provisioners (D5)

`pg_deploy_plan::storage` renders the exact desired state of the five storage components as an
idempotent step list: package/repository work, cluster creation, managed configuration files,
`pg_hba.conf`, SQL (roles, databases, DDL), systemd units, cron entries, firewall rules and
verification commands. Every step carries a content `sha256` idempotency check, so a converged host
is a no-op. The planner is pure: it never reads a secret, opens SSH or changes a host, and
`pgctl provision plan` prints the redacted JSON plan plus its findings.

```toml
# pgctl.toml (the [storage] overlay is parsed by pg-deploy-plan until pg-deploy-config models it)
[storage.postgres]
ram_gb = 16                 # shared_buffers 4GB, effective_cache_size 12GB, maintenance_work_mem 1GB
io_method = "auto"          # auto | worker | io_uring | sync (auto renders worker; apply re-probes)
source = "pgdg"             # pgdg (default) | distro
max_connections = 300
sync_standbys = false       # opt in only after the replica is streaming

[storage.pgbouncer]
default_pool_size = 50      # validated: sum of pools <= max_connections - 20
max_client_conn = 2000

[storage.redis]
engine = "valkey"           # redis | valkey
acl = true                  # core/worker/backup ACL users instead of requirepass
maxmemory = "4gb"
ha = "none"                 # none | sentinel

[storage.audit]
owner_password = "secret:pgw_owner_password"
writer_role = "gw_audit_writer"

[storage.clamav]
mode = "managed"            # managed | external | disabled
```

`pgctl provision plan` accepts these sections (top-level `[postgres]`, `[pgbouncer]`,
`[clamav]`, `[audit]` and `[log]` are aliases). `pgctl config validate` and `pgctl plan` still use
the strict D0 document and reject `[storage]` until the overlay moves into `pg-deploy-config`
(DEV-054); run them on the document without the overlay in the meantime.

What each target plans:

- **postgres** — PGDG repository (pinned major 18), `pg_createcluster`/`initdb` with data checksums,
  the chapter 4 tuning block (`PG_RAM_GB` sizing, `io_method`, WAL/slot limits, `statement_timeout`,
  `pg_stat_statements`), internal-CA TLS files, hostssl-only HBA with `clientcert=verify-ca`
  (default; `verify-full` is available), owner/runtime/replication roles (`pg_*` names rejected), main and
  sandbox databases, replication slots, `pg_basebackup -R` with `application_name` matching
  `synchronous_standby_names`, journal-partition cron, and `pg_isready`/SSL/checksum/role checks.
- **pgbouncer** — transaction alias, `pgw_session` session alias (and sandbox aliases), SCRAM
  verifier auth file, `verify-full` client TLS and `verify-full` server TLS with a client
  certificate, computed pool budget, `KillSignal=SIGINT`
  unit with a 15 s stop, ownership convergence, and login probes through both aliases.
- **redis** — TLS-only listener (`port 0` + `tls-port`), ACL users `core`/`worker`/`backup`, AOF
  `everysec`, `volatile-ttl`, a single pgctl-owned config path, a unit drop-in, firewall allowlist,
  PING/plaintext-port/ACL assertions, and optional three-instance Sentinel with markers.
- **audit-log** — the append-only audit DDL (hash chain + immutability trigger) and the partitioned
  log DDL (BRIN indexes, monthly partitions, retention function), owner/writer roles, least
  privilege grants, a shared-cluster guard (primary, or audit+log on one listener), and assertions
  that the writer cannot UPDATE.
- **clamav** — one loopback-only `clamd` per core host (`127.0.0.1:3310`), `StreamMaxLength` above
  the 25 MB KYB upload, `freshclam`, the socket-activation unit disabled, and a `zPING` check.

Secrets never appear in a plan: files use `{{secret:<name>}}` (PgBouncer also `{{scram:<name>}}`)
and SQL uses psql variables (`:'name'`), resolved by the executor from the encrypted store. A
defence-in-depth pass redacts any inline credential before printing.

**Not implemented yet:** actual package installation and SSH convergence (`--execute` and
`provision apply` print the plan and exit 3), Patroni/etcd HA (D5-T06), the observability stack
(D5-T07), and the MinIO/backup/object-storage provisioners (D5-T04). `io_uring` is selected only
after the apply-phase probe; synchronous replication should be enabled after the replica is
streaming (the plan warns).

## Gateway egress (`pg-egress`)

Port of `core-back/engine/apiConsumer/ApiConsumer.ts`, `compileUrl.ts` and
`lib/webhooks/egress.ts` (chapter 2 §28): the outbound HTTP executor used by the rail engine.

```rust
use pg_egress::{
    ApiConsumerAuth, CallContext, EgressClient, EgressConfig, EgressPolicy, EgressRequest,
    GatewayAuthConfig, GatewayCredentials, HostAllowlist, RequestBody, RetryPolicy, SideEffect,
    StaticResolver, TokenKey,
};

let policy = EgressPolicy::new(HostAllowlist::new(&["api.gateway.example"]));
let resolver = std::sync::Arc::new(StaticResolver::new().with("api.gateway.example", &["93.184.216.34"]));
let client = EgressClient::new(EgressConfig::new(policy, resolver))?;

let auth = GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("method"));
let credentials = GatewayCredentials::from_pairs([("apiKey", "<secret>")]);
let context = CallContext::new(&auth, &credentials, TokenKey::new("gw-1", "cs-1", "LIVE"));

let response = client.request(
    &context,
    EgressRequest::new(reqwest::Method::POST, "https://api.gateway.example/pay")
        .with_body(RequestBody::Json(serde_json::json!({ "amount": "1.00" })))
        .with_side_effect(SideEffect::MovesMoney)
        .with_retry_policy(RetryPolicy::Never),
).await?;
```

What one call guarantees:

- **SSRF**: `validate_target_with` parses the URL (HTTPS only, no credentials/fragments, port 443
  or configured, exact host allowlist, no private/loopback/link-local literal), resolves the name
  **once** and pins exactly one address. The reqwest client is built per
  `(host, pinned address, TLS identity)` with `ClientBuilder::resolve`, so `Host` and SNI keep the
  real name while the socket can only go to the validated address. No proxy, no redirects.
- **Limits**: `connect_timeout`, `read_timeout`, total `timeout` and the `max_response_bytes` cap
  (`MAX_RESPONSE_BYTES`, 2 MiB) checked against the declared length and then while streaming.
- **Authentication**: all ten methods (`NONE`, `API_KEY` header/query/body, `PERMANENT_TOKEN`,
  `TOKEN_ENDPOINT`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC`, `REQUEST_SIGNATURE`
  HMAC-SHA256/512 over `{timestamp}.{body}`, `OAUTH2_CLIENT_CREDENTIALS`, `MUTUAL_TLS`).
  `GatewayAuthConfig::from_json` reads a stored `auth_config_json`.
- **Token cache**: `TokenCache` (bounded, 30 s TS margin, deterministic ±10% jitter), one refresh
  per key, a single refresh after `401/403`, and an optional `RefreshTokenSink` for a rotated
  refresh token. Tokens never appear in `Debug` output or an error message.
- **Mutual TLS**: a client certificate from the `certificate`/`privateKey`/`ca` credentials or from
  `pg_mtls::ClientTlsPaths`; one cached client per credential identity.
- **Responses**: status, headers, exact `raw_text` and parsed `data` (JSON only when the content
  type says so), JSON depth 64, XML `DOCTYPE`/`ENTITY` rejection. Failures carry a stable code:
  the `compileUrl`/SSRF codes for a refused destination and the `API_*` family for transport,
  authentication-config and response failures (`API_TIMEOUT`, `API_NETWORK_ERROR`,
  `API_RESPONSE_TOO_LARGE`, `API_JSON_DEPTH_EXCEEDED`, …).

Tests: `cargo test -p pg-egress` (80 unit + 20 integration). The integration suite runs a local
`tokio::net::TcpListener` HTTP/HTTPS server (rcgen certificates) and asserts the applied
headers/query/body, the HMAC golden value, token reuse/refresh/rotation, a refused redirect and
private host, the response cap, a timeout and mutual TLS.

## Conventions

- `#![forbid(unsafe_code)]` in every crate.
- Money is `rust_decimal`; no floats in money/ledger modules.
- No `unwrap`/`expect`/`panic!` in request, worker or CLI paths.
- Every route gets a `pg_http::policy::Policy`; deny by default.
- Ports carry `/// Port of <ts path>:<symbol>`.
- Adding a dependency requires a `DEVIATIONS.md` entry.
