import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { requireAuthorities, principalOf } from "../middleware/authDoubleCheck";
import { auditActor, auditBase } from "./adminSliceHelpers";
import { writeAudit } from "../../lib/audit/writeAudit";
import {
  extractZipAssetFiles,
  ReportDescriptorSpecSchema,
  ReportChromeSpecSchema,
  type ReportChromeSpec,
  type ReportDescriptorSpec,
  type ReportActorContext,
  type ReportChromeRegistryEntry,
  canApplySecurityOverride,
  isActorAllowedByPolicy,
  ReportInputValidationError,
  ReportAccessDeniedError,
  validateMerchantReportScope,
} from "../../lib/reportEngineSdk";
import { getReportEngine } from "../../engine/reportStudio/reportEngineRuntime";

const router = express.Router();
export const adminReportEngineRouter = router;

router.use(express.json({ limit: "30mb" }));

const engine = getReportEngine();
const host = engine.host;

const specBodySchema = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
    publish: z.boolean().optional(),
  })
  .strict();

const verifyBodySchema = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
  })
  .strict();

const overrideBodySchema = z
  .object({
    allowedRoles: z.array(z.string()).max(20).default([]),
    allowedAuthorities: z.array(z.string()).max(40).default([]),
    justification: z.string().trim().min(15).max(1000),
    allowConfidentialAmlBypass: z.boolean().optional(),
    clear: z.boolean().optional(),
  })
  .strict();

const executeBodySchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    locale: z.string().max(16).optional(),
    chromeOverride: z
      .object({
        headerMode: z.enum(["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"]).optional(),
        headerChromeCode: z.string().nullable().optional(),
        footerMode: z.enum(["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"]).optional(),
        footerChromeCode: z.string().nullable().optional(),
      })
      .optional(),
    renderMode: z.enum(["CLIENT_PAGED_VECTOR", "SERVER_PDF"]).optional(),
  })
  .strict();

const chromeBodySchema = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
    publish: z.boolean().optional(),
    makeDefault: z.boolean().optional(),
  })
  .strict();

const setDefaultBodySchema = z.object({ isDefault: z.boolean() }).strict();

function actorOf(request: Request): ReportActorContext {
  const principal = principalOf(request);
  return {
    userId: principal.userId ?? "00000000-0000-0000-0000-000000000000",
    email: null,
    role: principal.role ?? "UNKNOWN",
    authorities: principal.authorities,
    isMaker: false,
    isChecker: false,
  };
}

function parseJson<T>(value: string | Record<string, unknown>, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new ApiError(400, "INVALID_JSON_SYNTAX", "The spec is not valid JSON");
  }
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ApiError(400, "SCHEMA_VALIDATION_ERROR", "The spec does not match the required schema", {
        issues: error.issues,
      });
    }
    throw error;
  }
}

function decodeZip(base64: string | undefined): Buffer | null {
  if (!base64) return null;
  return Buffer.from(base64, "base64");
}

function redactInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    output[key] = /secret|password|token|otp|pin|key/i.test(key) ? "[REDACTED]" : value;
  }
  return output;
}

function isAllowed(
  record: {
    authorityMode: string;
    inferredRoles: string[];
    inferredAuthorities: string[];
    overrideAllowedRoles: string[];
    overrideAllowedAuthorities: string[];
  },
  actor: ReportActorContext,
): boolean {
  return isActorAllowedByPolicy(record, actor);
}

async function chromeRegistry(): Promise<ReportChromeRegistryEntry[]> {
  const rows = await client.reportChromeSpecRecord.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [{ chromeType: "asc" }, { code: "asc" }],
  });
  return rows.map((row) => ({
    spec: ReportChromeSpecSchema.parse(row.specJson) as ReportChromeSpec,
    isDefaultGlobal: row.isDefaultGlobal,
    status: row.status,
    assetBundleId: row.assetBundleId,
  }));
}

function mimeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

