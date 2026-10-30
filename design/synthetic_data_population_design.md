# Synthetic Historical Data Population — Design

## Purpose

Populate a development/staging database with deterministic, multi-year synthetic data that behaves like a real running platform: merchants, payments, settlements, refunds, disputes, reconciliation, AML, approvals, notifications and ledger history.

## Non-negotiable rules

- Opt-in only; production requires an explicit override.
- Deterministic from `SYNTHETIC_DATA_SEED`.
- Idempotent and resumable.
- Namespaced so reset never touches real data.
- Financial entries must balance and pass `InvariantVerifier`.
- No real PII, PANs or secrets.
- Synthetic rows must not be indistinguishable from real rows.

## Entry points

- `core-back/scripts/syntheticDataPlan.ts` — pure config, PRNG, distributions, IDs, manifest.
- `core-back/scripts/seed-synthetic.ts` — generator, reset and verify.
- `core-back/test/synthetic-data-plan.test.ts` — pure tests.
- `core-back/test/e2e/synthetic-data.test.ts` — tiny-profile MariaDB test.
- `core-back/package.json`: `"seed-synthetic": "bun ./scripts/seed-synthetic.ts"`.

## Configuration

| Variable | Default |
| :--- | :--- |
| `SYNTHETIC_DATA_ENABLED` | `false` |
| `SYNTHETIC_DATA_PROFILE` | `demo` |
| `SYNTHETIC_DATA_NAMESPACE` | `synthv1` |
| `SYNTHETIC_DATA_SEED` | `20260101` |
| `SYNTHETIC_DATA_YEARS` | `3` |
| `SYNTHETIC_DATA_END_DATE` | today |
| `SYNTHETIC_DATA_MERCHANTS` | profile default |
| `SYNTHETIC_DATA_ATTEMPTS` | profile default |
| `SYNTHETIC_DATA_RESET` | `false` |
| `SYNTHETIC_DATA_ALLOW_PRODUCTION` | `false` |
| `RUN_SYNTHETIC_SEED` | `false` |

Profiles: `demo` (3 years, 30 merchants, 30k attempts), `staging` (3 years, 100 merchants, 150k attempts), `load` (5 years, 400 merchants, 500k attempts).

## Data domains

- Catalog/identity: merchants, users, identities, applications, wallets, merchant GL accounts, commission profiles, access tokens, POS.
- Onboarding: join requests, KYB documents, beneficial owners, screenings.
- Payments: links, attempt groups, attempts, step logs, inbound events, journal entries/lines, health samples.
- Finance: settlement sweeps, fee variances, merchant-direct netting, refunds, chargebacks, cash-outs, adjustments.
- Compliance: AML screenings/matches/cases, regulatory reports.
- Operations: operator cases, statement sources, reconciliation runs/items, approvals, detail logs, audit logs, notifications.

## Generation

1. Validate config and guard.
2. Read manifest; `--auto` skips a completed matching dataset.
3. Optional namespace-only reset.
4. Ensure base seed and catalog exist.
5. Generate identity/onboarding history.
6. Generate day/month buckets across the historical window.
7. Generate links/groups/attempts and post balanced ledger entries.
8. Generate finance/compliance/operations rows with correct time ordering.
9. Run `InvariantVerifier`; fail on non-zero drift.
10. Write the manifest summary.

## Namespacing

- IDs: `<namespace>_...`
- References: `SYNTH-...`
- Emails: `@synthetic.payment-gateway.local`
- Merchant names: `SYNTH ...`
- Audit actions: `SYNTHETIC_*`

## Manifest and smart detection

`platform_settings` key `synthetic.dataset.<namespace>` stores generator version, profile, seed, window, status, last bucket, counts, ledger drift and timestamps.

- `COMPLETE` + matching config + valid counts/drift → skip.
- `RUNNING` → resume from last completed bucket.
- `FAILED` or changed config → require reset/new namespace.
- `--verify` checks without writing.
- `--reset` removes only the namespace.

## Deploy integration

Deploy can run `seed-synthetic --auto` after base seed and optional fake-rail seed when `RUN_SYNTHETIC_SEED=true`. The current test server must set `SYNTHETIC_DATA_ALLOW_PRODUCTION=true`.

## Verification

- Deterministic rerun produces stable counts.
- Reset removes only synthetic rows.
- Zero ledger drift.
- Link counter invariants hold.
- No orphan FKs.
- Dashboard, profitability, liquidity, disputes, AML, reconciliation and approvals pages render the data.
