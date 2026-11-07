import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, countUnlessSkipped, listResponse } from "../../lib/listQuery";
import { requireAuthorities } from "../middleware/authDoubleCheck";
import { writeAudit } from "../../lib/audit/writeAudit";
import { assertNoTippingOff, extractTemplateVariables } from "../../engine/compliance/tippingOff";
import {
  BackgroundJobState,
  BackgroundJobType,
  ConfidentialityClass,
  NotificationChannel,
  NotificationLang,
  NotificationStatus,
} from "../../generated/prisma/enums";
import {
  andWhere,
  auditActor,
  auditBase,
  booleanFilter,
  enumListFilter,
  queryString,
  queryWithout,
  reasonSchema,
  requireUuidParam,
  searchClause,
} from "./adminSliceHelpers";

/**
 * System monitors of the admin console: background jobs, the event outbox, the
 * audit outbox, notifications and notification templates. Mounted under
 * `/internal/admin` (see admin.ts).
 *
 * There is deliberately NO outbox retry: the outbox has no failure column and
 * its worker republishes unpublished rows by itself, so that tab is a monitor.
 */
const router = express.Router();

const JOB_STATES = Object.values(BackgroundJobState) as BackgroundJobState[];
const JOB_TYPES = Object.values(BackgroundJobType) as BackgroundJobType[];
const NOTIFICATION_STATUSES = Object.values(NotificationStatus) as NotificationStatus[];
const CHANNELS = Object.values(NotificationChannel) as NotificationChannel[];
const LANGS = Object.values(NotificationLang) as NotificationLang[];
const CONFIDENTIALITY_CLASSES = Object.values(ConfidentialityClass) as ConfidentialityClass[];
const LAST_ERROR_LIMIT = 1000;

// ---------------------------------------------------------------- summary

