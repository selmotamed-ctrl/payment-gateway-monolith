import { describe, expect, test } from "bun:test";
import { compileXsd } from "../engine/compliance/reporting/XsdCompiler";
import { ReportGenerationService } from "../engine/compliance/reporting/ReportGenerationService";
import type { GoamlMappingBlueprint } from "../engine/compliance/reporting/types";

const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="report"><xs:complexType><xs:sequence><xs:element name="code" type="xs:string"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;

describe("ReportGenerationService", () => {
  test("generates, hashes and stores a current output bound to the payload hash", async () => {
    const ast = compileXsd(xsd);
    const mapping: GoamlMappingBlueprint = {
      schemaVersion: 1,
      repeatingNodes: [],
      fieldBindings: [{ xsdPath: "/report/code", sourceKind: "CONSTANT", constantValue: "STR" }],
      codeMaps: {},
      assertions: [],
    };
    const schema = {
      id: "schema-1",
      status: "CONFIRMED",
      format: "XML",
      authority: "CBL",
      reportType: "SUSPICIOUS_ACTIVITY",
      reportCode: "STR",
      version: 1,
      compiledDefinitionJson: ast,
      mappingBlueprintJson: mapping,
      templateCiphertext: null,
    };
    const outputs: any[] = [];
    const db: any = {
      regulatorySchemaDefaultBinding: { findFirst: async () => ({ schema }) },
      regulatoryRuleSchemaBinding: { findFirst: async () => null },
      $queryRawUnsafe: async () => [],
      $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
      regulatoryReportOutput: {
        findFirst: async ({ where }: any) => outputs.find((row) => row.reportId === where.reportId && row.format === where.format && row.supersededAt === null) ?? null,
        create: async ({ data }: any) => { const row = { id: `out-${outputs.length + 1}`, ...data }; outputs.push(row); return row; },
        update: async ({ where, data }: any) => { const row = outputs.find((entry) => entry.id === where.id); Object.assign(row ?? {}, data); return row; },
      },
    };
    const results = await new ReportGenerationService().generate(db, {
      report: {
        id: "report-1",
        reportType: "SUSPICIOUS_ACTIVITY",
        reportCode: "STR",
        authority: "CBL",
        subjectType: "REPORTING_RULE",
        subjectId: "rule-1",
        amlCaseId: null,
        periodStart: new Date("2026-11-01T00:00:00.000Z"),
        periodEnd: new Date("2026-11-10T00:00:00.000Z"),
        periodKey: "2026-11",
        dueAt: null,
        requiredOutputFormats: ["XML"],
      },
      payload: { code: "STR" },
      ruleId: "rule-1",
      formats: ["XML"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.validationStatus).toBe("VALIDATED");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.payloadSha256).toHaveLength(64);
    expect(outputs[0]?.contentSha256).toHaveLength(64);
  });
});
