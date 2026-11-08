#!/usr/bin/env bash
#
# Drop application database(s) on the local PostgreSQL cluster.
#
#   ./scripts/drop-database.sh                 # prompt, then drop payment_gateway_prod
#   ./scripts/drop-database.sh --yes           # no prompt
#   ./scripts/drop-database.sh --yes pg_audit_db pg_logs_db
#
# The database name defaults to PG_DB_NAME in deploy/deploy.env, the port to
# DB_PORT (5432) and the PostgreSQL version to PG_VERSION (18). It connects as
# the postgres superuser through sudo/runuser (peer auth) and uses
# DROP DATABASE ... WITH (FORCE), which terminates any open sessions.
#
# Options:
#   -y, --yes   Do not ask for confirmation.
#   -h, --help  Show this help.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT/deploy/deploy.env}"

env_value() {
  local key="$1"
  [[ -f "$DEPLOY_ENV_FILE" ]] || return 1
  local line value
  line="$(grep -m1 -E "^[[:space:]]*${key}=" "$DEPLOY_ENV_FILE" || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

PORT="${PG_PORT:-$(env_value DB_PORT || true)}"
PORT="${PORT:-5432}"
DEFAULT_DB="${PG_DB_NAME:-$(env_value PG_DB_NAME || true)}"
DEFAULT_DB="${DEFAULT_DB:-payment_gateway_prod}"

ASSUME_YES=0
DBS=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) DBS+=("$arg") ;;
  esac
done
[[ ${#DBS[@]} -gt 0 ]] || DBS=("$DEFAULT_DB")

for db in "${DBS[@]}"; do
  [[ "$db" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*$ ]] || {
    echo "Invalid database name: $db" >&2
    exit 2
  }
done

if [[ "$(id -u)" -eq 0 ]]; then
  PSQL=(runuser -u postgres -- psql)
else
  command -v sudo >/dev/null 2>&1 || {
    echo "Run as root or install sudo: dropping a database needs the postgres superuser." >&2
    exit 1
  }
  PSQL=(sudo runuser -u postgres -- psql)
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf 'Drop database(s) %s on 127.0.0.1:%s? This cannot be undone. [y/N] ' "${DBS[*]}" "$PORT"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

for db in "${DBS[@]}"; do
  echo "Dropping \"$db\"..."
  "${PSQL[@]}" -p "$PORT" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
done

echo "Done."
