---
id: checkout-ui.help
title: Checkout Help Center
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - checkout-front/src/components/help/CheckoutHelpDrawer.tsx
  - checkout-front/src/components/help/PerRailInstructionsBanner.tsx
  - checkout-front/src/components/renderers/types.ts
  - checkout-front/src/pages/pay/[linkKey]/index.tsx
  - core-back/api/internal/checkout.ts
  - core-back/prisma/seedGuides.ts
  - admin-front/src/pages/settings/checkout-help/index.tsx
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
  - design/07-guides-and-academy/guide_system_design_and_content.md
tests:
  - core-back/test/guides-support.test.ts
  - tests/e2e/checkout/pay.spec.ts
  - tests/e2e/checkout/a11y.spec.ts
  - tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts
gaps:
  - The admin Checkout Help page only edits the platform support configuration; there is no admin UI to edit per-rail `help_guide_json`.
  - The admin page subtitle says "per-rail instructions" but the page does not provide per-rail editing.
  - Disabling support hides contact and FAQ, but the help drawer, state guidance, payment reference and per-rail banner remain; this is broader than the admin warning may imply.
  - There is no dedicated checkout help route/deep link; help is a drawer on the payer page.
  - `supportConfig.channels` is a redundant flat list derived from the platform contact fields.
  - No help-content analytics, feedback capture or read tracking exists.
---

# Checkout Help Center

## 1. Purpose and scope

This part owns the payer-facing help center in `checkout-front`:

- The per-rail instructions banner on the payment form.
- The "Help & Support" slide-over drawer on the payer page.
- The `supportConfig` projection from the admin-managed platform setting.
- The per-rail `helpGuide` projection from the rail record.
- The state-aware guidance for in-flight, unknown, failed, expired and cancelled attempts.
- The actual hide behavior when the admin disables support.

It does not own the admin support settings page, merchant guide, admin guide, or the checkout phase machine. It documents the separation between the platform support configuration and the per-rail guides, and it records the gaps in the current authoring and visibility model.

## 2. Design intent (extracted and synthesized from ./design)

The checkout help center is data-driven rather than hard-coded:

1. **The payer never needs a second request for help.** Support details and per-rail walkthroughs travel with the payment-link summary.
2. **Help is contextual to the selected rail.** The banner and guide section explain the exact steps, prerequisites and troubleshooting for the rail the payer is using.
3. **Help is state-aware.** A `VERIFYING`/`UNKNOWN`/`FAILED`/`EXPIRED`/`CANCELLED` attempt gets a clear "do not pay again" or "safe to retry" message.
4. **Support is centrally controlled.** The admin edits one platform setting for support channels, working hours and FAQ; the change applies to all checkout links.
5. **The merchant contact is optional and separate.** The platform can show its own support channels, the merchant's contact details, both, or neither.
6. **Per-rail guides are content, not code.** The rail record carries bilingual steps/prerequisites/troubleshooting so operators can tune guidance per payment method.
7. **The payer can always copy the reference.** The drawer exposes the payment reference for support conversations.
8. **Disabling support should not break the payment flow.** It hides the contact block, not the payment or the attempt-state guidance.

## 3. As-built architecture

### 3.1 The two data sources

| Data | Source | Projection |
| :--- | :--- | :--- |
| Platform support config | `platform_settings` key `checkout.support_config` | `buildCheckoutSupportConfig` in `core-back/api/internal/checkout.ts` |
| Per-rail guide | `rails.help_guide_json` (seeded by `core-back/prisma/seedGuides.ts`) | Passed through `visibleRails[].helpGuide` in `GET v1/pay/:linkKey` |

The checkout page receives both in `PayLinkSummary.supportConfig` and `RailDescriptor.helpGuide`.

### 3.2 Support config shape

```text
SupportConfig {
  enabled: boolean
  working_hours_ar: string | null
  working_hours_en: string | null
  platform: { phone, whatsapp, email } | null
  merchant: { phone, email, tradeName } | null
  faq_items: Array<{ q_ar, a_ar, q_en, a_en }>
  channels: string[]
}
```

