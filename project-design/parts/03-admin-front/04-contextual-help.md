---
id: admin-ui.help
title: Contextual Help
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/components/guide/ContextualHelpDrawer.tsx
  - admin-front/src/components/guide/GlobalGuideSearchModal.tsx
  - admin-front/src/components/ui/PageHeader.tsx
  - admin-front/src/layouts/default.tsx
  - admin-front/src/content/guide/index.ts
  - merchant-front/src/components/guide/ContextualHelpDrawer.tsx
  - merchant-front/src/layouts/default.tsx
  - checkout-front/src/components/help/**
  - core-back/api/internal/checkout.ts
  - core-back/prisma/seedGuides.ts
design_sources:
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
  - design/07-guides-and-academy/guide_system_design_and_content.md
tests:
  - admin-front/src/content/__tests__/content-completeness.test.ts
  - tests/e2e/admin/global-search.spec.ts
  - tests/e2e/checkout/pay.spec.ts
  - core-back/test/guides-support.test.ts
gaps:
  - Six protected admin route names have no effective contextual-help chapter, namely AdminUsers, AdminUserDetail, AuditLog, PricingControls, AdminPlatformSettings and SystemBackups.
  - `PageHeader` exposes `helpChapterId` and `onOpenHelp` props but no page passes them; help is only reachable from the shell drawer and `?` shortcut.
  - Chapter 9.4 is stored under Book 7, so the Book 9/9.4 mapping for Merchants and MerchantDetail resolves to no chapter.
  - Contextual-help mapping titles are English-only and are shown in English even in Arabic.
  - There is no admin UI for authoring per-rail checkout help guides; only the support configuration is editable.
---

# Contextual Help

## 1. Purpose and scope

This part owns the admin contextual-help drawer and its route-to-guide mapping, the merchant portal help drawer, the unused `PageHeader` help props, and the boundary between admin/merchant contextual help and the payer-facing checkout help center.

The checkout help center has its own data contract and rendering rules; it is documented in `05-checkout-front/01-help-center.md`. This part only records how the products are separated and where the admin/merchant surfaces diverge.

## 2. Design intent (extracted and synthesized from ./design)

The design intent is that help is always one action away without destroying work in progress:

1. **Global admin drawer.** A "Help & SOP (?)" button in the shell and a `?` keyboard shortcut open a right-hand 560 px drawer for the current screen.
2. **Context before content.** The drawer should show the mapped book/chapter, the book SOP checklist and the critical human-error warning for the current route.
3. **No form reset.** Opening help must not unmount, close or reset the form being edited.
4. **Search is separate from context.** `Ctrl+K`/`Cmd+K` opens the broader guide search palette; the drawer is for the current screen.
5. **Merchant help is merchant-specific.** The merchant portal has its own M-xx/D-xx chapters and route map, not the admin 12-book guide.
6. **Checkout help is payer-specific.** The checkout support drawer and per-rail banner are driven by the checkout projection, not by the admin guide.
7. **Future guide v2 expects a formal 23-screen context map.** That exhaustive context-map model is not implemented; the current admin map is a simpler 29-entry record.

## 3. As-built architecture

### 3.1 Admin drawer

`admin-front/src/components/guide/ContextualHelpDrawer.tsx` renders a `VNavigationDrawer` with:

- `location="end"`, `temporary`, width 560.
- A close button.
- Status chips for "Help & SOP", the book number and the chapter number.
- A mapping title (English only).
- The book title in the current language when a book resolves.
- The mapped chapter title and Markdown body (`GuideMarkdown compact`).
- The book SOP checklist.
- The book human-error warning.
- An "Open the full guide" button.
- A footer note that the drawer never closes/resets the current form.

If no chapter resolves, it shows a message telling the operator to use `Ctrl+K` to search records, pages and the guide.

The drawer is mounted once in `admin-front/src/layouts/default.tsx`. The route name passed to it is:

```text
String(route.meta.parentName ?? route.name ?? "")
```

That parent-first rule means detail pages automatically use the parent mapping.

### 3.2 The 29-entry admin map

`GUIDE_ROUTE_HELP` in `admin-front/src/content/guide/index.ts` has 29 entries.

| Mapping key(s) | Book | Chapter | Mapping title |
| :--- | :--- | :--- | :--- |
| `Dashboard` | 1 | 1.1 | What the platform does |
| `Approvals` | 2 | 2.4 | Approvals queue SOP |
| `JoinRequests` (also `JoinRequestNew` via parent) | 9 | 9.1 | Join request lifecycle |
| `KybReview`, `KybReviewDetail` | 9 | 9.3 | KYB review queue and per-document decisions |
| `AmlCases`, `AmlScreenings`, `AmlRules`, `AmlReports` | 10 | 10.1 | AML case management / screening / rules / reporting |
| `OperatorCases`, `OperatorCaseDetail`, `GatewayInquirySchedules` | 7 | 7.2 | Operator cases and runbooks |
| `Disputes` | 11 | 11.1 | Dispute and chargeback SOP |
| `Adjustments` | 11 | 11.2 | Refund adjustment SOP |
| `CashOuts` | 12 | 12.1 | Liquidity before cash-outs |
| `Reconciliation` | 8 | 8.2 | Statement reconciliation |
| `Profitability`, `Liquidity`, `Invariant` | 12 | 12.1 | Profitability/liquidity/invariant guidance |
| `Gateways`, `GatewayWizard` | 6 | 6.1 | Gateway wizard |
| `GatewayAiImport` | 6 | 6.2 | Smart AI importer |
| `Rails`, `GatewayRoutes` | 3 | 3.2 | Visible rails formula / route diagnostics |
| `Merchants`, `MerchantDetail` | 9 | 9.4 | Merchant lifecycle and support operations |
| `AdminCheckoutHelp` | 4 | 4.2 | Checkout confirmation channels |
| `AdminGuide` | 1 | 1.1 | Admin system guide |
| `AdminAcademy` | 1 | 1.1 | Employee academy |

The map has no Arabic titles. In Arabic mode the drawer still shows `mapping.titleEn`.

### 3.3 Effective coverage and missing mappings

Because the drawer receives `parentName ?? name`, not every route name needs its own map key. With parent fallback, the current map covers 31 of the 37 protected routes. Six route names have no effective chapter:

| Route | Effective help key | Result |
| :--- | :--- | :--- |
| `AdminUsers` | `AdminUsers` | No mapping; drawer shows the "no chapter" message. |
| `AdminUserDetail` | `AdminUsers` via parent | Same. |
| `AuditLog` | `AuditLog` | No mapping. |
| `PricingControls` | `PricingControls` | No mapping. |
| `AdminPlatformSettings` | `AdminPlatformSettings` | No mapping. |
| `SystemBackups` | `SystemBackups` | No mapping. |

`GatewayAiImport`, `AdminCheckoutHelp`, `AdminGuide` and `AdminAcademy` are mapped even though some are not in the navigation or have no route authority gate. `JoinRequestNew` is not a map key but resolves through `meta.parentName = "JoinRequests"`.

### 3.4 The 9.4 placement bug

The merchant chapter object is:

```text
id: book-9-chapter-9.4
number: 9.4
title: Merchant Lifecycle, Sensitive Edits & Support Operations
```

It is physically inside `BOOKS_PART_2[0]`, whose `id` is `book-7` and whose `number` is 7. As a result:

- Book 7's chapter list has three chapters: 7.1, 7.2 and 9.4.
- Book 9's chapter list has only 9.1, 9.2 and 9.3.
- `findChapter(9, "9.4")` returns `undefined`.
- `GUIDE_ROUTE_HELP.Merchants` and `.MerchantDetail` point to 9/9.4, so the admin merchants help drawer shows "No chapter is mapped to this screen yet."
- Global guide search still finds the 9.4 entry because the search index walks all chapter objects and records `bookNumber` from the containing book; the result is therefore presented as Book 7's chapter 9.4.

This is a content-placement bug, not a missing body. Moving the object into Book 9 fixes the drawer without changing the mapping.

### 3.5 PageHeader help props are unused

`admin-front/src/components/ui/PageHeader.tsx` defines `helpChapterId` and `onOpenHelp` and conditionally renders an "SOP & Help" button. However, no route page passes either prop. The only working entry points are:

- The shell "Help & SOP (?)" button.
- The `?` shortcut when focus is not in an input/textarea/select/contenteditable.
- The shell menu/guide link.

Therefore the PageHeader help affordance is dead code in practice, and the help chapter cannot be selected per page through that prop.

### 3.6 Merchant contextual help

`merchant-front/src/components/guide/ContextualHelpDrawer.tsx` has a separate 16-entry `ROUTE_HELP` map:

| Route | Chapter |
| :--- | :--- |
| `Dashboard` | `M-02` |
| `Onboarding` | `M-01` |
| `Wallets` | `M-07` |
| `Statements` | `M-07` |
| `Cashouts` | `M-07` |
| `Links` | `M-03` |
| `Applications` | `M-02` |
| `PosTerminals` | `M-05` |
| `PosScreen` | `M-05` |
| `Payments` | `M-06` |
| `Disputes` | `M-08` |
| `DeveloperTokens` | `D-02` |
| `Credentials` | `M-09` |
| `Team` | `M-10` |
| `MerchantGuide` | `M-01` |
| `MerchantDeveloperGuide` | `D-01` |

The merchant drawer:

- Resolves the chapter from the merchant operations/developer content, not the admin 12-book guide.
- Shows chapter id, role, developer/operations badge, title and Markdown body.
- Has an "Open the full guide" footer that routes to the developer guide for developer routes and to the merchant guide otherwise.
- Is opened by the merchant shell's "SOP & Help" button and `?` shortcut.
- Uses the same parent-first route-name rule.

The 9.4-under-Book-7 bug is an admin guide content bug. Merchant `M-07` and the merchant drawer are unaffected because they do not read the admin book arrays.

### 3.7 Checkout help is a separate product

The checkout help center does not consume `GUIDE_ROUTE_HELP` or the merchant `ROUTE_HELP` map. It consumes:

- `PayLinkSummary.supportConfig` from the core checkout projection of `checkout.support_config`.
- `RailDescriptor.helpGuide` from `rails.help_guide_json`.

The admin `Checkout Help` page edits the support configuration; the per-rail guides are seeded from `core-back/prisma/seedGuides.ts` and sent through the checkout summary. The checkout drawer/banner are documented in `05-checkout-front/01-help-center.md`.

## 4. Contracts and invariants

1. **The admin drawer never closes or resets the underlying form.** It is a temporary navigation drawer, not a page transition.
2. **The route key is parent-first.** `meta.parentName` wins over the detail route name.
3. **Mappings carry a book number, optional chapter number and English title.** Missing chapter numbers fall back to the book's first chapter; missing mappings show the fallback message.
4. **A mapped chapter must exist in the mapped book.** The 9.4 case violates this.
5. **Help is role-agnostic.** Any authenticated admin may open the guide and drawer; it contains no live data.
6. **Merchant and admin help are separate content domains.** Do not reuse admin book numbers in the merchant drawer.
7. **Checkout help is data-driven.** It must not depend on admin guide content.
8. **The future context map is not current.** Do not describe the 23-screen v2 map as implemented.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Admin drawer | `admin-front/src/components/guide/ContextualHelpDrawer.tsx` |
| Admin shell mount and keyboard handling | `admin-front/src/layouts/default.tsx` |
| Admin route map | `admin-front/src/content/guide/index.ts` |
| Admin guide search | `admin-front/src/components/guide/GlobalGuideSearchModal.tsx` |
| PageHeader help props | `admin-front/src/components/ui/PageHeader.tsx` |
| Merchant drawer/map | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` |
| Merchant shell mount | `merchant-front/src/layouts/default.tsx` |
| Checkout help drawer/banner | `checkout-front/src/components/help/**` |
| Checkout support projection | `core-back/api/internal/checkout.ts` |
| Seeded support/rail guides | `core-back/prisma/seedGuides.ts` |

No deployment flag controls the admin/merchant contextual drawer. The `ADMIN_SHOW_HELP_PANELS` flag controls inline help panels on KYB, approvals and merchants, not the contextual drawer.

## 6. Operational usage

- Add an admin mapping: add the route name to `GUIDE_ROUTE_HELP`, point it at an existing chapter, and confirm `findChapter(bookNumber, chapterNumber)` resolves.
- Fix the 9.4 bug: move the chapter object from Book 7's array to Book 9's array; keep the `book-9-chapter-9.4` id and number.
- Add a merchant mapping: add the route name to the merchant `ROUTE_HELP` map and ensure the referenced M/D chapter exists.
- Debug "no chapter" in the admin drawer: check the effective route key (`parentName ?? name`), the map entry, and the chapter's actual containing book.
- Do not wire per-page `PageHeader` help props until the shell and the page share a single open-state contract; the current shell owns drawer state.

## 7. Status and deviations

### Implemented

- Admin global 560 px drawer with book/chapter/SOP/human-error rendering.
- 29-entry admin route map with parent fallback.
- `?` shortcut and shell button.
- Merchant 16-route help map and separate M/D chapter content.
- Guide search entry point.
- Checkout help separate from admin/merchant guide content.

### Partial

- Effective admin help coverage is 31/37 routes; six routes fall back to "no chapter".
- Mapping titles are English-only.
- `PageHeader` help props are implemented but unused.
- Merchant help is mapped for all 16 routes, but its content is still the 10+5 chapter baseline, not guide v2.

### Missing / deferred

- No full 23-screen context map, safeguard cards, playbook or read tracking from guide v2.
- No admin UI to author per-rail checkout help guides.
- No localized mapping titles.
- No page-level help button wiring beyond the shell.

### Known bugs / risks

- **Content bug:** 9.4 under Book 7 breaks the Merchants/MerchantDetail admin help and misorders Book 7.
- **Coverage gap:** AdminUsers, AdminUserDetail, AuditLog, PricingControls, AdminPlatformSettings and SystemBackups have no help chapter.
- **Dead UI:** `PageHeader`'s help props are unused, so a page cannot request a different chapter than the shell route map supplies.
- **Localization gap:** Arabic mode still shows the English mapping title.
- **Future-doc risk:** the guide v2 context map must not be presented as current.

## 8. Verification and tests

- `admin-front/src/content/__tests__/content-completeness.test.ts` verifies book/chapter content shape and depth, but it does not assert that every `GUIDE_ROUTE_HELP` entry resolves. That is why the 9.4 bug can pass.
- `tests/e2e/admin/global-search.spec.ts` checks the shell search split between records and guide search.
- `tests/e2e/checkout/pay.spec.ts` checks the payer surface; checkout help behavior is covered in the checkout help part.
- `core-back/test/guides-support.test.ts` verifies the checkout support setting and per-rail help guide seeding.

The content test and `guides-support` test require Bun; the latter requires PostgreSQL/Redis. Playwright requires the live stack.

## 9. Source references

### Old design sections

- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — implemented four-surface help model and merchant guide chapters.
- `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` — 560 px drawer intent.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — future context-map/safeguard workstream.

### Code paths

- `admin-front/src/components/guide/ContextualHelpDrawer.tsx`
- `admin-front/src/components/guide/GlobalGuideSearchModal.tsx`
- `admin-front/src/components/ui/PageHeader.tsx`
- `admin-front/src/layouts/default.tsx`
- `admin-front/src/content/guide/index.ts`
- `admin-front/src/content/guide/booksPart2.ts`
- `merchant-front/src/components/guide/ContextualHelpDrawer.tsx`
- `merchant-front/src/layouts/default.tsx`
- `checkout-front/src/components/help/CheckoutHelpDrawer.tsx`
- `checkout-front/src/components/help/PerRailInstructionsBanner.tsx`
- `core-back/api/internal/checkout.ts`
- `core-back/prisma/seedGuides.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical contextual-help part. Records the 29-entry admin map, six missing effective mappings, unused PageHeader help props, the 9.4-under-Book-7 bug, the merchant map, and the separation from checkout help.
