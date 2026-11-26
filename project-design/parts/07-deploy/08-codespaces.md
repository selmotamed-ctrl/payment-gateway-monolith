---
id: deploy.codespaces
title: GitHub Codespaces and One-Command Local Launcher
status: partial
confidence: medium
last_verified: 2026-11-26
verified_against: efb90c8+working-tree
code:
  - .devcontainer/devcontainer.json
  - .devcontainer/docker-compose.yml
  - .devcontainer/Dockerfile
  - .devcontainer/post-create.sh
  - .gitattributes
  - scripts/codespaces-start.sh
  - scripts/codespaces-smoke.ts
  - scripts/deploy-localhost.sh
  - core-back/prisma/seedFakeRails.ts
  - core-back/scripts/create-dev-users.ts
  - fake-rails-front/vite.config.ts
  - .github/workflows/ci.yml
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md
tests:
  - scripts/codespaces-smoke.ts
  - core-back/test/engine/multipart-and-content-type.test.ts
  - .github/workflows/ci.yml
gaps:
  - The dev container itself (image build, compose services, port forwarding) has only been statically validated in CI; it was not exercised inside a real Codespace by the authors of this part (TRACKER GAP-079).
  - Only the OTP-pull rails (Edfali, Sadad) were verified end to end through the launcher; the other seeded rails initiate but do not all settle against Fake Rails (see TRACKER GAP-080).
  - The launcher supervises plain background processes; it is not a production process manager and does not restart a crashed service.
---

# GitHub Codespaces and One-Command Local Launcher

## 1. Purpose and scope

This part documents the **development / demonstration** environment that lets a contributor open the repository in GitHub Codespaces (or any Linux/macOS/WSL host that already has PostgreSQL 18, Bun, Node and OpenSSL) and start a working stack with **one command**:

```bash
./scripts/codespaces-start.sh            # default profile: merchant-demo
```

It is **not** a deployment path. Nothing is published outside the machine; production and multi-host deployment remain the job of `deploy/` (see `deploy.topology`, `deploy.pipeline`). `scripts/deploy-localhost.sh` (PM2, Arch Linux workstation) is unchanged in purpose; the launcher exists because Codespaces has no PM2 and no systemd/sudo, uses containers for PostgreSQL and Redis, and reaches every portal through *forwarded* URLs instead of loopback.

## 2. Design intent

- **One clear command.** Idempotent: a second run reuses the database, secrets, certificates and portal builds and only starts what is not running.
- **Nothing destructive by default.** The launcher never resets a database. Seeds are individually guarded (baseline seed only when `platform_settings` is empty; dev users only when missing; Fake Rails gateway re-pointing only when the forwarded URL or the seeder script changed). The only destructive path is `reset-db --yes-delete-dev-database`, which refuses `*_test` databases.
- **No hard-coded secrets.** `KMS_MASTER_KEY`, `OBJECT_STORAGE_KEK_KEYRING`, the development password, the Fake Rails admin password, JWT secret, seeder token and control token are generated with `openssl rand` into `.local/codespaces/secrets.env` (mode 0600, git-ignored). The development password satisfies the `create-dev-users` policy (12+ characters with lowercase, uppercase and a digit). It is shown only by `./scripts/codespaces-start.sh credentials`.
- **Security posture unchanged.** mTLS (TLS 1.3, one client common name per namespace) stays enforced between edges and cores; the launcher only generates the same local CA/certificates as `bun run generate-mtls-certs`. `core-back`, `core-sandbox`, PostgreSQL and Redis are never forwarded; every service binds to `127.0.0.1`; edges never receive `DATABASE_URL` or `KMS_MASTER_KEY`.

## 3. As-built architecture

### 3.1 Dev container (`.devcontainer/`)

