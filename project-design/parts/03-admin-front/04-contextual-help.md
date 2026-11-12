---
id: admin-ui.help
title: Contextual Help
status: implemented
confidence: high
last_verified: 2026-11-04
verified_against: working-tree
code:
  - admin-front/src/components/guide/ContextHelpButton.tsx
  - admin-front/src/components/guide/ContextHelpDrawer.tsx
  - admin-front/src/components/guide/useContextHelp.ts
  - admin-front/src/components/guide/SafeguardDialog.tsx
  - admin-front/src/components/guide/useSafeguard.ts
  - admin-front/src/components/ui/PageHeader.tsx
  - admin-front/src/layouts/default.tsx
  - admin-front/src/content/guide/generated/context-map.json
  - merchant-front/src/components/guide/ContextualHelpDrawer.tsx
  - checkout-front/src/components/help/**
design_sources:
  - design/07-guides-and-academy/guide_system_design_and_content.md
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
tests:
  - tests/unit/guide-content.test.ts
  - tests/e2e/admin/guide-context.spec.ts
  - tests/e2e/admin/guide-safeguard.spec.ts
  - tests/e2e/admin/global-search.spec.ts
  - tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts
gaps:
  - Drawer summaries, card titles and situation titles are English-only; the route/screen map is generated from the English guide design.
  - The context map used stale route-name guesses; missing names were added to the owning screen or `General` and logged in `design/07-guides-and-academy/guide_content_fixes.md`.
  - The merchant drawer and checkout help center remain separate products and are not fed by the admin context map.
---

# Contextual Help

## 1. Purpose and scope

This part owns the admin contextual-help button and drawer, the 30-screen context map, and the safeguard dialog that appears before risky actions. The merchant portal drawer and payer checkout help are separate products; this part only records their boundary.

## 2. As-built architecture

### 2.1 Button

`admin-front/src/components/ui/PageHeader.tsx` renders `ContextHelpButton` automatically. The button uses the current route name, preferring `route.meta.parentName` over `route.name`, and opens a shared drawer through `useContextHelp()`. Pages never wire the button by hand. The app-bar "Help & SOP" button and the `?` shortcut open the same drawer with the same parent-first rule.

The accessible name is "How this page works".

### 2.2 Context map

`context-map.json` is generated from `@@map id=context-map` in the guide design. It contains `fallbackScreenId` plus 30 `ContextScreen` entries with `screenId`, `routeNames`, `pageDir`, `summary`, `articles`, `cards` and `situations`.

Resolution rules:

1. Find the first screen whose `routeNames` contains the current route name.
2. If none matches, use the screen whose `screenId` equals `fallbackScreenId` (`General`).
3. `pageDir` is the `admin-front/src` folder used by the label-verification procedure.

The route-coverage unit test parses every named route in `router/index.ts` (except `Login` and `NotFound`) and fails if a name has no context-map entry. Missing names were added to the owning screen or `General` and logged in `design/07-guides-and-academy/guide_content_fixes.md`.

### 2.3 Drawer

`ContextHelpDrawer` is a non-modal navigation drawer, 420 px wide, placed on the inline-end side (right in LTR, left in RTL). It shows:

1. **What this screen is for** — the screen summary.
2. **Before you act** — collapsible safeguard cards with risk badges and the full four-section body.
3. **Common problems** — situation links.
4. **Learn more** — article links.
5. **Open the whole guide** — route to `AdminGuide`.

The drawer does not unmount or reset the page, and a test types into the merchant filter, opens the drawer, closes it and asserts the value remains.

### 2.4 Safeguard dialog

`SafeguardDialog` is mounted once in the default layout. `useSafeguard(cardId).confirm()` returns `Promise<boolean>`:

- Every `- [ ]` item in the card's `Check first` section is a required checkbox.
- **Continue** is disabled until every box is ticked.
- **Cancel** resolves `false`.
- Ticks reset on every open and are never stored or sent.

The integration points are the 22 action areas named in the guide design: approvals, adjustments, cash-outs, operator cases, join requests, merchants, AML cases/screenings/rules/reports, gateway wizard, routes, AI import and reconciliation. Existing confirmation and maker-checker mechanisms remain in place after the safeguard. Two cards (`sg-reverse-adjustment`, `sg-release-reservation`) have no separate current UI action; this is documented in `design/07-guides-and-academy/guide_content_questions.md`.

## 3. Contracts and invariants

1. Help is always one button away in `PageHeader`; no page wires it manually.
2. The route key is parent-first, matching navigation and breadcrumbs.
3. Unknown route names always fall back to `General`.
4. Opening help never navigates or resets form state.
5. The drawer never substitutes for an approval; safeguards are additional, not a replacement.
6. The guide and drawer contain no live data, secrets or external links.
7. Merchant and checkout help remain separate content domains.

## 4. Surface

| Surface | Location |
| :--- | :--- |
| Button | `admin-front/src/components/guide/ContextHelpButton.tsx` |
| Drawer | `admin-front/src/components/guide/ContextHelpDrawer.tsx` |
| Shared state | `admin-front/src/components/guide/useContextHelp.ts` |
| Safeguard dialog | `admin-front/src/components/guide/SafeguardDialog.tsx` |
| Safeguard composable | `admin-front/src/components/guide/useSafeguard.ts` |
| PageHeader mount | `admin-front/src/components/ui/PageHeader.tsx` |
| Global mount | `admin-front/src/layouts/default.tsx` |
| Context map | `admin-front/src/content/guide/generated/context-map.json` |
| Merchant drawer | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` |
| Checkout help | `checkout-front/src/components/help/**` |

## 5. Verification

`tests/unit/guide-content.test.ts` checks route coverage. `tests/e2e/admin/guide-context.spec.ts` checks five representative routes and form-state preservation. `tests/e2e/admin/guide-safeguard.spec.ts` checks the disabled Continue button, required checks and that Cancel sends no request.
