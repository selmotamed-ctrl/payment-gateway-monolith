#!/usr/bin/env bash
#
# Starts a local MariaDB instance for development and for the end-to-end suite.
#
# The service is intentionally started by hand (no systemd, no container
# runtime) so that the workspace stays self contained:
#
#   ./scripts/start-mariadb.sh            # start on 127.0.0.1:3307
#   ./scripts/start-mariadb.sh --reset    # drop and recreate the databases
#
# The instance listens on 127.0.0.1:3307 and stores its data under
# /tmp/opencode/mariadb. The default credentials are `gateway` / `gateway_pw`.
#
set -euo pipefail

DATA_ROOT="${MARIADB_DATA_ROOT:-/tmp/opencode/mariadb}"
DATA_DIR="${DATA_ROOT}/data"
RUN_DIR="${DATA_ROOT}/run"
PORT="${MARIADB_PORT:-3307}"
DB_USER="${MARIADB_USER:-gateway}"
DB_PASSWORD="${MARIADB_PASSWORD:-gateway_pw}"
DATABASES=(payment_gateway payment_gateway_test)
SOCKET="${RUN_DIR}/mysqld.sock"

mkdir -p "${RUN_DIR}"

if [ ! -d "${DATA_DIR}/mysql" ]; then
  echo "Initialising the MariaDB data directory in ${DATA_DIR} ..."
  mariadb-install-db \
    --datadir="${DATA_DIR}" \
    --user="$(id -un)" \
    --auth-root-authentication-method=normal >/dev/null
fi

if ! mariadb-admin --socket="${SOCKET}" ping >/dev/null 2>&1; then
  echo "Starting MariaDB on 127.0.0.1:${PORT} ..."
  mariadbd \
    --datadir="${DATA_DIR}" \
    --socket="${SOCKET}" \
    --port="${PORT}" \
    --bind-address=127.0.0.1 \
    --pid-file="${RUN_DIR}/mysqld.pid" \
    --log-error="${RUN_DIR}/error.log" \
    --user="$(id -un)" >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    if mariadb-admin --socket="${SOCKET}" ping >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! mariadb-admin --socket="${SOCKET}" ping >/dev/null 2>&1; then
  echo "MariaDB did not start; see ${RUN_DIR}/error.log" >&2
  exit 1
fi

for database in "${DATABASES[@]}"; do
  mariadb --socket="${SOCKET}" -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${DB_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${DB_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
done

if [ "${1:-}" = "--reset" ]; then
  echo "Resetting the databases ..."
  for database in "${DATABASES[@]}"; do
    mariadb --socket="${SOCKET}" -u root -e "DROP DATABASE IF EXISTS \`${database}\`;"
  done
  for database in "${DATABASES[@]}"; do
    mariadb --socket="${SOCKET}" -u root <<SQL
CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${DB_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${DB_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
  done
fi

echo "MariaDB is ready on 127.0.0.1:${PORT} (socket ${SOCKET})."
echo "  DATABASE_URL=mysql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/payment_gateway"
