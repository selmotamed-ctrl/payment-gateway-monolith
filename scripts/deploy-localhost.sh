#!/usr/bin/env bash
#
# Local all-in-one deployment for an Arch Linux workstation.
#
# It provisions the MariaDB database, applies the Prisma migration, seeds the
# chart of accounts / blueprints / Fake Rails catalog, builds the four SPAs and
# starts the five backends + four portals under PM2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
mkdir -p "$LOCAL/fake-rails-data" "$LOCAL/logs"

# The orchestrator (deploy/deploy.ts) keeps its credentials in deploy/deploy.env
# and the fake-rails nginx vhost proxies to this backend. Read the same values
# here, otherwise this convenience script restarts the backend with a different
# tester password/JWT secret and the portal login stops matching the deployed
# configuration. Explicit environment variables still win.
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT/deploy/deploy.env}"
read_deploy_value() {
  local key="$1"
  [[ -f "$DEPLOY_ENV_FILE" ]] || return 1
  local line
  line="$(grep -m1 -E "^[[:space:]]*${key}=" "$DEPLOY_ENV_FILE" || true)"
  [[ -n "$line" ]] || return 1
  local value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}
deploy_value() {
  local fallback="$2" value
  value="$(read_deploy_value "$1" || true)"
  printf '%s' "${value:-$fallback}"
}

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-admin}"
DB_PASSWORD="${DB_PASSWORD:-admin}"
DB_NAME="${DB_NAME:-payment_gateway_monolith}"
DATABASE_URL="${DATABASE_URL:-mysql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}}"

KMS_MASTER_KEY="${KMS_MASTER_KEY:-local-payment-gateway-master-key-32chars!}"
FAKE_RAILS_BASE_URL="${FAKE_RAILS_BASE_URL:-$(deploy_value FAKE_RAILS_PUBLIC_BASE_URL http://127.0.0.1:4104)}"
FAKE_RAILS_PUBLIC_BASE_URL="${FAKE_RAILS_PUBLIC_BASE_URL:-$FAKE_RAILS_BASE_URL}"
FAKE_RAILS_BACK_PORT="${FAKE_RAILS_BACK_PORT:-$(deploy_value FAKE_RAILS_BACK_PORT 4104)}"
FAKE_RAILS_ADMIN_USER="${FAKE_RAILS_ADMIN_USER:-$(deploy_value FAKE_RAILS_ADMIN_USER tester_admin)}"
FAKE_RAILS_ADMIN_PASSWORD="${FAKE_RAILS_ADMIN_PASSWORD:-$(deploy_value FAKE_RAILS_ADMIN_PASSWORD Strong-Tester-Pass-2026!)}"
FAKE_RAILS_JWT_SECRET="${FAKE_RAILS_JWT_SECRET:-$(deploy_value FAKE_RAILS_JWT_SECRET 0123456789abcdef0123456789abcdef)}"
FAKE_RAILS_SEEDER_TOKEN="${FAKE_RAILS_SEEDER_TOKEN:-$(deploy_value FAKE_RAILS_SEEDER_TOKEN 0123456789abcdef0123456789abcdef)}"
FAKE_RAILS_REMOTE_DIR="${FAKE_RAILS_REMOTE_DIR:-$(deploy_value FAKE_RAILS_REMOTE_DIR /var/www/pg-fake-rails)}"
if [[ -z "${FAKE_RAILS_DATA_DIR:-}" ]]; then
  if [[ -d "$FAKE_RAILS_REMOTE_DIR/shared/data" ]]; then
    FAKE_RAILS_DATA_DIR="$FAKE_RAILS_REMOTE_DIR/shared/data"
  else
    FAKE_RAILS_DATA_DIR="$LOCAL/fake-rails-data"
  fi
fi

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

step "MariaDB / database"
MYSQL_PWD="$DB_PASSWORD" mysql --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --protocol=TCP \
  -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null

step "mTLS certificates"
if [[ ! -f "$ROOT/core-back/certs/core-back.crt" ]]; then
  (cd "$ROOT/core-back" && bun run generate-mtls-certs)
else
  echo "using the existing internal CA and certificates"
fi

step "Prisma migrate"
(cd "$ROOT/core-back" && DATABASE_URL="$DATABASE_URL" bun run migrate-deploy)

step "Seed GL accounts, blueprints and platform settings"
(cd "$ROOT/core-back" && \
  DATABASE_URL="$DATABASE_URL" \
  KMS_MASTER_KEY="$KMS_MASTER_KEY" \
  MTLS_CA_CERT_PATH="$ROOT/core-back/certs/internal-ca.crt" \
  MTLS_SERVER_CERT_PATH="$ROOT/core-back/certs/core-back.crt" \
  MTLS_SERVER_KEY_PATH="$ROOT/core-back/certs/core-back.key" \
  bun run db-seed)

