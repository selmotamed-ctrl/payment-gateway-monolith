---
id: deploy.pki
title: Internal PKI and mTLS Certificates
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - deploy/lib/pkiManager.ts
  - deploy/lib/hostPlanner.ts
  - deploy/deploy.ts
  - core-back/index.ts
  - core-back/api/middleware/mtlsGuard.ts
  - deploy/backup-daemon/src/server.ts
  - core-back/lib/storageEngine/backupControlClient.ts
design_sources:
  - design/payment_gateway_final_design-v5.md#22-mutual-tls-mtls-inter-service-transport-architecture
  - design/payment_gateway_deployment_and_guides_architecture.md#4-automated-mtls-13-pki-generation-san-binding--least-privilege-distribution
  - design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#4-segment-3--postgresql-18-ddl-partialcoveringgin-indexes--dedicated-auditlog-schemas
tests:
  - deploy/test/pkiScale.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
  - deploy/test/provisioners.test.ts
  - deploy/test/templates.test.ts
  - deploy/backup-daemon/test/server.test.ts
gaps:
  - Storage client certificates are generated and distributed but PostgreSQL, Redis, PgBouncer and the audit/log databases do not consume them for client-certificate authentication.
  - PostgreSQL SSL material is not configured by the provisioner; `hostssl` rules rely on whatever TLS configuration the distribution supplies.
  - Redis has no TLS listener or certificate configuration.
  - The backup daemon certificate and key are uploaded with root ownership; the daemon runs as pgbackup, and the deploy does not chown the cert files. mTLS startup readiness is not proven.
  - Existing leaf certificates are reused when all SANs match even if they are close to expiry or already expired; rotation requires an explicit flag.
  - The backup daemon accepts any CA-signed client certificate; it does not bind a client CN to an operation.
---

# Internal PKI and mTLS Certificates

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

- `design/payment_gateway_final_design-v5.md` section 2.2, mTLS and certificate roles.
- `design/payment_gateway_deployment_and_guides_architecture.md` section 4, PKI generation and distribution.
- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` section 4, storage DDL.

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
