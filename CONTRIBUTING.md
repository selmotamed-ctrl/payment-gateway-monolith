# Contributing

## Design-first workflow

1. Read `AGENTS.md`, `project-design/INDEX.md`, and the relevant `project-design/parts/**` file.
2. Change code and design together.
3. Update the part frontmatter (`status`, `last_verified`, `code`, `design_sources`, `tests`, `gaps`) and the part body.
4. Add a dated entry to `project-design/TRACKER.md`.
5. Run `bun scripts/project-design/build.ts`.
6. Run `bun scripts/project-design/build.ts --check`, `git diff --check`, and the relevant typecheck/test/build commands.

`design/**` is historical/reference material only. Do not add new normative design there.

## Generated files

Do not hand-edit:

- `project-design/PROJECT_DESIGN.md`
- `project-design/STATUS.md`
- `project-design/INDEX.md`
- `project-design/appendices/schema-catalog.md`
- `project-design/appendices/migration-catalog.md`
- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`
- `project-design/appendices/code-surface-map.md`
- `*/blueprint.md`

Edit `project-design/parts/**` or the generator and rerun `bun scripts/project-design/build.ts`.
