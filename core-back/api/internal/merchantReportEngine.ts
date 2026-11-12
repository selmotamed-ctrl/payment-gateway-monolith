import { createHash, randomUUID } from "node:crypto";
import { specContentSha256 } from "../../lib/reportEngineSdk/specHash";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { principalOf } from "../middleware/authDoubleCheck";
import { assertMerchantAuthority, effectiveMerchantAuthorities } from "../../lib/auth/merchantAuthorities";
import { writeAudit } from "../../lib/audit/writeAudit";
import {
  ReportDescriptorSpecSchema,
  ReportMerchantScopeViolationError,
  extractZipAssetFiles,
  validateMerchantReportScope,
  type ReportActorContext,
  type ReportDescriptorSpec,
  type ReportExecutionBundle,
} from "../../lib/reportEngineSdk";
import { openKeyedOperatorCase } from "../../engine/workers/automationCases";
import {
  MERCHANT_TIER_LIMITS,
  MerchantReportGuardError,
  acquireMerchantExecutionSlot,
  assertMerchantBudget,
  assertMerchantEngineAvailable,
  assertMerchantQuota,
  assertMerchantRateLimit,
  buildMerchantTranscript,
  getMerchantReportEngine,
  merchantCacheKey,
  readMerchantCache,
  readMerchantReportPolicy,
  validateMerchantTierLimits,
  writeMerchantCache,
} from "../../engine/reportStudio/merchantReportEngine";
import {
  actorIdentityOf,
  loadChromeRegistry,
  redactInputs,
  toReportExecutionError,
} from "./adminReportEngine";

/**
 * The applications a merchant SESSION user is restricted to (`app_scope_ids`), or undefined for an unrestricted user.
 * API tokens are bound to one application by the token itself.
 */
const applicationScopeOf = (request: Request): readonly string[] | undefined => {
  const principal = principalOf(request);
  if (principal.kind !== "session") return undefined;
  const ids = principal.appScopeIds ?? [];
  return ids.length > 0 ? ids : undefined;
};

/**
 * A restricted user may only report on models whose rows belong to ONE application (payment_attempts); the engine
 * narrows them to the user's applications. Wallets, cash-outs and the daily stats are merchant-wide and cannot be
 * narrowed, so a report on them is refused, as the merchant overview is (APP_SCOPE_RESTRICTED). Before, the report
 * engine ignored the restriction altogether and returned every application's rows.
 */
const assertSpecFitsApplicationScope = (spec: ReportDescriptorSpec, applicationIds: readonly string[] | undefined): void => {
  if (!applicationIds) return;
  const unsupported = [...new Set(spec.datasets.flatMap((dataset) => [dataset.from_model, ...dataset.joins.map((join) => join.target_model)]))]
    .filter((model) => !host.models[model]?.merchantScopable?.applicationIdColumn);
  if (unsupported.length > 0) {
    throw new ApiError(
      403,
      "APP_SCOPE_RESTRICTED",
      "This report reads merchant-wide data and is not available to a user restricted to specific applications",
      { models: unsupported },
    );
  }
};

/**
 * Merchant report engine: a SEPARATE authoring/execution line. It reads and
 * writes only merchant-owned registry rows and executes on the merchant host
 * catalog, where the engine injects the authenticated merchant predicate on
 * every dataset alias and asserts every returned row (E04).
 */
const router = express.Router();

export const merchantReportEngineRouter = router;

const engine = getMerchantReportEngine();
const host = engine.host;

const NULL_USER_ID = "00000000-0000-0000-0000-000000000000";

const executeBodySchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    locale: z.string().max(16).optional(),
    renderMode: z.enum(["CLIENT_PAGED_VECTOR", "SERVER_PDF"]).optional(),
  })
  .strict();

const studioVerifySchema = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
  })
  .strict();

const studioSaveSchema = studioVerifySchema
  .extend({ publish: z.boolean().optional() })
  .strict();

const cloneSchema = z.object({ code: z.string().min(1).max(64).optional() }).strict();

const codeParams = z.object({ code: z.string().min(1).max(64) }).strict();
const sourceParams = z.object({ sourceKey: z.string().min(1).max(64) }).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();

const MERCHANT_SAFE_SOURCES = new Set(["applications", "currencies", "payment_links", "pos_terminals"]);

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

const mimeFor = (fileName: string): string => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
};

/** The spec's content hash, reproducible from the stored `spec_json` (see `specContentSha256`). */
const sha256 = (value: unknown): string => specContentSha256(value);

