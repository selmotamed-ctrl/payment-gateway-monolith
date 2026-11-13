#!/usr/bin/env bash
#
# Prepares the PostgreSQL 18 databases the platform uses.
#
# The platform expects a PostgreSQL 18 server. This script does NOT start a
# server: it prepares the role and databases on the server it is pointed at,
# so it works with the system service, a container, or a server started by hand.
#
#   POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5432 \
#   POSTGRES_ADMIN_USER=postgres POSTGRES_ADMIN_PASSWORD=secret \
#   ./scripts/prepare-databases.sh
#
# The local development / CI server of this repository listens on 55432:
#
#   POSTGRES_PORT=55432 POSTGRES_ADMIN_USER=postgres \
#   ./scripts/prepare-databases.sh
#
# It creates:
#   - the application role                  (default `gateway`)
#   - the application database              (default `payment_gateway_monolith`)
#   - the test database                     (default `payment_gateway_monolith_test`)
# and then applies the Prisma baseline migrations to both databases.
#
# The two databases are separate on purpose: the integration suite rewrites its
# own data and must never touch the application database.
#
# PostgreSQL 18 is the only supported engine. The former MySQL/MariaDB
# migration history and runtime adapter have been removed.
#
set -euo pipefail

POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
ADMIN_USER="${POSTGRES_ADMIN_USER:-postgres}"
ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-}"
APP_USER="${POSTGRES_APP_USER:-gateway}"
APP_PASSWORD="${POSTGRES_APP_PASSWORD:-gateway}"
DATABASE="${POSTGRES_DATABASE:-payment_gateway_monolith}"
TEST_DATABASE="${POSTGRES_TEST_DATABASE:-${DATABASE}_test}"
# v38: the Sandbox plane is a physically separate database in every topology.
SANDBOX_DATABASE="${POSTGRES_SANDBOX_DATABASE:-payment_gateway_sandbox}"
ALLOW_FAKE_RAILS_ON_LIVE="${FAKE_RAILS_ENABLED:-false}"

psql_admin() {
  PGPASSWORD="${ADMIN_PASSWORD}" psql \
    --host="${POSTGRES_HOST}" \
    --port="${POSTGRES_PORT}" \
    --username="${ADMIN_USER}" \
    --dbname=postgres \
    --no-password \
    "$@"
}

echo "Checking the PostgreSQL server at ${POSTGRES_HOST}:${POSTGRES_PORT} ..."
psql_admin -tAc "SELECT version();" >/dev/null

echo "Creating or updating the application role ${APP_USER} ..."
psql_admin -v ON_ERROR_STOP=1 \
  -v role="${APP_USER}" \
  -v password="${APP_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'role', :'password')
\gexec
SQL

for database in "${DATABASE}" "${TEST_DATABASE}" "${SANDBOX_DATABASE}"; do
  echo "Creating the database ${database} ..."
  exists="$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${database}'")"
  if [[ "${exists}" != "1" ]]; then
    psql_admin -v ON_ERROR_STOP=1 \
      -v database="${database}" \
      -v owner="${APP_USER}" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'owner')
\gexec
SQL
  fi
done

# v38: stamp each database with its execution plane before the migration
# inserts the single-row system_execution_plane lock. A development
# deployment that intentionally uses the Fake Rails emulator marks its LIVE
# database with app.allow_fake_rails=true; production never does.
stamp_plane() {
  local database="$1"
  local plane="$2"
  local allow_fake="false"
  if [[ "${plane}" == "SANDBOX" || "${ALLOW_FAKE_RAILS_ON_LIVE}" == "true" ]]; then
    allow_fake="true"
  fi
  psql_admin -v ON_ERROR_STOP=1     -v database="${database}"     -v plane="${plane}"     -v allow_fake="${allow_fake}" <<'SQL'
SELECT format('ALTER DATABASE %I SET app.execution_plane = %L', :'database', :'plane')
\gexec
SELECT format('ALTER DATABASE %I SET app.allow_fake_rails = %L', :'database', :'allow_fake')
\gexec
SQL
}

stamp_plane "${DATABASE}" "LIVE"
stamp_plane "${TEST_DATABASE}" "LIVE"
stamp_plane "${SANDBOX_DATABASE}" "SANDBOX"

echo
echo "Applying the PostgreSQL baseline migrations ..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_BACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${CORE_BACK_DIR}"
export PATH="${HOME}/.bun/bin:${PATH}"

for database in "${DATABASE}" "${TEST_DATABASE}" "${SANDBOX_DATABASE}"; do
  echo "  migrate deploy -> ${database}"
  DATABASE_URL="postgresql://${APP_USER}:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${database}" \
    bunx --bun prisma migrate deploy
done

echo
echo "Databases are ready."
echo "  DATABASE_URL=postgresql://${APP_USER}:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${DATABASE}"
echo "  POSTGRES_TEST_DATABASE_URL=postgresql://${APP_USER}:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${TEST_DATABASE}"
echo "  SANDBOX_DATABASE_URL=postgresql://${APP_USER}:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${SANDBOX_DATABASE}"
echo
echo "Next:"
echo "  cd core-back"
echo "  export DATABASE_URL=postgresql://${APP_USER}:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${DATABASE}"
echo "  export POSTGRES_TEST_DATABASE_URL=postgresql://${APP_USER}:${APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${TEST_DATABASE}"
echo "  bun run generate-mtls-certs"
echo "  bun run migrate-deploy"
echo "  bun run db-seed"
echo "  bun test"
