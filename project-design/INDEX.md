# Project Design Index

<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

This is the canonical entrypoint for the payment-gateway project design.

## Authority

- `project-design/parts/**` — editable source of truth.
- `PROJECT_DESIGN.md` — generated centralized verbose master.
- `STATUS.md` — generated implementation status.
- `TRACKER.md` — append-only change, gap, decision and verification log.
- `design/**` — historical/reference only.

## Parts

### 00-platform

- [Platform Overview](parts/00-platform/00-overview.md) — `platform.overview` · `partial`
- [Service Topology](parts/00-platform/01-service-topology.md) — `platform.topology` · `partial`
- [Security and mTLS](parts/00-platform/02-security-and-mtls.md) — `platform.security` · `partial`
- [Runtime and Configuration](parts/00-platform/03-runtime-and-config.md) — `platform.runtime` · `partial`
- [Observability](parts/00-platform/04-observability.md) — `platform.observability` · `partial`

### 01-core-back

- [Core Foundations](parts/01-core-back/00-foundations.md) — `core.foundations` · `partial`
- [Core API Surface](parts/01-core-back/01-api-surface.md) — `core.api` · `partial`
- [Core Engine](parts/01-core-back/02-engine.md) — `core.engine` · `partial`
- [Double-Entry Ledger](parts/01-core-back/03-ledger.md) — `core.ledger` · `partial`
- [Governance and Compliance](parts/01-core-back/04-governance-compliance.md) — `core.governance` · `partial`
- [Background Workers and Outboxes](parts/01-core-back/05-workers.md) — `core.workers` · `partial`
- [Storage Engine](parts/01-core-back/06-storage-engine.md) — `core.storage` · `partial`
- [Data Schema and Migrations](parts/01-core-back/07-data-schema-and-migrations.md) — `core.data` · `partial`
- [Global Search](parts/01-core-back/08-search.md) — `core.search` · `partial`
- [Backup Control](parts/01-core-back/09-backup-control.md) — `core.backup` · `partial`
- [Synthetic Seeder](parts/01-core-back/10-synthetic-seeder.md) — `core.seeder` · `partial`
- [Tests and Benchmarks](parts/01-core-back/11-tests-and-benchmarks.md) — `core.tests` · `partial`

### 02-edge-services

- [Shared Core Upstream Client](parts/02-edge-services/00-shared-core-upstream-client.md) — `edge.shared` · `implemented`
- [Admin Edge BFF](parts/02-edge-services/01-admin-back.md) — `edge.admin` · `partial`
- [Merchant Edge BFF](parts/02-edge-services/02-merchant-back.md) — `edge.merchant` · `partial`
- [Checkout Edge BFF](parts/02-edge-services/03-checkout-back.md) — `edge.checkout` · `partial`

### 03-admin-front

- [Admin UI System](parts/03-admin-front/00-ui-system.md) — `admin-ui.system` · `partial`
- [Admin Route and Page Catalog](parts/03-admin-front/01-route-and-page-catalog.md) — `admin-ui.routes` · `partial`
- [Tables Filters and Exports](parts/03-admin-front/02-tables-filters-exports.md) — `admin-ui.tables` · `partial`
- [Admin Guide and Academy](parts/03-admin-front/03-guide-and-academy.md) — `admin-ui.guide` · `partial`
- [Contextual Help](parts/03-admin-front/04-contextual-help.md) — `admin-ui.help` · `implemented`
- [Backups Settings and Operations](parts/03-admin-front/05-backups-settings-and-operations.md) — `admin-ui.operations` · `partial`
- [Admin Guide v2](parts/03-admin-front/06-guide-v2.md) — `admin-ui.guide-v2` · `implemented`

### 04-merchant-front

- [Merchant Portal](parts/04-merchant-front/00-portal.md) — `merchant-ui.portal` · `partial`
- [Merchant Guide and Developer API](parts/04-merchant-front/01-guide-and-developer-api.md) — `merchant-ui.guide` · `partial`

### 05-checkout-front

- [Checkout Payer Flow](parts/05-checkout-front/00-payer-flow.md) — `checkout-ui.flow` · `partial`
- [Checkout Help Center](parts/05-checkout-front/01-help-center.md) — `checkout-ui.help` · `partial`

### 06-fake-rails

- [Fake Rails Backend Architecture](parts/06-fake-rails/00-backend-architecture.md) — `fake-rails.backend` · `partial`
- [Fake Rails Protocol Matrix](parts/06-fake-rails/01-protocol-matrix.md) — `fake-rails.protocol` · `partial`
- [Fake Rails Chaos Engine and Tester Portal](parts/06-fake-rails/02-chaos-and-tester-portal.md) — `fake-rails.chaos` · `partial`
- [Core Integration and Deployment](parts/06-fake-rails/03-core-integration.md) — `fake-rails.integration` · `partial`

### 07-deploy

- [Deploy Topology and Configuration](parts/07-deploy/00-topology-and-config.md) — `deploy.topology` · `partial`
- [Host Planner](parts/07-deploy/01-host-planner.md) — `deploy.planner` · `implemented`
- [Internal PKI and mTLS Certificates](parts/07-deploy/02-pki.md) — `deploy.pki` · `partial`
- [Firewall Policy and Application](parts/07-deploy/03-firewall.md) — `deploy.firewall` · `partial`
- [Deployment Pipeline](parts/07-deploy/04-pipeline.md) — `deploy.pipeline` · `partial`
- [Storage Provisioners](parts/07-deploy/05-storage-provisioners.md) — `deploy.storage` · `partial`
- [Backup Daemon](parts/07-deploy/06-backup-daemon.md) — `deploy.backup` · `partial`
- [Health Verification, Rollback and Recovery](parts/07-deploy/07-health-rollback-and-recovery.md) — `deploy.health` · `partial`

### 08-testing

- [Testing Strategy](parts/08-testing/00-strategy.md) — `testing.strategy` · `partial`
- [Test Suite Catalog](parts/08-testing/01-suite-catalog.md) — `testing.suites` · `partial`
- [Fixtures, Mock API and Live Stack](parts/08-testing/02-fixtures-and-live-stack.md) — `testing.fixtures` · `partial`
- [Benchmarks and Performance Gates](parts/08-testing/03-benchmarks.md) — `testing.benchmarks` · `partial`
- [Two-Machine Multi-Topology Matrix](parts/08-testing/04-two-machine-matrix.md) — `testing.two-machine-matrix` · `partial`

### 09-future-and-unimplemented

- [Voucher Provider Management System (Future)](parts/09-future-and-unimplemented/00-voucher-provider-system.md) — `future.voucher` · `missing`
- [Smart AI Spec Importer and Voucher Half (Future)](parts/09-future-and-unimplemented/02-smart-ai-voucher-half.md) — `future.smart-ai-voucher` · `missing`
- [Deferred and Partial Features](parts/09-future-and-unimplemented/03-deferred-features.md) — `future.deferred` · `deferred`

## Generated artifacts

- [PROJECT_DESIGN.md](PROJECT_DESIGN.md)
- [STATUS.md](STATUS.md)
- [TRACKER.md](TRACKER.md)
- [schema catalog](appendices/schema-catalog.md)
- [migration catalog](appendices/migration-catalog.md)
- [API route matrix](appendices/api-route-matrix.md)
- [environment matrix](appendices/env-and-config-matrix.md)
- [test inventory](appendices/test-inventory.md)
- [design source map](appendices/design-source-map.md)
- [stale claims register](appendices/stale-claims-register.md)