async function extractMerchantZip(base64: string | undefined): Promise<{
  filesByName: Map<string, Buffer>;
  zipBytes: number;
}> {
  if (!base64) return { filesByName: new Map(), zipBytes: 0 };
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > MERCHANT_TIER_LIMITS.maxZipBytes) {
    throw new MerchantReportGuardError(
      "MERCHANT_ASSET_ZIP_TOO_LARGE",
      `The asset bundle exceeds ${MERCHANT_TIER_LIMITS.maxZipBytes} bytes`,
      400,
    );
  }
  const extraction = await extractZipAssetFiles({
    zipBuffer: buffer,
    maxZipBytes: MERCHANT_TIER_LIMITS.maxZipBytes,
    maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
  });
  if (extraction.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ApiError(400, "REPORT_ASSET_BUNDLE_INVALID", "The asset archive is invalid", {
      diagnostics: extraction.diagnostics,
    });
  }
  return { filesByName: extraction.filesByName, zipBytes: buffer.byteLength };
}

async function storeMerchantAssets(params: {
  merchantId: string;
  userId: string;
  spec: ReportDescriptorSpec;
  filesByName: Map<string, Buffer>;
}): Promise<string | null> {
  if (params.spec.required_assets.length === 0) return null;
  const requiredByFile = new Map(params.spec.required_assets.map((asset) => [asset.file_name.toLowerCase(), asset]));
  const files = [...params.filesByName.entries()].map(([relativePath, buffer]) => {
    const required = requiredByFile.get(relativePath.toLowerCase());
    return {
      relativePath: required?.file_name ?? relativePath,
      buffer,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      mimeType: required?.mime_type ?? mimeFor(relativePath),
    };
  });
  if (files.length === 0) return null;
  const bundleSha256 = createHash("sha256")
    .update(Buffer.concat(files.map((file) => file.buffer)))
    .digest("hex");
  const existing = await client.merchantReportAssetBundle.findUnique({
    where: { merchantId_bundleSha256: { merchantId: params.merchantId, bundleSha256 } },
  });
  if (existing) return existing.id;
  const bundleId = randomUUID();
  const storage = await host.assetStoragePort.storeAssetBundle({ bundleId, files });
  const row = await client.merchantReportAssetBundle.upsert({
    where: { merchantId_bundleSha256: { merchantId: params.merchantId, bundleSha256 } },
    create: {
      id: bundleId,
      merchantId: params.merchantId,
      bundleSha256,
      storageKey: storage.bundleStorageKey,
      totalBytes: files.reduce((sum, file) => sum + file.buffer.byteLength, 0),
      fileCount: files.length,
      manifestJson: files.map((file) => ({
        fileName: file.relativePath,
        mimeType: file.mimeType,
        sha256: file.sha256,
        bytes: file.buffer.byteLength,
      })) as never,
      uploadedByUserId: params.userId,
    },
    update: {},
  });
  return row.id;
}

async function storedMerchantFiles(
  merchantId: string,
  assetBundleId: string | null,
  required: Array<{ file_name: string }>,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!assetBundleId) return files;
  const bundle = await client.merchantReportAssetBundle.findFirst({
    where: { id: assetBundleId, merchantId },
  });
  if (!bundle) return files;
  for (const asset of required) {
    const stored = await host.assetStoragePort.getAssetBuffer({
      bundleId: assetBundleId,
      relativePath: asset.file_name,
    });
    if (stored) files.set(asset.file_name, stored.buffer);
  }
  return files;
}

async function verifyMerchantSpec(params: {
  rawSpecJson: string;
  filesByName: Map<string, Buffer>;
  specBytes: number;
  zipBytes: number;
  assetsEnabled: boolean;
}) {
  const verification = await engine.verifyDescriptor({
    rawSpecJson: params.rawSpecJson,
    extractedZipFiles: params.filesByName,
  });
  let spec: ReportDescriptorSpec | null = null;
  try {
    spec = ReportDescriptorSpecSchema.parse(JSON.parse(params.rawSpecJson));
  } catch {
    spec = null;
  }
  const tierDiagnostics = spec
    ? validateMerchantTierLimits(spec, { specBytes: params.specBytes, zipBytes: params.zipBytes })
    : [];
  const policyDiagnostics: typeof verification.diagnostics = [];
  if (spec && spec.report.audience_scope !== "MERCHANT_FACING" && spec.report.audience_scope !== "BOTH") {
    policyDiagnostics.push({
      layer: 1,
      severity: "error",
      path: "report.audience_scope",
      code: "MERCHANT_REPORT_AUDIENCE_INVALID",
      message: "A merchant-authored report must use audience_scope MERCHANT_FACING (or BOTH).",
      aiFixHint: 'Set report.audience_scope to "MERCHANT_FACING".',
    });
  }
  if (!params.assetsEnabled && spec && (spec.required_assets.length > 0 || params.filesByName.size > 0)) {
    policyDiagnostics.push({
      layer: 1,
      severity: "error",
      path: "required_assets",
      code: "MERCHANT_REPORT_ASSETS_DISABLED",
      message: "Merchant report asset bundles are disabled by platform policy.",
      aiFixHint: "Remove required_assets and do not upload an asset bundle; the platform policy currently rejects them.",
    });
  }
  const diagnostics = [...verification.diagnostics, ...tierDiagnostics, ...policyDiagnostics];
  return {
    ...verification,
    diagnostics,
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
  };
}

