import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { compileXsd } from "../engine/compliance/reporting/XsdCompiler";
import { XsdXmlGenerator } from "../engine/compliance/reporting/XsdXmlGenerator";
import { validateXml } from "../engine/compliance/reporting/XsdXmlValidator";
import { renderRegulatoryWorkbook } from "../lib/xlsx/regulatoryWorkbook";
import { ensureBaselineReportingSchemas } from "../engine/compliance/reporting/baselineSchemas";
import type { GoamlMappingBlueprint, XlsxWorkbookSchema } from "../engine/compliance/reporting/types";

const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="report">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="code" type="xs:string" minOccurs="1"/>
        <xs:element name="transaction" minOccurs="1" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="reference" type="xs:string" minOccurs="1"/>
              <xs:element name="amount" type="xs:decimal" minOccurs="1"/>
              <xs:element name="kind">
                <xs:simpleType>
                  <xs:restriction base="xs:string">
                    <xs:enumeration value="A"/>
                    <xs:enumeration value="B"/>
                  </xs:restriction>
                </xs:simpleType>
              </xs:element>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const blueprint: GoamlMappingBlueprint = {
  schemaVersion: 1,
  repeatingNodes: [{ xsdPath: "/report/transaction", repeatOverContextPath: "transactions", itemAlias: "tx" }],
  fieldBindings: [
    { xsdPath: "/report/code", sourceKind: "CONSTANT", constantValue: "STR" },
    { xsdPath: "/report/transaction/reference", sourceKind: "CONTEXT_PATH", contextPath: "tx.reference" },
    { xsdPath: "/report/transaction/amount", sourceKind: "CONTEXT_PATH", contextPath: "tx.amount" },
    { xsdPath: "/report/transaction/kind", sourceKind: "CODE_MAP", contextPath: "tx.kind", codeMapKey: "kind" },
  ],
  codeMaps: { kind: { description: "kind", mappings: { wallet: "A" }, defaultFallback: "B" } },
  assertions: [],
};

describe("declarative XML reporting", () => {
  test("compiles a safe XSD and extracts paths and code lists", () => {
    const ast = compileXsd(xsd);
    expect(ast.rootElement.name).toBe("report");
    expect(ast.paths["/report/transaction/amount"]?.kind).toBe("simple");
    expect(ast.codeLists.kind?.allowedValues).toEqual(["A", "B"]);
  });

  test("rejects DOCTYPE and external schema locations", () => {
    expect(() => compileXsd(`<!DOCTYPE foo><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>`))
      .toThrow();
    expect(() => compileXsd(`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="http://evil.test/a.xsd"/></xs:schema>`))
      .toThrow();
  });

  test("generates XML in XSD order and validates it", async () => {
    const ast = compileXsd(xsd);
    const xml = await new XsdXmlGenerator().generate(ast, blueprint, {
      transactions: [
        { reference: "R-1", amount: "10.0000", kind: "wallet" },
        { reference: "R-2", amount: "20.0000", kind: "card" },
      ],
    });
    expect(xml).toContain("<code>STR</code>");
    expect(xml.indexOf("<reference>R-1</reference>")).toBeLessThan(xml.indexOf("<amount>10.0000</amount>"));
    expect(xml).toContain("<kind>A</kind>");
    expect(validateXml(xml, ast, blueprint).valid).toBe(true);
  });

  test("reports a missing required element and an enumeration violation", async () => {
    const ast = compileXsd(xsd);
    const invalid = `<?xml version="1.0"?><report><code>STR</code><transaction><reference>R</reference><amount>x</amount><kind>C</kind></transaction></report>`;
    const result = validateXml(invalid, ast, blueprint);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.rule === "type")).toBe(true);
    expect(result.issues.some((issue) => issue.rule === "enumeration")).toBe(true);
  });
});

