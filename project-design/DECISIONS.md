# Decisions

Architecture and documentation decisions are recorded here. Add a dated ADR entry for every non-trivial decision.

## ADR-0001 — `project-design/` is canonical

- **Date:** 2026-11-03
- **Status:** accepted
- **Decision:** `project-design/parts/**` is the editable source of truth. `PROJECT_DESIGN.md`, `STATUS.md`, appendices and `*/blueprint.md` are generated. `design/**` is historical/reference only.
- **Rationale:** The historical design corpus mixes normative design, delivery logs, aspirational plans and obsolete engine versions. A single generated master plus part metadata gives one authoritative answer and a machine-checkable status.
- **Consequences:** Agents must update part docs and `TRACKER.md` with code changes. Generated files are never hand-edited.

## ADR-0002 — PostgreSQL 18 is the only runtime database

- **Date:** 2026-11-03
- **Status:** accepted
- **Decision:** PostgreSQL 18 (`@prisma/adapter-pg` + `pg`) is the only supported runtime engine. MySQL/MariaDB runtime support and legacy migration history are removed.
- **Consequences:** Historical MySQL notes remain only in `design/**` with historical labels. `deploy.env` defaults to PostgreSQL 18.

## ADR-0003 — Storage/backup design is as-built, not aspirational

- **Date:** 2026-11-03
- **Status:** accepted
- **Decision:** Storage/backup/search/seeder design parts must distinguish implemented behavior from partial/missing features. Read models, replica routing, keyset pagination, audit/log retention and backup drill behavior are documented as they exist, not as the blueprint originally proposed.
- **Consequences:** P0/P1 gaps stay visible in `TRACKER.md` until the code changes.

## 2026-11-03 — Two-machine lab is disposable and marker-gated

- **Decision:** `deploy/test-matrix/**` owns the T1-T8 lab. Bootstrap writes `/etc/pg-lab-matrix`; teardown only drops PostgreSQL clusters when that marker exists.
- **Why:** the lab intentionally creates and destroys `main`, `replica_*`, `audit` and `log` clusters on both hosts. Without a marker, a teardown could destroy a non-lab database.
- **Consequence:** live certification requires HOST_B reachable and the marker present. Config generation and unit tests do not need HOST_B.