/** Merchant-safe spec shape for the catalog/preview response (no query AST). */
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

function toGuardError(error: unknown): unknown {
  if (error instanceof MerchantReportGuardError) {
    return new ApiError(error.status, error.code, error.message);
  }
  return toReportExecutionError(error);
}

/* ------------------------------------------------------------------------ */
/* Catalog (templates + the merchant's own published reports)                */
/* ------------------------------------------------------------------------ */

router.get("/report-engine/catalog", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
  const policy = await assertMerchantEngineAvailable(merchantId);
  const actor = await actorOf(request);
  const page = Math.max(1, Number(request.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 20) || 20));
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const sortKey = typeof request.query.sortKey === "string" ? request.query.sortKey : "";
  const sortDirection: "asc" | "desc" = request.query.sortDirection === "asc" ? "asc" : "desc";

  const rows = await client.reportDefinitionSpecRecord.findMany({
    where: {
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
    },
    orderBy: sortKey === "version" ? { version: sortDirection } : sortKey === "category" ? { category: sortDirection } : sortKey === "report" ? { code: sortDirection } : { updatedAt: sortDirection },
  });
  const own = await client.merchantReportSpecRecord.findMany({
    where: {
      merchantId,
      status: "PUBLISHED",
      isLatestPublished: true,
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: "insensitive" as const } },
              { category: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
  });

  const merchantRoleAllowed = (record: {
    authorityMode: string;
    overrideAllowedRoles: string[];
    overrideAllowedAuthorities: string[];
  }): boolean => {
    if (record.authorityMode !== "SECURITY_ADMIN_OVERRIDE") return true;
    return (
      record.overrideAllowedRoles.includes(actor.role) ||
      record.overrideAllowedAuthorities.some((authority) => actor.authorities.includes(authority))
    );
  };

  const templates = [];
  for (const row of rows) {
    if (!merchantRoleAllowed(row as never)) continue;
    const spec = ReportDescriptorSpecSchema.parse(row.specJson);
    if (!policy.assetsEnabled && spec.required_assets.length > 0) continue;
    if (validateMerchantReportScope(spec, host).some((diagnostic) => diagnostic.severity === "error")) continue;
    if (validateMerchantTierLimits(spec, { specBytes: Buffer.byteLength(JSON.stringify(row.specJson)) }).some((diagnostic) => diagnostic.severity === "error")) continue;
    templates.push({
      id: row.id,
      code: row.code,
      version: row.version,
      category: row.category,
      audienceScope: row.audienceScope,
      supportedLocales: row.supportedLocales,
      defaultLocale: row.defaultLocale,
      spec: merchantSafeSpec(spec),
      updatedAt: row.updatedAt,
      source: "TEMPLATE" as const,
      merchantId,
    });
  }
  const ownRows = own
    .filter((row) => {
      try {
        const spec = ReportDescriptorSpecSchema.parse(row.specJson);
        if (!policy.assetsEnabled && spec.required_assets.length > 0) return false;
        return !validateMerchantTierLimits(spec, {
          specBytes: Buffer.byteLength(JSON.stringify(row.specJson)),
        }).some((diagnostic) => diagnostic.severity === "error");
      } catch {
        return false;
      }
    })
    .map((row) => ({
      id: row.id,
      code: row.code,
      version: row.version,
      category: row.category,
      audienceScope: "MERCHANT_FACING",
      supportedLocales: row.supportedLocales,
      defaultLocale: row.defaultLocale,
      spec: merchantSafeSpec(ReportDescriptorSpecSchema.parse(row.specJson)),
      updatedAt: row.updatedAt,
      source: "OWN" as const,
      merchantId,
    }));
  const merged = [...ownRows, ...templates].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const total = merged.length;
  response.json({ reports: merged.slice((page - 1) * pageSize, page * pageSize), total });
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
    dependentValues: { ...(dependentValues ?? {}), merchantId },
  });
  response.json({ items });
});

