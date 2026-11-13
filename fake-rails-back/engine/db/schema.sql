PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fake_rail_scenarios (
  rail_code TEXT PRIMARY KEY,
  gateway_code TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fake_transactions (
  id TEXT PRIMARY KEY,
  gateway_code TEXT NOT NULL,
  rail_code TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'SANDBOX',
  our_reference TEXT NOT NULL,
  provider_reference TEXT NOT NULL UNIQUE,
  network_reference TEXT,
  idempotency_key TEXT,
  requested_amount_wire TEXT NOT NULL,
  normalized_amount_lyd TEXT NOT NULL,
  settled_amount_lyd TEXT,
  gateway_fee_lyd TEXT NOT NULL DEFAULT '0.0000',
  currency TEXT NOT NULL DEFAULT 'LYD',
  collection_mode TEXT NOT NULL,
  customer_identifier_masked TEXT,
  expected_otp TEXT,
  merchant_id TEXT,
  qr_payload TEXT,
  deep_link_url TEXT,
  redirect_url TEXT,
  status TEXT NOT NULL,
  assigned_fail_phase TEXT,
  assigned_failure_mode TEXT,
  inquiry_override_status TEXT,
  return_url TEXT,
  cancel_url TEXT,
  webhook_url TEXT,
  is_seeded_historical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_tx_our_ref ON fake_transactions(gateway_code, our_reference);
CREATE INDEX IF NOT EXISTS idx_fake_tx_created ON fake_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fake_tx_status ON fake_transactions(rail_code, status);
CREATE INDEX IF NOT EXISTS idx_fake_tx_provider ON fake_transactions(provider_reference);

CREATE TABLE IF NOT EXISTS fake_step_events (
  id TEXT PRIMARY KEY,
  transaction_id TEXT,
  gateway_code TEXT NOT NULL,
  phase TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_raw TEXT NOT NULL,
  response_status INTEGER,
  response_body_raw TEXT,
  injected_fault TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_events_tx ON fake_step_events(transaction_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_fake_events_created ON fake_step_events(created_at DESC);

CREATE TABLE IF NOT EXISTS fake_webhook_deliveries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT,
  gateway_code TEXT NOT NULL,
  url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_raw TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 1,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'QUEUED',
  response_status INTEGER,
  response_body_raw TEXT,
  scheduled_for TEXT NOT NULL,
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_webhooks_tx ON fake_webhook_deliveries(transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fake_webhooks_state ON fake_webhook_deliveries(state, scheduled_for);

CREATE TABLE IF NOT EXISTS fake_statements (
  id TEXT PRIMARY KEY,
  gateway_code TEXT NOT NULL,
  format TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  anomaly_json TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fake_portal_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);


-- ============================================================================
-- Stateful Fake Rails v2: test customer accounts, holds, movements, clearing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fake_accounts (
  id TEXT PRIMARY KEY,
  rail_code TEXT NOT NULL,
  gateway_code TEXT NOT NULL,
  merchant_id TEXT,
  instrument_type TEXT NOT NULL DEFAULT 'MOBILE_WALLET',
  identifier TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  secret_pin TEXT NOT NULL DEFAULT '1234',
  expiry TEXT DEFAULT '12/28',
  currency TEXT NOT NULL DEFAULT 'LYD',
  available_balance_lyd TEXT NOT NULL DEFAULT '5000.0000',
  reserved_balance_lyd TEXT NOT NULL DEFAULT '0.0000',
  daily_limit_lyd TEXT NOT NULL DEFAULT '10000.0000',
  daily_spent_lyd TEXT NOT NULL DEFAULT '0.0000',
  daily_spent_date TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  static_otp TEXT,
  preset_fault TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A merchant owns its copy of a preset; the same identifier may therefore
-- exist once globally and once per merchant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fake_accounts_global_identifier
  ON fake_accounts(rail_code, identifier) WHERE merchant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fake_accounts_merchant_identifier
  ON fake_accounts(rail_code, identifier, merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fake_accounts_rail ON fake_accounts(rail_code, status);
CREATE INDEX IF NOT EXISTS idx_fake_accounts_gateway ON fake_accounts(gateway_code);
CREATE INDEX IF NOT EXISTS idx_fake_accounts_merchant ON fake_accounts(merchant_id);

CREATE TABLE IF NOT EXISTS fake_account_holds (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fake_accounts(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  amount_lyd TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'HELD',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_fake_holds_account ON fake_account_holds(account_id, state);

CREATE TABLE IF NOT EXISTS fake_account_movements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fake_accounts(id) ON DELETE CASCADE,
  transaction_id TEXT,
  direction TEXT NOT NULL,
  amount_lyd TEXT NOT NULL,
  available_before_lyd TEXT NOT NULL,
  available_after_lyd TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_movements_account ON fake_account_movements(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fake_merchant_clearing_pools (
  id TEXT PRIMARY KEY,
  gateway_code TEXT NOT NULL,
  rail_code TEXT NOT NULL,
  pending_settlement_lyd TEXT NOT NULL DEFAULT '0.0000',
  settled_lyd TEXT NOT NULL DEFAULT '0.0000',
  accumulated_gateway_fee_lyd TEXT NOT NULL DEFAULT '0.0000',
  tx_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(gateway_code, rail_code)
);

CREATE TABLE IF NOT EXISTS fake_clearing_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  gateway_code TEXT NOT NULL,
  rail_code TEXT NOT NULL,
  account_id TEXT,
  our_reference TEXT,
  provider_reference TEXT,
  currency TEXT NOT NULL DEFAULT 'LYD',
  status TEXT NOT NULL DEFAULT 'PAID',
  entry_type TEXT NOT NULL, -- CAPTURE | REFUND | RELEASE
  amount_lyd TEXT NOT NULL,
  gateway_fee_lyd TEXT NOT NULL DEFAULT '0.0000',
  settled_at TEXT,
  statement_included_at TEXT,
  statement_run_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_clearing_gateway ON fake_clearing_entries(gateway_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fake_clearing_tx ON fake_clearing_entries(transaction_id);

CREATE TABLE IF NOT EXISTS fake_account_resets (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  actor TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);


-- The schema version of the embedded emulator store. This is intentionally
-- separate from the gateway database schema version.
CREATE TABLE IF NOT EXISTS fake_schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO fake_schema_version (version) VALUES (2);
