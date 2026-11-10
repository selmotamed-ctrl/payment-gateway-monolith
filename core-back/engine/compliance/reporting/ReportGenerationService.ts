import { createHash } from "node:crypto";
import { Vault } from "../../crypto/Vault";
import { VaultContextCipher } from "../../runtime/contextCipher";
import { renderRegulatoryWorkbook } from "../../../lib/xlsx/regulatoryWorkbook";
import { renderRegulatoryDocx } from "../../../lib/docx/regulatoryDocx";
import { buildCanonicalReportContext, type BuildContextReport, type CanonicalReportContext } from "./CanonicalReportContext";
import { ensureBaselineReportingSchemas } from "./baselineSchemas";
import { XsdXmlGenerator } from "./XsdXmlGenerator";
import { validateXml } from "./XsdXmlValidator";
import type {
  GoamlMappingBlueprint,
  ReportGenerationResult,
  ReportOutputFormat,
  ReportOutputValidationStatus,
  DocxNarrativeSchema,
  XlsxTemplateBinding,
  XlsxWorkbookSchema,
  XsdCompiledAst,
} from "./types";

type Any = Record<string, any>;

export interface GenerateReportInput {
  report: BuildContextReport;
  payload: Record<string, unknown>;
  ruleId?: string | null;
  formats?: readonly ReportOutputFormat[];
  allowRegenerate?: boolean;
}

const schemaFor = async (
  db: Any,
  report: BuildContextReport,
  format: ReportOutputFormat,
  ruleId: string | null | undefined,
): Promise<Any | null> => {
  if (typeof db.regulatorySchemaDefaultBinding?.findFirst !== "function") return null;
  if (ruleId && typeof db.regulatoryRuleSchemaBinding?.findFirst === "function") {
    const binding = await db.regulatoryRuleSchemaBinding.findFirst({
      where: { ruleId, format },
      include: { schema: true },
    });
    if (binding?.schema) return binding.schema;
  }
  const binding = await db.regulatorySchemaDefaultBinding.findFirst({
    where: {
      authority: report.authority,
      reportType: report.reportType,
      reportCode: report.reportCode ?? "",
      format,
    },
    include: { schema: true },
  });
  return binding?.schema ?? null;
};

const validationStatus = (
  schemaStatus: string | undefined,
  valid: boolean,
): ReportOutputValidationStatus => {
  if (!valid) return "INVALID";
  return schemaStatus === "CONFIRMED" ? "VALIDATED" : "PROVISIONAL_SCHEMA";
};

const hash = (content: Buffer | string): string =>
  createHash("sha256").update(content).digest("hex");

const encode = async (cipher: VaultContextCipher, value: string): Promise<string> => cipher.encrypt(value);

export class ReportGenerationService {
  private readonly xml = new XsdXmlGenerator();
  private readonly xmlCipher: VaultContextCipher;
  private readonly xlsxCipher: VaultContextCipher;
  private readonly docxCipher: VaultContextCipher;

  constructor(vault = new Vault()) {
    this.xmlCipher = new VaultContextCipher(vault, "reporting-xml");
    this.xlsxCipher = new VaultContextCipher(vault, "reporting-xlsx");
    this.docxCipher = new VaultContextCipher(vault, "reporting-docx");
  }

  async generate(
    db: Any,
    input: GenerateReportInput,
  ): Promise<ReportGenerationResult[]> {
    const formats = input.formats
      ?? (input.report.requiredOutputFormats.length > 0
        ? input.report.requiredOutputFormats as ReportOutputFormat[]
        : ["XML"]);
    const context = await buildCanonicalReportContext(db, input.report, input.payload);
    const payloadSha256 = hash(JSON.stringify(input.payload));
    const results: ReportGenerationResult[] = [];
    for (const format of formats) {
      const schema = await schemaFor(db, input.report, format, input.ruleId);
      const result = await this.generateOne(format, schema, context);
      results.push(result);
      await this.store(db, input, format, result, payloadSha256);
    }
    return results;
  }

