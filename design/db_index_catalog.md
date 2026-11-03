# Index catalogue

Every index on a hot table must name the query it serves. This file is the
source for the schema lint test of `high_scale_db_architecture_v2.md` §5.4:
an index that is not listed here fails the build. Names are the physical
MariaDB names from the baseline migration managed by main.

Legend: **U** unique, **FT** full-text, **FK** required by InnoDB for a
foreign key. “T5” marks an index whose write cost must be measured with and
without it before it is kept.

## `payment_attempts` (hot)

| Index | Columns | Serves | Notes |
| :--- | :--- | :--- | :--- |
| `payment_attempts_reference_key` (**U**) | `reference` | checkout status, confirm lookup, exact reference search, statement match | 1 row |
| `payment_attempts_link_id_idempotency_key_key` (**U**) | `link_id`, `idempotency_key` | initiate idempotency; also the `link_id` FK | no prior select |
| `payment_attempts_ledger_entry_id_key` (**U**) | `ledger_entry_id` | 1:1 ledger link | nullable unique |
| `payment_attempts_merchant_id_created_at_idx` | `merchant_id`, `created_at` | default merchant list; `merchant_id` FK | keyset order |
| `payment_attempts_merchant_id_status_created_at_idx` | `merchant_id`, `status`, `created_at` | status-filtered merchant list | no filesort |
| `payment_attempts_status_created_at_idx` | `status`, `created_at` | admin global list by status | **T5 removable** |
| `payment_attempts_gateway_version_id_idx` | `gateway_version_id` | pinned-version lookup; FK | |
| `payment_attempts_rail_id_created_at_idx` | `rail_id`, `created_at` | rail reporting and daily volume; `rail_id` FK | |
| `payment_attempts_application_id_created_at_idx` | `application_id`, `created_at` | application reporting; `application_id` FK | |
| `payment_attempts_provider_ref_idx` | `provider_reference` | webhook correlation, statement match | |
| `payment_attempts_gateway_ref_idx` | `gateway_reference` | webhook correlation, inquiry | |
| `payment_attempts_network_ref_idx` | `network_reference` | card dispute/statement matching | **DECISION D2; T5** |
| `payment_attempts_link_id_fkey` (FK) | `link_id` | FK coverage | covered by the unique `(link_id, idempotency_key)` leading column; verify no duplicate index |
| `payment_attempts_route_id_fkey` / `_credential_set_id_fkey` / `_commission_profile_id_fkey` / `_attempt_group_id_fkey` / `_application_id_fkey` | FK columns | required by InnoDB | use the cheapest existing leading-column index; do not duplicate |

Removed from the v1 proposal and **not** in the catalogue: `(status,
next_check_at)`, the covering `(status, expires_at, terminal_at, substatus)`,
the covering `(route_id, status, terminal_at, total_charged_amount)`, and the
three `end_client_*` indexes. Their work moved to `attempt_deadlines`,
`velocity_counters` and `merchant_daily_stats`.

## `attempt_deadlines` (open work)

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `attempt_deadlines_due_idx` | `due_at` | sweeper/poll `WHERE due_at <= ? … FOR UPDATE SKIP LOCKED` |
| `PRIMARY` | `attempt_id`, `kind` | deadline upsert/delete by attempt |

## `payment_links`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `payment_links_key_key` (**U**) | `key` | checkout page |
| `payment_links_application_id_idx` (**FK**) | `application_id` | application list; FK |
| `payment_links_wallet_id_idx` (**FK**) | `wallet_id` | wallet links; FK |
| `payment_links_state_idx` | `state` | state sweeps (verify against actual queries) |
| `payment_links_application_id_created_at_idx` | `application_id`, `created_at` | application keyset list |
| `payment_links_state_created_at_idx` | `state`, `created_at` | admin state list |

Infinite-use links are not updated on the checkout hot path; the slot `UPDATE`
uses the primary key only.

