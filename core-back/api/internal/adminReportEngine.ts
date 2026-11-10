import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { requireAuthorities, principalOf, isStaffPrincipal, type Principal } from "../middleware/authDoubleCheck";
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

/**
 * Report-engine bodies carry a base64 asset zip (≤ 15 MB binary, ≈ 20 MB as
 * base64) next to the spec JSON. core-back's global parser skips the
 * report-engine prefix and parses it with this limit (`index.ts`); the
 * router-level parser keeps the same limit when the router is mounted on its
 * own (tests). It is scoped to `/report-engine` because this router is mounted
 * without a prefix on the admin channel.
 */
export const REPORT_ENGINE_JSON_LIMIT = "24mb";
router.use("/report-engine", express.json({ limit: REPORT_ENGINE_JSON_LIMIT }));

const engine = getReportEngine();
const host = engine.host;

const NULL_USER_ID = "00000000-0000-0000-0000-000000000000";

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

const CHROME_MODES = ["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"] as const;

/**
 * Runtime chrome selection. `SPECIFIC_CHROME_CODE` must name the chrome in
 * `headerChromeCode` / `footerChromeCode`; the code itself is never a mode.
 */
export const chromeOverrideSchema = z
  .object({
    headerMode: z.enum(CHROME_MODES).optional(),
    headerChromeCode: z.string().trim().max(64).nullable().optional(),
    footerMode: z.enum(CHROME_MODES).optional(),
    footerChromeCode: z.string().trim().max(64).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.headerMode === "SPECIFIC_CHROME_CODE" && !value.headerChromeCode) {
      context.addIssue({
        code: "custom",
        path: ["headerChromeCode"],
        message: "headerChromeCode is required when headerMode is SPECIFIC_CHROME_CODE",
      });
    }
    if (value.footerMode === "SPECIFIC_CHROME_CODE" && !value.footerChromeCode) {
      context.addIssue({
        code: "custom",
        path: ["footerChromeCode"],
        message: "footerChromeCode is required when footerMode is SPECIFIC_CHROME_CODE",
      });
    }
  });

const executeBodySchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    locale: z.string().max(16).optional(),
    chromeOverride: chromeOverrideSchema.optional(),
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

/* ------------------------------------------------------------------------ */
/* Shared helpers (also used by the merchant report-engine router)           */
/* ------------------------------------------------------------------------ */

interface ActorIdentity {
  email: string | null;
  isMaker: boolean;
  isChecker: boolean;
}

const identityCache = new WeakMap<Request, Promise<ActorIdentity>>();

/**
 * Reads the acting user's email and maker/checker flags once per request (the
 * session principal only carries the id). Merchant users live in the same
 * `users` table, so both routers share it.
 */
export function actorIdentityOf(request: Request): Promise<ActorIdentity> {
  const cached = identityCache.get(request);
  if (cached) return cached;
  const userId = request.principal?.userId ?? null;
  const pending: Promise<ActorIdentity> = userId
    ? client.user
        .findUnique({ where: { id: userId }, select: { email: true, isMaker: true, isChecker: true } })
        .then((user) => ({
          email: user?.email ?? null,
          isMaker: user?.isMaker ?? false,
          isChecker: user?.isChecker ?? false,
        }))
        .catch(() => ({ email: null, isMaker: false, isChecker: false }))
    : Promise.resolve({ email: null, isMaker: false, isChecker: false });
  identityCache.set(request, pending);
  return pending;
}

async function actorOf(request: Request): Promise<ReportActorContext> {
  const principal = principalOf(request);
  const identity = await actorIdentityOf(request);
  return {
    userId: principal.userId ?? NULL_USER_ID,
    email: identity.email,
    role: principal.role ?? "UNKNOWN",
    authorities: principal.authorities,
    isMaker: identity.isMaker,
    isChecker: identity.isChecker,
  };
}

/**
 * Input keys whose values never reach the execution audit. Matched on whole
 * words of the key (camelCase / snake_case / kebab-case split), so `pinCode`,
 * `card_pin` and `apiKey` are redacted while `spinCount` or `merchantKeyName`
 * are not.
 */
const SENSITIVE_INPUT_WORDS = new Set([
  "pin",
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "secret",
  "otp",
  "totp",
  "cvv",
  "cvc",
  "cvv2",
  "pan",
  "token",
  "apikey",
  "privatekey",
  "secretkey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "cardnumber",
  "mfacode",
  "credential",
  "credentials",
]);

export function isSensitiveInputKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (SENSITIVE_INPUT_WORDS.has(words.join(""))) return true;
  for (let index = 0; index < words.length; index += 1) {
    if (SENSITIVE_INPUT_WORDS.has(words[index]!)) return true;
    if (index + 1 < words.length && SENSITIVE_INPUT_WORDS.has(`${words[index]}${words[index + 1]}`)) return true;
  }
  return false;
}

