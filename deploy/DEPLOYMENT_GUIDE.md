# Payment Gateway — Multi-Host Deployment Guide

This guide is the operator manual for `deploy/deploy.ts`. It covers the 1-to-5
host topology, the environment reference, the certificate model, the firewall
policy and the recovery procedures.

> The platform is a 7-service monolith: `core-back` (the only service with a
> database credential and the `KMS_MASTER_KEY`), the three edge APIs
> (`admin-back`, `merchant-back`, `checkout-back`) and the three SPAs
> (`admin-front`, `merchant-front`, `checkout-front`).

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
| `--skip-verify` | Skip the end-to-end mTLS health verification. |
| `--rotate-certs` | Regenerate the internal CA **and** every leaf certificate. |
| `--keep=<n>` | Releases kept per host (default `KEEP_RELEASES`). |
| `--dry-run` | Print every local and remote command, execute nothing. |

The script refuses to start if `deploy.env` is missing or invalid: every value
is validated with Zod before the first SSH connection.

## 1.1 What the bootstrap installs, and what it configures

A `--fresh` run installs `nginx rsync ufw curl ca-certificates` and `nodejs`
(PM2 runs on Node; the applications run on Bun), installs Bun, installs PM2 and
symlinks Bun to `/usr/local/bin/bun` so the PM2 interpreter always resolves.

Two host settings are applied automatically because the schema depends on them:

* **`log_bin_trust_function_creators = 1`** on MySQL. The maker≠checker guard is
  a `BEFORE INSERT` trigger, and MySQL forbids creating a trigger while the
  binary log is on unless this flag is set or the user has `SUPER` (the
  application user never does). The deploy sets the global value and persists it
  in `/etc/mysql/conf.d/zz-payment-gateway.cnf`.
* **TLS for every vhost**, including the LAN-only admin. When a public vhost is
  in `self_signed` mode, or the admin vhost has no certificate, the deploy mints
  a certificate bound to the server name so `nginx -t` always passes.

PM2 applications are restarted with `pm2 delete` + `pm2 start` on every deploy,
not `startOrReload`: PM2 keeps the old `script`/`cwd` when an app is reloaded by
name, which would leave the previous (eventually pruned) release running. The
restart is sub-second on a single-instance fork app.

### A single staging box

Every role may share one host. Because MySQL binds to `127.0.0.1`, point the
application connection at the loopback and keep `DB_SSH_HOST` at the box:

```dotenv
DB_SSH_HOST="203.0.113.10"
DB_PRIVATE_IP="127.0.0.1"
DATABASE_URL="mysql://pg_core_user:...@127.0.0.1:3306/payment_gateway_prod"
CORE_PRIVATE_IP="203.0.113.10"     # edge -> core mTLS target
MERCHANT_SSL_MODE="self_signed"    # no public DNS on a test box
CHECKOUT_SSL_MODE="self_signed"
```

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

## 2. The 1-to-5 host topology

The orchestrator groups the five logical roles by their SSH endpoint
(`SSH_HOST:SSH_PORT`). Roles that share an endpoint are one machine.

| Role | Runs | Public exposure |
| :--- | :--- | :--- |
| `DB_HOST` | MySQL 8 / MariaDB 10.6+ (or PostgreSQL) | **Never** public. Accepts the DB port only from `CORE_PRIVATE_IP`. |
| `CORE_HOST` | `core-back` `:4000` (mTLS 1.3) | **Never** public. Accepts `:4000` only from the three edge private IPs. |
| `ADMIN_HOST` | `admin-back` `:4101` + `admin-front` via Nginx `:8443` | LAN only (`LAN_ALLOWED_CIDRS`). |
| `MERCHANT_HOST` | `merchant-back` `:4102` + `merchant-front` via Nginx `80/443` | Public HTTPS. |
| `CHECKOUT_HOST` | `checkout-back` `:4103` + `checkout-front` via Nginx `80/443` | Public HTTPS. |