/* ------------------------------------------------------------------------ */
/* Studio: transcript, verify, save, publish, archive, versions, usage       */
/* ------------------------------------------------------------------------ */

router.get("/report-engine/studio/transcript", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const policy = await assertMerchantEngineAvailable(merchantIdOf(request));
  const transcript = buildMerchantTranscript({ merchantAssetsEnabled: policy.assetsEnabled });
  response.json({
    filename: transcript.filename,
    contentType: transcript.contentType,
    markdown: transcript.markdown,
    specVersion: transcript.specVersion,
  });
});

router.post("/report-engine/studio/verify", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const policy = await assertMerchantEngineAvailable(merchantId);
  await assertMerchantRateLimit(merchantId, "verify");
  const body = parseOrThrow(studioVerifySchema, request.body ?? {});
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(body.specJson);
  const zip = await extractMerchantZip(body.assetsZipBase64);
  const verification = await verifyMerchantSpec({
    rawSpecJson,
    filesByName: zip.filesByName,
    specBytes: Buffer.byteLength(rawSpecJson),
    zipBytes: zip.zipBytes,
    assetsEnabled: policy.assetsEnabled,
  });
  response.json(verification);
});

router.post("/report-engine/studio/specs", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  const policy = await assertMerchantEngineAvailable(merchantId);
  await assertMerchantRateLimit(merchantId, "verify");
  const body = parseOrThrow(studioSaveSchema, request.body ?? {});
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(body.specJson);
  const zip = await extractMerchantZip(body.assetsZipBase64);
  const verification = await verifyMerchantSpec({
    rawSpecJson,
    filesByName: zip.filesByName,
    specBytes: Buffer.byteLength(rawSpecJson),
    zipBytes: zip.zipBytes,
    assetsEnabled: policy.assetsEnabled,
  });
  if (!verification.valid) {
    throw new ApiError(400, "REPORT_SPEC_VERIFICATION_FAILED", "The report spec failed verification", { verification });
  }
  const spec = ReportDescriptorSpecSchema.parse(JSON.parse(rawSpecJson));
  await assertMerchantQuota(merchantId, spec.report.code);
  const assetBundleId = await storeMerchantAssets({
    merchantId,
    userId: actor.userId,
    spec,
    filesByName: zip.filesByName,
  });
  const publish = Boolean(body.publish);
  let created;
  try {
    created = await client.$transaction(async (tx) => {
      const previous = await tx.merchantReportSpecRecord.findFirst({
        where: { merchantId, code: spec.report.code },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = Math.max(spec.report.version, (previous?.version ?? 0) + 1);
      const persistedSpec = { ...spec, report: { ...spec.report, version } };
      const specSha256 = sha256(persistedSpec);
      if (publish) {
        await tx.merchantReportSpecRecord.updateMany({
          where: { merchantId, code: spec.report.code, isLatestPublished: true },
          data: { isLatestPublished: false },
        });
      }
      const row = await tx.merchantReportSpecRecord.create({
        data: {
          merchantId,
          code: spec.report.code,
          version,
          category: spec.report.category,
          status: publish ? "PUBLISHED" : "VERIFIED",
          isLatestPublished: publish,
          supportedLocales: Object.keys(spec.i18n.locales),
          defaultLocale: spec.i18n.default_locale,
          specJson: persistedSpec as never,
          specSha256,
          verificationReportJson: verification as never,
          assetBundleId,
          createdByUserId: actor.userId,
          publishedByUserId: publish ? actor.userId : null,
          publishedAt: publish ? new Date() : null,
        },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role,
          action: publish ? "MERCHANT_REPORT_PUBLISHED" : "MERCHANT_REPORT_VERIFIED",
          entityType: "MERCHANT_REPORT_SPEC",
          entityId: row.id,
          beforeJson: null,
          afterJson: { merchantId, code: row.code, version: row.version, status: row.status, specSha256 },
        } as never,
      });
      return row;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      throw new ApiError(409, "MERCHANT_REPORT_SPEC_CONFLICT", "Another version was saved at the same time; retry");
    }
    throw error;
  }
  response.status(201).json({
    id: created.id,
    code: created.code,
    version: created.version,
    status: created.status,
    verification,
  });
});

router.get("/report-engine/studio/specs", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const rows = await client.merchantReportSpecRecord.findMany({
    where: { merchantId, ...(typeof request.query.code === "string" ? { code: request.query.code } : {}) },
    orderBy: [{ code: "asc" }, { version: "desc" }],
  });
  response.json({
    specs: rows.map((row) => ({
      id: row.id,
      code: row.code,
      version: row.version,
      category: row.category,
      status: row.status,
      isLatestPublished: row.isLatestPublished,
      supportedLocales: row.supportedLocales,
      defaultLocale: row.defaultLocale,
      assetBundleId: row.assetBundleId,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt,
    })),
  });
});

