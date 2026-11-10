# Design Library (reference and lineage)

**Canonical design lives in [`../project-design/`](../project-design/INDEX.md).** Code is the authority for as-built behavior; `project-design/parts/**` describes it. The documents here are the *blueprints* the system was built from. They explain intent and history. They are **not** current authority. Where one is wrong or has drifted, it carries a dated *corrections / as-built* note, and the canonical part says what is actually true.

Every file here is mapped in [`../project-design/appendices/design-source-map.md`](../project-design/appendices/design-source-map.md). `bun scripts/project-design/check.ts` fails if a `design/**/*.md` file is unmapped. Known false claims are listed in [`../project-design/appendices/stale-claims-register.md`](../project-design/appendices/stale-claims-register.md).

## Relevance legend

| Tag | Meaning |
| :--- | :--- |
| **ACTIVE** | Still the best statement of *intent* for an implemented area. Read it with the canonical part. |
| **REFERENCE** | Useful background or partly implemented. Check the canonical part before relying on details. |
| **FUTURE** | Describes something not built yet, or a separate system. |
| **ARCHIVE** | Superseded or a raw log. Do not use for new work. |

## Layout

| Folder | File | Relevance | Canonical part(s) |
| :--- | :--- | :--- | :--- |
| `00-process/` | `blueprint-management.md`: how `project-design/` is generated and governed | ACTIVE | `project-design/README.md` |
| `01-platform-architecture/` | `payment_gateway_final_design-v5.md`: master architecture v5 (catalog, flow engine, ledger, KYB/AML/disputes) | REFERENCE (counts and schema stale) | `parts/00-platform/**`, `parts/01-core-back/**` |
| `02-storage-and-performance/` | `storage_driver_postgres18_backup_and_scaling_architecture.md`: PostgreSQL 18 storage engine, CQRS/replicas, backups, scaling | ACTIVE | `parts/01-core-back/06,07,09`, `parts/07-deploy/05,06` |
| | `backup_engine_reliability_architecture_and_test_plan.md`: backup engine reliability and test plan (implemented 2026-11-06) | ACTIVE | `parts/07-deploy/06-backup-daemon.md`, `parts/01-core-back/09-backup-control.md` |
| | `deep_search_plugin_architecture_plan.md`: global deep search and plugin registry | ACTIVE | `parts/01-core-back/08-search.md` |
| `03-deployment/` | `payment_gateway_deployment_and_guides_architecture.md`: multi-host deploy engine (+ guides §9–11, partly superseded by `07-guides-and-academy/`) | ACTIVE (deploy) / REFERENCE (guides) | `parts/07-deploy/**` |
| `04-fake-rails-and-seeder/` | `fake_payment_rails_service_architecture.md`: Fake Payment Rails emulator and chaos portal | ACTIVE | `parts/06-fake-rails/**` |
| | `synthetic_operational_data_seeder_architecture.md`: multi-year synthetic data seeder | ACTIVE | `parts/01-core-back/10-synthetic-seeder.md` |
| `05-testing/` | `master_exhaustive_test_plan_for_opencode.md`: exhaustive test plan (assertion counts aspirational) | REFERENCE | `parts/08-testing/00..03` |
| | `multi_machine_topology_and_stress_test_plan.md`: JSON-configured N-machine topology and stress lab | ACTIVE | `parts/08-testing/04-multi-machine-matrix.md` |
| `06-ui/` | `portal_ui_abstraction_and_modern_fintech_redesign_2.md`: portal design system v2 | ACTIVE | `parts/03-admin-front/00,02` |
| | `pg_companion_offline_android_app.md`: approved offline Android Guide + Academy companion blueprint | ACTIVE | `parts/10-companion/00-offline-companion.md` |
| | `portal_ui_implementation_plan.md`: as-built execution record for the UI redesign | REFERENCE | `parts/03-admin-front/**` |
| | `admin_front_complete_feature_and_missing_pages_plan.md`: admin-front completion plan (implemented 2026-11-06) | REFERENCE | `parts/03-admin-front/00,01,02` |
| | `merchant_landing_page_redesign.md`: merchant public landing page concept and motion system | ACTIVE | `parts/04-merchant-front/00-portal.md` |
| `07-guides-and-academy/` | `complete_zero_to_hero_guides_and_academy_specification.md`: implemented guide/academy baseline | REFERENCE (being replaced) | `parts/03-admin-front/03`, `parts/04-merchant-front/01` |
| | `guide_system_design_and_content.md`: Admin Guide v1.0 spec (implemented; content is extracted from it), plus `academy_system_design_and_content.md` (Academy spec, implemented 2026-11-04), `academy_content_fixes.md`, `academy_content_questions.md`, `guide_content_fixes.md`, `guide_content_questions.md` | ACTIVE (guide and academy) | `parts/03-admin-front/06-guide-v2.md`, `03-guide-and-academy.md` |
| `08-ai-onboarding/` | `smart_ai_rail_and_voucher_onboarding_plan.md`: BYO-AI spec importer (gateway half built; voucher half for the separate voucher system) | ACTIVE / FUTURE | `parts/01-core-back/02-engine.md`, `parts/09-future-and-unimplemented/02` |
| `09-voucher-system-external/` | `Voucher-Provider-Management-System-Technical-Design.md`, `voucher-system-raw-design.md`: separate voucher system, kept for shared patterns | FUTURE / external | `parts/09-future-and-unimplemented/00` |
| `10-fixes/` | `_0001_operator_cases.md`: operator cases feature fix (implemented) | REFERENCE | `parts/01-core-back/01,04`, `parts/03-admin-front/01` |
| `11-automation/` | `background_automation_and_workers_plan.md`: missing and defective background automations; `declarative_goaml_xsd_reporting_engine_plan.md` and `declarative_regulatory_reporting_engine_final_design.md` and `reporting_studio_and_automation_test_plan.md`: format-aware XML/XLSX reporting engine, visual studio and automation test sweep (2026-11-10) | ACTIVE / FUTURE | `parts/01-core-back/{04-governance-compliance,05-workers,07-data-schema-and-migrations}.md`, `parts/03-admin-front/01` |
| `90-archive/superseded-architecture/` | Design v2 and refined design v4.1: predecessors of v5 | ARCHIVE | — |
| `90-archive/superseded-ui/` | UI redesign v1: superseded by v2 | ARCHIVE | — |
| `90-archive/superseded-testing/` | Two-machine T1–T8 plan: superseded by the multi-machine plan (it also contained a plaintext lab password; do not reuse) | ARCHIVE | — |
| `90-archive/delivery-logs/` | OpenCode delivery tracker v5, raw session transcript | ARCHIVE | `project-design/TRACKER.md` |
| `90-archive/legacy-deploy-configs/` | Hand-written nginx/systemd files: replaced by `deploy/templates/*.tpl` + PM2 | ARCHIVE | `parts/07-deploy/**` |

## Rules

- Do not add new normative design here without also updating the matching `project-design/parts/**` file and `project-design/TRACKER.md` in the same change.
- When a blueprint is found wrong, fix it inline or add a dated *corrections / as-built* section, and record the drift in the stale-claims register.
- Move a superseded file into `90-archive/<topic>/` and update the source map; never delete lineage.