router.get("/system/jobs-outbox/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [unpublishedOutbox, oldestOutbox, auditOutboxQueued, oldestAudit, jobGroups, failedNotifications] =
    await Promise.all([
      client.outboxEvent.count({ where: { processedAt: null } }),
      client.outboxEvent.findFirst({ where: { processedAt: null }, orderBy: { id: "asc" }, select: { createdAt: true } }),
      client.auditOutbox.count({ where: { shippedAt: null } }),
      client.auditOutbox.findFirst({ where: { shippedAt: null }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      client.backgroundJob.groupBy({ by: ["state"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      client.notification.count({ where: { status: "FAILED" } }),
    ]);
  const jobCount = (state: BackgroundJobState): number =>
    jobGroups.find((group) => group.state === state)?._count._all ?? 0;
  response.json({
    unpublishedOutbox,
    oldestUnpublishedOutboxAt: oldestOutbox?.createdAt ?? null,
    auditOutboxQueued,
    oldestAuditOutboxAt: oldestAudit?.createdAt ?? null,
    jobs24h: {
      queued: jobCount("QUEUED"),
      running: jobCount("RUNNING"),
      succeeded: jobCount("SUCCEEDED"),
      failed: jobCount("FAILED"),
    },
    failedNotifications,
    ledger: await ledgerAutomationStats(),
  });
});

/**
 * Health of the ledger automation: how far the shard checkpoints lag, shards that failed their proof, and the
 * latest shard-width change. Cheap: it only reads the (small) shard and checkpoint tables.
 */
const ledgerAutomationStats = async () => {
  const [row] = (await client.$queryRawUnsafe(
    `SELECT COUNT(*) FILTER (WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0))::int AS "shardsBehind",
            COALESCE(MAX(s.line_seq - COALESCE(c.checkpoint_seq, 0)), 0)::text AS "maxPendingLines",
            MIN(c.checkpoint_at) FILTER (WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0)) AS "oldestPendingCheckpointAt",
            COUNT(*) FILTER (WHERE c.status <> 'OK')::int AS "failedShards",
            COUNT(*)::int AS shards
     FROM gl_account_shards s
     LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id`,
  )) as Array<{ shardsBehind: number; maxPendingLines: string; oldestPendingCheckpointAt: Date | null; failedShards: number; shards: number }>;
  const lastScaled = await client.glAccount.findFirst({
    where: { shardScaledAt: { not: null } },
    orderBy: { shardScaledAt: "desc" },
    select: { id: true, shardCount: true, shardScaledAt: true },
  });
  return {
    shards: row?.shards ?? 0,
    shardsBehind: row?.shardsBehind ?? 0,
    maxPendingLines: row?.maxPendingLines ?? "0",
    oldestPendingCheckpointAt: row?.oldestPendingCheckpointAt ?? null,
    failedShards: row?.failedShards ?? 0,
    lastScaling: lastScaled ? { glAccountId: lastScaled.id, shardCount: lastScaled.shardCount, at: lastScaled.shardScaledAt } : null,
  };
};

// ---------------------------------------------------------------- background jobs

const jobItem = (job: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  jobType: string;
  referenceType: string;
  referenceId: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  completedAt: Date | null;
}): Record<string, unknown> => ({
  id: job.id,
  jobType: job.jobType,
  referenceType: job.referenceType,
  referenceId: job.referenceId,
  state: job.state,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  availableAt: job.availableAt,
  lockedAt: job.lockedAt,
  lastError: job.lastError ? job.lastError.slice(0, LAST_ERROR_LIMIT) : null,
  completedAt: job.completedAt,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

/** `payloadJson` is never selected: a job payload can carry business data. */
const jobSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  jobType: true,
  referenceType: true,
  referenceId: true,
  state: true,
  attempts: true,
  maxAttempts: true,
  availableAt: true,
  lockedAt: true,
  lastError: true,
  completedAt: true,
} as const;

router.get("/system/jobs", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const query = request.query as Record<string, unknown>;
  const states = enumListFilter(query, "state", JOB_STATES);
  const types = enumListFilter(query, "jobType", JOB_TYPES);
  const built = buildListQuery(queryWithout(query, "search", "state", "jobType"), {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", state: "state", availableAt: "availableAt", attempts: "attempts" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const where = andWhere(
    built.where,
    states ? { state: { in: states } } : undefined,
    types ? { jobType: { in: types } } : undefined,
    searchClause(queryString(query, "search"), { text: ["referenceId", "referenceType"], uuid: ["id"] }),
  );
  const [jobs, total] = await Promise.all([
    client.backgroundJob.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: jobSelect,
    }),
    countUnlessSkipped(built, () => client.backgroundJob.count({ where: where as never })),
  ]);
  response.json(listResponse("jobs", jobs.map(jobItem), total, built, jobs));
});

const reasonBodySchema = z.object({ reason: reasonSchema });

router.post("/system/jobs/:id/requeue", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "BACKGROUND_JOB_NOT_FOUND", "The background job does not exist");
  const body = parseOrThrow(reasonBodySchema, request.body ?? {});
  const job = await client.$transaction(async (tx) => {
    const current = await tx.backgroundJob.findUnique({ where: { id }, select: jobSelect });
    if (!current) {
      throw new ApiError(404, "BACKGROUND_JOB_NOT_FOUND", "The background job does not exist");
    }
    // Conditional on the state: a job that moved on meanwhile is never re-queued twice.
    const moved = await tx.backgroundJob.updateMany({
      where: { id, state: "FAILED" },
      data: { state: "QUEUED", attempts: 0, availableAt: new Date(), lockedAt: null, completedAt: null },
    });
    if (moved.count === 0) {
      throw new ApiError(409, "JOB_NOT_FAILED", "Only a FAILED background job can be re-queued", {
        state: current.state,
      });
    }
    const updated = await tx.backgroundJob.findUniqueOrThrow({ where: { id }, select: jobSelect });
    await writeAudit(tx, {
      data: {
        ...auditBase(actor),
        action: "BACKGROUND_JOB_REQUEUED",
        entityType: "BACKGROUND_JOB",
        entityId: id,
        beforeJson: {
          state: current.state,
          attempts: current.attempts,
          lastError: current.lastError ? current.lastError.slice(0, LAST_ERROR_LIMIT) : null,
        },
        afterJson: { state: updated.state, attempts: updated.attempts, jobType: updated.jobType, reason: body.reason },
      } as never,
    });
    return updated;
  });
  response.json({ job: jobItem(job) });
});

// ---------------------------------------------------------------- outbox monitors

