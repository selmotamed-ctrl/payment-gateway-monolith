#!/usr/bin/env bash
#
# One-command launcher for GitHub Codespaces (also works on any Linux/macOS/WSL box that already
# has PostgreSQL 18, Bun, Node and OpenSSL).
#
#   ./scripts/codespaces-start.sh                    # start the default profile (merchant-demo)
#   ./scripts/codespaces-start.sh start full         # start every portal incl. the admin back office
#   ./scripts/codespaces-start.sh status             # what is running + health
#   ./scripts/codespaces-start.sh urls               # forwarded URLs
#   ./scripts/codespaces-start.sh credentials        # print the generated development logins
#   ./scripts/codespaces-start.sh smoke              # real HTTP checks incl. a simulated payment + mTLS
#   ./scripts/codespaces-start.sh logs merchant-back # tail one service log
#   ./scripts/codespaces-start.sh stop               # stop every service started by this script
#   ./scripts/codespaces-start.sh reset-db --yes-delete-dev-database
#
# Profiles:
#   core           core-back only (private mTLS API)
#   merchant-demo  core + Sandbox core + Fake Rails + merchant/checkout edges + merchant/checkout/Fake Rails portals (default)
#   full           merchant-demo + admin-back + admin portal
#
# Safety:
#   * Nothing is reset on start. The database is only seeded when it is empty.
#   * Secrets (KMS master key, development password, Fake Rails tokens) are generated once with
#     `openssl rand` into .local/codespaces/secrets.env (mode 0600, git-ignored). Nothing is hard-coded.
#   * core-back, PostgreSQL and Redis are never published; every service binds to 127.0.0.1.
#     Codespaces forwards only the ports listed in `urls` and keeps them private by default.
#   * mTLS stays enforced between edges and core-back (certificates are generated locally, git-ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.local/codespaces"
LOGS="$STATE/logs"
PIDS="$STATE/pids"
SECRETS_FILE="${CODESPACES_SECRETS_FILE:-$STATE/secrets.env}"
CERTS="$ROOT/core-back/certs"
umask 077
mkdir -p "$LOGS" "$PIDS"

# ── ports (schema defaults of every workspace) ───────────────────────────────────────────────
CORE_PORT=4000
ADMIN_BACK_PORT=4101
MERCHANT_BACK_PORT=4102
CHECKOUT_BACK_PORT=4103
FAKE_RAILS_BACK_PORT=4104
ADMIN_FRONT_PORT=5101
MERCHANT_FRONT_PORT=5102
CHECKOUT_FRONT_PORT=5103
FAKE_RAILS_FRONT_PORT=5104
# Parallel Sandbox execution plane: a second core-back (own database) that every Fake Rails payment uses.
SANDBOX_CORE_PORT=4005

# ── database ─────────────────────────────────────────────────────────────────────────────────
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-payment_gateway_monolith}"
DB_PASSWORD="${DB_PASSWORD:-}"
SANDBOX_DB_NAME="${SANDBOX_DB_NAME:-${DB_NAME}_sandbox}"

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

usage() { sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

in_codespaces() { [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; }

# Browser-reachable origin of a local port (Codespaces forwarded URL, or loopback outside Codespaces).
public_url() {
  if in_codespaces; then
    printf 'https://%s-%s.%s' "$CODESPACE_NAME" "$1" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
  else
    printf 'http://127.0.0.1:%s' "$1"
  fi
}
public_host() {
  if in_codespaces; then
    printf '%s-%s.%s' "$CODESPACE_NAME" "$1" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
  else
    printf '127.0.0.1'
  fi
}

# ── profile → services ───────────────────────────────────────────────────────────────────────
profile_services() {
  case "$1" in
    core) echo "core-back" ;;
    merchant-demo) echo "core-back core-sandbox fake-rails-back merchant-back checkout-back merchant-front checkout-front fake-rails-front" ;;
    full) echo "core-back core-sandbox fake-rails-back admin-back merchant-back checkout-back admin-front merchant-front checkout-front fake-rails-front" ;;
    *) die "unknown profile '$1' (use: core, merchant-demo, full)" ;;
  esac
}
ALL_SERVICES="core-back core-sandbox fake-rails-back admin-back merchant-back checkout-back admin-front merchant-front checkout-front fake-rails-front"