router.get("/report-engine/studio/specs/:id", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idParams, request.params);
  const row = await client.merchantReportSpecRecord.findFirst({ where: { id, merchantId } });
  if (!row) throw new ApiError(404, "MERCHANT_REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  response.json({
    id: row.id,
    code: row.code,
    version: row.version,
    status: row.status,
    isLatestPublished: row.isLatestPublished,
    spec: row.specJson,
    verification: row.verificationReportJson,
    assetBundleId: row.assetBundleId,
  });
});

router.post("/report-engine/studio/specs/:id/publish", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  const policy = await assertMerchantEngineAvailable(merchantId);
  const { id } = parseOrThrow(idParams, request.params);
  const existing = await client.merchantReportSpecRecord.findFirst({ where: { id, merchantId } });
  if (!existing) throw new ApiError(404, "MERCHANT_REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  if (existing.status !== "VERIFIED") {
    throw new ApiError(409, "MERCHANT_REPORT_SPEC_NOT_VERIFIED", "Only a verified version can be published", {
      status: existing.status,
    });
  }
  const spec = ReportDescriptorSpecSchema.parse(existing.specJson);
  const verification = await verifyMerchantSpec({
    rawSpecJson: JSON.stringify(existing.specJson),
    filesByName: await storedMerchantFiles(merchantId, existing.assetBundleId, spec.required_assets),
    specBytes: Buffer.byteLength(JSON.stringify(existing.specJson)),
    zipBytes: 0,
    assetsEnabled: policy.assetsEnabled,
  });
  if (!verification.valid) {
    throw new ApiError(400, "REPORT_SPEC_VERIFICATION_FAILED", "The report spec no longer passes verification", {
      verification,
    });
  }
  let published: { id: string; code: string; version: number; status: "PUBLISHED" };
  try {
  published = await client.$transaction(async (tx) => {
    const newer = await tx.merchantReportSpecRecord.findFirst({
      where: { merchantId, code: existing.code, status: "PUBLISHED", version: { gt: existing.version } },
      select: { version: true },
    });
    if (newer) {
      throw new ApiError(
        409,
        "MERCHANT_REPORT_NEWER_VERSION_PUBLISHED",
        "A newer version of this report is already published",
        { publishedVersion: newer.version },
      );
    }
    await tx.merchantReportSpecRecord.updateMany({
      where: { merchantId, code: existing.code, isLatestPublished: true, id: { not: id } },
      data: { isLatestPublished: false },
    });
    const claimed = await tx.merchantReportSpecRecord.updateMany({
      where: { id, merchantId, status: "VERIFIED" },
      data: {
        status: "PUBLISHED",
        isLatestPublished: true,
        publishedByUserId: actor.userId,
        publishedAt: new Date(),
        verificationReportJson: verification as never,
      },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "MERCHANT_REPORT_SPEC_NOT_VERIFIED", "Only a verified version can be published");
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "MERCHANT_REPORT_PUBLISHED",
        entityType: "MERCHANT_REPORT_SPEC",
        entityId: id,
        beforeJson: { status: existing.status, isLatestPublished: existing.isLatestPublished },
        afterJson: { status: "PUBLISHED", isLatestPublished: true, merchantId },
      } as never,
    });
    return { id, code: existing.code, version: existing.version, status: "PUBLISHED" as const };
  });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      throw new ApiError(409, "MERCHANT_REPORT_PUBLISH_CONFLICT", "Another version was published at the same time; retry");
    }
    throw error;
  }
  response.json({ ...published, verification });
});