router.get("/system/outbox", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const query = request.query as Record<string, unknown>;
  const published = booleanFilter(query, "published");
  const topic = queryString(query, "topic");
  const aggregateType = queryString(query, "aggregateType");
  // The id is a BigInt: keyset cursors are not used, plain offset pages only.
  const built = buildListQuery(queryWithout(query, "search", "published", "topic", "aggregateType", "cursor"), {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", topic: "topic" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const where = andWhere(
    built.where,
    published === undefined ? undefined : { processedAt: published ? { not: null } : null },
    topic ? { topic } : undefined,
    aggregateType ? { aggregateType } : undefined,
    searchClause(queryString(query, "search"), { text: ["aggregateId", "topic"] }),
  );
  const [events, total] = await Promise.all([
    client.outboxEvent.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: { id: true, topic: true, aggregateType: true, aggregateId: true, merchantId: true, createdAt: true, processedAt: true },
    }),
    countUnlessSkipped(built, () => client.outboxEvent.count({ where: where as never })),
  ]);
  const now = Date.now();
  response.json(listResponse(
    "outbox",
    events.map((event) => ({
      id: event.id.toString(),
      topic: event.topic,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      merchantId: event.merchantId,
      createdAt: event.createdAt,
      processedAt: event.processedAt,
      published: event.processedAt !== null,
      ageSeconds: event.processedAt ? null : Math.max(0, Math.round((now - event.createdAt.getTime()) / 1000)),
    })),
    total,
    { page: built.page, pageSize: built.pageSize },
  ));
});

router.get("/system/audit-outbox", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const query = request.query as Record<string, unknown>;
  const shipped = booleanFilter(query, "shipped");
  const action = queryString(query, "action");
  const entityType = queryString(query, "entityType");
  const built = buildListQuery(queryWithout(query, "search", "shipped", "action", "entityType"), {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", action: "action" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const where = andWhere(
    built.where,
    shipped === undefined ? undefined : { shippedAt: shipped ? { not: null } : null },
    action ? { action } : undefined,
    entityType ? { entityType } : undefined,
    searchClause(queryString(query, "search"), { text: ["action", "entityId"], uuid: ["id"] }),
  );
  // before/after payloads and the actor email are never selected.
  const [rows, total] = await Promise.all([
    client.auditOutbox.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorId: true,
        role: true,
        createdAt: true,
        shippedAt: true,
        leaseUntil: true,
      },
    }),
    countUnlessSkipped(built, () => client.auditOutbox.count({ where: where as never })),
  ]);
  response.json(listResponse(
    "auditOutbox",
    rows.map((row) => ({ ...row, shipped: row.shippedAt !== null })),
    total,
    built,
    rows,
  ));
});

// ---------------------------------------------------------------- notifications

/** Neither `addressCiphertext` nor `payloadJson` (which can hold one-time codes) is ever selected. */
const notificationSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  eventId: true,
  recipientUserId: true,
  recipientMerchantId: true,
  addressMasked: true,
  templateCode: true,
  channel: true,
  lang: true,
  status: true,
  providerMessageId: true,
  attempts: true,
  nextAttemptAt: true,
} as const;

router.get("/system/notifications", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const query = request.query as Record<string, unknown>;
  const statusRaw = queryString(query, "status");
  // FAILED is the default: this tab is the failed-delivery monitor. `ALL` lifts the filter.
  const statuses = statusRaw === "ALL"
    ? undefined
    : enumListFilter(query, "status", NOTIFICATION_STATUSES) ?? (["FAILED"] as NotificationStatus[]);
  const channels = enumListFilter(query, "channel", CHANNELS);
  const langs = enumListFilter(query, "lang", LANGS);
  const templateCode = queryString(query, "templateCode");
  const built = buildListQuery(queryWithout(query, "search", "status", "channel", "lang", "templateCode"), {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", status: "status", attempts: "attempts", templateCode: "templateCode" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const where = andWhere(
    built.where,
    statuses ? { status: { in: statuses } } : undefined,
    channels ? { channel: { in: channels } } : undefined,
    langs ? { lang: { in: langs } } : undefined,
    templateCode ? { templateCode: { contains: templateCode, mode: "insensitive" } } : undefined,
    searchClause(queryString(query, "search"), {
      text: ["templateCode", "addressMasked", "eventId"],
      uuid: ["id", "recipientUserId", "recipientMerchantId"],
    }),
  );
  const [notifications, total] = await Promise.all([
    client.notification.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: notificationSelect,
    }),
    countUnlessSkipped(built, () => client.notification.count({ where: where as never })),
  ]);
  response.json(listResponse("notifications", notifications, total, built));
});

