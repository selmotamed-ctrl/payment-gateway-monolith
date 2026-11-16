import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase } from "./automationCases";
import { bilingualNotice, queueNotice, type NoticeDefinition } from "../../lib/automationNotices";
import { KybScannerError, type KybScanner } from "../../lib/kybScanner";
import type { ObjectStorageSdk } from "../../lib/objectStorageSdk";

type Any = Record<string, any>;

/** Merchant notice (AUTO-06): neutral, it names the document type only, never the detection. */
export const KYB_DOCUMENT_QUARANTINED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "KYB_DOCUMENT_QUARANTINED",
  en: {
    subject: "A document you uploaded could not be accepted",
    body: "The {{docType}} document you uploaded failed our security check and cannot be used. Please upload a clean replacement.",
  },
  ar: {
    subject: "تعذر قبول مستند قمت برفعه",
    body: "لم يجتز المستند ({{docType}}) الذي رفعته الفحص الأمني ولا يمكن استخدامه. يرجى رفع نسخة بديلة سليمة.",
  },
});

/** Seconds a claimed document is reserved for one scan; a crashed node's claim is retried after it. */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface KybScanWorkerDeps extends WorkerOptions {
  /** The engine; null means none is configured and the worker only reports it (documents stay PENDING). */
  scanner: KybScanner | null;
  /** The shared object-storage vault; when present the document bytes and the object verdict are kept in sync. */
  objectStorage?: ObjectStorageSdk;
  /** Decrypts a document's `content_ciphertext` to its bytes (production: the platform vault). */
  openContent: (ciphertext: string) => Promise<Buffer>;
  /** Re-scan CLEAN documents older than this many days; 0 turns re-scanning off. Default 30. */
  rescanDays?: number;
  /** Consecutive failed attempts after which a P2 case is opened (the retries continue). Default 8. */
  maxAttempts?: number;
  /** Retry backoff: `base * 2^(attempt-1)` up to `max`. Defaults 1 minute and 6 hours. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /**
   * Restricts the worker to these merchants' documents. Production leaves it unset (every document); tests that share
   * one database with other suites use it so they never scan a document they did not create.
   */
  merchantIds?: readonly string[];
}

interface ClaimedDocument {
  id: string;
  merchantId: string;
  docType: string;
  status: string;
  avStatus: "PENDING" | "CLEAN";
  attempts: number;
  uploadedBy: string | null;
  sha256: string;
  storageObjectId: string | null;
}

/**
 * Scans KYB documents that no engine has examined yet and re-scans the ones the signature set may have outgrown
 * (AUTO-06, decision D5: ClamAV `clamd`). Not a singleton: every node claims its own batch with
 * `FOR UPDATE SKIP LOCKED` and a short lease, so two nodes never scan the same document.
 *
 *  - PENDING -> CLEAN | INFECTED when the engine examined the bytes; any scanner failure leaves the document PENDING
 *    (fail closed) and schedules a retry with exponential backoff. After `maxAttempts` failures a keyed P2 case is
 *    opened once; the retries go on.
 *  - INFECTED quarantines: an UPLOADED document becomes REJECTED (download and review were already gated on CLEAN),
 *    the uploader gets a neutral notice, a keyed P1 case is opened, and one audit row records the detection. An
 *    ACCEPTED document that turns infected on a re-scan keeps its review status (a human decides about the merchant's
 *    KYB), but `av_status = INFECTED` already makes it undownloadable and not actionable; the case asks for that decision.
 *  - A failed RE-scan of a CLEAN document never downgrades it: the previous verdict stands, the failure is recorded.
 *
 * The result of a scan is applied with a guarded UPDATE (`av_status` must still be what the claim saw), so a
 * document replaced or decided while it was being scanned is never overwritten.
 */
export class KybScanWorker extends BaseWorker {
  private readonly scanner: KybScanner | null;
  private readonly openContent: KybScanWorkerDeps["openContent"];
  private readonly objectStorage: ObjectStorageSdk | undefined;
  private readonly rescanDays: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly merchantIds: readonly string[] | null;

  constructor(deps: KybScanWorkerDeps) {
    super(deps);
    this.scanner = deps.scanner;
    this.openContent = deps.openContent;
    this.objectStorage = deps.objectStorage;
    this.rescanDays = Math.max(0, deps.rescanDays ?? 30);
    this.maxAttempts = Math.max(1, Math.floor(deps.maxAttempts ?? 8));
    this.retryBaseMs = deps.retryBaseMs ?? 60_000;
    this.retryMaxMs = deps.retryMaxMs ?? 6 * 60 * 60 * 1000;
    this.merchantIds = deps.merchantIds && deps.merchantIds.length > 0 ? [...deps.merchantIds] : null;
  }