# ── secrets ──────────────────────────────────────────────────────────────────────────────────
NEW_KMS_KEY=0
init_secrets() {
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate development secrets"
  touch "$SECRETS_FILE"; chmod 600 "$SECRETS_FILE"
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  ensure_secret KMS_MASTER_KEY
  ensure_secret DEV_PASSWORD
  ensure_secret FAKE_RAILS_ADMIN_PASSWORD
  ensure_secret FAKE_RAILS_JWT_SECRET
  ensure_secret FAKE_RAILS_SEEDER_TOKEN
  ensure_secret OBJECT_STORAGE_KEK_KEYRING
  # Shared secret of the core <-> Fake Rails control plane (persona accounts, scenarios); mandatory in production mode.
  ensure_secret FAKE_RAILS_CONTROL_TOKEN
}
ensure_secret() {
  local name="$1" value
  if [[ -z "${!name:-}" ]]; then
    if [[ "$name" == "OBJECT_STORAGE_KEK_KEYRING" ]]; then
      # core-back refuses the development fallback KEK in production mode: v<N>:<64 hex chars>
      value="v1:$(openssl rand -hex 32)"
    elif [[ "$name" == "DEV_PASSWORD" ]]; then
      # create-dev-users requires 12+ chars with lowercase, uppercase and a digit
      value="Dp1-$(openssl rand -hex 16)"
    else
      value="$(openssl rand -hex 24 | cut -c1-40)"
    fi
    printf -v "$name" '%s' "$value"
    printf '%s=%q\n' "$name" "$value" >> "$SECRETS_FILE"
    [[ "$name" == "KMS_MASTER_KEY" ]] && NEW_KMS_KEY=1
  fi
  return 0
}

url_encode() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

build_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then return; fi
  if [[ -n "$DB_PASSWORD" ]]; then
    DATABASE_URL="postgresql://${DB_USER}:$(url_encode "$DB_PASSWORD")@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  else
    DATABASE_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  fi
}

# Sandbox plane database. The v38 migration stamps a fresh database LIVE unless the migration session
# carries app.execution_plane=SANDBOX, so the migration URL passes that setting as a connection option.
build_sandbox_database_url() {
  if [[ -n "${SANDBOX_DATABASE_URL:-}" ]]; then return; fi
  if [[ -n "$DB_PASSWORD" ]]; then
    SANDBOX_DATABASE_URL="postgresql://${DB_USER}:$(url_encode "$DB_PASSWORD")@${DB_HOST}:${DB_PORT}/${SANDBOX_DB_NAME}"
  else
    SANDBOX_DATABASE_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${SANDBOX_DB_NAME}"
  fi
  SANDBOX_MIGRATE_URL="${SANDBOX_DATABASE_URL}?options=-c%20app.execution_plane%3DSANDBOX"
}

