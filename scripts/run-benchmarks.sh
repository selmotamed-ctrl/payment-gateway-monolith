#!/usr/bin/env bash
#
# Storage-engine benchmark runner.
#
# The benchmark suites need a real PostgreSQL 18 server because they exercise
# partitioned journal writes, gl_account_shards, outbox_events, audit_outbox and
# the Redis Lua velocity path. They print p50/p95 timings and enforce generous
# upper bounds so a regression is visible without making CI machine-dependent.
#
#   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
#     ./scripts/run-benchmarks.sh
#
# Optional:
#   STORAGE_TEST_REDIS_URL=redis://127.0.0.1:56379
#   BENCHMARK_FILTER=write-path
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/core-back"

if [[ -z "${DATABASE_URL:-}" && -z "${POSTGRES_TEST_DATABASE_URL:-}" && -z "${STORAGE_TEST_DATABASE_URL:-}" ]]; then
  echo "Set DATABASE_URL, POSTGRES_TEST_DATABASE_URL or STORAGE_TEST_DATABASE_URL." >&2
  exit 2
fi

echo "== storage-engine benchmarks =="
if [[ -n "${BENCHMARK_FILTER:-}" ]]; then
  bun test test/storage-engine/performance --filter "$BENCHMARK_FILTER"
else
  bun test test/storage-engine/performance
fi

echo
echo "== full storage-engine regression =="
bun test test/storage-engine

echo
echo "== backup control-plane regression =="
bun test test/backup-admin

echo
echo "Benchmarks completed. Compare the printed p50/p95 values with the previous run."
