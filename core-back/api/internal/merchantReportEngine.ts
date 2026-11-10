import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { principalOf } from "../middleware/authDoubleCheck";
import { assertMerchantAuthority, effectiveMerchantAuthorities } from "../../lib/auth/merchantAuthorities";
import {
  ReportDescriptorSpecSchema,
  validateMerchantReportScope,
  type ReportActorContext,
  type ReportDescriptorSpec,
} from "../../lib/reportEngineSdk";
import { getReportEngine } from "../../engine/reportStudio/reportEngineRuntime";
import { writeAudit } from "../../lib/audit/writeAudit";
import {
  actorIdentityOf,
  loadChromeRegistry,
  redactInputs,
  toReportExecutionError,
} from "./adminReportEngine";

/**
 * Merchant report-engine routes. The router is mounted on the merchant channel
 * WITHOUT a prefix (its paths already start with `/report-engine`), behind the
 * channel's authentication and merchant-principal guards.
 */
const router = express.Router();
export const merchantReportEngineRouter = router;

const engine = getReportEngine();
const host = engine.host;

const NULL_USER_ID = "00000000-0000-0000-0000-000000000000";

const executeBodySchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    locale: z.string().max(16).optional(),
    renderMode: z.enum(["CLIENT_PAGED_VECTOR", "SERVER_PDF"]).optional(),
  })
  .strict();

const codeParams = z.object({ code: z.string().min(1).max(64) }).strict();
const sourceParams = z.object({ sourceKey: z.string().min(1).max(64) }).strict();

const MERCHANT_SAFE_SOURCES = new Set(["applications", "currencies"]);

function merchantIdOf(request: Request): string {
  const merchantId = principalOf(request).merchantId;
  if (!merchantId) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "The principal is not bound to a merchant");
  }
  return merchantId;
}

async function actorOf(request: Request): Promise<ReportActorContext> {
  const principal = principalOf(request);
  const identity = await actorIdentityOf(request);
  return {
    userId: principal.userId ?? NULL_USER_ID,
    email: identity.email,
    role: principal.role ?? "MERCHANT_STAFF",
    authorities: [...effectiveMerchantAuthorities(principal)],
    isMaker: identity.isMaker,
    isChecker: identity.isChecker,
  };
}

type SpecRecordPolicy = {
  audienceScope: string;
  authorityMode: string;
  requiresConfidentialAml: boolean;
  overrideAllowedRoles: string[];
  overrideAllowedAuthorities: string[];
};

/**
 * The merchant counterpart of `isActorAllowedByPolicy`. Inferred policies are
 * expressed in staff roles/authorities, which a merchant never holds, so for a
 * merchant the inferred policy is "merchant-facing, safely merchant-scoped and
 * `report_engine:run`" (checked by the callers). A Security Admin override
 * restricts further: the merchant's role or one of its effective authorities
 * must be listed. Confidential AML reports are never served to merchants.
 */
export function isMerchantActorAllowed(record: SpecRecordPolicy, actor: ReportActorContext): boolean {
  if (record.audienceScope !== "MERCHANT_FACING" && record.audienceScope !== "BOTH") return false;
  if (record.requiresConfidentialAml) return false;
  if (record.authorityMode === "SECURITY_ADMIN_OVERRIDE") {
    return (
      record.overrideAllowedRoles.includes(actor.role) ||
      record.overrideAllowedAuthorities.some((authority) => actor.authorities.includes(authority))
    );
  }
  return true;
}

/**
 * What a merchant needs to render a report: inputs, sections, i18n, report and
 * page/chrome settings. The datasets keep only their id and the output column
 * aliases with their format hints; the query AST (model, joins, filters,
 * grouping, ordering, limits) never leaves core.
 */
export function merchantSafeSpec(spec: ReportDescriptorSpec): Record<string, unknown> {
  const { datasets, suggested_access: _suggestedAccess, ...rest } = spec as ReportDescriptorSpec & {
    suggested_access?: unknown;
  };
  return {
    ...rest,
    datasets: datasets.map((dataset) => ({
      dataset_id: dataset.dataset_id,
      select: dataset.select.map((field) => ({
        alias: field.alias,
        format_hint: field.format_hint,
        ...("label_i18n_key" in field && typeof (field as { label_i18n_key?: unknown }).label_i18n_key === "string"
          ? { label_i18n_key: (field as { label_i18n_key: string }).label_i18n_key }
          : {}),
      })),
      window_fields: (dataset.window_fields ?? []).map((field) => ({
        alias: field.alias,
        ...("format_hint" in field ? { format_hint: (field as { format_hint?: unknown }).format_hint } : {}),
        ...("label_i18n_key" in field ? { label_i18n_key: (field as { label_i18n_key?: unknown }).label_i18n_key } : {}),
      })),
    })),
  };
}

