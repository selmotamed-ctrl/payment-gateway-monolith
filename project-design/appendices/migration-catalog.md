# Migration Catalog

<!-- GENERATED FILE. Edit core-back/prisma/migrations/** instead. Do not hand-edit this file. -->

| Migration | Lines | First comment |
| :--- | ---: | :--- |
| `20261103000000_postgres18_init` | 2839 | PostgreSQL 18 baseline. Replaces the legacy MySQL migration history. |
| `20261103120000_postgres18_storage_engine` | 115 | ============================================================================ |
| `20261103130000_cqrs_read_models` | 27 | CQRS read models maintained asynchronously by OutboxRelayWorker. |
| `20261103180000_storage_hardening` | 256 | ============================================================================ |
| `20261104090000_db_read_write_optimisation` | 97 | ============================================================================ |
| `20261104120000_mfa_challenges` | 51 | ============================================================================ |
| `20261105090000_append_only_ledger_guards` | 158 | ============================================================================ |
| `20261105130000_statement_unique_source_file_hash` | 33 | GAP-018: statement file hashes are unique per statement source, not globally. |
| `20261107090000_shard_sequenced_checkpoints` | 174 | ============================================================================ |
| `20261107120000_inbound_event_claims` | 22 | Lease-based claim for the inbound webhook inbox. |
| `20261107150000_shard_repairs` | 53 | ============================================================================ |
| `20261108090000_partition_truncate_guard` | 81 | Partitions created after 20261105090000_append_only_ledger_guards had no TRUNCATE guard. |
| `20261108100000_session_revocations` | 25 | Durable copy of the session revoke list. |
