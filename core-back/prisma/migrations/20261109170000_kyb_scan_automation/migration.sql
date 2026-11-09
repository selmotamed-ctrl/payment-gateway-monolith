-- ============================================================================
-- AUTO-06 KYB document scanning worker.
--
-- With the production default (no scanner configured at upload) a document stays PENDING and nothing scans it again, so
-- reviewers cannot open it. The KybScanWorker scans PENDING documents with the configured engine (ClamAV clamd), stores
-- the verdict with the engine signature version, retries with backoff and re-scans CLEAN documents after
-- KYB_RESCAN_DAYS. These columns hold the scan bookkeeping; `av_status` stays the single gate the download and review
-- paths read.
-- ============================================================================

ALTER TABLE "kyb_documents"
  ADD COLUMN IF NOT EXISTS "av_scanned_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "av_engine" TEXT,
  ADD COLUMN IF NOT EXISTS "av_signature" TEXT,
  ADD COLUMN IF NOT EXISTS "av_scan_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "av_next_scan_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "av_last_error" TEXT;

-- The worker's two claim queries: PENDING rows that are due, and CLEAN rows whose last scan is old.
CREATE INDEX IF NOT EXISTS "kyb_documents_pending_scan_idx"
  ON "kyb_documents" ("av_next_scan_at", "created_at")
  WHERE "av_status" = 'PENDING';
CREATE INDEX IF NOT EXISTS "kyb_documents_clean_rescan_idx"
  ON "kyb_documents" ("av_scanned_at")
  WHERE "av_status" = 'CLEAN';

-- ---------------------------------------------------------------------------
-- Schema version 21
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 21, "updated_at" = now()
WHERE "id" = 1;
