# Fix 0001 — Operator Cases list, bulk inquiry and case details

## Why

The current `/operator-cases` page is not aligned with the design:

- `admin-front/src/pages/operator-cases/index.tsx` uses `DataTable`, which is already
  in server mode because `tableRegistry.OperatorCases` exists. The page's own
  `load()` and header Case Type select are disconnected from the table and do
  nothing.
- Bulk inquiry loops over `attemptId`s, never checks eligibility, silently skips
  cases without attempts, and can move terminal attempts to `VERIFYING`.
- The “Attempts” column renders a checkbox. Selection is not tied to the case,
  has no select-all or eligibility summary, and reports no per-case result.
- The list API only searches `attempt.reference`; there is no merchant-name or
  case-reference filter.
- The detail API returns only the bare `OperatorCase` row: no attempt, step
  logs, inbound events, reconciliation item, approval or assignee.
- `POST /operator-cases/:id/resolve` only writes notes/state. The edge mapper
  discards the selected action, so “Mark succeeded/failed” does nothing.
- `POST /attempts/:id/inquire` directly sets any attempt to `VERIFYING`, which
  violates the forward-only lifecycle for terminal attempts.

## Scope

1. Rebuild the list page on `ApiTable` with server-side pagination/filtering.
2. Add real bulk inquiry with per-case eligibility and result reporting.
3. Add a logical, explainable case details page.
4. Make case resolutions real Maker-Checker operations:
   `MARK_SUCCEEDED`, `MARK_FAILED`, `CLOSE_CASE`.
5. Add help tooltips and show every database identifier with its source.
6. Keep all money movement inside the existing ledger and slot infrastructure.

## 1. Table strategy: `ApiTable`

Use `admin-front/src/components/Table/ApiTable.tsx`, following the pattern in
`example.ignore.tsx`:

- `ApiTable` owns server pagination, sorting, refresh, search, XLSX and rendering.
- `TopSlot` contains:
  - `TableFilters` from the current design system (not the older
    `FiltersContainer` from the example).
  - The bulk-selection bar.
  - Result count and active filters.
- `onRefresh` sends:
  `page`, `pageSize`, `search`, `caseRef`, `merchantName`,
  `providerReference`, `kind`, `priority`, `state`, `assigneeUserId`, `from`,
  `to`, `dateFrom`, `dateTo`, `sortKey`, `sortDirection`.
- `setRefreshHook` refreshes after bulk inquiry and actions.
- `apiDataExtractor` / `apiTotalExtractor` feed page-local row and total refs for
  selection and the bulk bar.

Low-risk `ApiTable` improvements (no current admin page uses it):

1. `localSearch?: boolean` (default `true`). Operator cases disables it because
   the server already searched.
2. `onData?: (rows, total) => void` so pages do not need extractor side effects.
3. Use `extractApiErrorMessage` instead of the hardcoded “Something Went Wrong!”.
4. Pass the internal `loading.value` to `TableHeader` (currently it passes
   `props.loading`).

## 2. Shared clarity improvements

### Table header tooltips

- Add `headerTooltip?: string` to `TableHeader` in
  `components/Table/types.ts`.
- Render a help icon beside the header label in `Table.tsx` with `VTooltip`.
- Every operator-case column has a tooltip explaining meaning, derivation and
  database source.

### Detail field tooltips

- Extend `FieldProps` with:
  - `hint?: string` — plain-language explanation.
  - `source?: string` — exact table/column or derivation.
- `Field` renders a help icon with a `VTooltip` containing hint and source.
- Add optional `title` / `description` to `FieldsSections` sections so grouped
  detail cards have explicit headings.
- Add optional `hint` to `StatusChip` for case-specific enums.

### Help content

`operatorCaseHelp.ts` contains one source of truth for:

- case kinds (`UNKNOWN`, `HELD`, `CONFLICT`, `MISMATCH`, `LATE_SUCCESS`,
  `MANUAL_REVIEW`, `UNMATCHED_STATEMENT`);
- case states (`OPEN`, `IN_PROGRESS`, `PENDING_CHECKER`, `RESOLVED`);
- priorities (`P1`, `P2`, `P3`);
- reconciliation results;
- inquiry support;
- runbook names.

The same definitions drive table tooltips, detail field hints and warnings.

## 3. List page

### Columns

