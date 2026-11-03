# Glossary and Status Rules

## Vocabulary

| Term | Meaning |
| :--- | :--- |
| **Gateway** | Upstream provider/bank/aggregator catalog record. |
| **Credential Set** | The pinned credentials and ownership mode used by a gateway version. |
| **Rail** | Customer-facing payment method. |
| **Route** | A rail + gateway + credential set + cost/limit/health binding. |
| **Attempt** | One payment attempt pinned to a gateway version and route. |
| **GL account** | Double-entry ledger account. |
| **GL shard** | One row in `gl_account_shards`; system accounts use 16 shards, merchant wallets one. |
| **Outbox** | `outbox_events` transactional event queue. |
| **Audit outbox** | `audit_outbox` transactional audit queue shipped to `pg_audit_db`. |
| **Read model** | `rm_*` projection maintained by the outbox relay. |
| **LSN** | PostgreSQL WAL location used for replica read-your-writes. |
| **Drill** | Scratch restore + ledger/audit invariant verification. |

## Status

| Status | Meaning |
| :--- | :--- |
| `implemented` | Present, tested and documented without material gaps. |
| `partial` | Present but with documented gaps or narrow adoption. |
| `missing` | Designed/expected but absent. |
| `deferred` | Intentionally postponed with a recorded decision. |
| `deprecated` | Present but should not be used for new work. |
| `historical` | Retained for context only. |

## Source-of-truth order

1. Running code and migrations.
2. Generated appendices (`schema-catalog`, `migration-catalog`, `api-route-matrix`, `env-and-config-matrix`, `test-inventory`).
3. `project-design/parts/**`.
4. `project-design/PROJECT_DESIGN.md` (generated).
5. `design/**` (historical only).

## Naming conventions

- Part IDs: `area.part` (`core.storage`, `deploy.pipeline`, `admin-ui.routes`).
- Code paths in frontmatter are repository-relative.
- Design sources are repository-relative and may include `#section` anchors.
- Generated files carry a `GENERATED FILE` header.
