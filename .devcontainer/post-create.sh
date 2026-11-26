#!/usr/bin/env bash
# Runs once when the Codespace is created. Installs dependencies and prepares the databases.
# It does NOT start any service and does NOT seed data: run ./scripts/codespaces-start.sh for that.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

echo "== Waiting for PostgreSQL 18 (${DB_HOST:-db}:${DB_PORT:-5432})"
for _ in $(seq 1 60); do
  pg_isready -h "${DB_HOST:-db}" -p "${DB_PORT:-5432}" >/dev/null 2>&1 && break
  sleep 2
done
pg_isready -h "${DB_HOST:-db}" -p "${DB_PORT:-5432}"

for database in payment_gateway_monolith payment_gateway_monolith_test; do
  if ! psql -h "${DB_HOST:-db}" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${database}'" | grep -q 1; then
    psql -h "${DB_HOST:-db}" -U postgres -c "CREATE DATABASE ${database}" >/dev/null
    echo "created database ${database}"
  fi
done

echo "== Installing workspace dependencies (frozen lockfiles)"
workspaces=(core-back admin-back merchant-back checkout-back fake-rails-back
            admin-front merchant-front checkout-front fake-rails-front
            deploy deploy/backup-daemon deploy/object-storage-daemon tests)
printf '%s\n' "${workspaces[@]}" | xargs -P 4 -I{} bash -c 'cd "$1/{}" && bun install --frozen-lockfile >/dev/null 2>&1 && echo "   installed {}" || echo "   FAILED {}"' _ "$ROOT"

for portal in admin-front merchant-front checkout-front fake-rails-front; do
  if [[ -f "$portal/.env.example" && ! -f "$portal/.env" ]]; then cp "$portal/.env.example" "$portal/.env"; fi
done

chmod +x scripts/*.sh .devcontainer/*.sh 2>/dev/null || true
echo
echo "Ready. Start the demo stack with:  ./scripts/codespaces-start.sh"