| File | Role |
| :--- | :--- |
| `devcontainer.json` | Compose-based container, Node 22 feature, `hostRequirements` 4 CPU / 8 GB, `forwardPorts` and labels, VS Code extensions, `postCreateCommand`. |
| `docker-compose.yml` | `app` (workspace), `db` (`postgres:18`, named volume `pg18-data` at `/var/lib/postgresql`), `redis` (`redis:7`). `db` and `redis` publish no ports; trust authentication is therefore reachable only from `app` on the private compose network. |
| `Dockerfile` | `devcontainers/base:ubuntu-24.04` + `postgresql-client`, `redis-tools`, `openssl`, `curl`, Bun (pinned `BUN_VERSION`, tested with 1.4.2). |
| `post-create.sh` | Waits for PostgreSQL, creates `payment_gateway_monolith` and `payment_gateway_monolith_test`, installs every workspace with `--frozen-lockfile`, copies the portals' `.env.example`. It starts nothing and seeds nothing. |

The compose environment points the Redis-backed and PostgreSQL-backed test suites at an isolated `payment_gateway_monolith_test` database, never at the development database.

### 3.2 Launcher (`scripts/codespaces-start.sh`)

Commands: `start [core|merchant-demo|full] [--rebuild]`, `stop`, `status`, `urls`, `credentials`, `logs <service>`, `smoke`, `reset-db --yes-delete-dev-database`.

| Profile | Services |
| :--- | :--- |
| `core` | `core-back` |
| `merchant-demo` (default) | `core-back`, `core-sandbox`, `fake-rails-back`, `merchant-back`, `checkout-back`, merchant / checkout / Fake Rails portals |
| `full` | `merchant-demo` + `admin-back` + admin portal |

Start sequence: tool check → secrets → PostgreSQL 18 version gate (`server_version_num >= 180000`) → database(s) → dependencies → mTLS certificates → `prisma generate` + `migrate deploy` → guarded seeds → portal builds → services → health checks (core cores probed over mTLS with Bun, because some curl builds cannot present a PEM client key).

**Ports** (schema defaults): core 4000, sandbox core 4005, admin-back 4101, merchant-back 4102, checkout-back 4103, Fake Rails 4104, portals 5101-5104.

**Portals reach their edge through the Vite preview proxy.** Production builds call a relative `/api`; `vite preview` proxies it to `VITE_API_URL` (`http://127.0.0.1:<edge port>`), so the browser only ever talks to the portal's own forwarded origin: no CORS, no cookies across origins, and edge ports need no forwarding. Vite blocks unknown `Host` headers, so each portal is started with `VITE_MY_TAILSCALE=<its forwarded host>` (the existing allowed-hosts hook); `fake-rails-front` gained the same hook.

**URLs baked at build time.** `VITE_CHECKOUT_BASE_URL` (merchant portal link generator) and `VITE_CHECKOUT_ORIGIN` (Fake Rails portal) depend on the Codespace name, so portals are rebuilt only when that URL set changes (`build.stamp`) or with `--rebuild`.

**Forwarded URL derivation.** `https://${CODESPACE_NAME}-<port>.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`; outside Codespaces `http://127.0.0.1:<port>`.

### 3.3 Why a Sandbox plane

Fake Rails answers with `env: "SANDBOX"` and the engine's trusted-success check requires the response environment to equal the attempt's. Fake Rails payments therefore only settle on **Sandbox-plane** attempts (`sbx_*` links), as designed in `platform.sandbox`. The `merchant-demo` and `full` profiles start a second `core-back` (`EXECUTION_PLANE=SANDBOX`, port 4005) on its own database `<DB_NAME>_sandbox`, migrated with `?options=-c app.execution_plane=SANDBOX` (otherwise v38 stamps the database LIVE), and give the edges `SANDBOX_CORE_BACK_URL`. The Live core runs with `PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE=true` (a development deployment only) and `OBJECT_STORAGE_ORPHAN_SWEEP_ENABLED=false` when both planes share the vault.

### 3.4 Fake Rails wiring specific to this launcher