async function storeAssets(
  zipBuffer: Buffer | null,
  requiredAssets: Array<{ asset_key: string; file_name: string; mime_type: string }>,
  actor: ReportActorContext,
): Promise<{
  bundleId: string | null;
  assetBundleId: string | null;
  extractedFiles: Map<string, Buffer>;
  bundleSha256: string | null;
  fileCount: number;
  totalBytes: number;
  manifest: Array<Record<string, unknown>>;
}> {
  if (!zipBuffer) {
    return {
      bundleId: null,
      assetBundleId: null,
      extractedFiles: new Map(),
      bundleSha256: null,
      fileCount: 0,
      totalBytes: 0,
      manifest: [],
    };
  }
  const extraction = await extractZipAssetFiles({
    zipBuffer,
    maxZipBytes: host.globalLimits.maxAssetZipBytes,
    maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
  });
  if (extraction.diagnostics.some((d) => d.severity === "error")) {
    throw new ApiError(400, "REPORT_ASSET_BUNDLE_INVALID", "The asset archive is invalid", {
      diagnostics: extraction.diagnostics,
    });
  }
  const bundleSha256 = createHash("sha256").update(zipBuffer).digest("hex");
  const requiredByFile = new Map(requiredAssets.map((asset) => [asset.file_name.toLowerCase(), asset]));
  const files = [...extraction.filesByName.entries()].map(([relativePath, buffer]) => {
    const required = requiredByFile.get(relativePath.toLowerCase());
    return {
      relativePath: required?.file_name ?? relativePath,
      buffer,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      mimeType: required?.mime_type ?? mimeForFileName(relativePath),
    };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.buffer.byteLength, 0);
  const manifest = files.map((file) => ({
    assetKey: requiredByFile.get(file.relativePath.toLowerCase())?.asset_key ?? null,
    fileName: file.relativePath,
    mimeType: file.mimeType,
    sha256: file.sha256,
    bytes: file.buffer.byteLength,
  }));

  const existing = await client.reportAssetBundle.findUnique({ where: { bundleSha256 } });
  if (existing) {
    return {
      bundleId: existing.id,
      assetBundleId: existing.id,
      extractedFiles: extraction.filesByName,
      bundleSha256,
      fileCount: existing.fileCount,
      totalBytes: existing.totalBytes,
      manifest,
    };
  }

  const bundleId = randomUUID();
  const storage = await host.assetStoragePort.storeAssetBundle({ bundleId, files });
  const row = await client.reportAssetBundle.create({
    data: {
      id: bundleId,
      bundleSha256,
      storageKey: storage.bundleStorageKey,
      totalBytes,
      fileCount: files.length,
      manifestJson: manifest,
      uploadedByUserId: actor.userId,
    },
  });
  return {
    bundleId,
    assetBundleId: row.id,
    extractedFiles: extraction.filesByName,
    bundleSha256,
    fileCount: files.length,
    totalBytes,
    manifest,
  };
}

function chromeSaveError(error: unknown, stage: "ASSET" | "DATABASE"): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === "P2002") {
    return new ApiError(409, "REPORT_CHROME_DUPLICATE", "A header/footer with this code and version already exists");
  }
  if (code === "P2003") {
    return new ApiError(409, "REPORT_CHROME_REFERENCE_CONFLICT", "The header/footer references a missing asset bundle");
  }
  return new ApiError(
    500,
    stage === "ASSET" ? "REPORT_CHROME_ASSET_SAVE_FAILED" : "REPORT_CHROME_SAVE_FAILED",
    stage === "ASSET"
      ? "The header/footer asset bundle could not be stored"
      : "The header/footer could not be saved",
    { reason: code ?? "storage/database error" },
  );
}

router.get("/report-engine/transcript", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:review", "report_engine:author", "gateway:write"]);
  const kind = String(request.query.kind ?? "REPORT").toUpperCase();
  const domains = String(request.query.domains ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean) as Array<ReportDescriptorSpec["report"]["category"]>;
  if (kind === "CHROME") {
    response.json(engine.buildChromeTranscript());
    return;
  }
  response.json(
    engine.buildTranscript({
      domains: domains.length > 0 ? (domains as never) : undefined,
    }),
  );
});

router.post("/report-engine/specs/verify", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:review", "report_engine:author"]);
  const body = parseOrThrow(verifyBodySchema, request.body ?? {});
  const zipBuffer = decodeZip(body.assetsZipBase64);
  const extraction = zipBuffer
    ? await extractZipAssetFiles({
        zipBuffer,
        maxZipBytes: host.globalLimits.maxAssetZipBytes,
        maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
      })
    : { filesByName: new Map<string, Buffer>(), diagnostics: [] };
  if (extraction.diagnostics.some((d) => d.severity === "error")) {
    response.json({
      valid: false,
      specVersion: null,
      layers: [],
      authorityInference: null,
      verifiedAssets: [],
      diagnostics: extraction.diagnostics,
      aiRepairPrompt: undefined,
    });
    return;
  }
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(body.specJson);
  const report = await engine.verifyDescriptor({
    rawSpecJson,
    extractedZipFiles: extraction.filesByName,
  });
  response.json(report);
});