psql_admin() { PGPASSWORD="$DB_PASSWORD" psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" "$@"; }

# ── process helpers ──────────────────────────────────────────────────────────────────────────
pid_file() { printf '%s/%s.pid' "$PIDS" "$1"; }
is_running() {
  local file pid
  file="$(pid_file "$1")"
  [[ -f "$file" ]] || return 1
  pid="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# start_service <name> <cwd> <command...>   (environment is taken from the calling subshell)
start_service() {
  local name="$1" cwd="$2"; shift 2
  if is_running "$name"; then info "$name already running (pid $(cat "$(pid_file "$name")"))"; return 0; fi
  local log="$LOGS/$name.log"
  : > "$log"
  (
    cd "$cwd"
    if command -v setsid >/dev/null 2>&1; then
      exec setsid nohup "$@" >> "$log" 2>&1 < /dev/null
    else
      exec nohup "$@" >> "$log" 2>&1 < /dev/null
    fi
  ) &
  echo $! > "$(pid_file "$name")"
  info "started $name (pid $!, log ${log#"$ROOT"/})"
}

stop_service() {
  local name="$1" pid
  if ! is_running "$name"; then rm -f "$(pid_file "$name")"; return 0; fi
  pid="$(cat "$(pid_file "$name")")"
  # the service was started in its own session: signal the whole process group first
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$(pid_file "$name")"
  info "stopped $name"
}

wait_for() { # name url [curl-args...]
  local name="$1" url="$2"; shift 2
  for _ in $(seq 1 90); do
    if curl -ksf --max-time 3 "$@" "$url" >/dev/null 2>&1; then printf '   \033[32mOK\033[0m   %s  (%s)\n' "$name" "$url"; return 0; fi
    sleep 1
  done
  printf '   \033[31mFAIL\033[0m %s  (%s) - see %s\n' "$name" "$url" "${LOGS#"$ROOT"/}/$name.log" >&2
  return 1
}
# mTLS probe of core-back. Done with Bun (not curl) so it behaves the same everywhere: some curl builds
# (e.g. Git for Windows / Schannel) cannot present a PEM client key.
core_health() { # [port]  (default: the Live core)
  CERTS_DIR="$CERTS" CORE_PORT_NUM="${1:-$CORE_PORT}" bun -e '
    const https = require("node:https");
    const fs = require("node:fs");
    const dir = process.env.CERTS_DIR;
    const req = https.get({
      host: "127.0.0.1",
      port: Number(process.env.CORE_PORT_NUM),
      path: "/health",
      cert: fs.readFileSync(dir + "/admin-back-client.crt"),
      key: fs.readFileSync(dir + "/admin-back-client.key"),
      ca: fs.readFileSync(dir + "/internal-ca.crt"),
      timeout: 3000,
    }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' >/dev/null 2>&1
}

core_env_run() { # <extra KEY=VALUE...> -- <command...>
  local extra=()
  while [[ "$1" != "--" ]]; do extra+=("$1"); shift; done
  shift
  (
    cd "$ROOT/core-back"
    export DATABASE_URL KMS_MASTER_KEY
    export MTLS_CA_CERT_PATH="$CERTS/internal-ca.crt" MTLS_SERVER_CERT_PATH="$CERTS/core-back.crt" MTLS_SERVER_KEY_PATH="$CERTS/core-back.key"
    for kv in "${extra[@]}"; do export "$kv"; done
    "$@"
  )
}

# ── commands ─────────────────────────────────────────────────────────────────────────────────
cmd_start() {
  local profile="merchant-demo" rebuild=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --rebuild) rebuild=1 ;;
      core|merchant-demo|full) profile="$1" ;;
      --profile) shift; profile="${1:-}" ;;
      --profile=*) profile="${1#--profile=}" ;;
      *) die "unknown option '$1' (see: $0 help)" ;;
    esac
    shift
  done
  local services; services="$(profile_services "$profile")"
  want() { [[ " $services " == *" $1 "* ]]; }

  if [[ "${NODE_ENV:-}" == "production" && "${LOCAL_TARGET:-}" != "1" ]]; then
    die "NODE_ENV=production is set. This launcher starts a test-tier stack (Fake Rails enabled); set LOCAL_TARGET=1 to confirm this is not a production host."
  fi

  step "Checking tools"
  for tool in bun node openssl curl psql pg_isready; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed or not on PATH"
  done
  info "bun $(bun --version), node $(node --version)"

  init_secrets
  build_database_url

  step "PostgreSQL 18"
  pg_isready --host="$DB_HOST" --port="$DB_PORT" >/dev/null 2>&1 \
    || die "PostgreSQL is not accepting connections on ${DB_HOST}:${DB_PORT}. In Codespaces the 'db' container starts with the workspace; outside Codespaces start PostgreSQL 18 and set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD."
  local version_num
  version_num="$(psql_admin --dbname=postgres -tAc 'SHOW server_version_num' | tr -d '[:space:]')"
  [[ "${version_num:-0}" -ge 180000 ]] || die "PostgreSQL 18 or newer is required (server_version_num=${version_num:-unknown})"
  if ! psql_admin --dbname=postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    psql_admin --dbname=postgres -c "CREATE DATABASE \"${DB_NAME}\"" >/dev/null
    info "created database ${DB_NAME}"
  fi
  info "server_version_num=$version_num, database ${DB_NAME} ready"
  if want core-sandbox; then
    build_sandbox_database_url
    if ! psql_admin --dbname=postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${SANDBOX_DB_NAME}'" | grep -q 1; then
      psql_admin --dbname=postgres -c "CREATE DATABASE \"${SANDBOX_DB_NAME}\"" >/dev/null
      info "created sandbox-plane database ${SANDBOX_DB_NAME}"
    fi
  fi

  step "Dependencies"
  local workspaces=(core-back)
  want fake-rails-back && workspaces+=(fake-rails-back)
  want admin-back && workspaces+=(admin-back admin-front)
  want merchant-back && workspaces+=(merchant-back merchant-front)
  want checkout-back && workspaces+=(checkout-back checkout-front)
  want fake-rails-front && workspaces+=(fake-rails-front)
  for ws in "${workspaces[@]}"; do
    if [[ ! -d "$ROOT/$ws/node_modules" ]]; then
      info "bun install in $ws"
      (cd "$ROOT/$ws" && bun install --frozen-lockfile >/dev/null)
    fi
  done
  info "workspace dependencies present"

  step "mTLS certificates"
  if [[ ! -f "$CERTS/core-back.crt" ]]; then
    (cd "$ROOT/core-back" && bun run generate-mtls-certs >/dev/null)
    info "generated a fresh internal CA and leaf certificates (git-ignored)"
  else
    info "using the existing internal CA and certificates"
  fi

  step "Prisma client and migrations"
  (cd "$ROOT/core-back" && bun run migrate-generate >/dev/null)
  (cd "$ROOT/core-back" && DATABASE_URL="$DATABASE_URL" bun run migrate-deploy 2>&1 | tail -2)

  # Every seed step is guarded and idempotent, so a failed or interrupted first run resumes cleanly and
  # a normal restart never touches existing data.
  local seeded dev_admin
  seeded="$(psql_admin --dbname="$DB_NAME" -tAc 'SELECT count(*) FROM platform_settings' 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [[ "${seeded:-0}" != "0" && "$NEW_KMS_KEY" == "1" ]]; then
    die "The database already holds encrypted data but no KMS master key was found in ${SECRETS_FILE#"$ROOT"/}. Restore the old secrets file, or reset the development database with: $0 reset-db --yes-delete-dev-database"
  fi
  step "Seed data (only what is missing)"
  if [[ "${seeded:-0}" == "0" ]]; then
    core_env_run -- bun run db-seed >/dev/null
    info "baseline seed applied (chart of accounts, blueprints, platform settings)"
  else
    info "baseline seed already present"
  fi
  # The dev merchant is created UNSCOPED so Sandbox Studio (a different set of applications) is usable;
  # an older, application-scoped dev merchant is re-provisioned once.
  dev_admin="$(psql_admin --dbname="$DB_NAME" -tAc "SELECT (SELECT count(*) FROM users WHERE email = 'dev-admin@payment-gateway.local') + (SELECT count(*) FROM users WHERE email = 'dev-merchant@payment-gateway.local' AND app_scope_ids::text = '[]')" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [[ "${dev_admin:-0}" != "2" ]]; then
    core_env_run DEV_USERS_ALLOW_PRODUCTION=true DEV_MERCHANT_UNSCOPED=true DEV_PASSWORD="$DEV_PASSWORD" -- bun run create-dev-users >/dev/null
    info "development administrator, checker and merchant created (logins: $0 credentials)"
  else
    info "development users already present"
  fi
  # The widget SDK origin is the forwarded URL of THIS Codespace, so re-point the gateways when it changes.
  local rails_stamp_new rails_stamp_old=""
  # (also re-run when seedFakeRails.ts itself changes, e.g. after a git pull)
  rails_stamp_new="$(public_url "$FAKE_RAILS_FRONT_PORT")|$(cksum < "$ROOT/core-back/prisma/seedFakeRails.ts" | cut -d" " -f1)"
  [[ -f "$STATE/fake-rails.stamp" ]] && rails_stamp_old="$(cat "$STATE/fake-rails.stamp")"
  if [[ "$rails_stamp_new" != "$rails_stamp_old" ]]; then
    core_env_run FAKE_RAILS_PUBLIC_BASE_URL="http://127.0.0.1:$FAKE_RAILS_BACK_PORT" \
      FAKE_RAILS_BROWSER_BASE_URL="$(public_url "$FAKE_RAILS_FRONT_PORT")" \
      FAKE_RAILS_SEEDER_TOKEN="$FAKE_RAILS_SEEDER_TOKEN" FAKE_RAILS_ALLOWED_HOSTS="127.0.0.1,localhost" \
      -- bun ./prisma/seedFakeRails.ts >/dev/null
    printf '%s' "$rails_stamp_new" > "$STATE/fake-rails.stamp"
    info "gateways pointed at the Fake Rails emulator (browser origin $(public_url "$FAKE_RAILS_FRONT_PORT"))"
  else
    info "gateways already point at the Fake Rails emulator"
  fi

  # ── Sandbox execution plane: its own database, migrated with app.execution_plane=SANDBOX ──
  if want core-sandbox; then
    step "Sandbox plane database (${SANDBOX_DB_NAME})"
    (cd "$ROOT/core-back" && DATABASE_URL="$SANDBOX_MIGRATE_URL" bun run migrate-deploy 2>&1 | tail -2)
    local sandbox_plane sandbox_seeded
    sandbox_plane="$(psql_admin --dbname="$SANDBOX_DB_NAME" -tAc 'SELECT plane FROM system_execution_plane WHERE id = 1' 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$sandbox_plane" == "SANDBOX" ]] || die "${SANDBOX_DB_NAME} is stamped '${sandbox_plane:-unknown}', not SANDBOX. Drop it (./scripts/codespaces-start.sh reset-db --yes-delete-dev-database) so it is migrated with the sandbox plane setting."
    sandbox_seeded="$(psql_admin --dbname="$SANDBOX_DB_NAME" -tAc 'SELECT count(*) FROM platform_settings' 2>/dev/null | tr -d '[:space:]' || echo 0)"
    if [[ "${sandbox_seeded:-0}" == "0" ]]; then
      core_env_run DATABASE_URL="$SANDBOX_DATABASE_URL" EXECUTION_PLANE=SANDBOX SANDBOX_DB_NAME="$SANDBOX_DB_NAME" -- bun run db-seed >/dev/null
      info "sandbox baseline seed applied"
    else
      info "sandbox baseline seed already present"
    fi
    local sandbox_stamp_new sandbox_stamp_old=""
    sandbox_stamp_new="$(public_url "$FAKE_RAILS_FRONT_PORT")|$(cksum < "$ROOT/core-back/prisma/seedFakeRails.ts" | cut -d" " -f1)"
    [[ -f "$STATE/fake-rails-sandbox.stamp" ]] && sandbox_stamp_old="$(cat "$STATE/fake-rails-sandbox.stamp")"
    if [[ "$sandbox_stamp_new" != "$sandbox_stamp_old" ]]; then
      core_env_run DATABASE_URL="$SANDBOX_DATABASE_URL" EXECUTION_PLANE=SANDBOX SANDBOX_DB_NAME="$SANDBOX_DB_NAME" \
        FAKE_RAILS_PUBLIC_BASE_URL="http://127.0.0.1:$FAKE_RAILS_BACK_PORT" \
        FAKE_RAILS_BROWSER_BASE_URL="$(public_url "$FAKE_RAILS_FRONT_PORT")" \
        FAKE_RAILS_SEEDER_TOKEN="$FAKE_RAILS_SEEDER_TOKEN" FAKE_RAILS_ALLOWED_HOSTS="127.0.0.1,localhost" \
        -- bun ./prisma/seedFakeRails.ts >/dev/null
      printf '%s' "$sandbox_stamp_new" > "$STATE/fake-rails-sandbox.stamp"
      info "sandbox gateways pointed at the Fake Rails emulator"
    else
      info "sandbox gateways already point at the Fake Rails emulator"
    fi
  fi

  # ── frontends: build once per URL set (the checkout/Fake Rails origins are baked in at build time) ──
  local stamp_new stamp_old=""
  stamp_new="$(public_url "$CHECKOUT_FRONT_PORT")|$(public_url "$FAKE_RAILS_FRONT_PORT")"
  [[ -f "$STATE/build.stamp" ]] && stamp_old="$(cat "$STATE/build.stamp")"
  build_front() { # name script
    local name="$1" script="$2"
    if [[ ! -f "$ROOT/$name/.env" && -f "$ROOT/$name/.env.example" ]]; then cp "$ROOT/$name/.env.example" "$ROOT/$name/.env"; fi
    if [[ "$rebuild" == "1" || "$stamp_new" != "$stamp_old" || ! -d "$ROOT/$name/dist" ]]; then
      info "building $name ..."
      (cd "$ROOT/$name" && \
        VITE_CHECKOUT_BASE_URL="$(public_url "$CHECKOUT_FRONT_PORT")" \
        VITE_CHECKOUT_ORIGIN="$(public_url "$CHECKOUT_FRONT_PORT")" \
        bun run "$script" >> "$LOGS/build-$name.log" 2>&1) || die "build of $name failed - see ${LOGS#"$ROOT"/}/build-$name.log"
    else
      info "$name already built for these URLs"
    fi
  }
  if want merchant-front || want checkout-front || want fake-rails-front || want admin-front; then
    step "Building portals"
    want admin-front && build_front admin-front build-only
    want merchant-front && build_front merchant-front build-only
    want checkout-front && build_front checkout-front build-only
    want fake-rails-front && build_front fake-rails-front build
    printf '%s' "$stamp_new" > "$STATE/build.stamp"
  fi

  step "Starting services ($profile)"
  export_edge_env() { # name port cert  (call inside a subshell)
    export NODE_ENV=production PORT="$2" BIND_HOST=127.0.0.1 LOG_LEVEL=info
    export CORE_BACK_URL="https://127.0.0.1:$CORE_PORT"
    # `sbx_*` links and SANDBOX webhooks are routed to the Sandbox plane core (never silently to Live).
    if want core-sandbox; then export SANDBOX_CORE_BACK_URL="https://127.0.0.1:$SANDBOX_CORE_PORT"; fi
    export MTLS_CA_CERT_PATH="$CERTS/internal-ca.crt" MTLS_CLIENT_CERT_PATH="$CERTS/$3-client.crt" MTLS_CLIENT_KEY_PATH="$CERTS/$3-client.key"
  }

  if want core-back; then
    (
      export NODE_ENV=production DATABASE_URL KMS_MASTER_KEY PORT=$CORE_PORT HOST=127.0.0.1 LOG_LEVEL=info
      export MTLS_CA_CERT_PATH="$CERTS/internal-ca.crt" MTLS_SERVER_CERT_PATH="$CERTS/core-back.crt" MTLS_SERVER_KEY_PATH="$CERTS/core-back.key"
      export WORKER_ENABLED=true WORKER_BACKGROUND_JOBS_ENABLED=true WORKER_RETENTION_ENABLED=true
      export OBJECT_STORAGE_KEK_KEYRING OBJECT_STORAGE_ROOT_DIR="$STATE/object-storage"; mkdir -p "$OBJECT_STORAGE_ROOT_DIR"
      export FAKE_RAILS_ENABLED=true FAKE_RAILS_ALLOW_IN_PRODUCTION=true ALLOW_FAKE_RAILS_HOSTS=true
      # Development deployment only: the emulator normally belongs to the Sandbox plane (PlaneFenceGuard).
      export EXECUTION_PLANE=LIVE PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE=true
      export FAKE_RAILS_ALLOWED_HOSTS="127.0.0.1,localhost" FAKE_RAILS_PUBLIC_BASE_URL="http://127.0.0.1:$FAKE_RAILS_BACK_PORT"
      export FAKE_RAILS_SEEDER_TOKEN
      # Both cores share the object-storage vault: only one plane may sweep orphans.
      if want core-sandbox; then export OBJECT_STORAGE_ORPHAN_SWEEP_ENABLED=false; fi
      [[ -n "${REDIS_URL:-}" ]] && export REDIS_URL
      start_service core-back "$ROOT/core-back" bun run index.ts
    )
    for _ in $(seq 1 90); do core_health && break; sleep 1; done
    core_health && printf '   \033[32mOK\033[0m   core-back (mTLS)  https://127.0.0.1:%s/health\n' "$CORE_PORT" \
      || die "core-back did not become healthy - see ${LOGS#"$ROOT"/}/core-back.log"
  fi

  if want core-sandbox; then
    (
      export NODE_ENV=production DATABASE_URL="$SANDBOX_DATABASE_URL" KMS_MASTER_KEY PORT=$SANDBOX_CORE_PORT HOST=127.0.0.1 LOG_LEVEL=info
      export MTLS_CA_CERT_PATH="$CERTS/internal-ca.crt" MTLS_SERVER_CERT_PATH="$CERTS/core-back.crt" MTLS_SERVER_KEY_PATH="$CERTS/core-back.key"
      export WORKER_ENABLED=true WORKER_BACKGROUND_JOBS_ENABLED=true WORKER_RETENTION_ENABLED=true NODE_ID=sandbox-1
      export OBJECT_STORAGE_KEK_KEYRING OBJECT_STORAGE_ROOT_DIR="$STATE/object-storage" OBJECT_STORAGE_ORPHAN_SWEEP_ENABLED=false
      export EXECUTION_PLANE=SANDBOX SANDBOX_DB_NAME="$SANDBOX_DB_NAME" PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE=false
      export FAKE_RAILS_ENABLED=true FAKE_RAILS_ALLOW_IN_PRODUCTION=true ALLOW_FAKE_RAILS_HOSTS=true
      export FAKE_RAILS_ALLOWED_HOSTS="127.0.0.1,localhost" FAKE_RAILS_PUBLIC_BASE_URL="http://127.0.0.1:$FAKE_RAILS_BACK_PORT"
      export FAKE_RAILS_CONTROL_URL="http://127.0.0.1:$FAKE_RAILS_BACK_PORT" FAKE_RAILS_SEEDER_TOKEN FAKE_RAILS_CONTROL_TOKEN
      [[ -n "${REDIS_URL:-}" ]] && export REDIS_URL
      start_service core-sandbox "$ROOT/core-back" bun run index.ts
    )
    for _ in $(seq 1 90); do core_health "$SANDBOX_CORE_PORT" && break; sleep 1; done
    core_health "$SANDBOX_CORE_PORT" && printf '   \033[32mOK\033[0m   core-sandbox (mTLS)  https://127.0.0.1:%s/health\n' "$SANDBOX_CORE_PORT" \
      || die "core-sandbox did not become healthy - see ${LOGS#"$ROOT"/}/core-sandbox.log"
  fi

  if want fake-rails-back; then
    (
      export NODE_ENV=production HOST=127.0.0.1 PORT=$FAKE_RAILS_BACK_PORT FAKE_RAILS_ENABLED=true FAKE_RAILS_ALLOW_IN_PRODUCTION=true
      export FAKE_RAILS_PUBLIC_BASE_URL="$(public_url "$FAKE_RAILS_FRONT_PORT")"
      export FAKE_RAILS_DATA_DIR="$STATE/fake-rails-data"; mkdir -p "$FAKE_RAILS_DATA_DIR"
      export CORE_INBOUND_BASE_URL="http://127.0.0.1:$CHECKOUT_BACK_PORT/api/v1/inbound"
      export FAKE_RAILS_ADMIN_USER=tester_admin FAKE_RAILS_ADMIN_PASSWORD FAKE_RAILS_JWT_SECRET FAKE_RAILS_SEEDER_TOKEN FAKE_RAILS_CONTROL_TOKEN
      export FAKE_RAILS_ALLOWED_HOSTS="127.0.0.1,localhost" FAKE_RAILS_ALLOWED_CIDRS="127.0.0.1/32" LOG_LEVEL=info
      start_service fake-rails-back "$ROOT/fake-rails-back" bun run index.ts
    )
  fi
  if want admin-back; then
    (
      export_edge_env admin-back "$ADMIN_BACK_PORT" admin-back; export ADMIN_BIND_HOST=127.0.0.1
      start_service admin-back "$ROOT/admin-back" bun run index.ts
    )
  fi
  if want merchant-back; then
    (
      export_edge_env merchant-back "$MERCHANT_BACK_PORT" merchant-back
      start_service merchant-back "$ROOT/merchant-back" bun run index.ts
    )
  fi
  if want checkout-back; then
    (
      export_edge_env checkout-back "$CHECKOUT_BACK_PORT" checkout-back
      export CHECKOUT_FRONT_BASE_URL="$(public_url "$CHECKOUT_FRONT_PORT")"
      start_service checkout-back "$ROOT/checkout-back" bun run index.ts
    )
  fi

  start_front() { # name port api-port
    local name="$1" port="$2" api="$3"
    (
      export NODE_ENV=production VITE_API_URL="http://127.0.0.1:$api" VITE_FAKE_RAILS_API="http://127.0.0.1:$api"
      # Vite's host check: only this portal's own forwarded host (plus loopback) may be served.
      export VITE_MY_TAILSCALE="$(public_host "$port")"
      start_service "$name" "$ROOT/$name" bun run preview -- --port "$port" --strictPort --host 127.0.0.1
    )
  }
  want admin-front && start_front admin-front $ADMIN_FRONT_PORT $ADMIN_BACK_PORT
  want merchant-front && start_front merchant-front $MERCHANT_FRONT_PORT $MERCHANT_BACK_PORT
  want checkout-front && start_front checkout-front $CHECKOUT_FRONT_PORT $CHECKOUT_BACK_PORT
  want fake-rails-front && start_front fake-rails-front $FAKE_RAILS_FRONT_PORT $FAKE_RAILS_BACK_PORT

  step "Health checks"
  local failed=0
  want fake-rails-back && { wait_for fake-rails-back "http://127.0.0.1:$FAKE_RAILS_BACK_PORT/health" || failed=1; }
  want admin-back && { wait_for admin-back "http://127.0.0.1:$ADMIN_BACK_PORT/health" || failed=1; }
  want merchant-back && { wait_for merchant-back "http://127.0.0.1:$MERCHANT_BACK_PORT/health" || failed=1; }
  want checkout-back && { wait_for checkout-back "http://127.0.0.1:$CHECKOUT_BACK_PORT/health" || failed=1; }
  want admin-front && { wait_for admin-front "http://127.0.0.1:$ADMIN_FRONT_PORT/" || failed=1; }
  want merchant-front && { wait_for merchant-front "http://127.0.0.1:$MERCHANT_FRONT_PORT/" || failed=1; }
  want checkout-front && { wait_for checkout-front "http://127.0.0.1:$CHECKOUT_FRONT_PORT/" || failed=1; }
  want fake-rails-front && { wait_for fake-rails-front "http://127.0.0.1:$FAKE_RAILS_FRONT_PORT/" || failed=1; }
  echo "$profile" > "$STATE/profile"
  [[ "$failed" == "0" ]] || die "some services failed their health check (logs in ${LOGS#"$ROOT"/})"

  step "Ready"
  print_urls "$profile"
}

