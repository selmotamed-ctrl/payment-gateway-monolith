---
id: core.data
title: Data Schema and Migrations
status: partial
confidence: high
last_verified: 2026-11-10
verified_against: d695518+working-tree
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
  - core-back/prisma/migrations/20261107090000_shard_sequenced_checkpoints/migration.sql
  - core-back/prisma/migrations/20261107150000_shard_repairs/migration.sql
  - core-back/prisma/migrations/20261108090000_partition_truncate_guard/migration.sql
  - core-back/prisma/migrations/20261109210000_ledger_query_and_index_optimization/migration.sql
  - core-back/prisma/migrations/20261110120000_dynamic_report_engine_sdk/migration.sql
  - core-back/prisma/migrations/20261110130000_report_engine_merchant_and_aml/migration.sql
tests:
  - core-back/test/exhaustive/01-schema/**
  - core-back/test/phase1-mtls-and-schema.test.ts
  - core-back/test/blueprint-seed.test.ts
  - core-back/test/synthetic-seeder.test.ts
  - core-back/test/security-regressions/c2-mfa.test.ts
  - core-back/test/security-regressions/h4-cashout.test.ts
  - core-back/test/reportEngineSdk/**
gaps:
  - Core tables use `TIMESTAMP(3)` while storage-engine tables use `TIMESTAMPTZ(3)`.
  - The migration history is forward-only; there are no down migrations.
  - Core HTTP start does not call `ensureSchemaVersion()`; only the seeders assert schema version 35.
  - `journal_lines` partition maintenance depends on an external deploy cron.
  - The generated schema catalog appendix is produced by the project-design generator and is not hand-maintained.
---

# Data Schema and Migrations

## 1. Purpose and scope

This part owns the PostgreSQL 18 relational model, the committed migration history, the schema-version guard and the deterministic seeders that populate a baseline platform.

It covers:

- `core-back/prisma/schema.prisma` — 79 Prisma models and 105 enums;
- `core-back/prisma/migrations/**` — the committed migration history (the generated migration catalog is authoritative);
- `core-back/prisma/schemaVersion.ts` and `core-back/prisma/client/index.ts` — schema version 35 and the seeders' version guard;
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
- the schema version is 14, not 5 or 6;
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

`core-back/prisma/schemaVersion.ts` exports `REQUIRED_SCHEMA_VERSION = 35`.

`core-back/prisma/client/index.ts:17-37` implements `ensureSchemaVersion()`:

- it connects through the base client;
- it reads `schema_versions.version` where `id = 1`;
- it throws when the row is missing or does not equal `REQUIRED_SCHEMA_VERSION`;
- it caches the successful check and resets the cached promise after a failure so a later call can retry.

`core-back/prisma/seed.ts`, `seedFakeRails.ts` and `syntheticSeeder/index.ts` call `ensureSchemaVersion()` before writing. A stale database is therefore rejected by these seeders and by any caller that explicitly asserts the version. The core HTTP start path does not call it.

### 3.3 Migration history

The committed migration history is generated in `project-design/appendices/migration-catalog.md` (authoritative; it currently ends with `20261112090000_journal_partition_storage_and_race`, schema version 35). The original four migrations are:

| Migration | Purpose |
| :--- | :--- |
| `20261103000000_postgres18_init` | Creates 74 tables: all baseline Prisma model tables plus the `schema_versions` support table. Creates enums and the initial indexes/FKs. Inserts schema version 7. |
| `20261103120000_postgres18_storage_engine` | Adds `pg_trgm` and `btree_gin`; replaces outbox/audit indexes with partial/BRIN indexes; adds covering/BRIN journal indexes; adds worker-claim partial indexes; adds attempt reference indexes and trigram search indexes. |
| `20261103130000_cqrs_read_models` | Creates `rm_merchant_daily_stats` and `rm_route_daily_volumes` plus their day indexes. |
| `20261103180000_storage_hardening` | Adds `pg_stat_statements` when available; sets `gl_account_shards.shard_id` default and a 0..15 range check (relaxed to 0..255 by `20261107090000_shard_sequenced_checkpoints`); converts `journal_lines` to monthly range partitions; adds partition maintenance function; adds broader trigram indexes; updates schema version to 8. |
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
| `gl_account_shards_shard_id_range` | `shard_id >= 0 AND shard_id < 256` | Shard id range (0..255) |
| `gl_accounts_shard_count_range` | `shard_count >= 1 AND shard_count <= 256` | Account routing width (1..256) |
| `journal_lines_shard_id_range` | `shard_id >= 0 AND shard_id < 256` | Line shard attribution |
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
- `gl_account_shards.shard_id` and `journal_lines.shard_id` must be in `0..255`; `gl_accounts.shard_count` is `1..256`.
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

- Apply migrations before starting a new core build. The boot guard will reject a schema version other than 33.
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

- 84 models and 105 enums in the Prisma datamodel.
- Schema version 35 with an equality check used by the seeders.
- The committed migration history (baseline, storage indexes, CQRS read models, hardening, MFA, append-only guards, shard checkpoints/repairs, session revocations and the ledger query/index optimisation) is generated in the migration catalog.
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

The current schema version is 35 (`REQUIRED_SCHEMA_VERSION = 35`; model count 105). The schema migrations since version 10 are:

- `20261104120000_mfa_challenges` (version 10):
  - creates `mfa_challenges` (opaque UUID id, HMAC of the code, channel, attempt counter, expiry, single-use state);
  - adds `access_tokens.expires_at`;
  - adds `cashout_requests.idempotency_key` (unique per merchant) and `cashout_requests.requested_by_user_id`.
- `20261105090000_append_only_ledger_guards`: append-only triggers on `journal_entries`, `journal_lines` (and partitions) and `audit_log`, plus the non-owner `pgw_app` role. Audit retention deletes remain possible inside a transaction that sets `pgw.audit_retention` (accidental-error protection, not privilege separation from a compromised app role).
- `20261105130000_statement_unique_source_file_hash`: replaces the global `reconciliation_runs.file_hash` unique index with `(statement_source_id, file_hash)`, sets `timestamp_tolerance_sec = 0` for legacy keyed channels with no signed timestamp source (the verifier now fails closed on a missing signed timestamp), and bumps `schema_versions` to 11.
- `20261107090000_shard_sequenced_checkpoints` (version 12): per-shard sequenced ledger checkpoints, `journal_lines.shard_id/shard_seq`, the `gl_shard_checkpoints` table, per-account shard width and `operator_cases.subject_key` (see `core.ledger`).
- `20261107150000_shard_repairs` (version 14): `gl_shard_checkpoints.baseline_seq` (the exemption marker of a re-baselined shard) and the append-only history table `gl_shard_repairs` (see `core.ledger` 3.10).
- `20261108090000_partition_truncate_guard` (functions and triggers only; `schema_versions` stays at 14): `pgw_guard_journal_line_partition(regclass)` installs the `pgw_journal_lines_no_truncate` statement trigger only when it is missing; `ensure_journal_line_partitions` (run daily by the deploy cron) calls it for every partition it covers, and the migration backfills every existing partition. Statement-level TRUNCATE triggers are not cloned from the partitioned parent, so partitions created after `20261105090000_append_only_ledger_guards` could be truncated by their owner without meeting the guard.
- `20261107120000_inbound_event_claims` (version 13): adds nullable `inbound_events.claimed_at` and `claimed_by` plus `(processed_at, claimed_at)`, the durable lease the inbound webhook worker uses to prevent duplicate processing across a brief leadership overlap.
- `20261109210000_ledger_query_and_index_optimization` (version 25): covering indexes and append-only autovacuum (see `core.ledger`). Revised 2026-11-10 before any production use: `SET lock_timeout = '10s'`, each `journal_lines` covering index is rebuilt only when `pg_get_indexdef` differs from its target (so an index pre-built online is never rebuilt, see section 12b), and the resilient `ensure_journal_line_partitions`.
- `20261110090000_resilient_journal_partitions` (functions only, no version bump): redefines `ensure_journal_line_partitions` for databases that applied version 25 before that revision (`prisma migrate deploy` never re-runs an applied migration: verified 2026-11-10). A month that cannot be created (rows already in `journal_lines_default`: `check_violation`; a lock wait over 5 s: `lock_not_available`) is skipped with a WARNING instead of aborting the call; storage parameters are set only on a partition the call creates; `lock_timeout = 5s`, `timezone = UTC`.
- `20261111090000_report_tenant_and_filing_integrity` (version 34): (1) the merchant report tables referenced each other by id only, so nothing at the database level stopped merchant A's spec pointing at merchant B's asset bundle, or an audit row carrying B's spec under A's `merchant_id`: `UNIQUE (id, merchant_id)` on the bundle and spec tables, composite foreign keys `(asset_bundle_id, merchant_id)` (`ON DELETE SET NULL (asset_bundle_id)`) and `(merchant_spec_id, merchant_id)` (`RESTRICT`) alongside the single-column ones (Prisma cannot model a composite relation with an optional first column, so these are SQL-only), and a real foreign key from `merchant_id` to `merchants` on all five tables; (2) `merchant_report_execution_audit.merchant_spec_id` was `ON DELETE SET NULL`, an UPDATE the table's own append-only trigger rejects, so deleting a referenced spec failed: it is now `RESTRICT` (specs are archived, never deleted), and the table gets the `BEFORE TRUNCATE` guard the staff audit has; (3) `external_submissions_open_report_adapter_key`, a partial unique index on `(report_id, adapter_id)` for statuses PENDING, SUBMITTED and ACKNOWLEDGED: a report is filed at most once per adapter (a FAILED or REJECTED submission can be retried), and the file route maps the violation to its existing `409 REPORT_ALREADY_FILING`. Applying it to a database that already holds two open submissions for one report and adapter fails with a duplicate-key error: resolve them first.
- `20261112090000_journal_partition_storage_and_race` (version 35, no table shape change): redefines `ensure_journal_line_partitions` again. (1) The 2026-11-10 revision set only the insert-autovacuum parameters on a new monthly partition and dropped the explicit `fillfactor = 100` of the original body; it is restored, and set once (`SHARE UPDATE EXCLUSIVE`, no write blocking) on every monthly partition created without it. (2) The same revision replaced `CREATE TABLE IF NOT EXISTS` with a `to_regclass` check and a plain `CREATE TABLE`, so two callers at once (the partition worker on two nodes, or the worker and a deploy) both saw a month missing and the second aborted with `duplicate_table` (measured: 3 of 4 concurrent callers failed); `duplicate_table` / `unique_violation` from a concurrent creator are now accepted, and the truncate-guard install tolerates `duplicate_object`. The version is bumped because the newest migration sets `REQUIRED_SCHEMA_VERSION` (checked by `phase1-mtls-and-schema.test.ts`) and the seeders' equality guard then refuses a database without it; core HTTP start does not check the version. Test: `ledger-query-pruning-and-accuracy.test.ts` EC-15 (storage parameters) and EC-15b (four concurrent callers on a dropped empty month).

The change-history line below records the original extraction numbers (75 models, version 8) and is historical. Deployments must apply these migrations before starting the new core build, because merchant cash-out, API-token expiry, MFA, the append-only guards, shard checkpoints and the inbound claim depend on them.

## 12. Runbook: applying `20261107090000_shard_sequenced_checkpoints` to a populated database (2026-11-08)

Fresh databases and test databases need nothing special. A database that already holds `journal_lines` history does, because the migration is one transaction that:

- adds `journal_lines.shard_id/shard_seq` (metadata-only, but each `ALTER TABLE` takes `ACCESS EXCLUSIVE` on the partitioned parent and every partition for its duration);
- adds `journal_lines_shard_id_range` as a **validated** `CHECK`, which scans every partition under that lock (the `shard_seq > 0` check is `NOT VALID` and costs nothing);
- builds `journal_lines_shard_seq_idx` with a plain `CREATE INDEX`, which blocks writes to `journal_lines` until it finishes;
- computes the genesis totals with one aggregate over all of `journal_lines`, then rewrites `gl_account_shards` and `gl_shard_checkpoints` for every account.

The application is not available for the duration, and an old binary posting while it runs would either block or write lines without shard attribution. The applied migration file must not be edited (Prisma checksums it); the safe handling is operational.

1. **Rehearse first.** Restore the latest backup into a scratch PostgreSQL 18 instance and run `bunx prisma migrate deploy` there. Record the elapsed time; it grows with `journal_lines` row count (the scan, the index build and the genesis aggregate are all full passes). Plan the window at about three times the rehearsal.
2. **Announce a maintenance window** and stop traffic: stop the three edge services (admin/merchant/checkout) and then core's workers, so nothing posts. Confirm no open transactions touch `journal_lines`: `SELECT pid, state, query FROM pg_stat_activity WHERE query ILIKE '%journal_lines%' AND pid <> pg_backend_pid();`.
3. **Take the pre-migration dump** (the deploy engine does this automatically before `migrate deploy`; keep it until the checkpoint worker has verified at least one full sweep afterwards).
4. **Deploy the new core binary and run the migration together** (`bun deploy/deploy.ts`, update mode). Do not run the migration alone and leave the old binary serving: the old poster does not write `shard_id/shard_seq`, so every new line would violate `journal_lines_shard_seq_positive` (the migration is not skippable for the new binary either: `REQUIRED_SCHEMA_VERSION` is checked by the seeders).
5. **Verify before reopening traffic**: `SELECT version FROM schema_versions;` is at least 12; `SELECT count(*) FROM gl_accounts a WHERE NOT EXISTS (SELECT 1 FROM gl_account_shards s WHERE s.gl_account_id = a.id);` is 0; the global ledger invariant check in the admin ledger-health page reports no drift; then start the edges.
6. **If the window is too long for the lock scan**, the lower-impact variant is a hand-applied pre-step on the production database, run before the deploy and reviewed by two people (maker-checker for operations): `ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_shard_id_range CHECK (shard_id >= 0 AND shard_id < 256) NOT VALID;` then `ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_shard_id_range;` (the validate step takes only `SHARE UPDATE EXCLUSIVE`) and `CREATE INDEX CONCURRENTLY` for each partition's index. The migration's own `ADD CONSTRAINT`/`CREATE INDEX` statements would then fail on the existing names, so this variant requires a reviewed copy of the migration with those statements guarded by `IF NOT EXISTS`/skipped, applied via `prisma migrate resolve`. Do this only with a rehearsal; the default recommendation is the window.

Open: a deploy-time guard that refuses to run this migration on a database with a large `journal_lines` unless the operator passes an explicit acknowledgement is not implemented. The pipeline already takes a pre-migration dump and probes pending migrations (`deploy/deploy.ts` `probeMigrationState`), so the guard would extend that probe.

## 12b. Runbook: applying `20261109210000_ledger_query_and_index_optimization` to a populated database (2026-11-10)

Fresh and small databases need nothing special. On a populated ledger the migration's index builds are plain `CREATE INDEX`: a migration runs as one transaction, and `CONCURRENTLY` is refused both inside a transaction and on a partitioned parent, so a build blocks ledger writes for its whole duration. Since 2026-11-10 every build is skipped when the index already has its target definition, so build them online first, then deploy.

1. `journal_entries` (not partitioned), with `psql` outside a transaction:

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "journal_entries_created_at_idx" ON "journal_entries" ("created_at") INCLUDE ("id", "ref_type", "ref_id");
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "journal_entries_trgm_search_idx" ON "journal_entries" USING gin ("ref_id" gin_trgm_ops, "description" gin_trgm_ops);
   ```

2. `journal_lines` (partitioned): for each of the two indexes, create the parent index `ON ONLY` (instant, invalid), build every partition's index `CONCURRENTLY` and attach it (the parent becomes valid once every partition is attached), then swap the names. For `journal_lines_entry_id_created_at_idx`:

   ```sql
   CREATE INDEX journal_lines_entry_cov_new ON ONLY journal_lines (entry_id, created_at) INCLUDE (gl_account_id, direction, amount, id);
   -- for every partition P: SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass;
   CREATE INDEX CONCURRENTLY <P>_entry_cov_new ON <P> (entry_id, created_at) INCLUDE (gl_account_id, direction, amount, id);
   ALTER INDEX journal_lines_entry_cov_new ATTACH PARTITION <P>_entry_cov_new;
   -- once indisvalid is true for journal_lines_entry_cov_new (a brief ACCESS EXCLUSIVE, no scan):
   DROP INDEX journal_lines_entry_id_created_at_idx;
   ALTER INDEX journal_lines_entry_cov_new RENAME TO journal_lines_entry_id_created_at_idx;
   ```

   Repeat for `journal_lines_account_id_cov_idx` with `(gl_account_id, created_at) INCLUDE (direction, amount, entry_id, id)`. A partition created while this runs needs its own build and attach before the parent is valid.

3. Deploy. The migration finds the target definitions (`NOTICE ... already has its target definition; not rebuilt`) and only applies the autovacuum settings, redefines `ensure_journal_line_partitions` and ensures the partitions. `lock_timeout = 10s` makes it fail fast instead of queueing postings behind its locks; rerun the deploy if it times out. A month whose rows already sit in `journal_lines_default` is skipped with a WARNING: move those rows out of the default partition, then the next `JournalPartitionWorker` run creates it.

These steps, the guard and the resilient function were rehearsed on embedded PostgreSQL 17 (PGlite) through the real `prisma migrate deploy`; rehearse on a restored PostgreSQL 18 backup before a production run.

## Remediation round 2 (2026-11-08): session revocations

## 13. Session revocations (schema version 15)

`20261108100000_session_revocations` adds the `session_revocations` model (`jti`, `expires_at`) and bumps `REQUIRED_SCHEMA_VERSION` to 15. `revokeSession` writes Redis (atomic `SET ... PX`) and the table; `isSessionRevoked` reads Redis first and the table when Redis misses or is down. Expired rows are deleted opportunistically on later revocations. `20261108090000_partition_truncate_guard` was amended (it is unreleased) so `pgw_guard_journal_line_partition` also grants the app role its DML on each partition and revokes UPDATE/DELETE/TRUNCATE, because partitions created by the cron run as `postgres` and do not inherit the owner's default privileges.

## 14. Automation migrations (schema versions 16 to 24, 2026-11-09)

- `20261109110000_refund_inquiry_job_type` adds `BackgroundJobType.REFUND_INQUIRY` (AUTO-20).
- `20261109120000_outbox_dead_letter_worker_cursors` (version 16, AUTO-02 and AUTO-25): `outbox_events.attempts`, `last_error`, `parked_at` (parked rows keep `processed_at` NULL and stay in the partial index `outbox_events_unprocessed_idx`) and the `worker_cursors` table (`name`, `cursor_value`, `updated_at`). Both are declared in `schema.prisma` (`OutboxEvent`, `WorkerCursor`); the migration had originally been written without them, which the schema-fidelity suite caught.
- `20261109130000_journal_partition_worker` (version 17, AUTO-01): `ensure_journal_line_partitions(months_ahead)` becomes `SECURITY DEFINER` with a pinned `search_path`, refuses `months_ahead` outside 1..60, and `EXECUTE` is revoked from `PUBLIC` and granted to `pgw_app`, so the application role can call it from `JournalPartitionWorker` while the deploy cron (a superuser) keeps calling the same function. Rows stranded in `journal_lines_default` are moved by the operator script `scripts/repair-journal-default-partition.ts` (maintenance role, one transaction, dry run by default).
- `20261109140000_expiry_housekeeping` (version 18, AUTO-05 and AUTO-11): `ApprovalState.EXPIRED` (final), and two PARTIAL indexes: `notifications_secret_payload_idx` (finished notifications that still carry a sealed MFA code or invitation token) and `payment_links_pending_expiry_idx` (PENDING links with an expiry). The partial indexes are migration-only (Prisma cannot express them).
- `20261109150000_deadline_stages` (version 19, AUTO-04 and AUTO-22): the `deadline_stages` table (`subject_type`, `subject_id`, `stage`, `fired_at`, `detail_json`; primary key = the three identifying columns), the exactly-once marker of the deadline worker.
- `20261109160000_reconciliation_automation` (version 20, AUTO-23): `reconciliation_items.row_type` (nullable text, the parsed statement row type).
- `20261109170000_kyb_scan_automation` (version 21, AUTO-06): `kyb_documents.av_scanned_at`, `av_engine`, `av_signature`, `av_scan_attempts` (default 0), `av_next_scan_at` (claim lease / retry time), `av_last_error`; partial indexes `kyb_documents_pending_scan_idx` (PENDING) and `kyb_documents_clean_rescan_idx` (CLEAN).
- `20261109180000_audit_chain_anchors` (version 22, AUTO-27): table `audit_chain_anchors` (`last_seq_no` unique, `last_row_hash`, `rows_verified_total`, `rows_verified_this_run`, `key_id`, HMAC `signature`) with an append-only trigger (UPDATE and DELETE raise).
- `20261109190000_regulatory_report_automation` (version 23, AUTO-16): `regulatory_reports.due_at`, `report_code`, `period_key` with the partial unique index `regulatory_reports_code_period_key` (one draft per scheduled return and period) and the partial index `regulatory_reports_open_due_idx` (unfiled reports by due date); seeds four PROVISIONAL `reporting_rules` rows (`PSP-M`, `AML-Q`, `AML-A`, `LTR`) with fixed ids, `ON CONFLICT DO NOTHING`.
- `20261109200000_merchant_webhooks` (version 24, AUTO-34): `merchant_webhook_endpoints` (per application and merchant: `url`, `event_types` (empty = all), `status` ACTIVE or DISABLED with `disabled_reason`, vault-encrypted `secret_ciphertext` plus the previous secret and its expiry, `failing_since`, last success and failure) and `merchant_webhook_deliveries` (unique `(endpoint_id, event_id)`, the signed `body` text, `status` PENDING, DELIVERED or PARKED, attempts, `next_attempt_at`, last status code, latency and error, `park_reason`; partial index on due PENDING rows).

## 15. Ledger query and index optimisation (schema version 25)

`20261109210000_ledger_query_and_index_optimization` bumps `REQUIRED_SCHEMA_VERSION` to 25 and adds the indexes/tuning the admin ledger queries need. It is applied after the automation migrations; its `ensure_journal_line_partitions` keeps the AUTO-01 security hardening (SECURITY DEFINER, bounded 1..60, app-role EXECUTE) and adds the append-only autovacuum settings for future monthly partitions:

- `journal_entries_created_at_idx` (`created_at` INCLUDE `id, ref_type, ref_id`) for the journal list and the 24-hour summary, and `journal_entries_trgm_search_idx` (GIN on `ref_id`, `description`) for the admin search.
- Covering `journal_lines_entry_id_created_at_idx` (`entry_id, created_at` INCLUDE `gl_account_id, direction, amount, id`) and `journal_lines_account_id_cov_idx` (`gl_account_id, created_at` INCLUDE `direction, amount, entry_id, id`). The key columns are unchanged, so the declared `@@index` parity in the exhaustive schema suite still holds.
- Insert-triggered autovacuum (`autovacuum_vacuum_insert_scale_factor = 0.01`, threshold 1000) on `journal_entries` and every `journal_lines` partition, because append-only tables never receive the UPDATEs that normally refresh the Visibility Map that Index-Only Scans require. `ensure_journal_line_partitions` applies the same settings to future monthly partitions and keeps the truncate guard and `pgw_app` grants/revokes from `20261108090000_partition_truncate_guard`.
- The development baseline `20261103180000_storage_hardening` orders the `journal_lines` columns by alignment width (UUIDs, timestamps, NUMERIC, enum); databases created before this change keep their existing physical order (the new migration does not rewrite the table).

Operationally, the migration drops and rebuilds the two `journal_lines` indexes on the partitioned parent, which takes an `ACCESS EXCLUSIVE` lock on every partition for the duration of each build. It is a direct migration because the project has no live production data; on a populated database, run it in a maintenance window (the same operational rule as the shard-checkpoint migration in section 12).

The query rules that depend on these indexes are in `core.ledger` section 3.11 and `core-back/README.md` section 3.1.

## 16. Report engine schema (schema version 26, 2026-11-09)

`20261110120000_dynamic_report_engine_sdk` adds the report-engine registry and bumps `REQUIRED_SCHEMA_VERSION` to 26. It defines `ReportSpecStatus`, `ReportChromeType`, `ReportAudienceScope`, `ReportAuthorityMode`, `report_asset_bundles`, `report_chrome_specs`, `report_definition_specs` and `report_execution_audit`. The partial unique index `report_chrome_specs_one_default_per_type_idx` permits only one published global default header and one footer. The four models are listed in `core.report-engine` section 6.

## 17. Report engine hardening and merchant execution (schema version 27, 2026-11-09)

`20261110130000_report_engine_merchant_and_aml` adds `report_definition_specs.allow_confidential_aml_bypass` (default false), a partial unique index on `report_definition_specs(code) WHERE is_latest_published = true`, and append-only triggers on `report_execution_audit`. The AML bypass is only applied after a different MLRO or Security Admin approves a `REPORT_AML_BYPASS` approval request. The merchant report API forces `merchant_scope_input_key` from the authenticated merchant and rejects any non-merchant-scopable model.

## 18. Declarative regulatory reporting (schema version 28, 2026-11-10)

`20261110140000_declarative_regulatory_reporting` adds the format-aware reporting engine:

- Enums `ReportOutputFormat` (`XML`, `XLSX`), `RegulatorySchemaStatus` (`DRAFT`, `PROVISIONAL`, `PENDING_APPROVAL`, `CONFIRMED`, `SUPERSEDED`, `ARCHIVED`) and `ReportOutputValidationStatus` (`NOT_GENERATED`, `PROVISIONAL_SCHEMA`, `VALIDATED`, `INVALID`).
- `regulatory_report_schemas` (authority, report type, format, schema code/name/version, lifecycle status, XSD text or workbook JSON, optional encrypted uploaded template, compiled AST/workbook, mapping blueprint, sample context, approval link, seed key; unique `(authority, schema_code, version)`).
- `regulatory_schema_default_bindings` (authority, report type, report code, format -> schema; unique together), `regulatory_rule_schema_bindings` (rule + format -> schema), and `regulatory_report_outputs` (report, format, revision, schema id/version, encrypted content, SHA-256, validation status/errors, generated/submitted times, superseded time; unique `(report_id, format, revision)` and a partial unique current-output index).
- `reporting_rules.required_output_formats` and `primary_output_format`; `regulatory_reports.required_output_formats`, `filing_channel`, `acknowledged_at`, `rejection_reason`, `supersedes_id`; and a full `due_at` index. `regulatory_report_schemas.revision`, `cloned_from_schema_id`, `mapping_sha256`, `compiled_from_sha256`; `regulatory_report_outputs.payload_sha256`; `regulatory_reports.aml_case_id` is no longer unique and has a normal index. A database trigger blocks definition/mapping/compiled/template changes once a schema leaves `DRAFT`. Existing scheduled rules/reports are backfilled by `returnCode`/`reportCode`.
- The baseline provisional schemas/templates are inserted lazily by `ensureBaselineReportingSchemas` (`cbl-goaml-str-v1`, `cbl-goaml-ltr-v1`, `cbl-psp-m-v1`, `cbl-aml-q-v1`, `cbl-aml-a-v1`, `cbl-goaml-ltr-xlsx-v1`) and their default bindings. They are `PROVISIONAL`; a confirmed FIU XSD/CBL workbook must be uploaded and promoted before XML filing.

## 19. Reporting Studio phases 2-5 (schema versions 29 to 32, 2026-11-10)

- `20261110150000_report_template_binding` (version 29): `regulatory_report_schemas.template_binding_json` stores the visual named-range mapping for an uploaded XLSX template. The column is separate from `template_ciphertext` so the encrypted workbook and its mapping can be rotated independently; the template upload route validates the zip, rejects macros/external links/OLE/zip bombs and audits the SHA-256.
- `20261110160000_incident_management` (version 30): `ReportingType.INCIDENT`; enums `IncidentSeverity`, `IncidentStatus`, `IncidentCategory`, `IncidentImpactScope`, `IncidentTimelineType`, `IncidentActionStatus`, `IncidentCommunicationChannel`, `IncidentLinkType`; tables `incidents`, `incident_timeline_entries`, `incident_responders`, `incident_action_items`, `incident_links`, `incident_communications`. The lifecycle is DETECTED -> TRIAGED/DECLARED -> CONTAINED -> MONITORING -> RESOLVED -> POSTMORTEM -> CLOSED, with timestamp columns and postmortem due dates for SEV1/SEV2, security and data-integrity incidents.
- `20261110170000_docx_report_output` (version 31): adds `ReportOutputFormat.DOCX`. `DocxNarrativeSchema` sections are rendered by the pure-JS OOXML builder; the output is stored encrypted under the `reporting-docx` context and downloaded as `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- `20261110180000_external_filing_adapters` (version 32): `FilingAdapterKind`, `FilingAdapterStatus`, `ExternalSubmissionStatus`; `external_filing_adapters` (name, authority, MANUAL/HTTP, status, HTTPS endpoint, encrypted auth secret, timeout, config) and `external_submissions` (report, adapter, status, request SHA-256, external reference, response code/body, error). The HTTP adapter rejects non-HTTPS, private/loopback/link-local endpoints, embedded credentials and redirects; the manual adapter remains the default.

The reporting baseline set now includes a PROVISIONAL `cbl-incident-docx-v1` default binding for `CBL / INCIDENT / INC / DOCX`. As with the other provisional baselines, the incident output cannot be filed until the schema is reviewed and confirmed.

## 16. Merchant report authoring line (schema version 33)

`20261110190000_merchant_report_engine` adds five tables separate from the staff report registry: `merchant_report_specs` (merchant-owned versioned specs; unique `(merchant_id, code, version)` and a partial unique latest-published index), `merchant_report_asset_bundles` (unique per merchant and content hash), `merchant_report_execution_audit` (append-only trigger), `merchant_report_rate_events` (hourly verify/execute counters) and `merchant_report_studio_status` (per-merchant Studio suspension). The migration bumps the schema version to 33; `phase1-mtls-and-schema.test.ts` asserts the applied version.
