---
id: core.route-health
title: Route Health and Circuit Breaker
status: partial
confidence: high
last_verified: 2026-11-16
verified_against: working-tree
code:
  - core-back/engine/routeHealth/**
  - core-back/engine/flow/VisibleRailsResolver.ts
  - core-back/engine/runtime/attemptRepository.ts
  - core-back/engine/workers/productionRuntime.ts
  - core-back/api/internal/checkout.ts
  - core-back/api/internal/admin.ts
  - admin-back/api/protected/rails.ts
  - admin-front/src/pages/routes/**
  - admin-front/src/pages/dashboard/index.tsx
tests:
  - core-back/test/route-health.test.ts
  - core-back/test/exhaustive/04-rail-engine/visible-rails-formula-matrix.test.ts
design_sources:
  - design/11-automation/background_automation_and_workers_plan.md
gaps:
  - The v40 migration and DB-backed worker/approval suites are not written/run against a live PostgreSQL in this workspace; the pure policy, routing, probe and migration-shape gates pass.
  - A manual probe records evidence and counters; a failed degraded/open probe is applied by the next worker decision tick, not in the HTTP request.
---

# Route Health and Circuit Breaker

## 1. Effective and computed health

`rail_routes.health_state` is the effective value used by routing. It is the
admin override when one is active, otherwise `health_computed_state`. The
automation never overwrites the admin override: it keeps writing
`health_computed_state`, probe counters and events, so staff can always see
the measured state behind a forced state.

States are `HEALTHY`, `DEGRADED` and `OPEN_BREAKER`. `DEGRADED` is not routable
for normal traffic but is eligible for a stable canary cohort. `OPEN_BREAKER`
is never routable.

## 2. Outcome classification

The classifier counts only partner faults:

- success: `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`;
- definitive failure: `FAILED` with `ErrorMap.countsTowardBreaker=true` and
  `GATEWAY_FAULT`, or the HTTP 5xx/timeout/network fallback;
- ambiguous: unresolved `UNKNOWN` and trusted-fact conflicts;
- ignored: wrong OTP, terminal declines, limits, `EXPIRED`, `CANCELLED`,
  `BLOCKED`;
- 429 is stored separately and never trips the breaker.

Each terminal attempt stores `first_terminal_at`; an unresolved `UNKNOWN`
stores `first_unknown_at`. `canonical_error` is stored independently from the
overloaded `substatus`. The first markers are monotonic: a later transition
does not rewrite the first one.

## 3. Policy and sampling

The worker is `GatewayHealthWorker` (singleton, `WORKER_ROUTE_HEALTH_ENABLED`,
default 60 s). It recomputes five-minute buckets over a rolling window from
`payment_attempts`, rebuilds `gateway_health_samples` for that window (unique
`(route_id, window_start)`) and drives the breaker. Defaults:

| Setting | Default |
| :--- | :--- |
| minimum outcomes | 10 |
| degrade / open error rate | 30% / 60% |
| consecutive failures to degrade / open | 3 / 6 |
| window / bucket | 900 s / 300 s |
| recovery probes from degraded / open | 2 / 3 |
| open cooldown | 300 s |
| probe interval / backoff max | 60 s / 900 s |
| degraded canary | 5% |
| override default / maximum | 7 / 30 days |

The staff-managed `route_health.policy` Platform Setting overrides these
defaults. A malformed value is ignored field-by-field and never stops the
worker. `SHADOW` computes and records decisions without changing effective
health; `OFF` stops measurement.

## 4. Degraded canary traffic

A degraded route may carry only a stable cohort of payment links:
`canarySelected(routeId, link.key, canaryPercent)`. The cohort is stable for a
route and link, and `canaryMaxAmount` (optional) caps the payment amount. A
rail whose only route is degraded is visible only to its canary cohort; a
healthy route is preferred, and a canary-eligible degraded route is tried
first so recovery evidence is actually produced. The checkout reads the policy
on every resolution; merchant/public previews without a link key never use the
canary.

## 5. Probes

`RouteHealthProbeService` prefers the gateway's declared `CREDENTIAL_CHECK`
flow and falls back to the authenticated base-URL probe. Probes are read-only
and never update the credential-set verdict (`persist:false`). A route that
requires a merchant-owned credential has no platform probe and is left to a
person. Probe results are recorded in `route_health_probes`; consecutive
successes recover `DEGRADED` (2) or `OPEN_BREAKER` (3). A probe failure while
degraded/open opens the breaker. Probes continue while an override is active
when the computed state is not healthy.

## 6. Admin overrides and maker-checker

- Force `HEALTHY`: creates a `ROUTE_HEALTH_OVERRIDE` approval request. The
  checker authority and maker ≠ checker are enforced server-side. The payload
  carries state, reason, expiry and evidence.
- Force `DEGRADED` or `OPEN_BREAKER`: immediate, reason mandatory, audited.
- Clearing an override that makes effective health healthier (for example
  forced `OPEN_BREAKER` → computed `HEALTHY`) needs approval. Clearing a more
  restrictive override is immediate.
- Every override has a mandatory expiry: 7 days by default, 30 days maximum.
- An active override keeps `health_computed_state` and probe evidence visible;
  a persistent conflict opens `route.health.override_conflict:<routeId>`.
  Degraded/open routes open `route.health:<routeId>` (P1 for open).

## 7. API and UI

Core routes (proxied by `admin-back`):

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/internal/admin/routes/:id/health` | effective/computed/override health, canary settings, samples, probes, events |
| POST | `/internal/admin/routes/:id/health/probe` | run a read-only probe and record evidence |
| POST | `/internal/admin/routes/:id/health/override` | immediate override or force-HEALTHY approval |
| POST | `/internal/admin/routes/:id/health/override/clear` | clear, immediate or through approval |

The Admin Routes page opens a health drawer from the row action. It shows the
effective/computed/override split, canary, probe counters, sample windows,
probe history and state history, and offers probe/override/clear. The table
marks a forced route. The Dashboard reports forced and conflicting route
counts alongside healthy/degraded/open.

## 8. Data model

Schema version 40 adds:

- `rail_routes.health_computed_state/reason/at`, `health_override_state/reason/set_at/set_by/expires_at/approval_id`,
  `health_reason/changed_at`, consecutive/probe counters, last/next probe;
- `payment_attempts.first_terminal_at`, `first_unknown_at`, `canonical_error`
  and supporting indexes;
- `gateway_health_samples.ignored_outcomes` and its uniqueness constraint;
- `route_health_events` and `route_health_probes`.

The migration backfills computed health from effective health and
`first_terminal_at` from `terminal_at`, writes one `MIGRATION` event per route,
and installs `payment_attempts_health_markers`, a BEFORE INSERT/UPDATE trigger
that maintains `first_terminal_at`, `first_unknown_at` and the canonical-error
fallback for every writer (Prisma, raw SQL, poll/expiry workers, governance,
sandbox and the seeder). Routing also treats an expired override lazily as
inactive, so a disabled worker cannot keep a forced state in front of payers.
The schema version is 40.
