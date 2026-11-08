# Guide content questions

Append-only list of behaviour or label questions found while implementing the
Admin Interactive Guide. These do not block the build.

1. `sg-reverse-adjustment` — the design names a **Reverse** action on
   `pages/adjustments`, but the current screen has no Reverse action or reverse
   endpoint. It exposes **Reverse commission** as a field on a new adjustment
   instead. The safeguard is implemented in the card catalog but could not be
   wired to a request. Confirm whether a dedicated Reverse action is planned.
2. `sg-release-reservation` — the design names a **Release reservation**
   resolution on `pages/operator-cases`. The current screen combines releasing
   the link reservation into **Resolve as failed and release reservation**
   (`MARK_FAILED`). Only `sg-resolve-unknown` is shown for that action.
3. `sg-aml-rule-change` and `sg-aml-report` — the design names **Create** and
   **Save**. The current AML rules screen has no save/update action, and the
   reports screen calls its save-equivalent **Save authority decision**. Both
   creation and acknowledgement paths are guarded.
4. `sg-run-reconciliation` — the design names **Run File**; the current action
   is **Upload** with a separate statement-file field. The upload path is
   guarded.
5. `sg-edit-route` and `sg-ai-import-draft` — the design's cards use
   **Create**/**Save** and "creating the draft". The current labels are
   **Create**/**Save** for routes and **Create Draft** for the AI importer;
   both paths are guarded.

## Text and code disagree: owner decisions (2026-11-07 readability overhaul)

The rewrites kept the original wording in every case below. Change either the code or the article once you decide which is intended.

1. `b08-07` Cash-outs: the article describes a second Finance user approving the subtraction (`PENDING`, `PROCESSING`, `COMPLETE`, `SUBTRACTED`). The code lets one actor process a request straight to `COMPLETE` (`executeCashout` in `core-back/engine/governance/GovernanceExecution.ts`; `PROCESSING` and `SUBTRACTED` are unused). This also touches the maker-checker invariant.
2. `b08-05`, `b08-06`, `b08-07` (and `l-m9-2`): "drift stops automatic payouts". `core-back/engine/workers/LedgerInvariantWorker.ts` only opens a P1 case; nothing was found that halts payouts (`project-design/parts/01-core-back/05-workers.md`).
3. `b08-03`: commission-profile changes "go through approval". The governance part documents creation as a direct route.
4. Circuit breaker: `b06-08` (gateway faults and ambiguous results count), `b06-11` (partner faults only) and the lesson check (gateway faults only) disagree. The code uses a per-error flag `counts_toward_breaker` (`core-back/engine/specImporter/specSchema.ts`).
5. `b06-15` says "twenty integrations" but lists 21 gateways. `b12-05` is titled "twelve-step" while `deploy/deploy.ts` runs 14 steps. `b12-03` says four certificates but the tool also creates backup-daemon, Fake Rails and optional storage certificates.
6. `b06-11`: WEIGHTED is described as a share of traffic; `VisibleRailsResolver.ts` only sorts by weight.
7. `b09-*`: the article says a screening suppression "may" carry an expiry date; the exam says it "must".
8. `b08-13`: rule 2 offers suspending the merchant, while rule 4 says suspension is blocked.
9. `b06-09` / `b03-12` Credential Sets: `b06-09` says credential changes need two people (`GATEWAY_ADMIN` proposes, `SECURITY_ADMIN` approves), and `project-design/parts/01-core-back/04-governance-compliance.md` lists a `CREDENTIAL_SET` approval subject with no execution branch. The Credential Sets screen and `core-back/api/internal/admin.ts` create, rotate, verify and revoke immediately, with no approval. `b03-12` describes the screen's real behaviour and carries a note about the mismatch. Decide whether to add the approval flow or reword `b06-09`.