router.post("/report-engine/specs", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "report_engine:author"]);
  const body = parseOrThrow(specBodySchema, request.body ?? {});
  const spec = parseJson(body.specJson, ReportDescriptorSpecSchema);
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(spec);
  const zipBuffer = decodeZip(body.assetsZipBase64);
  const extraction = zipBuffer
    ? await extractZipAssetFiles({
        zipBuffer,
        maxZipBytes: host.globalLimits.maxAssetZipBytes,
        maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
      })
    : { filesByName: new Map<string, Buffer>(), diagnostics: [] };
  if (extraction.diagnostics.some((d) => d.severity === "error")) {
    throw new ApiError(400, "REPORT_ASSET_BUNDLE_INVALID", "The asset archive is invalid", {
      diagnostics: extraction.diagnostics,
    });
  }
  const verification = await engine.verifyDescriptor({
    rawSpecJson,
    extractedZipFiles: extraction.filesByName,
  });
  if (!verification.valid) {
    throw new ApiError(400, "REPORT_SPEC_VERIFICATION_FAILED", "The report spec failed verification", {
      verification,
    });
  }

  const actor = actorOf(request);
  const assetBundle = await storeAssets(zipBuffer, spec.required_assets, actor);
  const specSha256 = createHash("sha256").update(rawSpecJson).digest("hex");
  const publish = Boolean(body.publish);
  const created = await client.$transaction(async (tx) => {
    const previous = await tx.reportDefinitionSpecRecord.findFirst({
      where: { code: spec.report.code },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = Math.max(spec.report.version, (previous?.version ?? 0) + 1);
    if (publish) {
      await tx.reportDefinitionSpecRecord.updateMany({
        where: { code: spec.report.code, isLatestPublished: true },
        data: { isLatestPublished: false },
      });
    }
    return tx.reportDefinitionSpecRecord.create({
      data: {
        code: spec.report.code,
        version,
        category: spec.report.category,
        audienceScope: spec.report.audience_scope,
        status: publish ? "PUBLISHED" : "VERIFIED",
        isLatestPublished: publish,
        supportedLocales: Object.keys(spec.i18n.locales),
        defaultLocale: spec.i18n.default_locale,
        specJson: spec as never,
        specSha256,
        verificationReportJson: verification as never,
        assetBundleId: assetBundle.assetBundleId,
        authorityMode: verification.authorityInference?.effectiveAccessPolicy.mode ?? "INFERRED_STRICT",
        inferredRoles: verification.authorityInference?.inferredNaturalRoles ?? [],
        inferredAuthorities: verification.authorityInference?.inferredRequiredAuthorities ?? [],
        conflictStatus: verification.authorityInference?.conflictStatus ?? "NONE",
        requiresConfidentialAml: verification.authorityInference?.requiresConfidentialAmlAccess ?? false,
        createdByUserId: actor.userId,
        publishedByUserId: publish ? actor.userId : null,
        publishedAt: publish ? new Date() : null,
      },
    });
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: publish ? "REPORT_SPEC_PUBLISHED" : "REPORT_SPEC_VERIFIED",
      entityType: "REPORT_SPEC",
      entityId: created.id,
      beforeJson: null,
      afterJson: {
        code: created.code,
        version: created.version,
        status: created.status,
        specSha256,
        assetBundleId: assetBundle.assetBundleId,
      },
    } as never,
  });
  response.status(201).json({
    id: created.id,
    code: created.code,
    version: created.version,
    status: created.status,
    verification,
  });
});

router.get("/report-engine/specs", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:review", "report_engine:author", "report:approve"]);
  const code = typeof request.query.code === "string" ? request.query.code : undefined;
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const rows = await client.reportDefinitionSpecRecord.findMany({
    where: {
      ...(code ? { code } : {}),
      ...(status ? { status: status as never } : {}),
    },
    orderBy: [{ code: "asc" }, { version: "desc" }],
    take: 200,
  });
  response.json({
    specs: rows.map((row) => ({
      id: row.id,
      code: row.code,
      version: row.version,
      category: row.category,
      audienceScope: row.audienceScope,
      status: row.status,
      isLatestPublished: row.isLatestPublished,
      supportedLocales: row.supportedLocales,
      defaultLocale: row.defaultLocale,
      specSha256: row.specSha256,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt,
      assetBundleId: row.assetBundleId,
      authorityMode: row.authorityMode,
      allowConfidentialAmlBypass: row.allowConfidentialAmlBypass,
    })),
  });
});

router.get("/report-engine/specs/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:review", "report_engine:author", "report:approve"]);
  const id = String(request.params.id);
  const row = await client.reportDefinitionSpecRecord.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  response.json({
    id: row.id,
    code: row.code,
    version: row.version,
    category: row.category,
    audienceScope: row.audienceScope,
    status: row.status,
    isLatestPublished: row.isLatestPublished,
    supportedLocales: row.supportedLocales,
    defaultLocale: row.defaultLocale,
    spec: row.specJson,
    verification: row.verificationReportJson,
    specSha256: row.specSha256,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    assetBundleId: row.assetBundleId,
    authorityMode: row.authorityMode,
    inferredRoles: row.inferredRoles,
    inferredAuthorities: row.inferredAuthorities,
    conflictStatus: row.conflictStatus,
    requiresConfidentialAml: row.requiresConfidentialAml,
    overrideAllowedRoles: row.overrideAllowedRoles,
    overrideAllowedAuthorities: row.overrideAllowedAuthorities,
    overrideJustification: row.overrideJustification,
    allowConfidentialAmlBypass: row.allowConfidentialAmlBypass,
  });
});

router.post("/report-engine/specs/:id/archive", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "report_engine:author", "security:write"]);
  const id = String(request.params.id);
  const existing = await client.reportDefinitionSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  const updated = await client.reportDefinitionSpecRecord.update({
    where: { id },
    data: { status: "ARCHIVED", isLatestPublished: false },
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_SPEC_ARCHIVED",
      entityType: "REPORT_SPEC",
      entityId: id,
      beforeJson: { status: existing.status, isLatestPublished: existing.isLatestPublished },
      afterJson: { status: "ARCHIVED", isLatestPublished: false },
    } as never,
  });
  response.json({ id: updated.id, status: updated.status, isLatestPublished: updated.isLatestPublished });
});