- Core reaches the emulator at `http://127.0.0.1:4104` (seeded as the gateway base URL, `FAKE_RAILS_PUBLIC_BASE_URL` of the core), while the payer's browser uses the forwarded Fake Rails *portal* origin: `fake-rails-back` is started with `FAKE_RAILS_PUBLIC_BASE_URL=<forwarded 5104>` (hosted redirect pages live in the portal) and `seedFakeRails.ts` accepts `FAKE_RAILS_BROWSER_BASE_URL` for widget SDK script URLs / allowed origins.
- `seedFakeRails.ts` now creates a demo credential manifest (`apiKey`, `token`, `username`, `password`, `secret`, `clientId`, `clientSecret`, plus every crypto profile `secretKeyRef`) on **empty** platform credential sets, values derived from the seeder token. The emulator never checks key values; existing entries are never replaced; mutual-TLS gateways stay unconfigured.
- `FAKE_RAILS_CONTROL_TOKEN` is generated and shared by the sandbox core and `fake-rails-back` (required in production mode by the control plane).
- The dev merchant is created with `DEV_MERCHANT_UNSCOPED=true` so it is not restricted to the single Live application and can use Sandbox Studio.

## 4. Contracts and invariants

- The launcher refuses `NODE_ENV=production` unless `LOCAL_TARGET=1`.
- Every service log is `.local/codespaces/logs/<service>.log`; pids in `.local/codespaces/pids`.
- Changing the key material after seeding is refused: if encrypted data exists but no KMS key is found in the secrets file the launcher stops and explains how to restore it or reset.
- `.gitattributes` forces LF for `*.sh`, `.devcontainer/**` and `project-design/**` so a Windows checkout with `core.autocrlf=true` does not break the scripts or the design generator.

## 5. Data / API / config / deployment surface

| Variable | Used by | Meaning |
| :--- | :--- | :--- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | launcher | PostgreSQL connection (compose sets `db:5432`, trust auth, `payment_gateway_monolith`). |
| `SANDBOX_DB_NAME` | launcher | Sandbox plane database (default `<DB_NAME>_sandbox`). |
| `CODESPACES_SECRETS_FILE` | launcher | Override of `.local/codespaces/secrets.env`. |
| `REDIS_URL` | core | Optional cache/velocity store (compose sets `redis://redis:6379`). |
| `FAKE_RAILS_BROWSER_BASE_URL` | `seedFakeRails.ts` | Browser-reachable origin for SDK script URLs; defaults to `FAKE_RAILS_PUBLIC_BASE_URL`. |
| `DEV_MERCHANT_UNSCOPED` | `create-dev-users` | `true` leaves the dev merchant unrestricted (all applications). |

Forwarded ports (private by default): 5102 merchant portal, 5103 checkout, 5104 Fake Rails portal, 4102 merchant API (`pg_live_` / `pg_test_` tokens), 5101 admin portal (`full` only). Port visibility cannot be set from `devcontainer.json`; make a port public only from the Ports tab, and only the one you intend to demonstrate.

## 6. Operational usage

```bash
./scripts/codespaces-start.sh               # start
./scripts/codespaces-start.sh smoke         # 17 real HTTP checks incl. a simulated payment and mTLS enforcement
./scripts/codespaces-start.sh credentials   # development logins
./scripts/codespaces-start.sh stop
```

Codespaces stop after inactivity: processes die, the PostgreSQL volume and `.local/` survive; run the start command again. Deleting the Codespace deletes both.

CI (`codespaces` job) validates the shell syntax, parses `devcontainer.json`, validates the compose file, boots the `core` profile against a PostgreSQL 18 service container, proves `core-back` rejects a client without a certificate, and runs the start command a second time to prove idempotence.

## 7. Status and deviations

### Implemented

- Dev container, launcher with three profiles, Sandbox plane wiring, guarded seeds, generated secrets, mTLS probes, smoke test, CI job.
- Verified locally (Windows host, WSL PostgreSQL 18.6, Bun 1.4.2): fresh first start of `merchant-demo`, idempotent restart, the 17-check smoke test, an Edfali and a Sadad OTP payment settling `SUCCEEDED`.

### Partial

- Not exercised inside a real Codespace (no Docker on the verifying host).
- Only OTP-pull rails settle; other rails initiate (redirect, QR, embedded) but settlement needs tester actions or hits seeded-blueprint gaps.

### Known bugs / risks

- Code gap: Windows Bun 1.4.2 crashes/hangs in `test/admin-slice/report-engine-migration.test.ts`; verified on Linux (CI) only.
- Documentation gap closed in this change: `deploy-localhost.sh` could not start core (missing `OBJECT_STORAGE_KEK_KEYRING`, plane-fence flag) and its dev password never satisfied the user policy; both fixed.