describe("declarative XLSX reporting", () => {
  const workbook: XlsxWorkbookSchema = {
    schemaVersion: 1,
    mode: "GENERATED",
    sheets: [
      {
        name: "Summary",
        order: 0,
        columns: [
          { key: "metric", header: "Metric", type: "string", required: true },
          { key: "value", header: "Value", type: "number", required: true },
        ],
        rows: { repeatOver: "summary" },
      },
      {
        name: "Transactions",
        order: 1,
        columns: [
          { key: "reference", header: "Reference", type: "string", required: true },
          { key: "amount", header: "Amount", type: "number", required: true },
        ],
        rows: { repeatOver: "transactions" },
        totals: [{ column: "amount", function: "sum" }],
      },
    ],
    narrativeSections: [{ key: "risk", title: "Risk assessment", required: true }],
    validations: [{ id: "total", type: "TOTAL_MATCH", contextPath: "expectedTotal", column: "amount" }],
  };

  test("renders a workbook, totals and narrative, and validates required data", async () => {
    const result = await renderRegulatoryWorkbook(workbook, {
      summary: [{ metric: "Attempts", value: 2 }],
      transactions: [
        { reference: "=1+1", amount: 10 },
        { reference: "R-2", amount: 20 },
      ],
      expectedTotal: 30,
      narrative: { risk: "Reviewed" },
    });
    expect(result.issues).toEqual([]);
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(result.buffer as unknown as ExcelJS.Buffer);
    const summary = loaded.getWorksheet("Summary");
    const transactions = loaded.getWorksheet("Transactions");
    expect(summary?.getCell("A2").value).toBe("Attempts");
    expect(transactions?.getCell("A2").value).toBe("'=1+1");
    expect(transactions?.getCell("B4").value).toBe(30);
  });

  test("reports missing required rows and narrative", async () => {
    const result = await renderRegulatoryWorkbook(workbook, {
      summary: [],
      transactions: [{ reference: "", amount: 10 }],
      expectedTotal: 20,
    });
    expect(result.issues.some((issue) => issue.rule === "required")).toBe(true);
    expect(result.issues.some((issue) => issue.rule === "TOTAL_MATCH")).toBe(true);
  });

  test("rejects macro-bearing templates", async () => {
    const macro = Buffer.from("vbaProject.bin", "utf8");
    const result = await renderRegulatoryWorkbook(workbook, {}, macro);
    expect(result.issues[0]?.rule).toBe("security");
  });
});

describe("baseline reporting schemas", () => {
  test("seeds the provisional XML and XLSX schemas and generates a valid STR XML", async () => {
    const schemas: any[] = [];
    const bindings: any[] = [];
    const db = {
      regulatoryReportSchema: {
        findUnique: async ({ where }: any) => schemas.find((row) => row.seedKey === where.seedKey) ?? null,
        create: async ({ data }: any) => {
          const row = { id: `schema-${schemas.length + 1}`, ...data };
          schemas.push(row);
          return row;
        },
      },
      regulatorySchemaDefaultBinding: {
        upsert: async ({ where, create }: any) => {
          const key = where.authority_reportType_reportCode_format;
          const existing = bindings.find((row) =>
            row.authority === key.authority
            && row.reportType === key.reportType
            && row.reportCode === key.reportCode
            && row.format === key.format
          );
          if (existing) return existing;
          bindings.push(create);
          return create;
        },
      },
    };
    await ensureBaselineReportingSchemas(db);
    expect(schemas.length).toBe(7);
    expect(bindings.length).toBe(7);
    expect(schemas.some((row) => row.format === "DOCX" && row.reportType === "INCIDENT")).toBe(true);
    const str = schemas.find((row) => row.schemaCode === "cbl-goaml-str-v1");
    expect(str).toBeDefined();
    const xml = await new XsdXmlGenerator().generate(
      str.compiledDefinitionJson,
      str.mappingBlueprintJson,
      {
        institution: {
          rentityId: "PROVISIONAL-CBL-RENTITY",
          submissionCode: "E",
          localCurrencyCode: "LYD",
          reportingPersonName: "Compliance Officer",
          reportingPersonEmail: "compliance@payment-gateway.internal",
        },
        report: { reportType: "SUSPICIOUS_ACTIVITY", periodEnd: "2026-10-31T00:00:00.000Z" },
        merchant: { legalName: "Acme Ltd" },
        transactions: [{ reference: "PAY-1", date: "2026-10-30T10:00:00.000Z", amount: "100.0000", currency: "LYD", railCode: "mobicash", status: "SUCCEEDED" }],
        indicators: [{ code: "STRUCTURING" }],
        amlCase: { triggerReason: "STRUCTURING" },
      },
    );
    const validation = validateXml(xml, str.compiledDefinitionJson, str.mappingBlueprintJson);
    expect(validation.valid).toBe(true);
  });
});

