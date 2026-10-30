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