## `gl_accounts`, `gl_balance_shards`, `gl_period_totals`, `journal_lines`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `gl_accounts_seed_key_key` (**U**) | `seed_key` | idempotent account seeding |
| `gl_accounts_account_type_idx` | `account_type` | account listings and global equation by type |
| `gl_accounts_owner_id_idx` | `owner_id` | merchant-owned accounts |
| `gl_accounts_gateway_id_idx` (**FK**) | `gateway_id` | gateway clearing accounts; FK |
| `gl_accounts_gateway_id_env_credential_set_id_key` (**U**) | `gateway_id`, `env`, `credential_set_id` | one clearing account per gateway/env/credential |
| `gl_balance_shards` **PRIMARY** | `gl_account_id`, `shard_no` | sharded balance read (≤ 32 rows) and `ON DUPLICATE KEY UPDATE` |
| `gl_period_totals` **PRIMARY** | `gl_account_id`, `day` | closed-period verification |
| `journal_entries_ref_type_ref_id_key` (**U**) | `ref_type`, `ref_id` | one entry per business reference |
| `journal_lines_entry_idx` (**FK**) | `entry_id` | lines of one entry; FK |
| `journal_lines_acct_time_cov_idx` | `gl_account_id`, `created_at`, `direction`, `amount` | balance verification and period rollups; covering/index-only |

`journal_lines.id` is `BIGINT UNSIGNED AUTO_INCREMENT`; the PK is never used as
a correctness cursor.

## `access_tokens`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `access_tokens_token_hash_key` (**U**) | `token_hash` | authenticate bearer token by hash |
| `access_tokens_application_id_idx` (**FK**) | `application_id` | application token list; FK |
| `access_tokens_merchant_id_revoked_at_idx` | `merchant_id`, `revoked_at` | merchant token list and revocation filter |

`last_used_at` is refreshed at most once per 5 minutes and has no index of its
own. Revocation is read from the token row on every request.

## `merchants`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `merchants_status_idx` | `status` | status counts and status lists |
| `merchants_kybStatus_idx` | `kybStatus` | KYB queues |
| `merchants_status_created_at_idx` | `status`, `created_at` | admin merchant keyset list |
| `merchants_riskTier_idx` | `riskTier` | risk-filtered lists |
| `merchants_kybStatus_status_idx` | `kybStatus`, `status` | KYB + status queue |
| `merchants_taxId_idx` | `taxId(100)` | exact/prefix identifier search |
| `merchants_registrationNo_idx` | `registrationNo(100)` | exact/prefix identifier search |
| `merchants_contactPhone_idx` | `contactPhone` | exact/prefix contact search |
| `merchants_contactEmail_idx` | `contactEmail` | exact/prefix contact search |
| `merchants_payout_account_hash_idx` | `payout_account_hash` | payout account lookup |
| `merchants_next_kyb_review_at_idx` | `next_kyb_review_at` | KYB expiry worker |
| `merchants_names_ft_idx` (**FT**) | `legalName`, `tradeName` | global name search; token size 2 |

## `kyb_documents`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `kyb_documents_sha256_idx` | `sha256` | duplicate-document check on upload |
| `kyb_documents_duplicate_of_merchant_idx` | `duplicate_of_merchant_id` | compliance duplicate list |
| `kyb_documents_merchant_id_status_idx` | `merchant_id`, `status` | merchant document list |
| `kyb_documents_status_av_status_created_at_idx` | `status`, `av_status`, `created_at` | AV/review queue |
| `kyb_documents_doc_type_idx` | `doc_type` | document type filter |
| `kyb_documents_expires_on_idx` | `expires_on` | expiry worker |
| `kyb_documents_uploaded_by_idx` / `_reviewed_by_idx` / `_join_request_id_idx` | FK columns | required by InnoDB |

No `kyb_document_hash_stats` table or index: duplicates are a nullable
`duplicate_of_merchant_id` column.

## `velocity_counter`, `route_daily_volumes`, `merchant_daily_stats`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `velocity_counters` **PRIMARY** | `scope_type`, `scope_key`, `granularity`, `bucket` | increment and window read |
| `route_daily_volumes` **PRIMARY** | `route_id`, `day_bucket`, `shard_no` | sharded cap read/write |
| `rdv_day_bucket_idx` | `day_bucket` | daily reporting across routes |
| `merchant_daily_stats` **PRIMARY** | `merchant_id`, `day_bucket`, `rail_code` | rollup upsert/read |
| `mds_day_rail_idx` | `day_bucket`, `rail_code` | platform daily rollup by rail |

`merchant_daily_stats` is written by a worker, not in the checkout or confirm
transaction.

## `inbound_events`, `background_jobs`, `reconciliation_items`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `inbound_events_gateway_id_idx` (**FK**) | `gateway_id` | gateway inbox; FK |
| `inbound_events_processed_at_received_at_idx` | `processed_at`, `received_at` | inbox claim |
| `inbound_events_channel_id_dedupe_key_key` (**U**) | `channel_id`, `dedupe_key` | webhook dedupe |
| `background_jobs_state_available_at_idx` | `state`, `available_at` | queued job claim |
| `background_jobs_state_locked_at_idx` | `state`, `locked_at` | lease recovery |
| `background_jobs_reference_type_reference_id_idx` | `reference_type`, `reference_id` | job lookup by business reference |
| `reconciliation_items_run_id_idx` (**FK**) | `run_id` | reconciliation item list; FK |
| `reconciliation_items_result_idx` | `result` | result filter |

