/**
 * AUTO-27 the daily audit-chain anchor against a real dedicated audit database (private schema) and live PostgreSQL:
 * incremental verification, signed anchors, and the three integrity incidents (broken chain, rewritten or truncated
 * past, forged anchor), each opening ONE keyed P1 case and never moving the anchor over rows that did not verify.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { Vault } from "../../engine/crypto/Vault";
import { AuditChainAnchorWorker, anchorMessage } from "../../engine/workers/AuditChainAnchorWorker";
import type { AuditEnvelope } from "../../lib/storageEngine/ports";
import { createAuditSandbox, createPrisma, databaseIsReachable, uniqueId, uniqueUuid, type AuditSandbox } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 6 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = new Date();
const vault = new Vault({ masterKey: randomBytes(32) });
const KEY = "audit-anchor-v1";
const sandboxes: AuditSandbox[] = [];
const tables: string[] = [];

const entry = (index: number): AuditEnvelope => ({
  actorId: uniqueUuid(),
  actorEmail: "auditor@example.test",
  role: "SECURITY_ADMIN",
  action: `ANCHOR_TEST_${index}`,
  entityType: "ANCHOR_TEST",
  entityId: uniqueId("entity"),
  beforeJson: { index },
  afterJson: { index, nested: { b: 2, a: 1 } },
});

const append = (sandbox: AuditSandbox, count: number, from = 0) => sandbox.driver.appendBatch(Array.from({ length: count }, (_, index) => entry(from + index)));

const setup = async (rows: number) => {
  const sandbox = await createAuditSandbox("anchor");
  sandboxes.push(sandbox);
  const table = `audit_chain_anchors_t${randomBytes(4).toString("hex")}`;
  await client.$executeRawUnsafe(`CREATE TABLE ${table} (LIKE audit_chain_anchors INCLUDING ALL)`);
  tables.push(table);
  const inserted = rows > 0 ? await append(sandbox, rows) : [];
  return { sandbox, table, inserted };
};

const worker = (sandbox: AuditSandbox, table: string, extra: Partial<ConstructorParameters<typeof AuditChainAnchorWorker>[0]> = {}) =>
  new AuditChainAnchorWorker({
    db: client as never,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    clock: () => NOW,
    source: sandbox.driver,
    signer: vault,
    keyId: KEY,
    anchorTable: table,
    ...extra,
  });

const anchors = (table: string) =>
  client.$queryRawUnsafe<Array<{ last_seq_no: string; last_row_hash: string; rows_verified_total: string; rows_verified_this_run: number; signature: string; key_id: string }>>(
    `SELECT last_seq_no::text AS last_seq_no, last_row_hash, rows_verified_total::text AS rows_verified_total, rows_verified_this_run, signature, key_id FROM ${table} ORDER BY ${table}.last_seq_no`,
  );
const cases = () => client.operatorCase.findMany({ where: { subjectKey: { startsWith: "audit." } }, select: { subjectKey: true, priority: true, state: true, resolutionNotes: true } });
const disableImmutable = (sandbox: AuditSandbox) => sandbox.pool.query(`ALTER TABLE ${sandbox.table} DISABLE TRIGGER trg_audit_immutable`);

beforeEach(async () => {
  await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key LIKE 'audit.%'`);
});

afterAll(async () => {
  for (const sandbox of sandboxes) await sandbox.cleanup();
  for (const table of tables) await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
  await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key LIKE 'audit.%'`);
  await client.$disconnect();
});

describeDb("audit chain anchor (live PostgreSQL)", () => {
  test("the first run verifies the whole chain and stores one signed anchor; later runs verify only what is new", async () => {
    const { sandbox, table, inserted } = await setup(25);
    const last = inserted.at(-1)!;
    await worker(sandbox, table).runOnce();

    let rows = await anchors(table);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ last_seq_no: String(last.seqNo), last_row_hash: last.rowHash, rows_verified_total: "25", rows_verified_this_run: 25, key_id: KEY });
    expect(await vault.verifySignature(anchorMessage({ lastSeqNo: String(last.seqNo), lastRowHash: last.rowHash, rowsVerifiedTotal: "25" }), rows[0]!.signature, KEY)).toBe(true);
    expect(await cases()).toEqual([]);

    // nothing new: no second anchor
    await worker(sandbox, table).runOnce();
    expect(await anchors(table)).toHaveLength(1);

    const more = await append(sandbox, 10, 25);
    await worker(sandbox, table).runOnce();
    rows = await anchors(table);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ last_seq_no: String(more.at(-1)!.seqNo), rows_verified_total: "35", rows_verified_this_run: 10 });
    expect(await cases()).toEqual([]);
  });

  test("an empty chain stores nothing and raises nothing", async () => {
    const { sandbox, table } = await setup(0);
    await worker(sandbox, table).runOnce();
    expect(await anchors(table)).toEqual([]);
    expect(await cases()).toEqual([]);
  });

  test("a long history is verified over several ticks, the anchor advancing each time, with the same end result", async () => {
    const { sandbox, table, inserted } = await setup(23);
    const small = { segmentRows: 4, maxSegmentsPerTick: 2 }; // 8 rows per tick
    let ticks = 0;
    for (; ticks < 10; ticks += 1) {
      await worker(sandbox, table, small).runOnce();
      const current = await anchors(table);
      if (current.at(-1)?.last_seq_no === String(inserted.at(-1)!.seqNo)) break;
    }
    const rows = await anchors(table);
    expect(ticks).toBe(2); // 8 + 8 + 7 rows = three ticks
    expect(rows.map((row) => row.rows_verified_total)).toEqual(["8", "16", "23"]);
    expect(rows.at(-1)!.last_row_hash).toBe(inserted.at(-1)!.rowHash);
    expect(await cases()).toEqual([]);
  });

  test("a row edited after it was written breaks the chain: ONE P1 case, and the anchor stops at the last good row", async () => {
    const { sandbox, table, inserted } = await setup(20);
    await disableImmutable(sandbox);
    const target = inserted[12]!;
    await sandbox.pool.query(`UPDATE ${sandbox.table} SET after_json = '{"tampered":true}'::jsonb WHERE id = $1`, [target.id]);

    await worker(sandbox, table).runOnce();
    await worker(sandbox, table).runOnce();
    const found = await cases();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subjectKey: "audit.chain_broken", priority: "P1", state: "OPEN" });
    expect(found[0]!.resolutionNotes).toContain(target.id);
    const rows = await anchors(table);
    expect(rows).toHaveLength(1); // the second run starts at the anchor and finds the same break; it adds nothing
    expect(rows[0]).toMatchObject({ last_seq_no: String(inserted[11]!.seqNo), rows_verified_total: "12" });
  });

  test("a rewritten anchored row is detected against its anchor even though the rows after it still chain", async () => {
    const { sandbox, table, inserted } = await setup(15);
    await worker(sandbox, table).runOnce();
    await append(sandbox, 5, 15);
    // the attacker recomputes nothing: only the anchored row's hash is replaced
    await disableImmutable(sandbox);
    await sandbox.pool.query(`UPDATE ${sandbox.table} SET row_hash = $2 WHERE id = $1`, [inserted.at(-1)!.id, "f".repeat(64)]);
    await worker(sandbox, table).runOnce();
    const found = await cases();
    expect(found.map((row) => row.subjectKey)).toEqual(["audit.chain_rewritten"]);
    expect(found[0]!.resolutionNotes).toMatch(/rewritten/);
    expect(await anchors(table)).toHaveLength(1);
  });

  test("a truncated tail (rows deleted after they were anchored) is detected", async () => {
    const { sandbox, table, inserted } = await setup(15);
    await worker(sandbox, table).runOnce();
    await disableImmutable(sandbox);
    await sandbox.pool.query(`DELETE FROM ${sandbox.table} WHERE id = ANY($1::uuid[])`, [inserted.slice(-3).map((row) => row.id)]);
    await worker(sandbox, table).runOnce();
    const found = await cases();
    expect(found.map((row) => row.subjectKey)).toEqual(["audit.chain_rewritten"]);
    expect(found[0]!.resolutionNotes).toMatch(/truncated/);
  });

  test("a forged anchor (valid shape, wrong signature) is an incident and is never trusted", async () => {
    const { sandbox, table, inserted } = await setup(10);
    await worker(sandbox, table).runOnce();
    const forgedSeq = String(Number(inserted.at(-1)?.seqNo ?? 0) + 100);
    await client.$executeRawUnsafe(
      `INSERT INTO ${table} (id, last_seq_no, last_row_hash, rows_verified_total, rows_verified_this_run, key_id, signature) VALUES (gen_random_uuid(), $1::bigint, $2, 110, 100, $3, $4)`,
      forgedSeq,
      "a".repeat(64),
      KEY,
      "b".repeat(64),
    );
    await worker(sandbox, table).runOnce();
    expect((await cases()).map((row) => row.subjectKey)).toEqual(["audit.anchor_invalid"]);
    // a signature made with another key is as invalid as garbage
    const stranger = new Vault({ masterKey: randomBytes(32) });
    expect(await stranger.verifySignature(anchorMessage({ lastSeqNo: "1", lastRowHash: "a".repeat(64), rowsVerifiedTotal: "1" }), await vault.sign("x", KEY), KEY)).toBe(false);
  });

  test("two leaders racing on the same point store one anchor (the unique sequence wins)", async () => {
    const { sandbox, table } = await setup(8);
    await Promise.all([worker(sandbox, table).runOnce(), worker(sandbox, table).runOnce()]);
    expect(await anchors(table)).toHaveLength(1);
  });

  test("the audit_chain_anchors table itself is append-only", async () => {
    await client.$executeRawUnsafe(
      `INSERT INTO audit_chain_anchors (id, last_seq_no, last_row_hash, rows_verified_total, rows_verified_this_run, key_id, signature)
       VALUES (gen_random_uuid(), -1, '${"0".repeat(64)}', 1, 1, 'k', '${"0".repeat(64)}') ON CONFLICT DO NOTHING`,
    );
    await expect(Promise.resolve(client.$executeRawUnsafe(`DELETE FROM audit_chain_anchors WHERE last_seq_no = -1`))).rejects.toThrow(/append-only/);
    await expect(Promise.resolve(client.$executeRawUnsafe(`UPDATE audit_chain_anchors SET key_id = 'x' WHERE last_seq_no = -1`))).rejects.toThrow(/append-only/);
  });
});

describe("vault signatures", () => {
  test("a signature verifies only for the same data and key; malformed signatures are rejected", async () => {
    const signature = await vault.sign("hello", KEY);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(await vault.verifySignature("hello", signature, KEY)).toBe(true);
    expect(await vault.verifySignature("hello!", signature, KEY)).toBe(false);
    expect(await vault.verifySignature("hello", signature, "other-key")).toBe(false);
    expect(await vault.verifySignature("hello", "not-hex", KEY)).toBe(false);
    expect(await vault.verifySignature("hello", signature.toUpperCase(), KEY)).toBe(false);
  });
});