router.post("/report-engine/studio/specs/:id/archive", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  await assertMerchantEngineAvailable(merchantId);
  const { id } = parseOrThrow(idParams, request.params);
  const existing = await client.merchantReportSpecRecord.findFirst({ where: { id, merchantId } });
  if (!existing) throw new ApiError(404, "MERCHANT_REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  if (existing.status === "ARCHIVED") {
    response.json({ id, status: "ARCHIVED", isLatestPublished: false, promotedSpecId: null });
    return;
  }
  const result = await client.$transaction(async (tx) => {
    const updated = await tx.merchantReportSpecRecord.update({
      where: { id },
      data: { status: "ARCHIVED", isLatestPublished: false },
    });
    let promoted: { id: string } | null = null;
    if (existing.isLatestPublished) {
      promoted = await tx.merchantReportSpecRecord.findFirst({
        where: { merchantId, code: existing.code, status: "PUBLISHED", id: { not: id } },
        orderBy: { version: "desc" },
        select: { id: true },
      });
      if (promoted) {
        await tx.merchantReportSpecRecord.update({ where: { id: promoted.id }, data: { isLatestPublished: true } });
      }
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "MERCHANT_REPORT_ARCHIVED",
        entityType: "MERCHANT_REPORT_SPEC",
        entityId: id,
        beforeJson: { status: existing.status, isLatestPublished: existing.isLatestPublished },
        afterJson: { status: "ARCHIVED", promotedSpecId: promoted?.id ?? null, merchantId },
      } as never,
    });
    return { updated, promoted };
  });
  response.json({
    id: result.updated.id,
    status: result.updated.status,
    isLatestPublished: result.updated.isLatestPublished,
    promotedSpecId: result.promoted?.id ?? null,
  });
});

router.get("/report-engine/studio/usage", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const policy = await readMerchantReportPolicy();
  const [codes, runsToday, dbTime, executesLastHour, verifiesLastHour, suspension] = await Promise.all([
    client.merchantReportSpecRecord.groupBy({ by: ["code"], where: { merchantId } }),
    client.merchantReportExecutionAudit.count({ where: { merchantId, createdAt: { gte: startOfDay } } }),
    client.merchantReportExecutionAudit.aggregate({
      where: { merchantId, createdAt: { gte: startOfDay } },
      _sum: { durationMs: true },
    }),
    client.merchantReportRateEvent.count({ where: { merchantId, action: "execute", createdAt: { gte: hourAgo } } }),
    client.merchantReportRateEvent.count({ where: { merchantId, action: "verify", createdAt: { gte: hourAgo } } }),
    client.merchantReportStudioStatus.findUnique({ where: { merchantId } }),
  ]);
  response.json({
    codes: codes.length,
    maxCodes: MERCHANT_TIER_LIMITS.maxCodes,
    runsToday,
    dbTimeTodayMs: dbTime._sum.durationMs ?? 0,
    maxDailyDbTimeMs: (await import("../../lib/env")).env.MERCHANT_REPORT_DAILY_DB_TIME_MS,
    executesLastHour,
    verifiesLastHour,
    maxExecutesPerHour: (await import("../../lib/env")).env.MERCHANT_REPORT_EXECUTE_PER_HOUR,
    maxVerifiesPerHour: (await import("../../lib/env")).env.MERCHANT_REPORT_VERIFY_PER_HOUR,
    suspended: Boolean(suspension?.suspendedAt),
    suspensionReason: suspension?.reason ?? null,
    engineEnabled: policy.enabled,
    assetsEnabled: policy.assetsEnabled,
  });
});