export function redactInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    output[key] = isSensitiveInputKey(key) ? "[REDACTED]" : value;
  }
  return output;
}

/** Compiler / pipeline errors carry an UPPER_SNAKE reason prefix (`UNKNOWN_COLUMN: "t0.x"`). */
const COMPILE_ERROR_PATTERN = /^([A-Z][A-Z0-9_]{3,}):/;

/** Maps an `engine.executeReport` failure onto the public error contract. */
export function toReportExecutionError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof ReportInputValidationError) {
    return new ApiError(400, error.code, error.message, { issues: error.zodError.issues });
  }
  if (error instanceof ReportAccessDeniedError) {
    return new ApiError(403, error.code, error.message);
  }
  const pgCode = (error as { code?: unknown } | null)?.code;
  const message = String((error as Error | null)?.message ?? "");
  if (pgCode === "57014" || /statement timeout|canceling statement/i.test(message)) {
    return new ApiError(408, "REPORT_QUERY_TIMEOUT", "The report query exceeded its time limit");
  }
  if (pgCode === "55P03" || /lock timeout|could not obtain lock/i.test(message)) {
    return new ApiError(408, "REPORT_LOCK_TIMEOUT", "The report query could not obtain a lock in time; retry shortly");
  }
  const compileReason = COMPILE_ERROR_PATTERN.exec(message)?.[1];
  if (compileReason || (typeof pgCode === "string" && /^42[0-9A-Z]{3}$/.test(pgCode))) {
    return new ApiError(422, "REPORT_COMPILE_ERROR", "The report query could not be compiled for execution", {
      reason: compileReason ?? `SQLSTATE_${String(pgCode)}`,
    });
  }
  return error;
}

/**
 * The published chrome registry: the highest published version of each code.
 * Older published rows (legacy data, before publishing superseded them) never
 * win on row order; the default flag of any published version of a code is
 * carried by its latest version.
 */
export async function loadChromeRegistry(): Promise<ReportChromeRegistryEntry[]> {
  const rows = await client.reportChromeSpecRecord.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [{ chromeType: "asc" }, { code: "asc" }, { version: "desc" }],
  });
  const byCode = new Map<string, { row: (typeof rows)[number]; isDefault: boolean }>();
  for (const row of rows) {
    const current = byCode.get(row.code);
    if (!current) {
      byCode.set(row.code, { row, isDefault: row.isDefaultGlobal });
    } else if (row.isDefaultGlobal) {
      current.isDefault = true;
    }
  }
  return [...byCode.values()].map(({ row, isDefault }) => ({
    spec: ReportChromeSpecSchema.parse(row.specJson) as ReportChromeSpec,
    isDefaultGlobal: isDefault,
    status: row.status,
    assetBundleId: row.assetBundleId,
  }));
}

/** Holds one of the authorities, with the staff wildcard. */
function holdsAny(principal: Principal, authorities: readonly string[]): boolean {
  const granted = new Set(principal.authorities);
  if (granted.has("*") && isStaffPrincipal(principal)) return true;
  return authorities.some((authority) => granted.has(authority));
}

const CHROME_AUTHOR_AUTHORITIES = ["report:approve", "report_engine:author", "security:write"] as const;

/* ------------------------------------------------------------------------ */

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
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > host.globalLimits.maxAssetZipBytes) {
    throw new ApiError(413, "REPORT_ASSET_ZIP_TOO_LARGE", "The asset archive exceeds the maximum size", {
      maxBytes: host.globalLimits.maxAssetZipBytes,
      actualBytes: buffer.byteLength,
    });
  }
  return buffer;
}

async function extractZip(zipBuffer: Buffer | null) {
  return zipBuffer
    ? extractZipAssetFiles({
        zipBuffer,
        maxZipBytes: host.globalLimits.maxAssetZipBytes,
        maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
      })
    : { filesByName: new Map<string, Buffer>(), diagnostics: [] };
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

function prismaCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
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
  const extraction = await extractZip(zipBuffer);
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

  // Content-addressed: the same archive maps to one bundle row. The fast path
  // avoids rewriting the files; the upsert settles a concurrent first upload
  // (both writers store identical content, the loser's copy is unused).
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
  const row = await client.reportAssetBundle.upsert({
    where: { bundleSha256 },
    create: {
      id: bundleId,
      bundleSha256,
      storageKey: storage.bundleStorageKey,
      totalBytes,
      fileCount: files.length,
      manifestJson: manifest,
      uploadedByUserId: actor.userId,
    },
    update: {},
  });
  return {
    bundleId: row.id,
    assetBundleId: row.id,
    extractedFiles: extraction.filesByName,
    bundleSha256,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    manifest,
  };
}