step "Development administrator & merchant accounts"
(cd "$ROOT/core-back" && \
  DATABASE_URL="$DATABASE_URL" \
  KMS_MASTER_KEY="$KMS_MASTER_KEY" \
  MTLS_CA_CERT_PATH="$ROOT/core-back/certs/internal-ca.crt" \
  MTLS_SERVER_CERT_PATH="$ROOT/core-back/certs/core-back.crt" \
  MTLS_SERVER_KEY_PATH="$ROOT/core-back/certs/core-back.key" \
  DEV_USERS_ALLOW_PRODUCTION="true" DEV_PASSWORD="${DEV_PASSWORD:-DevPassword123!}" \
  bun run create-dev-users)

step "Seed the Fake Rails gateway catalog"
(cd "$ROOT/core-back" && \
  DATABASE_URL="$DATABASE_URL" \
  KMS_MASTER_KEY="$KMS_MASTER_KEY" \
  MTLS_CA_CERT_PATH="$ROOT/core-back/certs/internal-ca.crt" \
  MTLS_SERVER_CERT_PATH="$ROOT/core-back/certs/core-back.crt" \
  MTLS_SERVER_KEY_PATH="$ROOT/core-back/certs/core-back.key" \
  FAKE_RAILS_PUBLIC_BASE_URL="$FAKE_RAILS_BASE_URL" \
  FAKE_RAILS_SEEDER_TOKEN="$FAKE_RAILS_SEEDER_TOKEN" \
  FAKE_RAILS_ALLOWED_HOSTS="127.0.0.1,localhost" \
  bun ./prisma/seedFakeRails.ts)

step "Build the four portals"
for portal in admin-front merchant-front checkout-front fake-rails-front; do
  if [[ "$portal" == "fake-rails-front" ]]; then
    (cd "$ROOT/$portal" && bun run build >/dev/null)
  else
    (cd "$ROOT/$portal" && bun run build-only >/dev/null)
  fi
  echo "built $portal"
done

step "PM2 ecosystem"
cat > "$LOCAL/ecosystem.config.cjs" <<EOF
const path = require("node:path");
const root = "$ROOT";
const core = path.join(root, "core-back");
const commonCore = {
  NODE_ENV: "production",
  DATABASE_URL: "$DATABASE_URL",
  KMS_MASTER_KEY: "$KMS_MASTER_KEY",
  MTLS_CA_CERT_PATH: path.join(core, "certs/internal-ca.crt"),
  MTLS_SERVER_CERT_PATH: path.join(core, "certs/core-back.crt"),
  MTLS_SERVER_KEY_PATH: path.join(core, "certs/core-back.key"),
  PORT: "4000",
  HOST: "127.0.0.1",
  LOG_LEVEL: "info",
  WORKER_ENABLED: "true",
  WORKER_BACKGROUND_JOBS_ENABLED: "true",
  WORKER_RETENTION_ENABLED: "true",
  FAKE_RAILS_ENABLED: "true",
  FAKE_RAILS_ALLOW_IN_PRODUCTION: "true",
  ALLOW_FAKE_RAILS_HOSTS: "true",
  FAKE_RAILS_ALLOWED_HOSTS: "127.0.0.1,localhost",
  FAKE_RAILS_PUBLIC_BASE_URL: "$FAKE_RAILS_BASE_URL",
  FAKE_RAILS_SEEDER_TOKEN: "$FAKE_RAILS_SEEDER_TOKEN",
};
const edge = (name, port, cert) => ({
  NODE_ENV: "production",
  PORT: String(port),
  BIND_HOST: "127.0.0.1",
  ...(name === "admin-back" ? { ADMIN_BIND_HOST: "127.0.0.1" } : {}),
  CORE_BACK_URL: "https://127.0.0.1:4000",
  MTLS_CA_CERT_PATH: path.join(core, "certs/internal-ca.crt"),
  MTLS_CLIENT_CERT_PATH: path.join(core, "certs", cert + "-client.crt"),
  MTLS_CLIENT_KEY_PATH: path.join(core, "certs", cert + "-client.key"),
  ...(name === "checkout-back" ? { CHECKOUT_FRONT_BASE_URL: "http://127.0.0.1:5103" } : {}),
  LOG_LEVEL: "info",
});
module.exports = {
  apps: [
    { name: "pg-core-back", cwd: core, script: "pm2-compatible-start.js", interpreter: "bun", env: commonCore },
    { name: "pg-fake-rails-back", cwd: path.join(root, "fake-rails-back"), script: "pm2-compatible-start.js", interpreter: "bun", env: {
      NODE_ENV: "production", HOST: "127.0.0.1", PORT: "$FAKE_RAILS_BACK_PORT",
      FAKE_RAILS_ENABLED: "true", FAKE_RAILS_ALLOW_IN_PRODUCTION: "true",
      FAKE_RAILS_PUBLIC_BASE_URL: "$FAKE_RAILS_PUBLIC_BASE_URL",
      FAKE_RAILS_DATA_DIR: "$FAKE_RAILS_DATA_DIR",
      CORE_INBOUND_BASE_URL: "http://127.0.0.1:4103/api/v1/inbound",
      FAKE_RAILS_ADMIN_USER: "$FAKE_RAILS_ADMIN_USER",
      FAKE_RAILS_ADMIN_PASSWORD: "$FAKE_RAILS_ADMIN_PASSWORD",
      FAKE_RAILS_JWT_SECRET: "$FAKE_RAILS_JWT_SECRET",
      FAKE_RAILS_SEEDER_TOKEN: "$FAKE_RAILS_SEEDER_TOKEN",
      FAKE_RAILS_ALLOWED_HOSTS: "127.0.0.1,localhost",
      FAKE_RAILS_ALLOWED_CIDRS: "127.0.0.1/32",
      LOG_LEVEL: "info",
    } },
    { name: "pg-admin-back", cwd: path.join(root, "admin-back"), script: "pm2-compatible-start.js", interpreter: "bun", env: edge("admin-back", 4101, "admin-back") },
    { name: "pg-merchant-back", cwd: path.join(root, "merchant-back"), script: "pm2-compatible-start.js", interpreter: "bun", env: edge("merchant-back", 4102, "merchant-back") },
    { name: "pg-checkout-back", cwd: path.join(root, "checkout-back"), script: "pm2-compatible-start.js", interpreter: "bun", env: edge("checkout-back", 4103, "checkout-back") },
    { name: "pg-admin-front", cwd: path.join(root, "admin-front"), script: "bun", args: "run preview -- --port 5101 --strictPort --host 127.0.0.1", interpreter: "none", env: { NODE_ENV: "production" } },
    { name: "pg-merchant-front", cwd: path.join(root, "merchant-front"), script: "bun", args: "run preview -- --port 5102 --strictPort --host 127.0.0.1", interpreter: "none", env: { NODE_ENV: "production" } },
    { name: "pg-checkout-front", cwd: path.join(root, "checkout-front"), script: "bun", args: "run preview -- --port 5103 --strictPort --host 127.0.0.1", interpreter: "none", env: { NODE_ENV: "production" } },
    { name: "pg-fake-rails-front", cwd: path.join(root, "fake-rails-front"), script: "bun", args: "run preview -- --port 5104 --strictPort --host 127.0.0.1", interpreter: "none", env: { NODE_ENV: "production" } },
  ],
};
EOF