print_urls() {
  local profile="${1:-$(cat "$STATE/profile" 2>/dev/null || echo merchant-demo)}" services
  services="$(profile_services "$profile")"
  want() { [[ " $services " == *" $1 "* ]]; }
  echo "Profile: $profile    ($(in_codespaces && echo "GitHub Codespace $CODESPACE_NAME" || echo "local machine"))"
  echo
  want merchant-front && printf '   Merchant portal   %s\n' "$(public_url $MERCHANT_FRONT_PORT)"
  want checkout-front && printf '   Checkout (payer)  %s/pay/<linkKey>\n' "$(public_url $CHECKOUT_FRONT_PORT)"
  want fake-rails-front && printf '   Fake Rails portal %s   (user tester_admin)\n' "$(public_url $FAKE_RAILS_FRONT_PORT)"
  want admin-front && printf '   Admin portal      %s\n' "$(public_url $ADMIN_FRONT_PORT)"
  want merchant-back && printf '   Merchant API      %s/api/v1/...   (pg_live_ API keys; forwarded port %s)\n' "$(public_url $MERCHANT_BACK_PORT)" "$MERCHANT_BACK_PORT"
  printf '   Core mTLS API     https://127.0.0.1:%s   (private, never forwarded)\n' "$CORE_PORT"
  want core-sandbox && printf '   Sandbox core      https://127.0.0.1:%s   (private; simulated payments run here: use "Sandbox Studio" in the merchant portal)\n' "$SANDBOX_CORE_PORT"
  echo
  echo "Logins:  ./scripts/codespaces-start.sh credentials"
  echo "Status:  ./scripts/codespaces-start.sh status     Stop: ./scripts/codespaces-start.sh stop"
  if in_codespaces; then
    echo "Ports are PRIVATE by default (only you, signed in to GitHub, can open them). See the Ports tab."
  fi
}

