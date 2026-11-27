/**
 * The non-human drafting principal, shared by the runtime automation and the
 * synthetic seeder.
 *
 * The identity is a real `users` row so that the foreign keys of
 * `approval_requests.maker_user_id` and `audit_log.actor_id` stay intact, but
 * it is `DISABLED`, it carries no authority and it can never be a checker.
 *
 * The row is canonical: `ensureSystemAutomationUser` finds or creates it by
 * e-mail, and the seeder MUST reuse the database id when the runtime already
 * created it. Generating a second id for the same e-mail makes the seeder's
 * `users` insert skip the row (unique e-mail) and leaves every approval that
 * names the generated id violating `approval_requests_maker_user_id_fkey`.
 */
export const SYSTEM_AUTOMATION_EMAIL = "system-drafter@payment-gateway.internal";

/** Legacy sentinel for code that must refuse the automation principal as a checker. Never stored in a UUID column. */
export const SYSTEM_AUTOMATION_USER_ID = "SYSTEM_AUTOMATION";
