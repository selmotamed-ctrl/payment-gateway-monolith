#!/usr/bin/env bash
#
# Multi-host deployment entrypoint.
#
#   ./deploy/deploy.sh                       # deploy everything (deploy/deploy.env)
#   ./deploy/deploy.sh --only=checkout       # one tier only
#   ./deploy/deploy.sh --update              # no OS bootstrap, no firewall change
#   ./deploy/deploy.sh --dry-run             # print every remote command
#
# The heavy lifting lives in deploy/deploy.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required on the deployment workstation (https://bun.sh)." >&2
  exit 1
fi

if [ ! -f "${SCRIPT_DIR}/deploy.env" ]; then
  echo "Missing ${SCRIPT_DIR}/deploy.env." >&2
  echo "Copy deploy/deploy.env.example to deploy/deploy.env and fill it in." >&2
  exit 1
fi

cd "${REPO_ROOT}"
exec bun run "${SCRIPT_DIR}/deploy.ts" "$@"
