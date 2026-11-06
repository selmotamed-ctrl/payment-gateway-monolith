/** Ledger + audit fixtures shared by the single-host live test and the two-host lab. */

export const LEDGER_SCHEMA = `
CREATE TABLE gl_accounts (id uuid PRIMARY KEY, code text UNIQUE NOT NULL, checkpoint_balance numeric(20,4) NOT NULL DEFAULT 0, last_checkpoint_id text);
CREATE TABLE gl_account_shards (gl_account_id uuid NOT NULL REFERENCES gl_accounts(id), shard int NOT NULL, current_balance numeric(20,4) NOT NULL DEFAULT 0, PRIMARY KEY (gl_account_id, shard));
CREATE TABLE journal_entries (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE journal_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid NOT NULL REFERENCES journal_entries(id), gl_account_id uuid NOT NULL REFERENCES gl_accounts(id), direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')), amount numeric(20,4) NOT NULL);
CREATE TABLE heartbeat (at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO gl_accounts (id, code) VALUES (gen_random_uuid(), 'A'), (gen_random_uuid(), 'B');
INSERT INTO gl_account_shards SELECT a.id, s, 0 FROM gl_accounts a, generate_series(0, 15) s;

-- A balanced 16-shard entry: DEBIT account A / CREDIT account B, each shard moves amount/16.
CREATE FUNCTION post_balanced(p_amount numeric) RETURNS void AS $$
DECLARE e uuid := gen_random_uuid(); a uuid := (SELECT id FROM gl_accounts WHERE code = 'A'); b uuid := (SELECT id FROM gl_accounts WHERE code = 'B');
BEGIN
  INSERT INTO journal_entries (id) VALUES (e);
  FOR i IN 0..15 LOOP
    INSERT INTO journal_lines (journal_entry_id, gl_account_id, direction, amount) VALUES (e, a, 'DEBIT', p_amount / 16), (e, b, 'CREDIT', p_amount / 16);
    UPDATE gl_account_shards SET current_balance = current_balance + p_amount / 16 WHERE gl_account_id = a AND shard = i;
    UPDATE gl_account_shards SET current_balance = current_balance - p_amount / 16 WHERE gl_account_id = b AND shard = i;
  END LOOP;
END $$ LANGUAGE plpgsql;

-- One leg only (unbalanced on purpose); the shard follows the line so parity still holds.
CREATE FUNCTION post_line(p_code text, p_direction text, p_amount numeric) RETURNS void AS $$
DECLARE e uuid := gen_random_uuid(); acc uuid := (SELECT id FROM gl_accounts WHERE code = p_code);
BEGIN
  INSERT INTO journal_entries (id) VALUES (e);
  INSERT INTO journal_lines (journal_entry_id, gl_account_id, direction, amount) VALUES (e, acc, p_direction, p_amount);
  UPDATE gl_account_shards SET current_balance = current_balance + (CASE WHEN p_direction = 'DEBIT' THEN p_amount ELSE -p_amount END) WHERE gl_account_id = acc AND shard = 0;
END $$ LANGUAGE plpgsql;
`;

export const auditRows = (from: number, to: number): string => `
INSERT INTO audit_records (id, created_at, actor_id, role, action, entity_type, entity_id, before_json, after_json, prev_hash, row_hash)
SELECT gen_random_uuid(), clock_timestamp(), '0190a000-0000-7000-8000-000000000011', 'SECURITY_ADMIN', 'ACTION_' || g, 'thing', 'thing-' || g,
       jsonb_build_object('n', g, 'status', 'old', 'zz', 1), jsonb_build_object('n', g, 'status', 'new', 'tags', jsonb_build_array(1, 2)),
       repeat('0', 64), repeat('0', 64)
FROM generate_series(${from}, ${to}) g;`;
