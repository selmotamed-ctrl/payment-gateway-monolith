import { BaseWorker, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase } from "./automationCases";

/** What the worker needs of the audit database (`DedicatedAuditDatabaseDriver` implements it). */
export interface AuditChainSource {
  verifyChainSegment(input: { afterSeqNo: string | null; previousHash: string; limit: number }): Promise<{
    valid: boolean;
    verifiedCount: number;
    lastSeqNo: string | null;
    lastRowHash: string | null;
    firstBrokenId?: string;
  }>;
  rowHashAt(seqNo: string): Promise<string | null>;
}

export interface AnchorSigner {
  sign(data: string, keyId: string): Promise<string>;
  verifySignature(data: string, signature: string, keyId: string): Promise<boolean>;
}

export interface AuditChainAnchorWorkerDeps extends WorkerOptions {
  source: AuditChainSource;
  signer: AnchorSigner;
  /** Vault key the anchors are signed with. Default `audit-anchor-v1`. */
  keyId?: string;
  /** Rows verified per query. Default 5000. */
  segmentRows?: number;
  /** Segments one tick may verify (the next tick continues from the new anchor). Default 40. */
  maxSegmentsPerTick?: number;
  /** Anchor table. Production keeps the default; a test that shares the database uses a private copy (append-only rows cannot be cleaned up). */
  anchorTable?: string;
}

export const GENESIS_HASH = "0".repeat(64);

/** The text an anchor signs: versioned and positional so no field can be reinterpreted as another. */
export const anchorMessage = (input: { lastSeqNo: string; lastRowHash: string; rowsVerifiedTotal: string }): string =>
  `audit-anchor/v1|${input.lastSeqNo}|${input.lastRowHash}|${input.rowsVerifiedTotal}`;

interface AnchorRow {
  id: string;
  lastSeqNo: string;
  lastRowHash: string;
  rowsVerifiedTotal: string;
  keyId: string;
  signature: string;
}

/**
 * Daily verification of the LIVE audit hash chain with a signed anchor (AUTO-27). Cluster singleton.
 *
 * Until now the chain was only verified on a restored copy during a drill. Every tick this worker
 *
 *  1. loads the latest anchor and checks its signature (a forged or edited anchor row is an incident);
 *  2. checks that the audit database still holds the anchored row with the anchored hash (a truncated or rewritten
 *     audited past no longer matches its own anchor: the chain alone cannot show a removed tail);
 *  3. verifies the rows added since the anchor, segment by segment (bounded per tick, so the first run over a long
 *     history simply takes several ticks), linking the first new row to the anchored hash;
 *  4. stores a new signed anchor at the end of the verified range, and writes one audit row `AUDIT_CHAIN_ANCHORED`.
 *
 * Any failure opens ONE keyed P1 case (`audit.anchor_invalid`, `audit.chain_rewritten`, `audit.chain_broken`) and stops
 * without moving the anchor: an anchor is never signed over rows that did not verify. The cases are not auto-resolved,
 * an integrity incident needs a person.
 */
export class AuditChainAnchorWorker extends BaseWorker {
  /** Cluster singleton: only the advisory-lock leader ticks (GAP-012). */
  protected override get singleton(): boolean {
    return true;
  }

  private readonly source: AuditChainSource;
  private readonly signer: AnchorSigner;
  private readonly keyId: string;
  private readonly segmentRows: number;
  private readonly maxSegments: number;
  private readonly table: string;

