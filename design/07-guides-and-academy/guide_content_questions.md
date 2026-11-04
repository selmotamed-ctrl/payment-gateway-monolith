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
