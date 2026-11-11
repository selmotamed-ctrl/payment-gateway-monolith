import ExcelJS from "exceljs";
import type {
  ValidationIssue,
  XlsxColumn,
  XlsxSheet,
  XlsxTemplateBinding,
  XlsxWorkbookSchema,
} from "../../engine/compliance/reporting/types";
import { resolveTemplateAnchor, templateBindingRequired } from "./template";

type Scope = Record<string, unknown>;

const asRecord = (value: unknown): Scope =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Scope : {};

const resolvePath = (scope: Scope, path: string | undefined): unknown => {
  if (!path) return undefined;
  let current: unknown = scope;
  for (const part of path.split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) current = current[0];
    current = asRecord(current)[part];
  }
  return current;
};

const safeText = (value: unknown): string => {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};

const writeCell = (cell: ExcelJS.Cell, value: unknown, column: XlsxColumn): void => {
  if (value === null || value === undefined || value === "") {
    cell.value = null;
    return;
  }
  if (column.type === "number") {
    cell.value = typeof value === "number" ? value : Number(value);
    if (column.numberFormat) cell.numFmt = column.numberFormat;
    return;
  }
  if (column.type === "date") {
    cell.value = value instanceof Date ? value : new Date(String(value));
    if (column.numberFormat) cell.numFmt = column.numberFormat;
    return;
  }
  if (column.type === "boolean") {
    cell.value = Boolean(value);
    return;
  }
  cell.value = safeText(value);
};

const applyColumns = (worksheet: ExcelJS.Worksheet, columns: readonly XlsxColumn[], writeHeaders: boolean): void => {
  worksheet.columns = columns.map((column) => ({
    header: writeHeaders ? column.header : undefined,
    key: column.key,
    width: column.width ?? 18,
    style: column.numberFormat ? { numFmt: column.numberFormat } : undefined,
  })) as ExcelJS.Column[];
};

const validateSheet = (
  sheet: XlsxSheet,
  rows: readonly Scope[],
  issues: ValidationIssue[],
): void => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    for (const column of sheet.columns) {
      const value = resolvePath(row, column.key);
      if (column.required && (value === null || value === undefined || String(value).trim() === "")) {
        issues.push({
          path: `${sheet.name}/${index + 1}/${column.key}`,
          rule: "required",
          message: "Required value is missing",
        });
      }
      if (value !== undefined && value !== null && value !== "" && column.type === "number" && !Number.isFinite(Number(value))) {
        issues.push({
          path: `${sheet.name}/${index + 1}/${column.key}`,
          rule: "type",
          message: "Value must be numeric",
          actual: String(value),
        });
      }
      if (value !== undefined && value !== null && value !== "" && column.type === "list" && column.list && !column.list.includes(String(value))) {
        issues.push({
          path: `${sheet.name}/${index + 1}/${column.key}`,
          rule: "list",
          message: `Value must be one of: ${column.list.join(", ")}`,
          actual: String(value),
        });
      }
    }
  }
};

const rowObjects = (context: Scope, path: string): Scope[] => {
  const value = resolvePath(context, path);
  return Array.isArray(value) ? value.map(asRecord) : [];
};

const hasMacro = (buffer: Buffer): boolean =>
  buffer.includes(Buffer.from("vbaProject.bin", "utf8")) || buffer.includes(Buffer.from("xl/vbaProject.bin", "utf8"));

export interface XlsxRenderResult {
  buffer: Buffer;
  issues: ValidationIssue[];
}