pm2 delete pg-core-back pg-fake-rails-back pg-admin-back pg-merchant-back pg-checkout-back pg-admin-front pg-merchant-front pg-checkout-front pg-fake-rails-front >/dev/null 2>&1 || true
pm2 start "$LOCAL/ecosystem.config.cjs"
pm2 save >/dev/null

step "Health checks"
wait_for() {
  local name="$1" url="$2" extra="${3:-}"
  for _ in $(seq 1 60); do
    if curl -kfsS $extra "$url" >/dev/null 2>&1; then
      echo "$name OK ($url)"
      return 0
    fi
    sleep 1
  done
  echo "$name FAILED ($url)" >&2
  return 1
}

wait_for "admin-back" "http://127.0.0.1:4101/health"
wait_for "merchant-back" "http://127.0.0.1:4102/health"
wait_for "checkout-back" "http://127.0.0.1:4103/health"
wait_for "fake-rails-back" "http://127.0.0.1:4104/health"
wait_for "core-back (mTLS)" "https://127.0.0.1:4000/health" \
  "--cert $ROOT/core-back/certs/admin-back-client.crt --key $ROOT/core-back/certs/admin-back-client.key --cacert $ROOT/core-back/certs/internal-ca.crt"
wait_for "admin-front" "http://127.0.0.1:5101/"
wait_for "merchant-front" "http://127.0.0.1:5102/"
wait_for "checkout-front" "http://127.0.0.1:5103/"
wait_for "fake-rails-front" "http://127.0.0.1:5104/"

step "Deployed"
cat <<TXT
Admin portal      http://127.0.0.1:5101
Merchant portal   http://127.0.0.1:5102
Checkout portal   http://127.0.0.1:5103/pay/<linkKey>
Fake Rails portal http://127.0.0.1:5104  ($FAKE_RAILS_ADMIN_USER / $FAKE_RAILS_ADMIN_PASSWORD)
Core mTLS         https://127.0.0.1:4000
PM2 status        pm2 list
Logs              pm2 logs <name>   (or $LOCAL/logs)
TXT