  protected async tick(): Promise<WorkerTickResult> {
    if (!this.scanner) {
      return { processed: 0 };
    }
    const now = this.clock();
    let processed = 0;
    const failures: string[] = [];
    const pending = await this.claim(now, "PENDING");
    for (const document of pending) {
      processed += 1;
      const error = await this.scanOne(document);
      if (error) failures.push(error);
    }
    if (this.rescanDays > 0) {
      const rescans = await this.claim(now, "CLEAN");
      for (const document of rescans) {
        processed += 1;
        const error = await this.scanOne(document);
        if (error) failures.push(error);
      }
    }
    if (failures.length > 0) {
      // Surface the failure to the health registry; the documents themselves are already scheduled for a retry.
      throw new Error(`KybScanWorker: ${failures.length} scan(s) failed (${failures[0]})`);
    }
    return { processed };
  }

  private async claim(now: Date, kind: "PENDING" | "CLEAN"): Promise<ClaimedDocument[]> {
    const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
    const cutoff = new Date(now.getTime() - this.rescanDays * 86_400_000);
    const eligible =
      kind === "PENDING"
        ? "av_status = 'PENDING' AND (av_next_scan_at IS NULL OR av_next_scan_at <= $1)"
        : "av_status = 'CLEAN' AND (av_next_scan_at IS NULL OR av_next_scan_at <= $1) AND (av_scanned_at IS NULL OR av_scanned_at < $4::timestamp)";
    const order = kind === "PENDING" ? "created_at ASC" : "av_scanned_at ASC NULLS FIRST, created_at ASC";
    // Every placeholder must be referenced: PostgreSQL cannot type an unused parameter.
    const params: unknown[] = [now, this.batchSize, lease];
    if (kind === "CLEAN") params.push(cutoff);
    const scope = this.merchantIds ? ` AND merchant_id = ANY($${params.length + 1}::uuid[])` : "";
    if (this.merchantIds) params.push(this.merchantIds);
    const rows = await this.inTransaction(async (tx) =>
      toCamelRows<Record<string, unknown>>(
        await tx.$queryRawUnsafe(
          `WITH target AS (SELECT id FROM kyb_documents WHERE ${eligible}${scope} ORDER BY ${order} LIMIT $2 FOR UPDATE SKIP LOCKED)` +
            " UPDATE kyb_documents d SET av_next_scan_at = $3, av_scan_attempts = d.av_scan_attempts + 1, updated_at = $1" +
            " FROM target t WHERE d.id = t.id" +
            " RETURNING d.id, d.merchant_id, d.doc_type::text AS doc_type, d.status::text AS status, d.av_status::text AS av_status," +
            " d.av_scan_attempts AS attempts, d.uploaded_by, d.sha256, d.storage_object_id",
          ...params,
        ),
      ),
    );
    return rows.map((row) => ({
      id: String(row.id),
      merchantId: String(row.merchantId),
      docType: String(row.docType),
      status: String(row.status),
      avStatus: String(row.avStatus) as "PENDING" | "CLEAN",
      attempts: Number(row.attempts),
      uploadedBy: row.uploadedBy ? String(row.uploadedBy) : null,
      sha256: String(row.sha256),
      storageObjectId: row.storageObjectId ? String(row.storageObjectId) : null,
    }));
  }

  /**
   * Returns an error summary when the scan failed because of the scanner (and was scheduled for a retry), null
   * otherwise. A document with nothing to scan is recorded and escalated but is not a scanner failure.
   */
  private async scanOne(document: ClaimedDocument): Promise<string | null> {
    const now = this.clock();
    try {
      let bytes: Buffer;
      if (document.storageObjectId && this.objectStorage) {
        bytes = (await this.objectStorage.workerClient.readForScan(document.storageObjectId)).bytes;
      } else {
        const stored = await this.db.kybDocument.findUnique({ where: { id: document.id }, select: { storageObjectId: true } });
        if (stored?.storageObjectId && this.objectStorage) {
          bytes = (await this.objectStorage.workerClient.readForScan(String(stored.storageObjectId))).bytes;
        } else {
          throw new KybScannerError("the document has no shared object-storage content to scan", false);
        }
      }
      const result = await this.scanner!.scan(bytes);
      await this.applyVerdict(document, result, this.clock());
      return null;
    } catch (error) {
      const message = sanitizeWorkerError(error);
      await this.recordFailure(document, message, now).catch((failure) => {
        this.logger.error("KybScanWorker: could not record a scan failure", { documentId: document.id, error: sanitizeWorkerError(failure) });
      });
      this.logger.warn("KybScanWorker: scan failed", { documentId: document.id, attempt: document.attempts, error: message });
      return error instanceof KybScannerError && !error.retryable ? null : message;
    }
  }