## `cache_invalidation_events`

| Index | Columns | Serves |
| :--- | :--- | :--- |
| `PRIMARY` | `event_seq` | poll `WHERE event_seq > ? ORDER BY event_seq LIMIT 500` |
| `cie_created_at_idx` | `created_at` | purge `WHERE created_at < ? LIMIT 5000` |

## Appendix: other maintained indexes

The following tables have low-contention indexes that are still part of the
catalogue because the lint test requires every index to be named:

- `users`: `users_email_key` (login), `users_role_idx` (role filter),
  `users_merchant_id_status_idx` (merchant staff list).
- `applications`: `applications_assigned_wallet_id_idx` (FK),
  `applications_merchant_id_status_idx` (merchant list).
- `wallets`: `wallets_gl_account_id_key` (1:1 ledger account),
  `wallets_merchant_id_status_idx` (merchant wallet list).
- `commission_profiles`: `commission_profiles_seed_key_key` (seed),
  `commission_profiles_application_id_idx` (FK).
- `rails`: `rails_code_key` (lookup), `rails_collection_mode_idx`,
  `rails_blocked_idx` (visible-rail filter).
- `rail_routes`: `rail_routes_status_health_state_idx` (visible rails and
  circuit breaker), `rail_routes_credential_policy_idx`,
  `rail_routes_hard_cap_idx`, `rail_routes_rail_id_gateway_id_credential_policy_key`
  (uniqueness).
- `platform_settings`: `platform_settings_key_scope_version_key` (versioned
  read), `platform_settings_key_scope_idx` (latest-by-key).
- `audit_log`: `audit_log_entity_type_entity_id_created_at_idx` (entity audit
  trail), `audit_log_created_at_idx` (retention/partition maintenance).

Any index added to `schema.prisma` must be added here in the same change, with
the exact query it serves. Any index removed must be removed from both places.

## Appendix B — complete physical index register

Generated from the baseline migration owned by main. This appendix
exists so the §5.4 lint test can find **every** physical index name;
the purpose column names the query family the index serves.