describe("XSD attributes and LTR batch mapping", () => {
  const attrXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="report">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="transaction">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="value" type="xs:string" minOccurs="1"/>
            </xs:sequence>
            <xs:attribute name="currency" type="xs:string" use="required"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;
  test("generates and validates a required attribute", async () => {
    const ast = compileXsd(attrXsd);
    const blueprint: GoamlMappingBlueprint = {
      schemaVersion: 1,
      repeatingNodes: [],
      fieldBindings: [
        { xsdPath: "/report/transaction/@currency", sourceKind: "CONSTANT", constantValue: "LYD" },
        { xsdPath: "/report/transaction/value", sourceKind: "CONSTANT", constantValue: "ok" },
      ],
      codeMaps: {},
      assertions: [],
    };
    const xml = await new XsdXmlGenerator().generate(ast, blueprint, {});
    expect(xml).toContain('currency="LYD"');
    expect(validateXml(xml, ast, blueprint).valid).toBe(true);
    expect(validateXml(xml.replace(' currency="LYD"', ""), ast, blueprint).issues.some((issue) => issue.rule === "required")).toBe(true);
  });

  test("the baseline LTR XML maps the batch date field", async () => {
    const schemas: any[] = [];
    const bindings: any[] = [];
    const db = {
      regulatoryReportSchema: {
        findUnique: async ({ where }: any) => schemas.find((row) => row.seedKey === where.seedKey) ?? null,
        create: async ({ data }: any) => { const row = { id: `s-${schemas.length + 1}`, ...data }; schemas.push(row); return row; },
      },
      regulatorySchemaDefaultBinding: {
        upsert: async ({ create }: any) => { bindings.push(create); return create; },
      },
    };
    await ensureBaselineReportingSchemas(db);
    const ltr = schemas.find((row) => row.schemaCode === "cbl-goaml-ltr-v1");
    const xml = await new XsdXmlGenerator().generate(ltr.compiledDefinitionJson, ltr.mappingBlueprintJson, {
      institution: { rentityId: "R", submissionCode: "E", localCurrencyCode: "LYD", reportingPersonName: "Officer" },
      report: { periodEnd: "2026-11-10T00:00:00.000Z" },
      transactions: [{ reference: "TX-1", date: "2026-11-09T10:00:00.000Z", amount: "50000.0000", currency: "LYD", railCode: "mobicash", status: "SUCCEEDED" }],
    });
    expect(xml).toContain("<date_transaction>2026-11-09T12:00:00</date_transaction>");
    expect(validateXml(xml, ltr.compiledDefinitionJson, ltr.mappingBlueprintJson).valid).toBe(true);
  });
  test("validates list values and required narrative sections", async () => {
    const schema: XlsxWorkbookSchema = {
      schemaVersion: 1,
      mode: "GENERATED",
      sheets: [{
        name: "Rows",
        order: 0,
        columns: [{ key: "type", header: "Type", type: "list", required: true, list: ["A", "B"] }],
        rows: { repeatOver: "rows" },
      }],
      narrativeSections: [{ key: "risk", title: "Risk assessment", required: true }],
      validations: [{ id: "risk-required", type: "REQUIRED_SECTION", contextPath: "narrative.risk" }],
    };
    const result = await renderRegulatoryWorkbook(schema, { rows: [{ type: "C" }], narrative: {} });
    expect(result.issues.some((issue) => issue.rule === "list")).toBe(true);
    expect(result.issues.some((issue) => issue.rule === "REQUIRED_SECTION")).toBe(true);
  });

});