Three supported shapes:

- **A — five servers:** every `*_SSH_HOST` is a distinct IP.
- **B — two servers:** e.g. `ADMIN_SSH_HOST = CORE_SSH_HOST` (internal) and
  `CHECKOUT_SSH_HOST = MERCHANT_SSH_HOST` (public edge). The script
  bootstraps each host once and merges both PM2 apps and both Nginx vhosts.
- **C — one staging box:** every `*_SSH_HOST` is the same IP. Ports stay
  distinct and mTLS is still enforced.

`./deploy/deploy.sh --dry-run` prints the resulting **Host Topology Map**,
which is the fastest way to confirm that your deduplication is what you meant.

## 3. Environment reference

### Global

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `DEPLOY_MODE` | `auto` | `auto` (fresh when the remote dir is absent), `fresh`, `update`. |
| `KEEP_RELEASES` | `5` | Releases kept per host; older ones are pruned in step 11. |
| `ROTATE_MTLS_CERTS` | `false` | Force a CA + leaf regeneration. |
| `MTLS_VALIDITY_DAYS` | `825` | Leaf certificate validity. |
| `LAN_ALLOWED_CIDRS` | `127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Nginx allowlist and `ADMIN_LAN_CIDRS` for the admin host. |

### Database (`DB_*`)

| Variable | Notes |
| :--- | :--- |
| `DB_MANAGE_VIA_SSH` | When `true`, the script creates the database and the application user on the DB host through its own sudo access. |
| `DB_SSH_HOST` / `_PORT` / `_USER` / `_KEY_PATH` / `_SUDO_PASSWORD` | SSH target of the database host. |
| `DB_PRIVATE_IP` | The address the core connects to. Must differ from `CORE_PRIVATE_IP`. |
| `DB_ENGINE` | `mysql` or `postgresql`. Must agree with `DATABASE_URL`. |
| `DB_PORT` | `3306` (MySQL/MariaDB) or `5432` (PostgreSQL). |
| `DB_NAME` / `DB_USER` | Identifier-safe database and role names. |
| `DB_PASSWORD` | The application role password (≥ 8 chars). |
| `DATABASE_URL` | The connection string the core uses. |

### Core (`CORE_*`)

`CORE_SSH_HOST`, `CORE_SSH_PORT`, `CORE_SSH_USER`, `CORE_SSH_KEY_PATH`,
`CORE_SUDO_PASSWORD`, `CORE_PRIVATE_IP` (bound and in the certificate SAN),
`CORE_PORT` (default 4000), `CORE_REMOTE_DIR` (default `/var/www/pg-core`),
`RUN_PRISMA_SEED` (`true` on the first deploy only).

### Admin (`ADMIN_*`)

`ADMIN_SSH_*`, `ADMIN_SUDO_PASSWORD`, `ADMIN_PRIVATE_IP`,
`ADMIN_BACK_PORT` (4101), `ADMIN_NGINX_LAN_PORT` (8443), `ADMIN_DOMAIN`,
`ADMIN_REMOTE_DIR`.

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
| `REDIS_URL` | Optional; enables cross-node `InvalidationBus`. |

## 4. Certificates (mTLS 1.3)

`deploy/lib/pkiManager.ts` creates the whole PKI in `deploy/.certs/`
(`chmod 600`, gitignored):

- `internal-ca.crt` / `internal-ca.key` — the offline root CA.
- `core-back.crt` / `.key` — the **server** certificate, SAN
  `IP:<CORE_PRIVATE_IP>, IP:127.0.0.1, DNS:core-back.internal`. The SAN is
  mandatory: the edge hosts reach the core by private IP and TLS 1.3 verifies
  the hostname.
- `admin-back-client`, `merchant-back-client`, `checkout-back-client` — the
  **client** certificates, `CN=admin-back|merchant-back|checkout-back`.

Least-privilege distribution:

| Host | Receives |
| :--- | :--- |
| `CORE_HOST` | `internal-ca.crt`, `core-back.crt`, `core-back.key` |
| `ADMIN_HOST` | `internal-ca.crt`, `admin-back-client.crt/.key` |
| `MERCHANT_HOST` | `internal-ca.crt`, `merchant-back-client.crt/.key` |
| `CHECKOUT_HOST` | `internal-ca.crt`, `checkout-back-client.crt/.key` |

`internal-ca.key` **never leaves the deployment workstation**. An edge host has
no database credential, no `KMS_MASTER_KEY` and no other host's client key, so
compromising one public host does not compromise the platform.

Rotate: `./deploy/deploy.sh --rotate-certs` (all hosts are updated in the same
run). Certificates are inspected in step 3 and again in the audit summary, with
the remaining validity in days.

### Changing the server IP

The private IP is part of the core certificate SAN, the nginx vhosts, the DB
grants and the UFW rules, so a new LAN address needs one coordinated run:

1. Update every `*_PRIVATE_IP` and `*_SSH_HOST` in `deploy/deploy.env` to the
   new address (all roles on one box share it).
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
| `DB_HOST` | SSH, `DB_PORT` from `CORE_PRIVATE_IP` | — |
| `CORE_HOST` | SSH, `CORE_PORT` from the admin/merchant/checkout private IPs | — |
| `ADMIN_HOST` | SSH, `ADMIN_NGINX_LAN_PORT` from `LAN_ALLOWED_CIDRS` | `admin-back` on `127.0.0.1` |
| `MERCHANT_HOST` | SSH, 80, 443 | `merchant-back` on `127.0.0.1` |
| `CHECKOUT_HOST` | SSH, 80, 443 | `checkout-back` on `127.0.0.1` |

A host that runs several roles gets the union of its rules. The SSH rule is
always emitted, and `ufw --force enable` is the **last** command, so the deploy
can never lock itself out.

## 6. The 12-step pipeline

1. Validate `deploy.env` and print the topology map.
2. Build the three SPAs locally (`bun run build`).
3. Generate or verify the PKI.
4. Bootstrap each unique host (`--fresh`) and apply UFW.
5. Create the database and the application role; take a pre-migration backup
   (compressed) into `CORE_REMOTE_DIR/shared/backups/`.
6. Deploy `core-back`: rsync, certs, `.env`, `bun install --frozen-lockfile`,
   `prisma generate`, `migrate-deploy`, optional seed, atomic `current`
   symlink, PM2 reload.
7. Deploy `admin-back` + `admin-front` on the LAN vhost.
8. Deploy `merchant-back` + `merchant-front` (unbuffered POS SSE).
9. Deploy `checkout-back` + `checkout-front` (unbuffered payer SSE, strict CSP).
10. Verify: the core `/health` over mTLS, each edge backend `/health`, each edge
    host completing an mTLS handshake to **its own** core channel, and the
    public vhosts.
11. Prune old releases.
12. Print the audit summary (commit, release timestamp, hosts, certificate
    expiry).

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
| `Invalid deploy.env: DATABASE_URL must start with mysql://` | `DATABASE_URL` and `DB_ENGINE` disagree. |
| `DB_PRIVATE_IP and CORE_PRIVATE_IP cannot be the same host` | The design keeps the database on its own node; use a separate IP or set `DB_MANAGE_VIA_SSH=false` and point `DATABASE_URL` at an external database. |
| `missing certificate /etc/letsencrypt/…` | Issue it: `certbot --nginx -d <domain> --agree-tos -m ops@<domain>`. |
| `core /health (mTLS) FAIL` | The core did not start: `pm2 logs pg-core-back`, then check `shared/.env`. |
| `mTLS -> core /internal/admin/health FAIL` | The client certificate does not match the channel (`CN=admin-back` is required on `/internal/admin`). |
| The whole deploy aborts after step 10 | No host was left broken; the previous release is still on disk. |

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
