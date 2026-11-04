# Guide content fixes

Append-only log for label and route-map corrections made while implementing the
Admin Interactive Guide. Format: `articleId | old label | new label | file:line`.

## Context-map route names (guide design §II-6, phase G-4)

| Screen | Change | Reason | Source |
| :--- | :--- | :--- | :--- |
| JoinRequests | Added `JoinRequestNew`, `JoinRequestDetail`, `KybReviewDetail` | Router names rendered by pages in `pages/join-requests` and `pages/kyb`, which the design groups under JoinRequests. | `admin-front/src/router/index.ts` |
| OperatorCases | Added `OperatorCaseDetail`, `GatewayInquirySchedules` | Detail and inquiry pages use `pages/operator-cases`. | `admin-front/src/router/index.ts` |
| Finance | Added `PricingControls` | `pages/finance/pricing` has no dedicated screen entry; Finance owns `pages/finance`. | `admin-front/src/router/index.ts` |
| Routes | Added `GatewayRoutes` | The real router name is `GatewayRoutes`, not `Routes`. | `admin-front/src/router/index.ts` |
| CheckoutHelp | Added `AdminCheckoutHelp` | The real router name is `AdminCheckoutHelp`, not `CheckoutHelp`/`SettingsCheckoutHelp`. | `admin-front/src/router/index.ts` |
| General | Added `AdminUsers`, `AdminUserDetail`, `AuditLog`, `AdminPlatformSettings`, `SystemBackups` | These route names render pages without a dedicated screen entry; General is the fallback screen. | `admin-front/src/router/index.ts` |

## Label corrections verified against the code

No article label text was changed. The following code labels differ from the
guide design's wording; they are recorded here and in
`guide_content_questions.md` rather than editing an explanation:

| Card | Design label | Actual label | File:line |
| :--- | :--- | :--- | :--- |
| `sg-bulk-inquiry` | **Bulk Inquiry** | **Inquire selected** / **Inquire about selected cases** | `admin-front/src/pages/operator-cases/index.tsx:1074` |
| `sg-resolve-unknown` | **Mark succeeded** / **Mark failed** | **Resolve as succeeded** / **Resolve as failed and release reservation** | `admin-front/src/pages/operator-cases/[id].tsx:189` |
| `sg-suspend-merchant` | **Suspend Merchant** | **Suspend** (dialog **Suspend merchant**) | `admin-front/src/pages/merchants/[id].tsx:714` |
| `sg-reinstate-merchant` | **Reinstate Merchant** | **Reinstate** (dialog **Reinstate merchant**) | `admin-front/src/pages/merchants/[id].tsx:717` |
| `sg-edit-merchant-sensitive` | **Submit For Approval** | **Submit for approval** | `admin-front/src/pages/merchants/components/MerchantEditDialog.tsx:223` |
| `sg-aml-rule-change` | **Create** / **Save** | **Draft rule** → **Create draft** (no Save action) | `admin-front/src/pages/aml/rules/index.tsx:456` |
| `sg-aml-report` | **Create** / **Save** | **Draft report** → **Create draft**; **Save authority decision** | `admin-front/src/pages/aml/reports/index.tsx:582` |
| `sg-run-reconciliation` | **Run File** | **Upload** | `admin-front/src/pages/reconciliation/index.tsx:793` |