export const renderRegulatoryWorkbook = async (
  schema: XlsxWorkbookSchema,
  context: Scope,
  template?: Buffer | null,
  templateBinding?: XlsxTemplateBinding | null,
): Promise<XlsxRenderResult> => {
  if (template && hasMacro(template)) {
    return {
      buffer: Buffer.alloc(0),
      issues: [{ path: "/", rule: "security", message: "Macro-bearing workbooks are not allowed" }],
    };
  }
  const workbook = new ExcelJS.Workbook();
  if (template && template.length > 0) {
    await workbook.xlsx.load(template as unknown as ExcelJS.Buffer);
  }
  const issues: ValidationIssue[] = [];
  if (template && schema.mode === "TEMPLATE") {
    issues.push(...templateBindingRequired(templateBinding));
    if (!templateBinding || issues.some((issue) => issue.rule === "template-binding")) {
      return { buffer: Buffer.alloc(0), issues };
    }
    for (const binding of templateBinding.sheets) {
      const schemaSheet = schema.sheets.find((entry) => entry.name === binding.name);
      const worksheet = workbook.getWorksheet(binding.name);
      if (!worksheet || !schemaSheet) {
        issues.push({ path: `/template/${binding.name}`, rule: "template", message: "Mapped sheet is missing from the workbook or workbook schema" });
        continue;
      }
      const rows = rowObjects(context, schemaSheet.rows.repeatOver);
      const range = resolveTemplateAnchor(workbook, {
        namedRange: binding.rangeName ?? binding.tableName,
        cell: undefined,
        row: binding.dataStartRow,
      });
      const dataStart = binding.dataStartRow ?? range?.row ?? 2;
      const prototypeRow = binding.prototypeRow ?? dataStart;
      const columns = binding.columns.map((column, index) => {
        const anchor = resolveTemplateAnchor(workbook, { namedRange: column.namedRange, column: column.column, row: dataStart });
        return { ...column, index: (anchor?.column ?? index + 1) - 1, templateColumn: schemaSheet.columns.find((entry) => entry.key === column.key) };
      });
      const rangeEnd = binding.rangeName || binding.tableName
        ? (() => {
            const parsed = (workbook.definedNames.getRanges(binding.rangeName ?? binding.tableName!)?.ranges ?? [])
              .map((value) => value)
              .find(Boolean);
            return parsed ? parsed : null;
          })()
        : null;
      const available = rangeEnd
        ? Math.max(0, (Number(/\$?(\d+)$/.exec(rangeEnd)?.[1] ?? dataStart)) - dataStart + 1)
        : Math.max(0, worksheet.rowCount - dataStart + 1);
      if (rows.length > available) {
        issues.push({
          path: `/template/${binding.name}`,
          rule: "template-range",
          message: `The template range has ${available} data row(s) but ${rows.length} are required`,
        });
      }
      for (const [rowIndex, row] of rows.entries()) {
        const target = worksheet.getRow(dataStart + rowIndex);
        const prototype = worksheet.getRow(prototypeRow);
        target.height = prototype.height;
        for (const column of columns) {
          const sourceCell = prototype.getCell(column.index + 1);
          const targetCell = target.getCell(column.index + 1);
          targetCell.style = { ...sourceCell.style };
          writeCell(targetCell, resolvePath(row, column.key), column.templateColumn ?? {
            key: column.key,
            header: column.header ?? column.key,
            type: column.type ?? "string",
          });
        }
      }
      if (binding.totals && binding.totals.length > 0) {
        for (const total of binding.totals) {
          const anchor = resolveTemplateAnchor(workbook, {
            namedRange: total.namedRange,
            row: total.row ?? (dataStart + rows.length),
          });
          const column = columns.find((entry) => entry.key === total.column);
          if (!anchor || !column) continue;
          const sum = rows.reduce((accumulator, row) => accumulator + Number(resolvePath(row, total.column) ?? 0), 0);
          worksheet.getCell(anchor.row, anchor.column + (total.namedRange ? 0 : column.index)).value = sum;
        }
      }
      validateSheet(schemaSheet, rows, issues);
    }
    for (const narrativeBinding of templateBinding.narrative ?? []) {
      const anchor = resolveTemplateAnchor(workbook, { namedRange: narrativeBinding.namedRange, cell: narrativeBinding.cell });
      if (!anchor) {
        issues.push({ path: `/template/narrative/${narrativeBinding.key}`, rule: "template", message: "Narrative anchor is missing" });
        continue;
      }
      const worksheet = workbook.worksheets[0];
      const value = asRecord(context.narrative)[narrativeBinding.key];
      if (!worksheet) continue;
      worksheet.getCell(anchor.row, anchor.column).value = safeText(value ?? "");
    }
    for (const validation of schema.validations ?? []) {
      if (validation.type === "REQUIRED_SECTION") {
        const sectionKey = typeof validation.value === "string" ? validation.value : validation.contextPath;
        const section = schema.narrativeSections?.find((entry) => entry.key === sectionKey || entry.title === sectionKey);
        const value = section ? asRecord(context.narrative)[section.key] : resolvePath(context, validation.contextPath);
        if (value === null || value === undefined || String(value).trim() === "") {
          issues.push({ path: `/validations/${validation.id}`, rule: "REQUIRED_SECTION", message: `Required section '${sectionKey ?? ""}' is missing` });
        }
      }
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), issues };
  }
  const orderedSheets = [...schema.sheets].sort((left, right) => left.order - right.order);
  for (const sheet of orderedSheets) {
    const existing = workbook.getWorksheet(sheet.name);
    const worksheet = existing ?? workbook.addWorksheet(sheet.name);
    const rows = rowObjects(context, sheet.rows.repeatOver);
    applyColumns(worksheet, sheet.columns, false);
    if (!existing) {
      worksheet.addRow(sheet.columns.map((column) => column.header));
      worksheet.getRow(1).font = { bold: true };
    }
    for (const row of rows) {
      worksheet.addRow(sheet.columns.map((column) => resolvePath(row, column.key) ?? null));
      const added = worksheet.lastRow;
      if (added) {
        sheet.columns.forEach((column, index) => writeCell(added.getCell(index + 1), resolvePath(row, column.key), column));
      }
    }
    if (sheet.totals && sheet.totals.length > 0) {
      const totalRow = worksheet.addRow([]);
      totalRow.font = { bold: true };
      totalRow.getCell(1).value = "Total";
      for (const total of sheet.totals) {
        const index = sheet.columns.findIndex((column) => column.key === total.column);
        if (index === -1) continue;
        const sum = rows.reduce((accumulator, row) => accumulator + Number(resolvePath(row, total.column) ?? 0), 0);
        totalRow.getCell(index + 1).value = sum;
      }
    }
    validateSheet(sheet, rows, issues);
  }
  if (schema.narrativeSections && schema.narrativeSections.length > 0) {
    const narrative = asRecord(context.narrative);
    const worksheet = workbook.getWorksheet("Narrative") ?? workbook.addWorksheet("Narrative");
    worksheet.columns = [{ width: 34 }, { width: 110 }] as ExcelJS.Column[];
    if (!worksheet.getRow(1).getCell(1).value) {
      worksheet.addRow(["Section", "Response"]).font = { bold: true };
    }
    for (const section of schema.narrativeSections) {
      const value = narrative[section.key];
      worksheet.addRow([section.title, safeText(value ?? "")]);
      if (section.required && (value === null || value === undefined || String(value).trim() === "")) {
        issues.push({
          path: `/narrative/${section.key}`,
          rule: "required",
          message: `Narrative section '${section.title}' is required`,
        });
      }
      if (section.maxLength !== undefined && String(value ?? "").length > section.maxLength) {
        issues.push({
          path: `/narrative/${section.key}`,
          rule: "maxLength",
          message: `Narrative section '${section.title}' exceeds ${section.maxLength} characters`,
        });
      }
    }
  }
  for (const validation of schema.validations ?? []) {
    if (validation.type === "TOTAL_MATCH") {
      const expected = Number(resolvePath(context, validation.contextPath));
      const sheet = orderedSheets.find((candidate) =>
        candidate.columns.some((column) => column.key === validation.column),
      );
      if (!sheet || !validation.column || !Number.isFinite(expected)) continue;
      const rows = rowObjects(context, sheet.rows.repeatOver);
      const actual = rows.reduce((sum, row) => sum + Number(resolvePath(row, validation.column!) ?? 0), 0);
      if (Math.abs(actual - expected) > 0.0001) {
        issues.push({
          path: `/validations/${validation.id}`,
          rule: "TOTAL_MATCH",
          message: `Column total ${actual} does not match ${expected}`,
        });
      }
    }
    if (validation.type === "ROW_COUNT" && typeof validation.value === "number") {
      for (const sheet of orderedSheets) {
        const rows = rowObjects(context, sheet.rows.repeatOver);
        if (rows.length !== validation.value) {
          issues.push({
            path: `/validations/${validation.id}`,
            rule: "ROW_COUNT",
            message: `Sheet ${sheet.name} has ${rows.length} rows, expected ${validation.value}`,
          });
        }
      }
    }
    if (validation.type === "REQUIRED_SECTION") {
      const sectionKey = typeof validation.value === "string" ? validation.value : validation.contextPath;
      const section = schema.narrativeSections?.find((entry) => entry.key === sectionKey || entry.title === sectionKey);
      const value = section ? asRecord(context.narrative)[section.key] : resolvePath(context, validation.contextPath);
      if (value === null || value === undefined || String(value).trim() === "") {
        issues.push({
          path: `/validations/${validation.id}`,
          rule: "REQUIRED_SECTION",
          message: `Required section '${sectionKey ?? ""}' is missing`,
        });
      }
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), issues };
};