/** Clone a platform template into the merchant's own Studio (E07). */
router.post("/report-engine/studio/templates/:code/clone", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:author"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  const policy = await assertMerchantEngineAvailable(merchantId);
  const { code } = parseOrThrow(codeParams, request.params);
  const body = parseOrThrow(cloneSchema, request.body ?? {});
  const template = await client.reportDefinitionSpecRecord.findFirst({
    where: { code, status: "PUBLISHED", isLatestPublished: true },
    orderBy: { version: "desc" },
  });
  if (!template) throw new ApiError(404, "REPORT_NOT_FOUND", "The template does not exist");
  if (template.audienceScope !== "MERCHANT_FACING" && template.audienceScope !== "BOTH") {
    throw new ApiError(403, "REPORT_ACCESS_DENIED", "This template is not available to merchants");
  }
  const spec = ReportDescriptorSpecSchema.parse(template.specJson);
  if (spec.required_assets.length > 0) {
    throw new ApiError(
      409,
      policy.assetsEnabled ? "MERCHANT_TEMPLATE_ASSETS_NOT_CLONEABLE" : "MERCHANT_REPORT_ASSETS_DISABLED",
      policy.assetsEnabled
        ? "This template uses assets; attach your own asset bundle by re-authoring the spec"
        : "Merchant report asset bundles are disabled by platform policy",
    );
  }
  const requestedCode = body.code ?? `${spec.report.code}-mine`;
  const cloneCode = requestedCode.slice(0, 64);
  const cloned: ReportDescriptorSpec = {
    ...spec,
    report: { ...spec.report, code: cloneCode, version: 1 },
  };
  const verification = await verifyMerchantSpec({
    rawSpecJson: JSON.stringify(cloned),
    filesByName: new Map(),
    specBytes: Buffer.byteLength(JSON.stringify(cloned)),
    zipBytes: 0,
    assetsEnabled: policy.assetsEnabled,
  });
  if (!verification.valid) {
    throw new ApiError(409, "MERCHANT_TEMPLATE_NOT_CLONEABLE", "This template is not valid on the merchant line", {
      verification,
    });
  }
  await assertMerchantQuota(merchantId, cloned.report.code);
  let row;
  try {
  row = await client.$transaction(async (tx) => {
    const created = await tx.merchantReportSpecRecord.create({
      data: {
        merchantId,
        code: cloned.report.code,
        version: 1,
        category: cloned.report.category,
        status: "VERIFIED",
        isLatestPublished: false,
        supportedLocales: Object.keys(cloned.i18n.locales),
        defaultLocale: cloned.i18n.default_locale,
        specJson: cloned as never,
        specSha256: sha256(cloned),
        verificationReportJson: verification as never,
        createdByUserId: actor.userId,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "MERCHANT_REPORT_TEMPLATE_CLONED",
        entityType: "MERCHANT_REPORT_SPEC",
        entityId: created.id,
        beforeJson: { templateCode: code, templateVersion: template.version },
        afterJson: { merchantId, code: created.code, version: created.version },
      } as never,
    });
    return created;
  });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      throw new ApiError(409, "MERCHANT_REPORT_CLONE_CONFLICT", "A report with this code already exists");
    }
    throw error;
  }
  response.status(201).json({ id: row.id, code: row.code, version: row.version, status: row.status, verification });
});

/* ------------------------------------------------------------------------ */
/* Execution                                                                 */
/* ------------------------------------------------------------------------ */

