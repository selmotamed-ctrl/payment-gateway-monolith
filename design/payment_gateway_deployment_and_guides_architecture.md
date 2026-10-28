# MULTI-RAIL PAYMENT GATEWAY PLATFORM — MULTI-HOST AUTOMATED DEPLOYMENT ENGINE & 4-PORTAL INTERACTIVE GUIDES ARCHITECTURE

**Subtitle:** Topology-Aware Multi-Server Deployment Orchestrator (`1-to-5 Host Matrix`, Automated mTLS 1.3 PKI Generation & Distribution, Per-Host UFW Zero-Trust Firewalling, Atomic Symlink Releases, PM2 + Bun, Multi-Vhost Nginx Generator) and Built-In Interactive User Guides, Employee Academy & Dynamic Checkout Help Center across `admin-front`, `merchant-front`, and `checkout-front`.

**Target Repository:** [`selmotamed-ctrl/payment-gateway-monolith`](https://github.com/selmotamed-ctrl/payment-gateway-monolith) (`core-back`, `admin-back`, `admin-front`, `merchant-back`, `merchant-front`, `checkout-back`, `checkout-front`, `design`)

## Contents

- **PART I: MULTI-SERVER ZERO-TRUST DEPLOYMENT ENGINE ARCHITECTURE**
  - 1. Flexible 1-to-5 Host Topology Model (Same-Server vs. Fully Distributed)
  - 2. Complete `deploy/` Directory Structure
  - 3. Multi-Host Configuration Architecture: `deploy.env` & Zod 4 Validator
  - 4. Automated mTLS 1.3 PKI Generation, SAN Binding & Least-Privilege Distribution
  - 5. Host-Aware UFW Firewall & Network Isolation Provisioning
  - 6. Ordered 12-Step Multi-Host Deployment Pipeline (Database -> Core -> Edge Nodes)
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

## 1. Flexible 1-to-5 Host Topology Model (Same-Server vs. Fully Distributed)

Unlike a single-server app, the Payment Gateway Platform consists of **4 backend services**, **3 frontend SPAs**, and **1 database server**, where any service may live on its own dedicated physical/virtual server or share a host with others:

- **Node Role 1 (`DB_HOST`):** Runs PostgreSQL / MariaDB. Accepts connections **strictly** from `CORE_HOST_PRIVATE_IP` (never from `admin-back`, `merchant-back`, `checkout-back`, or the public internet).
- **Node Role 2 (`CORE_HOST`):** Runs `core-back` on port `4000` (mTLS 1.3 Server). Has the **only** Prisma client, database credentials, and `KMS_MASTER_KEY`. Accepts connections **strictly** from the private LAN IPs of `ADMIN_HOST`, `MERCHANT_HOST`, and `CHECKOUT_HOST`.
- **Node Role 3 (`ADMIN_HOST`):** Runs `admin-back` (`:4101`) + serves `admin-front` static build via LAN-only Nginx (`:8443` SSL on private LAN interface, never router-forwarded). Connects to `CORE_HOST:4000` using `admin-back-client.crt` (`CN=admin-back`).
- **Node Role 4 (`MERCHANT_HOST`):** Runs `merchant-back` (`:4102`) + serves `merchant-front` static build via Public SSL Nginx (`80 -> 443`). Connects to `CORE_HOST:4000` using `merchant-back-client.crt` (`CN=merchant-back`).
- **Node Role 5 (`CHECKOUT_HOST`):** Runs `checkout-back` (`:4103`) + serves `checkout-front` static build via Public SSL Nginx (`80 -> 443`). Connects to `CORE_HOST:4000` using `checkout-back-client.crt` (`CN=checkout-back`).

### Smart Host Deduplication in `deploy/deploy.ts`
The deployment orchestrator groups the 5 logical roles by `(SSH_HOST, SSH_PORT)`:
- **Scenario A (5 Separate Servers):** Every role has a distinct IP in `deploy.env`. The script bootstraps each server with **only** the packages, certificates, PM2 apps, and Nginx vhosts required for its specific role.
- **Scenario B (2 Servers — e.g., Internal Core/Admin/DB Server + Public Edge Server for Merchant/Checkout):** The script detects that `MERCHANT_HOST` and `CHECKOUT_HOST` share an IP, runs OS bootstrap once on that host, deploys both `merchant-back` and `checkout-back` into PM2, and configures both Nginx public virtual hosts (`merchant.<domain>` and `pay.<domain>`).
- **Scenario C (Single All-in-One Staging/Compact Server):** All 5 roles point to the same IP (`127.0.0.1` private communication), while still enforcing mTLS client certificates and separate ports (`4000`, `4101`, `4102`, `4103`, `8443`, `443`).

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
    │   ├── configSchema.ts             # Zod 4 validator for all 5 host roles & app vars
    │   ├── hostPlanner.ts              # Deduplicates hosts by IP & plans per-host actions
    │   ├── pkiManager.ts               # Generates/rotates Internal CA + SAN-bound mTLS certs
    │   ├── sshRunner.ts                # Multi-host SSH, stdin-sudo (`sudo -S`), and rsync engine
    │   ├── firewallConfigurator.ts     # Configures strict UFW rules per host role
    │   └── healthVerifier.ts           # End-to-end mTLS + HTTP health probes & auto-rollback
    └── templates/
        ├── pm2.core.config.cjs.tpl
        ├── pm2.edge.config.cjs.tpl
        ├── nginx.admin.lan.conf.tpl    # LAN-only port 8443 SSL config (`allow <LAN_CIDR>; deny all;`)
        ├── nginx.merchant.ssl.conf.tpl # Public 80->443 SSL config for merchant portal & POS stream
        └── nginx.checkout.ssl.conf.tpl # Public 80->443 SSL config for checkout & SSE stream
```

---

## 3. Multi-Host Configuration Architecture: `deploy.env` & Zod 4 Validator

### 3.1 Complete `deploy/deploy.env.example`

```ini
# ==============================================================================
# MULTI-RAIL PAYMENT GATEWAY — MULTI-HOST DEPLOYMENT CONFIGURATION (deploy.env)
# ==============================================================================
# Supports 1 to 5 servers. If two roles share the same server, give them the same
# SSH_HOST, SSH_USER, SSH_KEY_PATH, and SUDO_PASSWORD; the orchestrator will
# automatically deduplicate OS provisioning and merge PM2/Nginx configurations.

# --- 0. GLOBAL DEPLOYMENT OPTIONS ---------------------------------------------
DEPLOY_MODE="auto"                  # "auto" | "fresh" | "update"
KEEP_RELEASES="5"                   # Number of atomic releases kept per host for rollback
ROTATE_MTLS_CERTS="false"           # Set "true" to force regeneration of mTLS client/server certs
MTLS_VALIDITY_DAYS="825"            # Validity period for generated internal mTLS certificates
LAN_ALLOWED_CIDRS="10.0.0.0/8,192.168.0.0/16" # Allowed LAN subnets for admin-front/admin-back

# --- 1. DATABASE SERVER (DB_HOST) ---------------------------------------------
# Set DB_MANAGE_VIA_SSH="true" if the script should SSH into DB_HOST to create
# the DB/user and lock firewall rules to CORE_PRIVATE_IP only.
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_PORT="22"
DB_SSH_USER="ubuntu"
DB_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_db"
DB_SUDO_PASSWORD="db-sudo-password"
DB_PRIVATE_IP="10.10.0.10"
DB_ENGINE="postgresql"              # "postgresql" | "mysql"
DB_PORT="5432"
DB_NAME="payment_gateway_prod"
DB_USER="pg_core_user"
DB_PASSWORD="ultra-strong-db-password"
DATABASE_URL="postgresql://pg_core_user:ultra-strong-db-password@10.10.0.10:5432/payment_gateway_prod?schema=public"

# --- 2. CORE-BACK SERVER (CORE_HOST — Private LAN Only, Sole DB Owner) --------
CORE_SSH_HOST="10.10.0.20"
CORE_SSH_PORT="22"
CORE_SSH_USER="ubuntu"
CORE_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_core"
CORE_SUDO_PASSWORD="core-sudo-password"
CORE_PRIVATE_IP="10.10.0.20"        # IP bound by core-back mTLS server & included in core-back.crt SAN
CORE_PORT="4000"
CORE_REMOTE_DIR="/var/www/pg-core"
RUN_PRISMA_SEED="false"             # Set "true" on initial deploy to seed GL accounts, roles & 7 blueprints

# --- 3. ADMIN SERVER (ADMIN_HOST — Private LAN Only, Non-Forwarded Port) ------
ADMIN_SSH_HOST="10.10.0.30"
ADMIN_SSH_PORT="22"
ADMIN_SSH_USER="ubuntu"
ADMIN_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_admin"
ADMIN_SUDO_PASSWORD="admin-sudo-password"
ADMIN_PRIVATE_IP="10.10.0.30"       # Allowed by UFW on CORE_HOST:4000
ADMIN_BACK_PORT="4101"
ADMIN_NGINX_LAN_PORT="8443"         # Served over HTTPS on LAN only (not router-forwarded)
ADMIN_DOMAIN="admin.internal"
ADMIN_REMOTE_DIR="/var/www/pg-admin"

# --- 4. MERCHANT SERVER (MERCHANT_HOST — Public SSL 80/443) -------------------
MERCHANT_SSH_HOST="203.0.113.10"
MERCHANT_SSH_PORT="22"
MERCHANT_SSH_USER="ubuntu"
MERCHANT_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_merchant"
MERCHANT_SUDO_PASSWORD="merchant-sudo-password"
MERCHANT_PRIVATE_IP="10.10.0.40"    # Private LAN IP used to reach CORE_PRIVATE_IP:4000 over mTLS
MERCHANT_BACK_PORT="4102"
MERCHANT_DOMAIN="merchant.yourdomain.ly"
MERCHANT_SSL_MODE="certbot"         # "certbot" | "custom" | "self_signed"
MERCHANT_SSL_CERT_PATH="/etc/letsencrypt/live/merchant.yourdomain.ly/fullchain.pem"
MERCHANT_SSL_KEY_PATH="/etc/letsencrypt/live/merchant.yourdomain.ly/privkey.pem"
MERCHANT_REMOTE_DIR="/var/www/pg-merchant"

# --- 5. CHECKOUT SERVER (CHECKOUT_HOST — Public SSL 80/443) -------------------
CHECKOUT_SSH_HOST="203.0.113.20"
CHECKOUT_SSH_PORT="22"
CHECKOUT_SSH_USER="ubuntu"
CHECKOUT_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_checkout"
CHECKOUT_SUDO_PASSWORD="checkout-sudo-password"
CHECKOUT_PRIVATE_IP="10.10.0.50"    # Private LAN IP used to reach CORE_PRIVATE_IP:4000 over mTLS
CHECKOUT_BACK_PORT="4103"
CHECKOUT_DOMAIN="pay.yourdomain.ly"
CHECKOUT_SSL_MODE="certbot"         # "certbot" | "custom" | "self_signed"
CHECKOUT_SSL_CERT_PATH="/etc/letsencrypt/live/pay.yourdomain.ly/fullchain.pem"
CHECKOUT_SSL_KEY_PATH="/etc/letsencrypt/live/pay.yourdomain.ly/privkey.pem"
CHECKOUT_REMOTE_DIR="/var/www/pg-checkout"

# --- 6. CORE-BACK MASTER SECRETS (Delivered ONLY to CORE_HOST, NEVER to Edge) -
KMS_MASTER_KEY_ID="v1"
KMS_MASTER_KEY_HEX="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
JWT_ADMIN_SECRET="64-byte-random-secret-for-admin-jwt"
JWT_MERCHANT_SECRET="64-byte-random-secret-for-merchant-jwt"
BASE_CURRENCY="LYD"
GATEWAY_TIMEZONE="Africa/Tripoli"
REDIS_URL=""                        # Optional Redis URL for multi-node InvalidationBus
```

---

## 4. Automated mTLS 1.3 PKI Generation, SAN Binding & Least-Privilege Distribution

One of the hardest parts of deploying a multi-server mTLS architecture is making sure certificates match the exact private IP addresses of the servers and that private keys never end up on the wrong machine. `deploy/lib/pkiManager.ts` automates this completely:

1. **Local Vault Generation (`deploy/.certs/` — gitignored, `chmod 600`):**
   - On first run (or when `ROTATE_MTLS_CERTS="true"`), `pkiManager.ts` generates an offline **Internal Root CA** (`internal-ca.key` + `internal-ca.crt`) and signs 4 leaf certificates:
     - **`core-back.crt` / `core-back.key`:** Includes Subject Alternative Names (`subjectAltName = IP:${CORE_PRIVATE_IP}, IP:127.0.0.1, DNS:core-back.internal`). Without the dynamic `IP:${CORE_PRIVATE_IP}` SAN, TLS 1.3 hostname verification would fail when edge servers sit on separate machines!
     - **`admin-back-client.crt` / `.key`:** Signed with `CN=admin-back, OU=edge-admin`.
     - **`merchant-back-client.crt` / `.key`:** Signed with `CN=merchant-back, OU=edge-merchant`.
     - **`checkout-back-client.crt` / `.key`:** Signed with `CN=checkout-back, OU=edge-checkout`.
2. **Strict Least-Privilege Key Distribution:**
   - `internal-ca.key` **never leaves your deployment workstation**.
   - `CORE_HOST` receives **only** `internal-ca.crt`, `core-back.crt`, and `core-back.key`.
   - `ADMIN_HOST` receives **only** `internal-ca.crt`, `admin-back-client.crt`, and `admin-back-client.key`.
   - `MERCHANT_HOST` receives **only** `internal-ca.crt`, `merchant-back-client.crt`, and `merchant-back-client.key`.
   - `CHECKOUT_HOST` receives **only** `internal-ca.crt`, `checkout-back-client.crt`, and `checkout-back-client.key`.
   - Even if `CHECKOUT_HOST` were compromised by an attacker on the public internet, it does **not** possess `merchant-back-client.key` or `admin-back-client.key`, nor does it possess `DATABASE_URL` or `KMS_MASTER_KEY`.

---

## 5. Host-Aware UFW Firewall & Network Isolation Provisioning

During Fresh Bootstrap (or `--enforce-firewall`), `deploy/lib/firewallConfigurator.ts` configures UFW on each server according to its assigned role(s):

| Host Role | Inbound Ports Opened by `firewallConfigurator.ts` | Explicitly Blocked |
| :--- | :--- | :--- |
| **`DB_HOST`** | `SSH_PORT`, plus `DB_PORT` (`5432`/`3306`) **ONLY from `CORE_PRIVATE_IP`** (`ufw allow from <CORE_PRIVATE_IP> to any port <DB_PORT> proto tcp`). | All public & edge traffic to DB. |
| **`CORE_HOST`** | `SSH_PORT`, plus `CORE_PORT` (`4000`) **ONLY from `ADMIN_PRIVATE_IP`, `MERCHANT_PRIVATE_IP`, and `CHECKOUT_PRIVATE_IP`**. | All public internet traffic to `:4000`. |
| **`ADMIN_HOST`** | `SSH_PORT`, plus `ADMIN_NGINX_LAN_PORT` (`8443`) **ONLY from `LAN_ALLOWED_CIDRS`** (`10.0.0.0/8`, `192.168.0.0/16`). `ADMIN_BACK_PORT` (`4101`) bound to `127.0.0.1` only. | All non-LAN traffic. |
| **`MERCHANT_HOST`** | `SSH_PORT`, `80/tcp`, `443/tcp`. `MERCHANT_BACK_PORT` (`4102`) bound to `127.0.0.1` only. | Direct external access to `:4102`. |
| **`CHECKOUT_HOST`** | `SSH_PORT`, `80/tcp`, `443/tcp`. `CHECKOUT_BACK_PORT` (`4103`) bound to `127.0.0.1` only. | Direct external access to `:4103`. |

*(If multiple roles share the same physical server, `hostPlanner.ts` unions their UFW rules on that host.)*

---

## 6. Ordered 12-Step Multi-Host Deployment Pipeline

When you run `./deploy/deploy.sh` (or target a single tier via `./deploy/deploy.sh --only=checkout`), the orchestrator executes in strict dependency order so `core-back` and database migrations are always live *before* edge servers switch over:

1. **Step 1 — Validate `deploy.env` & Build Execution Plan:** Validates all variables with Zod 4 and prints the **Host Topology Map** (showing which services map to which physical IPs).
2. **Step 2 — Build All 3 Frontend SPAs Locally (`admin-front`, `merchant-front`, `checkout-front`):** Injects the respective build-time constants and compiles all 3 Vite TSX bundles in parallel on the deployment machine.
3. **Step 3 — Ensure mTLS PKI Certificates:** Generates or verifies `internal-ca.crt` and the 4 leaf certificates in `deploy/.certs/` bound to `CORE_PRIVATE_IP`.
4. **Step 4 — Bootstrap Unique Target Hosts (Fresh Mode):** Connects to every unique host via SSH, pipes `SUDO_PASSWORD` to `sudo -S`, installs `nginx`, `rsync`, `ufw`, `bun`, `pm2`, and applies role-specific UFW rules.
5. **Step 5 — Database Pre-Migration Backup & Provisioning (`DB_HOST` / `CORE_HOST`):** Verifies database connectivity from `CORE_HOST`; if migrations are pending, dumps a compressed pre-migration backup into `CORE_REMOTE_DIR/shared/backups/`.
6. **Step 6 — Deploy `core-back` to `CORE_HOST`:**
   - Rsyncs `core-back/` into `/var/www/pg-core/releases/<TS>/core-back`.
   - Uploads `internal-ca.crt`, `core-back.crt`, and `core-back.key` to `/var/www/pg-core/shared/certs/` (`chmod 600`).
   - Writes `/var/www/pg-core/shared/.env` (containing `DATABASE_URL` and `KMS_MASTER_KEY_HEX`).
   - Runs `bun install --frozen-lockfile`, `bunx prisma generate`, `bun run migrate-deploy`, and optional `seed.ts`.
   - Atomically switches `/var/www/pg-core/current`, reloads PM2 (`pg-core-back`), and verifies the mTLS `/health` probe on `https://${CORE_PRIVATE_IP}:${CORE_PORT}/health`.
7. **Step 7 — Deploy `admin-back` & `admin-front` to `ADMIN_HOST`:**
   - Rsyncs `admin-back/` and `admin-front/dist/` to `/var/www/pg-admin/releases/<TS>/`.
   - Uploads **only** `internal-ca.crt` and `admin-back-client.{crt,key}`.
   - Writes `shared/.env` (`CORE_BACK_URL=https://${CORE_PRIVATE_IP}:${CORE_PORT}`, zero DB vars), installs dependencies, switches `current` symlink, and reloads PM2 (`pg-admin-back`).
   - Renders LAN-only Nginx config (`:8443`), verifies `sudo nginx -t`, and reloads Nginx.
8. **Step 8 — Deploy `merchant-back` & `merchant-front` to `MERCHANT_HOST`:**
   - Rsyncs `merchant-back/` and `merchant-front/dist/` to `/var/www/pg-merchant/releases/<TS>/`.
   - Uploads **only** `internal-ca.crt` and `merchant-back-client.{crt,key}`.
   - Writes `shared/.env`, installs dependencies, switches `current` symlink, reloads PM2 (`pg-merchant-back`), and updates/reloads Nginx (`merchant.<domain>` on `80/443` with SSE/WebSocket unbuffered proxy for POS rooms).
9. **Step 9 — Deploy `checkout-back` & `checkout-front` to `CHECKOUT_HOST`:**
   - Rsyncs `checkout-back/` and `checkout-front/dist/` to `/var/www/pg-checkout/releases/<TS>/`.
   - Uploads **only** `internal-ca.crt` and `checkout-back-client.{crt,key}`.
   - Writes `shared/.env`, installs dependencies, switches `current` symlink, reloads PM2 (`pg-checkout-back`), and updates/reloads Nginx (`pay.<domain>` on `80/443` with strict CSP headers and unbuffered SSE proxy).
10. **Step 10 — End-to-End Cross-Host mTLS & Health Verification:**
    - Verifies that `ADMIN_HOST`, `MERCHANT_HOST`, and `CHECKOUT_HOST` can each complete a mutually authenticated TLS 1.3 handshake to `CORE_HOST:4000` on their permitted channel and receive `{ "msg": "OK" }`.
    - If any tier fails health verification, automatically triggers **Multi-Host Rollback** to the previous release timestamp across all affected hosts.
11. **Step 11 — Prune Old Releases:** Keeps the most recent `KEEP_RELEASES` (default 5) on each server.
12. **Step 12 — Emit Deployment Audit Summary:** Prints deployed commit SHA, release timestamp, host statuses, and active certificate expiry dates.

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
- [x] **`PG-D1` Build Multi-Host Zod Config & Host Planner:** Implement `deploy/lib/configSchema.ts` and `deploy/lib/hostPlanner.ts` supporting 1-to-5 servers (`DB_HOST`, `CORE_HOST`, `ADMIN_HOST`, `MERCHANT_HOST`, `CHECKOUT_HOST`) and `deploy/deploy.env.example`.
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
