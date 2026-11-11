import { describe, expect, test } from "bun:test";
import { canTransitionIncident, incidentPostmortemDueAt, incidentReportPayload, incidentRequiresPostmortem } from "../engine/compliance/incidents";

describe("incident lifecycle", () => {
  test("allows only forward recovery transitions and a terminal close", () => {
    expect(canTransitionIncident("DETECTED", "DECLARED")).toBe(true);
    expect(canTransitionIncident("DECLARED", "CONTAINED")).toBe(true);
    expect(canTransitionIncident("CONTAINED", "RESOLVED")).toBe(true);
    expect(canTransitionIncident("RESOLVED", "POSTMORTEM")).toBe(true);
    expect(canTransitionIncident("POSTMORTEM", "CLOSED")).toBe(true);
    expect(canTransitionIncident("CLOSED", "DETECTED")).toBe(false);
    expect(canTransitionIncident("DECLARED", "CLOSED")).toBe(false);
    expect(canTransitionIncident("DETECTED", "DETECTED")).toBe(false);
  });

  test("requires a postmortem for high severity and security/data incidents", () => {
    expect(incidentRequiresPostmortem({ severity: "SEV1", category: "AVAILABILITY" })).toBe(true);
    expect(incidentRequiresPostmortem({ severity: "SEV3", category: "SECURITY" })).toBe(true);
    expect(incidentRequiresPostmortem({ severity: "SEV3", category: "AVAILABILITY" })).toBe(false);
    expect(incidentPostmortemDueAt(new Date("2026-01-01T00:00:00Z"), "SEV1").toISOString()).toBe("2026-01-06T00:00:00.000Z");
  });

  test("builds a filing payload without leaking ciphertext or internal ids", () => {
    const payload = incidentReportPayload({
      incident: { reference: "INC-1", severity: "SEV2", summary: "Gateway outage" },
      timeline: [{ type: "DECLARED", summary: "Declared" }],
      actions: [{ title: "Restore rail", status: "DONE" }],
      communications: [{ channel: "REGULATOR", subject: "Notice" }],
      generatedAt: new Date("2026-02-01T00:00:00Z"),
    });
    expect(payload.reportType).toBe("INCIDENT");
    expect(payload.returnCode).toBe("INC");
    expect(payload.generatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect((payload.narrative as Record<string, string>).summary).toContain("Gateway outage");
    expect(JSON.stringify(payload)).not.toContain("payloadCiphertext");
  });
});