1. Selection checkbox
2. Case reference — links to detail; derived value explained in tooltip
3. Type — chip with tooltip
4. Priority — chip with tooltip
5. State — chip with tooltip
6. Merchant
7. Rail / Gateway
8. Amount — charged amount when an attempt exists, otherwise statement amount;
   source explained in the tooltip
9. Attempt — reference plus status/substatus
10. Link slot — confirmed/use counts and active lock
11. Provider reference
12. Reconciliation result
13. Approval state
14. Opened at
15. SLA due — overdue / due-soon chip
16. Assignee
17. Actions — Open, Inquire (disabled with reason when ineligible)

Use `rowColor` from `statusTone` so P1/overdue/conflict rows stand out.

### Filters

Configure in `tableRegistry.OperatorCases`, reused by the page:

- Case reference (`caseRef`)
- Merchant name (`merchantName`)
- Provider reference (`providerReference`)
- Case type, multi (`kind`)
- Priority, multi (`priority`)
- State, multi (`state`)
- Assignee (`assigneeUserId`)
- Opened date range (`from`, `to`)
- SLA due range (`dateFrom`, `dateTo`)

Header search matches case reference, attempt reference, provider reference,
merchant trade name and merchant legal name.

Filter changes are debounced, then call `reset()`. `TableFilters` supplies
active chips and “Clear all”.

### Bulk inquiry

- Selection stores **case IDs**, never attempt IDs.
- Header checkbox selects all rows on the current server page.
- Selection persists across pages and clears when search/filters change.
- Bulk bar shows selected / inquiry-ready / will-be-skipped.
- `POST /operator-cases/bulk-inquire` accepts case IDs and returns per-case
  results.
- Eligibility:
  - case state is not `RESOLVED` or `PENDING_CHECKER`;
  - attempt exists;
  - attempt is `UNKNOWN` or `VERIFYING`;
  - pinned gateway version has `supportsStatusCheck = true`.
- Result dialog lists scheduled and skipped cases with exact reasons.

## 4. Case details page

The page is an investigation narrative, not a raw dump.

1. **Header** — reference, type, priority, state, SLA, actions:
   Back, Assign to me, Start working, Inquire Gateway Now, Propose Resolution.
2. **Workflow strip** — `OPEN → IN_PROGRESS → PENDING_CHECKER → RESOLVED`,
   current state highlighted, assignee and SLA.
3. **“What this case means”**
   - What happened (from kind + attempt status + reconciliation result).
   - Why it matters (money and slot impact).
   - What to do next (runbook and available actions).
4. **Key statistics** — charged amount, attempt status, SLA remaining, age,
   priority.
5. **Case and ownership** — IDs, state, priority, assignee, opened, updated,
   SLA, approval.
6. **Merchant and application**.
7. **Payment attempt and money** — status/substatus, environment, mode,
   requested/surcharge/charged/settled/fee/commission/net, references,
   timestamps, ledger entry.
8. **Route, gateway and slot** — rail, collection mode, gateway, route health,
   pinned version, inquiry support, link slot counters.
9. **Reconciliation and statement**.
10. **Evidence** — expandable panels:
    - Timeline;
    - Gateway step logs;
    - Inbound webhooks;
    - Reconciliation items;
    - Adjustments and disputes;
    - Audit trail;
    - Raw evidence (collapsed, monospace, copyable, LTR, scroll-contained).
11. **Resolution and approval** — current notes, approval state, maker/checker,
    payload, rejection reason; approve/reject only for an eligible checker who
    is not the maker.
12. **All identifiers** — every ID with entity label, database table/column and
    copy button.

## 5. Backend/API

### List endpoint

`GET /operator-cases` returns explicit fields:

- `caseId`, `caseRef`, `caseReferenceSource`
- `caseType`, `priority`, `state`
- `merchantId`, `merchantTradeName`, `merchantLegalName`
- `railId`, `railCode`, `railNameEn`
- `gatewayId`, `gatewayCode`, `gatewayName`
- `routeId`, `attemptId`, `attemptReference`
- `attemptStatus`, `attemptSubstatus`
- `chargedAmount`, `statementAmount`, `currency`
- `providerReference`, `gatewayReference`
- `linkSlot` object
- `reconciliationItemId`, `reconciliationResult`
- `approvalRequestId`, `approvalState`
- `assigneeUserId`, `assigneeEmail`
- `openedAt`, `slaDueAt`
- `gatewaySupportsStatusCheck`
- `inquiryEligibility` (`eligible`, `reason`)

