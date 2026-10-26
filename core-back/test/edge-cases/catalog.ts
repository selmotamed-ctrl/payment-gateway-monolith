export type EdgeCaseGroup =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K";

export type EdgeCaseSeverity = "Low" | "Med" | "High";

export interface EdgeCase {
  id: number;
  group: EdgeCaseGroup;
  scenario: string;
  resolution: string;
  severity: EdgeCaseSeverity;
  check: string;
}

export const EDGE_CASE_GROUPS: Record<EdgeCaseGroup, { title: string; range: [number, number] }> = {
  A: { title: "Lifecycle and Timing", range: [1, 14] },
  B: { title: "Confirmation and Trust", range: [15, 31] },
  C: { title: "Money, Amounts, Fees and Ledger", range: [32, 48] },
  D: { title: "Routing, Failover and Availability", range: [49, 58] },
  E: { title: "Credentials and Account Ownership", range: [59, 67] },
  F: { title: "Configuration, Versioning and Operations", range: [68, 79] },
  G: { title: "Security and Abuse", range: [80, 90] },
  H: { title: "Customer Experience and Channels", range: [91, 98] },
  I: { title: "Multi-Instance Cluster, Time, Concurrency and Drift", range: [99, 115] },
  J: { title: "Onboarding, Identity, Compliance and Disputes", range: [116, 130] },
  K: { title: "NeomPay and Internal Rails", range: [131, 140] },
};

