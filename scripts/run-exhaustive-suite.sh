#!/usr/bin/env bash
#
# Master runner for the exhaustive verification blueprint.
#
#   ./scripts/run-exhaustive-suite.sh            # run every suite
#   ./scripts/run-exhaustive-suite.sh --deploy   # run every suite, then deploy locally
#
# The database suites share one test database and assert the continuous
# double-entry invariant, so every Bun invocation is forced to a single worker
# (`--parallel=1`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEPLOY=0
for argument in "$@"; do
  case "$argument" in
    --deploy) DEPLOY=1 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

step() {
  printf '\n\033[1;36m== %s ==\033[0m\n' "$1"
}

run_core_suite() {
  local id="$1" directory="$2"
  step "T-EX-${id}  ${directory}"
  (cd core-back && bun test --parallel=1 "test/exhaustive/${directory}")
}

step "T-EX-01  Schema, models, constraints & triggers"
(cd core-back && bun test --parallel=1 test/exhaustive/01-schema)

step "T-EX-02  Ledger templates, hierarchy, fuzzer & checkpoints"
(cd core-back && bun test --parallel=1 test/exhaustive/02-ledger)

step "T-EX-03  Transforms, selectors, crypto & vault"
(cd core-back && bun test --parallel=1 test/exhaustive/03-transforms-crypto)

step "T-EX-04  Rail engine, failover & visible-rails formula"
(cd core-back && bun test --parallel=1 test/exhaustive/04-rail-engine)

step "T-EX-05  API, mTLS, RBAC, IDOR, list filters & Zod matrix"
(cd core-back && bun test --parallel=1 test/exhaustive/05-api-matrix)
(cd admin-back && bun test --parallel=1)
(cd merchant-back && bun test --parallel=1)
(cd checkout-back && bun test --parallel=1)
(cd fake-rails-back && bun test --parallel=1)
(cd deploy && bun test --parallel=1)

step "T-EX-06  Concurrency, slot locks & multi-node workers"
(cd core-back && bun test --parallel=1 test/exhaustive/06-concurrency)

step "T-EX-07  Onboarding, AML, reconciliation & go-live gates"
(cd core-back && bun test --parallel=1 test/exhaustive/07-workflows)

step "T-EX-08  Edge catalog, STRIDE threats & safeguards"
(cd core-back && bun test --parallel=1 test/exhaustive/08-security-edge)

step "T-EX-09  Full-surface Playwright UI matrix"
(cd tests && bun run test:unit && bunx playwright test -c playwright.exhaustive.config.ts)

step "T-EX-10  Cross-service E2E, synthetic seeder & deploy matrix"
(cd core-back && bun test --parallel=1 test/exhaustive/10-seeder-and-deploy)
if [[ "${E2E_LIVE:-0}" == "1" ]]; then
  (cd tests && bunx playwright test -c playwright.exhaustive.config.ts -g "cross-service lifecycle")
else
  echo "Cross-service journeys skipped (set E2E_LIVE=1 to run them against the live stack)."
fi

step "Full core-back regression suite"
(cd core-back && bun test --parallel=1)

if [[ "$DEPLOY" == "1" ]]; then
  step "Local deployment"
  exec "$ROOT/scripts/deploy-localhost.sh"
fi

step "All exhaustive suites passed"
