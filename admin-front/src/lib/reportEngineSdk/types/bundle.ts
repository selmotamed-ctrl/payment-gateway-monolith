import type { ReportDescriptorSpec } from "./reportSpec";
import type { ReportChromeSpec } from "./chromeSpec";

export interface ReportExecutionBundle {
  executionId: string;
  executedAtIso: string;
  verificationSha256: string;
  spec: ReportDescriptorSpec;
  resolvedHeaderChrome: ReportChromeSpec | null;
  resolvedFooterChrome: ReportChromeSpec | null;
  datasets: Record<string, Array<Record<string, unknown>>>;
  assetDataUrls: Record<string, string>;
  actor: { name: string; email: string; role: string };
  institutionName?: string;
  chromeVariables?: Record<string, string>;
  /** ISO 4217 code used for CURRENCY_MINOR values when a row carries no currency column. */
  currency?: string;
  inputsUsed: Record<string, unknown>;
  rowCountTotal: number;
  durationMs: number;
  servedByNode: string;
  /** Present on Studio mock previews; live executions omit it. */
  previewMode?: "MOCK";
}
