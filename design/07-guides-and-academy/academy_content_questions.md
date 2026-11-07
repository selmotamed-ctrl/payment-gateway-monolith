# Academy content questions

Open behaviour questions found while implementing or auditing the Employee Academy. Format:
`itemId | claim in the content | what the code does | file:line`. Content is never edited for these;
they are for the owner of the Academy content to decide.

<!-- itemId | claim | actual behaviour | file:line -->
l-m6-6, lab-cashout-adjustments | **Reverse** proposes an offsetting adjustment | The Adjustments screen has no Reverse action, only a **Reverse commission** field | `admin-front/src/pages/adjustments/index.tsx:831`
lab-approval-desk | A reason is implied on every decision | The code requires a reason only when rejecting; Approve/Reject stay disabled until the decision checklist is complete | `admin-front/src/pages/approvals/index.tsx:1067-1087`
lab-kyb-desk | **Approve** / **Reject** on KYB review | Join requests use Approve/Reject; KYB document review uses **Accept** / **Reject** / **Save decision** | `admin-front/src/pages/kyb/components/KybReviewDialog.tsx:109`
l-m4 (Request information pauses the deadline) | The pause stops the SLA clock | The expiry worker's overdue sweep still includes `INFO_REQUESTED`; confirm the pause moves `sla_due_at` | `core-back/engine/workers/JoinRequestExpiryWorker.ts:58`
drills (Fake Rails) | **Trigger Webhook Replay**, **Send Forged-Signature Webhook**, **Full Outage 503**, upstream chargeback webhook button | Built labels: **Compose webhook**, **Forge signature** toggle, **Full outage** / **Outage**; no upstream chargeback button | `fake-rails-front/src/pages/transactions/index.tsx:109`, `components/WebhookComposerModal.tsx:109`, `pages/chaos-matrix/index.tsx:64`
l-m9-2, c-l-m9-2 and exam text | "Drift stops automatic payouts" | `LedgerInvariantWorker` opens a P1 case; nothing found halts payouts | `core-back/engine/workers/LedgerInvariantWorker.ts:47`
l-m8-3, l-m8-5, exam | Circuit breaker counts gateway faults only | Per-error flag `counts_toward_breaker`; `b06-08` and `b06-11` word it differently | `core-back/engine/specImporter/specSchema.ts:434`
l-m7-3, exam | A suppression "must" carry an expiry date | `b09-03` says "may" | `design/07-guides-and-academy/guide_system_design_and_content.md` (`b09-03`)
l-m5-4 | The button is called Bulk Inquiry | The built button is **Inquire selected** | `admin-front/src/pages/operator-cases/index.tsx:1077`
