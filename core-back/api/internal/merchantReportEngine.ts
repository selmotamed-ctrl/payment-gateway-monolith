import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { principalOf } from "../middleware/authDoubleCheck";
import { assertMerchantAuthority, effectiveMerchantAuthorities } from "../../lib/auth/merchantAuthorities";
import {
  ReportDescriptorSpecSchema,
  ReportChromeSpecSchema,
  ReportInputValidationError,
  ReportAccessDeniedError,
  validateMerchantReportScope,
  type ReportActorContext,
  type ReportChromeRegistryEntry,
} from "../../lib/reportEngineSdk";
import { getReportEngine } from "../../engine/reportStudio/reportEngineRuntime";
import { writeAudit } from "../../lib/audit/writeAudit";

const router = express.Router();
export const merchantReportEngineRouter = router;

const engine = getReportEngine();
const host = engine.host;

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

function actorOf(request: Request): ReportActorContext {
  const principal = principalOf(request);
  return {
    userId: principal.userId ?? "00000000-0000-0000-0000-000000000000",
    email: null,
    role: principal.role ?? "MERCHANT_STAFF",
    authorities: [...effectiveMerchantAuthorities(principal)],
  };
}

function redactInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    output[key] = /secret|password|token|otp|pin|key/i.test(key) ? "[REDACTED]" : value;
  }
  return output;
}

async function chromeRegistry(): Promise<ReportChromeRegistryEntry[]> {
  const rows = await client.reportChromeSpecRecord.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [{ chromeType: "asc" }, { code: "asc" }],
  });
  return rows.map((row) => ({
    spec: ReportChromeSpecSchema.parse(row.specJson),
    isDefaultGlobal: row.isDefaultGlobal,
    status: row.status,
    assetBundleId: row.assetBundleId,
  }));
}

router.get("/report-engine/catalog", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
  const page = Math.max(1, Number(request.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 20) || 20));
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const sortKey = typeof request.query.sortKey === "string" ? request.query.sortKey : "";
  const sortDirection: "asc" | "desc" = request.query.sortDirection === "asc" ? "asc" : "desc";
  const where: Prisma.ReportDefinitionSpecRecordWhereInput = {
    status: "PUBLISHED",
    isLatestPublished: true,
    audienceScope: { in: ["MERCHANT_FACING", "BOTH"] },
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
    if (row.audienceScope !== "MERCHANT_FACING" && row.audienceScope !== "BOTH") continue;
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
      spec,
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
    limit: Math.min(Number(request.query.limit ?? 20), 50),
    actor: actorOf(request),
    dependentValues: sourceKey === "applications" ? { ...(dependentValues ?? {}), merchantId } : dependentValues,
  });
  response.json({ items });
});

router.post("/report-engine/catalog/:code/execute", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
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
  const registry = await chromeRegistry();
  let bundle;
  try {
    bundle = await engine.executeReport({
      spec,
      inputs: forcedInputs,
      actor: actorOf(request),
      chromeRegistry: registry,
      chromeOverride: null,
      assetBundleId: row.assetBundleId,
      allowConfidentialAmlBypass: false,
    });
  } catch (error) {
    if (error instanceof ReportInputValidationError) {
      throw new ApiError(400, error.code, error.message, { issues: error.zodError.issues });
    }
    if (error instanceof ReportAccessDeniedError) {
      throw new ApiError(403, error.code, error.message);
    }
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === "57014" || /statement timeout|canceling statement/i.test(String((error as Error)?.message))) {
      throw new ApiError(408, "REPORT_QUERY_TIMEOUT", "The report query exceeded its time limit");
    }
    throw error;
  }

  await client.reportExecutionAuditRecord.create({
    data: {
      reportSpecId: row.id,
      reportCode: row.code,
      reportVersion: row.version,
      actorUserId: principal.userId ?? "00000000-0000-0000-0000-000000000000",
      actorRole: principal.role ?? "MERCHANT_STAFF",
      selectedLocale: body.locale ?? spec.i18n.default_locale,
      scopedMerchantId: merchantId,
      inputsRedactedJson: redactInputs(bundle.inputsUsed) as never,
      rowCountTotal: bundle.rowCountTotal,
      durationMs: bundle.durationMs,
      servedByNode: bundle.servedByNode,
      verificationSha256: bundle.verificationSha256,
      renderTarget: "CLIENT_PAGED_VECTOR",
    },
  });
  await writeAudit(client, {
    data: {
      actorId: principal.userId ?? "00000000-0000-0000-0000-000000000000",
      role: principal.role ?? "MERCHANT_STAFF",
      action: "MERCHANT_REPORT_EXECUTED",
      entityType: "REPORT_SPEC",
      entityId: row.id,
      beforeJson: null,
      afterJson: {
        code: row.code,
        version: row.version,
        merchantId,
        locale: body.locale ?? spec.i18n.default_locale,
        verificationSha256: bundle.verificationSha256,
      },
    } as never,
  });
  response.json(bundle);
});
