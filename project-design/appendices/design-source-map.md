# Design Source Map

Every historical design file must map to a canonical part or be explicitly marked `HISTORICAL`, `SUPERSEDED` or `FUTURE`.

| Historical source | Disposition | Canonical destination |
| :--- | :--- | :--- |
| `design/01-platform-architecture/payment_gateway_final_design-v5.md` | Historical narrative; extract current intent, replace stale schema/API/state counts | `parts/00-platform/**`, `parts/01-core-back/**` |
| `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` | Historical predecessor; extract onboarding/AML/dispute detail not in v5 | `parts/01-core-back/04-governance-compliance.md`, historical appendix |
| `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` | Historical research/design | `parts/00-platform/00-overview.md`, historical appendix |
| `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` | Delivery tracker / historical verification log | `TRACKER.md`, `parts/01-core-back/11-tests-and-benchmarks.md` |
| `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` | Design source; correct as-built details | `parts/07-deploy/**`, `parts/03-admin-front/03-guide-and-academy.md` |
| `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` | Authoritative intent for storage/backup/scaling; correct DDL/LSN/read-model drift | `parts/01-core-back/06-storage-engine.md`, `09-backup-control.md`, `parts/07-deploy/**` |
| `design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md` | Active backup-engine reliability and test design | `parts/07-deploy/06-backup-daemon.md`, `parts/01-core-back/09-backup-control.md`, `parts/08-testing/01-suite-catalog.md` |
| `design/06-ui/admin_front_complete_feature_and_missing_pages_plan.md` | Implemented admin-front completion plan (fields re-grounded against the real schema) | `parts/03-admin-front/00-ui-system.md`, `01-route-and-page-catalog.md`, `02-tables-filters-exports.md` |
| `design/02-storage-and-performance/ledger_scaling_partition_pruning_and_archive_anchor_plan.md` | Implemented 2026-11-09 (OPT-1..OPT-7): journal_entries indexes, covering journal_lines indexes, insert-autovacuum, partition pruning, single-pass totals, checkout receivable short-circuit, query rules | `parts/01-core-back/03-ledger.md`, `06-storage-engine.md`, `07-data-schema-and-migrations.md`, `parts/08-testing/01-suite-catalog.md` |
| `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md` | Design source; document actual 20-provider implementation and gaps | `parts/01-core-back/08-search.md`, `parts/03-admin-front/**` |
| `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md` | Design source; correct to 55 collections / 9 generators / actual safety gate | `parts/01-core-back/10-synthetic-seeder.md` |
| `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` | Design source; document protocol/chaos/portal and current gaps | `parts/06-fake-rails/**` |
| `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` | Implemented baseline for guide/academy | `parts/03-admin-front/03-guide-and-academy.md`, `parts/04-merchant-front/01-guide-and-developer-api.md` |
| `design/07-guides-and-academy/guide_system_design_and_content.md` | Implemented as Admin Guide v1.0 (content extracted into `admin-front/src/content/guide/generated/`); stale DB statements corrected | `parts/03-admin-front/06-guide-v2.md` |
| `design/07-guides-and-academy/academy_system_design_and_content.md` | Academy spec (Parts 0-II) and content (Part III); implemented 2026-11-04 | `parts/03-admin-front/03-guide-and-academy.md` |
| `design/07-guides-and-academy/guide_content_fixes.md` | Implementation log of label/route-map corrections | `parts/03-admin-front/06-guide-v2.md` |
| `design/07-guides-and-academy/guide_content_questions.md` | Open behaviour questions found during implementation | `parts/03-admin-front/06-guide-v2.md` |
| `design/07-guides-and-academy/academy_content_fixes.md` | Implementation log of Academy label/route-map/spec corrections | `parts/03-admin-front/03-guide-and-academy.md` |
| `design/07-guides-and-academy/academy_content_questions.md` | Open Academy behaviour questions found during implementation | `parts/03-admin-front/03-guide-and-academy.md` |
| `design/07-guides-and-academy/guide_academy_and_companion_clarity_overhaul_plan.md` | Implemented 2026-11-07 against the current 128-article/50-lesson tree; the plan's verbatim replacements target an older snapshot and were adapted, not copied | `parts/03-admin-front/03-guide-and-academy.md`, `parts/10-companion/00-offline-companion.md`, `parts/08-testing/01-suite-catalog.md` |
| `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` | SUPERSEDED by v2 (`design/06-ui/..._2.md`); UI design source; correct route counts and actual primitives | `parts/03-admin-front/00-ui-system.md` |
| `design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md` | UI v2 design source | `parts/03-admin-front/00-ui-system.md`, `02-tables-filters-exports.md` |
| `design/06-ui/pg_companion_offline_android_app.md` | Active design for the offline PG Companion Android app | `parts/10-companion/00-offline-companion.md` |
| `design/06-ui/portal_ui_implementation_plan.md` | As-built UI execution record | `parts/03-admin-front/**`, `TRACKER.md` |
| `design/05-testing/master_exhaustive_test_plan_for_opencode.md` | Test strategy source; correct counts and missing suites | `parts/08-testing/**` |
| `design/90-archive/superseded-testing/two_machine_multi_topology_deployment_and_stress_test_plan.md` | SUPERSEDED (2026-11-04) by the JSON-configured multi-machine plan; contained a plaintext lab password — never reuse | `parts/08-testing/04-multi-machine-matrix.md` |
| `design/05-testing/multi_machine_topology_and_stress_test_plan.md` | Active design for the N-machine topology/stress lab | `parts/08-testing/04-multi-machine-matrix.md`, `parts/07-deploy/**` |
| `design/09-voucher-system-external/Voucher-Provider-Management-System-Technical-Design.md` | Not implemented | `parts/09-future-and-unimplemented/00-voucher-provider-system.md` |
| `design/09-voucher-system-external/voucher-system-raw-design.md` | Not implemented raw source | `parts/09-future-and-unimplemented/00-voucher-provider-system.md` |
| `design/08-ai-onboarding/smart_ai_rail_and_voucher_onboarding_plan.md` | Gateway half implemented; voucher half missing | `parts/01-core-back/02-engine.md`, `parts/09-future-and-unimplemented/02-smart-ai-voucher-half.md` |
| `design/00-process/blueprint-management.md` | Active process doc for the generated `project-design/` system | `project-design/README.md`, `scripts/project-design/**` |
| `design/06-ui/merchant_landing_page_redesign.md` | Active design for the merchant public landing page | `parts/04-merchant-front/00-portal.md` |
| `design/90-archive/legacy-deploy-configs/**` | SUPERSEDED hand-written nginx/systemd files; replaced by `deploy/templates/*.tpl` + PM2 | `parts/07-deploy/04-pipeline.md` |
| `design/10-fixes/_0001_operator_cases.md` | Implemented operator-case feature spec | `parts/01-core-back/01-api-surface.md`, `04-governance-compliance.md`, `parts/03-admin-front/01-route-and-page-catalog.md` |
| `design/11-automation/background_automation_and_workers_plan.md` | FUTURE: background automation plan (not implemented); verified against master 2026-11-09 | `parts/01-core-back/05-workers.md`, `TRACKER.md` GAP-066 |
| `design/11-automation/declarative_goaml_xsd_reporting_engine_plan.md` | ACTIVE: XSD/goAML compiler, AST, mapping and studio design; retained by the final format-aware design | `parts/01-core-back/04-governance-compliance.md`, `design/11-automation/declarative_regulatory_reporting_engine_final_design.md` |
| `design/11-automation/declarative_regulatory_reporting_engine_final_design.md` | ACTIVE: format-aware declarative regulatory reporting engine (XML/XSD + XLSX + narrative, schema registry, generation and filing gates); implementation started 2026-11-10 | `parts/01-core-back/04-governance-compliance.md`, `07-data-schema-and-migrations.md`, `05-workers.md`, `parts/03-admin-front/01-route-and-page-catalog.md`, `parts/08-testing/01-suite-catalog.md` |
| `design/11-automation/reporting_studio_and_automation_test_plan.md` | ACTIVE: visual XSD/XLSX studio, schema cloning, code-list translation, reporting bug fixes and full automation test sweep; implementation started 2026-11-10 | `parts/01-core-back/04-governance-compliance.md`, `07-data-schema-and-migrations.md`, `parts/03-admin-front/01-route-and-page-catalog.md`, `parts/08-testing/01-suite-catalog.md`, `TRACKER.md` |
| `design/90-archive/delivery-logs/session-ses_e8c2.md` | Raw session transcript; not authoritative | `TRACKER.md` historical note only |

## Unmapped headings

The generator/check script reports headings in `design/**` that are not represented here or in a part's `design_sources`. Add them before final verification.
