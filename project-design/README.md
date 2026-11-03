# project-design

Canonical, implementation-aware design for the payment-gateway monorepo.

## Authority

- `project-design/parts/**` is the editable source of truth.
- `project-design/PROJECT_DESIGN.md` is generated from the parts and is the centralized verbose master document.
- `project-design/INDEX.md` is the canonical entrypoint.
- `project-design/STATUS.md` is generated from part metadata.
- `project-design/TRACKER.md` is the append-only change, gap and decision log.
- `design/**` is historical/reference material only. It is retained for extraction lineage and is not current authority.
- Code is the authority for as-built behavior. Every design claim must point at code and tests.

## Editing rules

1. Edit the relevant file under `project-design/parts/**`, never the generated `PROJECT_DESIGN.md`, `STATUS.md`, appendices or `*/blueprint.md`.
2. Keep the YAML frontmatter accurate: `status`, `last_verified`, `code`, `design_sources`, `tests`, `gaps`.
3. Mark unimplemented features as `missing` or `deferred`; never describe them as current behavior.
4. When code and design conflict, either fix the code or record the deviation in the part's `Status and deviations` section and in `TRACKER.md`.
5. Run `bun scripts/project-design/build.ts` after edits and `bun scripts/project-design/build.ts --check` before finishing.
6. Add a dated entry to `TRACKER.md` for behavior, contract, schema, env, deploy, UI route, test or invariant changes.

## Part template

Use `project-design/templates/PART_TEMPLATE.md`.

## Status legend

| Status | Meaning |
| :--- | :--- |
| `implemented` | Present in code, covered by tests, and documented without material gaps. |
| `partial` | Present in code but with documented gaps or narrow adoption. |
| `missing` | Designed or expected but not present in the repository. |
| `deferred` | Intentionally postponed with a recorded decision. |
| `deprecated` | Still present but should not be used for new work. |
| `historical` | Retained only for context; not current behavior. |