Projection rules in `buildCheckoutSupportConfig`:

- If the setting is absent, not an object, or `enabled !== true`, return `null`.
- If `show_platform_contact` is not false, include the platform phone/WhatsApp/email.
- If `show_merchant_contact` is not false, include the merchant phone/email/trade name from the loaded link.
- Pass through `working_hours_ar`/`working_hours_en`, FAQ items (all four fields, null-coalesced) and a flat `channels` list derived from non-empty platform channels.
- The projection deliberately excludes the setting's other fields; only the support-facing shape leaks.

The admin form defaults both `show_*` values to true and saves the `checkout.support_config` setting as a new immutable platform-setting version. The core handler writes `CHECKOUT_SUPPORT_UPDATED` and `CHECKOUT_SUPPORT_EDIT_CHECKLIST` audits. The admin page's live preview is not the actual drawer.

### 3.3 Per-rail help guide shape

```text
RailHelpGuide {
  steps_ar: string[]
  steps_en: string[]
  prerequisites_ar: string[]
  prerequisites_en: string[]
  troubleshooting_ar: Array<{ q_ar, a_ar }>
  troubleshooting_en: Array<{ q_en, a_en }>
}
```

`core-back/prisma/seedGuides.ts` defines `RAIL_HELP_GUIDES` for 14 seeded rails: `edfali`, `sadad`, `moamalat_card`, `cbl_lypay`, `lypay`, `mypay`, `tlync`, `mobicash`, `onepay`, `yussor`, `sahara`, `mpgs`, `evo_pay`, `neompay_wallet` (the comment above the map says 13, but the actual object has 14 keys). A rail without a guide returns `helpGuide: null`; the banner hides and the drawer omits the rail-guide section.

The admin portal has no rail-guide editor. Rails are seeded/updated from code and the admin Rails page manages rail catalog fields, not `helpGuideJson` content.

### 3.4 Per-rail banner

`checkout-front/src/components/help/PerRailInstructionsBanner.tsx` renders when `selectedRail.helpGuide` exists:

- A region titled "How to pay with <rail>".
- An expand/collapse button (default expanded).
- A help button that opens the drawer.
- Prerequisite pills (localized with fallback).
- Numbered step rows.
- Localized last-resort behavior: Arabic uses Arabic when present, otherwise English; English uses English when present, otherwise Arabic.

The banner is independent of `supportConfig.enabled`. Disabling support does not hide it.

### 3.5 State-aware drawer

`checkout-front/src/components/help/CheckoutHelpDrawer.tsx` is a `SlideOverDrawer` (width 440) titled "Help & Support". It composes:

1. **State guidance** for the current attempt status.
2. **Payment reference** with a copy action when a reference exists.
3. **Per-rail guide** from the selected rail's `helpGuide`.
4. **FAQ** from `supportConfig.faq_items`.
5. **Contact support** from `supportConfig.platform` and `supportConfig.merchant`.

State guidance:

| Status | Tone | Message summary |
| :--- | :--- | :--- |
| `VERIFYING` | info | The platform is verifying; do not pay again; status updates automatically. |
| `UNKNOWN` | warning | Could not confirm yet; do not pay again; wait/refresh; contact support with the reference. |
| `FAILED` | error | Attempt did not complete; try another method; if charged, contact support with the reference. |
| `EXPIRED` | warning | Payment window expired; do not use the old reference; start a new payment. |
| `CANCELLED` | warning | Payment was cancelled; if charged, contact support with the reference; otherwise start again. |
| Other | none | No state block. |

The drawer always shows the reference block when a reference exists, regardless of support configuration. The rail-guide section shows prerequisites, numbered steps and troubleshooting when a guide is present. The FAQ section renders only when there are complete localized FAQ items. The contact section renders only when `supportConfig.enabled` is true.

Contact behavior:

