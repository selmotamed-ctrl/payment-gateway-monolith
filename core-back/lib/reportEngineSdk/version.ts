/**
 * Canonical authoring/runtime contract versions.
 *
 * The engine major version is the compatibility gate for stored specs. A major
 * bump means previously stored reports and chrome are no longer executable
 * without migration. Spec versions identify the serialized schema; transcript
 * versions identify the AI authoring contract.
 */
export const REPORT_ENGINE_VERSION = "1.0.0" as const;
export const REPORT_SPEC_VERSION = "1.0" as const;
export const REPORT_TRANSCRIPT_VERSION = "1.1" as const;
export const REPORT_CHROME_SPEC_VERSION = "1.0" as const;
export const REPORT_CHROME_TRANSCRIPT_VERSION = "1.1" as const;

export const SUPPORTED_REPORT_ENGINE_MAJORS = [1] as const;
export const SUPPORTED_REPORT_SPEC_VERSIONS = [REPORT_SPEC_VERSION] as const;
export const SUPPORTED_REPORT_CHROME_SPEC_VERSIONS = [REPORT_CHROME_SPEC_VERSION] as const;

export const REPORT_ENGINE_VERSION_MAJOR = Number.parseInt(REPORT_ENGINE_VERSION, 10);

export function majorVersionOf(version: string | null | undefined): number | null {
  if (!version) return null;
  const match = /^(\d+)/.exec(String(version).trim());
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  return Number.isFinite(major) ? major : null;
}

export function isSupportedEngineVersion(version: string | null | undefined): boolean {
  const major = majorVersionOf(version);
  return major !== null && (SUPPORTED_REPORT_ENGINE_MAJORS as readonly number[]).includes(major);
}

export function isSupportedReportSpecVersion(version: string | null | undefined): boolean {
  return Boolean(version) && (SUPPORTED_REPORT_SPEC_VERSIONS as readonly string[]).includes(String(version));
}

export function isSupportedChromeSpecVersion(version: string | null | undefined): boolean {
  return Boolean(version) && (SUPPORTED_REPORT_CHROME_SPEC_VERSIONS as readonly string[]).includes(String(version));
}
