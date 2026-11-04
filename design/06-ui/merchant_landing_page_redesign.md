# Merchant Landing Page Redesign (2026-11-04)

Status: implemented in `merchant-front/src/pages/public/landing/**`. The canonical description is `project-design/parts/04-merchant-front/00-portal.md` §3.1a. This note records the research, concept and decisions behind it.

## 1. Goal and constraints

Make the public merchant landing page (`/`) clearly sell what the platform actually does, using modern fintech patterns and tasteful motion, while staying:

- truthful: every claim is checked against `project-design/**` and the code (see §7);
- inside the existing stack (Vue 3 TSX + Vuetify 3, shared `--pg-*` tokens, self-hosted fonts), with **no new dependency**;
- fast (static hero, lazy below-the-fold code section, CSS-first motion, no layout shift);
- accessible (full `prefers-reduced-motion`, keyboard operation, semantic headings, contrast), working in light/dark and English/Arabic RTL down to 360 px.

## 2. Research summary

Sources reviewed (November 2026):

- Bento grids — [SaaSFrame: Designing Bento Grids That Actually Work (2026)](https://www.saasframe.io/blog/designing-bento-grids-that-actually-work-a-2026-practical-guide), [Muzli: Landing page design trends 2026](https://store.muz.li/articles/landing-page-design-trends-2026), [B2B SaaS bento trend](https://www.pravinkumar.co/blog/bento-grids-b2b-saas-homepage-design-trend-2026). Takeaway: a bento works when it is a *curated* layout with mixed cell sizes (one large hero cell, small proof cells), not a dashboard dump.
- Stripe — [Stripe engineering: the globe](https://stripe.com/blog/globe), [Stripe site analysis](https://webtrends.pages.dev/posts/stripe-website-design-analysis), [bram.us on the Stripe gradient](https://www.bram.us/2021/10/13/how-to-create-the-stripe-website-gradient-effect). Takeaway: Stripe's motion mostly *confirms* actions and visualises the product (payments flowing), and its signature gradient is WebGL — too heavy and against our no-decorative-gradient rule.
- Linear — [LogRocket on Linear-style design](https://blog.logrocket.com/?p=186781), [Linear-style design origins](https://bootcamp.uxdesign.cc/the-rise-of-linear-style-design-origins-trends-and-techniques-4fd96aab7646). Takeaway: near-monochrome palette, restrained motion that guides attention, dark-mode parity, two-tone headlines.
- Mercury / Ramp / Wise and trust patterns — [Utsubo: fintech trust design patterns](https://www.utsubo.com/blog/fintech-website-trust-design-patterns), [DesignRevision: fintech SaaS landing pages](https://designrevision.com/blog/fintech-saas-landing-pages.md), [Mercury teardown](https://landingdoctors.com/teardowns/mercury-com). Takeaways: show the real product UI instead of abstract art (Mercury), let visitors *experience value before converting* (Ramp), and make pricing transparent with a calculator that shows exactly what is paid and received (Wise). Put compliance/security signals near the decision points.
- Scroll-driven animation support — [CSS scroll-driven animations go cross-browser](https://www.buildmvpfast.com/blog/css-scroll-driven-animations-replace-js-2026), [Website Spec: scroll-driven animations](https://www.specification.website/spec/performance/scroll-driven-animations/). Chrome/Edge since 115 and Safari 26 support `animation-timeline`; Firefox support is not reliable, so scroll timelines can only be progressive enhancement.
- Reduced motion — [WCAG 2.3.3 Animation from Interactions](https://www.disabilityworld.org/toolkit/standards/wcag/2-3-3-animation-from-interactions/), [OpenReplay on prefers-reduced-motion](https://blog.openreplay.com/prefers-reduced-motion-accessible-animation/). With `reduce`, motion must disappear, not merely shorten; content must be complete without motion.
- `@property` counters — [Animating integers in CSS](https://devbytes.co.in/news/animate-integers-in-css-without-javascript-heres-how), [Cruip animated counters](https://cruip.com/how-to-make-an-animated-number-counter-with-tailwind-css/). Pure-CSS counters are not reliably read by screen readers and have Safari gaps, so counters use a tiny rAF tween with an `sr-only` final value; `@property` is used only for a registered percentage that animates the redirect progress bar.

### What we adopted and why

| Pattern | Source | How it appears here | Why |
| :--- | :--- | :--- | :--- |
| Product-as-hero, interactive demo | Mercury, Ramp | Hero payment simulator the visitor can drive | Shows the real flow (rails → statuses → ledger) instead of claiming it. |
| Payment-flow visualisation | Stripe | "How money moves" track + ledger card posting lines | Our differentiator is reconciliation; animate it. |
| Two-tone headline, monochrome palette | Linear, Vercel | Ink + muted ink h1, single blue accent, green only for success | Matches the existing anti-"AI-slop" design system. |
| Curated bento | SaaSFrame | 12-column bento with one wide links cell and small proof cells | Many capabilities, scannable in one view. |
| Transparent pricing calculator | Wise | Fee preview for the three fee-bearer modes | Fee bearer modes are a real product feature; let merchants try them. |
| Trust near decisions | Utsubo/DesignRevision | Security & compliance section, "KYB-verified" proof point under the CTAs | Central-bank-regulated audience. |
| Facts as counters | common SaaS | 5 / 3 / 2 / **0** (floating-point operations on money) | Only countable facts we can prove; the "0" is the memorable one. |

Rejected: WebGL gradients/globes (weight, gradient rule), auto-scrolling logo marquees (we cannot name partner rails as "supported" — the gateway catalogue is operator-configured — and marquees need pause controls), fake "live volume" counters and "All systems operational" badges (no public status source exists).

## 3. Concept

**"Collect on any rail. Reconcile every dinar."** The page tells one story: a payment link travels through a rail the merchant enabled, is confirmed only on trusted evidence, posts a balanced double-entry journal and lands in a ledger-derived wallet. Every section is a zoom-in on one part of that story.

## 4. Sections

1. **Sticky glass header** — brand, anchor nav, ع/EN toggle, theme toggle, Login, Get started.
2. **Hero** — eyebrow pill, two-tone h1, lede, primary (`Register`) and secondary (`Login`) CTAs, three proof points; right column is the **simulator**:
   - A hosted-checkout window (server-priced 250.000 LYD) with five rail buttons mapping to the five checkout client actions (`SHOW_OTP_FORM`, `SHOW_QR_OR_CODE`, `SHOW_PUSH_OR_TRANSFER`, `HTTP_REDIRECT`, `RENDER_EMBEDDED`).
   - Five steps: pick rail → customer action (OTP digits type in, QR scan line, push card drops and is tapped, redirect bar sweeps, card form) → `VERIFYING` → `SUCCEEDED` (drawn check) → journal posted.
   - An overlapping ledger card: Dr gateway clearing 250.000 / Cr wallet 243.750 / Cr platform commission 6.250 (2.5 % example), "Balanced" badge, wallet count-up computed with decimal.js.
   - Play/pause and next-step controls, a caption that is announced only after user interaction, and an "illustrative" note.
3. **How money moves** — five nodes with real state chips (`lnk_…`, `AWAITING_CUSTOMER`, `SUCCEEDED`, `Σ Dr = Σ Cr`, `IBAN`); the connecting track fills when revealed, horizontal on desktop and vertical on mobile.
4. **Product bento** — payment links & QR; live POS screen (one "waiting → paid" cycle); fee preview (interactive); wallets & sealed statements (snapshot hash, Excel export); four-eyes changes; disputes with deadlines; team roles; bring your own gateway (`MERCHANT_DIRECT`).
5. **Stats band** — 5 ways to pay, 3 fee-bearer modes, 2 languages with full RTL, 0 floating-point operations on money (counts *down* from 100).
6. **Developers** (lazy chunk) — tokens, IP CIDR allowlists, decimal strings, verify-by-API; code window with cURL/TypeScript/Python tabs, copy button and the real `201` response shape.
7. **Security & compliance** — maker-checker, KYB/AML, mTLS between edge and core, AES-256-GCM write-only secrets, append-only ledger, least privilege; an illustrative `ledger.invariant` panel.
8. **Onboarding** — six steps matching the portal onboarding page.
9. **FAQ** — native `<details>` with honest answers (including "is there a sandbox?").
10. **Final CTA and footer**.

## 5. Motion system

Tokens (in `landing.css`): `--pgl-ease: cubic-bezier(.22,1,.36,1)`, durations 160 / 320 / 640 ms, stagger 70 ms via `--pgl-i`, and `--pgl-dir` (1 or −1) for direction-aware translations.

| Mechanism | Used for | Fallback |
| :--- | :--- | :--- |
| IntersectionObserver + `data-revealed` | Section/card reveals, flow track fill, POS cycle, onboarding badges | Nothing is hidden unless JS sets `data-motion="on"` and the user allows motion. |
| CSS keyframes | Simulator micro-interactions (OTP typing, QR scan, push drop/tap, check draw, journal posting glow) | Final states are the static styles. |
| `@property --pgl-sweep` | Redirect progress bar width | Static 70 % bar. |
| `animation-timeline: scroll()` | Header hairline appears after 64 px of scroll | `data-scrolled` attribute from a passive scroll listener. |
| View Transitions | Theme and language switches cross-fade | Instant switch. |
| rAF tween (`animateProgress`) | Wallet count-up (Decimal × progress) and stats | Final value immediately. |

Loop discipline (WCAG 2.2.2): the simulator autoplay pauses when off-screen, when the tab is hidden and when the user presses pause; pulses run six iterations; the spinner exists only during the 1.7 s verifying step. The h1 (LCP) animates transform only, never opacity.

## 6. Accessibility and RTL decisions

- One `h1`; every section has an `h2` referenced by `aria-labelledby`; cards use `h3`.
- Skip link to `#pgl-main`; anchor nav scrolls and moves focus to the section; scroll margin accounts for the sticky header.
- All controls are native buttons/links with visible `:focus-visible` rings; rail buttons and language buttons use `aria-pressed`; `SegmentedTabs` arrow keys now follow the rendered direction (bug fixed: they were LTR-only).
- `prefers-reduced-motion: reduce`: every animation and transition inside `.pgl-root` is disabled, the simulator opens on its final step with autoplay off, counters show final values, smooth scrolling is off.
- Forced-colours mode keeps borders on cards and highlights pressed toggles.
- RTL: logical properties throughout; the flow track's `transform-origin` and the journal slide direction flip; arrows and skip icons flip; code, URLs, money and the code window are `dir="ltr"`; Arabic headings get `letter-spacing: 0` and taller line-height (Cairo); Latin tokens inside Arabic strings are wrapped in U+2066/U+2069 isolates so underscores and slashes stay in place.
- Inputs in the fee preview accept Arabic-Indic digits and the Arabic decimal separator.
- Contrast uses the existing token pairs; dark surfaces (code window, POS screen, invariant panel) use fixed light-on-dark colours that pass AA in both themes.

## 7. Claim verification

| Claim on the page | Evidence |
| :--- | :--- |
| Server-priced links, checkout cannot change amount | checkout contract, `project-design/parts/05-checkout-front/00-payer-flow.md` §2/§4 |
| Five checkout experiences | `RENDER` client actions, `project-design/parts/01-core-back/02-engine.md` |
| Trusted success only on verified evidence | engine trusted-success facts, same part |
| Balanced double-entry journal, 4 dp | `project-design/parts/01-core-back/03-ledger.md` (`Decimal(18,4)`, `PLATFORM_CLEARING`) |
| Fee-bearer modes | ledger part and guide M-04; `MerchantFeeCalculator` formulas |
| `MERCHANT_DIRECT` own credentials | portal §3.12, ledger ownership modes |
| Maker-checker on wallet/rail/redirect changes | portal §3.6, AGENTS invariants |
| mTLS 1.3 edge↔core, AES-256-GCM secrets | `project-design/parts/00-platform/02-security-and-mtls.md` |
| Token hash, scopes, IP allowlist | merchant-back part, developer guide D-02 |
| Create-link snippet fields and `201` body | `core-back/api/internal/merchant.ts` `linkCreateSchema` and `/external/links` handler (tested) |

Not claimed on purpose: named partner gateways as "supported", outbound signed merchant webhooks (no sender exists in core-back), a self-service sandbox, uptime/status, fixed pricing or a currency list.

## 8. Performance

- Hero is static HTML + small SVG; no images except the existing logo.
- `landing.css` and the page JS live in the landing route chunk; `DeveloperSection` is a separate chunk loaded when the section is within 600 px of the viewport, with a reserved-height placeholder to avoid layout shift.
- No new runtime dependency; decimal.js was already in the bundle.