- Platform WhatsApp builds `https://wa.me/<digits>?text=<encoded help message>`.
- Platform phone uses `tel:` with whitespace removed.
- Platform email uses `mailto:` with a localized subject and a body containing the link key and reference.
- Merchant name/phone/email render when the merchant contact is present.
- If support is enabled but no channel and no working hours exist, the drawer shows "No contact details are available right now."
- The help message includes the link key and reference (or `N/A`).

The drawer does not close/reset the payment form. It is opened by the header help button and by the banner's help button.

### 3.6 Actual hide behavior

This is the important distinction between design intent and code:

- When `checkout.support_config.enabled` is false, `buildCheckoutSupportConfig` returns `null`.
- The drawer's `support` computed value is null, so:
  - **Contact support hides.**
  - **FAQ hides** (the FAQ is derived from `supportConfig`).
  - **Working hours hide** (inside the contact block).
- The following remain visible/usable:
  - The header "Help & Support" button and the drawer itself.
  - State guidance for the current attempt.
  - The payment reference and copy action.
  - The per-rail guide section (from `rail.helpGuide`).
  - The per-rail banner.
- Therefore the admin warning "Disabling this hides the Contact Us block on every checkout page" is accurate for the contact/FAQ block, but it does not remove the entire help center. The setting is a support-channel switch, not a global help kill switch.

### 3.7 Localization and fallback

- `currentLocale` comes from the checkout locale adapter (`ar` or `en`).
- Rail display names fall back between Arabic and English.
- Guide steps/prerequisites/troubleshooting use the selected language first, then the other language.
- FAQ questions/answers are filtered to complete localized pairs.
- Working hours fall back between languages.
- The drawer's section titles are bilingual inline.

### 3.8 Separation from admin/merchant help

- Admin contextual help uses `GUIDE_ROUTE_HELP` and the 12-book guide; it does not read `supportConfig`.
- Merchant contextual help uses M/D chapters; it does not read `supportConfig`.
- Checkout help uses `supportConfig` and `helpGuide`; it does not read admin/merchant guide content.
- The admin `/settings/checkout-help` page is the only authoring surface for the platform support config.
- Per-rail content is seeded from core code and has no admin authoring surface.

## 4. Contracts and invariants

1. **Help data travels with the payment-link summary.** No second help request is required.
2. **`enabled: false` returns `null` supportConfig.** The drawer must tolerate null and still render state/reference/rail help.
3. **Only enabled support exposes platform/merchant contacts and FAQ.** The projection enforces this; the UI does not re-enable hidden data.
4. **Merchant contact is link-derived.** It uses the loaded merchant's contact fields, not a merchant-supplied free-form block.
5. **Per-rail guides are bilingual arrays.** Missing entries fall back to the other language.
6. **The drawer never changes payment state.** It only displays status/reference and opens external contact links.
7. **The banner is independent of support enabled.** It is driven by `rail.helpGuide`.
8. **The reference copy is a UI convenience.** It does not prove payment.
9. **No secrets are shown.** Support details are business contact data; payment secrets/OTP/PAN are never placed in the drawer.
10. **The admin setting is versioned.** A change creates a new `checkout.support_config` version.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Public summary + support/help projection | `GET v1/pay/:linkKey` in `core-back/api/internal/checkout.ts` |
| Support setting | `platform_settings` key `checkout.support_config` |
| Support seed | `DEFAULT_SUPPORT_CONFIG` in `core-back/prisma/seedGuides.ts` |
| Rail guides seed | `RAIL_HELP_GUIDES` in `core-back/prisma/seedGuides.ts` |
| Admin config page | `admin-front/src/pages/settings/checkout-help/index.tsx` |
| Admin endpoints | `v1/admin/settings/checkout-support`, `/history`, `/summary`, `/summary/export` |
| Payer banner | `checkout-front/src/components/help/PerRailInstructionsBanner.tsx` |
| Payer drawer | `checkout-front/src/components/help/CheckoutHelpDrawer.tsx` |
| Payer page mount | `checkout-front/src/pages/pay/[linkKey]/index.tsx` |

## 6. Operational usage

