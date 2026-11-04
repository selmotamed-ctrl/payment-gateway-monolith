# Design Source Map

Every historical design file must map to a canonical part or be explicitly marked `HISTORICAL`, `SUPERSEDED` or `FUTURE`.

| Historical source | Disposition | Canonical destination |
| :--- | :--- | :--- |
| `design/payment_gateway_final_design-v5.md` | Historical narrative; extract current intent, replace stale schema/API/state counts | `parts/00-platform/**`, `parts/01-core-back/**` |
| `design/payment-gateway-refined-design-v4.1.md` | Historical predecessor; extract onboarding/AML/dispute detail not in v5 | `parts/01-core-back/04-governance-compliance.md`, historical appendix |
| `design/Dynamic-Payment-Gateway-Management-Design-v2.md` | Historical research/design | `parts/00-platform/00-overview.md`, historical appendix |
| `design/opencode_technical_delivery_design.md` | Delivery tracker / historical verification log | `TRACKER.md`, `parts/01-core-back/11-tests-and-benchmarks.md` |
| `design/payment_gateway_deployment_and_guides_architecture.md` | Design source; correct as-built details | `parts/07-deploy/**`, `parts/03-admin-front/03-guide-and-academy.md` |
| `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` | Authoritative intent for storage/backup/scaling; correct DDL/LSN/read-model drift | `parts/01-core-back/06-storage-engine.md`, `09-backup-control.md`, `parts/07-deploy/**` |
| `design/performance-efficiency/deep_search_plugin_architecture_plan.md` | Design source; document actual 20-provider implementation and gaps | `parts/01-core-back/08-search.md`, `parts/03-admin-front/**` |
| `design/synthetic_operational_data_seeder_architecture.md` | Design source; correct to 55 collections / 9 generators / actual safety gate | `parts/01-core-back/10-synthetic-seeder.md` |
| `design/fake_payment_rails_service_architecture.md` | Design source; document protocol/chaos/portal and current gaps | `parts/06-fake-rails/**` |
| `design/complete_zero_to_hero_guides_and_academy_specification.md` | Implemented baseline for guide/academy | `parts/03-admin-front/03-guide-and-academy.md`, `parts/04-merchant-front/01-guide-and-developer-api.md` |
| `design/guide_system_design_and_content (2).md` | Future workstream; not current implementation | `parts/09-future-and-unimplemented/01-guide-v2.md` |
| `design/ui/portal_ui_abstraction_and_modern_fintech_redesign.md` | UI design source; correct route counts and actual primitives | `parts/03-admin-front/00-ui-system.md` |
| `design/ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md` | UI v2 design source | `parts/03-admin-front/00-ui-system.md`, `02-tables-filters-exports.md` |
| `design/ui/portal_ui_implementation_plan.md` | As-built UI execution record | `parts/03-admin-front/**`, `TRACKER.md` |
| `design/master_exhaustive_test_plan_for_opencode.md` | Test strategy source; correct counts and missing suites | `parts/08-testing/**` |
| `design/two-machine-test/two_machine_multi_topology_deployment_and_stress_test_plan.md` | Executable lab plan; implementation and live-execution gaps recorded | `parts/08-testing/04-two-machine-matrix.md`, `parts/07-deploy/**` |
| `design/Voucher-Provider-Management-System-Technical-Design.md` | Not implemented | `parts/09-future-and-unimplemented/00-voucher-provider-system.md` |
| `design/voucher-system-raw-design.md` | Not implemented raw source | `parts/09-future-and-unimplemented/00-voucher-provider-system.md` |
| `design/smart_ai_rail_and_voucher_onboarding_plan.md` | Gateway half implemented; voucher half missing | `parts/01-core-back/02-engine.md`, `parts/09-future-and-unimplemented/02-smart-ai-voucher-half.md` |
| `design/fixes/_0001_operator_cases.md` | Implemented operator-case feature spec | `parts/01-core-back/01-api-surface.md`, `04-governance-compliance.md`, `parts/03-admin-front/01-route-and-page-catalog.md` |
| `design/session-ses_e8c2.md` | Raw session transcript; not authoritative | `TRACKER.md` historical note only |

## Unmapped headings

The generator/check script reports headings in `design/**` that are not represented here or in a part's `design_sources`. Add them before final verification.
