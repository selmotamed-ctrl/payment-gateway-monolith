# Stale Claims Register

This register records known false, outdated or misleading claims in historical `design/**` documents and in old READMEs. Historical documents remain in place as lineage; this register defines the current truth.

| ID | Historical claim | Actual current behavior | Canonical destination | Status |
| :--- | :--- | :--- | :--- | :--- |
| SC-001 | 64 tables / 100 enums | 75 models / 105 enums, schema version 8 | `parts/01-core-back/07-data-schema-and-migrations.md` | FIXED |
| SC-002 | 13-state attempt lifecycle | 14 statuses | `parts/01-core-back/02-engine.md` | FIXED |
| SC-003 | 10-phase engine executes all phases | 10 declarative names; 7 runtime phases + separate credential check; CAPTURE/SETTLEMENT_FETCH reserved | `parts/01-core-back/02-engine.md` | FIXED |
| SC-004 | 15 worked ledger templates | 17 `LedgerScenario` values | `parts/01-core-back/03-ledger.md` | FIXED |
| SC-005 | 10 GL account types | 11 (includes `GATEWAY_FEE_EXPENSE`) | `parts/01-core-back/03-ledger.md` | FIXED |
| SC-006 | 36 transform operations | 39 operations | `parts/01-core-back/02-engine.md` | FIXED |
| SC-007 | One storage migration creates shards/outboxes/tables | Tables are in the baseline; storage migration adds indexes; hardening adds partitions/constraints/indexes | `parts/01-core-back/06-storage-engine.md` | FIXED |
| SC-008 | `rm_merchant_dashboard_stats`, `rm_wallet_statements` | `rm_merchant_daily_stats`, `rm_route_daily_volumes`; no wallet statements model | `parts/01-core-back/06-storage-engine.md` | FIXED |
| SC-009 | Ledger outbox drives read models | `ledger.entry_posted` handler is a no-op; only `attempt.transitioned` projects | `parts/01-core-back/06-storage-engine.md` | FIXED |
| SC-010 | All dashboards/lists/exports read replicas | Only global search and three merchant list endpoints use `readStore` | `parts/01-core-back/06-storage-engine.md` | FIXED |
| SC-011 | Keyset pagination in `listQuery` | Offset pagination with `skip/take` | `parts/01-core-back/01-api-surface.md` | FIXED |
| SC-012 | Audit shipper deletes shipped rows | Marks `shipped_at`; rows are retained | `parts/01-core-back/06-storage-engine.md` | FIXED |
| SC-013 | Weekly drill Sunday 03:00 Tripoli; hourly Redis BGSAVE | Scheduler is UTC, full/delta/drill only; Redis is part of triggered backups | `parts/01-core-back/09-backup-control.md` | FIXED |
| SC-014 | Backup certs ready for daemon mTLS | Certs are generated/distributed; ownership/consumption needs staging verification | `parts/07-deploy/06-backup-daemon.md` | OPEN |
| SC-015 | Deploy prunes in step 13 | Pruning happens inside `deployService`; step 13 only logs | `parts/07-deploy/04-pipeline.md` | FIXED |
| SC-016 | PM2 templates are used | Templates exist but `deploy.ts` generates PM2 config inline | `parts/07-deploy/04-pipeline.md` | FIXED |
| SC-017 | Storage mTLS is provisioned end to end | Certs are generated but PostgreSQL/Redis configs do not consume them | `parts/07-deploy/05-storage-provisioners.md` | OPEN |
| SC-018 | 36 admin routes / 15 merchant routes | 37 protected admin routes / 16 merchant portal routes | `parts/03-admin-front/01-route-and-page-catalog.md` | FIXED |
| SC-019 | Guide v2 14 books/125 articles is current | Current guide is 12 books/8 academy modules; guide v2 is future | `parts/09-future-and-unimplemented/01-guide-v2.md` | FIXED |
| SC-020 | Fake Rails has 20 fully working gateways and all modes/phases | 20 descriptors, 13 seeded core gateways, route/credential/protocol gaps | `parts/06-fake-rails/**` | OPEN |
| SC-021 | Voucher system exists | Entirely absent | `parts/09-future-and-unimplemented/00-voucher-provider-system.md` | FIXED |
| SC-022 | 38,500+ exhaustive assertions | 1,778 literal test declarations; many suites mocked/skipped/missing | `parts/08-testing/01-suite-catalog.md` | FIXED |
| SC-023 | `SCALING_FEATURE.md` describes current app scaling | App scaling was removed; files are stale | `parts/03-admin-front/00-ui-system.md` | FIXED |
| SC-024 | `notes.md` is service documentation | Identical unrelated scratch notes | deleted | FIXED |
| SC-025 | Google OIDC login is supported | Merchant `/auth/google` returns 501 | `parts/02-edge-services/02-merchant-back.md` | FIXED |
| SC-026 | Every request re-checks MFA/revocation/IP allowlist | Core checks JWT/user/authorities; per-call MFA/revocation/admin IP are not enforced | `parts/00-platform/02-security-and-mtls.md` | FIXED |
| SC-027 | Inbound webhooks are queued and acked before verification | Current checkout verifies synchronously before ack | `parts/01-core-back/01-api-surface.md` | FIXED |
| SC-028 | SSE streams subscribe to transition bus | Checkout/POS SSE poll the DB | `parts/02-edge-services/**` | FIXED |
| SC-029 | `inbound_events` are never deleted | Retention worker purges them after the cutoff | `parts/01-core-back/05-workers.md` | FIXED |
| SC-030 | Seeder seeds all 66 models and all 15 templates | 55 collections, 9 generators, only payment/adjustment ledger refs | `parts/01-core-back/10-synthetic-seeder.md` | FIXED |