function chromeSaveError(error: unknown, stage: "ASSET" | "DATABASE"): ApiError {
  if (error instanceof ApiError) return error;
  const code = prismaCode(error);
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

function specSaveError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (prismaCode(error) === "P2002") {
    return new ApiError(
      409,
      "REPORT_SPEC_CONFLICT",
      "Another version of this report was saved at the same time; reload and save again",
    );
  }
  return error;
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Loads the stored asset files a spec requires, keyed by file name (as the zip extractor does). */
async function loadStoredAssetFiles(
  assetBundleId: string | null,
  requiredAssets: Array<{ file_name: string }>,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!assetBundleId) return files;
  for (const required of requiredAssets) {
    const stored = await host.assetStoragePort.getAssetBuffer({
      bundleId: assetBundleId,
      relativePath: required.file_name,
    });
    if (stored) files.set(required.file_name, stored.buffer);
  }
  return files;
}

/* ------------------------------------------------------------------------ */
/* Authoring                                                                 */
/* ------------------------------------------------------------------------ */

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
  const extraction = await extractZip(zipBuffer);
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

const SPEC_AUTHOR_AUTHORITIES = ["report:approve", "report_engine:author"];

router.post("/report-engine/specs", async (request: Request, response: Response) => {
  requireAuthorities(request, SPEC_AUTHOR_AUTHORITIES);
  const body = parseOrThrow(specBodySchema, request.body ?? {});
  const spec = parseJson(body.specJson, ReportDescriptorSpecSchema);
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(spec);
  const zipBuffer = decodeZip(body.assetsZipBase64);
  const extraction = await extractZip(zipBuffer);
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

  const actor = await actorOf(request);
  const assetBundle = await storeAssets(zipBuffer, spec.required_assets, actor);
  const publish = Boolean(body.publish);
  const audit = auditBase(auditActor(request));
  let created;
  try {
    created = await client.$transaction(async (tx) => {
      const previous = await tx.reportDefinitionSpecRecord.findFirst({
        where: { code: spec.report.code },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = Math.max(spec.report.version, (previous?.version ?? 0) + 1);
      // The stored spec, the printed version and the hash all carry the row's version.
      const persistedSpec = { ...spec, report: { ...spec.report, version } };
      const specSha256 = sha256Of(persistedSpec);
      if (publish) {
        await tx.reportDefinitionSpecRecord.updateMany({
          where: { code: spec.report.code, isLatestPublished: true },
          data: { isLatestPublished: false },
        });
      }
      const row = await tx.reportDefinitionSpecRecord.create({
        data: {
          code: spec.report.code,
          version,
          category: spec.report.category,
          audienceScope: spec.report.audience_scope,
          status: publish ? "PUBLISHED" : "VERIFIED",
          isLatestPublished: publish,
          supportedLocales: Object.keys(spec.i18n.locales),
          defaultLocale: spec.i18n.default_locale,
          specJson: persistedSpec as never,
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
      await writeAudit(tx, {
        data: {
          ...audit,
          action: publish ? "REPORT_SPEC_PUBLISHED" : "REPORT_SPEC_VERIFIED",
          entityType: "REPORT_SPEC",
          entityId: row.id,
          beforeJson: null,
          afterJson: {
            code: row.code,
            version: row.version,
            status: row.status,
            specSha256,
            assetBundleId: assetBundle.assetBundleId,
          },
        } as never,
      });
      return row;
    });
  } catch (error) {
    throw specSaveError(error);
  }
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

/**
 * Publishes an existing VERIFIED version (so a Security Admin override applied
 * to it is kept). The stored spec is re-verified against the current catalog
 * first; the previous latest published version stops being the latest.
 */
router.post("/report-engine/specs/:id/publish", async (request: Request, response: Response) => {
  requireAuthorities(request, SPEC_AUTHOR_AUTHORITIES);
  parseOrThrow(z.object({}).strict(), request.body ?? {});
  const id = String(request.params.id);
  const existing = await client.reportDefinitionSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  if (existing.status !== "VERIFIED") {
    throw new ApiError(409, "REPORT_SPEC_NOT_VERIFIED", "Only a VERIFIED report version can be published", {
      status: existing.status,
    });
  }
  const spec = ReportDescriptorSpecSchema.parse(existing.specJson);
  const verification = await engine.verifyDescriptor({
    rawSpecJson: JSON.stringify(existing.specJson),
    extractedZipFiles: await loadStoredAssetFiles(existing.assetBundleId, spec.required_assets),
  });
  if (!verification.valid) {
    throw new ApiError(400, "REPORT_SPEC_VERIFICATION_FAILED", "The report spec no longer passes verification", {
      verification,
    });
  }
  const actor = await actorOf(request);
  const audit = auditBase(auditActor(request));
  let published;
  try {
    published = await client.$transaction(async (tx) => {
      const newer = await tx.reportDefinitionSpecRecord.findFirst({
        where: { code: existing.code, status: "PUBLISHED", version: { gt: existing.version } },
        select: { id: true, version: true },
      });
      if (newer) {
        throw new ApiError(
          409,
          "REPORT_SPEC_NEWER_VERSION_PUBLISHED",
          "A newer version of this report is already published",
          { publishedVersion: newer.version },
        );
      }
      const previousLatest = await tx.reportDefinitionSpecRecord.findFirst({
        where: { code: existing.code, isLatestPublished: true, id: { not: id } },
        select: { id: true, version: true },
      });
      await tx.reportDefinitionSpecRecord.updateMany({
        where: { code: existing.code, isLatestPublished: true, id: { not: id } },
        data: { isLatestPublished: false },
      });
      const now = new Date();
      // Conditional claim: two concurrent publishes cannot both flip the row.
      const claimed = await tx.reportDefinitionSpecRecord.updateMany({
        where: { id, status: "VERIFIED" },
        data: {
          status: "PUBLISHED",
          isLatestPublished: true,
          publishedByUserId: actor.userId,
          publishedAt: now,
          verificationReportJson: verification as never,
        },
      });
      if (claimed.count !== 1) {
        throw new ApiError(409, "REPORT_SPEC_NOT_VERIFIED", "Only a VERIFIED report version can be published");
      }
      await writeAudit(tx, {
        data: {
          ...audit,
          action: "REPORT_SPEC_PUBLISHED",
          entityType: "REPORT_SPEC",
          entityId: id,
          beforeJson: { status: existing.status, isLatestPublished: existing.isLatestPublished },
          afterJson: {
            code: existing.code,
            version: existing.version,
            status: "PUBLISHED",
            isLatestPublished: true,
            specSha256: existing.specSha256,
            authorityMode: existing.authorityMode,
            previousLatestSpecId: previousLatest?.id ?? null,
            previousLatestVersion: previousLatest?.version ?? null,
          },
        } as never,
      });
      return { id, code: existing.code, version: existing.version, status: "PUBLISHED" as const };
    });
  } catch (error) {
    throw specSaveError(error);
  }
  response.json({ ...published, verification });
});

router.post("/report-engine/specs/:id/archive", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "report_engine:author", "security:write"]);
  const id = String(request.params.id);
  const existing = await client.reportDefinitionSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  if (existing.status === "ARCHIVED") {
    response.json({ id, status: "ARCHIVED", isLatestPublished: false, promotedSpecId: null, promotedVersion: null });
    return;
  }
  const audit = auditBase(auditActor(request));
  const result = await client.$transaction(async (tx) => {
    const updated = await tx.reportDefinitionSpecRecord.update({
      where: { id },
      data: { status: "ARCHIVED", isLatestPublished: false },
    });
    // Archiving the latest published version promotes the previous published
    // version, so the report stays runnable.
    let promoted: { id: string; version: number } | null = null;
    if (existing.isLatestPublished) {
      promoted = await tx.reportDefinitionSpecRecord.findFirst({
        where: { code: existing.code, status: "PUBLISHED", id: { not: id } },
        orderBy: { version: "desc" },
        select: { id: true, version: true },
      });
      if (promoted) {
        await tx.reportDefinitionSpecRecord.update({
          where: { id: promoted.id },
          data: { isLatestPublished: true },
        });
      }
    }
    await writeAudit(tx, {
      data: {
        ...audit,
        action: "REPORT_SPEC_ARCHIVED",
        entityType: "REPORT_SPEC",
        entityId: id,
        beforeJson: { status: existing.status, isLatestPublished: existing.isLatestPublished },
        afterJson: {
          status: "ARCHIVED",
          isLatestPublished: false,
          promotedSpecId: promoted?.id ?? null,
          promotedVersion: promoted?.version ?? null,
        },
      } as never,
    });
    return { updated, promoted };
  });
  response.json({
    id: result.updated.id,
    status: result.updated.status,
    isLatestPublished: result.updated.isLatestPublished,
    promotedSpecId: result.promoted?.id ?? null,
    promotedVersion: result.promoted?.version ?? null,
  });
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
  const actor = await actorOf(request);
  if (!canApplySecurityOverride({ ...actor, role: principal.role ?? "UNKNOWN" }, host)) {
    throw new ApiError(403, "SECURITY_OVERRIDE_AUTHORITY_REQUIRED", "Only a Security Admin may override report authorities");
  }
  const body = parseOrThrow(overrideBodySchema, request.body ?? {});
  const id = String(request.params.id);
  const existing = await client.reportDefinitionSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
  const audit = auditBase(auditActor(request));

  if (body.clear) {
    const cleared = await client.$transaction(async (tx) => {
      const row = await tx.reportDefinitionSpecRecord.update({
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
      await writeAudit(tx, {
        data: {
          ...audit,
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
      return row;
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
    const approval = await client.$transaction(async (tx) => {
      const row = await tx.approvalRequest.create({
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
          makerUserId: principal.userId ?? actor.userId,
          state: "PENDING_REVIEW",
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      });
      await writeAudit(tx, {
        data: {
          ...audit,
          action: "REPORT_AML_BYPASS_REQUESTED",
          entityType: "REPORT_SPEC",
          entityId: id,
          beforeJson: null,
          afterJson: {
            approvalRequestId: row.id,
            allowedRoles: body.allowedRoles,
            allowedAuthorities: body.allowedAuthorities,
            justification: body.justification,
          },
        } as never,
      });
      return row;
    });
    response.status(202).json({
      id,
      approvalRequestId: approval.id,
      status: "PENDING_REVIEW",
      message: "A different MLRO or Security Admin must approve the confidential AML bypass",
    });
    return;
  }

  const updated = await client.$transaction(async (tx) => {
    const row = await tx.reportDefinitionSpecRecord.update({
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
    await writeAudit(tx, {
      data: {
        ...audit,
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
    return row;
  });
  response.json({ id: updated.id, authorityMode: updated.authorityMode });
});

/* ------------------------------------------------------------------------ */
/* Confidential AML bypass (four eyes)                                       */
/* ------------------------------------------------------------------------ */

const amlBypassDecisionSchema = z.object({ notes: z.string().max(2000).optional() }).strict();

const AML_BYPASS_CHECKER_ROLES = ["MLRO", "SECURITY_ADMIN"];

function unexpired(now: Date): Prisma.ApprovalRequestWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

async function loadPendingBypass(id: string, checkerUserId: string | null, now: Date) {
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval || approval.subjectType !== "REPORT_AML_BYPASS") {
    throw new ApiError(404, "AML_BYPASS_APPROVAL_NOT_FOUND", "The AML bypass approval does not exist");
  }
  if (approval.state !== "PENDING_REVIEW") {
    throw new ApiError(409, "AML_BYPASS_NOT_PENDING", "The AML bypass approval is not pending", {
      state: approval.state,
    });
  }
  if (approval.makerUserId === checkerUserId) {
    throw new ApiError(409, "APPROVAL_MAKER_EQUALS_CHECKER", "The maker and the checker must be different users");
  }
  return approval;
}

router.get("/report-engine/aml-bypass/pending", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write", "report:approve"]);
  const principal = principalOf(request);
  if (!AML_BYPASS_CHECKER_ROLES.includes(String(principal.role ?? ""))) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "Only an MLRO or Security Admin may review AML bypasses");
  }
  const rows = await client.approvalRequest.findMany({
    where: { subjectType: "REPORT_AML_BYPASS", state: "PENDING_REVIEW", ...unexpired(new Date()) },
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
        expiresAt: row.expiresAt,
        canDecide: row.makerUserId !== principal.userId,
      };
    }),
  });
});

router.post("/report-engine/aml-bypass/:id/approve", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write", "report:approve"]);
  const principal = principalOf(request);
  if (!AML_BYPASS_CHECKER_ROLES.includes(String(principal.role ?? ""))) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "Only an MLRO or Security Admin may approve an AML bypass");
  }
  if (!principal.userId) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "A named checker is required");
  }
  const checkerUserId = principal.userId;
  const id = String(request.params.id);
  const now = new Date();
  const approval = await loadPendingBypass(id, checkerUserId, now);
  if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(409, "AML_BYPASS_EXPIRED", "The AML bypass approval has expired; the maker must request it again");
  }
  const payload = approval.payloadDiffJson as Record<string, unknown>;
  const reportSpecId = String(payload.reportSpecId ?? approval.subjectId);
  const audit = auditBase(auditActor(request));
  const updated = await client.$transaction(async (tx) => {
    // Conditional claim (UPDATE ... WHERE state = 'PENDING_REVIEW' AND unexpired AND maker <> checker):
    // of two concurrent decisions only one changes the row.
    const claimed = await tx.approvalRequest.updateMany({
      where: {
        id,
        subjectType: "REPORT_AML_BYPASS",
        state: "PENDING_REVIEW",
        makerUserId: { not: checkerUserId },
        ...unexpired(now),
      },
      data: { checkerUserId, state: "APPROVED" },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "AML_BYPASS_NOT_PENDING", "The AML bypass approval is not pending");
    }
    const spec = await tx.reportDefinitionSpecRecord.findUnique({ where: { id: reportSpecId } });
    if (!spec) throw new ApiError(404, "REPORT_SPEC_NOT_FOUND", "The report spec does not exist");
    if (spec.status === "ARCHIVED") {
      throw new ApiError(409, "REPORT_SPEC_ARCHIVED", "The report spec was archived after the bypass was requested");
    }
    if (!spec.requiresConfidentialAml) {
      throw new ApiError(409, "AML_BYPASS_NOT_APPLICABLE", "The report no longer requires confidential AML access");
    }
    const row = await tx.reportDefinitionSpecRecord.update({
      where: { id: reportSpecId },
      data: {
        authorityMode: "SECURITY_ADMIN_OVERRIDE",
        overrideAllowedRoles: Array.isArray(payload.allowedRoles) ? (payload.allowedRoles as never) : [],
        overrideAllowedAuthorities: Array.isArray(payload.allowedAuthorities) ? (payload.allowedAuthorities as never) : [],
        overrideJustification: String(payload.justification ?? ""),
        allowConfidentialAmlBypass: true,
        overriddenByUserId: approval.makerUserId,
        overriddenAt: now,
      },
    });
    await writeAudit(tx, {
      data: {
        ...audit,
        action: "REPORT_AML_BYPASS_APPROVED",
        entityType: "REPORT_SPEC",
        entityId: reportSpecId,
        approvalRequestId: id,
        beforeJson: { approvalRequestId: id, state: "PENDING_REVIEW" },
        afterJson: { state: "APPROVED", checkerUserId },
      } as never,
    });
    return row;
  });
  response.json({ id: updated.id, approvalRequestId: id, state: "APPROVED", allowConfidentialAmlBypass: true });
});

router.post("/report-engine/aml-bypass/:id/reject", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:write", "report:approve"]);
  const principal = principalOf(request);
  if (!AML_BYPASS_CHECKER_ROLES.includes(String(principal.role ?? ""))) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "Only an MLRO or Security Admin may reject an AML bypass");
  }
  if (!principal.userId) {
    throw new ApiError(403, "AML_BYPASS_CHECKER_REQUIRED", "A named checker is required");
  }
  const checkerUserId = principal.userId;
  const id = String(request.params.id);
  const body = parseOrThrow(amlBypassDecisionSchema, request.body ?? {});
  const approval = await loadPendingBypass(id, checkerUserId, new Date());
  const audit = auditBase(auditActor(request));
  await client.$transaction(async (tx) => {
    const claimed = await tx.approvalRequest.updateMany({
      where: { id, subjectType: "REPORT_AML_BYPASS", state: "PENDING_REVIEW", makerUserId: { not: checkerUserId } },
      data: {
        checkerUserId,
        state: "REJECTED",
        rejectionReason: body.notes ?? "Rejected by MLRO/Security Admin",
      },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "AML_BYPASS_NOT_PENDING", "The AML bypass approval is not pending");
    }
    await writeAudit(tx, {
      data: {
        ...audit,
        action: "REPORT_AML_BYPASS_REJECTED",
        entityType: "REPORT_SPEC",
        entityId: approval.subjectId,
        approvalRequestId: id,
        beforeJson: { approvalRequestId: id, state: "PENDING_REVIEW" },
        afterJson: { state: "REJECTED", checkerUserId, notes: body.notes ?? null },
      } as never,
    });
  });
  response.json({ id, state: "REJECTED" });
});

