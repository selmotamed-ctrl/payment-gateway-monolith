---
id: core.data
title: Data Schema and Migrations
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - core-back/prisma/schema.prisma
  - core-back/prisma/schemaVersion.ts
  - core-back/prisma/migrations/**
  - core-back/prisma/migrateDev/index.ts
  - core-back/prisma/client/index.ts
  - core-back/prisma/seed.ts
  - core-back/prisma/seedBlueprints.ts
  - core-back/prisma/seedGlAccounts.ts
  - core-back/prisma/seedGuides.ts
  - core-back/prisma/seedFakeRails.ts
  - core-back/prisma/syntheticSeeder/**
  - core-back/prisma/migrations/20261104120000_mfa_challenges/migration.sql
tests:
  - core-back/test/exhaustive/01-schema/**
  - core-back/test/phase1-mtls-and-schema.test.ts
  - core-back/test/blueprint-seed.test.ts
  - core-back/test/synthetic-seeder.test.ts
  - core-back/test/security-regressions/c2-mfa.test.ts
  - core-back/test/security-regressions/h4-cashout.test.ts
gaps:
  - Core tables use `TIMESTAMP(3)` while storage-engine tables use `TIMESTAMPTZ(3)`.
  - The migration history is forward-only; there are no down migrations.
  - Core HTTP start does not call `ensureSchemaVersion()`; only the seeders assert schema version 10.
  - `journal_lines` partition maintenance depends on an external deploy cron.
  - The generated schema catalog appendix is produced by the project-design generator and is not hand-maintained.
---

# Data Schema and Migrations

## 1. Purpose and scope

This part owns the PostgreSQL 18 relational model, the committed migration history, the schema-version guard and the deterministic seeders that populate a baseline platform.

It covers:

- `core-back/prisma/schema.prisma` — 76 Prisma models and 105 enums;
- `core-back/prisma/migrations/**` — four committed migrations;
- `core-back/prisma/schemaVersion.ts` and `core-back/prisma/client/index.ts` — schema version 10 and the boot guard;
- `core-back/prisma/migrateDev/index.ts` — the migration creation/adoption workflow;
- `core-back/prisma/seed.ts`, `seedBlueprints.ts`, `seedGlAccounts.ts`, `seedGuides.ts` and `seedFakeRails.ts` — deterministic baseline data;
- `core-back/prisma/syntheticSeeder/**` — the optional multi-year synthetic history (documented separately in `core.seeder`).

It does not own domain state machines, ledger templates, API behavior, storage adapter behavior or backup policy. Those are documented in `core.engine`, `core.ledger`, `core.storage` and `core.backup`.

## 2. Design intent (extracted and synthesized from ./design)

The historical design treats PostgreSQL 18 as the only runtime database and the schema as the durable contract for the switch:

- money is stored as `DECIMAL(18,4)` and never as floating point;
- payments, ledger entries and audit/outbox records are written atomically;
- the ledger is append-only and enforced by constraints and shard projections;
- maker-checker is a database-enforced rule, not only an application convention;
- the append-only journal is range-partitioned by month for retention and maintenance;
- read models and the dedicated audit/log databases are separate physical targets;
- migrations are versioned and checked at boot so an outdated database cannot serve traffic.

The blueprint's stale counts are corrected here:

- the schema is not 64 models and 100 enums; it is 76 models and 105 enums;
- the schema version is 10, not 5 or 6;
- there is not one migration that creates shards, outboxes and all tables. The baseline creates the tables, the storage migration adds indexes, the CQRS migration adds read models, and the hardening migration adds partitions, checks and search indexes;
- `rm_merchant_dashboard_stats` and `rm_wallet_statements` do not exist. The actual read models are `rm_merchant_daily_stats` and `rm_route_daily_volumes`.

## 3. As-built architecture

### 3.1 Schema size and layout

`core-back/prisma/schema.prisma` contains:

- 76 `model` declarations;
- 105 `enum` declarations;
- 188 `@@index` / `@@unique` declarations in the datamodel;
- PostgreSQL provider configured through `DATABASE_URL` and the Prisma 7 `@prisma/adapter-pg` runtime.

The models are grouped by domain:

| Domain | Representative models |
| :--- | :--- |
| Merchant and onboarding | `Merchant`, `User`, `UserIdentity`, `JoinRequest`, `KybDocument`, `KybRevalidationRequest`, `BeneficialOwner`, `Application`, `Wallet`, `AccessToken`, `AccessTokenIp` |
| Payment collection | `PaymentLink`, `PosTerminal`, `PosScreen`, `AttemptGroup`, `PaymentAttempt`, `AttemptStepLog`, `InboundEvent`, `OperatorCase`, `GatewayInquirySchedule` |
| Ledger and balances | `GlAccount`, `JournalEntry`, `JournalLine`, `GlAccountShard`, `CommissionProfile` |
| Gateway catalogue and flow | `Gateway`, `GatewayVersion`, `GatewayVersionEvidence`, `GatewayEnvironment`, `GatewayAuth`, `GatewaySetting`, `CredentialSet`, `Asset`, `Rail`, `RailField`, `RailRoute`, `CryptoProfile`, `Flow`, `FlowStep`, `StepParameter`, `StepOutput`, `StatusRule`, `ErrorMap`, `ConfirmationChannel`, `PollPolicy`, `WidgetDefinition`, `RedirectDefinition`, `StatementSource`, `ManualInstruction` |
| Risk and collection operations | `VelocityRule`, `AmlCase`, `AmlScreening`, `AmlScreeningMatch`, `AmlRule`, `ReportingRule`, `RegulatoryReport`, `Dispute`, `Adjustment`, `CashoutRequest`, `ReconciliationRun`, `ReconciliationItem` |
| Governance and audit | `ApprovalRequest`, `DetailChangeLog`, `AuditLog`, `NotificationTemplate`, `Notification`, `PlatformSetting`, `BackgroundJob` |
| Health and operations | `GatewayHealthSample`, `BackupCatalogRun`, `BackupRestoreDrill` |
| Write-path infrastructure | `OutboxEvent`, `AuditOutbox` |
| Read models | `RmMerchantDailyStat`, `RmRouteDailyVolume` |

`core-back/generated/prisma/**` is the committed generated client. It must be regenerated with `bun run migrate-generate`, not hand-edited.

### 3.2 Schema version

`core-back/prisma/schemaVersion.ts` exports `REQUIRED_SCHEMA_VERSION = 10`.

`core-back/prisma/client/index.ts:17-37` implements `ensureSchemaVersion()`:

- it connects through the base client;
- it reads `schema_versions.version` where `id = 1`;
- it throws when the row is missing or does not equal 9;
- it caches the successful check and resets the cached promise after a failure so a later call can retry.

`core-back/prisma/seed.ts`, `seedFakeRails.ts` and `syntheticSeeder/index.ts` call `ensureSchemaVersion()` before writing. A stale database is therefore rejected by these seeders and by any caller that explicitly asserts the version. The core HTTP start path does not call it.

### 3.3 Migration history

There are six committed migrations (the original four below, plus `20261104090000_db_read_write_optimisation` which adds indexes and bumps the schema version to 9, and `20261104120000_mfa_challenges`, described in section 11; the generated migration catalog is authoritative):

| Migration | Purpose |
| :--- | :--- |
| `20261103000000_postgres18_init` | Creates 74 tables: all baseline Prisma model tables plus the `schema_versions` support table. Creates enums and the initial indexes/FKs. Inserts schema version 7. |
| `20261103120000_postgres18_storage_engine` | Adds `pg_trgm` and `btree_gin`; replaces outbox/audit indexes with partial/BRIN indexes; adds covering/BRIN journal indexes; adds worker-claim partial indexes; adds attempt reference indexes and trigram search indexes. |
| `20261103130000_cqrs_read_models` | Creates `rm_merchant_daily_stats` and `rm_route_daily_volumes` plus their day indexes. |
| `20261103180000_storage_hardening` | Adds `pg_stat_statements` when available; sets `gl_account_shards.shard_id` default and range check; converts `journal_lines` to monthly range partitions; adds partition maintenance function; adds broader trigram indexes; updates schema version to 8. |
| `20261104090000_db_read_write_optimisation` | Part A (Prisma diff): drops the redundant `payment_attempts(link_id)`, `payment_attempts(merchant_id)`, `attempt_step_logs(attempt_id)`, `reconciliation_items(run_id)` and `audit_log(entity_type, entity_id)` indexes (each is a prefix of a kept or new composite); adds `approval_requests(subject_type, subject_id, state)`, `payment_attempts(link_id, created_at)`, `attempt_step_logs(attempt_id, created_at)`, `inbound_events(attempt_id, received_at)`, `reconciliation_items(run_id, created_at)` and `(created_at)`, `audit_log(created_at)` and `(actor_id, created_at)`; adds `audit_outbox.lease_until` and `rm_merchant_daily_stats.success_amount` / `success_net_amount`. Part B (raw SQL): partial expression index `payment_attempts_succeeded_settled_at_idx` on `COALESCE(terminal_at, created_at)` INCLUDE `(route_id, total_charged_amount)` WHERE `status = 'SUCCEEDED'` (daily route volume), `audit_outbox_unshipped_idx` recreated INCLUDE `lease_until`, `audit_outbox_shipped_idx` (partial btree) replacing the BRIN. Sets schema version 9. |

The baseline creates the tables, not the storage migration. The storage migration is index-only. The hardening migration is the one that rewrites `journal_lines` into a partitioned table:

- it renames the old table to `journal_lines_unpartitioned`;
- it creates the new partitioned parent with primary key `(id, created_at)`;
- it creates monthly partitions from 2023-01 through the 2028-11 partition and a default partition;
- it copies existing rows;
- it re-adds foreign keys and the positive-amount check;
- it recreates the covering and BRIN indexes;
- it creates `ensure_journal_line_partitions(months_ahead)` and runs it for 18 months.

The deploy engine installs a daily cron at `JOURNAL_LINE_PARTITION_MAINTENANCE_CRON = "30 1 * * *"` that calls `ensure_journal_line_partitions(18)` (`deploy/provisioners/backupEngineProvisioner.ts:333-336`). Partition creation outside that cron is not automatic. A write that falls outside all monthly ranges goes to the default partition.

### 3.4 Indexes

The index strategy has four layers:

1. Foreign-key and uniqueness indexes from the baseline.
2. Partial indexes for worker claim loops:
   - `outbox_events_unprocessed_idx` on `id` where `processed_at IS NULL`;
   - `audit_outbox_unshipped_idx` on `(created_at, id)` where `shipped_at IS NULL`;
   - `payment_attempts_active_expiry_partial_idx` and `payment_attempts_active_poll_partial_idx` for non-terminal attempts;
   - `inbound_events_unprocessed_partial_idx`, `background_jobs_queued_partial_idx` and `notifications_queued_partial_idx`.
3. Covering and BRIN indexes:
   - `journal_lines_account_id_cov_idx` includes direction, amount and created_at;
   - BRIN indexes on `journal_lines.created_at`, `payment_attempts.created_at`, `outbox_events.created_at` and `audit_outbox.shipped_at`;
   - `payment_attempts_merchant_keyset_cov_idx` backs keyset pagination of the merchant payment list (cursor predicate on `(created_at, id)`).
4. Trigram GIN indexes for search candidates on merchants, attempts, join requests, users, gateway inquiries, approvals, KYB documents, disputes, adjustments, reconciliations, AML cases/screenings/rules, regulatory reports, gateways, rails and `audit_log`.

### 3.5 Constraints and triggers

The database enforces the invariants that must not depend on a caller:

| Constraint | Definition | Purpose |
| :--- | :--- | :--- |
| `journal_lines_amount_positive` | `amount > 0` | Rejects zero/negative journal lines |
| `attempt_groups_single_success` | `success_count <= 1` | One success per attempt group |
| `payment_links_slot_reservation_invariant` | `infinite_use = true OR confirmed_count + active_locked_count <= use_count` | Prevents slot over-reservation |
| `approval_requests_checker_not_maker_insert` | `checker_user_id IS NULL OR checker_user_id <> maker_user_id` | Maker-checker on insert |
| `gl_account_shards_shard_id_range` | `shard_id >= 0 AND shard_id < 16` | Shard range |
| `journal_lines_entry_id_fkey` | FK to `journal_entries` with `ON DELETE RESTRICT` | No orphan ledger lines |
| `journal_lines_gl_account_id_fkey` | FK to `gl_accounts` with `ON DELETE RESTRICT` | No orphan account lines |

The baseline also creates the `approval_requests_checker_not_maker` trigger function and `approval_requests_checker_not_maker_update` before-update trigger, which raises when a checker is set equal to the maker. Unique indexes further enforce:

- `journal_entries(ref_type, ref_id)` — one journal entry per domain reference;
- `payment_attempts(reference)`, `payment_attempts(ledger_entry_id)` and `payment_attempts(link_id, idempotency_key)`;
- `inbound_events(channel_id, dedupe_key)`;
- `users(email)`, `user_identities(kind, identifier_normalized)` and `user_identities(provider_subject)`;
- `payment_links(key)`, `access_tokens(token_hash)`;
- `gateways(code)`, `gateway_versions(content_hash)` and `gateway_versions(gateway_id, version_number)`;
- `adjustments(dispute_id)` and `adjustments(journal_entry_id)`;
- `reconciliation_runs(file_hash)` and `platform_settings(key, scope, version)`.

### 3.6 UUID and timestamp conventions

- IDs are UUIDs stored as native PostgreSQL `uuid` (`@db.Uuid`).
- Most models declare `@id @default(uuid(7))`. The application also generates UUIDv7 directly through `core-back/lib/storageEngine/uuid.ts` for audit ids; `uuidv7()` is monotonic within a millisecond and preserves B-tree insert locality.
- Some infrastructure tables use non-UUID keys: `OutboxEvent.id` is `BigInt @default(autoincrement())`; `HttpAccessLog` (dedicated log DB, outside Prisma) and `AuditRecord` use their own identity/primary-key conventions.
- `createdAt` is `DateTime @default(now()) @map("created_at")`; `updatedAt` is `DateTime @updatedAt` on models that mutate.
- Core domain tables use `TIMESTAMP(3)` (without time zone), matching Prisma's default mapping in the baseline. Storage-engine tables such as `gl_account_shards`, `outbox_events`, `audit_outbox`, `backup_catalog_runs` and the two read models explicitly use `@db.Timestamptz(3)`.
- `schema_versions` uses `TIMESTAMPTZ(3)` directly in raw SQL.
- Column names are snake_case through `@map` / `@@map`; the Prisma client exposes camelCase fields.

The mixed timestamp convention is real. Any query that compares a core `TIMESTAMP(3)` column to `now()` relies on the session time zone; storage-engine tables compare absolute instants. New tables should use `TIMESTAMPTZ(3)` unless there is a documented reason not to.

### 3.7 Baseline seeders

`core-back/prisma/seed.ts` is the main baseline seeder. It is idempotent by lookup for most rows and covers:

- platform settings (`OD-1` through `OD-11` plus `join_request.four_eyes_policy`, `onboarding.required_documents`, `join_request.volume_threshold`, `kyb.refresh_policy`);
- system GL accounts via `seedSystemGlAccounts(client)`;
- the blueprint catalogue (`seedBlueprints(client)`) — gateways, versions, rails, routes, flows, steps, status/error maps and related definitions;
- platform credential sets via `seedPlatformCredentialSets(client)`;
- bilingual notification templates;
- reporting rules for the CBL large-transaction and suspicious-activity references;
- checkout support configuration and per-rail help guides via `seedCheckoutSupport` and `seedRailHelpGuides`.

`core-back/prisma/seedFakeRails.ts` is a separate bridge that points seeded gateways at the Fake Rails emulator, rewrites environment base URLs and allowed hosts, updates widget definitions to the emulator SDK, and derives inbound verification secrets from the shared seeder token. It is not a full domain seed.

`core-back/prisma/syntheticSeeder/index.ts` is the optional multi-year history seeder. It requires the Fake Rails safety gate and is described in `core.seeder`.

### 3.8 Migration workflow

The normal workflow is:

```bash
cd core-back
bun run migrate-dev       # create a new migration from the schema and apply it
bun run migrate-deploy    # apply committed migrations
bun run migrate-reset     # drop and recreate the database, then apply all migrations
bun run migrate-generate  # regenerate the Prisma client
bun run prisma:validate   # validate the datamodel
```

`core-back/prisma/migrateDev/index.ts` wraps Prisma:

1. It lists migration directories before the operation.
2. It runs `prisma migrate dev --create-only --name init`.
3. If Prisma created a migration, it patches the SQL: it removes the `DROP TABLE "schema_versions"` statement and appends the schema-version table DDL plus an upsert to `REQUIRED_SCHEMA_VERSION`.
4. It runs `prisma migrate deploy`.

The patch exists because `schema_versions` is managed outside the Prisma datamodel. It is string-based and assumes the generated Prisma SQL contains the exact `DROP TABLE "schema_versions";` statement. A Prisma output change that renames or reformats that statement would silently leave the drop in place or skip the upsert. Review the patched SQL before committing a migration.

## 4. Contracts and invariants

- PostgreSQL 18 is the only runtime database. MySQL/MariaDB must not be reintroduced.
- Money columns are `DECIMAL(18,4)` (or Prisma `Decimal` with the same precision). Application code uses `Decimal`/`decimal.js`; no floating-point arithmetic is allowed for money.
- The Prisma schema is the source of the datamodel. Migrations are the source of applied DDL. Never edit `PROJECT_DESIGN.md`, generated appendices or the generated Prisma client as if they were the schema source.
- Every migration must be forward-applicable to the committed history. There are no down migrations; recovery is restore/PITR or a new forward migration.
- The schema-version row is single-row (`id = 1`) and must equal `REQUIRED_SCHEMA_VERSION` before the application or seeder proceeds.
- `journal_lines` is append-only and partitioned by `created_at`. The primary key includes `created_at` because PostgreSQL requires the partition key in every unique key.
- `journal_lines.amount > 0`; direction carries the sign.
- `payment_links` slot accounting must satisfy the check invariant at all times.
- `approval_requests` must have `checker_user_id <> maker_user_id` when a checker is present, on insert and update.
- `gl_account_shards.shard_id` must be in `0..15`.
- FK actions are deliberate: ledger and shard references use `RESTRICT`; optional relationships use `SET NULL` or `CASCADE` where the dependent row has no independent meaning.
- UUIDv7 is the preferred identifier for new domain rows. Do not use random UUIDv4 for high-volume insert paths without a measured reason.
- Seeders must be safe to rerun. Baseline seeders use existence checks; the synthetic seeder uses a completed-run marker and `skipDuplicates`.
- The Fake Rails bridge requires `FAKE_RAILS_SEEDER_TOKEN`; it must not silently fall back to an empty secret.
- `rm_*` tables are derived data, not the source of truth. A rebuild must be possible from the outbox/ledger. `rebuildAttemptReadModels(db, { fromDay, toDay })` (`outboxWorkers.ts`) recomputes both attempt read models from `payment_attempts`; run it after bulk loads that bypass the outbox (the synthetic seeder). Since 2026-11-04 `rm_route_daily_volumes.volume_amount` is the SUCCEEDED volume (the daily route-cap semantics) and `rm_merchant_daily_stats` carries separate `success_amount` / `success_net_amount` columns next to the creation-time `gross_amount` / `net_amount`.

## 5. Data / API / config / deployment surface

### Prisma and generated surfaces

- Datamodel: `core-back/prisma/schema.prisma`.
- Generated client: `core-back/generated/prisma/**`.
- Migration lock: `core-back/prisma/migrations/migration_lock.toml` (`provider = "postgresql"`).
- Schema version constant: `core-back/prisma/schemaVersion.ts`.
- Boot guard: `core-back/prisma/client/index.ts`.
- Migration wrapper: `core-back/prisma/migrateDev/index.ts`.

### Environment

| Key | Purpose |
| :--- | :--- |
| `DATABASE_URL` | Primary PostgreSQL 18 connection used by Prisma, migrations and seeders |
| `POSTGRES_TEST_DATABASE_URL` / `STORAGE_TEST_DATABASE_URL` | Alternative test database URLs used by test helpers |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Base URL used by `seedFakeRails.ts` |
| `FAKE_RAILS_SEEDER_TOKEN` | HMAC seed for Fake Rails secrets and seeder authentication |
| `FAKE_RAILS_ALLOWED_HOSTS` | Allowed hosts written into gateway environments |
| `SYNTHETIC_SEED_*` | Synthetic seeder controls (see `core.seeder`) |

### Scripts

| Script | Action |
| :--- | :--- |
| `bun run migrate` | `prisma migrate deploy` |
| `bun run migrate-dev` | Create + patch + apply a migration |
| `bun run migrate-deploy` | Apply committed migrations |
| `bun run migrate-reset` | Drop/recreate the database and apply migrations |
| `bun run migrate-generate` | Regenerate the Prisma client |
| `bun run db-seed` | Run the baseline seed |
| `bun run seed-fake-rails` | Point seeded gateways at Fake Rails |
| `bun run seed-synthetic-history` | Run the synthetic history seeder |

### Deployment surfaces

- The deploy engine provisions PostgreSQL 18 on the primary, replicas and optional PgBouncer.
- The partition cron is installed on the primary by `backupEngineProvisioner.ts`.
- The audit and log databases have their own DDL in `deploy/provisioners/auditAndLogDbProvisioner.ts`; they are not Prisma models.
- Backups capture the core database, audit database and optional Redis snapshot (see `core.backup`).

## 6. Operational usage

- Apply migrations before starting a new core build. The boot guard will reject a schema version other than 10.
- Use `bun run migrate-dev` only in development. For production, review and commit the generated migration, then run `bun run migrate-deploy`.
- After changing `schema.prisma`, run `bun run migrate-generate` before typechecking or starting the application.
- Keep the `schema_versions` patch logic in `migrateDev/index.ts` under review. It is the only place that updates the version for newly created migrations.
- Run partition maintenance by installing the deploy cron or by calling `SELECT ensure_journal_line_partitions(18)` on a schedule. The default partition is a safety net, not a substitute for monthly maintenance.
- Run `bun run db-seed` once per environment. It is idempotent for the platform settings, system accounts, blueprints, credential sets, templates, reporting rules and guides.
- Run `bun run seed-fake-rails` only in environments that intentionally point at the emulator. It rewrites gateway base URLs and allowed hosts.
- For a test server, set the synthetic seeder safety variables and run `bun run seed-synthetic-history` after the baseline seed and Fake Rails blueprints.
- To inspect the schema, read the generated `project-design/appendices/schema-catalog.md` and `migration-catalog.md`; regenerate them with `bun scripts/project-design/build.ts`.

## 7. Status and deviations

### Implemented

- 76 models and 105 enums in the Prisma datamodel.
- Schema version 10 with an equality check used by the seeders.
- Four committed migrations with the intended separation: baseline, storage indexes, CQRS read models, hardening.
- Monthly range partitioning of `journal_lines` with historical/future partitions and a default partition.
- Partial, covering, BRIN and trigram indexes for the write path, workers and search.
- Maker-checker insert check and update trigger, slot invariant, positive journal amount, shard range and reference uniqueness.
- UUIDv7 defaults and application UUIDv7 generation.
- Baseline seeders for settings, GL accounts, blueprints, credential sets, templates, reporting rules and guides.
- Fake Rails bridge seeder.
- Synthetic seeder integration with the schema-version guard.
- Schema, constraint, trigger and index test suites.

### Partial

- Timestamp semantics: core domain tables use `TIMESTAMP(3)` while storage tables use `TIMESTAMPTZ(3)`. This is consistent inside each area but mixed globally.
- Seed coverage is complete for platform fundamentals and blueprints, not for every optional model. Business history is delegated to the synthetic seeder.
- Migration guard coverage: the schema-version check runs in the seeders, not in the core HTTP start path; the migration wrapper patches new migrations, but there is no general runtime guard around every script.

### Missing / deferred

- Down migrations or automated rollback. Intentional forward-only design.
- Automatic partition creation inside the application. Deferred to the deploy cron.
- A hand-maintained schema table in the design docs. Replaced by the generated schema catalog.
- Automatic schema drift detection between `schema.prisma` and the live database. `prisma migrate` / validation tools are the current check.
- A boot-time schema assertion in core. The helper exists but core does not call it.

### Known bugs / risks

- The `migrateDev` patch is string-based and fragile against Prisma SQL formatting changes. Code risk.
- `schema_versions` is excluded from the Prisma datamodel, so `prisma migrate reset` drops it and relies on the patched migrations to recreate it. A migration that bypasses `migrateDev` can miss the version upsert.
- The baseline migration inserts version 7 and only the hardening migration moves to 8. Applying only the first three migrations leaves the database at 7; the seeders refuse to run, while core HTTP can start because it does not call the guard. This is easy to misread during partial restore.
- The partition maintenance function creates future partitions but does not enforce retention or detach old partitions. Retention is a separate operational decision.
- The default partition can silently accumulate out-of-range rows, which complicates later partition attachment.
- Core `TIMESTAMP(3)` columns have no time zone. Cross-host comparisons can be wrong if a session time zone differs from the application assumption. Code/schema risk.
- Prisma client generation is committed; a schema change without regenerating the client produces a typecheck/runtime mismatch.
- The synthetic seeder and baseline seeder both write users; the synthetic `authoritiesMap` shape differs from the auth parser expectation (see `core.seeder`).

## 8. Verification and tests

Relevant test files:

- `core-back/test/exhaustive/01-schema/models-and-columns.test.ts` — parses `schema.prisma` and checks the expected model/column surface.
- `core-back/test/exhaustive/01-schema/unique-and-fk-constraints.test.ts` — live PostgreSQL catalog checks for unique and foreign-key constraints.
- `core-back/test/exhaustive/01-schema/check-constraints-and-triggers.test.ts` — check constraints and maker-checker trigger behavior.
- `core-back/test/exhaustive/01-schema/indexes-and-query-plans.test.ts` — index existence and query-plan expectations.
- `core-back/test/phase1-mtls-and-schema.test.ts` — schema phase gate.
- `core-back/test/blueprint-seed.test.ts` — baseline blueprint seed behavior.
- `core-back/test/synthetic-seeder.test.ts` — synthetic seed safety and audit.

Commands:

```bash
cd core-back && bun test test/exhaustive/01-schema
cd core-back && bun test test/phase1-mtls-and-schema.test.ts test/blueprint-seed.test.ts
cd core-back && bun run prisma:validate
cd core-back && bun run migrate-deploy
```

The exhaustive schema suites require a reachable PostgreSQL test database (`databaseIsReachable`); without one they skip. `prisma:validate` requires no database. The migration commands require `DATABASE_URL` and should only be run against the intended database. No test or migration was run for this documentation change.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md#7-database-schema`
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#5-database-schema`
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#4-database-schema`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#3-comprehensive-multi-state-distribution-across-all-66-database-models`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#4-segment-3--postgresql-18-ddl-partialcoveringgin-indexes--dedicated-auditlog-schemas`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/prisma/schema.prisma`
- `core-back/prisma/schemaVersion.ts`
- `core-back/prisma/client/index.ts`
- `core-back/prisma/migrateDev/index.ts`
- `core-back/prisma/migrations/20261103000000_postgres18_init/migration.sql`
- `core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`
- `core-back/prisma/migrations/20261103130000_cqrs_read_models/migration.sql`
- `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql`
- `core-back/prisma/migrations/migration_lock.toml`
- `core-back/prisma/seed.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/prisma/seedGlAccounts.ts`
- `core-back/prisma/seedGuides.ts`
- `core-back/prisma/seedFakeRails.ts`
- `core-back/prisma/syntheticSeeder/**`
- `core-back/generated/prisma/**`
- `deploy/provisioners/backupEngineProvisioner.ts`
- `deploy/provisioners/auditAndLogDbProvisioner.ts`

### Generated appendices

- `project-design/appendices/schema-catalog.md` — authoritative generated model/column/index catalogue. Link target for all schema tables; do not duplicate it by hand.
- `project-design/appendices/migration-catalog.md` — authoritative generated migration list and order.
- `project-design/appendices/env-and-config-matrix.md` — database and seeder environment keys.

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records 75 models, 105 enums, schema version 8, the four-migration history, `journal_lines` partitioning, the actual constraint/trigger set, UUID/timestamp conventions, baseline seeders, Fake Rails bridge and migration wrapper behavior. See `project-design/TRACKER.md`.

## 11. Security hardening (2026-11-05)

Migration `20261104120000_mfa_challenges` (schema version 10, `REQUIRED_SCHEMA_VERSION = 10`; model count 75 to 76):
- creates `mfa_challenges` (opaque UUID id, HMAC of the code, channel, attempt counter, expiry, single-use state);
- adds `access_tokens.expires_at`;
- adds `cashout_requests.idempotency_key` (unique per merchant) and `cashout_requests.requested_by_user_id`;
- bumps `schema_versions` to 10.

Notes: the schema version and model counts quoted elsewhere in this part are updated to 10 and 76; the change-history line below records the original extraction numbers (75 models, version 8) and is historical. Deployments must apply this migration before starting the new core build, because merchant cash-out, API-token expiry and MFA depend on the new columns and table.
