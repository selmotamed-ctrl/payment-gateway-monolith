-- ============================================================================
-- AUTO-16 regulatory report drafting and filing due dates.
--
-- `regulatory_reports` gets a filing due date and a (report_code, period_key) identity so the RegulatoryReportWorker can
-- draft each periodic return exactly once per period. The provisional CBL report catalogue (plan section 6.2) is data:
-- one `reporting_rules` row per scheduled return, status PROVISIONAL, confirmed or replaced through maker-checker later.
-- ============================================================================

ALTER TABLE "regulatory_reports"
  ADD COLUMN IF NOT EXISTS "due_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "report_code" TEXT,
  ADD COLUMN IF NOT EXISTS "period_key" TEXT;

-- One draft per scheduled return and period, however many nodes or ticks try to create it.
CREATE UNIQUE INDEX IF NOT EXISTS "regulatory_reports_code_period_key"
  ON "regulatory_reports" ("report_code", "period_key")
  WHERE "report_code" IS NOT NULL AND "period_key" IS NOT NULL;

-- The deadline rule scans reports that are not filed yet.
CREATE INDEX IF NOT EXISTS "regulatory_reports_open_due_idx"
  ON "regulatory_reports" ("due_at")
  WHERE "due_at" IS NOT NULL AND "status" IN ('DRAFT', 'PENDING_CHECKER', 'APPROVED');

INSERT INTO "reporting_rules"
  ("id", "created_at", "updated_at", "authority", "report_type", "threshold_amount", "window_seconds", "currency", "conditions", "source_reference", "status", "effective_from")
VALUES
  ('019a0000-0000-7000-8000-000000000a01', now(), now(), 'CBL', 'PERIODIC_RETURN', NULL, NULL, 'LYD',
   '{"returnCode":"PSP-M","period":"MONTHLY","dueDays":10,"sections":["paymentsByRail","refunds","disputes","cashouts","merchants","fundsPosition"]}'::jsonb,
   'provisional default, pending CBL confirmation', 'PROVISIONAL', '2026-01-01'),
  ('019a0000-0000-7000-8000-000000000a02', now(), now(), 'CBL', 'PERIODIC_RETURN', NULL, NULL, 'LYD',
   '{"returnCode":"AML-Q","period":"QUARTERLY","dueDays":15,"sections":["screenings","amlCases","suspiciousActivityReportCount","kyb"]}'::jsonb,
   'provisional default, pending CBL confirmation', 'PROVISIONAL', '2026-01-01'),
  ('019a0000-0000-7000-8000-000000000a03', now(), now(), 'CBL', 'PERIODIC_RETURN', NULL, NULL, 'LYD',
   '{"returnCode":"AML-A","period":"ANNUAL","dueDays":31,"sections":["screenings","amlCases","kyb","riskTiers"]}'::jsonb,
   'provisional default, pending CBL confirmation', 'PROVISIONAL', '2026-01-01'),
  ('019a0000-0000-7000-8000-000000000a04', now(), now(), 'CBL', 'LARGE_TRANSACTION', 50000.0000, NULL, 'LYD',
   '{"returnCode":"LTR","batch":"BUSINESS_DAY","dueBusinessDays":1}'::jsonb,
   'provisional default, pending CBL confirmation', 'PROVISIONAL', '2026-01-01')
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Schema version 23
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 23, "updated_at" = now()
WHERE "id" = 1;
