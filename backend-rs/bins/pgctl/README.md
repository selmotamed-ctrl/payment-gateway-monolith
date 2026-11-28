# `pgctl` — deploy engine (Rust port)

`pgctl` is the Rust replacement for `deploy/` (chapter 7 of `design/14-rust-port/`). The binary also
carries the D4 PKI and the storage TLS plan; this README documents the PKI surface in detail, since
operators run it before any storage or service is provisioned.

```
pgctl version
pgctl config validate|import|schema
pgctl plan
pgctl pki …
pgctl release build|sign|verify
pgctl service install
pgctl deploy | rollback | watch
pgctl route-table | workers handover | push
```

Exit codes: `0` success, `1` failure/check failed, `2` usage, `3` precondition.

## PKI (`pgctl pki`)

The PKI is in-process (`rcgen`); no `openssl` binary is required on the operator workstation and the
root key never has to leave the host that runs `pki init`.

### Commands

| Command | What it does |
| :--- | :--- |
| `pki init [--dir D] [--root-days 3650] [--intermediate-days 1095]` | Create the root CA and the per-environment intermediate CA. Refuses to overwrite an existing CA. |
| `pki init --rotate` | Build a new CA in a staging directory, swap it in, and re-issue every non-revoked leaf. Revoked names are skipped and reported. |
| `pki issue --file pgctl.toml` | Issue the whole topology catalogue (`[tls].leaf_days`, default 90). |
| `pki issue --name core-back` | Issue one catalogue entry (the other entries are untouched). |
| `pki issue --name srv --cn srv.internal --dns srv.internal --ip 10.0.0.11 --kind server` | Custom leaf. `--kind` defaults to `server` when SANs are given, else `client`. |
| `pki renew [--within-days 30]` | Re-issue **only** leaves inside the window, with the same CA. No-op runs leave every file byte-identical. Refuses to renew under a CA that is itself inside the window (`pki init --rotate`). |
| `pki revoke --name X` / `--serial HEX` | Add the serial to `revoked.json`, increment the CRL number and sign `crl.pem`. Idempotent; unknown serials fail. |
| `pki inventory [--write]` | Print/refresh the deterministic inventory (serial, SHA-256 fingerprint, not-after, roles). |
| `pki verify [--file pgctl.toml]` | Check the chain, expiry, SANs/CN, revocation, CRL and file modes. Exit 1 with one line per problem. |
| `pki dev [--dir D]` | Complete local/CI bundle, default `<repo>/core-back/certs`. Refuses `/etc`, `/var/lib/pg*`, `/opt/pg`, `/srv/pg`. |
| `pki storage --file pgctl.toml` | Print the storage TLS plan section (paths, SANs, `verify-full` settings). |

`--now <unix>` on `init`, `renew`, `revoke`, `verify` and `dev` evaluates the command at a fixed clock; it
exists for CI and tests.

`[tls]` in `pgctl.toml` drives the defaults: `pki_dir` (default `/etc/pg/pki`), `leaf_days`,
`renew_within_days`, `rotate`. `--dir` wins over `pki_dir`. `--file` wins over the global `--config`
for the commands that accept it.

### Files

