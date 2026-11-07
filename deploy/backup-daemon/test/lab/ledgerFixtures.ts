/** Ledger + audit fixtures shared by the single-host live test and the two-host lab. */

export const LEDGER_SCHEMA = `
CREATE TABLE gl_accounts (id uuid PRIMARY KEY, code text UNIQUE NOT NULL);
CREATE TABLE gl_account_shards (gl_account_id uuid NOT NULL REFERENCES gl_accounts(id), shard_id int NOT NULL, current_balance numeric(20,4) NOT NULL DEFAULT 0, line_seq bigint NOT NULL DEFAULT 0, PRIMARY KEY (gl_account_id, shard_id));
CREATE TABLE gl_shard_checkpoints (gl_account_id uuid NOT NULL, shard_id int NOT NULL, checkpoint_balance numeric(20,4) NOT NULL DEFAULT 0, checkpoint_seq bigint NOT NULL DEFAULT 0, baseline_seq bigint NOT NULL DEFAULT 0, PRIMARY KEY (gl_account_id, shard_id));
CREATE TABLE journal_entries (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE journal_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid NOT NULL REFERENCES journal_entries(id), gl_account_id uuid NOT NULL REFERENCES gl_accounts(id), direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')), amount numeric(20,4) NOT NULL, shard_id int NOT NULL DEFAULT 0, shard_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE heartbeat (at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO gl_accounts (id, code) VALUES (gen_random_uuid(), 'A'), (gen_random_uuid(), 'B');
INSERT INTO gl_account_shards (gl_account_id, shard_id) SELECT a.id, s FROM gl_accounts a, generate_series(0, 15) s;

-- Posts one line on a shard the way the poster does: bump the shard (balance + sequence) first, then insert the line
-- carrying the sequence number the bump returned.
CREATE FUNCTION post_shard_line(p_entry uuid, p_account uuid, p_shard int, p_direction text, p_amount numeric) RETURNS void AS $$
DECLARE s bigint;
BEGIN
  UPDATE gl_account_shards
     SET current_balance = current_balance + (CASE WHEN p_direction = 'DEBIT' THEN p_amount ELSE -p_amount END), line_seq = line_seq + 1
   WHERE gl_account_id = p_account AND shard_id = p_shard
   RETURNING line_seq INTO s;
  INSERT INTO journal_lines (journal_entry_id, gl_account_id, direction, amount, shard_id, shard_seq) VALUES (p_entry, p_account, p_direction, p_amount, p_shard, s);
END $$ LANGUAGE plpgsql;

-- A balanced 16-shard entry: DEBIT account A / CREDIT account B, each shard moves amount/16.
CREATE FUNCTION post_balanced(p_amount numeric) RETURNS void AS $$
DECLARE e uuid := gen_random_uuid(); a uuid := (SELECT id FROM gl_accounts WHERE code = 'A'); b uuid := (SELECT id FROM gl_accounts WHERE code = 'B');
BEGIN
  INSERT INTO journal_entries (id) VALUES (e);
  FOR i IN 0..15 LOOP
    PERFORM post_shard_line(e, a, i, 'DEBIT', p_amount / 16);
    PERFORM post_shard_line(e, b, i, 'CREDIT', p_amount / 16);
  END LOOP;
END $$ LANGUAGE plpgsql;

-- One leg only (unbalanced on purpose); the shard follows the line so parity still holds.
CREATE FUNCTION post_line(p_code text, p_direction text, p_amount numeric) RETURNS void AS $$
DECLARE e uuid := gen_random_uuid(); acc uuid := (SELECT id FROM gl_accounts WHERE code = p_code);
BEGIN
  INSERT INTO journal_entries (id) VALUES (e);
  PERFORM post_shard_line(e, acc, 0, p_direction, p_amount);
END $$ LANGUAGE plpgsql;
`;

export const auditRows = (from: number, to: number): string => `
INSERT INTO audit_records (id, created_at, actor_id, role, action, entity_type, entity_id, before_json, after_json, prev_hash, row_hash)
SELECT gen_random_uuid(), clock_timestamp(), '0190a000-0000-7000-8000-000000000011', 'SECURITY_ADMIN', 'ACTION_' || g, 'thing', 'thing-' || g,
       jsonb_build_object('n', g, 'status', 'old', 'zz', 1), jsonb_build_object('n', g, 'status', 'new', 'tags', jsonb_build_array(1, 2)),
       repeat('0', 64), repeat('0', 64)
FROM generate_series(${from}, ${to}) g;`;
