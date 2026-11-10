import { createHash } from "node:crypto";
import { compileXsd } from "./XsdCompiler";
import type { GoamlMappingBlueprint, XlsxWorkbookSchema } from "./types";

type Any = Record<string, any>;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const commonXsd = (rootTargetNamespace: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="${rootTargetNamespace}"
           elementFormDefault="qualified">
  <xs:element name="report">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="rentity_id" type="xs:string" minOccurs="1"/>
        <xs:element name="submission_code" type="xs:string" minOccurs="1"/>
        <xs:element name="report_code" type="xs:string" minOccurs="1"/>
        <xs:element name="report_date" type="xs:date" minOccurs="1"/>
        <xs:element name="currency_code_local" type="xs:string" minOccurs="1"/>
        <xs:element name="reporting_person" minOccurs="1">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="name" type="xs:string" minOccurs="1"/>
              <xs:element name="email" type="xs:string" minOccurs="0"/>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
        <xs:element name="transaction" minOccurs="1" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="transactionnumber" type="xs:string" minOccurs="1"/>
              <xs:element name="date_transaction" type="xs:dateTime" minOccurs="1"/>
              <xs:element name="amount_local" type="xs:decimal" minOccurs="1"/>
              <xs:element name="currency_code_local" type="xs:string" minOccurs="1"/>
              <xs:element name="funds_code" type="xs:string" minOccurs="1"/>
              <xs:element name="status" type="xs:string" minOccurs="1"/>
              <xs:element name="merchant_name" type="xs:string" minOccurs="0"/>
              <xs:element name="indicator" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
        <xs:element name="reason" type="xs:string" minOccurs="0"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const mapping = (reportCode: string): GoamlMappingBlueprint => ({
  schemaVersion: 1,
  repeatingNodes: [
    { xsdPath: "/report/transaction", repeatOverContextPath: "transactions", itemAlias: "tx" },
    { xsdPath: "/report/transaction/indicator", repeatOverContextPath: "indicators", itemAlias: "indicator" },
  ],
  fieldBindings: [
    { xsdPath: "/report/rentity_id", sourceKind: "CONTEXT_PATH", contextPath: "institution.rentityId" },
    { xsdPath: "/report/submission_code", sourceKind: "CONTEXT_PATH", contextPath: "institution.submissionCode" },
    { xsdPath: "/report/report_code", sourceKind: "CONSTANT", constantValue: reportCode },
    {
      xsdPath: "/report/report_date",
      sourceKind: "CONTEXT_PATH",
      contextPath: "report.periodEnd",
      transforms: [{ op: "format_date", args: ["YYYY-MM-DD", "Africa/Tripoli"] }],
    },
    { xsdPath: "/report/currency_code_local", sourceKind: "CONTEXT_PATH", contextPath: "institution.localCurrencyCode" },
    { xsdPath: "/report/reporting_person/name", sourceKind: "CONTEXT_PATH", contextPath: "institution.reportingPersonName" },
    { xsdPath: "/report/reporting_person/email", sourceKind: "CONTEXT_PATH", contextPath: "institution.reportingPersonEmail" },
    { xsdPath: "/report/transaction/transactionnumber", sourceKind: "CONTEXT_PATH", contextPath: "tx.reference" },
    {
      xsdPath: "/report/transaction/date_transaction",
      sourceKind: "CONTEXT_PATH",
      contextPath: "tx.date",
      transforms: [{ op: "format_date", args: ["YYYY-MM-DDTHH:mm:ss", "Africa/Tripoli"] }],
    },
    {
      xsdPath: "/report/transaction/amount_local",
      sourceKind: "CONTEXT_PATH",
      contextPath: "tx.amount",
      transforms: [{ op: "format_decimal", args: [4] }],
    },
    { xsdPath: "/report/transaction/currency_code_local", sourceKind: "CONTEXT_PATH", contextPath: "tx.currency" },
    {
      xsdPath: "/report/transaction/funds_code",
      sourceKind: "CODE_MAP",
      contextPath: "tx.railCode",
      codeMapKey: "rail_to_funds_code",
    },
    { xsdPath: "/report/transaction/status", sourceKind: "CONTEXT_PATH", contextPath: "tx.status" },
    { xsdPath: "/report/transaction/merchant_name", sourceKind: "CONTEXT_PATH", contextPath: "merchant.legalName" },
    {
      xsdPath: "/report/transaction/indicator",
      sourceKind: "CONTEXT_PATH",
      contextPath: "indicator.code",
      condition: { contextPath: "indicator.code", operator: "NOT_EMPTY" },
    },
    {
      xsdPath: "/report/reason",
      sourceKind: "CONTEXT_PATH",
      contextPath: "amlCase.triggerReason",
      condition: { contextPath: "amlCase.triggerReason", operator: "NOT_EMPTY" },
    },
  ],
  codeMaps: {
    rail_to_funds_code: {
      description: "Internal rail code to the provisional goAML funds code",
      mappings: {
        mobicash: "E_WALLET",
        sadad: "E_WALLET",
        "local-card": "DEBIT_CARD",
        "bank-transfer": "BANK_TRANSFER",
      },
      defaultFallback: "OTHER",
    },
  },
  assertions: [],
});

const xlsx = (sheets: XlsxWorkbookSchema["sheets"], narrativeSections?: XlsxWorkbookSchema["narrativeSections"]): XlsxWorkbookSchema => ({
  schemaVersion: 1,
  mode: "GENERATED",
  sheets,
  ...(narrativeSections ? { narrativeSections } : {}),
});

const columns = (...values: Array<[string, string, "string" | "number" | "date" | "boolean", boolean?]>): XlsxWorkbookSchema["sheets"][number]["columns"] =>
  values.map(([key, header, type, required]) => ({ key, header, type, required }));

const pspM = xlsx([
  {
    name: "Summary",
    order: 0,
    columns: columns(["metric", "Metric", "string"], ["value", "Value", "number"]),
    rows: { repeatOver: "aggregates.summaryRows" },
  },
  {
    name: "Payments by rail",
    order: 1,
    columns: columns(
      ["rail", "Rail", "string", true],
      ["currency", "Currency", "string", true],
      ["attempts", "Attempts", "number"],
      ["succeeded", "Succeeded", "number"],
      ["failed", "Failed", "number"],
      ["unknown", "Unknown", "number"],
      ["successRate", "Success rate", "string"],
      ["valueSucceeded", "Value succeeded", "string"],
    ),
    rows: { repeatOver: "aggregates.paymentRails" },
  },
  {
    name: "Refunds",
    order: 2,
    columns: columns(["key", "State", "string", true], ["count", "Count", "number"], ["amount", "Amount", "string"]),
    rows: { repeatOver: "aggregates.refundsRows" },
  },
  {
    name: "Disputes opened",
    order: 3,
    columns: columns(["key", "Status", "string", true], ["count", "Count", "number"], ["amount", "Amount", "string"]),
    rows: { repeatOver: "aggregates.disputesOpenedRows" },
  },
  {
    name: "Cash-outs",
    order: 4,
    columns: columns(["key", "State", "string", true], ["count", "Count", "number"], ["amount", "Amount", "string"]),
    rows: { repeatOver: "aggregates.cashoutsRows" },
  },
  {
    name: "Merchants",
    order: 5,
    columns: columns(["key", "Status", "string", true], ["count", "Count", "number"]),
    rows: { repeatOver: "aggregates.merchantStatusRows" },
  },
  {
    name: "Funds position",
    order: 6,
    columns: columns(
      ["accountType", "Account type", "string", true],
      ["currency", "Currency", "string", true],
      ["balance", "Balance", "string"],
    ),
    rows: { repeatOver: "aggregates.fundsRows" },
  },
]);

const amlQ = xlsx([
  {
    name: "Summary",
    order: 0,
    columns: columns(["metric", "Metric", "string"], ["value", "Value", "number"]),
    rows: { repeatOver: "aggregates.summaryRows" },
  },
  {
    name: "Screenings",
    order: 1,
    columns: columns(["key", "Result", "string", true], ["count", "Count", "number"]),
    rows: { repeatOver: "aggregates.screeningRows" },
  },
  {
    name: "AML cases",
    order: 2,
    columns: columns(["key", "Status", "string", true], ["count", "Count", "number"]),
    rows: { repeatOver: "aggregates.amlCaseRows" },
  },
  {
    name: "KYB",
    order: 3,
    columns: columns(["key", "KYB status", "string", true], ["count", "Count", "number"]),
    rows: { repeatOver: "aggregates.kybRows" },
  },
]);

const amlA = xlsx(
  [
    {
      name: "Summary",
      order: 0,
      columns: columns(["metric", "Metric", "string"], ["value", "Value", "number"]),
      rows: { repeatOver: "aggregates.summaryRows" },
    },
    {
      name: "AML cases",
      order: 1,
      columns: columns(["key", "Status", "string", true], ["count", "Count", "number"]),
      rows: { repeatOver: "aggregates.amlCaseRows" },
    },
    {
      name: "Risk tiers",
      order: 2,
      columns: columns(["key", "Risk tier", "string", true], ["count", "Count", "number"]),
      rows: { repeatOver: "aggregates.riskTierRows" },
    },
    {
      name: "KYB",
      order: 3,
      columns: columns(["key", "KYB status", "string", true], ["count", "Count", "number"]),
      rows: { repeatOver: "aggregates.kybRows" },
    },
  ],
  [
    { key: "riskAssessment", title: "Risk assessment", required: true, maxLength: 8000 },
    { key: "policyAndControlChanges", title: "Policy and control changes", required: true, maxLength: 8000 },
    { key: "auditFindings", title: "Audit findings", required: true, maxLength: 8000 },
  ],
);

const ltrXlsx = xlsx([
  {
    name: "Transactions",
    order: 0,
    columns: columns(
      ["reference", "Reference", "string", true],
      ["date", "Date", "date"],
      ["amount", "Amount", "string"],
      ["currency", "Currency", "string"],
      ["railCode", "Rail", "string"],
      ["merchantId", "Merchant", "string"],
      ["status", "Status", "string"],
    ),
    rows: { repeatOver: "transactions" },
  },
]);

const schemas = [
  {
    seedKey: "baseline:cbl:str:xml:v1",
    schemaCode: "cbl-goaml-str-v1",
    name: "CBL goAML STR (provisional)",
    reportType: "SUSPICIOUS_ACTIVITY",
    reportCode: "STR",
    format: "XML" as const,
    definition: commonXsd("urn:cbl:goaml:str:provisional"),
    compiled: null as unknown,
    mapping: mapping("STR"),
  },
  {
    seedKey: "baseline:cbl:ltr:xml:v1",
    schemaCode: "cbl-goaml-ltr-v1",
    name: "CBL goAML LTR (provisional)",
    reportType: "LARGE_TRANSACTION",
    reportCode: "LTR",
    format: "XML" as const,
    definition: commonXsd("urn:cbl:goaml:ltr:provisional"),
    compiled: null as unknown,
    mapping: mapping("LTR"),
  },
  {
    seedKey: "baseline:cbl:psp-m:xlsx:v1",
    schemaCode: "cbl-psp-m-v1",
    name: "CBL PSP monthly return (provisional)",
    reportType: "PERIODIC_RETURN",
    reportCode: "PSP-M",
    format: "XLSX" as const,
    definition: JSON.stringify(pspM),
    compiled: pspM,
    mapping: { schemaVersion: 1 },
  },
  {
    seedKey: "baseline:cbl:aml-q:xlsx:v1",
    schemaCode: "cbl-aml-q-v1",
    name: "CBL AML quarterly return (provisional)",
    reportType: "PERIODIC_RETURN",
    reportCode: "AML-Q",
    format: "XLSX" as const,
    definition: JSON.stringify(amlQ),
    compiled: amlQ,
    mapping: { schemaVersion: 1 },
  },
  {
    seedKey: "baseline:cbl:aml-a:xlsx:v1",
    schemaCode: "cbl-aml-a-v1",
    name: "CBL AML annual return (provisional)",
    reportType: "PERIODIC_RETURN",
    reportCode: "AML-A",
    format: "XLSX" as const,
    definition: JSON.stringify(amlA),
    compiled: amlA,
    mapping: { schemaVersion: 1 },
  },
  {
    seedKey: "baseline:cbl:inc:docx:v1",
    schemaCode: "cbl-incident-docx-v1",
    name: "CBL operational incident report (provisional)",
    reportType: "INCIDENT",
    reportCode: "INC",
    format: "DOCX" as const,
    definition: JSON.stringify({
      schemaVersion: 1,
      mode: "DOCX",
      title: "Operational incident report",
      subtitle: "Confidential — provisional CBL format",
      sections: [
        { key: "summary", title: "Incident summary", required: true },
        { key: "impact", title: "Impact assessment", required: true },
        { key: "rootCause", title: "Root cause" },
        { key: "response", title: "Response and containment" },
        { key: "remediation", title: "Corrective actions and lessons learned", required: true },
      ],
      tables: [{ title: "Timeline", rowsPath: "timeline", columns: [{ key: "occurredAt", header: "Time" }, { key: "type", header: "Event" }, { key: "summary", header: "Detail" }] }],
    }),
    compiled: {
      schemaVersion: 1,
      mode: "DOCX",
      title: "Operational incident report",
      subtitle: "Confidential — provisional CBL format",
      sections: [
        { key: "summary", title: "Incident summary", required: true },
        { key: "impact", title: "Impact assessment", required: true },
        { key: "rootCause", title: "Root cause" },
        { key: "response", title: "Response and containment" },
        { key: "remediation", title: "Corrective actions and lessons learned", required: true },
      ],
      tables: [{ title: "Timeline", rowsPath: "timeline", columns: [{ key: "occurredAt", header: "Time" }, { key: "type", header: "Event" }, { key: "summary", header: "Detail" }] }],
    },
    mapping: { schemaVersion: 1 },
  },
  {
    seedKey: "baseline:cbl:ltr:xlsx:v1",
    schemaCode: "cbl-goaml-ltr-xlsx-v1",
    name: "CBL LTR supporting workbook (provisional)",
    reportType: "LARGE_TRANSACTION",
    reportCode: "LTR",
    format: "XLSX" as const,
    definition: JSON.stringify(ltrXlsx),
    compiled: ltrXlsx,
    mapping: { schemaVersion: 1 },
  },
] as const;

export const ensureBaselineReportingSchemas = async (db: Any): Promise<void> => {
  for (const schema of schemas) {
    const existing = await db.regulatoryReportSchema.findUnique({ where: { seedKey: schema.seedKey } });
    let record = existing;
    if (!record) {
      const compiled = schema.compiled ?? compileXsd(schema.definition);
      const definitionSha256 = sha256(schema.definition);
      record = await db.regulatoryReportSchema.create({
        data: {
          authority: "CBL",
          reportType: schema.reportType,
          format: schema.format,
          schemaCode: schema.schemaCode,
          name: schema.name,
          version: 1,
          status: "PROVISIONAL",
          definitionText: schema.definition,
          definitionSha256,
          mappingSha256: sha256(JSON.stringify(schema.mapping)),
          compiledDefinitionJson: compiled as never,
          mappingBlueprintJson: schema.mapping as never,
          seedKey: schema.seedKey,
        },
      });
    }
    await db.regulatorySchemaDefaultBinding.upsert({
      where: {
        authority_reportType_reportCode_format: {
          authority: "CBL",
          reportType: schema.reportType,
          reportCode: schema.reportCode,
          format: schema.format,
        },
      },
      create: {
        authority: "CBL",
        reportType: schema.reportType,
        reportCode: schema.reportCode,
        format: schema.format,
        schemaId: record.id,
      },
      update: {},
    });
  }
};
