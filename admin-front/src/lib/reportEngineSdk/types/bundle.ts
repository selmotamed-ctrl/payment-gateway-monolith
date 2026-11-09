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
  inputsUsed: Record<string, unknown>;
  rowCountTotal: number;
  durationMs: number;
  servedByNode: string;
}