/* ------------------------------------------------------------------------ */
/* Catalog and execution (any authenticated staff; per-report policy here)   */
/* ------------------------------------------------------------------------ */

router.get("/report-engine/catalog", async (request: Request, response: Response) => {
  const actor = await actorOf(request);
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
      ? { audienceScope: { in: ["BACKOFFICE_INTERNAL", "BOTH"] } }
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
  const rows = await client.reportDefinitionSpecRecord.findMany({ where, orderBy });
  const allowed = rows
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
  const total = allowed.length;
  const items = allowed.slice((page - 1) * pageSize, page * pageSize);
  response.json({ reports: items, total });
});

router.get("/report-engine/autocomplete/:sourceKey", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const sourceKey = String(request.params.sourceKey);
  const provider = host.autocompleteProviders[sourceKey];
  if (!provider) throw new ApiError(404, "AUTOCOMPLETE_SOURCE_NOT_FOUND", "The autocomplete source does not exist");
  if (!holdsAny(principal, [provider.requiredAuthority, "security:write"])) {
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
    limit: Math.min(Number(request.query.limit ?? 20) || 20, 50),
    actor: await actorOf(request),
    dependentValues,
  });
  response.json({ items });
});

router.post("/report-engine/catalog/:code/execute", async (request: Request, response: Response) => {
  const actor = await actorOf(request);
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
  const registry = await loadChromeRegistry();
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
    throw toReportExecutionError(error);
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

/* ------------------------------------------------------------------------ */
/* Header / footer chrome                                                    */
/* ------------------------------------------------------------------------ */

type ChromeRow = Awaited<ReturnType<typeof client.reportChromeSpecRecord.findMany>>[number];

async function chromeAssetDataUrls(row: ChromeRow, spec: ReportChromeSpec): Promise<Record<string, string>> {
  const assetDataUrls: Record<string, string> = {};
  if (!row.assetBundleId) return assetDataUrls;
  for (const required of spec.required_assets) {
    const stored = await host.assetStoragePort.getAssetBuffer({
      bundleId: row.assetBundleId,
      relativePath: required.file_name,
    });
    if (stored) {
      assetDataUrls[required.asset_key] = `data:${stored.mimeType};base64,${stored.buffer.toString("base64")}`;
    }
  }
  return assetDataUrls;
}

async function chromeView(row: ChromeRow, includeAssets: boolean) {
  const spec = ReportChromeSpecSchema.parse(row.specJson);
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    name: row.name,
    chromeType: row.chromeType,
    status: row.status,
    isDefaultGlobal: row.isDefaultGlobal,
    supportedLocales: row.supportedLocales,
    assetBundleId: row.assetBundleId,
    assetDataUrls: includeAssets ? await chromeAssetDataUrls(row, spec) : {},
    spec,
  };
}

const truthyFlag = (value: unknown): boolean => value === "1" || value === "true";

/**
 * Chrome list. Authors (report:approve, report_engine:author, security:write)
 * see every status; everyone else sees published chrome only. Asset data URLs
 * are inlined only with `includeAssets=1`.
 */
router.get("/report-engine/chrome", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const isAuthor = holdsAny(principal, CHROME_AUTHOR_AUTHORITIES);
  const type = typeof request.query.type === "string" ? request.query.type : undefined;
  const includeArchived = truthyFlag(request.query.includeArchived);
  const includeAssets = truthyFlag(request.query.includeAssets);
  const page = Math.max(1, Number(request.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 200) || 200));
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const sortKey = typeof request.query.sortKey === "string" ? request.query.sortKey : "";
  const sortDirection: "asc" | "desc" = request.query.sortDirection === "asc" ? "asc" : "desc";
  const where: Prisma.ReportChromeSpecRecordWhereInput = {
    ...(type === "HEADER" || type === "FOOTER" ? { chromeType: type } : {}),
    ...(!isAuthor ? { status: "PUBLISHED" as const } : includeArchived ? {} : { status: { not: "ARCHIVED" as const } }),
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
  for (const row of rows) specs.push(await chromeView(row, includeAssets));
  response.json({ specs, total });
});

