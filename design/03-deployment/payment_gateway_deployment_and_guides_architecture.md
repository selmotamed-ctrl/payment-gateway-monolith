# MULTI-RAIL PAYMENT GATEWAY PLATFORM — MULTI-HOST AUTOMATED DEPLOYMENT ENGINE & 4-PORTAL INTERACTIVE GUIDES ARCHITECTURE

**Subtitle:** Topology-Aware Multi-Server Deployment Orchestrator (`1..N Compute Nodes + Dedicated PostgreSQL 18/Redis/Audit/Log/Backup Storage Tiers`, Automated Multi-Node mTLS 1.3 PKI Generation & Distribution, Per-Host UFW Zero-Trust Firewalling, Atomic Symlink Releases, PM2 + Bun, Multi-Vhost Nginx Generator, Rolling Batches and Storage Provisioners) and Built-In Interactive User Guides, Employee Academy & Dynamic Checkout Help Center across `admin-front`, `merchant-front`, and `checkout-front`.

**Target Repository:** [`selmotamed-ctrl/payment-gateway-monolith`](https://github.com/selmotamed-ctrl/payment-gateway-monolith) (`core-back`, `admin-back`, `admin-front`, `merchant-back`, `merchant-front`, `checkout-back`, `checkout-front`, `design`)

## Contents

- **PART I: MULTI-SERVER ZERO-TRUST DEPLOYMENT ENGINE ARCHITECTURE**
  - 1. Flexible 1..N Compute + Storage Topology Model (Same-Server vs. Fully Distributed)
  - 2. Complete `deploy/` Directory Structure
  - 3. Multi-Host Configuration Architecture: `deploy.env` & Zod 4 Validator
  - 4. Automated mTLS 1.3 PKI Generation, SAN Binding & Least-Privilege Distribution
  - 5. Host-Aware UFW Firewall & Network Isolation Provisioning
  - 6. Ordered 14-Step Multi-Host Deployment Pipeline (Storage -> Core -> Edge Nodes)
  - 7. Reference Templates (Multi-App PM2, Public SSL Nginx, LAN-Only Admin Nginx)
  - 8. Complete Operator Manual & Environment Variable Reference (`deploy/DEPLOYMENT_GUIDE.md`)
- **PART II: THE FOUR BUILT-IN INTERACTIVE PORTAL GUIDES & EMPLOYEE ACADEMY**
  - 9. Architectural Overview of the 4 Embedded Knowledge & Help Systems
  - 10. System 1: Admin Portal Interactive Searchable User Guide (`admin-front/src/pages/guide/index.tsx`)
  - 11. System 2: Admin Portal A-to-Z Employee Academy & Certification LMS (`admin-front/src/pages/academy/index.tsx`)
  - 12. System 3: Merchant Dashboard Interactive Searchable User & Developer Guide (`merchant-front/src/pages/guide/index.tsx`)
  - 13. System 4: Checkout Dynamic Help Center, Per-Rail Step-by-Step Guides & Admin-Configured Contact Support (`checkout-front`)
- **PART III: OPENCODE AI IMPLEMENTATION CHECKLIST**
  - 14. Phased Tasks & Verification Gates for OpenCode

---

# PART I: MULTI-SERVER ZERO-TRUST DEPLOYMENT ENGINE ARCHITECTURE

## 1. Flexible 1..N Compute + Storage Topology Model (Same-Server vs. Fully Distributed)

Unlike a single-server app, the Payment Gateway Platform consists of **4 backend services**, **3 frontend SPAs**, and a **PostgreSQL 18 storage plane**, where any service may live on its own dedicated physical/virtual server or share a host with others:

- **Compute tiers (`1..N` nodes):** `CORE_NODES` runs `core-back` on port `4000` (mTLS 1.3 server, the only Prisma client, database credentials and `KMS_MASTER_KEY`), and `ADMIN_NODES` / `MERCHANT_NODES` / `CHECKOUT_NODES` run the three edge backends plus their SPAs. Each tier is declared as a comma-separated array of `nodeId@sshHost:sshPort:privateIp:servicePort` entries.
- **PostgreSQL 18 primary:** `PG_PRIMARY_NODE` runs the relational core. It accepts `5432` from replicas and, when PgBouncer is disabled, from core nodes.
- **Streaming replicas (`1..M`):** `PG_REPLICA_NODES` receive physical replication via `pg_basebackup -R` and serve dashboards, lists, exports and deep search with LSN-aware read-your-own-writes routing.
- **PgBouncer:** when `PGBOUNCER_ENABLED=true`, transaction-mode pooling runs on the primary and every replica on `6432`, and core nodes connect through it.
- **Redis:** `REDIS_NODES` provides the L1/L2 cache and atomic velocity counters; it is never authoritative for money.
- **Dedicated audit and log databases:** `AUDIT_DB_NODE` (`pg_audit_db`, append-only SHA-256 hash chain) and `LOG_DB_NODE` (`pg_logs_db`, monthly-partitioned step/access logs).
- **Backup daemon:** `BACKUP_NODE` runs `pg-backup-daemon` on an mTLS control plane (`:4090`) over WAL-G or Barman, with S3 primary storage and an optional secondary SSH/S3 target.

### Smart Host Deduplication in `deploy/deploy.ts`
The deployment orchestrator groups every compute and storage role by `(sshHost, sshPort)`:
- **Scenario A (fully distributed):** every compute tier and storage role has its own host.
- **Scenario B (combined compute hosts — e.g., Internal Core/Admin + Public Edge):** the script detects shared SSH endpoints, bootstraps each host once, and merges PM2 services, Nginx vhosts and UFW rules.
- **Scenario C (single all-in-one staging server):** all roles share one host (`127.0.0.1` private communication), while still enforcing mTLS client certificates and distinct compute listeners (`4000`, `4101`, `4102`, `4103`, `8443`, `443`). PostgreSQL-family storage roles may co-locate on `5432`.
- **Scenario D (horizontal compute):** add `core-2`, `merch-2`, `chk-2`, etc. to the node arrays. Edge nodes receive `CORE_BACK_URLS=https://<core-private-ip>:<port>,...` and `CORE_BACK_URL` (first node for compatibility); the core server certificate SAN contains every core private IP. Deploys use rolling batches (`--rolling-batch`) and can be limited with `--nodes`.

---

## 2. Complete `deploy/` Directory Structure

```text
payment-gateway-monolith/
├── core-back/
├── admin-back/
├── admin-front/
├── merchant-back/
├── merchant-front/
├── checkout-back/
├── checkout-front/
├── design/
└── deploy/
    ├── deploy.sh                       # CLI Entrypoint (`bun run deploy/deploy.ts "$@"`)
    ├── deploy.ts                       # Multi-host topology orchestrator
    ├── deploy.env.example              # Fully documented multi-server env template
    ├── deploy.env                      # Operator's secret config (gitignored, chmod 600)
    ├── DEPLOYMENT_GUIDE.md             # Complete operator manual & variable dictionary
    ├── lib/
    │   ├── configSchema.ts             # Zod 4 validator for compute tiers, PG/storage nodes & app vars
    │   ├── hostPlanner.ts              # Deduplicates hosts by SSH endpoint, plans compute + storage nodes
    │   ├── pkiManager.ts               # Generates/rotates Internal CA + multi-node SAN mTLS certs
    │   ├── sshRunner.ts                # Multi-host SSH, stdin-sudo (`sudo -S`), and rsync engine
    │   ├── firewallConfigurator.ts     # Configures strict UFW rules per compute/storage role
    │   └── healthVerifier.ts           # End-to-end mTLS + storage + HTTP health probes
    ├── provisioners/
    │   ├── postgres18Provisioner.ts    # PostgreSQL 18 primary/replicas + PgBouncer
    │   ├── redisProvisioner.ts         # Redis cache/velocity tier
    │   ├── auditAndLogDbProvisioner.ts # pg_audit_db + partitioned pg_logs_db
    │   └── backupEngineProvisioner.ts  # WAL-G/Barman + pg-backup-daemon + cron drills
    ├── backup-daemon/                  # mTLS backup control plane + restore/invariant drills
    ├── templates/
    │   ├── pm2.core.config.cjs.tpl
    │   ├── pm2.edge.config.cjs.tpl
    │   ├── nginx.admin.lan.conf.tpl    # LAN-only port 8443 SSL config (`allow <LAN_CIDR>; deny all;`)
    │   ├── nginx.merchant.ssl.conf.tpl # Public 80->443 SSL config for merchant portal & POS stream
    │   └── nginx.checkout.ssl.conf.tpl # Public 80->443 SSL config for checkout & SSE stream
    └── test/                           # config, planner, PKI, provisioner and rolling-deploy suites
```

---

## 3. Multi-Host Configuration Architecture: `deploy.env` & Zod 4 Validator

### 3.1 Complete `deploy/deploy.env.example`

PostgreSQL 18 is the default and the only supported runtime engine. The `DB_*`
block is a legacy single-host compatibility path; the `PG_*` block is the
current primary/replica/PgBouncer storage tier.

```ini
# --- 0. GLOBAL DEPLOYMENT OPTIONS ---------------------------------------------
DEPLOY_MODE="auto"                  # "auto" | "fresh" | "update" (rolling_update is accepted)
DEPLOY_ENV="production"
ROLLING_BATCH_SIZE="1"              # nodes per rolling batch
KEEP_RELEASES="5"
ROTATE_MTLS_CERTS="false"
MTLS_VALIDITY_DAYS="825"
LAN_ALLOWED_CIDRS="127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

# Multi-node format (all *_NODES arrays, PG_PRIMARY_NODE, PG_REPLICA_NODES,
# REDIS_NODES, AUDIT_DB_NODE, LOG_DB_NODE, BACKUP_NODE):
#   nodeId@sshHost:sshPort:privateIp:servicePort

# --- 1. LEGACY SINGLE-HOST DATABASE COMPATIBILITY (OPTIONAL) ------------------
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_PORT="22"
DB_SSH_USER="ubuntu"
DB_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_db"
DB_SUDO_PASSWORD="db-sudo-password"
DB_PRIVATE_IP="10.10.0.10"
DB_ENGINE="postgresql"              # PostgreSQL 18 only
DB_PORT="5432"
DB_NAME="payment_gateway_prod"
DB_USER="pg_core_user"
DB_PASSWORD="ultra-strong-db-password"
DATABASE_URL="postgresql://pg_core_user:ultra-strong-db-password@10.10.0.10:5432/payment_gateway_prod"

# --- 1b. HORIZONTAL COMPUTE NODE ARRAYS --------------------------------------
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
MERCHANT_NODES="merch-1@203.0.113.11:22:10.10.3.11:4102,merch-2@203.0.113.12:22:10.10.3.12:4102"
CHECKOUT_NODES="chk-1@203.0.113.21:22:10.10.4.11:4103,chk-2@203.0.113.22:22:10.10.4.12:4103"
# CORE_BACK_URLS="https://10.10.1.11:4000,https://10.10.1.12:4000"

# --- 2. CORE-BACK SERVER (PRIVATE LAN ONLY, SOLE DB OWNER) -------------------
CORE_SSH_HOST="10.10.0.20"
CORE_SSH_PORT="22"
CORE_SSH_USER="ubuntu"
CORE_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_core"
CORE_SUDO_PASSWORD="core-sudo-password"
CORE_PRIVATE_IP="10.10.0.20"
CORE_PORT="4000"
CORE_REMOTE_DIR="/var/www/pg-core"
RUN_PRISMA_SEED="false"

# --- 3. ADMIN SERVER (PRIVATE LAN ONLY, NON-FORWARDED PORT) ------------------
ADMIN_SSH_HOST="10.10.0.30"
ADMIN_SSH_PORT="22"
ADMIN_SSH_USER="ubuntu"
ADMIN_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_admin"
ADMIN_SUDO_PASSWORD="admin-sudo-password"
ADMIN_PRIVATE_IP="10.10.0.30"
ADMIN_BACK_PORT="4101"
ADMIN_NGINX_LAN_PORT="8443"
ADMIN_DOMAIN="admin.internal"
ADMIN_REMOTE_DIR="/var/www/pg-admin"

# --- 4. MERCHANT SERVER (PUBLIC SSL 80/443) ----------------------------------
MERCHANT_SSH_HOST="203.0.113.10"
MERCHANT_SSH_PORT="22"
MERCHANT_SSH_USER="ubuntu"
MERCHANT_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_merchant"
MERCHANT_SUDO_PASSWORD="merchant-sudo-password"
MERCHANT_PRIVATE_IP="10.10.0.40"
MERCHANT_BACK_PORT="4102"
MERCHANT_DOMAIN="merchant.yourdomain.ly"
MERCHANT_SSL_MODE="certbot"
MERCHANT_SSL_CERT_PATH="/etc/letsencrypt/live/merchant.yourdomain.ly/fullchain.pem"
MERCHANT_SSL_KEY_PATH="/etc/letsencrypt/live/merchant.yourdomain.ly/privkey.pem"
MERCHANT_REMOTE_DIR="/var/www/pg-merchant"

# --- 5. CHECKOUT SERVER (PUBLIC SSL 80/443) ----------------------------------
CHECKOUT_SSH_HOST="203.0.113.20"
CHECKOUT_SSH_PORT="22"
CHECKOUT_SSH_USER="ubuntu"
CHECKOUT_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_checkout"
CHECKOUT_SUDO_PASSWORD="checkout-sudo-password"
CHECKOUT_PRIVATE_IP="10.10.0.50"
CHECKOUT_BACK_PORT="4103"
CHECKOUT_DOMAIN="pay.yourdomain.ly"
CHECKOUT_SSL_MODE="certbot"
CHECKOUT_SSL_CERT_PATH="/etc/letsencrypt/live/pay.yourdomain.ly/fullchain.pem"
CHECKOUT_SSL_KEY_PATH="/etc/letsencrypt/live/pay.yourdomain.ly/privkey.pem"
CHECKOUT_REMOTE_DIR="/var/www/pg-checkout"

# --- 6. POSTGRESQL 18 PRIMARY + STREAMING REPLICAS + PGBOUNCER ---------------
PG_MANAGE_VIA_SSH="true"
PG_VERSION="18"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432,pg-rep-2@10.10.10.12:22:10.10.10.12:5432"
PG_SSH_USER="ubuntu"
PG_SSH_PORT="22"
PG_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_db"
PG_SUDO_PASSWORD="pg-sudo-password"
PG_DB_NAME="payment_gateway_prod"
PG_DB_USER="pg_core_user"
PG_DB_PASSWORD="ultra-strong-pg-password"
PG_REPLICATION_USER="pg_replicator"
PG_REPLICATION_PASSWORD="ultra-strong-repl-password"
PGBOUNCER_ENABLED="true"
PGBOUNCER_PORT="6432"
PGBOUNCER_DEFAULT_POOL_SIZE="50"
PGBOUNCER_MAX_CLIENT_CONN="2000"
PGBOUNCER_MAX_PREPARED_STATEMENTS="256"

# --- 7. REDIS 7.4+ CACHE / VELOCITY ENGINE -----------------------------------
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_USER="ubuntu"
REDIS_SSH_PORT="22"
REDIS_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_redis"
REDIS_SUDO_PASSWORD="redis-sudo-password"
REDIS_PASSWORD="ultra-strong-redis-password"
REDIS_MAXMEMORY="4gb"

# --- 8. DEDICATED AUDIT + LOG DATABASES --------------------------------------
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@10.10.12.10:22:10.10.12.10:5432"
AUDIT_DB_NAME="pg_audit_db"
AUDIT_DB_USER="pg_audit_writer"
AUDIT_DB_PASSWORD="ultra-strong-audit-password"

LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@10.10.12.20:22:10.10.12.20:5432"
LOG_DB_NAME="pg_logs_db"
LOG_DB_USER="pg_log_writer"
LOG_DB_PASSWORD="ultra-strong-log-password"
LOG_RETENTION_MONTHS="12"

# --- 9. BACKUP ORCHESTRATOR & PITR DRILL ENGINE -------------------------------
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_ENGINE_MODE="barman"          # "wal-g" | "barman"
BACKUP_COMPRESSION="zstd"            # "zstd" | "lz4" | "gzip"
BACKUP_ENCRYPTION_KEY_HEX="<64 hex chars; openssl rand -hex 32>"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.eu-central-1.amazonaws.com"
BACKUP_PRIMARY_S3_BUCKET="s3://libya-pg-backups-primary/prod"
BACKUP_PRIMARY_S3_ACCESS_KEY="AKIA..."
BACKUP_PRIMARY_S3_SECRET_KEY="secret..."
BACKUP_SECONDARY_SSH_TARGET="backup-vault@198.51.100.99:/mnt/offsite-vault/pg"
BACKUP_FULL_CRON="0 2 * * 0"
BACKUP_DELTA_CRON="0 2 * * 1-6"
BACKUP_DRILL_CRON="0 4 * * 0"
BACKUP_RETENTION_FULL_COUNT="8"
BACKUP_RETENTION_WAL_DAYS="14"
BACKUP_DAEMON_PORT="4090"

# --- 10. CORE-ONLY MASTER SECRETS (NEVER DELIVERED TO EDGE) -------------------
KMS_MASTER_KEY="change-me-at-least-32-characters-long-secret"
BASE_CURRENCY="LYD"
GATEWAY_TIMEZONE="Africa/Tripoli"
REDIS_URL=""                        # optional external Redis URL
```

---

## 4. Automated mTLS 1.3 PKI Generation, SAN Binding & Least-Privilege Distribution

One of the hardest parts of deploying a multi-server mTLS architecture is making sure certificates match the exact private IP addresses of the servers and that private keys never end up on the wrong machine. `deploy/lib/pkiManager.ts` automates this completely:

1. **Local Vault Generation (`deploy/.certs/` — gitignored, `chmod 600`):**
   - On first run (or when `ROTATE_MTLS_CERTS="true"`), `pkiManager.ts` generates an offline **Internal Root CA** (`internal-ca.key` + `internal-ca.crt`) and signs the leaf certificates:
     - **`core-back.crt` / `core-back.key`:** server certificate whose SAN contains `IP:<every CORE_NODES private IP>`, `IP:127.0.0.1` and `DNS:core-back.internal`. The multi-IP SAN is what lets a rolling deploy of one core node keep mTLS alive on the others.
     - **`admin-back-client.crt` / `.key`:** `CN=admin-back`, `OU=edge-admin`.
     - **`merchant-back-client.crt` / `.key`:** `CN=merchant-back`, `OU=edge-merchant`.
     - **`checkout-back-client.crt` / `.key`:** `CN=checkout-back`, `OU=edge-checkout`.
     - **`backup-daemon.crt` / `.key`:** backup control-plane server certificate, SAN-bound to `BACKUP_NODE` and `127.0.0.1`.
     - **`pg-client`, `redis-client`, `audit-db-client`, `log-db-client`, `backup-client`:** optional storage/backup client certificates generated only when the matching storage tier is enabled.
2. **Strict Least-Privilege Key Distribution:**
   - `internal-ca.key` **never leaves your deployment workstation**.
   - Each core node receives `internal-ca.crt`, `core-back.crt/.key`, and the enabled storage client certificates.
   - Each edge host receives **only** `internal-ca.crt` and its own `<edge>-back-client.crt/.key`.
   - The backup host receives `internal-ca.crt`, `backup-daemon.crt/.key`, `backup-client.crt/.key` and `pg-client.crt/.key`; PostgreSQL/Redis/audit/log storage hosts receive only their own client certificate and the CA.
   - Even if a public edge host is compromised, it does **not** possess another edge's client key, `DATABASE_URL` or `KMS_MASTER_KEY`.

---

## 5. Host-Aware UFW Firewall & Network Isolation Provisioning

During Fresh Bootstrap (or `--enforce-firewall`), `deploy/lib/firewallConfigurator.ts` configures UFW on each server according to its assigned role(s):

| Host Role | Inbound Ports Opened by `firewallConfigurator.ts` | Explicitly Blocked |
| :--- | :--- | :--- |
| **Legacy `DB_HOST`** | `SSH_PORT`, plus `DB_PORT` (`5432`) **ONLY from `CORE_PRIVATE_IP`**. | All public & edge traffic to DB. |
| **`CORE_NODES`** | `SSH_PORT`, plus `CORE_PORT` (`4000`) **ONLY from the admin/merchant/checkout private IPs**. | All public internet traffic to `:4000`. |
| **`ADMIN_NODES`** | `SSH_PORT`, plus `ADMIN_NGINX_LAN_PORT` (`8443`) **ONLY from `LAN_ALLOWED_CIDRS`**. `ADMIN_BACK_PORT` (`4101`) bound to `127.0.0.1` only. | All non-LAN traffic. |
| **`MERCHANT_NODES`** | `SSH_PORT`, `80/tcp`, `443/tcp`. `MERCHANT_BACK_PORT` (`4102`) bound to `127.0.0.1` only. | Direct external access to `:4102`. |
| **`CHECKOUT_NODES`** | `SSH_PORT`, `80/tcp`, `443/tcp`. `CHECKOUT_BACK_PORT` (`4103`) bound to `127.0.0.1` only. | Direct external access to `:4103`. |
| **PostgreSQL primary** | `SSH_PORT`, `5432` from replicas (and core when PgBouncer is off), `6432` from core nodes when PgBouncer is on. | Public and edge traffic. |
| **PostgreSQL replica** | `SSH_PORT`, `5432` from primary/other replicas (and core when PgBouncer is off), `6432` from core nodes when PgBouncer is on. | Public and edge traffic. |
| **Redis** | `SSH_PORT`, `6379` from core and backup nodes. | Public and edge traffic. |
| **Audit DB / log DB** | `SSH_PORT`, the PostgreSQL port from core and backup nodes. | Public and edge traffic. |
| **`BACKUP_NODE`** | `SSH_PORT`, `BACKUP_DAEMON_PORT` (`4090`) from core nodes. | Public and edge traffic. |

*(If multiple roles share the same physical server, `hostPlanner.ts` unions their UFW rules on that host.)*

---

## 6. Ordered 14-Step Multi-Host Deployment Pipeline

When you run `./deploy/deploy.sh` (or target a single tier via `./deploy/deploy.sh --only=checkout`), the orchestrator executes in strict dependency order so the storage plane and database migrations are always live *before* edge servers switch over:

1. **Step 1 — Validate `deploy.env` & Build Execution Plan:** Validates all variables with Zod 4 and prints the **Host Topology Map** (compute nodes and storage roles).
2. **Step 2 — Build the SPAs Locally:** Compiles `admin-front`, `merchant-front`, `checkout-front` and, when enabled, `fake-rails-front`.
3. **Step 3 — Ensure Multi-Node mTLS PKI:** Generates or verifies the internal CA, the multi-SAN core certificate, edge client certificates, the backup-daemon certificate and the storage client certificates.
4. **Step 4 — Bootstrap Unique Target Hosts (Fresh Mode):** Connects to every unique host via SSH, pipes `SUDO_PASSWORD` to `sudo -S`, installs `nginx`, `rsync`, `ufw`, `bun`, `pm2`, and applies role-specific UFW rules.
5. **Step 5 — Provision Storage Engines or the Legacy Database:** Runs the PostgreSQL 18 primary/replica + PgBouncer, Redis, audit/log DB and backup provisioners. On the legacy single-host path, creates the database/role and takes a compressed pre-migration backup into `CORE_REMOTE_DIR/shared/backups/`.
6. **Step 6 — Deploy `core-back`:** Rsyncs the release, uploads the least-privilege certificates, writes `shared/.env` (`DATABASE_URL`, replica URLs, audit/log URLs, Redis, backup control plane, `KMS_MASTER_KEY`), runs `bun install --frozen-lockfile`, `prisma generate`, `migrate-deploy`, optional seed, switches `current`, reloads PM2 and probes `/health` over mTLS.
7. **Step 7 (optional) — Deploy `fake-rails-back` + `fake-rails-front`.**
8. **Step 8 — Deploy `admin-back` + `admin-front`:** Writes `CORE_BACK_URLS=https://<core-ip>:<port>,...` plus `CORE_BACK_URL` (first node), renders the LAN-only Nginx vhost (`:8443`), reloads PM2 and Nginx.
9. **Step 9 — Deploy `merchant-back` + `merchant-front`:** Same mTLS client pool, public `merchant.<domain>` vhost on `80/443` with unbuffered POS SSE.
10. **Step 10 — Deploy `checkout-back` + `checkout-front`:** Same mTLS client pool, public `pay.<domain>` vhost on `80/443` with strict CSP and unbuffered payer SSE.
11. **Step 11 — Seed Fake Rails Blueprints and Synthetic History:** Optional, test-server only.
12. **Step 12 — End-to-End Verification:** Probes every core node, every edge node against a healthy core URL, the public vhosts, PostgreSQL primary/replicas (`pg_isready` + `SELECT 1`), PgBouncer, Redis `PING`, audit/log `SELECT 1`, and the backup-daemon `/health` over mTLS when configured. A failed rolling batch stops the deploy with the previous release still on disk.
13. **Step 13 — Prune Old Releases:** Keeps the most recent `KEEP_RELEASES` (default 5) on each server.
14. **Step 14 — Emit Deployment Audit Summary:** Prints deployed commit SHA, release timestamp, host statuses and active certificate expiry dates.

Rolling updates use `--rolling-batch=<n>` (default `ROLLING_BATCH_SIZE`, or `1`); each batch is health-checked before the next starts. `--nodes=<id,...>` limits a run to named compute nodes. `--only` accepts the compute roles plus `pg`, `pg-primary`, `pg-replica`, `pgbouncer`, `redis`, `audit-db`, `log-db`, `backup` and `storage`.

---

# PART II: THE FOUR BUILT-IN INTERACTIVE PORTAL GUIDES & EMPLOYEE ACADEMY

## 9. Architectural Overview of the 4 Embedded Knowledge & Help Systems

To ensure operators, fresh employees, merchants, and end-customers never feel lost—and to avoid any dependency on external SaaS helpdesks that break LAN isolation—we embed **four specialized interactive documentation & help systems** directly into the portals:

| # | Portal Target | Guide / System Name | Primary Audience | Key Capabilities |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **`admin-front`** | **Admin Interactive Searchable System Guide** (`/guide` + Global `Ctrl+K` + Contextual `?` Drawers) | Platform Admins (`GATEWAY_ADMIN`, `FINANCE`, `COMPLIANCE`, `MLRO`, `OPERATOR`, `SUPPORT`) | Full-text search across all 64 tables/concepts, interactive **Transform & Crypto Playground**, **Double-Entry Ledger Visualizer**, and contextual side-drawers on every wizard step and queue. |
| **2** | **`admin-front`** | **Employee A-to-Z Onboarding Academy (Built-In LMS)** (`/academy`) | Fresh Employees & New Operations/Compliance/Finance Hires | Role-tailored learning tracks, 8 interactive modules from basic concepts to 8-Step Gateway onboarding & AML/Dispute resolution, hands-on sandbox labs, quizzes, and database-tracked completion certificates. |
| **3** | **`merchant-front`** | **Merchant Interactive User & Developer Guide** (`/guide` + Onboarding Coachmarks) | Merchants, Store Managers, Cashiers & Merchant Developers | Interactive searchable guide covering KYB onboarding, Wallets, Applications, Payment Links, POS Terminal/Screen pairing, Cash-outs, Disputes, plus an interactive **API & Webhook Playground** (`pg_live_` tokens). |
| **4** | **`checkout-front`** | **End-Client Checkout Help Center, Per-Rail Walkthroughs & Admin-Configured Contact Center** | Anonymous Payers at Checkout | Context-aware drawer showing step-by-step visual instructions **for the currently selected rail** (e.g., Edfali, Sadad, Moamalat Card, LYPay QR, MobiCash, OnePay), common error troubleshooting, and **Admin-Configured Support Channels** (WhatsApp, Phone, Email, Live Support Hours, or Merchant Support fallback). |

---

## 10. System 1: Admin Portal Interactive Searchable User Guide (`admin-front/src/pages/guide/index.tsx`)

Built in Vue 3 TSX (`dc()` from `kt-dc`) with full Arabic (RTL) and English (LTR) support.

### 10.1 Interactive Capabilities
1. **Command-Palette Search (`Ctrl+K` / `Cmd+K` from any screen):**
   - Instant fuzzy search over articles, glossary terms, canonical error codes (`RETRYABLE_OTP`, `LIMIT_EXCEEDED`, `AMBIGUOUS`), GL account types, and the 140 edge cases.
2. **Contextual Slide-Over Help Drawer (`ContextualHelpDrawer.tsx`):**
   - Every complex screen in `admin-front` (such as each of the 8 steps of the Add-a-Gateway Wizard, the Maker-Checker JSON-Patch diff viewer, the AML Case disposition screen, and the Statement Parser mapper) includes a `"How this page works (?)"` trigger that opens the exact guide chapter in a non-blocking right drawer without losing form state.
3. **Three Interactive Embedded Simulators Inside the Admin Guide:**
   - **Widget A — Transform Pipeline & Selector Sandbox:** Paste sample JSON/XML, chain operations from `TransformPipe[]` (e.g., `scale(1000) |> to_int |> to_string`), and watch the step-by-step output.
   - **Widget B — Cryptographic Signature Lab:** Test `SORTED_KEY_VALUE_AMP` (Moamalat Hex key), `TIMESTAMP_DOT_RAW_BODY` (DPay), and `SORTED_VALUES_HASH` (Plutu) interactively to see the exact canonical string before hashing.
   - **Widget C — Interactive T-Account Ledger Explorer:** Pick any of the 15 business events (e.g., *Platform-Held T+N Confirm with Fee Accrual*, *AML Hold & Release*, *Chargeback Escrowed & Lost*, *NeomPay Internal Confirm*) and enter a custom LYD amount + commission % to watch the balanced Debits and Credits animate across the GL accounts and verify the system-wide invariant formula.

### 10.2 Admin Guide Content Structure (10 Comprehensive Books)
- **Book 1:** System Architecture & the 7-Service Zero-Trust Security Model (`core-back` vs. edge tiers).
- **Book 2:** The Four-Layer Catalog (`Gateway` -> `CredentialSet` -> `Rail` -> `RailRoute`) & the Visible Rails Formula.
- **Book 3:** Step-by-Step Guide to the 8-Step "Add-a-Gateway" Wizard & Smart AI Spec Importer.
- **Book 4:** Collection Modes (Axis A) & Confirmation Channels (Axis B) — Why Browser Callbacks and Return URLs Are Never Trusted.
- **Book 5:** The 13-State Attempt Lifecycle, Slot Reservation (`active_locked_count`), and Resolving `UNKNOWN` Cases (`RB-01` to `RB-05`).
- **Book 6:** Ownership-Aware Double-Entry Accounting, Clearing Accounts, Fee Bearers (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`), and Statement Reconciliation.
- **Book 7:** Merchant Onboarding, KYB Document Verification, Duplicate Detection & the Four-Eyes Policy.
- **Book 8:** The 7-Layer AML & Compliance Program, Screening Dispositions, No-Tipping-Off Rules & CBL Reporting (`PROVISIONAL` vs. `CONFIRMED`).
- **Book 9:** Disputes, Automated Chargeback Drafting (`SYSTEM_AUTOMATION`), Refunds & `negative_balance_ceiling` Recovery.
- **Book 10:** Complete Searchable Reference of the 140 Edge Cases & 12 Go-Live Gates.

---

## 11. System 2: Admin Portal A-to-Z Employee Academy & Certification LMS (`admin-front/src/pages/academy/index.tsx`)

When a fresh employee joins (as an `OPERATOR`, `COMPLIANCE` analyst, `FINANCE` officer, `SUPPORT` agent, or `GATEWAY_ADMIN`), they open **Employee Academy (`/academy`)** to learn the entire platform from A to Z through guided interactive lessons, simulated tasks, and role-based certification tracks.

### 11.1 Database Persistence for Employee Training Progress
To let management track whether new staff have completed their required onboarding before granting them `is_maker` / `is_checker` production authorities, add a lightweight JSON column or table in `core-back`:
- `users.academy_progress_json JSON` (stores completed module IDs, quiz scores, completed sandbox labs, and earned role badges: `CERTIFIED_OPERATOR`, `CERTIFIED_COMPLIANCE`, `CERTIFIED_FINANCE`, `CERTIFIED_GATEWAY_ARCHITECT`).

### 11.2 The 8-Module A-to-Z Curriculum & Interactive Sandbox Labs

| Module | Title & A-to-Z Curriculum Scope | Interactive Simulation / Lab Inside `admin-front` |
| :--- | :--- | :--- |
| **Module 1 (A–C)** | **How Money & Links Flow Through the Platform:** Actors, Interfaces, Merchants, Applications, Wallets, Payment Links, and why Checkout never trusts the browser. | **Interactive Flow Tracer:** Step through an end-to-end payment from link creation to ledger posting and identify where a tampered `return_url` is caught. |
| **Module 2 (D–F)** | **The Four-Eyes (Maker-Checker) Governance Rule:** Why `maker != checker`, descriptive vs. sensitive fields, JSON-Patch diffs, and emergency suspension ratification. | **Simulated Approval Lab:** Review 3 mock `approval_requests` (one legitimate bank change, one self-approval attempt, one stale `base_version`) and make the right Checker decision. |
| **Module 3 (G–I)** | **Merchant Onboarding & KYB Review:** Reviewing commercial registries, beneficial owners (25% rule), duplicate document SHA-256 flags, and `INFO_REQUESTED` SLA pausing. | **Mock KYB Desk:** Inspect a simulated merchant application where a KYB document hash matches another merchant (Edge Case 120) and escalate properly. |
| **Module 4 (J–L)** | **Double-Entry Ledger, Fee Bearers & Cash-Outs:** Understanding `TREASURY`, `GATEWAY_CLEARING`, `GATEWAY_FEE_ACCRUAL`, `MERCHANT_WALLET`, `COMMISSION_RECEIVABLE`, and the invariant equation. | **Ledger Balancing Lab:** Calculate the exact Journal Lines for a 100 LYD payment with `PAYER_SURCHARGE` (3%) and a 0.80 LYD accrued gateway fee, then reconcile the T+1 bank sweep. |
| **Module 5 (M–P)** | **The Universal Rail Engine & 8-Step Gateway Wizard:** Gateways, Credential Sets, Rails, Routes, the 10 Flow Phases, `TransformPipe[]`, and `CryptoProfile` signing. | **Build-a-Rail Lab:** Configure a simulated 2-step OTP rail (Edfali/Sadad style) + use the Smart AI Importer to verify `test_vectors`. |
| **Module 6 (Q–S)** | **Handling `UNKNOWN` Payments, Outages & Reconciliation:** Why `MOVES_MONEY` steps never auto-retry, using `inquire()`, reading `attempt_step_logs`, and running Runbooks `RB-01` to `RB-05`. | **Incident Simulator:** A simulated switch timeout leaves 3 attempts in `UNKNOWN` and 1 webhook conflict (`P1 CONFLICT`). Resolve each case safely without double-crediting. |
| **Module 7 (T–V)** | **AML Screening, Velocity Rules & No-Tipping-Off:** Sanctions/PEP dispositions, correlated `FLAG` + AML escalation to `CRITICAL`, `AML_HOLD` release vs. void, and confidentiality rules. | **Compliance Lab:** Disposition a false-positive Arabic name match vs. a true PEP hit, and verify why `SUPPORT` cannot view `AML-CONFIDENTIAL` reasons. |
| **Module 8 (W–Z)** | **Disputes, Chargebacks, Refunds & Go-Live Gates:** Automated dispute drafting (`SYSTEM_AUTOMATION`), evidence deadlines, `WON`/`LOST` entries, `negative_balance_ceiling`, and the 12 Go-Live Gates. | **Final Graduation Assessment:** 20-question comprehensive exam across all modules to earn the role certification badge. |

---

## 12. System 3: Merchant Dashboard Interactive Searchable User & Developer Guide (`merchant-front/src/pages/guide/index.tsx`)

Built into `merchant-front` (`ar` RTL / `en` LTR) so merchants, store managers, cashiers, and merchant developers have a self-service knowledge base and interactive tools:

### 12.1 Core Features & Interactive Widgets
1. **Instant Search & Role Filter:** Filter articles by **Business Owner (`MERCHANT_ADMIN`)**, **Store Staff (`MERCHANT_STAFF`)**, **POS Cashier (`MERCHANT_CASHIER`)**, or **Developer (`API Integration`)**.
2. **Interactive "First 5 Steps" Onboarding Checklist Banner:** Guides newly approved merchants through: *(1) Create Wallet -> (2) Create Application & Link Wallet -> (3) Configure Commission/Fee Bearer Preview -> (4) Create First Payment Link -> (5) Pair a POS Screen or Generate API Token*.
3. **Interactive Fee & Net Settlement Calculator:** Merchants type an amount (e.g., `250.000 LYD`), select a rail, and toggle between `MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, and `SPLIT` to see exactly what the customer pays, the platform commission, and the exact net LYD credited to their wallet.
4. **Interactive Developer API & Webhook Sandbox (`/guide/developers`):**
   - Visualizes how to call `POST /api/v1/external/links` and `GET /api/v1/external/payments/:reference` using `pg_live_` bearer tokens.
   - Generates copy-pasteable code snippets in **JavaScript/TypeScript**, **PHP (Laravel)**, **Python**, and **cURL** pre-filled with the merchant's selected `applicationId`.

### 12.2 Merchant Guide Content Chapters
1. **Completing Your KYB Onboarding & Beneficial Owner Declarations.**
2. **Understanding Wallets, Applications & Why Each Application Connects to One Wallet.**
3. **Creating Single-Use vs. Multi-Use Payment Links & Using Safe Redirect URLs.**
4. **Setting Up In-Store POS Terminals & Pairing Realtime Cashier/Customer Screens (15-Minute Idle Rule).**
5. **How Fee Bearers Work (`MERCHANT_ABSORBS` vs. `PAYER_SURCHARGE` vs. `SPLIT`).**
6. **Reading Your Real-Time Wallet Balance, Monthly Hash-Verified Statements & Requesting Cash-Outs.**
7. **Responding to Customer Disputes & Uploading Evidence Before the Deadline.**
8. **Using Your Own Gateway Credentials (`MERCHANT_DIRECT`) & How Commission Receivable Netting Works.**
9. **Managing Team Members, Application Scopes & Security (`MFA` & IP Whitelists).**

---

## 13. System 4: Checkout Dynamic Help Center, Per-Rail Step-by-Step Guides & Admin-Configured Contact Support (`checkout-front`)

When an end-customer opens a payment link (`https://pay.<domain>/pay/:linkKey`), confusion about how a specific Libyan rail works (e.g., *"Where do I get my 7-digit MobiCash transaction card number?"*, *"Why does Sadad ask for my birth year?"*, or *"Which app scans a OnePay / LYPay QR code?"*) is the #1 cause of cart abandonment.

### 13.1 Admin-Configurable Checkout Help & Support Settings (`platform_settings` + `rails` + `merchants`)
1. **Platform-Wide Checkout Support Configuration (Managed in `admin-front` -> stored in `platform_settings` under key `checkout.support_config`):**
   ```json
   {
     "enabled": true,
     "show_platform_contact": true,
     "show_merchant_contact": true,
     "support_phone": "+218-91-XXXXXXX",
     "support_whatsapp": "+21891XXXXXXX",
     "support_email": "support@yourdomain.ly",
     "working_hours_ar": "السبت - الخميس: 9:00 صباحاً - 6:00 مساءً",
     "working_hours_en": "Sat - Thu: 09:00 AM - 06:00 PM (Tripoli Time)",
     "faq_items": [
       {
         "q_ar": "تم خصم المبلغ من حسابي ولكن الصفحة لا تزال قيد التأكيد، ماذا أفعل؟",
         "a_ar": "لا تقم بإعادة الدفع. يحتفظ النظام برقم العملية المرجعي ويتحقق تلقائياً من المصرف أو المحفظة...",
         "q_en": "Money was deducted from my account but the page still says Confirming. What should I do?",
         "a_en": "Do not pay again. Our system holds your payment reference and automatically verifies the status..."
       }
     ]
   }
   ```
2. **Per-Rail Structured Help & Troubleshooting (`rails.help_guide_json` or `rails.instructions_ar` / `instructions_en`):**
   - Every rail in the catalog carries bilingual step-by-step instructions, prerequisite checklists (e.g., *"Must be subscribed to Almadar Sadad service"*), input field hints, and rail-specific FAQs.
3. **Public Exposure via `checkout-back` (`GET /api/v1/pay/:linkKey`):**
   - When `checkout-front` loads a link, `core-back` includes:
     - `supportConfig` (only if `checkout.support_config.enabled == true`, plus the merchant's public `contact_phone` / `contact_email` if `show_merchant_contact == true`),
     - Each visible rail's `helpGuide` (`steps_ar`, `steps_en`, `prerequisites_ar`, `prerequisites_en`, `troubleshooting_ar`, `troubleshooting_en`).

### 13.2 What the Payer Sees in `checkout-front` (`CheckoutHelpDrawer.tsx`)
1. **Contextual "How to Pay with [Selected Rail]" Pill on the Checkout Card:**
   - As soon as the payer clicks a rail (e.g., **Sadad**, **Edfali**, **Moamalat Card**, **LYPay QR**, **MobiCash**, **Yussor Pay**, **NeomPay**), a clean expandable banner and `? Help` button show the exact 3–4 visual steps for that specific rail:
     - *Example for **Sadad**:* (1) Enter your `091xxxxxxx` Almadar number and your 4-digit Birth Year -> (2) Receive the 6-digit SMS code from Sadad -> (3) Enter the code within 10 minutes to confirm.
     - *Example for **Moamalat Card**:* (1) Click "Pay Now" to open the secure National Switch Lightbox -> (2) Enter your local debit card number, expiry date, and PIN -> (3) Wait for automatic confirmation.
     - *Example for **MobiCash / Yussor Pay / Sahara Pay**:* Explains where to find the 7-digit transaction card number or how to scan the QR code inside the Masarat / MobiMal app.
     - *Example for **OnePay / LYPay**:* Lists the supported Libyan bank apps that can scan the interoperable EMVCo QR code.
2. **Interactive Troubleshooting & Reference Copy Helper:**
   - If an attempt enters `VERIFYING`, `UNKNOWN`, or fails with `LIMIT_EXCEEDED` / `RETRYABLE_OTP`, the Help Drawer automatically highlights the exact explanation for that state and provides a **1-Click "Copy Payment Reference (`ref`)"** button so the customer can share it with support if needed.
3. **"Contact Support" Section (Rendered Conditionally When Configured by Admin):**
   - If `supportConfig.enabled == true`, the bottom of the Checkout Help Center (and footer) renders direct action buttons:
     - **WhatsApp Support** (pre-filled with `Hello, I need help with payment link ${linkKey} / reference ${attemptRef}`),
     - **Call Support** (`tel:...`),
     - **Email Support** (`mailto:...`),
     - **Merchant Store Contact** (if enabled for that merchant),
     - **Support Working Hours** badge (`ar` / `en`).
   - If the admin disables `checkout.support_config.enabled` in `admin-front`, the Contact Us section cleanly hides itself across all checkout pages immediately.

---

# PART III: OPENCODE AI IMPLEMENTATION CHECKLIST

You can hand this file directly to **OpenCode** to implement both the Multi-Host Deployment Orchestrator and the 4 Portal Guide Systems in [`payment-gateway-monolith`](https://github.com/selmotamed-ctrl/payment-gateway-monolith):

### Phase A: Multi-Host Deployment Engine (`deploy/`)
- [x] **`PG-D1` Build Multi-Host Zod Config & Host Planner:** Implement `deploy/lib/configSchema.ts` and `deploy/lib/hostPlanner.ts` supporting `1..N` compute tiers (`CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`) plus storage nodes (`PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, PgBouncer, `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE`, `BACKUP_NODE`) and `deploy/deploy.env.example`.
- [x] **`PG-D2` Build Automated mTLS PKI Generator & Distributor:** Implement `deploy/lib/pkiManager.ts` generating `internal-ca.crt` and SAN-bound `core-back.crt` (`IP:${CORE_PRIVATE_IP}`) + `admin-back`, `merchant-back`, and `checkout-back` client certs, distributing only the required keys to each host.
- [x] **`PG-D3` Build SSH/`stdin`-Sudo Runner, UFW Configurator & Atomic Deployer:** Implement `deploy/lib/sshRunner.ts`, `deploy/lib/firewallConfigurator.ts`, `deploy/lib/healthVerifier.ts`, `deploy/deploy.ts`, and `deploy/deploy.sh`.
- [x] **`PG-D4` Create PM2 & Nginx Templates + `DEPLOYMENT_GUIDE.md`:** Implement `pm2.core.config.cjs.tpl`, `pm2.edge.config.cjs.tpl`, `nginx.admin.lan.conf.tpl`, `nginx.merchant.ssl.conf.tpl`, `nginx.checkout.ssl.conf.tpl`, and `deploy/DEPLOYMENT_GUIDE.md`.

### Phase B: Four Built-In Interactive Portal Guides & Employee Academy
- [x] **`PG-G1` Backend Support Config & Academy Progress Endpoints (`core-back`, `admin-back`, `checkout-back`):**
  - Add `academy_progress_json` to `users` (or `platform_settings` for `checkout.support_config`) and seed comprehensive bilingual (`ar`/`en`) per-rail help guides (`steps`, `prerequisites`, `troubleshooting`) for all 20 gateways/rails.
  - Expose `GET/PUT /api/v1/admin/settings/checkout-support`, `GET/PUT /api/v1/admin/academy/progress`, and include `supportConfig` + per-rail `helpGuide` in `GET /api/v1/pay/:linkKey`.
- [x] **`PG-G2` System 1 — Admin Interactive Searchable Guide (`admin-front`):**
  - Build `admin-front/src/pages/guide/index.tsx`, `Ctrl+K` global search modal, `ContextualHelpDrawer.tsx`, `TransformPlayground.tsx`, `CryptoSignatureLab.tsx`, and `LedgerTAccountVisualizer.tsx` in Vue 3 TSX (`kt-dc`).
- [x] **`PG-G3` System 2 — Admin A-to-Z Employee Academy (`admin-front`):**
  - Build `admin-front/src/pages/academy/index.tsx` with the 8 interactive modules (A-to-Z curriculum), hands-on simulation labs (Approval Lab, KYB Desk, Ledger Balancing Lab, Build-a-Rail Lab, `UNKNOWN` Incident Simulator, Compliance Lab), quizzes, and role certification badges.
- [x] **`PG-G4` System 3 — Merchant Interactive User & Developer Guide (`merchant-front`):**
  - Build `merchant-front/src/pages/guide/index.tsx` with role filters, Onboarding Checklist Coachmarks, Interactive Fee Bearer Calculator (`decimal.js`), and the multi-language API/Webhook code snippet generator.
- [x] **`PG-G5` System 4 — Checkout Help Center, Per-Rail Guides & Contact Support (`checkout-front` & `admin-front`):**
  - Build `checkout-front/src/components/help/CheckoutHelpDrawer.tsx` and `PerRailInstructionsBanner.tsx` showing dynamic step-by-step instructions for the selected rail, state-aware troubleshooting with 1-click reference copy, and the Admin-configured Contact Us channels (WhatsApp, Phone, Email, Hours), plus the Admin configuration screen in `admin-front/src/pages/settings/checkout-help/index.tsx`.
