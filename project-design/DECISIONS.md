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

## ADR-0004 — `pg-native` is the default backup engine

- **Date:** 2026-11-06
- **Status:** accepted
- **Decision:** `BACKUP_ENGINE_MODE` defaults to `pg-native`, and `auto` means `pg-native` (it used to pick `wal-g` on the primary's host and `barman` elsewhere). `wal-g` (co-located only) and `barman` (dedicated host) remain available as explicit choices and keep their validation rules.
- **Rationale:** There is no production deployment, so the default should be the best-evidenced engine, not the one that happens to be oldest. `pg-native` works identically on the primary's host and on a dedicated backup host, needs no external backup tool or S3, and is the only engine that has run against real PostgreSQL 18.6: a single-host live test (full + incremental chain, WAL over mTLS and streaming, PITR, fault injection, least-privilege audit role, recovery of never-archived commits) and a two-host lab on a real LAN (dedicated backup host under systemd as an unprivileged user, restore drills that do not stall the primary, total loss of the primary recovered from the backup host alone). WAL-G and Barman have never run live in this project.
- **Consequences:** Anyone relying on the implicit `wal-g`/`auto` behavior must now set the engine explicitly. WAL-G and Barman are retained but are NOT exercised by any live test; treat them as legacy options until they are. The deploy engine's own SSH execution of the pg-native provisioning is covered by `test/lab/single-host-deploy.lab.test.ts`, which was written and could not be completed (the target host became unreachable); run it before relying on a first real deploy.

## ADR-0005 — The log database is not a backup target

- **Date:** 2026-11-06
- **Status:** accepted (deferred)
- **Decision:** The daemon backs up core, audit and optional Redis only. The operational/step log database is not a backup or PITR target.
- **Rationale:** Logs are high-volume, time-partitioned and pruned by retention, are reproducible from the systems that emitted them, and carry no ledger or audit invariants. Adding a target changes the target enum in the daemon, the core API validation and the admin UI together, for a store whose loss is an inconvenience rather than an incident.
- **Consequences:** Revisit only if logs become evidence (compliance retention). Tracked as GAP-049.

## ADR-0006 — Backup labs that need real machines are manual and credential-gated

- **Date:** 2026-11-06
- **Status:** accepted
- **Decision:** `deploy/backup-daemon/test/lab/*.lab.test.ts` (two-host lab, deploy-engine lab) skip unless `LAB_B_HOST`, `LAB_B_USER` and `LAB_B_PASSWORD` are set, take credentials only from the environment, never write them to a file, and clean up the target afterwards (`LAB_KEEP=1` keeps it). They are not part of CI.
- **Rationale:** They provision and destroy services on a real host, so they must be opt-in, and CI has no such host. A skipped lab does nothing at collection time (no openssl, no temp files).
- **Consequences:** Lab results are recorded in `TRACKER.md` with the date and the topology they covered; they are evidence for that run only.