  private async applyVerdict(
    document: ClaimedDocument,
    result: { verdict: "CLEAN" | "INFECTED"; engine: string; signature?: string; threat?: string },
    now: Date,
  ): Promise<void> {
    if (document.storageObjectId && this.objectStorage) {
      // Keep the vault state in step with the domain verdict: CLEAN promotes
      // the object (and stamps retention); INFECTED releases the domain lock
      // and quarantines it. A vault error is retried by the next scan pass.
      try {
        await this.objectStorage.workerClient.applyScanVerdict({
          objectId: document.storageObjectId,
          verdict: result.verdict,
          signature: result.verdict === "INFECTED" ? (result.signature ?? result.threat ?? result.engine) : null,
        });
      } catch (error) {
        const message = sanitizeWorkerError(error);
        if (!/PURGED|NOT_FOUND|QUARANTINE_REJECTED/i.test(message)) throw error;
      }
    }
    await this.inTransaction(async (tx) => {
      const rows = toCamelRows<Record<string, unknown>>(
        await tx.$queryRawUnsafe(
          "UPDATE kyb_documents SET av_status = $2::\"AvStatus\", av_scanned_at = $3, av_engine = $4, av_signature = $5," +
            " av_scan_attempts = 0, av_next_scan_at = NULL, av_last_error = NULL, updated_at = $3," +
            // A pending upload that turns infected is rejected like an infected upload is; a decided one keeps its status.
            " status = CASE WHEN $2 = 'INFECTED' AND status = 'UPLOADED' THEN 'REJECTED'::\"KybDocumentStatus\" ELSE status END," +
            " rejection_reason_code = CASE WHEN $2 = 'INFECTED' AND status = 'UPLOADED' THEN 'OTHER' ELSE rejection_reason_code END," +
            " review_notes = CASE WHEN $2 = 'INFECTED' AND status = 'UPLOADED' THEN 'Rejected automatically: the malware scan flagged this file.' ELSE review_notes END," +
            " status_changed_at = CASE WHEN $2 = 'INFECTED' AND status = 'UPLOADED' THEN $3 ELSE status_changed_at END" +
            " WHERE id = $1::uuid AND av_status = $6::\"AvStatus\" RETURNING id, status::text AS status",
          document.id,
          result.verdict,
          now,
          result.engine,
          result.signature ?? null,
          document.avStatus,
        ),
      );
      if (rows.length === 0) return; // decided or rescanned elsewhere while this node was scanning
      const finalStatus = String(rows[0]!.status);
      if (result.verdict !== "INFECTED") {
        if (document.avStatus === "PENDING") {
          await writeSystemAudit(tx as Any, {
            action: "KYB_DOCUMENT_SCANNED",
            entityType: "KYB_DOCUMENT",
            entityId: document.id,
            before: { avStatus: "PENDING" },
            after: { avStatus: "CLEAN", engine: result.engine, signature: result.signature ?? null },
          });
        }
        return;
      }
      await writeSystemAudit(tx as Any, {
        action: "KYB_DOCUMENT_QUARANTINED",
        entityType: "KYB_DOCUMENT",
        entityId: document.id,
        before: { avStatus: document.avStatus, status: document.status },
        after: {
          avStatus: "INFECTED",
          status: finalStatus,
          engine: result.engine,
          signature: result.signature ?? null,
          threat: result.threat ?? null,
          merchantId: document.merchantId,
          rescan: document.avStatus === "CLEAN",
        },
      });
      await openKeyedOperatorCase(tx, {
        kind: "MANUAL_REVIEW",
        priority: "P1",
        subjectKey: `kyb-infected:${document.id}`,
        notes:
          `KYB document ${document.id} (${document.docType}, merchant ${document.merchantId}) was flagged by ${result.engine}` +
          `${result.threat ? ` (${result.threat})` : ""}${document.avStatus === "CLEAN" ? " on a re-scan; it had been clean before" : ""}.` +
          ` It is quarantined (not downloadable). ${finalStatus === "ACCEPTED" ? "It was ACCEPTED: decide whether the merchant's KYB still stands. " : ""}Ask the merchant for a replacement.`,
        slaHours: 4,
        now,
      });
      if (document.uploadedBy && finalStatus === "REJECTED") {
        await queueNotice(tx as Any, {
          definition: KYB_DOCUMENT_QUARANTINED_NOTICE,
          eventKey: `kyb-quarantined:${document.id}`,
          payload: { docType: document.docType.replaceAll("_", " ").toLowerCase() },
          userId: document.uploadedBy,
          merchantId: document.merchantId,
        });
      }
    });
  }

  private async recordFailure(document: ClaimedDocument, message: string, now: Date): Promise<void> {
    const retryable = !/no stored content/.test(message) && !/size limit/i.test(message);
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, document.attempts - 1));
    await this.inTransaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "UPDATE kyb_documents SET av_last_error = $2, av_next_scan_at = $3, updated_at = $4 WHERE id = $1::uuid RETURNING id",
        document.id,
        message.slice(0, 500),
        new Date(now.getTime() + (retryable ? delay : this.retryMaxMs)),
        now,
      );
      if (document.attempts >= this.maxAttempts || !retryable) {
        await openKeyedOperatorCase(tx, {
          kind: "MANUAL_REVIEW",
          priority: "P2",
          subjectKey: `kyb-scan-failed:${document.id}`,
          notes:
            `KYB document ${document.id} (${document.docType}, merchant ${document.merchantId}) could not be scanned after ${document.attempts} attempt(s): ${message}.` +
            (document.avStatus === "PENDING" ? " It stays PENDING and cannot be reviewed until a scan succeeds." : " Its previous CLEAN verdict stands."),
          slaHours: 24,
          now,
        });
      }
    });
  }
}
