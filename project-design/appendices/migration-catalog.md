# Migration Catalog

<!-- GENERATED FILE. Edit core-back/prisma/migrations/** instead. Do not hand-edit this file. -->

| Migration | Lines | First comment |
| :--- | ---: | :--- |
| `20261103000000_postgres18_init` | 2839 | PostgreSQL 18 baseline. Replaces the legacy MySQL migration history. |
| `20261103120000_postgres18_storage_engine` | 115 | ============================================================================ |
| `20261103130000_cqrs_read_models` | 27 | CQRS read models maintained asynchronously by OutboxRelayWorker. |
| `20261103180000_storage_hardening` | 259 | ============================================================================ |
| `20261104090000_db_read_write_optimisation` | 97 | ============================================================================ |
| `20261104120000_mfa_challenges` | 51 | ============================================================================ |
| `20261105090000_append_only_ledger_guards` | 158 | ============================================================================ |
| `20261105130000_statement_unique_source_file_hash` | 33 | GAP-018: statement file hashes are unique per statement source, not globally. |
| `20261107090000_shard_sequenced_checkpoints` | 174 | ============================================================================ |
| `20261107120000_inbound_event_claims` | 22 | Lease-based claim for the inbound webhook inbox. |
| `20261107150000_shard_repairs` | 53 | ============================================================================ |
| `20261108090000_partition_truncate_guard` | 81 | Partitions created after 20261105090000_append_only_ledger_guards had no TRUNCATE guard. |
| `20261108100000_session_revocations` | 25 | Durable copy of the session revoke list. |
| `20261109110000_refund_inquiry_job_type` | 7 | AUTO-20: durable follow-up of refunds stuck in EXECUTING. |
| `20261109120000_outbox_dead_letter_worker_cursors` | 42 | ============================================================================ |
| `20261109130000_journal_partition_worker` | 64 | ============================================================================ |
| `20261109140000_expiry_housekeeping` | 30 | ============================================================================ |
| `20261109150000_deadline_stages` | 27 | ============================================================================ |
| `20261109160000_reconciliation_automation` | 17 | ============================================================================ |
| `20261109170000_kyb_scan_automation` | 33 | ============================================================================ |
| `20261109180000_audit_chain_anchors` | 42 | ============================================================================ |
| `20261109190000_regulatory_report_automation` | 47 | ============================================================================ |
| `20261109200000_merchant_webhooks` | 74 | ============================================================================ |
| `20261109210000_ledger_query_and_index_optimization` | 134 | ============================================================================ |
| `20261110090000_resilient_journal_partitions` | 86 | ============================================================================ |
| `20261110120000_dynamic_report_engine_sdk` | 147 | ============================================================================ |
| `20261110130000_report_engine_merchant_and_aml` | 42 | ============================================================================ |
| `20261110140000_declarative_regulatory_reporting` | 188 |  |
| `20261110150000_report_template_binding` | 4 |  |
| `20261110160000_incident_management` | 129 | Incident management (expanded): lifecycle, timeline, responders, actions, links and communications. |
| `20261110170000_docx_report_output` | 4 |  |
| `20261110180000_external_filing_adapters` | 47 |  |
| `20261110190000_merchant_report_engine` | 117 | ============================================================================ |
| `20261111090000_report_tenant_and_filing_integrity` | 91 | ============================================================================ |
