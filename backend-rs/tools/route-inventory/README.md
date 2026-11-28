# Route / error-code / environment inventory (P0-T04)

Golden-vector generator for the Rust/ntex port. It reads the TypeScript backend (the source of truth for
Track P) and writes the inventories the Rust router, error envelope and configuration loader must reproduce.

No dependencies: the script uses only `node:fs`, `node:path` and `node:url` from Bun. It does **not** need
the TypeScript compiler, so it runs from a bare checkout and in CI without an install step.

## Usage

```bash
# from the repository root
bun backend-rs/tools/route-inventory/index.ts           # (re)generate the committed JSON
bun backend-rs/tools/route-inventory/index.ts --check   # CI guard: exit 1 when a committed file differs
```

`--check` never writes. It prints the current counts, then for each stale file a short summary
(route count, up to 8 added and 8 removed `METHOD path` keys, added/removed error codes, call-site
count, per-service env keys). Exit codes: `0` up to date, `1` differences, `2` bad arguments.

The output directory is fixed: `backend-rs/tests/golden-vectors/route-inventory/`. The script resolves
the repository root from its own location, so the working directory does not matter.

## Outputs

### `routes.json` — core-back

An array of every HTTP route reachable from `core-back/index.ts`:

| Field | Meaning |
| :--- | :--- |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` or `ALL` (Express `router.all`). |
| `fullPath` | Absolute mount path (`/internal/admin/users`). `null` when the path is dynamic. |
| `file`, `line` | Real `file:line` of the registration in the TS source. |
| `guards` | Detected auth/validation mechanisms (see below), canonical order. |
| `bodyLimit` | `json`, `raw` or `none` (the parser that would run for this path). |
| `rawLimitBytes` | Raw-body limit for `raw` rows (from `core-back/lib/rawBody/index.ts`). |
| `tsOrigin` | The exported router symbol and verb, e.g. `adminInternalRouter.post`. |
| `jsonLimitBytes` | JSON limit for `json` rows (default or the report-engine 24 MiB rule). |
| `guardsWindow` | Guard labels from the registration region only (same call + 15 preceding top-level lines). |
| `guardsInherited` | Guard labels inherited through the mount chain and prefix-scoped middleware. |
| `mountChain` | `file:line absolutePrefix` for every mount traversed, root first. |
| `dynamic`, `pathExpression` | Present on a row whose path could not be resolved statically. |

`core-back/index.ts` mounts `/internal` and `/api`; the internal channel routers are bound to a client
certificate CN in `core-back/api/index.ts`, which is why every `/internal/**` row carries `mtlsGuard`.

### `edge-routes.json` — admin-back, merchant-back, checkout-back

The same rows plus `service` (`admin-back` | `merchant-back` | `checkout-back`). Edge `/health` rows have
`bodyLimit: "none"` because each edge registers `/health` before its JSON parser.

### `error-codes.json`

Every `new ApiError(<status>, "<CODE>", "<message>" ...)` call site in `core-back`, `admin-back`,
`merchant-back`, `checkout-back`, `fake-rails-back` and the two deploy daemons' `src/` trees, grouped:

```json
{ "code": "ACADEMY_BUSY", "status": 409, "count": 1,
  "callSites": [{ "file": "core-back/engine/academy/service.ts", "line": 95, "message": "..." }] }
```

Groups are deduplicated by `code + status`; every call site is kept (sorted by file, line). `message` is
`null` when the TS call passes a non-literal (template, ternary, variable). Call sites whose status or code
is not a literal (35 today) cannot be represented as a group: they are listed in the run summary and
counted as `dynamic`.

### `env-schemas.json`

A map of service name to the sorted environment keys that service reads or validates:

```json
{ "core-back": ["DATABASE_URL", "..."], "...": [], "rust-only": ["HTTP_WORKERS", "..."] }
```

Extraction combines three patterns in `core-back/lib/env/index.ts`, each edge's `lib/env/index.ts`,
`deploy/backup-daemon/src/config.ts`, `deploy/object-storage-daemon/src/config.ts` and
`fake-rails-back/lib/env/index.ts`:

- `process.env.KEY` / `process.env["KEY"]`;
- direct keys of the zod schema object (`z.object({...})`, `z.strictObject({...})`, `z\n.object({...})`);
- `env.KEY` property reads.

The `rust-only` entry lists the keys the Rust services introduce (`HTTP_WORKERS`,
`WORKER_RUNTIME_THREADS`, `PG_STATEMENT_CACHE`, `METRICS_BIND`, `LOG_FORMAT`,
`CREDENTIALS_DIRECTORY`). They are intentionally absent from every TS service.

The same pass records numeric `.default(...)` values, which the route inventory uses to resolve
`express.json({ limit: env.MAX_JSON_BODY_BYTES })` and checkout's raw inbound limit.

## How the scan works

1. **Mask** — a small state machine replaces comment bodies and the contents of strings, template
   literals and regex literals with spaces (newlines preserved). Identifiers, punctuation and keywords in
   code remain, so a regex can find calls without matching inside comments or strings and bracket
   matching stays safe.
2. **Calls** — `IDENT.get|post|put|patch|delete|all|use|route(` is located in the masked text; the
   argument list is sliced with bracket/brace/paren depth (commas inside strings, objects and nested calls
   do not split). Multi-line calls are handled. `router.route("/x").get(...)` chains are expanded.
3. **Router graph** — `const X = express.Router()` / `Router()` / `const app = express()` declarations,
   ESM imports (including `import { a as b }`, default imports and re-exports such as
   `export { adminInternalRouter } from "./admin"`) and exports (`export const X = router`,
   `export default router`) are parsed. A router identifier passed as a `use(...)` handler is resolved to
   its declaring file; the mount prefix is concatenated and the mount is traversed. The walk starts at
   each app entry point (`core-back/index.ts`, `{admin,merchant,checkout}-back/index.ts`), so files that
   are never mounted are not routes.
4. **Body limits** — core raw-body rules mirror `core-back/lib/rawBody/index.ts` (exact paths, prefix
   `/internal/checkout/inbound`, and the `join-requests/:id/kyb-documents`, `aml/cases/:id/evidence`,
   `disputes/:id/attachments` regexes). JSON defaults come from the parsed env schemas (core 1 MiB,
   admin 4 MiB, merchant 2 MiB, checkout 1 MiB). The app-level conditional 24 MiB report-engine parsers
   (`core-back/index.ts:23`, `admin-back/index.ts`, `merchant-back/index.ts`) and route-scoped
   `router.use("/report-engine", express.json({limit}))` registrations are applied on top. Checkout's
   `express.raw` inbound parser is detected from the router's `rawParser`/`getRawParser` middleware.
5. **Guards** — labels are detected in the masked text of the registration's own first 20 lines (so a
   guard called at the top of an inline handler counts), in the 15 preceding lines whose indentation is
   not deeper than the registration (so a neighbouring handler's body is ignored), in the mount call
   arguments, in earlier `router.use(...)` registrations on the same router (path-less and
   prefix-scoped), and through guard aliases (`const readX = requireAuthorities(...)`,
   `const guard = requireAuthoritiesByMethod`). The labels are:

   `mtlsGuard` (`requireEdgeIdentity`), `requireAuthentication`, `requireSession`,
   `requireStaffPrincipal`, `requireMerchantPrincipal`, `requireAuthorities`, `authorityGuard`
   (`requireAuthoritiesByMethod` / `guard(...)`), `requireMerchantScope`, `requireServiceIdentity`,
   `requireApiToken`, `makerChecker`, `validate(zod)` (`validate*` / `parseOrThrow`), `rawBody`, plus any
   other `*Guard` identifier a mount passes (for example `merchantKybGuard`).

   Request rate limiters, cookie parsing and CORS are intentionally not guards.

## How to add a route

1. Register it on an already mounted router with a literal path:
   `router.get("/widgets/:id", requireAuthentication, handler)`. Add the file to the app's router tree if
   it is new (an unmounted router file is listed in the run summary and left out of `routes.json`).
2. Run `bun backend-rs/tools/route-inventory/index.ts` and commit the regenerated JSON. The normal route
   test should be added in the same change; the golden file is not a substitute for it.
3. CI runs `--check`; a new route that is not committed fails the guard with the added `METHOD path`.

If the path cannot be a literal, use one of the supported shapes or expect a `dynamic: true` row:

- an array literal (`router.get(["/a", "/b"], ...)`);
- a template inside `for (const x of ["a", "b"] as const) { router.get(\`/:id/${x}\`) }`;
- otherwise the row is emitted with `fullPath: null`, `dynamic: true`, `pathExpression` and a summary
  entry. Add a literal path or extend the tool if a Rust route must match it.

## Current findings (2026-11-28)

- **Core: 611 routes** — 610 internal/public registrations plus `GET /health`, matching the plan's
  "610 + 1". All paths are statically resolved.
- **Edges: 419 admin + 106 merchant + 19 checkout.** The plan's "610 + 1" is core only.
- **605 error code+status groups / 1,231 call sites**, plus 35 genuinely dynamic `ApiError` call sites
  (status/code from a variable or ternary; listed in the summary).
- **One dead route file**: `merchant-back/api/protected/options.ts` declares `GET /:kind` but nothing
  imports `optionsRouter`, so it is not reachable and is not in `edge-routes.json`.
- **Duplicate method+path rows** exist where the TS code registers path-scoped middleware and the final
  handler as separate Express layers (admin `POST /auth/login` + `/auth/mfa` rate limiters) or where a
  handler is literally registered twice (`core-back/api/internal/sandboxControl.ts` registers
  `GET /admin/merchants` at lines 1980 and 2089; Express serves the first). The rows are kept in source
  order; deduplicate by `method + fullPath` when building the Rust route registry and treat the later
  duplicate as shadowed.
- **`requireMerchantScope`, `requireServiceIdentity` and `requireApiToken` have zero occurrences** —
  those helpers are not called from any route in the TS code (see the S-SEC-02 note in the contracts
  reference). The inventory reports what the code does, not what the documents intend.

## Limitations

- **No AST.** The scanner is a masker plus bracket-balanced argument parsing. It understands the router
  and mount idioms used in this repository; a new idiom (a router returned by a helper, a path built by
  string concatenation, a mount inside a conditional) is reported as dynamic or missed until the tool is
  extended. `grep -c "router\."`-style checks are not a substitute; the run summary's counts and the
  `--check` diff are the guard.
- **Static imports only.** A router passed through a function call, an object property or a default
  parameter cannot be followed. Namespace imports are recorded but not traversed.
- **Express ordering is not simulated.** Every registration is listed at its source line; shadowed
  routes and middleware-only layers are not merged (see duplicates above). Prefix-scoped middleware is
  attributed to a route when its line precedes the mount/route, which is how Express runs it.
- **Catch-all proxies register no verbs.** `admin-back/api/sandboxProxy.ts` and
  `merchant-back/api/sandboxProxy.ts` forward every `/sandbox/**` request from a single `router.use`
  middleware, so the mirrored Sandbox routes (and the merchant mirror `report-engine` 24 MiB path) are not
  enumerated here; only the app-level parser limits apply to them. The Sandbox route list comes from
  `core-back/api/internal/sandboxControl.ts`, which is fully inventoried under `/internal/sandbox/**`.
- **Guard detection is heuristic.** It finds named mechanisms, not the complete authority policy. Core
  authorises inside handlers (`requireAuthorities(request, [...])`); those calls are visible only when
  they appear in the first 20 lines of the handler. The authority strings themselves are not extracted.
- **Body schemas are not extracted.** Validation happens in handlers via `parseOrThrow`/zod; the
  inventory records the presence of `validate(zod)` but not the schema. Codegen/golden vectors for zod
  shapes are a separate P0-T05/P0-T06 task.
- **Multipart uploads are not modelled.** Edge upload routes use multer; the app-level JSON parser still
  runs first, so they appear as `json`. Their real limits (`MAX_UPLOAD_BYTES`, `UPLOAD_RATE_LIMIT_MAX`,
  the MIME allowlist) live in `lib/upload.ts` and need their own inventory.
- **Only app-level and `use(...)` parsers are modelled.** A parser passed directly to a route verb
  (`router.post(path, express.json({limit}), h)`) would not raise the limit. No route does that today.
- **`bodyLimit` is the parser that would run**, not proof a body is accepted. `GET` and `DELETE` rows
  usually say `json` because the app-level JSON parser is mounted for all methods.
- **HEAD is implicit.** Express answers `HEAD` for every `GET`; only the six registrable verbs are listed.
- **One trailing-slash form.** Express matches both `/x` and `/x/`; the inventory stores the normalised
  form without the trailing slash.
- **Error scan scope.** Tests, `node_modules`, `dist` and Prisma migrations are excluded, so only
  production call sites are counted. The deploy daemons do not use `ApiError` (they use `HttpError` and
  `{ error: { code, message } }`); they contribute zero groups by design. The `MAX_*` / `MIN_*` handler
  limits and the daemons' codes need a separate inventory if the Rust daemons share the core envelope.
- **Env keys are names only.** Defaults are best-effort numeric literals from `.default(...)`; zod
  transforms/refinements and cross-field rules are not captured.
- **Diagnostics are stdout only.** Unmounted router files, dynamic routes and dynamic `ApiError` sites are
  printed on every run but are not part of the JSON contract, so they do not churn the golden files.

## CI

Wire the guard next to the other repository gates:

```yaml
- run: bun backend-rs/tools/route-inventory/index.ts --check
```

The check is semantic (JSON parse + deep compare), so formatting changes alone do not fail it; a changed
route, error code or env key does.
