import type { ReportDiagnostic } from "@/lib/reportEngineSdk";
import { extractApiError, extractApiErrorPayload } from "@/utils/errors/extractor";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeDiagnostic = (value: unknown): ReportDiagnostic | null => {
  if (!isRecord(value)) return null;
  const rawLayer = Number(value.layer);
  const layer = [1, 2, 3, 4, 5].includes(rawLayer) ? rawLayer : 1;
  const severity = value.severity === "warning" ? "warning" : "error";
  const rawPath = Array.isArray(value.path) ? value.path.join(".") : value.path;
  return {
    layer: layer as ReportDiagnostic["layer"],
    severity,
    path: rawPath ? String(rawPath) : "<root>",
    code: String(value.code ?? "UNKNOWN"),
    message: String(value.message ?? ""),
    aiFixHint: typeof value.aiFixHint === "string" ? value.aiFixHint : undefined,
  };
};

/** Extracts report diagnostics from a verification response or an API error envelope. */
export function diagnosticsFromApiError(error: unknown): ReportDiagnostic[] {
  const payload = extractApiErrorPayload(error);
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload
      .map((item) => normalizeDiagnostic(item))
      .filter((item): item is ReportDiagnostic => Boolean(item));
  }
  if (!isRecord(payload)) return [];
  const verification = isRecord(payload.verification) ? payload.verification : null;
  const candidates = [
    verification?.diagnostics,
    payload.diagnostics,
    payload.issues,
  ].find((candidate) => Array.isArray(candidate));
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((item) => normalizeDiagnostic(item))
    .filter((item): item is ReportDiagnostic => Boolean(item));
}

const FRIENDLY_TITLES: Record<string, string> = {
  INVALID_JSON_SYNTAX: "The spec is not valid JSON",
  SCHEMA_VALIDATION_ERROR: "The spec does not match the required schema",
  MISSING_DEFAULT_LOCALE_AR: "Arabic translations are missing",
  MISSING_I18N_KEY_FOR_LOCALE: "A translation is missing",
  UNKNOWN_SECTION_FIELD: "A section references an unknown field",
  UNKNOWN_SECTION_DATASET: "A section references an unknown dataset",
  UNKNOWN_VISIBILITY_DATASET: "A section visibility rule references an unknown dataset",
  UNKNOWN_TRANSFORM_DATASET: "A transform references an unknown dataset",
  MANDATORY_PARTITION_FILTER_MISSING: "A large table query needs a bounded date filter",
  PARTITION_DATE_RANGE_UNBOUNDED: "The date range is too large",
  FORBIDDEN_SECRET_COLUMN: "A forbidden secret column was requested",
  MERCHANT_ISOLATION_FILTER_MISSING: "A merchant report is missing its merchant filter",
  MERCHANT_MODEL_OUT_OF_SCOPE: "A merchant report uses a model outside merchant scope",
  MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED: "A merchant report uses a staff-only autocomplete source",
  QUERY_COMPILATION_FAILED: "The query could not be compiled",
  QUERY_COST_EXCEEDED: "The query is too expensive",
  SEQUENTIAL_SCAN_DETECTED: "The query may scan too many rows",
  REQUIRED_ASSET_MISSING_FROM_ZIP: "The asset bundle is missing a required file",
  ASSET_PATH_TRAVERSAL_DETECTED: "The asset bundle contains an unsafe path",
  ASSET_MAGIC_BYTE_MISMATCH: "An asset file type does not match its extension",
  ASSET_DUPLICATE_BASENAME: "The asset bundle contains duplicate file names",
  UNSAFE_HTML_TAG_FORBIDDEN: "The template contains unsafe HTML",
  UNSAFE_HTML_ATTRIBUTE_FORBIDDEN: "The template contains unsafe attributes",
  UNSAFE_CSS_CONSTRUCT_FORBIDDEN: "The stylesheet contains an unsafe rule",
  UNSAFE_EXTERNAL_URL_FORBIDDEN: "The template contains an external URL",
  ZERO_NATURAL_ROLE_INTERSECTION: "No single default role can access this cross-domain report",
  SUGGESTED_ACCESS_CONFLICT: "The suggested access policy conflicts with the queried models",
  REPORT_NOT_PUBLISHED: "This report is not published",
  REPORT_NOT_FOUND: "This report could not be found",
  REPORT_CHROME_SAVE_FAILED: "The header/footer could not be saved",
  REPORT_CHROME_ASSET_SAVE_FAILED: "The header/footer assets could not be stored",
  REPORT_CHROME_DUPLICATE: "A header/footer with this code and version already exists",
  REPORT_CHROME_VERIFICATION_FAILED: "The header/footer failed validation",
  REPORT_SPEC_VERIFICATION_FAILED: "The report spec failed validation",
  INVALID_BODY: "The request contains invalid data",
  REPORT_SPEC_CONFLICT: "Someone saved this report at the same time. Refresh the version history and try again.",
  REPORT_ASSET_ZIP_TOO_LARGE: "The asset bundle is larger than 15 MB",
  REPORT_LOCK_TIMEOUT: "The database was busy and the request timed out. Try again in a moment.",
  REPORT_COMPILE_ERROR: "The report query could not be compiled",
  REPORT_SPEC_NOT_FOUND: "This report version could not be found",
  REPORT_ASSET_BUNDLE_INVALID: "The asset bundle is invalid",
};

/** Message shown when the client-side 15 MB zip check fails (same text as REPORT_ASSET_ZIP_TOO_LARGE). */
export const ASSET_ZIP_TOO_LARGE_MESSAGE = FRIENDLY_TITLES.REPORT_ASSET_ZIP_TOO_LARGE!;

type Translate = (key: string, ...params: unknown[]) => string;
const identity: Translate = (key) => key;

/** `true` when the code has a curated, translatable title. */
export function hasFriendlyTitle(code: string | null | undefined): boolean {
  return Boolean(code && Object.prototype.hasOwnProperty.call(FRIENDLY_TITLES, code));
}

export function friendlyDiagnosticTitle(code: string, t: Translate = identity): string {
  const curated = FRIENDLY_TITLES[code];
  if (curated) return t(curated);
  const humanised = code.replaceAll("_", " ").toLowerCase();
  return humanised.charAt(0).toUpperCase() + humanised.slice(1);
}

/**
 * Friendly, translated message for an API error: a curated title for known report-engine codes, otherwise the
 * server's own message (unknown codes never get a humanised code instead of the real explanation).
 */
export function friendlyApiErrorMessage(error: unknown, t: Translate = identity): string {
  const extracted = extractApiError(error);
  if (!extracted) {
    // A proxy/body-parser 413 has no JSON envelope; it is always the upload being too large.
    if ((error as { response?: { status?: number } } | null)?.response?.status === 413) {
      return t(ASSET_ZIP_TOO_LARGE_MESSAGE);
    }
    if (error instanceof Error && error.message) return error.message;
    return t("An unexpected error occurred.");
  }
  if (hasFriendlyTitle(extracted.code)) return t(FRIENDLY_TITLES[extracted.code]!);
  return extracted.error || t("An unexpected error occurred.");
}
