import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { analyzeWorkbookTemplate, parseXlsxRange, templateBindingRequired } from "../lib/xlsx/template";
import { renderRegulatoryWorkbook } from "../lib/xlsx/regulatoryWorkbook";
import type { XlsxTemplateBinding } from "../engine/compliance/reporting/types";

const buildTemplate = async (): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Transactions");
  sheet.getCell("A1").value = "ID";
  sheet.getCell("B1").value = "Amount";
  sheet.getCell("C1").value = "Date";
  sheet.getCell("A2").value = "prototype";
  sheet.getCell("B2").value = 0;
  sheet.getCell("C2").value = "2026-01-01";
  sheet.getCell("A2").font = { bold: true };
  sheet.getCell("B2").numFmt = "#,##0.0000";
  sheet.getCell("E1").value = "Summary";
  sheet.getCell("E2").value = "";
  workbook.definedNames.add("Transactions!$A$2:$C$10", "Transactions_Data");
  workbook.definedNames.add("Transactions!$A$2:$A$10", "Transactions_ID");
  workbook.definedNames.add("Transactions!$B$2:$B$10", "Transactions_Amount");
  workbook.definedNames.add("Transactions!$C$2:$C$10", "Transactions_Date");
  workbook.definedNames.add("Transactions!$E$2", "Report_Summary");
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const schema = {
  schemaVersion: 1 as const,
  mode: "TEMPLATE" as const,
  sheets: [{
    name: "Transactions",
    rows: { repeatOver: "transactions" },
    columns: [
      { key: "id", header: "ID" },
      { key: "amount", header: "Amount", type: "number", numberFormat: "#,##0.0000" },
      { key: "date", header: "Date", type: "date" },
    ],
  }],
  narrativeSections: [{ key: "summary", title: "Summary" }],
  validations: [{ id: "summary-required", type: "REQUIRED_SECTION", value: "summary" }],
};

const binding: XlsxTemplateBinding = {
  mode: "TEMPLATE",
  sheets: [{
    name: "Transactions",
    rangeName: "Transactions_Data",
    dataStartRow: 2,
    prototypeRow: 2,
    columns: [
      { key: "id", namedRange: "Transactions_ID" },
      { key: "amount", namedRange: "Transactions_Amount" },
      { key: "date", namedRange: "Transactions_Date" },
    ],
    totals: [{ column: "amount", function: "sum", row: 5 }],
  }],
  narrative: [{ key: "summary", namedRange: "Report_Summary" }],
};

describe("xlsx reporting template", () => {
  test("parses quoted and unquoted ranges", () => {
    expect(parseXlsxRange("Transactions!$A$2:$C$10")).toEqual({ sheetName: "Transactions", startRow: 2, startColumn: 1, endRow: 10, endColumn: 3 });
    expect(parseXlsxRange("'My Sheet'!B3")).toEqual({ sheetName: "My Sheet", startRow: 3, startColumn: 2, endRow: 3, endColumn: 2 });
  });

  test("analyses a safe named-range template and rejects an unbound template", async () => {
    const analysis = await analyzeWorkbookTemplate(await buildTemplate());
    expect(analysis.issues).toEqual([]);
    expect(analysis.namedRanges.map((entry) => entry.name)).toContain("Transactions_Data");
    expect(analysis.sheets[0]?.name).toBe("Transactions");
    expect(templateBindingRequired(null)).not.toEqual([]);
    expect(templateBindingRequired(binding)).toEqual([]);
  });

  test("writes rows, totals and narrative through named ranges and copies style", async () => {
    const result = await renderRegulatoryWorkbook(
      schema as never,
      { transactions: [{ id: "TX-2", amount: 12.5, date: "2026-02-02" }, { id: "TX-1", amount: 7.5, date: "2026-01-01" }], narrative: { summary: "Monthly return" } },
      await buildTemplate(),
      binding,
    );
    expect(result.issues).toEqual([]);
    const rendered = new ExcelJS.Workbook();
    await rendered.xlsx.load(result.buffer as unknown as ExcelJS.Buffer);
    const sheet = rendered.getWorksheet("Transactions")!;
    expect(sheet.getCell("A2").value).toBe("TX-2");
    expect(sheet.getCell("B2").value).toBe(12.5);
    expect(sheet.getCell("A3").value).toBe("TX-1");
    expect(sheet.getCell("A2").font?.bold).toBe(true);
    expect(sheet.getCell("B2").numFmt).toBe("#,##0.0000");
    expect(sheet.getCell("B5").value).toBe(20);
    expect(sheet.getCell("E2").value).toBe("Monthly return");
  });

  test("reports a malformed workbook instead of accepting it", async () => {
    const analysis = await analyzeWorkbookTemplate(Buffer.from("not an xlsx archive", "utf8"));
    expect(analysis.issues.some((issue) => issue.rule === "zip" || issue.rule === "workbook")).toBe(true);
  });

  test("refuses a binding that has no mapped sheet and reports range overflow", async () => {
    const missing = await renderRegulatoryWorkbook(schema as never, { transactions: [{ id: "TX-1", amount: 1 }], narrative: { summary: "x" } }, await buildTemplate(), { mode: "TEMPLATE", sheets: [] });
    expect(missing.issues.some((issue) => issue.rule === "template-binding")).toBe(true);
    const huge = await renderRegulatoryWorkbook(
      schema as never,
      { transactions: Array.from({ length: 10 }, (_, index) => ({ id: `TX-${index}`, amount: 1 })), narrative: { summary: "x" } },
      await buildTemplate(),
      binding,
    );
    expect(huge.issues.some((issue) => issue.rule === "template-range")).toBe(true);
  });
});
