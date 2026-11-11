/**
 * Curated set of tables that are internal plumbing rather than business data.
 *
 * They are hidden from the AI authoring transcript so an authoring model is not
 * tempted to report on the report engine itself, authentication internals,
 * queues, backup control or gateway configuration. The Layer 2 verifier uses
 * the same list so a hallucinated internal table is rejected with an explicit
 * diagnostic instead of a generic unknown-model error.
 */
export const NON_REPORTABLE_MODELS: ReadonlySet<string> = new Set([
  // Report engine storage (reporting on the report engine is not business reporting).
  "report_asset_bundles",
  "report_chrome_specs",
  "report_definition_specs",
  "report_execution_audit",
  "merchant_report_specs",
  "merchant_report_asset_bundles",
  "merchant_report_execution_audit",
  "merchant_report_rate_events",
  "merchant_report_studio_status",
  // Authentication / session internals.
  "mfa_challenges",
  "access_tokens",
  "access_token_ips",
  "user_identities",
  "session_revocations",
  "worker_cursors",
  "deadline_stages",
  // Queues, outboxes and backup control.
  "outbox_events",
  "audit_outbox",
  "backup_catalog_runs",
  "backup_restore_drills",
  // Ledger shard maintenance.
  "gl_shard_repairs",
  "gl_shard_checkpoints",
  // Gateway configuration internals (secrets, protocol plumbing, UI widgets).
  "credential_sets",
  "gateway_auth",
  "crypto_profiles",
  "gateway_version_evidence",
  "gateway_environments",
  "gateway_settings",
  "rail_fields",
  "flows",
  "flow_steps",
  "step_parameters",
  "step_outputs",
  "status_rules",
  "error_maps",
  "confirmation_channels",
  "poll_policies",
  "widget_definitions",
  "redirect_definitions",
  "manual_instructions",
  // Platform configuration and template/asset plumbing.
  "platform_settings",
  "notification_templates",
  "regulatory_schema_default_bindings",
  "regulatory_rule_schema_bindings",
  "assets",
]);

export function isReportableModel(tableName: string): boolean {
  return !NON_REPORTABLE_MODELS.has(tableName);
}
