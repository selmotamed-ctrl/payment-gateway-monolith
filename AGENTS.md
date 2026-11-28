# AGENTS.md — Payment Gateway Monorepo

## Start here

1. Read `project-design/INDEX.md`.
2. Read the relevant `project-design/parts/**` file for the area you will change.
3. Read the code and tests that the part references.
4. If `project-design/` is missing or conflicts with the code, update `project-design/` first (or record the deviation in `TRACKER.md` before proceeding).

`design/**` is historical/reference material only. It is not current authority.

## Project map

| Workspace | Role |
| :--- | :--- |
| `core-back/` | PostgreSQL 18 storage engine, domain engine, ledger, governance, workers, backup control, synthetic seeder. |
| `admin-back/`, `merchant-back/`, `checkout-back/` | mTLS-only edge BFFs with least-in-flight `CORE_BACK_URLS` pools. |
| `admin-front/`, `merchant-front/`, `checkout-front/` | Vue 3 + Vuetify 3 + TSX portals. |
| `fake-rails-back/`, `fake-rails-front/` | Optional Fake Payment Rails emulator and tester portal. |
| `companion-app/` | Offline Android Guide + Academy companion; canonical-content snapshot and signed APK build. |
| `deploy/` | Multi-host deploy engine, storage provisioners, PKI, firewall, backup daemon. |
| `backend-rs/` | Rust/ntex port workspace (`backend-rs/README.md`; Track P/D progress in `backend-rs/IMPLEMENTATION_TRACKER.md`). |
| `tests/` | Playwright/Vitest suites, including live-stack journeys. |
| `project-design/` | Canonical design, status, tracker and generated appendices. |

## Non-negotiable invariants

- PostgreSQL 18 is the only runtime database (`@prisma/adapter-pg` + `pg`). Do not reintroduce MySQL/MariaDB.
- Money uses `Decimal`/`decimal.js`; never floating point.
- Sensitive actions use maker-checker; maker ≠ checker is enforced server-side.
- Authorities are enforced by `core-back`; edge/UI checks are advisory.
- Edge services never receive `DATABASE_URL`, `KMS_MASTER_KEY` or another host's client key.
- Ledger, outbox and audit writes for critical paths are atomic.
- Secrets, ciphertext, AML-confidential data and master keys must never be logged.
- Keep English/Arabic catalogues in sync for user-facing text.
- All spreadsheet exports use the shared XLSX pipeline.
- Deploy-generated UI flags (`ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_HELP_PANELS`) are runtime-config controlled.

For report-engine changes, also read `project-design/parts/01-core-back/12-report-engine-sdk.md` §18 and follow the version/migration/transcript checklist; never overwrite a released transcript snapshot.

## Documentation workflow

Any change to behavior, APIs, schema/migrations, env/config, deploy, UI routes, tests or invariants must update the affected `project-design/parts/**` file and `project-design/TRACKER.md` in the same change.

- Generated files: `project-design/PROJECT_DESIGN.md`, `project-design/STATUS.md`, `project-design/appendices/*-catalog.md`, `project-design/appendices/*-matrix.md`, `project-design/appendices/*-inventory.md`, and `*/blueprint.md`.
- Never hand-edit generated files. Edit `project-design/parts/**` and run the generator.
- Status values: `implemented`, `partial`, `missing`, `deferred`, `deprecated`, `historical`.
- Unimplemented features go under `project-design/parts/09-future-and-unimplemented/`.
- Keep the YAML frontmatter accurate (`status`, `last_verified`, `code`, `design_sources`, `tests`, `gaps`).

## Verification

Run the smallest relevant checks first, then the full gate:

```bash
bun scripts/project-design/build.ts --check
cd core-back && bun run typecheck && bun test
cd deploy && bun run typecheck && bun test
cd deploy/backup-daemon && bun run typecheck && bun test
cd deploy/object-storage-daemon && bun run typecheck && bun test
cd admin-back && bun run typecheck && bun test
cd merchant-back && bun run typecheck && bun test
cd checkout-back && bun run typecheck && bun test
cd admin-front && bun run build
cd merchant-front && bun run build
cd checkout-front && bun run build
cd companion-app && bun run content:check && bun run typecheck && bun test && bun run build
cd backend-rs && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
bun backend-rs/tools/codegen/gen.ts --check
bun backend-rs/tools/route-inventory/index.ts --check
bun backend-rs/tools/golden/check.ts
```

Database-backed suites require PostgreSQL 18 and Redis; report skipped suites explicitly. Run `scripts/run-benchmarks.sh` for storage benchmarks.

## Before finishing

- `bun scripts/project-design/build.ts --check` passes.
- `git diff --check` passes.
- Typechecks/tests/builds relevant to the change pass, or the environment limitation is stated.
- `project-design/TRACKER.md` has a dated entry for material changes.

## UI & Design System Governance (STRICT — ZERO EXCEPTIONS)

1. **Single Source of Truth (`@pg/ui`):** All reusable UI primitives, layout containers, form controls, tables, alerts, toasts, dialogs and design tokens live exclusively in `packages/ui` (`@pg/ui`). Never copy-paste UI components or CSS token files into `admin-front`, `merchant-front`, `checkout-front` or `fake-rails-front`. The package is consumed through the `@pg/ui` Vite/TypeScript alias so every portal compiles the same source with Vue 3.6 Vapor.
2. **Forbidden Raw Controls:** Never write raw `<select>`, `<select multiple>`, `<input type="date">`, `<input type="checkbox">`, `<input type="text">`, `<textarea>` or hand-styled alert/toast divs inside application pages. Always use `PgAutocomplete`, `PgDateInput`, `PgCheckbox`, `PgTextField`, `PgSearchInput`, `PgTextarea`, `PgAlert`, `PgDialog`, `PgMetricStrip` and `showToast` from `@pg/ui`.
3. **Global Spacing Policy:** Never override container padding or form gaps with ad-hoc inline `style={{ padding: ... }}` on `PgPage`, `PgCard`, `PgDialog`, `PgDrawer` or `PgSection`. Rely on the `--pg-space-*` tokens and the component props. Table cells and compact chips keep their own metric.
4. **Floating Overlays:** `PgAutocomplete`, `PgDateInput`, `PgMenu`, `PgTooltip`, `PgDialog`, `PgDrawer` and `PgCommandPalette` own their positioning. Do not wrap them in a clipped `overflow: hidden` container or re-implement a floating panel in a page.
5. **Creating a New Component:** If a feature genuinely requires a UI pattern not yet in `@pg/ui`, you MUST:
   - Design and implement it inside `packages/ui/src/` as a 100% Vue 3.6 Vapor-valid, accessible, RTL-ready, dark/light-mode component using `--pg-*` tokens.
   - Export it from `packages/ui/src/index.ts`, add unit tests in `packages/ui/test/`, and document its props and usage in `packages/ui/CATALOG.md` **before** using it in any page.
6. **CI Gate:** Run `bun run ui:audit`, `bun run ui:test` and `bun run ui:typecheck` before completing any frontend task. `bun run ui:icons:check` must also pass after adding a new `mdi-*` icon.