/** One chrome with its assets inlined (preview). Non-authors only reach published chrome. */
router.get("/report-engine/chrome/:id", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const id = parseOrThrow(z.string().uuid(), String(request.params.id));
  const row = await client.reportChromeSpecRecord.findUnique({ where: { id } });
  if (!row || (row.status !== "PUBLISHED" && !holdsAny(principal, CHROME_AUTHOR_AUTHORITIES))) {
    throw new ApiError(404, "REPORT_CHROME_SPEC_NOT_FOUND", "The chrome spec does not exist");
  }
  response.json(await chromeView(row, true));
});

router.post("/report-engine/chrome", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "security:write"]);
  const body = parseOrThrow(chromeBodySchema, request.body ?? {});
  const spec = parseJson(body.specJson, ReportChromeSpecSchema);
  const rawSpecJson = typeof body.specJson === "string" ? body.specJson : JSON.stringify(spec);
  const zipBuffer = decodeZip(body.assetsZipBase64);
  const extraction = await extractZip(zipBuffer);
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
  const actor = await actorOf(request);
  let assetBundle;
  try {
    assetBundle = await storeAssets(zipBuffer, spec.required_assets, actor);
  } catch (error) {
    console.error(`[${request.requestId}] report chrome asset storage failed: ${(error as Error)?.message ?? "unknown"}`);
    throw chromeSaveError(error, "ASSET");
  }
  const specSha256 = createHash("sha256").update(rawSpecJson).digest("hex");
  const publish = Boolean(body.publish);
  const audit = auditBase(auditActor(request));
  let created;
  try {
    created = await client.$transaction(async (tx) => {
      const previous = await tx.reportChromeSpecRecord.findFirst({
        where: { code: spec.chrome.code },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = Math.max(1, (previous?.version ?? 0) + 1);
      let superseded: Array<{ id: string; version: number; isDefaultGlobal: boolean }> = [];
      if (publish) {
        // Publishing supersedes every earlier published version of the code:
        // they are archived and a default flag moves to the new version.
        superseded = await tx.reportChromeSpecRecord.findMany({
          where: { code: spec.chrome.code, status: "PUBLISHED" },
          select: { id: true, version: true, isDefaultGlobal: true },
        });
        if (superseded.length > 0) {
          await tx.reportChromeSpecRecord.updateMany({
            where: { id: { in: superseded.map((row) => row.id) } },
            data: { status: "ARCHIVED", isDefaultGlobal: false },
          });
        }
      }
      const makeDefault = publish && (Boolean(body.makeDefault) || superseded.some((row) => row.isDefaultGlobal));
      if (makeDefault) {
        await tx.reportChromeSpecRecord.updateMany({
          where: { chromeType: spec.chrome.chrome_type, isDefaultGlobal: true },
          data: { isDefaultGlobal: false },
        });
      }
      const row = await tx.reportChromeSpecRecord.create({
        data: {
          code: spec.chrome.code,
          version,
          name: spec.chrome.name,
          chromeType: spec.chrome.chrome_type,
          status: publish ? "PUBLISHED" : "VERIFIED",
          isDefaultGlobal: makeDefault,
          supportedLocales: Object.keys(spec.i18n.locales),
          specJson: spec as never,
          specSha256,
          assetBundleId: assetBundle.assetBundleId,
          createdByUserId: actor.userId,
          publishedByUserId: publish ? actor.userId : null,
          publishedAt: publish ? new Date() : null,
        },
      });
      await writeAudit(tx, {
        data: {
          ...audit,
          action: "REPORT_CHROME_SPEC_SAVED",
          entityType: "REPORT_CHROME_SPEC",
          entityId: row.id,
          beforeJson: superseded.length > 0 ? { superseded } : null,
          afterJson: {
            code: row.code,
            version: row.version,
            chromeType: row.chromeType,
            status: row.status,
            isDefaultGlobal: row.isDefaultGlobal,
            specSha256,
          },
        } as never,
      });
      return { row, supersededIds: superseded.map((entry) => entry.id) };
    });
  } catch (error) {
    console.error(`[${request.requestId}] report chrome database save failed: ${(error as Error)?.message ?? "unknown"}`);
    throw chromeSaveError(error, "DATABASE");
  }
  response.status(201).json({
    id: created.row.id,
    code: created.row.code,
    version: created.row.version,
    status: created.row.status,
    isDefaultGlobal: created.row.isDefaultGlobal,
    supersededIds: created.supersededIds,
    verification,
  });
});

