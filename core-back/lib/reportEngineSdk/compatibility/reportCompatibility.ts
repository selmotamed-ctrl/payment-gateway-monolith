import { ReportDescriptorSpecSchema, type ReportDescriptorSpec } from "../types/reportSpec";
import {
  REPORT_ENGINE_VERSION,
  REPORT_SPEC_VERSION,
  isSupportedEngineVersion,
  isSupportedReportSpecVersion,
  majorVersionOf,
} from "../version";

export type CompatibilityStatus = "COMPATIBLE" | "NEEDS_MIGRATION" | "INVALID";

export type CompatibilityReasonCode =
  | "ENGINE_MAJOR_VERSION_MISMATCH"
  | "SPEC_VERSION_UNSUPPORTED"
  | "MISSING_VERSION_METADATA"
  | "INVALID_SPEC_JSON"
  | "CURRENT_SCHEMA_VALIDATION_FAILED"
  | "WRONG_SPEC_KIND";

export interface CompatibilityIssue {
  path: string;
  code: string;
  message: string;
}

export interface ReportCompatibilityResult {
  status: CompatibilityStatus;
  reasonCode: CompatibilityReasonCode | null;
  message: string;
  storedEngineVersion: string | null;
  storedSpecVersion: string | null;
  currentEngineVersion: string;
  currentSpecVersion: string;
  declaredSpecVersion: string | null;
  issues: CompatibilityIssue[];
  promptAvailable: boolean;
}

export interface ClassifyStoredReportSpecInput {
  specJson: unknown;
  storedEngineVersion?: string | null;
  storedSpecVersion?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function declaredVersion(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record?.spec_version === "string" ? record.spec_version : null;
}

function declaredKind(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record?.spec_kind === "string" ? record.spec_kind : null;
}

function issuesFromZod(error: unknown): CompatibilityIssue[] {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; code?: string; message?: string }> } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    path: (issue.path ?? []).join(".") || "<root>",
    code: issue.code ?? "INVALID",
    message: issue.message ?? "Invalid value",
  }));
}

export function classifyStoredReportSpec(
  input: ClassifyStoredReportSpecInput,
): ReportCompatibilityResult {
  const parsed = parseJsonValue(input.specJson);
  const declared = declaredVersion(parsed);
  const kind = declaredKind(parsed);
  const storedEngineVersion = input.storedEngineVersion ?? null;
  const storedSpecVersion = input.storedSpecVersion ?? declared;
  const base = {
    storedEngineVersion,
    storedSpecVersion,
    currentEngineVersion: REPORT_ENGINE_VERSION,
    currentSpecVersion: REPORT_SPEC_VERSION,
    declaredSpecVersion: declared,
    promptAvailable: true,
  };

  if (parsed === undefined) {
    return {
      ...base,
      status: "INVALID",
      reasonCode: "INVALID_SPEC_JSON",
      message: "The stored report spec is not valid JSON.",
      issues: [],
    };
  }

  if (kind !== "REPORT_DESCRIPTOR") {
    return {
      ...base,
      status: "INVALID",
      reasonCode: "WRONG_SPEC_KIND",
      message: "The stored report spec is not a REPORT_DESCRIPTOR.",
      issues: [{ path: "spec_kind", code: "WRONG_SPEC_KIND", message: "Expected REPORT_DESCRIPTOR." }],
    };
  }

  if (!storedEngineVersion || !storedSpecVersion) {
    return {
      ...base,
      status: "NEEDS_MIGRATION",
      reasonCode: "MISSING_VERSION_METADATA",
      message: "The stored report spec has no recorded engine/spec version.",
      issues: [],
    };
  }

  const storedMajor = majorVersionOf(storedEngineVersion);
  if (!isSupportedEngineVersion(storedEngineVersion)) {
    return {
      ...base,
      status: "NEEDS_MIGRATION",
      reasonCode: "ENGINE_MAJOR_VERSION_MISMATCH",
      message: `The report was saved for engine version ${storedEngineVersion}; this engine is ${REPORT_ENGINE_VERSION}.`,
      issues: [
        {
          path: "engine_version",
          code: "ENGINE_MAJOR_VERSION_MISMATCH",
          message: `Engine major ${storedMajor ?? "unknown"} is not supported.`,
        },
      ],
    };
  }

  if (!isSupportedReportSpecVersion(storedSpecVersion)) {
    return {
      ...base,
      status: "NEEDS_MIGRATION",
      reasonCode: "SPEC_VERSION_UNSUPPORTED",
      message: `The report uses spec version ${storedSpecVersion}; this engine supports ${REPORT_SPEC_VERSION}.`,
      issues: [
        {
          path: "spec_version",
          code: "SPEC_VERSION_UNSUPPORTED",
          message: `Spec version ${storedSpecVersion} is not supported.`,
        },
      ],
    };
  }

  const parsedSpec = ReportDescriptorSpecSchema.safeParse(parsed);
  if (!parsedSpec.success) {
    return {
      ...base,
      status: "INVALID",
      reasonCode: "CURRENT_SCHEMA_VALIDATION_FAILED",
      message: "The stored report spec does not match the current schema.",
      issues: issuesFromZod(parsedSpec.error),
    };
  }

  return {
    ...base,
    status: "COMPATIBLE",
    reasonCode: null,
    message: "The stored report spec is compatible with the running engine.",
    issues: [],
    promptAvailable: false,
  };
}

export function safeParseStoredReportSpec(
  input: ClassifyStoredReportSpecInput,
):
  | { ok: true; spec: ReportDescriptorSpec; compatibility: ReportCompatibilityResult }
  | { ok: false; compatibility: ReportCompatibilityResult } {
  const compatibility = classifyStoredReportSpec(input);
  if (compatibility.status !== "COMPATIBLE") return { ok: false, compatibility };
  const parsed = parseJsonValue(input.specJson);
  const result = ReportDescriptorSpecSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      compatibility: {
        ...compatibility,
        status: "INVALID",
        reasonCode: "CURRENT_SCHEMA_VALIDATION_FAILED",
        message: "The stored report spec does not match the current schema.",
        issues: issuesFromZod(result.error),
        promptAvailable: true,
      },
    };
  }
  return { ok: true, spec: result.data, compatibility };
}

export function isReportCompatible(result: ReportCompatibilityResult): boolean {
  return result.status === "COMPATIBLE";
}