  constructor(deps: AuditChainAnchorWorkerDeps) {
    super(deps);
    this.source = deps.source;
    this.signer = deps.signer;
    this.keyId = deps.keyId ?? "audit-anchor-v1";
    this.segmentRows = Math.max(1, Math.floor(deps.segmentRows ?? 5000));
    this.maxSegments = Math.max(1, Math.floor(deps.maxSegmentsPerTick ?? 40));
    const table = deps.anchorTable ?? "audit_chain_anchors";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`invalid anchor table name: ${table}`);
    this.table = table;
  }

  protected async tick(): Promise<WorkerTickResult> {
    const now = this.clock();
    const anchor = await this.latestAnchor();
    if (anchor) {
      const genuine = await this.signer.verifySignature(anchorMessage(anchor), anchor.signature, anchor.keyId);
      if (!genuine) {
        await this.raise("audit.anchor_invalid", `The latest audit-chain anchor (sequence ${anchor.lastSeqNo}, id ${anchor.id}) does not verify under key ${anchor.keyId}: the anchor row was edited or forged.`, now);
        return { processed: 0 };
      }
      const current = await this.source.rowHashAt(anchor.lastSeqNo);
      if (current !== anchor.lastRowHash) {
        await this.raise(
          "audit.chain_rewritten",
          current === null
            ? `The audit database no longer holds row ${anchor.lastSeqNo}, which was verified and anchored (anchor ${anchor.id}): its tail was truncated.`
            : `Audit row ${anchor.lastSeqNo} no longer has the hash that was anchored (anchor ${anchor.id}): the audited past was rewritten.`,
          now,
        );
        return { processed: 0 };
      }
    }

    let afterSeqNo = anchor?.lastSeqNo ?? null;
    let previousHash = anchor?.lastRowHash ?? GENESIS_HASH;
    let verifiedThisRun = 0;
    for (let segment = 0; segment < this.maxSegments; segment += 1) {
      const result = await this.source.verifyChainSegment({ afterSeqNo, previousHash, limit: this.segmentRows });
      if (!result.valid) {
        await this.raise(
          "audit.chain_broken",
          `The audit hash chain is broken at row id ${result.firstBrokenId ?? "unknown"}, after ${verifiedThisRun + result.verifiedCount} verified row(s) since the last anchor. The audit database was modified outside the append path.`,
          now,
        );
        // Anchor what verified BEFORE the break so the next run starts there and the break stays located.
        if (result.verifiedCount > 0 && result.lastSeqNo && result.lastRowHash) {
          await this.storeAnchor(result.lastSeqNo, result.lastRowHash, verifiedThisRun + result.verifiedCount, anchor, now, false);
        }
        return { processed: verifiedThisRun + result.verifiedCount };
      }
      if (result.verifiedCount === 0 || !result.lastSeqNo || !result.lastRowHash) break;
      verifiedThisRun += result.verifiedCount;
      afterSeqNo = result.lastSeqNo;
      previousHash = result.lastRowHash;
      if (result.verifiedCount < this.segmentRows) break;
    }

    if (verifiedThisRun > 0 && afterSeqNo) {
      await this.storeAnchor(afterSeqNo, previousHash, verifiedThisRun, anchor, now, true);
    }
    return { processed: verifiedThisRun };
  }

  /** Numeric order on purpose: the text aliases below must not be what `ORDER BY` resolves to ("8" sorts after "16"). */
  private async latestAnchor(): Promise<AnchorRow | null> {
    const rows = toCamelRows<Record<string, unknown>>(
      await this.db.$queryRawUnsafe(
        "SELECT id::text AS id, last_seq_no::text AS last_seq_text, last_row_hash, rows_verified_total::text AS rows_verified_total," +
          ` key_id, signature FROM ${this.table} ORDER BY last_seq_no DESC LIMIT 1`,
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      lastSeqNo: String(row.lastSeqText),
      lastRowHash: String(row.lastRowHash).trim(),
      rowsVerifiedTotal: String(row.rowsVerifiedTotal),
      keyId: String(row.keyId),
      signature: String(row.signature).trim(),
    };
  }

  private async storeAnchor(
    lastSeqNo: string,
    lastRowHash: string,
    rowsThisRun: number,
    previous: AnchorRow | null,
    now: Date,
    clean: boolean,
  ): Promise<void> {
    const total = (BigInt(previous?.rowsVerifiedTotal ?? "0") + BigInt(rowsThisRun)).toString();
    const signature = await this.signer.sign(anchorMessage({ lastSeqNo, lastRowHash, rowsVerifiedTotal: total }), this.keyId);
    await this.inTransaction(async (tx) => {
      const inserted = toCamelRows<Record<string, unknown>>(
        await tx.$queryRawUnsafe(
          `INSERT INTO ${this.table} (id, created_at, last_seq_no, last_row_hash, rows_verified_total, rows_verified_this_run, key_id, signature)` +
            " VALUES (gen_random_uuid(), $1, $2::bigint, $3, $4::bigint, $5, $6, $7) ON CONFLICT (last_seq_no) DO NOTHING RETURNING id::text AS id",
          now,
          lastSeqNo,
          lastRowHash,
          total,
          rowsThisRun,
          this.keyId,
          signature,
        ),
      );
      if (inserted.length === 0) return; // another leader anchored the same point
      await writeSystemAudit(tx, {
        action: "AUDIT_CHAIN_ANCHORED",
        entityType: "AUDIT_CHAIN",
        entityId: lastSeqNo,
        before: { previousSeqNo: previous?.lastSeqNo ?? null },
        after: { lastSeqNo, lastRowHash, rowsVerifiedThisRun: rowsThisRun, rowsVerifiedTotal: total, keyId: this.keyId, clean },
      });
    });
  }

  private async raise(subject: string, notes: string, now: Date): Promise<void> {
    await openKeyedOperatorCase(this.db, {
      kind: "MANUAL_REVIEW",
      priority: "P1",
      subjectKey: subject,
      notes,
      slaHours: 4,
      now,
    });
    this.logger.error(`AuditChainAnchorWorker: ${subject}`, { notes });
  }
}