router.post("/system/notifications/:id/retry", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "NOTIFICATION_NOT_FOUND", "The notification does not exist");
  const body = parseOrThrow(reasonBodySchema, request.body ?? {});
  const notification = await client.$transaction(async (tx) => {
    const current = await tx.notification.findUnique({ where: { id }, select: notificationSelect });
    if (!current) {
      throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "The notification does not exist");
    }
    const moved = await tx.notification.updateMany({
      where: { id, status: "FAILED" },
      data: { status: "QUEUED", attempts: 0, nextAttemptAt: new Date() },
    });
    if (moved.count === 0) {
      throw new ApiError(409, "NOTIFICATION_NOT_FAILED", "Only a FAILED notification can be retried", {
        status: current.status,
      });
    }
    const updated = await tx.notification.findUniqueOrThrow({ where: { id }, select: notificationSelect });
    await writeAudit(tx, {
      data: {
        ...auditBase(actor),
        action: "NOTIFICATION_RETRY_REQUESTED",
        entityType: "NOTIFICATION",
        entityId: id,
        beforeJson: { status: current.status, attempts: current.attempts },
        afterJson: {
          status: updated.status,
          attempts: updated.attempts,
          templateCode: updated.templateCode,
          channel: updated.channel,
          recipientMerchantId: current.recipientMerchantId,
          reason: body.reason,
        },
      } as never,
    });
    return updated;
  });
  response.json({ notification });
});

// ---------------------------------------------------------------- notification templates

const templateItem = (template: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  code: string;
  channel: string;
  lang: string;
  subjectTemplate: string | null;
  bodyTemplate: string;
  confidentialityClass: string;
  version: number;
  active: boolean;
}): Record<string, unknown> => ({
  id: template.id,
  code: template.code,
  channel: template.channel,
  lang: template.lang,
  subjectTemplate: template.subjectTemplate,
  bodyTemplate: template.bodyTemplate,
  confidentialityClass: template.confidentialityClass,
  version: template.version,
  active: template.active,
  variables: [...new Set([
    ...extractTemplateVariables(template.subjectTemplate ?? ""),
    ...extractTemplateVariables(template.bodyTemplate),
  ])],
  createdAt: template.createdAt,
  updatedAt: template.updatedAt,
});

router.get("/settings/notification-templates", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const query = request.query as Record<string, unknown>;
  const history = booleanFilter(query, "history") === true;
  const channels = enumListFilter(query, "channel", CHANNELS);
  const langs = enumListFilter(query, "lang", LANGS);
  const active = booleanFilter(query, "active");
  const code = queryString(query, "code");
  const built = buildListQuery(queryWithout(query, "search", "history", "channel", "lang", "active", "code"), {
    sortable: { code: "code", channel: "channel", lang: "lang", version: "version", updatedAt: "updatedAt" },
    defaultSort: [{ code: "asc" }, { channel: "asc" }, { lang: "asc" }, { version: "desc" }],
    defaultPageSize: 50,
  });
  const where = andWhere(
    built.where,
    // Latest active versions only, unless the history is requested.
    history ? (active === undefined ? undefined : { active }) : { active: true },
    channels ? { channel: { in: channels } } : undefined,
    langs ? { lang: { in: langs } } : undefined,
    code ? { code: { contains: code, mode: "insensitive" } } : undefined,
    searchClause(queryString(query, "search"), { text: ["code", "subjectTemplate", "bodyTemplate"], uuid: ["id"] }),
  );
  const [templates, total] = await Promise.all([
    client.notificationTemplate.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
    }),
    countUnlessSkipped(built, () => client.notificationTemplate.count({ where: where as never })),
  ]);
  response.json(listResponse("templates", templates.map(templateItem), total, { page: built.page, pageSize: built.pageSize }));
});

const templateUpdateSchema = z.object({
  subjectTemplate: z.string().max(2000).nullable().optional(),
  bodyTemplate: z.string().trim().min(1).max(10_000),
  confidentialityClass: z.enum(CONFIDENTIALITY_CLASSES as [ConfidentialityClass, ...ConfidentialityClass[]]).optional(),
});

