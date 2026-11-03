# Copilot instructions

Read and follow `AGENTS.md` and `project-design/INDEX.md`.

`design/**` is historical/reference material only. `project-design/**` is canonical. Any behavior, API, schema/migration, env/config, deploy, UI-route, test or invariant change must update the affected part and `project-design/TRACKER.md` in the same change.

Never hand-edit `project-design/PROJECT_DESIGN.md`, `project-design/STATUS.md`, `project-design/appendices/*`, or `*/blueprint.md`; run `bun scripts/project-design/build.ts`.