router.get("/report-engine/catalog", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  const page = Math.max(1, Number(request.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 20) || 20));
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const sortKey = typeof request.query.sortKey === "string" ? request.query.sortKey : "";
  const sortDirection: "asc" | "desc" = request.query.sortDirection === "asc" ? "asc" : "desc";
  const where: Prisma.ReportDefinitionSpecRecordWhereInput = {
    status: "PUBLISHED",
    isLatestPublished: true,
    audienceScope: { in: ["MERCHANT_FACING", "BOTH"] },
    requiresConfidentialAml: false,
    ...(search
      ? {
          OR: [
            { code: { contains: search, mode: "insensitive" as const } },
            { category: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.ReportDefinitionSpecRecordOrderByWithRelationInput =
    sortKey === "version"
      ? { version: sortDirection }
      : sortKey === "category"
        ? { category: sortDirection }
        : sortKey === "report"
          ? { code: sortDirection }
          : { updatedAt: sortDirection };
  const rows = await client.reportDefinitionSpecRecord.findMany({ where, orderBy });
  const allowed = [];
  for (const row of rows) {
    if (!isMerchantActorAllowed(row, actor)) continue;
    const spec = ReportDescriptorSpecSchema.parse(row.specJson);
    if (validateMerchantReportScope(spec, host).some((diagnostic) => diagnostic.severity === "error")) continue;
    allowed.push({
      id: row.id,
      code: row.code,
      version: row.version,
      category: row.category,
      audienceScope: row.audienceScope,
      supportedLocales: row.supportedLocales,
      defaultLocale: row.defaultLocale,
      spec: merchantSafeSpec(spec),
      updatedAt: row.updatedAt,
      merchantId,
    });
  }
  const total = allowed.length;
  const items = allowed.slice((page - 1) * pageSize, page * pageSize);
  response.json({ reports: items, total });
});

router.get("/report-engine/autocomplete/:sourceKey", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
  const { sourceKey } = parseOrThrow(sourceParams, request.params);
  if (!MERCHANT_SAFE_SOURCES.has(sourceKey)) {
    throw new ApiError(403, "MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED", "This autocomplete source is not available to merchants");
  }
  const provider = host.autocompleteProviders[sourceKey];
  if (!provider) throw new ApiError(404, "AUTOCOMPLETE_SOURCE_NOT_FOUND", "The autocomplete source does not exist");
  const dependentValues =
    typeof request.query.dependent === "string"
      ? (() => {
          try {
            return JSON.parse(request.query.dependent) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const items = await provider.search({
    query: String(request.query.q ?? ""),
    limit: Math.min(Number(request.query.limit ?? 20) || 20, 50),
    actor: await actorOf(request),
    // The merchant can never widen the provider's merchant filter.
    dependentValues: { ...(dependentValues ?? {}), merchantId },
  });
  response.json({ items });
});

router.post("/report-engine/catalog/:code/execute", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  const { code } = parseOrThrow(codeParams, request.params);
  const body = parseOrThrow(executeBodySchema, request.body ?? {});
  const row = await client.reportDefinitionSpecRecord.findFirst({
    where: { code, status: "PUBLISHED", isLatestPublished: true },
    orderBy: { version: "desc" },
  });
  if (!row) throw new ApiError(404, "REPORT_NOT_FOUND", "The published report does not exist");
  if (row.audienceScope !== "MERCHANT_FACING" && row.audienceScope !== "BOTH") {
    throw new ApiError(403, "REPORT_ACCESS_DENIED", "This report is not available to merchants");
  }
  if (!isMerchantActorAllowed(row, actor)) {
    throw new ApiError(403, "REPORT_ACCESS_DENIED", "You are not authorized to run this report");
  }
  const spec = ReportDescriptorSpecSchema.parse(row.specJson);
  const scopeDiagnostics = validateMerchantReportScope(spec, host);
  if (scopeDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ApiError(409, "MERCHANT_REPORT_SCOPE_INVALID", "This report is not safely scoped for a merchant", {
      diagnostics: scopeDiagnostics,
    });
  }
  const scopeKey = spec.report.merchant_scope_input_key;
  if (!scopeKey) throw new ApiError(409, "MERCHANT_SCOPE_INPUT_MISSING", "The report has no merchant scope input");
  if (body.locale && !Object.keys(spec.i18n.locales).includes(body.locale)) {
    throw new ApiError(400, "REPORT_LOCALE_NOT_SUPPORTED", `The report does not provide locale "${body.locale}"`);
  }
  if (body.renderMode === "SERVER_PDF") {
    throw new ApiError(501, "SERVER_PDF_NOT_CONFIGURED", "The optional server-side PDF renderer is not configured");
  }

  const forcedInputs = { ...body.inputs, [scopeKey]: merchantId };
  const registry = await loadChromeRegistry();
  let bundle;
  try {
    bundle = await engine.executeReport({
      spec,
      inputs: forcedInputs,
      actor,
      chromeRegistry: registry,
      chromeOverride: null,
      assetBundleId: row.assetBundleId,
      allowConfidentialAmlBypass: false,
    });
  } catch (error) {
    throw toReportExecutionError(error);
  }

  const executed = bundle;
  // The execution record and its audit row commit together.
  await client.$transaction(async (tx) => {
    await tx.reportExecutionAuditRecord.create({
      data: {
        reportSpecId: row.id,
        reportCode: row.code,
        reportVersion: row.version,
        actorUserId: actor.userId,
        actorRole: actor.role,
        selectedLocale: body.locale ?? spec.i18n.default_locale,
        scopedMerchantId: merchantId,
        inputsRedactedJson: redactInputs(executed.inputsUsed) as never,
        rowCountTotal: executed.rowCountTotal,
        durationMs: executed.durationMs,
        servedByNode: executed.servedByNode,
        verificationSha256: executed.verificationSha256,
        renderTarget: "CLIENT_PAGED_VECTOR",
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "MERCHANT_REPORT_EXECUTED",
        entityType: "REPORT_SPEC",
        entityId: row.id,
        beforeJson: null,
        afterJson: {
          code: row.code,
          version: row.version,
          merchantId,
          locale: body.locale ?? spec.i18n.default_locale,
          verificationSha256: executed.verificationSha256,
        },
      } as never,
    });
  });
  // The rendered bundle carries the spec the client renders from; the query AST is stripped.
  response.json({ ...bundle, spec: merchantSafeSpec(bundle.spec) });
});
