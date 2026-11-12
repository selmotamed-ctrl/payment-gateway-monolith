import { majorVersionOf, REPORT_ENGINE_VERSION } from "../version";

export type MigrationSubject = "REPORT" | "CHROME";

export interface ReportEngineMigrationGuide {
  id: string;
  subject: MigrationSubject;
  fromEngineMajor: number;
  toEngineMajor: number;
  summary: string;
  breakingChanges: string[];
  promptNotes: string[];
}

/**
 * Every executable major transition must add a guide here. The migration prompt
 * builder falls back to a generic prompt when no guide exists, but the engine
 * version policy requires a guide for production major bumps.
 */
export const REPORT_ENGINE_MIGRATION_GUIDES: readonly ReportEngineMigrationGuide[] = [];

export function findMigrationGuide(
  subject: MigrationSubject,
  fromEngineVersion: string | null,
  toEngineVersion = REPORT_ENGINE_VERSION,
): ReportEngineMigrationGuide | null {
  const fromMajor = majorVersionOf(fromEngineVersion);
  const toMajor = majorVersionOf(toEngineVersion);
  if (fromMajor === null || toMajor === null) return null;
  return (
    REPORT_ENGINE_MIGRATION_GUIDES.find(
      (guide) =>
        guide.subject === subject &&
        guide.fromEngineMajor === fromMajor &&
        guide.toEngineMajor === toMajor,
    ) ?? null
  );
}