| File | Content | Mode |
| :--- | :--- | :--- |
| `internal-ca.crt` | Root CA only (the trust anchor, same name the TypeScript bundle used) | 0644 |
| `internal-ca.key` | Root CA key — export to offline storage and remove from the workstation when done | 0600 |
| `intermediate-ca.crt` / `.key` | Per-environment intermediate CA | 0644 / 0600 |
| `ca-chain.crt` | Root + intermediate | 0644 |
| `<name>.crt` | Leaf **followed by the intermediate**, so a root-only trust store verifies it | 0644 |
| `<name>.key` | Leaf key (ECDSA P-256, PKCS#8) | 0600 |
| `inventory.json` | Deterministic inventory, sorted by name, no timestamp | 0644 |
| `revoked.json` | Documented revocation list (source of truth for the CRL) | 0644 |
| `crl.pem` | CRL signed by the intermediate (`SSL CRL`), 30-day next-update | 0644 |

Algorithm: ECDSA P-256 for root, intermediate and leaves (the design's P-384 root and optional
RSA-2048 leaves are not used; `rcgen` with the `ring` backend is the pinned, buildable choice —
recorded as a D4 deviation). Writes are atomic (temp file in the same directory, fsync, rename). A newly
created or empty PKI directory is tightened to 0700; a populated directory is never chmodded by
surprise.

### CN / SAN / EKU catalogue

The CNs are not arbitrary: they are the allow-lists the services already enforce.

- `pg-mtls::allowed_channel_cns` binds `/internal/admin`, `/internal/merchant` and
  `/internal/checkout` to exactly `admin-back`, `merchant-back`, `checkout-back`.
- The backup daemon accepts `backup-client` for control, `wal-archive-client` for WAL `PUT` only,
  and `backup-admin` for policy changes (`S-SEC-09`).
- The object-storage daemon defaults to `object-storage-client,backup-daemon,backup-client`.
- Edges reach the core by private IP, so the core certificate carries every core node IP in its SAN.

| File stem | CN | SANs | EKU | Roles |
| :--- | :--- | :--- | :--- | :--- |
| `core-back` | `core-back.internal` | `DNS:core-back.internal`, `DNS:core-back`, every `core` node DNS/IP, the sandbox host, `IP:127.0.0.1`, `IP:::1` | server, client | core, server |
| `admin-back-client` | `admin-back` | — | client | admin, edge, client |
| `merchant-back-client` | `merchant-back` | — | client | merchant, edge, client |
| `checkout-back-client` | `checkout-back` | — | client | checkout, edge, client |
| `fake-rails` | `[services.fake_rails].public_host`, else `fakerails.internal` | CN, `DNS:localhost`, fake-rails host DNS/IPs, `IP:127.0.0.1`, `IP:::1` | server | fake-rails, server |
| `fake-rails-client` | `fake-rails-client` | — | client | fake-rails, control, client |
| `backup-daemon` | `backup-daemon.internal` | CN, backup host DNS/IPs, `IP:127.0.0.1`, `IP:::1` | server, client | backup, server |
| `object-storage-daemon` | `object-storage-daemon.internal` | CN, object-storage host DNS/IPs, `IP:127.0.0.1`, `IP:::1` | server, client | object-storage, server |
| `backup-client` | `backup-client` | — | client | backup, client |
| `backup-admin` | `backup-admin` | — | client | backup, policy, client |
| `wal-archive-client` | `wal-archive-client` | — | client | backup, wal, client |
| `object-storage-client` | `object-storage-client` | — | client | object-storage, storage, client |
| `pg-client` | `pg-client` | — | client | postgres, storage, client |
| `audit-db-client` | `audit-db-client` | — | client | postgres, audit, storage, client |
| `log-db-client` | `log-db-client` | — | client | postgres, log, storage, client |
| `redis-client` | `redis-client` | — | client | redis, storage, client |
| `postgres-<host>` | node name (or `postgres.internal` for an IP-only external host) | node name/public DNS, `DNS:localhost`, node IP(s), `IP:127.0.0.1`, `IP:::1` | server | postgres, server |
| `pgbouncer-<host>` | node name | same as PostgreSQL | server | pgbouncer, server |
| `redis-<host>` | node name | same as PostgreSQL | server | redis, server |

The storage certificates are issued for hosts with the `pg-primary`, `pg-replica`, `audit-db`,
`log-db`, `pgbouncer` and `redis` roles, plus external `[database].host` / `[redis].host` values.
`pki issue` re-issues a leaf automatically when its CN, SANs or EKU drift from the catalogue (a
staging box that moves to another LAN keeps working), and when it is inside the renewal window.

### Development bundle (`pki dev`)

`pki dev` replaces `core-back/scripts/generate-mtls-certs.ts` for local/CI use:

- default output `<repo>/core-back/certs`, with the same file names
  (`internal-ca.crt`, `core-back.crt`, `admin-back-client.crt`, …);
- root + intermediate + everything in the catalogue, including the storage server certificates;
- dev core CN is `core-back` (TS compatibility), production is `core-back.internal`;
- default leaf lifetime 825 days (TS `MTLS_CERT_DAYS`), CA 10 years / intermediate 3 years;
- re-running reuses the existing CA and leaves, so it is safe in scripts. `--rotate` replaces the
  dev CA and re-issues everything; a CA without an intermediate (an old TS bundle) is refused
  without `--rotate`;
- production paths (`/etc`, `/var/lib/pg*`, `/opt/pg`, `/srv/pg`) are refused.

### Renewal, rotation, revocation

- **Renew**: only leaves whose remaining lifetime is **strictly less** than the window
  (`MTLS_RENEW_WITHIN_DAYS`, default 30; `0` disables). The CA and every other certificate stay
  byte-identical; a no-op does not even rewrite `inventory.json`.
- **Rotate CA**: `pki init --rotate` builds the new CA in `.pki-rotate/` and swaps the five CA files
  in only after the new CA is complete, then re-issues the non-revoked inventory leaves.
- **Revoke**: writes `revoked.json` (serial, name, reason, instant) and signs `crl.pem`. Reasons:
  `unspecified`, `key-compromise`, `ca-compromise`, `affiliation-changed`, `superseded`,
  `cessation-of-operation`, `certificate-hold`, `privilege-withdrawn`, `aa-compromise`. Re-running
  a revoke is a no-op (no duplicate, no CRL-number bump). `pki verify` reports both the list entry
  and a stale/missing CRL.
- **Rotation of the root** is an offline operation by design: export `internal-ca.key`, keep it off
  the workstation, and run `pki init --rotate` in a controlled window.

### Storage TLS plan (D4-T02 / S-SEC-06)

`pgctl pki storage --file pgctl.toml` prints the section that `pgctl plan --json` also embeds under
`pki`:

- PostgreSQL (`postgres-<host>`): local cert/key, `ca-chain.crt`, `crl.pem`, install paths under
  `/etc/postgresql/18/<cluster>/tls/`, `sslmode=verify-full&sslrootcert=…&sslcert=…&sslkey=…`;
- PgBouncer (`pgbouncer-<host>`): `/etc/pgbouncer/tls/`, `server_tls_sslmode=verify-full`,
  `client_tls_sslmode=verify-full`;
- Redis/Valkey (`redis-<host>`): `/etc/redis/tls/`, `tls-auth-clients yes`, `rediss://` clients;
- shared client certificates (`pg-client`, `audit-db-client`, `log-db-client`, `redis-client`,
  `wal-archive-client`, `backup-client`, `object-storage-client`);
- guidance, including the negative test: a connection with the wrong CA must fail the handshake.

The TypeScript engine generated self-signed PostgreSQL certificates and used
`sslmode=no-verify`, an unverified PgBouncer server leg and plaintext Redis. This plan is the
`verify-full` replacement; the D5 provisioners consume these paths and SANs. No TypeScript deploy
engine file was changed for D4.

### Not in this phase

- CRL **distribution** to hosts and `ssl_crl_file` wiring is planned in D4-T02/D5; `pki revoke`
  produces the CRL but does not push it.
- **Hot reload** after renewal (`systemctl reload`, PostgreSQL `pg_ctl reload`, PgBouncer `RELOAD`,
  Redis `CONFIG SET`) is not implemented; services pick up new files on their next restart.
- **HSM / PKCS#11** key storage is not implemented; the CA keys are files (0600), with the offline
  root export as the mitigation.
- Locking `revoked.json` against concurrent `pki revoke` runs is not implemented (the deploy
  engine's per-host lock and single-operator workflow are the current guard).