router.put("/settings/notification-templates/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "NOTIFICATION_TEMPLATE_NOT_FOUND", "The notification template does not exist");
  const body = parseOrThrow(templateUpdateSchema, request.body ?? {});
  try {
    const result = await client.$transaction(async (tx) => {
      // Serialise concurrent edits of the same template row.
      await tx.$queryRawUnsafe("SELECT id FROM notification_templates WHERE id = $1::uuid FOR UPDATE", id);
      const current = await tx.notificationTemplate.findUnique({ where: { id } });
      if (!current) {
        throw new ApiError(404, "NOTIFICATION_TEMPLATE_NOT_FOUND", "The notification template does not exist");
      }
      if (!current.active) {
        throw new ApiError(409, "TEMPLATE_VERSION_NOT_ACTIVE", "Only the active version of a template can be edited", {
          version: current.version,
        });
      }
      const nextSubject = body.subjectTemplate === undefined ? current.subjectTemplate : body.subjectTemplate;
      const nextClass = body.confidentialityClass ?? current.confidentialityClass;
      if (
        nextSubject === current.subjectTemplate
        && body.bodyTemplate === current.bodyTemplate
        && nextClass === current.confidentialityClass
      ) {
        throw new ApiError(409, "TEMPLATE_UNCHANGED", "The template content is identical to the active version");
      }

      // Only placeholders the same template code already uses (any language,
      // channel or version) are accepted; a typo must not ship as an empty string.
      const siblings = await tx.notificationTemplate.findMany({
        where: { code: current.code },
        select: { subjectTemplate: true, bodyTemplate: true },
      });
      const allowed = new Set<string>();
      for (const sibling of siblings) {
        for (const name of extractTemplateVariables(sibling.subjectTemplate ?? "")) allowed.add(name);
        for (const name of extractTemplateVariables(sibling.bodyTemplate)) allowed.add(name);
      }
      const used = new Set([
        ...extractTemplateVariables(nextSubject ?? ""),
        ...extractTemplateVariables(body.bodyTemplate),
      ]);
      const unknown = [...used].filter((name) => !allowed.has(name)).sort();
      if (unknown.length > 0) {
        throw new ApiError(422, "TEMPLATE_UNKNOWN_PLACEHOLDERS", "The template uses placeholders that are not known for this code", {
          unknown,
          allowed: [...allowed].sort(),
        });
      }
      assertNoTippingOff({
        code: current.code,
        subjectTemplate: nextSubject,
        bodyTemplate: body.bodyTemplate,
        confidentialityClass: nextClass,
      });

      const latest = await tx.notificationTemplate.aggregate({
        where: { code: current.code, channel: current.channel, lang: current.lang },
        _max: { version: true },
      });
      await tx.notificationTemplate.update({ where: { id }, data: { active: false } });
      const created = await tx.notificationTemplate.create({
        data: {
          code: current.code,
          channel: current.channel,
          lang: current.lang,
          subjectTemplate: nextSubject,
          bodyTemplate: body.bodyTemplate,
          confidentialityClass: nextClass,
          version: (latest._max.version ?? current.version) + 1,
          active: true,
        },
      });
      await writeAudit(tx, {
        data: {
          ...auditBase(actor),
          action: "NOTIFICATION_TEMPLATE_VERSIONED",
          entityType: "NOTIFICATION_TEMPLATE",
          entityId: created.id,
          beforeJson: {
            id: current.id,
            version: current.version,
            subjectTemplate: current.subjectTemplate,
            bodyTemplate: current.bodyTemplate,
            confidentialityClass: current.confidentialityClass,
          },
          afterJson: {
            id: created.id,
            code: created.code,
            channel: created.channel,
            lang: created.lang,
            version: created.version,
            subjectTemplate: created.subjectTemplate,
            bodyTemplate: created.bodyTemplate,
            confidentialityClass: created.confidentialityClass,
          },
        } as never,
      });
      return { created, previous: { ...current, active: false } };
    });
    response.json({ template: templateItem(result.created), previous: templateItem(result.previous) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "TEMPLATE_VERSION_CONFLICT", "The template was edited concurrently; reload and retry");
    }
    throw error;
  }
});

export const adminSystemRouter = router;