router.post("/report-engine/chrome/:id/archive", async (request: Request, response: Response) => {
  requireAuthorities(request, ["report:approve", "security:write"]);
  const id = String(request.params.id);
  const existing = await client.reportChromeSpecRecord.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "REPORT_CHROME_SPEC_NOT_FOUND", "The chrome spec does not exist");
  if (existing.status === "ARCHIVED") {
    response.json({ id, status: "ARCHIVED", isDefaultGlobal: false, archived: true });
    return;
  }
  const audit = auditBase(auditActor(request));
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.reportChromeSpecRecord.update({
      where: { id },
      data: { status: "ARCHIVED", isDefaultGlobal: false },
    });
    await writeAudit(tx, {
      data: {
        ...audit,
        action: "REPORT_CHROME_SPEC_ARCHIVED",
        entityType: "REPORT_CHROME_SPEC",
        entityId: id,
        beforeJson: { status: existing.status, isDefaultGlobal: existing.isDefaultGlobal },
        afterJson: { status: "ARCHIVED", isDefaultGlobal: false },
      } as never,
    });
    return row;
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
  const audit = auditBase(auditActor(request));
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
    await writeAudit(tx, {
      data: {
        ...audit,
        action: "REPORT_CHROME_DEFAULT_CHANGED",
        entityType: "REPORT_CHROME_SPEC",
        entityId: id,
        beforeJson: { isDefaultGlobal: existing.isDefaultGlobal },
        afterJson: { isDefaultGlobal: body.isDefault, chromeType: existing.chromeType },
      } as never,
    });
  });
  response.json({ id, isDefaultGlobal: body.isDefault });
});
