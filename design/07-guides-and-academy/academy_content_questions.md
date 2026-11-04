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