cmd_stop() {
  step "Stopping services"
  local name
  for name in $ALL_SERVICES; do stop_service "$name"; done
  rm -f "$STATE/profile"
  info "stopped (PostgreSQL/Redis containers and data are untouched)"
}

cmd_status() {
  local name state
  printf '%-18s %-8s %s\n' SERVICE STATE PID
  for name in $ALL_SERVICES; do
    if is_running "$name"; then state="running"; else state="stopped"; fi
    printf '%-18s %-8s %s\n' "$name" "$state" "$(cat "$(pid_file "$name")" 2>/dev/null || echo -)"
  done
  echo
  pg_isready --host="$DB_HOST" --port="$DB_PORT" 2>&1 | sed 's/^/postgres: /' || true
  if [[ -f "$CERTS/admin-back-client.crt" ]]; then
    core_health && echo "core-back: healthy (mTLS)" || echo "core-back: not reachable"
    if is_running core-sandbox; then
      core_health "$SANDBOX_CORE_PORT" && echo "core-sandbox: healthy (mTLS)" || echo "core-sandbox: not reachable"
    fi
  fi
}

cmd_credentials() {
  [[ -f "$SECRETS_FILE" ]] || die "no secrets yet - run ./scripts/codespaces-start.sh first"
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  cat <<TXT
Development logins (generated for THIS workspace, stored in ${SECRETS_FILE#"$ROOT"/}, never committed):

  Merchant portal : dev-merchant@payment-gateway.local   password: ${DEV_PASSWORD:-?}
  Admin (maker)   : dev-admin@payment-gateway.local      password: ${DEV_PASSWORD:-?}
  Admin (checker) : dev-checker@payment-gateway.local    password: ${DEV_PASSWORD:-?}
  Fake Rails      : tester_admin                          password: ${FAKE_RAILS_ADMIN_PASSWORD:-?}

MFA is disabled for the development accounts only.
TXT
}

cmd_smoke() {
  command -v bun >/dev/null 2>&1 || die "bun is required for the smoke test"
  CODESPACES_SECRETS_FILE="$SECRETS_FILE" bun "$ROOT/scripts/codespaces-smoke.ts"
}

cmd_logs() {
  local name="${1:-}"
  [[ -n "$name" && -f "$LOGS/$name.log" ]] || die "usage: $0 logs <service>   (services: $ALL_SERVICES)"
  tail -n 80 -f "$LOGS/$name.log"
}

cmd_reset_db() {
  [[ "${1:-}" == "--yes-delete-dev-database" ]] || die "this DROPS the development database '${DB_NAME}' and its seeds. Re-run with --yes-delete-dev-database to confirm."
  [[ "$DB_NAME" != *_test ]] || die "refusing to reset a test database from this script"
  cmd_stop
  build_database_url
  psql_admin --dbname=postgres -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)" >/dev/null
  psql_admin --dbname=postgres -c "DROP DATABASE IF EXISTS \"${SANDBOX_DB_NAME}\" WITH (FORCE)" >/dev/null
  rm -f "$SECRETS_FILE" "$STATE"/*.stamp
  info "dropped ${DB_NAME} and ${SANDBOX_DB_NAME} and removed the generated secrets; the next start creates and seeds everything again"
}

main() {
  local cmd="${1:-start}"
  [[ $# -gt 0 ]] && shift
  case "$cmd" in
    start) cmd_start "$@" ;;
    core|merchant-demo|full) cmd_start "$cmd" "$@" ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    urls) print_urls "${1:-}" ;;
    credentials) cmd_credentials ;;
    logs) cmd_logs "${1:-}" ;;
    smoke) cmd_smoke ;;
    reset-db) cmd_reset_db "${1:-}" ;;
    help|-h|--help) usage ;;
    *) usage; die "unknown command '$cmd'" ;;
  esac
}
main "$@"
