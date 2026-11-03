# Manual SQL register

Source of truth: `core-back/prisma/schema.prisma` plus the baseline migration
managed by main. This file lists **only** the SQL that Prisma cannot express.
Every entry must be present in the baseline (or in a later small migration)
before the schema lint test of `high_scale_db_architecture_v2.md` §5.4 can pass.

The statements below are written as the expected manual edits, not as measured
results. Main owns the migration files; this register is the review checklist.

## 1. Identifier collation

Prisma cannot declare a column collation. Every application identifier exposed
through the API and every foreign-key column that references one is
`CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`. This applies to `id` and FK
columns on the entity tables, including at least:

- `merchants`, `users`, `applications`, `wallets`, `access_tokens`,
  `access_token_ips`, `payment_links`, `pos_terminals`, `pos_screens`;
- `gl_accounts`, `gl_balance_shards`, `gl_period_totals`, `journal_entries`,
  `journal_lines`, `commission_profiles`;
- `gateways`, `gateway_versions`, `gateway_environments`, `gateway_auth`,
  `gateway_settings`, `credential_sets`, `rails`, `rail_routes`, `crypto_profiles`,
  `flows`, `flow_steps`, `status_rules`, `error_maps`, `confirmation_channels`;
- `attempt_groups`, `payment_attempts`, `attempt_step_logs`, `inbound_events`,
  `attempt_deadlines`, `velocity_counters`, `route_daily_volumes`,
  `merchant_daily_stats`;
- `background_jobs`, `reconciliation_runs`, `reconciliation_items`,
  `operator_cases`, `join_requests`, `kyb_documents`, `beneficial_owners`,
  `aml_screenings`, `aml_cases`, `regulatory_reports`, `disputes`,
  `notifications`, `platform_settings`, `audit_log`, and their payload child
  tables.

The four append-only mega-tables use `BIGINT UNSIGNED AUTO_INCREMENT` for
`id` instead: `journal_lines`, `audit_log`, `attempt_step_logs`,
`inbound_events` (and, where the baseline keeps a surrogate, the payload
tables that follow the same rule).

Representative manual form (the baseline already contains the generated
column definitions):

```sql
ALTER TABLE `payment_attempts`
  MODIFY COLUMN `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY COLUMN `link_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
```

The collation lint check reads `information_schema.COLUMNS` and fails any
`CHAR(36)` id/FK column whose `CHARACTER_SET_NAME` is not `ascii` or whose
`COLLATION_NAME` is not `ascii_bin`.

## 2. Ledger checks and immutability triggers

```sql
ALTER TABLE `journal_lines`
  ADD CONSTRAINT `journal_lines_amount_positive`
  CHECK (`amount` > 0);
```

```sql
CREATE TRIGGER `journal_lines_no_update`
BEFORE UPDATE ON `journal_lines`
FOR EACH ROW
BEGIN
  IF COALESCE(@pg_allow_ledger_mutation, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LEDGER_IMMUTABLE';
  END IF;
END;

CREATE TRIGGER `journal_lines_no_delete`
BEFORE DELETE ON `journal_lines`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'LEDGER_IMMUTABLE';

CREATE TRIGGER `journal_entries_no_update`
BEFORE UPDATE ON `journal_entries`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'LEDGER_IMMUTABLE';

CREATE TRIGGER `journal_entries_no_delete`
BEFORE DELETE ON `journal_entries`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'LEDGER_IMMUTABLE';
```

The baseline also contains the domain guards that the v2 ledger relies on:

```sql
ALTER TABLE `attempt_groups`
  ADD CONSTRAINT `attempt_groups_single_success` CHECK (`success_count` <= 1);

ALTER TABLE `payment_links`
  ADD CONSTRAINT `payment_links_slot_reservation_invariant`
  CHECK (`infinite_use` = 1 OR `confirmed_count` + `active_locked_count` <= `use_count`);

CREATE TRIGGER `approval_requests_checker_not_maker` BEFORE INSERT ON `approval_requests`
FOR EACH ROW
BEGIN
  IF NEW.checker_user_id IS NOT NULL AND NEW.checker_user_id = NEW.maker_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checker_user_id must differ from maker_user_id';
  END IF;
END;
CREATE TRIGGER `approval_requests_checker_not_maker_update` BEFORE UPDATE ON `approval_requests`
FOR EACH ROW
BEGIN
  IF NEW.checker_user_id IS NOT NULL AND NEW.checker_user_id = NEW.maker_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checker_user_id must differ from maker_user_id';
  END IF;
END;
```