  private async generateOne(
    format: ReportOutputFormat,
    schema: Any | null,
    context: CanonicalReportContext,
  ): Promise<ReportGenerationResult> {
    if (!schema) {
      const empty = format === "XML" ? "" : Buffer.alloc(0);
      return {
        format,
        content: empty,
        sha256: hash(empty),
        validationStatus: "NOT_GENERATED",
        errors: [{ path: "/", rule: "schema", message: `No ${format} schema is configured for this report` }],
        schemaId: null,
        schemaVersion: null,
      };
    }
    if (format === "XML") {
      const ast = schema.compiledDefinitionJson as XsdCompiledAst;
      const blueprint = schema.mappingBlueprintJson as GoamlMappingBlueprint;
      const xml = await this.xml.generate(ast, blueprint, context as unknown as Record<string, unknown>);
      const validation = validateXml(xml, ast, blueprint);
      return {
        format,
        content: xml,
        sha256: hash(xml),
        validationStatus: validationStatus(schema.status, validation.valid),
        errors: validation.issues,
        schemaId: String(schema.id),
        schemaVersion: Number(schema.version),
      };
    }
    if (format === "XLSX") {
      const workbook = schema.compiledDefinitionJson as XlsxWorkbookSchema;
      const template = schema.templateCiphertext
        ? Buffer.from(String(await this.xlsxCipher.decrypt(schema.templateCiphertext)), "base64")
        : null;
      const rendered = await renderRegulatoryWorkbook(workbook, context as unknown as Record<string, unknown>, template, schema.templateBindingJson as XlsxTemplateBinding | null);
      const valid = rendered.issues.length === 0;
      return {
        format,
        content: rendered.buffer,
        sha256: hash(rendered.buffer),
        validationStatus: validationStatus(schema.status, valid),
        errors: rendered.issues,
        schemaId: String(schema.id),
        schemaVersion: Number(schema.version),
      };
    }
    if (format === "DOCX") {
      const narrative = schema.compiledDefinitionJson as DocxNarrativeSchema;
      const rendered = renderRegulatoryDocx(narrative, context as unknown as Record<string, unknown>);
      const valid = rendered.issues.length === 0;
      return {
        format,
        content: rendered.buffer,
        sha256: hash(rendered.buffer),
        validationStatus: validationStatus(schema.status, valid),
        errors: rendered.issues,
        schemaId: String(schema.id),
        schemaVersion: Number(schema.version),
      };
    }
    throw new Error(`Unsupported report output format: ${format}`);
  }

  private async store(
    db: Any,
    input: GenerateReportInput,
    format: ReportOutputFormat,
    result: ReportGenerationResult,
    payloadSha256: string,
  ): Promise<void> {
    const isXml = format === "XML";
    const payload = isXml
      ? String(result.content)
      : Buffer.from(result.content as Buffer).toString("base64");
    const cipher = isXml ? this.xmlCipher : format === "DOCX" ? this.docxCipher : this.xlsxCipher;
    const contentCiphertext = await encode(cipher, payload);
    const write = async (tx: Any): Promise<void> => {
      const current = await tx.regulatoryReportOutput.findFirst({
        where: { reportId: input.report.id, format, supersededAt: null },
        orderBy: { revision: "desc" },
      });
      if (current) {
        if (!input.allowRegenerate && current.validationStatus === "VALIDATED") {
          return;
        }
        if (input.allowRegenerate) {
          await tx.regulatoryReportOutput.update({
            where: { id: current.id },
            data: { supersededAt: new Date() },
          });
        } else {
          await tx.regulatoryReportOutput.update({
            where: { id: current.id },
            data: {
              schemaId: result.schemaId,
              schemaVersion: result.schemaVersion,
              contentCiphertext,
              contentSha256: result.sha256,
              payloadSha256,
              validationStatus: result.validationStatus,
              validationErrorsJson: result.errors.length > 0 ? result.errors : null,
              generatedAt: new Date(),
            },
          });
          return;
        }
      }
      const latest = await tx.regulatoryReportOutput.findFirst({
        where: { reportId: input.report.id, format },
        orderBy: { revision: "desc" },
      });
      await tx.regulatoryReportOutput.create({
        data: {
          reportId: input.report.id,
          format,
          revision: Number(latest?.revision ?? 0) + 1,
          schemaId: result.schemaId,
          schemaVersion: result.schemaVersion,
          contentCiphertext,
          contentSha256: result.sha256,
          payloadSha256,
          validationStatus: result.validationStatus,
          validationErrorsJson: result.errors.length > 0 ? result.errors : null,
          generatedAt: new Date(),
        },
      });
    };
    if (typeof db.$transaction === "function") {
      await db.$transaction((tx: Any) => write(tx));
    } else {
      await write(db);
    }
  }
}
