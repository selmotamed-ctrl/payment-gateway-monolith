export type IncidentStatus =
  | "DETECTED"
  | "TRIAGED"
  | "DECLARED"
  | "CONTAINED"
  | "MONITORING"
  | "RESOLVED"
  | "POSTMORTEM"
  | "CLOSED";

export type IncidentSeverity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  DETECTED: ["TRIAGED", "DECLARED"],
  TRIAGED: ["DECLARED", "MONITORING"],
  DECLARED: ["CONTAINED"],
  CONTAINED: ["MONITORING", "RESOLVED"],
  MONITORING: ["RESOLVED", "CONTAINED"],
  RESOLVED: ["POSTMORTEM", "CLOSED"],
  POSTMORTEM: ["CLOSED"],
  CLOSED: [],
};

export const canTransitionIncident = (from: IncidentStatus, to: IncidentStatus): boolean =>
  INCIDENT_TRANSITIONS[from]?.includes(to) ?? false;

export const incidentTimestampField = (status: IncidentStatus): "declaredAt" | "containedAt" | "resolvedAt" | "closedAt" | null => {
  switch (status) {
    case "DECLARED": return "declaredAt";
    case "CONTAINED": return "containedAt";
    case "RESOLVED": return "resolvedAt";
    case "CLOSED": return "closedAt";
    default: return null;
  }
};

export const incidentRequiresPostmortem = (input: { severity: IncidentSeverity; category: string }): boolean =>
  input.severity === "SEV1" || input.severity === "SEV2" || input.category === "SECURITY" || input.category === "DATA_INTEGRITY";

export const incidentPostmortemDueAt = (resolvedAt: Date, severity: IncidentSeverity): Date =>
  new Date(resolvedAt.getTime() + (severity === "SEV1" ? 5 : severity === "SEV2" ? 7 : 14) * 24 * 60 * 60 * 1000);

export const incidentReportPayload = (input: {
  incident: Record<string, unknown>;
  timeline: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  communications: Array<Record<string, unknown>>;
  generatedAt?: Date;
}): Record<string, unknown> => ({
  reportType: "INCIDENT",
  returnCode: "INC",
  generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  incident: input.incident,
  narrative: {
    summary: `${String(input.incident.title ?? "")}: ${String(input.incident.summary ?? "")}`.trim(),
    impact: `Impact scope: ${String(input.incident.impactScope ?? "")}. Affected services: ${(Array.isArray(input.incident.affectedServices) ? input.incident.affectedServices.join(", ") : "") || "none recorded"}.`,
    rootCause: String(input.incident.rootCause ?? "Under investigation"),
    response: input.timeline.map((entry) => `${String(entry.occurredAt ?? "")} — ${String(entry.summary ?? "")}`).join("\n\n"),
    remediation: input.actions.length > 0
      ? input.actions.map((action) => `${String(action.title ?? "")} (${String(action.status ?? "")})`).join("\n")
      : "No corrective actions have been recorded yet.",
  },
  timeline: input.timeline,
  correctiveActions: input.actions,
  communications: input.communications,
});