The lint test checks the trigger names and that an `UPDATE`/`DELETE` on each
ledger table is rejected. Test and maintenance sessions may set
`SET @pg_allow_ledger_mutation = 1` inside the same transaction before a
deliberate cleanup delete.

## 3. Database users and grants

The application user may read and append ledger rows but may not rewrite or
delete them. The migration user is a different account.

```sql
-- Application runtime account: normal DML elsewhere.
GRANT SELECT, INSERT, UPDATE, DELETE ON `payment_gateway_prod`.* TO 'app_rw'@'%';

-- Ledger tables: append-only at the grant level too.
REVOKE UPDATE, DELETE ON `payment_gateway_prod`.`journal_entries` FROM 'app_rw'@'%';
REVOKE UPDATE, DELETE ON `payment_gateway_prod`.`journal_lines` FROM 'app_rw'@'%';
GRANT SELECT, INSERT ON `payment_gateway_prod`.`journal_entries` TO 'app_rw'@'%';
GRANT SELECT, INSERT ON `payment_gateway_prod`.`journal_lines` TO 'app_rw'@'%';

-- Migration account: DDL and ledger maintenance only, not used by the app.
GRANT ALL PRIVILEGES ON `payment_gateway_prod`.* TO 'migrator'@'%';
```

The exact host list and password handling are deployment-specific and belong
to `deploy/deploy.ts`; the grants above are the canonical shape to verify.

## 4. Partitions for log tables

**Status:** the v2 baseline still has foreign keys on these log tables, so the
P8 partition DDL below is **not applied**. It is retained as the reviewed
manual step for the later phase; enabling it requires removing those foreign
keys and adding `created_at` to each primary key first.

When the partition phase (P8) is enabled, the log tables are partitioned by
month on `created_at`, the primary key includes `created_at`, and there are no
foreign keys to or from the partitioned tables (a MariaDB limitation for
partitioned InnoDB). The tables are:

- `audit_log` (+ `audit_log_payloads`),
- `attempt_step_logs`,
- `inbound_events` (+ `inbound_event_payloads`),
- `gateway_health_samples`,
- `cache_invalidation_events`,
- `notifications`.

Representative manual clause (generated per month by the partition job):

```sql
ALTER TABLE `audit_log`
  PARTITION BY RANGE COLUMNS(`created_at`) (
    PARTITION `p2026_11` VALUES LESS THAN ('2026-12-01'),
    PARTITION `p2026_12` VALUES LESS THAN ('2027-01-01'),
    PARTITION `pmax` VALUES LESS THAN (MAXVALUE)
  );
```

Dropping a partition is allowed only after the export manifest (SHA-256 and
row count) is written and verified. Do not drop audit/AML data before the
retention period in `design/db_decisions_needed.md` (D9).

## 5. Row format for large statement files

Statement files up to 25 MB live in the 1:1 child table. The default decision
D3 is to keep them in MariaDB; when the compressed row format is enabled, the
manual clause is:

```sql
ALTER TABLE `reconciliation_run_files`
  ROW_FORMAT=COMPRESSED;
```

`ROW_FORMAT=COMPRESSED` is a performance hypothesis until the file-write
benchmark in Part 5 prints its result. Object storage plus a path/SHA-256 pair
is the alternative if compressed writes are too slow.

## 6. Full-text index

`schema.prisma` declares:

```prisma
@@fulltext([legalName, tradeName], map: "merchants_names_ft_idx")
```

The server-side token setting is part of the MariaDB configuration, not a
table DDL: `innodb_ft_min_token_size = 2` (see `deploy/deploy.ts` and §2.12).
Arabic fixtures are a verification item, not a measured claim.

## 7. Verification queries for the lint test

The schema lint test should assert at least:

```sql
SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND COLUMN_NAME IN ('id')
  AND DATA_TYPE = 'char'
  AND CHARACTER_MAXIMUM_LENGTH = 36;
```

```sql
SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE();
```

No performance number belongs in this file. Measurements go in
`design/db_baseline_results.md` after the P0 harness has actually run.
