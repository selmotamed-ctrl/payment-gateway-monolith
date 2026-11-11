-- Incident management (expanded): lifecycle, timeline, responders, actions, links and communications.
ALTER TYPE "ReportingType" ADD VALUE IF NOT EXISTS 'INCIDENT';

CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');
CREATE TYPE "IncidentStatus" AS ENUM ('DETECTED', 'TRIAGED', 'DECLARED', 'CONTAINED', 'MONITORING', 'RESOLVED', 'POSTMORTEM', 'CLOSED');
CREATE TYPE "IncidentCategory" AS ENUM ('AVAILABILITY', 'DATA_INTEGRITY', 'SECURITY', 'FRAUD', 'COMPLIANCE', 'THIRD_PARTY', 'PAYMENT_PROCESSING', 'OTHER');
CREATE TYPE "IncidentImpactScope" AS ENUM ('PLATFORM', 'MERCHANT', 'CHECKOUT', 'ADMIN', 'MULTI_TENANT');
CREATE TYPE "IncidentTimelineType" AS ENUM ('DETECTED', 'DECLARED', 'STATUS_CHANGE', 'NOTE', 'ESCALATION', 'COMMUNICATION', 'ACTION', 'REGULATORY');
CREATE TYPE "IncidentActionStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');
CREATE TYPE "IncidentCommunicationChannel" AS ENUM ('STATUS_PAGE', 'EMAIL', 'SMS', 'REGULATOR', 'INTERNAL');
CREATE TYPE "IncidentLinkType" AS ENUM ('ATTEMPT', 'MERCHANT', 'RAIL', 'GATEWAY', 'REPORT', 'CASE', 'OTHER');

CREATE TABLE "incidents" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "reference" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "category" "IncidentCategory" NOT NULL DEFAULT 'OTHER',
  "severity" "IncidentSeverity" NOT NULL DEFAULT 'SEV3',
  "status" "IncidentStatus" NOT NULL DEFAULT 'DETECTED',
  "impact_scope" "IncidentImpactScope" NOT NULL DEFAULT 'PLATFORM',
  "detected_at" TIMESTAMP(3) NOT NULL,
  "declared_at" TIMESTAMP(3),
  "contained_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "commander_user_id" UUID,
  "reporter_user_id" UUID,
  "affected_services" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "affected_merchant_ids" UUID[] DEFAULT ARRAY[]::UUID[],
  "affected_attempt_ids" UUID[] DEFAULT ARRAY[]::UUID[],
  "regulators_notified" BOOLEAN NOT NULL DEFAULT false,
  "regulatory_report_id" UUID,
  "postmortem_required" BOOLEAN NOT NULL DEFAULT false,
  "postmortem_due_at" TIMESTAMP(3),
  "root_cause" TEXT,
  "postmortem_summary" TEXT,
  "postmortem_json" JSONB,
  "closed_by_user_id" UUID,
  CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "incident_timeline_entries" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "incident_id" UUID NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "type" "IncidentTimelineType" NOT NULL,
  "actor_user_id" UUID,
  "actor_name" TEXT,
  "summary" TEXT NOT NULL,
  "detail_json" JSONB,
  CONSTRAINT "incident_timeline_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "incident_responders" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "incident_id" UUID NOT NULL,
  "user_id" UUID,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "is_commander" BOOLEAN NOT NULL DEFAULT false,
  "paged_at" TIMESTAMP(3),
  "acknowledged_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  CONSTRAINT "incident_responders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "incident_action_items" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "incident_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "owner_user_id" UUID,
  "priority" INTEGER NOT NULL DEFAULT 3,
  "status" "IncidentActionStatus" NOT NULL DEFAULT 'OPEN',
  "due_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "incident_action_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "incident_links" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "incident_id" UUID NOT NULL,
  "link_type" "IncidentLinkType" NOT NULL,
  "target_id" TEXT NOT NULL,
  "label" TEXT,
  CONSTRAINT "incident_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "incident_communications" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "incident_id" UUID NOT NULL,
  "channel" "IncidentCommunicationChannel" NOT NULL,
  "audience" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3),
  "sent_by_user_id" UUID,
  "external_ref" TEXT,
  CONSTRAINT "incident_communications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incidents_reference_key" ON "incidents"("reference");
CREATE INDEX "incidents_status_severity_idx" ON "incidents"("status", "severity");
CREATE INDEX "incidents_category_detected_at_idx" ON "incidents"("category", "detected_at");
CREATE INDEX "incidents_detected_at_idx" ON "incidents"("detected_at");
CREATE INDEX "incident_timeline_entries_incident_id_occurred_at_idx" ON "incident_timeline_entries"("incident_id", "occurred_at");
CREATE INDEX "incident_responders_incident_id_released_at_idx" ON "incident_responders"("incident_id", "released_at");
CREATE INDEX "incident_action_items_incident_id_status_idx" ON "incident_action_items"("incident_id", "status");
CREATE INDEX "incident_action_items_owner_user_id_status_due_at_idx" ON "incident_action_items"("owner_user_id", "status", "due_at");
CREATE INDEX "incident_links_incident_id_link_type_idx" ON "incident_links"("incident_id", "link_type");
CREATE INDEX "incident_communications_incident_id_created_at_idx" ON "incident_communications"("incident_id", "created_at");

ALTER TABLE "incident_timeline_entries" ADD CONSTRAINT "incident_timeline_entries_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_responders" ADD CONSTRAINT "incident_responders_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_action_items" ADD CONSTRAINT "incident_action_items_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_links" ADD CONSTRAINT "incident_links_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_communications" ADD CONSTRAINT "incident_communications_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "schema_versions" SET "version" = 30;
