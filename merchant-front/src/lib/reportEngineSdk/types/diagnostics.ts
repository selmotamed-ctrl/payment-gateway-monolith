export type ReportDiagnosticLayer = 1 | 2 | 3 | 4 | 5;
export type ReportDiagnosticSeverity = "error" | "warning";

export interface ReportDiagnostic {
  layer: ReportDiagnosticLayer;
  severity: ReportDiagnosticSeverity;
  path: string;
  code: string;
  message: string;
  aiFixHint?: string;
}