- Enable support: set `enabled`, configure at least one platform or merchant channel, set working hours, review FAQ, and save. The change creates a new version and affects new link fetches.
- Disable support: expect contact and FAQ to disappear; the drawer, state guidance, reference and rail guide remain. Update any support scripts accordingly.
- Add a per-rail guide: edit `RAIL_HELP_GUIDES` and reseed; there is no admin UI. Confirm the rail is visible and the `helpGuide` is present in the link summary.
- Debug missing contact: check `enabled`, `show_platform_contact`/`show_merchant_contact`, and whether the link has merchant contact data.
- Debug missing FAQ: check `enabled` and whether the selected-language question/answer pair is complete.
- Debug missing banner: check `selectedRail.helpGuide`; a null/absent guide hides the banner.
- Debug a support message: use the reference shown in the drawer; do not ask the payer for an OTP or PIN.

## 7. Status and deviations

### Implemented

- Data-driven `supportConfig` projection from `checkout.support_config`.
- Per-rail `helpGuide` projection from `rails.help_guide_json`.
- Per-rail banner with prerequisites, steps, collapse and help entry.
- Drawer with state guidance, reference copy, rail guide, FAQ and contact channels.
- Bilingual fallback behavior.
- WhatsApp/phone/email deep links with reference-aware messages.
- Admin support config with versioning, preview, history, diff and summary export.
- Seeded support config and 14 seeded rail guides (the seed comment says 13).

### Partial

- Support disabling hides contact/FAQ but not the whole help center; the UI warning can be read too broadly.
- Per-rail guide authoring is code/seed-only.
- The admin page subtitle mentions per-rail instructions but the page only edits support config.
- The help drawer has no analytics or feedback capture.
- The help center has no dedicated route; it is a drawer on `/pay/:linkKey`.

### Missing / deferred

- No admin editor for `helpGuideJson`.
- No per-merchant support override; support is platform-wide.
- No content version displayed to the payer.
- No help-content search or FAQ deep links.
- No guide v2 context/playbook/safeguard model for checkout.

### Known bugs / risks

- **Wording gap:** "per-rail instructions" in the admin subtitle implies an authoring capability that does not exist.
- **Visibility gap:** disabling support does not remove state guidance, reference, rail guide or banner.
- **Content risk:** per-rail guides are seeded code; a rail whose guide is stale or missing gives the payer less help than expected.
- **Support risk:** the merchant contact comes from link data; if the merchant's phone/email is missing or stale, the payer sees no merchant channel.
- **Security risk:** support flows must never ask for OTP/PIN; the guide and default FAQ reinforce this, but contact channels are external.
- **Future-doc risk:** guide v2 is not the current checkout help implementation.

## 8. Verification and tests

- `core-back/test/guides-support.test.ts` seeds support config and rail guides and asserts the public projection/help guide shape.
- `tests/e2e/checkout/pay.spec.ts` renders the payer surface.
- `tests/e2e/checkout/a11y.spec.ts` covers accessibility basics.
- `tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts` covers the checkout surface across viewports/locales/themes.

The core support test requires PostgreSQL/Redis; the Playwright suites require the running stack. There is no dedicated unit test for the support-disable hide matrix.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — checkout/help deployment context.
- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — collection-mode and trustworthy-confirmation terminology used by the payer guidance.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — future guide workstream; not current checkout help behavior.

### Code paths

- `checkout-front/src/components/help/CheckoutHelpDrawer.tsx`
- `checkout-front/src/components/help/PerRailInstructionsBanner.tsx`
- `checkout-front/src/components/renderers/types.ts`
- `checkout-front/src/pages/pay/[linkKey]/index.tsx`
- `core-back/api/internal/checkout.ts`
- `core-back/prisma/seedGuides.ts`
- `admin-front/src/pages/settings/checkout-help/index.tsx`
- `core-back/test/guides-support.test.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical checkout help part. Confirms the `supportConfig`/`helpGuide` projections, per-rail banner, state-aware drawer, the actual support-disable hide behavior, and the missing per-rail authoring surface.
