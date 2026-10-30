# Synthetic Data and Fake Rails — Implementation Tracker

## Phase 1 — Design and configuration
- [x] Write synthetic data design.
- [x] Write fake rails design.
- [x] Write implementation tracker.
- [x] Add core environment variables for fake rails.
- [x] Add deploy environment schema and planner variables.

## Phase 2 — Fake rails
- [x] Add outbound private/HTTP allowlist for the exact fake host.
- [x] Implement embedded fake provider.
- [x] Implement fake rail catalog and idempotent seed.
- [x] Start provider from core when enabled.
- [x] Add fake redirect checkout page and redirect allowlist.
- [x] Add fake-rail provider, allowlist and plan tests.

## Phase 3 — Synthetic data
- [x] Implement pure synthetic data plan module.
- [x] Implement generator, reset and verify.
- [x] Implement manifest and smart auto-detection.
- [x] Add package scripts and tests.

## Phase 4 — Deployment
- [x] Add deploy.env example and documentation.
- [x] Run fake-rail seed automatically when requested.
- [x] Run synthetic seed automatically when requested.
- [x] Add deploy tests.

## Phase 5 — Verification
- [x] Core typecheck.
- [x] Core tests (832 pass).
- [x] Deploy typecheck/tests (38 pass).
- [x] Checkout frontend typecheck/build.
- [x] Tiny-profile MariaDB integration (2 merchants / 20 attempts, drift 0.0000).
- [x] Full demo profile on MariaDB (30 merchants / 30,000 attempts / 136,516 journal lines, drift 0.0000).
- [x] Fake OTP rail end-to-end through the real engine and ledger.
- [x] Fake redirect rail end-to-end through the real engine and ledger.
- [x] QR/push provider endpoints and seeded flows (live checkout verification remains a deployment check).