router.get("/report-engine/executions", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:review", "report:approve", "security:read"]);
  const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
  const rows = await client.reportExecutionAuditRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  response.json({
    executions: rows.map((row) => ({
      id: row.id,
      reportSpecId: row.reportSpecId,
      reportCode: row.reportCode,
      reportVersion: row.reportVersion,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole,
      selectedLocale: row.selectedLocale,
      scopedMerchantId: row.scopedMerchantId,
      rowCountTotal: row.rowCountTotal,
      durationMs: row.durationMs,
      servedByNode: row.servedByNode,
      verificationSha256: row.verificationSha256,
      renderTarget: row.renderTarget,
      createdAt: row.createdAt,
    })),
  });
});

router.post("/report-engine/specs/:id/authority-override", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write"]);
  const principal = principalOf(request);
  if (!canApplySecurityOverride({ ...actorOf(request), role: principal.role ?? "UNKNOWN" }, host)) {
    throw new ApiError(403, "SECURITY_OVERRIDE_AUTHORITY_REQUIRED", "Only a Security Admin may override report authorities");
  }
  const body = parseOrThrow(overrideBodySchema, request.body ?? {});
  const id = String(request.params.id);
  const existing = await client.reportDefinitionSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");

  if (body.clear) {
    const cleared = await client.reportDefinitionSpecRecord.update({
      where: { id },
      data: {
        authorityMode: "INFERRED_STRICT",
        overrideAllowedRoles: [],
        overrideAllowedAuthorities: [],
        overrideJustification: null,
        allowConfidentialAmlBypass: false,
        overriddenByUserId: null,
        overriddenAt: null,
      },
    });
    await writeAudit(client, {
      data: {
        ...auditBase(auditActor(request)),
        action: "REPORT_AUTHORITY_OVERRIDE_CLEARED",
        entityType: "REPORT_SPEC",
        entityId: id,
        beforeJson: {
          authorityMode: existing.authorityMode,
          overrideAllowedRoles: existing.overrideAllowedRoles,
          overrideAllowedAuthorities: existing.overrideAllowedAuthorities,
          allowConfidentialAmlBypass: existing.allowConfidentialAmlBypass,
        },
        afterJson: { authorityMode: "INFERRED_STRICT" },
      } as never,
    });
    response.json({ id: cleared.id, authorityMode: cleared.authorityMode, cleared: true });
    return;
  }

  const unknownRoles = body.allowedRoles.filter((role) => !host.rolesCatalog.includes(role));
  const unknownAuthorities = body.allowedAuthorities.filter((authority) => !host.authoritiesCatalog.includes(authority));
  if (unknownRoles.length > 0 || unknownAuthorities.length > 0) {
    throw new ApiError(400, "UNKNOWN_OVERRIDE_VALUE", "The override contains unknown roles or authorities", {
      unknownRoles,
      unknownAuthorities,
    });
  }
  if (body.allowConfidentialAmlBypass && !existing.requiresConfidentialAml) {
    throw new ApiError(400, "AML_BYPASS_NOT_APPLICABLE", "This report does not require confidential AML access");
  }
  if (body.allowConfidentialAmlBypass) {
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "REPORT_AML_BYPASS",
        subjectId: id,
        payloadDiffJson: {
          reportSpecId: id,
          reportCode: existing.code,
          allowedRoles: body.allowedRoles,
          allowedAuthorities: body.allowedAuthorities,
          justification: body.justification,
          allowConfidentialAmlBypass: true,
        } as never,
        makerReason: body.justification,
        makerUserId: principal.userId ?? actorOf(request).userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    await writeAudit(client, {
      data: {
        ...auditBase(auditActor(request)),
        action: "REPORT_AML_BYPASS_REQUESTED",
        entityType: "REPORT_SPEC",
        entityId: id,
        beforeJson: null,
        afterJson: {
          approvalRequestId: approval.id,
          allowedRoles: body.allowedRoles,
          allowedAuthorities: body.allowedAuthorities,
          justification: body.justification,
        },
      } as never,
    });
    response.status(202).json({
      id,
      approvalRequestId: approval.id,
      status: "PENDING_REVIEW",
      message: "A different MLRO or Security Admin must approve the confidential AML bypass",
    });
    return;
  }

  const updated = await client.reportDefinitionSpecRecord.update({
    where: { id },
    data: {
      authorityMode: "SECURITY_ADMIN_OVERRIDE",
      overrideAllowedRoles: body.allowedRoles,
      overrideAllowedAuthorities: body.allowedAuthorities,
      overrideJustification: body.justification,
      allowConfidentialAmlBypass: false,
      overriddenByUserId: principal.userId,
      overriddenAt: new Date(),
    },
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_AUTHORITY_OVERRIDE",
      entityType: "REPORT_SPEC",
      entityId: id,
      beforeJson: {
        authorityMode: existing.authorityMode,
        overrideAllowedRoles: existing.overrideAllowedRoles,
        overrideAllowedAuthorities: existing.overrideAllowedAuthorities,
      },
      afterJson: {
        authorityMode: "SECURITY_ADMIN_OVERRIDE",
        allowedRoles: body.allowedRoles,
        allowedAuthorities: body.allowedAuthorities,
        justification: body.justification,
      },
    } as never,
  });
  response.json({ id: updated.id, authorityMode: updated.authorityMode });
});

