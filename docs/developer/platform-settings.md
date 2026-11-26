# Adding and changing platform settings

This is the developer checklist for the versioned platform configuration shown at
`/settings/platform`. The canonical project-design rule lives in
`project-design/parts/03-admin-front/05-backups-settings-and-operations.md` §9.

Platform settings are platform-wide, operator-editable, versioned JSON values.
They are not a place for secrets, personal data, per-merchant state or
infrastructure configuration.

## 1. Decide what kind of value it is

Use a platform setting only when all of these are true:

- It is one platform-wide policy or recorded decision.
- An operator should be able to inspect and change it without a deploy.
- It is safe to include in a settings backup (no password, token, private key,
  PAN/CVV, KYC/KYB personal data or AML-confidential evidence).
- A version history and an audit trail are useful.

Choose another mechanism otherwise:

| Need | Use |
| :--- | :--- |
| Host names, ports, file paths, credentials, feature switches owned by deploy | `deploy/deploy.env*` and the deploy engine |
| Per-merchant, per-wallet, per-route or per-attempt data | The domain table and its API |
| Static copy or UI text | The i18n catalogue |
| A calculated value | Code or a read model, not a setting |
| A secret | Vault / credential set / KMS, never a platform setting |

## 2. Choose the key and the value shape

- Keys use `domain.name`, for example `merchant_reports.policy`, or an existing
  decision-register id such as `OD-4`.
- The key is immutable. Renaming a key means a new key plus a fallback or
  migration; never reuse the old key for a different meaning.
- The stored value must be a JSON **object**. A scalar is not accepted by the
  API (`PUT /settings` maps a scalar to `{ "value": ... }` at the edge, but new
  settings should use explicit fields).
- Every field must have a safe default and a documented unit.
- No secrets, personal data or confidential AML evidence.

## 3. Add the default to the seed

File: `core-back/prisma/platformSettingsSeed.ts`

```ts
{
  key: "my_feature.policy",
  valueJson: {
    enabled: true,
    threshold: 10,
    description: "What this setting controls.",
  },
},
```

`core-back/prisma/seed.ts` applies the array idempotently. Add a row only if the
setting should exist in every environment. A runtime setting that operators
configure later can stay unseeded and appear in the UI as **Using default**.

## 4. Add the reader in core

Read the latest effective value with the same contract the other readers use:

```ts
const row = await db.platformSetting.findFirst({
  where: { key: "my_feature.policy", scope: "PLATFORM" },
  orderBy: { version: "desc" },
  select: { valueJson: true },
});
```

Rules:

- Parse defensively. A missing row, a malformed value or an unknown field must
  fall back to a safe default, never crash a payment or a worker.
- Never trust the UI validation alone.
- If the value is cached, invalidate the cache after a settings save. See
  `invalidateRouteHealthPolicyCache()` and
  `invalidateMerchantReportPolicyCache()`.
- If a worker or payment path reads it, document the reader and the timing in
  the catalog (see step 5).
- Add a unit test for the parser/defaults.

## 5. Register the catalog metadata

File: `admin-front/src/components/builders/model/settingsCatalog.ts`

Add a `SettingDefinition` with:

- `key`, `namespaceId`, `section`
- `lifecycle`: `RUNTIME`, `FALLBACK`, `DECISION`, `DEPRECATED`, `MANAGED` or
  `SYSTEM`
- `summary` (one line) and `description` (what it controls and why)
- `readBy` (component/worker) and `effect` (when a change applies)
- `risk` and `riskReason`
- `defaults`, `keywords`
- `allowEdit`, `showWhenUnconfigured`, `allowCreate` when relevant
- optional `managePath`, `guideArticleId`, `relatedKeys`, `cardFields`, `group`

Then add the typed namespace to
`admin-front/src/components/builders/model/settingsSchemas.ts`:

```ts
"my_feature.policy": {
  id: "my_feature.policy",
  title: "My feature policy",
  description: "What this policy controls.",
  fields: [
    {
      key: "enabled",
      kind: "boolean",
      label: "Enabled",
      hint: "When on, the feature is available. When off, it is blocked immediately.",
      default: true,
      group: "General",
    },
  ],
},
```

**Every field must have a hint that explains the field, its unit and its
effect.** A hint such as "The value" is not acceptable. Use `group` for long
policies and `optionHints` for every select value.

If the key is a dynamic family (for example `gateway.go_live.*`), extend
`resolveSettingNamespace` and add a test.

## 6. Add English and Arabic text

File: `admin-front/src/constants/i18n/settings.ts` (or the builders catalogue
for builder-specific text).

Add an entry for every catalog string that is passed to `t()` in the UI:

- section title and description
- status label, description and risk labels
- setting title, summary, description, reader, effect and risk reason
- every field label, hint, unit and option hint
- every action/empty-state string

The i18n gate must pass:

```bash
cd tests && bunx vitest run unit/i18n-catalogue.test.ts unit/builders-api-error-i18n.test.ts
```

## 7. Add tests

At minimum:

- `tests/unit/platform-settings.test.ts` proves seeded-key coverage, field hints,
  section/status translation, unconfigured/default behavior, effective vs
  scheduled versions, unregistered keys and search.
- `tests/e2e/admin/platform-settings.spec.ts` proves the page renders sections,
  searches, opens the drawer and saves a typed value with a change note.
- Core parser tests for the new reader.
- Edge forwarding tests if a new API field is added.

Run:

```bash
cd core-back && bun run typecheck && bun test <targeted tests>
cd admin-back && bun run typecheck && bun test
cd admin-front && bun run type-check && bun run test:unit && bun run build
cd tests && bun run test:unit
```

## 8. Update documentation

- `project-design/parts/03-admin-front/05-backups-settings-and-operations.md`
  (catalog, screen behavior and gaps)
- `project-design/parts/03-admin-front/01-route-and-page-catalog.md` if the page
  or route changed
- `project-design/parts/08-testing/01-suite-catalog.md` for new tests
- `project-design/TRACKER.md` with a dated entry
- `admin-front/README.md` if the page behavior changed
- The Guide article `b12-07` and the Companion snapshot when the operator-facing
  explanation changes

## 9. Review checklist

- [ ] The key is immutable and follows `domain.name`.
- [ ] The value is a JSON object with safe defaults.
- [ ] No secret, personal data or AML-confidential content is stored.
- [ ] Core parses missing/malformed values safely.
- [ ] A cache invalidates after a settings save.
- [ ] The catalog has a section, summary, description, reader, effect, risk and
  risk reason.
- [ ] Every field has a useful hint and every select has option hints.
- [ ] English and Arabic entries exist.
- [ ] Seeded-key coverage, search and page tests pass.
- [ ] `project-design` and `TRACKER.md` are updated.
- [ ] `bun scripts/project-design/build.ts --check` and `git diff --check` pass.

## 10. Deprecating or renaming

- Do not delete a key that may still be in a backup or an older reader.
- Mark it `DEPRECATED` or `FALLBACK` in the catalog and explain what replaced it.
- A renamed key needs a new key plus either a fallback reader or a migration.
- Remove it only after every reader, backup and audit reference is gone.