router.post("/report-engine/catalog/:code/execute", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["report_engine:run"]);
  const merchantId = merchantIdOf(request);
  const actor = await actorOf(request);
  const policy = await assertMerchantEngineAvailable(merchantId);
  const { code } = parseOrThrow(codeParams, request.params);
  const body = parseOrThrow(executeBodySchema, request.body ?? {});

  const ownRow = await client.merchantReportSpecRecord.findFirst({
    where: { merchantId, code, status: "PUBLISHED", isLatestPublished: true },
    orderBy: { version: "desc" },
  });
  const templateRow = ownRow
    ? null
    : await client.reportDefinitionSpecRecord.findFirst({
        where: { code, status: "PUBLISHED", isLatestPublished: true },
        orderBy: { version: "desc" },
      });
  const row = ownRow ?? templateRow;
  if (!row) throw new ApiError(404, "REPORT_NOT_FOUND", "The published report does not exist");
  if (!ownRow && (templateRow!.audienceScope !== "MERCHANT_FACING" && templateRow!.audienceScope !== "BOTH")) {
    throw new ApiError(403, "REPORT_ACCESS_DENIED", "This report is not available to merchants");
  }
  if (!ownRow && templateRow!.requiresConfidentialAml) {
    throw new ApiError(403, "REPORT_ACCESS_DENIED", "This report is not available to merchants");
  }

  const spec = ReportDescriptorSpecSchema.parse(row.specJson);
  if (!policy.assetsEnabled && spec.required_assets.length > 0) {
    throw new ApiError(
      409,
      "MERCHANT_REPORT_ASSETS_DISABLED",
      "Merchant report asset bundles are disabled by platform policy",
    );
  }
  const specBytes = Buffer.byteLength(JSON.stringify(row.specJson));
  const tierDiagnostics = validateMerchantTierLimits(spec, { specBytes });
  if (tierDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ApiError(409, "MERCHANT_REPORT_LIMIT_EXCEEDED", "This report exceeds the merchant reporting limits", {
      diagnostics: tierDiagnostics,
    });
  }
  const scopeDiagnostics = validateMerchantReportScope(spec, host);
  if (scopeDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ApiError(409, "MERCHANT_REPORT_SCOPE_INVALID", "This report is not safely scoped for a merchant", {
      diagnostics: scopeDiagnostics,
    });
  }
  if (ownRow && spec.required_assets.length > 0 && !ownRow.assetBundleId) {
    throw new ApiError(409, "MERCHANT_REPORT_ASSETS_MISSING", "The report assets are missing");
  }
  if (!ownRow && spec.required_assets.length > 0) {
    throw new ApiError(
      409,
      "MERCHANT_TEMPLATE_ASSETS_NOT_SUPPORTED",
      "This template uses assets; clone it into your Studio and attach your own bundle",
    );
  }
  const scopeKey = spec.report.merchant_scope_input_key;
  if (!scopeKey) throw new ApiError(409, "MERCHANT_SCOPE_INPUT_MISSING", "The report has no merchant scope input");
  if (body.locale && !Object.keys(spec.i18n.locales).includes(body.locale)) {
    throw new ApiError(400, "REPORT_LOCALE_NOT_SUPPORTED", `The report does not provide locale "${body.locale}"`);
  }
  if (body.renderMode === "SERVER_PDF") {
    throw new ApiError(501, "SERVER_PDF_NOT_CONFIGURED", "The optional server-side PDF renderer is not configured");
  }

  const applicationIds = applicationScopeOf(request);
  assertSpecFitsApplicationScope(spec, applicationIds);

  await assertMerchantBudget(merchantId);
  await assertMerchantRateLimit(merchantId, "execute");
  const release = acquireMerchantExecutionSlot(merchantId);
  const forcedInputs = { ...body.inputs, [scopeKey]: merchantId };
  const cacheKey = merchantCacheKey({ merchantId, spec, inputs: forcedInputs, applicationIds });
  const cached = readMerchantCache<ReportExecutionBundle>(cacheKey);
  if (cached) {
    release();
    response.json({ ...cached, spec: merchantSafeSpec(cached.spec) });
    return;
  }

  try {
    const registry = await loadChromeRegistry();
    const bundle = await engine.executeReport({
      spec,
      inputs: forcedInputs,
      actor,
      chromeRegistry: registry,
      chromeOverride: null,
      assetBundleId: ownRow?.assetBundleId ?? null,
      assets: {},
      allowConfidentialAmlBypass: false,
      merchantScope: {
        merchantId,
        applicationIds,
        onViolation: async (info) => {
          await writeAudit(client as never, {
            data: {
              actorId: actor.userId,
              role: actor.role,
              action: "MERCHANT_REPORT_SCOPE_VIOLATION",
              entityType: "MERCHANT_REPORT_SPEC",
              entityId: row.id,
              beforeJson: { merchantId, datasetId: info.datasetId },
              afterJson: { expected: info.expected, received: info.received },
            } as never,
          }).catch(() => undefined);
          await openKeyedOperatorCase(client as never, {
            kind: "MANUAL_REVIEW",
            priority: "P1",
            subjectKey: `merchant_report_scope:${merchantId}:${row.id}:${info.datasetId}`,
            notes: `Merchant report ${row.code} v${row.version} returned a row outside merchant ${merchantId} (dataset ${info.datasetId}).`,
            slaHours: 4,
          }).catch(() => undefined);
        },
      },
    });
    // The execution record and its audit row commit together.
    await client.$transaction(async (tx) => {
      await tx.merchantReportExecutionAudit.create({
        data: {
          merchantSpecId: ownRow?.id ?? null,
          merchantId,
          reportCode: row.code,
          reportVersion: row.version,
          actorUserId: actor.userId,
          actorRole: actor.role,
          selectedLocale: body.locale ?? spec.i18n.default_locale,
          inputsRedactedJson: redactInputs(bundle.inputsUsed) as never,
          rowCountTotal: bundle.rowCountTotal,
          durationMs: bundle.durationMs,
          servedByNode: bundle.servedByNode,
          verificationSha256: bundle.verificationSha256,
          renderTarget: "CLIENT_PAGED_VECTOR",
        },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role,
          action: "MERCHANT_REPORT_EXECUTED",
          entityType: ownRow ? "MERCHANT_REPORT_SPEC" : "REPORT_SPEC",
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
    });
    writeMerchantCache(cacheKey, bundle);
    response.json({ ...bundle, spec: merchantSafeSpec(bundle.spec) });
  } catch (error) {
    if (error instanceof ReportMerchantScopeViolationError) {
      throw new ApiError(403, "MERCHANT_SCOPE_VIOLATION", error.message);
    }
    throw toGuardError(error);
  } finally {
    release();
  }
});