const amlBypassDecisionSchema = z.object({ notes: z.string().max(2000).optional() }).strict();

router.get("/report-engine/aml-bypass/pending", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write", "report:approve"]);
  const principal = principalOf(request);
  if (!["MLRO", "SECURITY_ADMIN"].includes(String(principal.role ?? ""))) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "Only an MLRO or Security Admin may review AML bypasses");
  }
  const rows = await client.approvalRequest.findMany({
    where: { subjectType: "REPORT_AML_BYPASS", state: "PENDING_REVIEW" },
    orderBy: { createdAt: "desc" },
    include: { maker: { select: { email: true } } },
  });
  response.json({
    approvals: rows.map((row) => {
      const payload = row.payloadDiffJson as Record<string, unknown>;
      return {
        id: row.id,
        reportSpecId: row.subjectId,
        reportCode: String(payload.reportCode ?? ""),
        allowedRoles: Array.isArray(payload.allowedRoles) ? payload.allowedRoles : [],
        allowedAuthorities: Array.isArray(payload.allowedAuthorities) ? payload.allowedAuthorities : [],
        justification: String(payload.justification ?? ""),
        makerEmail: row.maker?.email ?? "",
        createdAt: row.createdAt,
        canDecide: row.makerUserId !== principal.userId,
      };
    }),
  });
});

router.post("/report-engine/aml-bypass/:id/approve", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write", "report:approve"]);
  const principal = principalOf(request);
  if (!["MLRO", "SECURITY_ADMIN"].includes(String(principal.role ?? ""))) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "Only an MLRO or Security Admin may approve an AML bypass");
  }
  const id = String(request.params.id);
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval || approval.subjectType !== "REPORT_AML_BYPASS") {
    throw new ApiError(404, "AML_BYPASS_APPROVAL_NOT_FOUND", "The AML bypass approval does not exist");
  }
  if (approval.state !== "PENDING_REVIEW") {
    throw new ApiError(409, "AML_BYPASS_NOT_PENDING", "The AML bypass approval is not pending");
  }
  if (approval.makerUserId === principal.userId) {
    throw new ApiError(409, "APPROVAL_MAKER_EQUALS_CHECKER", "The maker and the checker must be different users");
  }
  const payload = approval.payloadDiffJson as Record<string, unknown>;
  const reportSpecId = String(payload.reportSpecId ?? approval.subjectId);
  const updated = await client.$transaction(async (tx) => {
    await tx.approvalRequest.update({
      where: { id },
      data: { checkerUserId: principal.userId, state: "APPROVED" },
    });
    return tx.reportDefinitionSpecRecord.update({
      where: { id: reportSpecId },
      data: {
        authorityMode: "SECURITY_ADMIN_OVERRIDE",
        overrideAllowedRoles: Array.isArray(payload.allowedRoles) ? payload.allowedRoles as never : [],
        overrideAllowedAuthorities: Array.isArray(payload.allowedAuthorities) ? payload.allowedAuthorities as never : [],
        overrideJustification: String(payload.justification ?? ""),
        allowConfidentialAmlBypass: true,
        overriddenByUserId: approval.makerUserId,
        overriddenAt: new Date(),
      },
    });
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_AML_BYPASS_APPROVED",
      entityType: "REPORT_SPEC",
      entityId: reportSpecId,
      beforeJson: { approvalRequestId: id, state: "PENDING_REVIEW" },
      afterJson: { state: "APPROVED", checkerUserId: principal.userId },
    } as never,
  });
  response.json({ id: updated.id, approvalRequestId: id, state: "APPROVED", allowConfidentialAmlBypass: true });
});

router.post("/report-engine/aml-bypass/:id/reject", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write", "report:approve"]);
  const principal = principalOf(request);
  if (!["MLRO", "SECURITY_ADMIN"].includes(String(principal.role ?? ""))) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "Only an MLRO or Security Admin may reject an AML bypass");
  }
  const id = String(request.params.id);
  const body = parseOrThrow(amlBypassDecisionSchema, request.body ?? {});
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval || approval.subjectType !== "REPORT_AML_BYPASS") {
    throw new ApiError(404, "AML_BYPASS_APPROVAL_NOT_FOUND", "The AML bypass approval does not exist");
  }
  if (approval.makerUserId === principal.userId) {
    throw new ApiError(409, "APPROVAL_MAKER_EQUALS_CHECKER", "The maker and the checker must be different users");
  }
  await client.approvalRequest.update({
    where: { id },
    data: {
      checkerUserId: principal.userId,
      state: "REJECTED",
      rejectionReason: body.notes ?? "Rejected by MLRO/Security Admin",
    },
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_AML_BYPASS_REJECTED",
      entityType: "REPORT_SPEC",
      entityId: approval.subjectId,
      beforeJson: { approvalRequestId: id, state: "PENDING_REVIEW" },
      afterJson: { state: "REJECTED", checkerUserId: principal.userId, notes: body.notes ?? null },
    } as never,
  });
  response.json({ id, state: "REJECTED" });
});