| Table | Index | Columns | Purpose |
| :--- | :--- | :--- | :--- |
| `merchants` | `merchants_status_idx` | status | status queue or filter |
| `merchants` | `merchants_kybStatus_idx` | kybStatus | status queue or filter |
| `merchants` | `merchants_status_created_at_idx` | status, created_at | keyset list / retention scan |
| `merchants` | `merchants_riskTier_idx` | riskTier | catalogued lookup / filter; verify against the query catalogue |
| `merchants` | `merchants_kybStatus_status_idx` | kybStatus, status | status queue or filter |
| `merchants` | `merchants_taxId_idx` | taxId(100) | catalogued lookup / filter; verify against the query catalogue |
| `merchants` | `merchants_registrationNo_idx` | registrationNo(100) | catalogued lookup / filter; verify against the query catalogue |
| `merchants` | `merchants_contactPhone_idx` | contactPhone | catalogued lookup / filter; verify against the query catalogue |
| `merchants` | `merchants_contactEmail_idx` | contactEmail | catalogued lookup / filter; verify against the query catalogue |
| `merchants` | `merchants_payout_account_hash_idx` | payout_account_hash | content hash lookup |
| `merchants` | `merchants_next_kyb_review_at_idx` | next_kyb_review_at | worker due-work claim |
| `merchants` | `merchants_names_ft_idx` | legalName, tradeName | full-text search |
| `users` | `users_email_key` | email | unique lookup / idempotency guard |
| `users` | `users_role_idx` | role | catalogued lookup / filter; verify against the query catalogue |
| `users` | `users_merchant_id_status_idx` | merchant_id, status | status queue or filter |
| `applications` | `applications_assigned_wallet_id_idx` | assigned_wallet_id | catalogued lookup / filter; verify against the query catalogue |
| `applications` | `applications_merchant_id_status_idx` | merchant_id, status | status queue or filter |
| `wallets` | `wallets_gl_account_id_key` | gl_account_id | unique lookup / idempotency guard |
| `wallets` | `wallets_merchant_id_status_idx` | merchant_id, status | status queue or filter |
| `access_tokens` | `access_tokens_token_hash_key` | token_hash | unique lookup / idempotency guard |
| `access_tokens` | `access_tokens_application_id_idx` | application_id | catalogued lookup / filter; verify against the query catalogue |
| `access_tokens` | `access_tokens_merchant_id_revoked_at_idx` | merchant_id, revoked_at | merchant-scoped list |
| `access_token_ips` | `access_token_ips_token_id_cidr_key` | token_id, cidr | unique lookup / idempotency guard |
| `payment_links` | `payment_links_key_key` | key | unique lookup / idempotency guard |
| `payment_links` | `payment_links_application_id_idx` | application_id | catalogued lookup / filter; verify against the query catalogue |
| `payment_links` | `payment_links_wallet_id_idx` | wallet_id | catalogued lookup / filter; verify against the query catalogue |
| `payment_links` | `payment_links_state_idx` | state | state machine queue/filter |
| `payment_links` | `payment_links_application_id_created_at_idx` | application_id, created_at | keyset list / retention scan |
| `payment_links` | `payment_links_state_created_at_idx` | state, created_at | keyset list / retention scan |
| `pos_terminals` | `pos_terminals_application_id_idx` | application_id | catalogued lookup / filter; verify against the query catalogue |
| `pos_terminals` | `pos_terminals_application_id_status_idx` | application_id, status | status queue or filter |
| `pos_screens` | `pos_screens_screen_code_key` | screen_code | unique lookup / idempotency guard |
| `pos_screens` | `pos_screens_pos_id_idx` | pos_id | catalogued lookup / filter; verify against the query catalogue |
| `gl_accounts` | `gl_accounts_seed_key_key` | seed_key | unique lookup / idempotency guard |
| `gl_accounts` | `gl_accounts_account_type_idx` | account_type | catalogued lookup / filter; verify against the query catalogue |
| `gl_accounts` | `gl_accounts_owner_id_idx` | owner_id | catalogued lookup / filter; verify against the query catalogue |
| `gl_accounts` | `gl_accounts_gateway_id_idx` | gateway_id | gateway-scoped lookup |
| `gl_accounts` | `gl_accounts_gateway_id_env_credential_set_id_key` | gateway_id, env, credential_set_id | unique lookup / idempotency guard |
| `journal_entries` | `journal_entries_ref_type_ref_id_key` | ref_type, ref_id | unique lookup / idempotency guard |
| `journal_lines` | `journal_lines_entry_idx` | entry_id | catalogued lookup / filter; verify against the query catalogue |
| `journal_lines` | `journal_lines_acct_time_cov_idx` | gl_account_id, created_at, direction, amount | keyset list / retention scan |
| `commission_profiles` | `commission_profiles_seed_key_key` | seed_key | unique lookup / idempotency guard |
| `commission_profiles` | `commission_profiles_application_id_idx` | application_id | catalogued lookup / filter; verify against the query catalogue |
| `velocity_rules` | `velocity_rules_scope_type_scope_value_idx` | scope_type, scope_value | catalogued lookup / filter; verify against the query catalogue |
| `velocity_rules` | `velocity_rules_active_idx` | active | catalogued lookup / filter; verify against the query catalogue |
| `aml_cases` | `aml_cases_status_idx` | status | status queue or filter |
| `aml_cases` | `aml_cases_subject_type_subject_id_idx` | subject_type, subject_id | catalogued lookup / filter; verify against the query catalogue |
| `aml_cases` | `aml_cases_status_created_at_idx` | status, created_at | keyset list / retention scan |
| `aml_cases` | `aml_cases_severity_status_idx` | severity, status | status queue or filter |
| `aml_cases` | `aml_cases_sla_due_at_idx` | sla_due_at | worker due-work claim |
| `adjustments` | `adjustments_dispute_id_key` | dispute_id | unique lookup / idempotency guard |
| `adjustments` | `adjustments_journal_entry_id_key` | journal_entry_id | unique lookup / idempotency guard |
| `adjustments` | `adjustments_target_gl_account_id_idx` | target_gl_account_id | catalogued lookup / filter; verify against the query catalogue |
| `adjustments` | `adjustments_state_idx` | state | state machine queue/filter |
| `adjustments` | `adjustments_state_created_at_idx` | state, created_at | keyset list / retention scan |
| `adjustments` | `adjustments_type_created_at_idx` | type, created_at | keyset list / retention scan |
| `cashout_requests` | `cashout_requests_wallet_id_idx` | wallet_id | catalogued lookup / filter; verify against the query catalogue |
| `cashout_requests` | `cashout_requests_merchant_id_state_created_at_idx` | merchant_id, state, created_at | keyset list / retention scan |
| `cashout_requests` | `cashout_requests_wallet_id_created_at_idx` | wallet_id, created_at | keyset list / retention scan |
| `approval_requests` | `approval_requests_maker_user_id_idx` | maker_user_id | catalogued lookup / filter; verify against the query catalogue |
| `approval_requests` | `approval_requests_checker_user_id_idx` | checker_user_id | catalogued lookup / filter; verify against the query catalogue |
| `approval_requests` | `approval_requests_state_idx` | state | state machine queue/filter |
| `approval_requests` | `approval_requests_state_created_at_idx` | state, created_at | keyset list / retention scan |
| `approval_requests` | `approval_requests_subject_type_state_idx` | subject_type, state | state machine queue/filter |
| `gateways` | `gateways_code_key` | code | unique lookup / idempotency guard |
| `gateways` | `gateways_active_version_id_key` | active_version_id | unique lookup / idempotency guard |
| `gateways` | `gateways_status_idx` | status | status queue or filter |
| `gateways` | `gateways_kind_idx` | kind | catalogued lookup / filter; verify against the query catalogue |
| `gateways` | `gateways_verificationState_idx` | verificationState | state machine queue/filter |
| `gateways` | `gateways_riskClass_idx` | riskClass | catalogued lookup / filter; verify against the query catalogue |
| `gateway_versions` | `gateway_versions_content_hash_key` | content_hash | unique lookup / idempotency guard |
| `gateway_versions` | `gateway_versions_state_idx` | state | state machine queue/filter |
| `gateway_versions` | `gateway_versions_gateway_id_version_number_key` | gateway_id, version_number | unique lookup / idempotency guard |
| `gateway_version_evidence` | `gateway_version_evidence_gateway_version_id_key` | gateway_version_id | unique lookup / idempotency guard |
| `gateway_environments` | `gateway_environments_gateway_version_id_env_key` | gateway_version_id, env | unique lookup / idempotency guard |
| `gateway_auth` | `gateway_auth_gateway_version_id_env_key` | gateway_version_id, env | unique lookup / idempotency guard |
| `gateway_settings` | `gateway_settings_gateway_version_id_key` | gateway_version_id | unique lookup / idempotency guard |
| `credential_sets` | `credential_sets_owner_merchant_id_idx` | owner_merchant_id | merchant-scoped list |
| `credential_sets` | `credential_sets_owner_merchant_id_status_idx` | owner_merchant_id, status | status queue or filter |
| `credential_sets` | `credential_sets_env_idx` | env | catalogued lookup / filter; verify against the query catalogue |
| `credential_sets` | `credential_sets_gateway_id_env_external_merchant_id_key` | gateway_id, env, external_merchant_id | unique lookup / idempotency guard |
| `assets` | `assets_name_key` | name | unique lookup / idempotency guard |
| `assets` | `assets_sha256_key` | sha256 | unique lookup / idempotency guard |
| `rails` | `rails_code_key` | code | unique lookup / idempotency guard |
| `rails` | `rails_collection_mode_idx` | collection_mode | catalogued lookup / filter; verify against the query catalogue |
| `rails` | `rails_blocked_idx` | blocked | worker due-work claim |
| `rail_fields` | `rail_fields_rail_id_key_key` | rail_id, key | unique lookup / idempotency guard |
| `rail_routes` | `rail_routes_status_health_state_idx` | status, health_state | status queue or filter |
| `rail_routes` | `rail_routes_credential_policy_idx` | credential_policy | catalogued lookup / filter; verify against the query catalogue |
| `rail_routes` | `rail_routes_hard_cap_idx` | hard_cap | catalogued lookup / filter; verify against the query catalogue |
| `rail_routes` | `rail_routes_rail_id_gateway_id_credential_policy_key` | rail_id, gateway_id, credential_policy | unique lookup / idempotency guard |
| `crypto_profiles` | `crypto_profiles_gateway_version_id_name_key` | gateway_version_id, name | unique lookup / idempotency guard |
| `flows` | `flows_gateway_version_id_phase_idx` | gateway_version_id, phase | catalogued lookup / filter; verify against the query catalogue |
| `flow_steps` | `flow_steps_flow_id_order_index_key` | flow_id, order_index | unique lookup / idempotency guard |
| `step_parameters` | `step_parameters_step_id_place_key_key` | step_id, place, key | unique lookup / idempotency guard |
| `step_outputs` | `step_outputs_step_id_name_key` | step_id, name | unique lookup / idempotency guard |
| `status_rules` | `status_rules_gateway_version_id_phase_order_index_key` | gateway_version_id, phase, order_index | unique lookup / idempotency guard |
| `error_maps` | `error_maps_gateway_version_id_gateway_code_canonical_error_key` | gateway_version_id, gateway_code, canonical_error | unique lookup / idempotency guard |
| `confirmation_channels` | `confirmation_channels_path_token_key` | path_token | unique lookup / idempotency guard |
| `confirmation_channels` | `confirmation_channels_gateway_version_id_idx` | gateway_version_id | catalogued lookup / filter; verify against the query catalogue |
| `confirmation_channels` | `confirmation_channels_route_id_idx` | route_id | catalogued lookup / filter; verify against the query catalogue |
| `poll_policies` | `poll_policies_route_id_key` | route_id | unique lookup / idempotency guard |
| `widget_definitions` | `widget_definitions_route_id_key` | route_id | unique lookup / idempotency guard |
| `redirect_definitions` | `redirect_definitions_route_id_key` | route_id | unique lookup / idempotency guard |
| `statement_sources` | `statement_sources_gateway_id_idx` | gateway_id | gateway-scoped lookup |
| `manual_instructions` | `manual_instructions_rail_id_key` | rail_id | unique lookup / idempotency guard |
| `attempt_groups` | `attempt_groups_link_id_customer_fingerprint_key` | link_id, customer_fingerprint | unique lookup / idempotency guard |
| `payment_attempts` | `payment_attempts_reference_key` | reference | unique lookup / idempotency guard |
| `payment_attempts` | `payment_attempts_ledger_entry_id_key` | ledger_entry_id | unique lookup / idempotency guard |
| `payment_attempts` | `payment_attempts_gateway_version_id_idx` | gateway_version_id | catalogued lookup / filter; verify against the query catalogue |
| `payment_attempts` | `payment_attempts_merchant_id_created_at_idx` | merchant_id, created_at | keyset list / retention scan |
| `payment_attempts` | `payment_attempts_merchant_id_status_created_at_idx` | merchant_id, status, created_at | keyset list / retention scan |
| `payment_attempts` | `payment_attempts_status_created_at_idx` | status, created_at | keyset list / retention scan |
| `payment_attempts` | `payment_attempts_rail_id_created_at_idx` | rail_id, created_at | keyset list / retention scan |
| `payment_attempts` | `payment_attempts_application_id_created_at_idx` | application_id, created_at | keyset list / retention scan |
| `payment_attempts` | `payment_attempts_provider_ref_idx` | provider_reference | catalogued lookup / filter; verify against the query catalogue |
| `payment_attempts` | `payment_attempts_gateway_ref_idx` | gateway_reference | catalogued lookup / filter; verify against the query catalogue |
| `payment_attempts` | `payment_attempts_network_ref_idx` | network_reference | catalogued lookup / filter; verify against the query catalogue |
| `payment_attempts` | `payment_attempts_link_id_idempotency_key_key` | link_id, idempotency_key | unique lookup / idempotency guard |
| `attempt_step_logs` | `attempt_step_logs_attempt_id_idx` | attempt_id | attempt child rows |
| `inbound_events` | `inbound_events_gateway_id_idx` | gateway_id | gateway-scoped lookup |
| `inbound_events` | `inbound_events_processed_at_received_at_idx` | processed_at, received_at | catalogued lookup / filter; verify against the query catalogue |
| `inbound_events` | `inbound_events_channel_id_dedupe_key_key` | channel_id, dedupe_key | unique lookup / idempotency guard |
| `operator_cases` | `operator_cases_reconciliation_item_id_key` | reconciliation_item_id | unique lookup / idempotency guard |
| `operator_cases` | `operator_cases_state_priority_idx` | state, priority | state machine queue/filter |
| `operator_cases` | `operator_cases_state_created_at_idx` | state, created_at | keyset list / retention scan |
| `operator_cases` | `operator_cases_priority_idx` | priority | catalogued lookup / filter; verify against the query catalogue |
| `operator_cases` | `operator_cases_kind_idx` | kind | catalogued lookup / filter; verify against the query catalogue |
| `operator_cases` | `operator_cases_sla_due_at_idx` | sla_due_at | worker due-work claim |
| `operator_cases` | `operator_cases_assignee_user_id_idx` | assignee_user_id | catalogued lookup / filter; verify against the query catalogue |
| `operator_cases` | `operator_cases_attempt_id_idx` | attempt_id | attempt child rows |
| `gateway_inquiry_schedules` | `gateway_inquiry_schedules_status_next_run_at_idx` | status, next_run_at | status queue or filter |
| `gateway_inquiry_schedules` | `gateway_inquiry_schedules_attempt_id_status_idx` | attempt_id, status | status queue or filter |
| `gateway_inquiry_schedules` | `gateway_inquiry_schedules_operator_case_id_idx` | operator_case_id | catalogued lookup / filter; verify against the query catalogue |
| `gateway_inquiry_schedules` | `gateway_inquiry_schedules_source_status_idx` | source, status | status queue or filter |
| `reconciliation_runs` | `reconciliation_runs_file_hash_key` | file_hash | unique lookup / idempotency guard |
| `reconciliation_runs` | `reconciliation_runs_ingested_at_idx` | ingested_at | catalogued lookup / filter; verify against the query catalogue |
| `reconciliation_runs` | `reconciliation_runs_created_at_idx` | created_at | keyset list / retention scan |
| `reconciliation_runs` | `reconciliation_runs_statement_source_id_created_at_idx` | statement_source_id, created_at | keyset list / retention scan |
| `background_jobs` | `background_jobs_state_available_at_idx` | state, available_at | worker due-work claim |
| `background_jobs` | `background_jobs_state_locked_at_idx` | state, locked_at | worker due-work claim |
| `background_jobs` | `background_jobs_reference_type_reference_id_idx` | reference_type, reference_id | catalogued lookup / filter; verify against the query catalogue |
| `reconciliation_items` | `reconciliation_items_run_id_idx` | run_id | reconciliation run rows |
| `reconciliation_items` | `reconciliation_items_result_idx` | result | catalogued lookup / filter; verify against the query catalogue |
| `gateway_health_samples` | `gateway_health_samples_route_id_window_start_idx` | route_id, window_start | catalogued lookup / filter; verify against the query catalogue |
| `detail_change_logs` | `detail_change_logs_entity_type_entity_id_idx` | entity_type, entity_id | catalogued lookup / filter; verify against the query catalogue |
| `detail_change_logs` | `detail_change_logs_merchant_id_created_at_idx` | merchant_id, created_at | keyset list / retention scan |
| `audit_log` | `audit_log_entity_type_entity_id_created_at_idx` | entity_type, entity_id, created_at | keyset list / retention scan |
| `audit_log` | `audit_log_created_at_idx` | created_at | keyset list / retention scan |
| `user_identities` | `user_identities_provider_subject_key` | provider_subject | unique lookup / idempotency guard |
| `user_identities` | `user_identities_user_id_idx` | user_id | catalogued lookup / filter; verify against the query catalogue |
| `user_identities` | `user_identities_kind_identifier_normalized_key` | kind, identifier_normalized | unique lookup / idempotency guard |
| `join_requests` | `join_requests_status_idx` | status | status queue or filter |
| `join_requests` | `join_requests_status_created_at_idx` | status, created_at | keyset list / retention scan |
| `join_requests` | `join_requests_proposed_risk_tier_idx` | proposed_risk_tier | catalogued lookup / filter; verify against the query catalogue |
| `join_requests` | `join_requests_assigned_reviewer_id_idx` | assigned_reviewer_id | catalogued lookup / filter; verify against the query catalogue |
| `join_requests` | `join_requests_sla_due_at_idx` | sla_due_at | worker due-work claim |
| `kyb_documents` | `kyb_documents_join_request_id_idx` | join_request_id | catalogued lookup / filter; verify against the query catalogue |
| `kyb_documents` | `kyb_documents_sha256_idx` | sha256 | content hash lookup |
| `kyb_documents` | `kyb_documents_duplicate_of_merchant_idx` | duplicate_of_merchant_id | merchant-scoped list |
| `kyb_documents` | `kyb_documents_merchant_id_status_idx` | merchant_id, status | status queue or filter |
| `kyb_documents` | `kyb_documents_status_av_status_created_at_idx` | status, av_status, created_at | keyset list / retention scan |
| `kyb_documents` | `kyb_documents_doc_type_idx` | doc_type | catalogued lookup / filter; verify against the query catalogue |
| `kyb_documents` | `kyb_documents_expires_on_idx` | expires_on | worker due-work claim |
| `kyb_documents` | `kyb_documents_uploaded_by_idx` | uploaded_by | catalogued lookup / filter; verify against the query catalogue |
| `kyb_documents` | `kyb_documents_reviewed_by_idx` | reviewed_by | catalogued lookup / filter; verify against the query catalogue |
| `kyb_revalidation_requests` | `kyb_revalidation_requests_fulfilled_document_id_key` | fulfilled_document_id | unique lookup / idempotency guard |
| `kyb_revalidation_requests` | `kyb_revalidation_requests_merchant_id_status_idx` | merchant_id, status | status queue or filter |
| `kyb_revalidation_requests` | `kyb_revalidation_requests_status_due_at_idx` | status, due_at | status queue or filter |
| `kyb_revalidation_requests` | `kyb_revalidation_requests_document_id_idx` | document_id | catalogued lookup / filter; verify against the query catalogue |
| `kyb_revalidation_requests` | `kyb_revalidation_requests_join_request_id_idx` | join_request_id | catalogued lookup / filter; verify against the query catalogue |
| `kyb_revalidation_requests` | `kyb_revalidation_requests_requested_by_idx` | requested_by | catalogued lookup / filter; verify against the query catalogue |
| `beneficial_owners` | `beneficial_owners_screening_status_idx` | screening_status | status queue or filter |
| `beneficial_owners` | `beneficial_owners_national_id_hash_idx` | national_id_hash | content hash lookup |
| `aml_screenings` | `aml_screenings_subject_type_subject_id_idx` | subject_type, subject_id | catalogued lookup / filter; verify against the query catalogue |
| `aml_screenings` | `aml_screenings_result_idx` | result | catalogued lookup / filter; verify against the query catalogue |
| `aml_screenings` | `aml_screenings_result_requested_at_idx` | result, requested_at | catalogued lookup / filter; verify against the query catalogue |
| `aml_screenings` | `aml_screenings_provider_code_idx` | provider_code | catalogued lookup / filter; verify against the query catalogue |
| `aml_screening_matches` | `aml_screening_matches_screening_id_idx` | screening_id | catalogued lookup / filter; verify against the query catalogue |
| `aml_rules` | `aml_rules_code_key` | code | unique lookup / idempotency guard |
| `aml_rules` | `aml_rules_active_idx` | active | catalogued lookup / filter; verify against the query catalogue |
| `aml_rules` | `aml_rules_active_code_idx` | active, code | catalogued lookup / filter; verify against the query catalogue |
| `aml_rules` | `aml_rules_rule_type_idx` | rule_type | catalogued lookup / filter; verify against the query catalogue |
| `reporting_rules` | `reporting_rules_status_idx` | status | status queue or filter |
| `regulatory_reports` | `regulatory_reports_aml_case_id_key` | aml_case_id | unique lookup / idempotency guard |
| `regulatory_reports` | `regulatory_reports_status_idx` | status | status queue or filter |
| `regulatory_reports` | `regulatory_reports_status_created_at_idx` | status, created_at | keyset list / retention scan |
| `regulatory_reports` | `regulatory_reports_report_type_idx` | report_type | catalogued lookup / filter; verify against the query catalogue |
| `disputes` | `disputes_attempt_id_idx` | attempt_id | attempt child rows |
| `disputes` | `disputes_status_opened_at_idx` | status, opened_at | status queue or filter |
| `disputes` | `disputes_status_evidence_due_at_idx` | status, evidence_due_at | status queue or filter |
| `disputes` | `disputes_gateway_id_external_dispute_ref_key` | gateway_id, external_dispute_ref | unique lookup / idempotency guard |
| `notification_templates` | `notification_templates_code_idx` | code | catalogued lookup / filter; verify against the query catalogue |
| `notification_templates` | `notification_templates_code_channel_lang_version_key` | code, channel, lang, version | unique lookup / idempotency guard |
| `notifications` | `notifications_event_id_key` | event_id | unique lookup / idempotency guard |
| `notifications` | `notifications_status_next_attempt_at_idx` | status, next_attempt_at | status queue or filter |
| `notifications` | `notifications_recipient_merchant_id_created_at_idx` | recipient_merchant_id, created_at | keyset list / retention scan |
| `platform_settings` | `platform_settings_key_scope_idx` | key, scope | catalogued lookup / filter; verify against the query catalogue |
| `platform_settings` | `platform_settings_key_scope_version_key` | key, scope, version | unique lookup / idempotency guard |
| `attempt_deadlines` | `attempt_deadlines_due_idx` | due_at | worker due-work claim |
| `route_daily_volumes` | `rdv_day_bucket_idx` | day_bucket | catalogued lookup / filter; verify against the query catalogue |
| `merchant_daily_stats` | `mds_day_rail_idx` | day_bucket, rail_code | catalogued lookup / filter; verify against the query catalogue |
| `cache_invalidation_events` | `cie_created_at_idx` | created_at | keyset list / retention scan |