export const EDGE_CASE_CATALOG: EdgeCase[] = [
  { id: 1, group: "A", severity: "Med", scenario: "Customer closes browser after OTP sent or mid-redirect", resolution: "Attempt stays pending; page resumes from server state via attempt token; inquiry runs at expiry before declaring EXPIRED", check: "expiry_inquiry_before_expire" },
  { id: 2, group: "A", severity: "Low", scenario: "Reload or back button on OTP screen", resolution: "UI reads state from server; no second INITIATE; resend obeys the cooldown and cap", check: "otp_resend_cooldown" },
  { id: 3, group: "A", severity: "Med", scenario: "Gateway session expires before platform TTL", resolution: "expires_at equals the minimum of the gateway session TTL and the platform TTL", check: "effective_expiry_is_minimum" },
  { id: 4, group: "A", severity: "Med", scenario: "Repeated wrong OTP versus brute force", resolution: "RETRYABLE_OTP increments otp_attempts up to max_otp_attempts then transitions to FAILED", check: "otp_attempt_counter" },
  { id: 5, group: "A", severity: "High", scenario: "Correct OTP entered but the confirm call times out", resolution: "Transitions to UNKNOWN, never FAILED; the slot reservation is held; background polling resolves it", check: "timeout_moves_money_to_unknown" },
  { id: 6, group: "A", severity: "High", scenario: "Server restart or pod crash during an active attempt", resolution: "Durable expires_at and next_check_at with stateless FOR UPDATE SKIP LOCKED workers", check: "durable_worker_timers" },
  { id: 7, group: "A", severity: "Med", scenario: "Two browser tabs open the same single-use link", resolution: "Atomic active_locked_count reservation; the second tab sees payment in progress", check: "atomic_slot_reservation" },
  { id: 8, group: "A", severity: "High", scenario: "Customer retries while the previous attempt is UNKNOWN", resolution: "Slot reservation is held through UNKNOWN and retry is blocked server side", check: "slot_held_through_unknown" },
  { id: 9, group: "A", severity: "Med", scenario: "Customer switches rail mid flow", resolution: "Old attempt is cancelled or watched to expiry; the new attempt joins the same attempt group", check: "attempt_group_single_success" },
  { id: 10, group: "A", severity: "High", scenario: "Customer approves a push or scans a QR after EXPIRED", resolution: "Inbox stays open during the grace window; a verified late success transitions EXPIRED to SUCCEEDED", check: "late_success_recovery" },
  { id: 11, group: "A", severity: "Med", scenario: "Clock skew and timezone differences", resolution: "All timestamps are UTC; gateway timezones are explicit; webhook timestamps are tolerance checked", check: "gateway_timezone_formatting" },
  { id: 12, group: "A", severity: "Low", scenario: "Link expires between page load and form submit", resolution: "Initiation re-verifies expires_at inside the guard transaction and reports the link as unavailable", check: "link_expiry_reverified" },
  { id: 13, group: "A", severity: "High", scenario: "Multi-use link reaches use_count while attempts are in flight", resolution: "confirmed_count plus active_locked_count is bounded by use_count; excess settlement routes to SUSPENSE", check: "slot_invariant_bounded" },
  { id: 14, group: "A", severity: "Low", scenario: "POS screen hits the 15 minute idle timeout while a QR is pending", resolution: "The attempt continues server side and the screen resynchronises on reconnect", check: "pos_idle_timeout_resync" },

  { id: 15, group: "B", severity: "Med", scenario: "Webhook arrives before the initiate transaction commits", resolution: "Stored in the inbound_events inbox immediately and correlated asynchronously", check: "inbox_stored_before_processing" },
  { id: 16, group: "B", severity: "Low", scenario: "Webhook arrives for an unknown reference", resolution: "Stored with a null attempt id and no state effect", check: "unknown_reference_no_effect" },
  { id: 17, group: "B", severity: "High", scenario: "Duplicate webhooks delivered by the gateway", resolution: "Absorbed by the unique channel and dedupe key constraint and by the journal entry idempotency key", check: "duplicate_webhook_absorbed" },
  { id: 18, group: "B", severity: "High", scenario: "Out of order events", resolution: "The state machine is forward only and SUCCEEDED is never downgraded", check: "no_success_downgrade" },
  { id: 19, group: "B", severity: "High", scenario: "Verified success arrives after the attempt was marked FAILED", resolution: "Transitions FAILED to SUCCEEDED and raises a P2 alert", check: "late_success_after_failed" },
  { id: 20, group: "B", severity: "High", scenario: "Webhook says SUCCESS but the inquiry says FAILED", resolution: "Nothing is posted, the attempt is parked in UNKNOWN and a P1 conflict case opens", check: "conflicting_signals_unknown" },
  { id: 21, group: "B", severity: "Med", scenario: "Browser complete callback fires without a server webhook", resolution: "Treated as a hint only and the attempt stays VERIFYING with backoff polling", check: "browser_callback_is_hint" },
  { id: 22, group: "B", severity: "High", scenario: "Attacker sends a forged webhook claiming success", resolution: "Blocked by path token, IP allowlist, constant time signature verification and must_inquire", check: "forged_webhook_rejected" },
  { id: 23, group: "B", severity: "High", scenario: "Attacker replays a captured valid webhook", resolution: "Rejected by the timestamp tolerance and the stored dedupe key", check: "replay_window_rejected" },
  { id: 24, group: "B", severity: "Med", scenario: "Gateway retries the webhook aggressively", resolution: "The raw event is stored and the acknowledgement is returned before async processing", check: "ack_before_processing" },
  { id: 25, group: "B", severity: "High", scenario: "Valid signature but the settled amount or currency differs", resolution: "Evaluated against the route mismatch policy and held in SUSPENSE above tolerance", check: "amount_mismatch_held" },
  { id: 26, group: "B", severity: "Med", scenario: "Sandbox webhook sent to the live endpoint", resolution: "Separate path tokens and secrets per environment and the environment is verified", check: "environment_separation" },
  { id: 27, group: "B", severity: "High", scenario: "Gateway changes signature field order or algorithm", resolution: "Signature failure alerting fires and the raw bytes are preserved for lossless replay", check: "raw_bytes_preserved" },
  { id: 28, group: "B", severity: "Med", scenario: "Customer tampers with the return_url query string", resolution: "Return parameters never confirm a payment and only trigger an inquiry", check: "return_url_is_hint" },
  { id: 29, group: "B", severity: "Med", scenario: "Callback arrives as form, XML or non UTF-8 content", resolution: "The channel body format parses the fields while the raw body is preserved for the HMAC check", check: "body_format_parsing" },
  { id: 30, group: "B", severity: "Med", scenario: "Callback source IP is masked by a proxy", resolution: "The real IP is resolved through trusted proxy hops only", check: "trusted_proxy_ip_resolution" },
  { id: 31, group: "B", severity: "High", scenario: "Gateway offers neither signature nor inquiry API", resolution: "Flagged high risk and requires executive risk acceptance plus statement reconciliation", check: "high_risk_requires_acceptance" },

  { id: 32, group: "C", severity: "High", scenario: "Settled amount differs from the requested amount", resolution: "Stored in settled_amount and governed by the route mismatch policy", check: "settled_amount_recorded" },
  { id: 33, group: "C", severity: "High", scenario: "Amount scale bug on dirham scaled gateways", resolution: "Prevented by the amount scale configuration and the mandatory amount pipeline contract test", check: "amount_scale_contract" },
  { id: 34, group: "C", severity: "Med", scenario: "Rail currency differs from the payment link currency", resolution: "The visible rails formula hides any rail whose currency differs", check: "currency_mismatch_hidden" },
  { id: 35, group: "C", severity: "Med", scenario: "Customer borne fee", resolution: "The surcharge is calculated from the commission profile, displayed before confirmation and booked", check: "payer_surcharge_booking" },
  { id: 36, group: "C", severity: "Low", scenario: "Customer hits a personal ceiling", resolution: "Mapped to LIMIT_EXCEEDED and excluded from the circuit breaker failure count", check: "limit_exceeded_not_breaker" },
  { id: 37, group: "C", severity: "Med", scenario: "Gateway changes its transaction limits", resolution: "Enforced on the rail routes plus optional capability probe limit sync", check: "route_limits_enforced" },
  { id: 38, group: "C", severity: "Med", scenario: "Partial or over payment received", resolution: "Held in SUSPENSE under the mismatch policy and resolved by a Maker-Checker adjustment", check: "overpayment_held_in_suspense" },
  { id: 39, group: "C", severity: "Med", scenario: "Refund requested after the refund window or on a no-refund rail", resolution: "Blocked by the rail capability check and requires a manual Maker-Checker adjustment", check: "refund_window_enforced" },
  { id: 40, group: "C", severity: "High", scenario: "Upstream gateway initiates a chargeback", resolution: "A chargeback adjustment is drafted automatically and posts to the chargeback reserve on checker approval", check: "chargeback_drafted" },
  { id: 41, group: "C", severity: "High", scenario: "Second payment succeeds on a single-use link", resolution: "The attempt group detects the duplicate and the second settlement posts to SUSPENSE", check: "duplicate_settlement_to_suspense" },
  { id: 42, group: "C", severity: "High", scenario: "Statement has missing or extra lines", resolution: "Reconciliation flags MISSING_AT_GATEWAY or MISSING_LOCALLY and opens operator cases", check: "reconciliation_flags_drift" },
  { id: 43, group: "C", severity: "Med", scenario: "Gateway settles in T+N net batches", resolution: "The statement parser supports batch net lines and matches the batch reference", check: "batch_net_parsing" },
  { id: 44, group: "C", severity: "Low", scenario: "Gateway changes its fee rate mid month", resolution: "The route cost model is effective dated and the statement difference posts as a fee variance", check: "fee_variance_true_up" },
  { id: 45, group: "C", severity: "High", scenario: "Three decimal link paid on a two decimal gateway", resolution: "The wire amount is stored separately and the rounding direction is pinned by a contract test", check: "wire_amount_rounding" },
  { id: 46, group: "C", severity: "Low", scenario: "Percentage commission leaves a sub 0.0001 remainder", resolution: "Deterministic NUMERIC(18,4) rounding keeps net merchant plus commission equal to the amount", check: "commission_rounding_identity" },
  { id: 47, group: "C", severity: "Med", scenario: "Statement uploaded with an Arabic encoding or custom delimiter", resolution: "The parser configuration specifies encoding, delimiter and date format", check: "statement_encoding_config" },
  { id: 48, group: "C", severity: "Med", scenario: "Merchant fails to pay the commission receivable", resolution: "When the receivable exceeds the ceiling the direct routes pause and the balance nets", check: "receivable_ceiling_pauses_routes" },

  { id: 49, group: "D", severity: "Med", scenario: "Primary gateway is down at initiate before any send", resolution: "Classified as a definitive pre point of no return failure and the engine fails over", check: "pre_send_failure_fails_over" },
  { id: 50, group: "D", severity: "Med", scenario: "Gateway is slow or flapping", resolution: "Per step abort timeouts and rolling health samples move the route to DEGRADED then OPEN_BREAKER", check: "health_samples_drive_breaker" },
  { id: 51, group: "D", severity: "Low", scenario: "Scheduled maintenance window", resolution: "The route is hidden proactively during the maintenance window", check: "maintenance_window_hides_route" },
  { id: 52, group: "D", severity: "Med", scenario: "Gateway is retired or migrated", resolution: "The route is set to DRAINING then RETIRED while history is preserved", check: "draining_then_retired" },
  { id: 53, group: "D", severity: "Med", scenario: "The sole route for a rail opens its breaker", resolution: "The rail disappears from the visible rails automatically and an alert fires", check: "breaker_removes_rail" },
  { id: 54, group: "D", severity: "Med", scenario: "Aggregator down while the direct gateway is up", resolution: "The per route breaker isolates the aggregator and the direct route keeps serving", check: "route_level_breaker_isolation" },
  { id: 55, group: "D", severity: "High", scenario: "Customer retries across aggregator and direct routes", resolution: "Both attempts share the attempt group and the first confirmation wins", check: "shared_attempt_group" },
  { id: 56, group: "D", severity: "Med", scenario: "Gateway rate limits the platform", resolution: "The outbound limiter and concurrency cap back off and 429 never trips the breaker", check: "rate_limit_not_breaker" },
  { id: 57, group: "D", severity: "High", scenario: "Gateway changes the JSON response after a 200 OK debit", resolution: "A missing required output on a money step moves the attempt to UNKNOWN and preserves the raw text", check: "missing_output_unknown" },
  { id: 58, group: "D", severity: "Low", scenario: "Route hits its daily cap", resolution: "The ranker excludes the route for the rest of the day", check: "daily_cap_excludes_route" },

  { id: 59, group: "E", severity: "Low", scenario: "Merchant enters invalid API credentials", resolution: "The credential check runs on save and the set stays UNTESTED or FAILING", check: "credential_check_on_save" },
  { id: 60, group: "E", severity: "Med", scenario: "Merchant credentials expire or are revoked", resolution: "Runtime auth errors mark the set FAILING, hide its routes and let in-flight attempts finish", check: "failing_credentials_hide_routes" },
  { id: 61, group: "E", severity: "Med", scenario: "Zero downtime secret rotation", resolution: "Multiple active secret versions are verified in constant time during the overlap window", check: "secret_version_overlap" },
  { id: 62, group: "E", severity: "Med", scenario: "OAuth2 token refresh fails transiently", resolution: "The single flight refresh keeps the current token and schedules a jittered retry", check: "single_flight_refresh" },
  { id: 63, group: "E", severity: "Med", scenario: "Two merchants register the same gateway merchant id", resolution: "Blocked by the unique credential set constraint and flagged for compliance", check: "credential_set_uniqueness" },
  { id: 64, group: "E", severity: "Low", scenario: "Merchant migrates from direct to platform settlement", resolution: "New credential sets and routes are activated under Maker-Checker while history is untouched", check: "ownership_migration_pinned" },
  { id: 65, group: "E", severity: "Med", scenario: "Merchant suspended while payments are in flight", resolution: "New attempts are blocked while in-flight confirmations post to hold or suspense", check: "suspension_blocks_new_attempts" },
  { id: 66, group: "E", severity: "High", scenario: "Merchant A credentials used for Merchant B", resolution: "Prevented by the route scope check and the owner assertion in the orchestrator", check: "credential_owner_assertion" },
  { id: 67, group: "E", severity: "High", scenario: "Merchant direct payment triggers an AML threshold hit", resolution: "The platform holds no cash so the completion screen is blocked and a case opens", check: "merchant_direct_aml_case" },

  { id: 68, group: "F", severity: "High", scenario: "Admin edits a gateway flow while customers are entering OTPs", resolution: "Every attempt pins its gateway version at creation and finishes on that exact version", check: "version_pinning" },
  { id: 69, group: "F", severity: "High", scenario: "Defective gateway version promoted to live", resolution: "Gated by the twelve go live gates and the canary rollout with one click rollback", check: "rollback_version_named" },
  { id: 70, group: "F", severity: "Low", scenario: "Two admins edit the same gateway concurrently", resolution: "Optimistic concurrency on the version number and independent draft snapshots", check: "independent_draft_snapshots" },
  { id: 71, group: "F", severity: "High", scenario: "Sandbox traffic reaches the live ledger", resolution: "Sandbox attempts are structurally separated and excluded from financial queries", check: "sandbox_ledger_separation" },
  { id: 72, group: "F", severity: "Med", scenario: "Gateway rejects the reference format", resolution: "The per gateway reference format enforces charset and length and uniqueness is checked first", check: "reference_format_enforced" },
  { id: 73, group: "F", severity: "Low", scenario: "Gateway brand name collision", resolution: "The gateway stores code, operator, country and aliases and displays them in the wizard", check: "gateway_alias_resolution" },
  { id: 74, group: "F", severity: "Med", scenario: "Exported gateway template imported elsewhere", resolution: "Exports omit secrets and the imported version lands as a draft requiring secret entry", check: "export_omits_secrets" },
  { id: 75, group: "F", severity: "Low", scenario: "Maker is unavailable while an approval is pending", resolution: "Any eligible checker can review and self approval is impossible", check: "checker_substitution" },
  { id: 76, group: "F", severity: "High", scenario: "Admin exports configuration containing sensitive tokens", resolution: "The multi layer redactor scrubs secret names and literal secret strings", check: "config_export_redacted" },
  { id: 77, group: "F", severity: "Med", scenario: "Backlog of UNKNOWN attempts accumulates", resolution: "The operator queue tracks SLA timers, supports bulk inquiry and pages the duty officer", check: "operator_case_sla" },
  { id: 78, group: "F", severity: "Low", scenario: "Legacy hard coded gateway classes are migrated", resolution: "They wrap as native adapters behind the six method contract", check: "native_adapter_contract" },
  { id: 79, group: "F", severity: "Low", scenario: "Operator deletes a rail with historical attempts", resolution: "Deletion is blocked by foreign keys, the gateway retires and the rail is blocked", check: "soft_delete_only" },

  { id: 80, group: "G", severity: "High", scenario: "Client posts a modified amount or currency", resolution: "Client schemas have no amount field and the amount is read from payment_links only", check: "checkout_no_amount_field" },
  { id: 81, group: "G", severity: "High", scenario: "Payer enters a card number on an OTP rail", resolution: "PAN fields are memory only, excluded from the context and logs and gated by PCI review", check: "pan_memory_only" },
  { id: 82, group: "G", severity: "Med", scenario: "Attacker probes registered phone numbers through OTP errors", resolution: "Error maps normalise the responses into a generic bilingual message", check: "generic_error_message" },
  { id: 83, group: "G", severity: "High", scenario: "SMS OTP pumping across thousands of numbers", resolution: "Atomic sliding window velocity rules and resend cooldowns block the flood", check: "velocity_rule_atomic" },
  { id: 84, group: "G", severity: "Med", scenario: "Open redirect through the payment link redirect url", resolution: "The redirect url is validated against the application allow list and the checkout sets frame ancestors none", check: "redirect_allowlist" },
  { id: 85, group: "G", severity: "Med", scenario: "Gateway returns a huge payload or an XML bomb", resolution: "The outbound client caps the response bytes, JSON depth and disables XML entities", check: "response_size_and_depth_cap" },
  { id: 86, group: "G", severity: "High", scenario: "Customer injects script or header payloads into a form field", resolution: "Destination correct encoding and CR/LF rejection", check: "injection_rejected" },
  { id: 87, group: "G", severity: "High", scenario: "SSRF or DNS rebinding through a configured gateway URL", resolution: "The DNS hook blocks private, loopback and link local addresses at connection time", check: "ssrf_dns_guard" },
  { id: 88, group: "G", severity: "Med", scenario: "Inbound path token leaks into third party logs", resolution: "The token is rotated with overlapping validity and signatures still block unauthorised callers", check: "path_token_rotation" },
  { id: 89, group: "G", severity: "High", scenario: "Compromised admin account reroutes payouts or secrets", resolution: "All credential, route, commission and payout edits require four eyes approval", check: "four_eyes_for_sensitive_edits" },
  { id: 90, group: "G", severity: "Med", scenario: "Payer uploads malware disguised as a transfer receipt", resolution: "Magic byte MIME checks, a size cap and antivirus scanning protect the reviewer", check: "upload_magic_bytes" },

  { id: 91, group: "H", severity: "Low", scenario: "Customer types Arabic-Indic digits or a plus 218 prefix", resolution: "The field normaliser converts the digits and the phone format before validation", check: "arabic_digit_normalisation" },
  { id: 92, group: "H", severity: "Med", scenario: "In-app browser blocks the payment script", resolution: "The checkout detects the restriction and falls back to a redirect on the same rail", check: "webview_redirect_fallback" },
  { id: 93, group: "H", severity: "Low", scenario: "Gateway returns a raw technical error string", resolution: "The error map translates mapped codes and shows a safe generic message otherwise", check: "bilingual_error_mapping" },
  { id: 94, group: "H", severity: "Low", scenario: "Deep link on desktop or without the wallet app", resolution: "The checkout renders the QR and pay code alongside the deep link", check: "deep_link_qr_fallback" },
  { id: 95, group: "H", severity: "Low", scenario: "Cashier cancels a pending QR payment on the terminal", resolution: "The cancel flow runs, the attempt is cancelled, the reservation is released and the inbox stays open", check: "cancel_releases_reservation" },
  { id: 96, group: "H", severity: "Med", scenario: "Slow SMS delivery causes repeated submits", resolution: "The UI counts down and the backend enforces idempotency and the resend cooldown", check: "submit_idempotency" },
  { id: 97, group: "H", severity: "High", scenario: "Ledger insert fails transiently after a confirmed success", resolution: "The status transition and the ledger posting share one transaction and retry idempotently", check: "atomic_success_and_ledger" },
  { id: 98, group: "H", severity: "Low", scenario: "Merchant notification is emitted twice on retry", resolution: "Notifications are emitted from the committed outbox with a unique event id", check: "notification_event_uniqueness" },

  { id: 99, group: "I", severity: "Med", scenario: "Timezone database update shifts the gateway timestamp", resolution: "Formatting uses IANA timezones and contract tests assert fixed historical instants", check: "tzdata_stability" },
  { id: 100, group: "I", severity: "High", scenario: "Duplicate webhook redelivered across a pod restart", resolution: "The inbox dedupe key and the journal entry uniqueness guarantee zero double posting", check: "cluster_dedupe" },
  { id: 101, group: "I", severity: "Med", scenario: "Finance approves a refund while a new attempt starts on a multi-use link", resolution: "The refund adjustment locks and references the specific source attempt", check: "refund_locks_attempt" },
  { id: 102, group: "I", severity: "Med", scenario: "Gateway reorders columns in the daily settlement statement", resolution: "The parser validates the header row and halts on schema drift", check: "statement_schema_drift" },
  { id: 103, group: "I", severity: "Med", scenario: "Route paused on one node while another serves traffic", resolution: "The invalidation bus evicts caches and initiation re-verifies the route state", check: "invalidation_bus_evicts" },
  { id: 104, group: "I", severity: "Med", scenario: "Gateway incident releases ten thousand webhook retries", resolution: "The receiver performs a lightweight insert and acknowledgement and the worker drains with caps", check: "inbox_backlog_drain" },
  { id: 105, group: "I", severity: "Low", scenario: "POS tablet loses connectivity mid payment", resolution: "The attempt completes server side and the screen replays the state on reconnect", check: "pos_reconnect_replay" },
  { id: 106, group: "I", severity: "Med", scenario: "Clock drift between the platform and the gateway", resolution: "Timestamp rejection triggers the security runbook while the raw event is preserved", check: "timestamp_tolerance_alert" },
  { id: 107, group: "I", severity: "High", scenario: "Admin configures a static reusable QR code", resolution: "The save time validator requires QR flows to bind the attempt reference or a dynamic session output", check: "qr_binds_attempt_reference" },
  { id: 108, group: "I", severity: "Med", scenario: "Rolling deployment runs two application versions", resolution: "Both versions execute the pinned gateway version snapshot with the closed transform library", check: "rolling_deploy_version_pinning" },
  { id: 109, group: "I", severity: "Med", scenario: "Route drains or the credential set is revoked with attempts in flight", resolution: "Pinned route and credential identifiers let in-flight attempts finish", check: "in_flight_attempts_finish" },
  { id: 110, group: "I", severity: "High", scenario: "Settlement sweep runs while a late payment confirms", resolution: "Row level locking on the account checkpoint serialises the sweep", check: "checkpoint_row_lock" },
  { id: 111, group: "I", severity: "Med", scenario: "Merchant edits payout details while a cash out is processing", resolution: "The cash out snapshots the destination bank details at creation", check: "cashout_destination_snapshot" },
  { id: 112, group: "I", severity: "Med", scenario: "Aggregator renames an underlying payment alias", resolution: "The nightly credential check detects the missing alias and marks the route degraded", check: "alias_capability_probe" },
  { id: 113, group: "I", severity: "High", scenario: "Two partial refund adjustments are approved concurrently", resolution: "Execution serialises on the attempt and asserts the executed refunds stay within the settled amount", check: "partial_refund_serialisation" },
  { id: 114, group: "I", severity: "Med", scenario: "Gateway returns a non-unique provider reference", resolution: "Correlation prefers our reference and scopes provider only matching to the active window", check: "provider_reference_collision_scope" },
  { id: 115, group: "I", severity: "Low", scenario: "Prolonged outage across the merchant POS fleet", resolution: "All state and timers live on the server and expired links release reservations cleanly", check: "outage_releases_reservations" },

  { id: 116, group: "J", severity: "Low", scenario: "Applicant abandons a draft join request", resolution: "The draft expires after the inactivity window and the applicant can start again", check: "join_request_expiry" },
  { id: 117, group: "J", severity: "High", scenario: "Google sign-in presents an email of an existing account", resolution: "No automatic linking; the identity is only attached after a second factor or a separate identity is created", check: "no_autolink_unverified_email" },
  { id: 118, group: "J", severity: "High", scenario: "Rejected applicant re-applies with a new name, phone and email", resolution: "Duplicate detection matches the tax id, registration number, owner id, bank account or document hash", check: "duplicate_applicant_detection" },
  { id: 119, group: "J", severity: "Med", scenario: "Admin prepares an onboarding and decides it", resolution: "The preparer is recorded as maker and is barred from the deciding roles", check: "maker_barred_from_deciding" },
  { id: 120, group: "J", severity: "Med", scenario: "The same document hash appears under two merchants", resolution: "Both requests are flagged as duplicates and reviewers must justify acceptance", check: "document_hash_dedupe" },
  { id: 121, group: "J", severity: "Med", scenario: "Beneficial owners change between submission and decision", resolution: "A new screening runs, the request returns to review and pending approvals are invalidated", check: "owner_change_rescreens" },
  { id: 122, group: "J", severity: "High", scenario: "Arabic name variants cause a missed hit or false positive flood", resolution: "Names are normalised in Arabic and Latin forms and thresholds are tuned against a fixed test set", check: "arabic_name_normalisation" },
  { id: 123, group: "J", severity: "High", scenario: "Watch list update creates a new match on an active merchant", resolution: "A list update screening opens a case, restricts cash out and can emergency suspend", check: "list_update_case" },
  { id: 124, group: "J", severity: "Med", scenario: "Screening provider is unavailable during onboarding", resolution: "The result is an error, approval is impossible and the request stays in review", check: "screening_fail_closed" },
  { id: 125, group: "J", severity: "High", scenario: "Merchant splits a sale across links to stay under a threshold", resolution: "Rules aggregate by subject over the window and the structuring rule opens a case", check: "structuring_detected" },
  { id: 126, group: "J", severity: "High", scenario: "A voluntary refund was issued and a chargeback arrives later", resolution: "The dispute links to the refund and the chargeback is capped to the amount not yet returned", check: "chargeback_capped_after_refund" },
  { id: 127, group: "J", severity: "Med", scenario: "An emergency suspension is never ratified", resolution: "An alert escalates to the MLRO and the suspension stays in force", check: "unratified_suspension_persists" },
  { id: 128, group: "J", severity: "Med", scenario: "Dispute webhook replayed or statement re-imported", resolution: "The unique gateway reference and the inbox dedupe key absorb the duplicate", check: "dispute_dedupe" },
  { id: 129, group: "J", severity: "Med", scenario: "AML hold released while the merchant is suspended or closing", resolution: "The ledger resolution executes independently and closure is refused while a hold exists", check: "hold_release_independent_of_state" },
  { id: 130, group: "J", severity: "High", scenario: "Support asks why an account was restricted for AML reasons", resolution: "Only the generic notice is given, AML data is never exposed and the request is logged", check: "no_tipping_off" },

  { id: 131, group: "K", severity: "Low", scenario: "NeomPay wallet id fails the check digit or has an unknown type", resolution: "Rejected at field validation without contacting NeomPay and it counts toward the velocity limit", check: "wallet_id_check_digit" },
  { id: 132, group: "K", severity: "Low", scenario: "The payer wallet is frozen, closed or restricted", resolution: "Classified as a terminal decline with a generic message that never trips the breaker", check: "frozen_wallet_terminal_decline" },
  { id: 133, group: "K", severity: "High", scenario: "The NeomPay ledger times out", resolution: "The attempt becomes UNKNOWN, holds the slot and the route degrades while other rails stay available", check: "internal_timeout_unknown" },
  { id: 134, group: "K", severity: "High", scenario: "The payer wallet belongs to the same entity as the merchant", resolution: "The self payment policy blocks the attempt or opens an AML case", check: "self_payment_blocked" },
  { id: 135, group: "K", severity: "High", scenario: "NeomPay captured funds but the platform crashed before the journal entry", resolution: "The sweeper inquires and posts idempotently and the unique reference prevents a second posting", check: "internal_idempotent_recovery" },
  { id: 136, group: "K", severity: "Med", scenario: "The payer approves a push request after expiry", resolution: "The late capture is rejected and a slipped capture follows the late success recovery path", check: "late_push_after_expiry" },
  { id: 137, group: "K", severity: "Med", scenario: "The customer double taps the OTP submit", resolution: "The deterministic idempotency key returns the same result and at most one debit occurs", check: "internal_idempotency_key" },
  { id: 138, group: "K", severity: "Low", scenario: "The payer wallet type is not allowed to pay merchants", resolution: "The type code allow list rejects it at validation and no money moves", check: "wallet_type_allowlist" },
  { id: 139, group: "K", severity: "Med", scenario: "A refund is approved but the payer wallet was closed", resolution: "The refund step fails, the adjustment stays EXECUTING and an operator case opens", check: "refund_stays_executing" },
  { id: 140, group: "K", severity: "High", scenario: "The daily cross ledger equality check shows drift", resolution: "Automated payouts halt, a mismatch case opens and the correction is a Maker-Checker adjustment", check: "cross_ledger_drift_case" },
];