router.get("/report-engine/catalog", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const actor: ReportActorContext = {
    userId: principal.userId ?? "00000000-0000-0000-0000-000000000000",
    role: principal.role ?? "UNKNOWN",
    authorities: principal.authorities,
  };
  const audience = typeof request.query.audience === "string" ? request.query.audience : "ALL";
  const page = Math.max(1, Number(request.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 20) || 20));
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const sortKey = typeof request.query.sortKey === "string" ? request.query.sortKey : "";
  const sortDirection: "asc" | "desc" = request.query.sortDirection === "asc" ? "asc" : "desc";
  const where: Prisma.ReportDefinitionSpecRecordWhereInput = {
    status: "PUBLISHED" as const,
    isLatestPublished: true,
    ...(audience === "BACKOFFICE_INTERNAL"
      ? { audienceScope: "BACKOFFICE_INTERNAL" as const }
      : audience === "MERCHANT_FACING"
        ? { audienceScope: { in: ["MERCHANT_FACING", "BOTH"] } }
        : {}),
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
  const [total, rows] = await Promise.all([
    client.reportDefinitionSpecRecord.count({ where }),
    client.reportDefinitionSpecRecord.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const items = rows
    .filter((row) => isAllowed(row, actor))
    .map((row) => ({
      id: row.id,
      code: row.code,
      version: row.version,
      category: row.category,
      audienceScope: row.audienceScope,
      supportedLocales: row.supportedLocales,
      defaultLocale: row.defaultLocale,
      authorityMode: row.authorityMode,
      inferredRoles: row.inferredRoles,
      inferredAuthorities: row.inferredAuthorities,
      conflictStatus: row.conflictStatus,
      requiresConfidentialAml: row.requiresConfidentialAml,
      assetBundleId: row.assetBundleId,
      spec: row.specJson,
      updatedAt: row.updatedAt,
    }));
  response.json({ reports: items, total });
});

router.get("/report-engine/autocomplete/:sourceKey", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const sourceKey = String(request.params.sourceKey);
  const provider = host.autocompleteProviders[sourceKey];
  if (!provider) throw new ApiError(404, "AUTOCOMPLETE_SOURCE_NOT_FOUND", "The autocomplete source does not exist");
  if (!principal.authorities.includes(provider.requiredAuthority) && !principal.authorities.includes("security:write")) {
    throw new ApiError(403, "AUTHORITY_REQUIRED", `The autocomplete source requires ${provider.requiredAuthority}`);
  }
  let dependentValues: Record<string, unknown> | undefined;
  if (typeof request.query.dependent === "string") {
    try {
      dependentValues = JSON.parse(request.query.dependent) as Record<string, unknown>;
    } catch {
      dependentValues = undefined;
    }
  }
  const items = await provider.search({
    query: String(request.query.q ?? ""),
    limit: Math.min(Number(request.query.limit ?? 20), 50),
    actor: actorOf(request),
    dependentValues,
  });
  response.json({ items });
});

