#!/usr/bin/env bash
#
# Prepares the MySQL / MariaDB databases the platform uses.
#
# The platform expects a MySQL 8.0+ / MariaDB 10.6+ server. This script does
# NOT start a server: it prepares the databases on the server it is pointed at,
# so it works with the system service, a container, or a server started by hand.
#
#   MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 \
#   MYSQL_ADMIN_USER=admin MYSQL_ADMIN_PASSWORD=admin \
#   ./scripts/prepare-databases.sh
#
# It creates:
#   - the application database            (default `payment_gateway_monolith`)
#   - the test database                   (default `payment_gateway_monolith_test`)
#
# The two databases are separate on purpose: the integration suite truncates and
# rewrites its own data, and must never touch the application database.
#
set -euo pipefail

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
ADMIN_USER="${MYSQL_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${MYSQL_ADMIN_PASSWORD:-admin}"
DATABASE="${MYSQL_DATABASE:-payment_gateway_monolith}"
TEST_DATABASE="${MYSQL_TEST_DATABASE:-${DATABASE}_test}"

mysql_admin() {
  MYSQL_PWD="${ADMIN_PASSWORD}" mysql \
    --host="${MYSQL_HOST}" \
    --port="${MYSQL_PORT}" \
    --user="${ADMIN_USER}" \
    --protocol=TCP \
    --default-character-set=utf8mb4 \
    "$@"
}

echo "Checking the MySQL server at ${MYSQL_HOST}:${MYSQL_PORT} ..."
mysql_admin -e "SELECT VERSION() AS version;" >/dev/null

for database in "${DATABASE}" "${TEST_DATABASE}"; do
  echo "Creating the database ${database} ..."
  mysql_admin <<SQL
CREATE DATABASE IF NOT EXISTS \`${database}\`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
SQL
done

echo
echo "Databases are ready."
echo "  DATABASE_URL=mysql://${ADMIN_USER}:${ADMIN_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${DATABASE}"
echo "  MARIADB_TEST_DATABASE_URL=mysql://${ADMIN_USER}:${ADMIN_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${TEST_DATABASE}"
echo
echo "Next:"
echo "  cd core-back"
echo "  export DATABASE_URL=mysql://${ADMIN_USER}:${ADMIN_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${DATABASE}"
echo "  bun run generate-mtls-certs"
echo "  bun run migrate-deploy"
echo "  bun run db-seed"