Search and filters:

- search over case reference, attempt reference, provider reference, merchant
  trade/legal name;
- `contains` filters for `caseRef`, `merchantName`, `providerReference`;
- multi-value `in` filters for `kind`, `priority`, `state`;
- sort allowlist for priority, state, kind, opened, SLA, case reference,
  merchant.

### Detail endpoint

`GET /operator-cases/:id` includes safe nested data:

- case, assignee, approval maker/checker, reconciliation item/run/source;
- attempt, link, attempt group, merchant, application, rail, route, gateway,
  gateway version/settings;
- step logs;
- inbound events with decoded raw-body preview;
- adjustments, disputes, reconciliation items;
- audit trail.

`contextCiphertext` and secret material are never returned.

### Actions

- `POST /operator-cases/bulk-inquire` — inquiry scheduling with per-case
  results.
- `PATCH /operator-cases/:id` — assign and move `OPEN` ↔ `IN_PROGRESS`.
- `POST /operator-cases/:id/resolve` — Maker-Checker proposal:
  - `MARK_SUCCEEDED`, `MARK_FAILED`, `CLOSE_CASE`;
  - creates an `OPERATOR_CASE` approval;
  - sets case `PENDING_CHECKER`;
  - no attempt or ledger change until approval.
- `POST /approvals/:id/approve` — executes the resolution atomically.
- `POST /approvals/:id/reject` — returns the case to `IN_PROGRESS`.

Resolution execution:

- `MARK_SUCCEEDED` requires a provider reference; allowed for `UNKNOWN`,
  `VERIFYING`, `FAILED`, `EXPIRED`; uses existing ledger and slot
  infrastructure; routes to suspense when no slot remains.
- `MARK_FAILED` allowed for `UNKNOWN`/`VERIFYING`; releases the reservation and
  sets `FAILED`.
- `CLOSE_CASE` only when the attempt is terminal or absent.
- Forward-only violations and attempts with conflicting ledger entries are
  rejected.

### Roles

- Add `case:write` to seeded `OPERATOR`.
- Add `approval:read`, `approval:check`, `approval:write` to the operator-case
  checker role, at minimum `FINANCE`.
- Update `core-back/prisma/seed.ts` and
  `core-back/scripts/createAdminPlan.ts`.

## 6. Routing

- Add `/operator-cases/:id` as `OperatorCaseDetail`.
- Add authority mapping `case:read` / `operator:read`.
- Add `parentName: "OperatorCases"` route meta so the sidebar and help drawer
  keep the Operator Cases context.
- Map the detail route to Guide Book 7.2.
- Keep the detail route out of the sidebar.

## 7. Tests and verification

Backend:

- `core-back`: `contains` query tests, inquiry eligibility, maker-checker
  resolution, idempotency, rejection reset, suspense routing, conflicting
  ledger rejection.
- `admin-back`: route forwarding, schemas and contract mapping.
- role-plan tests.

Frontend:

- `ApiTable` pagination against mocked responses.
- Header search and filters send the correct query parameters.
- Bulk selection uses case IDs and shows per-case results.
- Case reference navigates to detail.
- Detail page renders narrative sections, evidence panels, tooltips, approval
  controls and all identifier rows.
- Maker proposal shows `PENDING_CHECKER`; checker approval resolves the case.

Commands:

- `core-back`: `bun run typecheck && bun test`
- `admin-back`: `bun run typecheck && bun test`
- `admin-front`: `bun run typecheck && bun run build && bun run lint`
- Playwright operator-case tests.
- Manual verification at `http://localhost:8443/operator-cases` and
  `/operator-cases/:id`.

## 8. Guardrails

- No attempt outcome change from the list page.
- Bulk inquiry only schedules inquiries.
- No terminal attempt downgrade.
- No ledger posting without a unique attempt ledger reference.
- Maker ≠ checker enforced at API and execution layers.
- Every displayed ID is labelled with its entity and database source.
- Every derived value says it is derived and from where.

## Implementation order

1. Shared backend query support and operator-case endpoints.
2. Maker-Checker execution in governance and approval reject/reset.
3. Admin-back routes and contracts.
4. Shared frontend clarity components (`ApiTable`, `Table` tooltips, `Field`,
   `FieldsSections`, `StatusChip`) and help content.
5. List page on `ApiTable`.
6. Detail page, router and navigation.
7. Tests, typechecks, build, lint and manual verification.