router.post("/report-engine/catalog/:code/execute", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const actor = actorOf(request);
  const body = parseOrThrow(executeBodySchema, request.body ?? {});
  const code = String(request.params.code);
  const row = await client.reportDefinitionSpecRecord.findFirst({
    where: { code, status: "PUBLISHED", isLatestPublished: true },
    orderBy: { version: "desc" },
  });
  if (!row) {
    const existing = await client.reportDefinitionSpecRecord.findFirst({
      where: { code },
      orderBy: { version: "desc" },
      select: { status: true, version: true, isLatestPublished: true },
    });
    if (!existing) {
      throw new ApiError(404, "REPORT_NOT_FOUND", `The report "${code}" does not exist`);
    }
    throw new ApiError(409, "REPORT_NOT_PUBLISHED", `The report "${code}" exists but is not the published latest version`, {
      status: existing.status,
      version: existing.version,
      isLatestPublished: existing.isLatestPublished,
    });
  }
  if (!isAllowed(row, actor)) {
    throw new ApiError(403, "REPORT_ACCESS_DENIED", "You are not authorized to run this report");
  }
  const spec = ReportDescriptorSpecSchema.parse(row.specJson);
  if (body.locale && !Object.keys(spec.i18n.locales).includes(body.locale)) {
    throw new ApiError(400, "REPORT_LOCALE_NOT_SUPPORTED", `The report does not provide locale "${body.locale}"`);
  }
  if (body.chromeOverride && !spec.page_layout.allow_runtime_chrome_selection) {
    throw new ApiError(403, "RUNTIME_CHROME_SELECTION_DISABLED", "This report does not allow runtime chrome selection");
  }
  if (body.renderMode === "SERVER_PDF") {
    throw new ApiError(
      501,
      "SERVER_PDF_NOT_CONFIGURED",
      "The optional server-side PDF renderer is not configured; use the client-side vector renderer",
    );
  }
  if (spec.report.audience_scope === "MERCHANT_FACING" || spec.report.audience_scope === "BOTH") {
    const scopeDiagnostics = validateMerchantReportScope(spec, host);
    if (scopeDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new ApiError(409, "MERCHANT_REPORT_SCOPE_INVALID", "The merchant-facing report is not safely scoped", {
        diagnostics: scopeDiagnostics,
      });
    }
  }
  const registry = await chromeRegistry();
  if (body.chromeOverride?.headerMode === "SPECIFIC_CHROME_CODE") {
    const found = registry.some(
      (entry) => entry.spec.chrome.chrome_type === "HEADER" && entry.spec.chrome.code === body.chromeOverride?.headerChromeCode,
    );
    if (!found) throw new ApiError(404, "REPORT_CHROME_NOT_FOUND", "The requested header chrome is not published");
  }
  if (body.chromeOverride?.footerMode === "SPECIFIC_CHROME_CODE") {
    const found = registry.some(
      (entry) => entry.spec.chrome.chrome_type === "FOOTER" && entry.spec.chrome.code === body.chromeOverride?.footerChromeCode,
    );
    if (!found) throw new ApiError(404, "REPORT_CHROME_NOT_FOUND", "The requested footer chrome is not published");
  }
  let bundle;
  try {
    bundle = await engine.executeReport({
      spec,
      inputs: body.inputs,
      actor,
      chromeRegistry: registry,
      chromeOverride: body.chromeOverride ?? null,
      assetBundleId: row.assetBundleId,
      allowConfidentialAmlBypass: row.allowConfidentialAmlBypass,
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
  const scopedMerchantId =
    spec.report.merchant_scope_input_key && typeof bundle.inputsUsed[spec.report.merchant_scope_input_key] === "string"
      ? String(bundle.inputsUsed[spec.report.merchant_scope_input_key])
      : null;
  await client.reportExecutionAuditRecord.create({
    data: {
      reportSpecId: row.id,
      reportCode: row.code,
      reportVersion: row.version,
      actorUserId: actor.userId,
      actorRole: actor.role,
      selectedLocale: body.locale ?? spec.i18n.default_locale,
      scopedMerchantId,
      inputsRedactedJson: redactInputs(bundle.inputsUsed) as never,
      rowCountTotal: bundle.rowCountTotal,
      durationMs: bundle.durationMs,
      servedByNode: bundle.servedByNode,
      verificationSha256: bundle.verificationSha256,
      renderTarget: "CLIENT_PAGED_VECTOR",
    },
  });
  response.json(bundle);
});

router.get("/report-engine/chrome", async (request: Request, response: Response) => {
  const type = typeof request.query.type === "string" ? request.query.type : undefined;
  const includeArchived = request.query.includeArchived === "true";
  const page = Math.max(1, Number(request.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 200) || 200));
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const sortKey = typeof request.query.sortKey === "string" ? request.query.sortKey : "";
  const sortDirection: "asc" | "desc" = request.query.sortDirection === "asc" ? "asc" : "desc";
  const where: Prisma.ReportChromeSpecRecordWhereInput = {
    ...(type ? { chromeType: type as never } : {}),
    ...(includeArchived ? {} : { status: { not: "ARCHIVED" } }),
    ...(search
      ? {
          OR: [
            { code: { contains: search, mode: "insensitive" as const } },
            { name: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.ReportChromeSpecRecordOrderByWithRelationInput[] =
    sortKey === "name"
      ? [{ name: sortDirection }, { code: "asc" }]
      : sortKey === "type"
        ? [{ chromeType: sortDirection }, { code: "asc" }]
        : sortKey === "status"
          ? [{ status: sortDirection }, { code: "asc" }]
          : sortKey === "version"
            ? [{ version: sortDirection }]
            : [{ chromeType: "asc" }, { code: "asc" }, { version: "desc" }];
  const [total, rows] = await Promise.all([
    client.reportChromeSpecRecord.count({ where }),
    client.reportChromeSpecRecord.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const specs = [];
  for (const row of rows) {
    const spec = ReportChromeSpecSchema.parse(row.specJson);
    const assetDataUrls: Record<string, string> = {};
    if (row.assetBundleId) {
      for (const required of spec.required_assets) {
        const stored = await host.assetStoragePort.getAssetBuffer({
          bundleId: row.assetBundleId,
          relativePath: required.file_name,
        });
        if (stored) {
          assetDataUrls[required.asset_key] = `data:${stored.mimeType};base64,${stored.buffer.toString("base64")}`;
        }
      }
    }
    specs.push({
      id: row.id,
      code: row.code,
      version: row.version,
      name: row.name,
      chromeType: row.chromeType,
      status: row.status,
      isDefaultGlobal: row.isDefaultGlobal,
      supportedLocales: row.supportedLocales,
      assetBundleId: row.assetBundleId,
      assetDataUrls,
      spec,
    });
  }
  response.json({ specs, total });
});

router.post("/report-engine/chrome", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "security:write"]);
  const body = parseOrThrow(chromeBodySchema, request.body ?? {});
  const spec = parseJson(body.specJson, ReportChromeSpecSchema);
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(spec);
  const zipBuffer = decodeZip(body.assetsZipBase64);
  const extraction = zipBuffer
    ? await extractZipAssetFiles({
        zipBuffer,
        maxZipBytes: host.globalLimits.maxAssetZipBytes,
        maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
      })
    : { filesByName: new Map<string, Buffer>(), diagnostics: [] };
  if (extraction.diagnostics.some((d) => d.severity === "error")) {
    throw new ApiError(400, "REPORT_ASSET_BUNDLE_INVALID", "The asset archive is invalid", {
      diagnostics: extraction.diagnostics,
    });
  }
  const verification = await engine.verifyChrome({
    rawSpecJson,
    extractedZipFiles: extraction.filesByName,
  });
  if (!verification.valid) {
    throw new ApiError(400, "REPORT_CHROME_VERIFICATION_FAILED", "The chrome spec failed verification", {
      verification,
    });
  }
  const actor = actorOf(request);
  let assetBundle;
  try {
    assetBundle = await storeAssets(zipBuffer, spec.required_assets, actor);
  } catch (error) {
    console.error(`[${request.requestId}] report chrome asset storage failed: ${(error as Error)?.message ?? "unknown"}`);
    throw chromeSaveError(error, "ASSET");
  }
  const specSha256 = createHash("sha256").update(rawSpecJson).digest("hex");
  const publish = Boolean(body.publish);
  let created;
  try {
    created = await client.$transaction(async (tx) => {
      const previous = await tx.reportChromeSpecRecord.findFirst({
        where: { code: spec.chrome.code },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = Math.max(1, (previous?.version ?? 0) + 1);
      if (body.makeDefault && publish) {
        await tx.reportChromeSpecRecord.updateMany({
          where: { chromeType: spec.chrome.chrome_type, isDefaultGlobal: true },
          data: { isDefaultGlobal: false },
        });
      }
      return tx.reportChromeSpecRecord.create({
        data: {
          code: spec.chrome.code,
          version,
          name: spec.chrome.name,
          chromeType: spec.chrome.chrome_type,
          status: publish ? "PUBLISHED" : "VERIFIED",
          isDefaultGlobal: Boolean(body.makeDefault) && publish,
          supportedLocales: Object.keys(spec.i18n.locales),
          specJson: spec as never,
          specSha256,
          assetBundleId: assetBundle.assetBundleId,
          createdByUserId: actor.userId,
          publishedByUserId: publish ? actor.userId : null,
          publishedAt: publish ? new Date() : null,
        },
      });
    });
  } catch (error) {
    console.error(`[${request.requestId}] report chrome database save failed: ${(error as Error)?.message ?? "unknown"}`);
    throw chromeSaveError(error, "DATABASE");
  }
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_CHROME_SPEC_SAVED",
      entityType: "REPORT_CHROME_SPEC",
      entityId: created.id,
      beforeJson: null,
      afterJson: {
        code: created.code,
        version: created.version,
        chromeType: created.chromeType,
        status: created.status,
        isDefaultGlobal: created.isDefaultGlobal,
        specSha256,
      },
    } as never,
  });
  response.status(201).json({
    id: created.id,
    code: created.code,
    version: created.version,
    status: created.status,
    isDefaultGlobal: created.isDefaultGlobal,
    verification,
  });
});

router.post("/report-engine/chrome/:id/archive", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "security:write"]);
  const id = String(request.params.id);
  const existing = await client.reportChromeSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_CHROME_SPEC_NOT_FOUND", "The chrome spec does not exist");
  if (existing.status === "ARCHIVED") {
    response.json({ id, status: "ARCHIVED", archived: true });
    return;
  }
  const updated = await client.reportChromeSpecRecord.update({
    where: { id },
    data: { status: "ARCHIVED", isDefaultGlobal: false },
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_CHROME_SPEC_ARCHIVED",
      entityType: "REPORT_CHROME_SPEC",
      entityId: id,
      beforeJson: { status: existing.status, isDefaultGlobal: existing.isDefaultGlobal },
      afterJson: { status: "ARCHIVED", isDefaultGlobal: false },
    } as never,
  });
  response.json({ id: updated.id, status: updated.status, isDefaultGlobal: updated.isDefaultGlobal, archived: true });
});

router.post("/report-engine/chrome/:id/set-default", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "security:write"]);
  const body = parseOrThrow(setDefaultBodySchema, request.body ?? {});
  const id = String(request.params.id);
  const existing = await client.reportChromeSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_CHROME_SPEC_NOT_FOUND", "The chrome spec does not exist");
  if (existing.status !== "PUBLISHED" && body.isDefault) {
    throw new ApiError(409, "REPORT_CHROME_NOT_PUBLISHED", "Only a published chrome spec can be the global default");
  }
  await client.$transaction(async (tx) => {
    if (body.isDefault) {
      await tx.reportChromeSpecRecord.updateMany({
        where: { chromeType: existing.chromeType, isDefaultGlobal: true },
        data: { isDefaultGlobal: false },
      });
    }
    await tx.reportChromeSpecRecord.update({
      where: { id },
      data: { isDefaultGlobal: body.isDefault },
    });
  });
  await writeAudit(client, {
    data: {
      ...auditBase(auditActor(request)),
      action: "REPORT_CHROME_DEFAULT_CHANGED",
      entityType: "REPORT_CHROME_SPEC",
      entityId: id,
      beforeJson: { isDefaultGlobal: existing.isDefaultGlobal },
      afterJson: { isDefaultGlobal: body.isDefault, chromeType: existing.chromeType },
    } as never,
  });
  response.json({ id, isDefaultGlobal: body.isDefault });
});
