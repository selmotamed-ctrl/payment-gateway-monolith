import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import type { ValidationIssue, XlsxTemplateBinding } from "../../engine/compliance/reporting/types";

const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_SHEETS = 100;
const MAX_CELLS = 1_000_000;
const FORBIDDEN_ENTRIES = [
  "vbaProject.bin",
  "xl/externalLinks/",
  "xl/connections.xml",
  "xl/embeddings/",
  "xl/oleObject",
  "customUI/",
];

export interface XlsxTemplateAnalysis {
  sheets: Array<{ name: string; rowCount: number; columnCount: number; mergedCells: number; formulaCount: number }>;
  namedRanges: Array<{ name: string; ranges: string[] }>;
  cellCount: number;
  formulaCount: number;
  security: { macros: boolean; externalLinks: boolean; oleObjects: boolean; zipBomb: boolean; forbidden: string[] };
  issues: ValidationIssue[];
}

export interface ParsedRange {
  sheetName: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export const parseXlsxRange = (range: string): ParsedRange | null => {
  const match = /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(range.trim());
  if (!match) return null;
  const [, sheetName, startColumnLetters, startRowRaw, endColumnLetters, endRowRaw] = match;
  const columnIndex = (letters: string): number => {
    let value = 0;
    for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
    return value;
  };
  return {
    sheetName: sheetName!.replace(/''/g, "'"),
    startRow: Number(startRowRaw),
    startColumn: columnIndex(startColumnLetters!),
    endRow: Number(endRowRaw ?? startRowRaw),
    endColumn: columnIndex(endColumnLetters ?? startColumnLetters!),
  };
};

const rangeOfNamedRange = (workbook: ExcelJS.Workbook, name: string): ParsedRange | null => {
  const ranges = workbook.definedNames.getRanges(name)?.ranges ?? [];
  for (const range of ranges) {
    const parsed = parseXlsxRange(range);
    if (parsed) return parsed;
  }
  return null;
};

export const resolveTemplateAnchor = (
  workbook: ExcelJS.Workbook,
  binding: { namedRange?: string; cell?: string; column?: string; row?: number },
): { row: number; column: number } | null => {
  if (binding.namedRange) {
    const parsed = rangeOfNamedRange(workbook, binding.namedRange);
    if (parsed) return { row: parsed.startRow, column: parsed.startColumn };
  }
  if (binding.cell) {
    const parsed = parseXlsxRange(binding.cell);
    if (parsed) return { row: parsed.startRow, column: parsed.startColumn };
  }
  if (binding.column) {
    let column = 0;
    for (const character of binding.column.toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
    return { row: binding.row ?? 1, column };
  }
  if (binding.row) return { row: binding.row, column: 1 };
  return null;
};

export const analyzeWorkbookTemplate = async (buffer: Buffer): Promise<XlsxTemplateAnalysis> => {
  const issues: ValidationIssue[] = [];
  if (buffer.length > MAX_COMPRESSED_BYTES) {
    issues.push({ path: "/", rule: "size", message: "Template exceeds 20 MB" });
  }
  let names: string[] = [];
  let uncompressed = 0;
  let exceeded = false;
  try {
    const files = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        if (uncompressed + file.originalSize > MAX_UNCOMPRESSED_BYTES) {
          exceeded = true;
          return false;
        }
        uncompressed += file.originalSize;
        return true;
      },
    });
    names = Object.keys(files);
  } catch {
    issues.push({ path: "/", rule: "zip", message: "The workbook is not a readable .xlsx zip archive" });
  }
  if (exceeded) issues.push({ path: "/", rule: "zip-bomb", message: "The uncompressed workbook is too large" });
  const forbidden = FORBIDDEN_ENTRIES.filter((entry) => names.some((name) => name.toLowerCase().includes(entry.toLowerCase())));
  const macros = forbidden.includes("vbaProject.bin");
  const externalLinks = forbidden.includes("xl/externalLinks/");
  const oleObjects = forbidden.includes("xl/embeddings/") || forbidden.includes("xl/oleObject");
  if (forbidden.length > 0) {
    issues.push({ path: "/", rule: "security", message: `Forbidden workbook entries: ${forbidden.join(", ")}` });
  }
  if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
    issues.push({ path: "/", rule: "zip-bomb", message: "The uncompressed workbook is too large" });
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch (error) {
    return {
      sheets: [],
      namedRanges: [],
      cellCount: 0,
      formulaCount: 0,
      security: { macros, externalLinks, oleObjects, zipBomb: uncompressed > MAX_UNCOMPRESSED_BYTES, forbidden },
      issues: [...issues, { path: "/", rule: "workbook", message: `Cannot parse workbook: ${(error as Error).message}` }],
    };
  }
  if (workbook.worksheets.length > MAX_SHEETS) {
    issues.push({ path: "/", rule: "sheets", message: `Workbook has more than ${MAX_SHEETS} sheets` });
  }
  let cellCount = 0;
  let formulaCount = 0;
  const sheets = workbook.worksheets.map((worksheet) => {
    let sheetFormulas = 0;
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.type === ExcelJS.ValueType.Formula || cell.formula) sheetFormulas += 1;
      });
    });
    const rows = worksheet.rowCount;
    const columns = worksheet.columnCount;
    cellCount += rows * columns;
    formulaCount += sheetFormulas;
    return { name: worksheet.name, rowCount: rows, columnCount: columns, mergedCells: worksheet.model.merges?.length ?? 0, formulaCount: sheetFormulas };
  });
  if (cellCount > MAX_CELLS) issues.push({ path: "/", rule: "cells", message: `Workbook has more than ${MAX_CELLS} cells` });
  return {
    sheets,
    namedRanges: (workbook.definedNames.model ?? []).map((entry) => ({ name: entry.name, ranges: entry.ranges })),
    cellCount,
    formulaCount,
    security: { macros, externalLinks, oleObjects, zipBomb: uncompressed > MAX_UNCOMPRESSED_BYTES, forbidden },
    issues,
  };
};

export const templateBindingRequired = (binding: XlsxTemplateBinding | null | undefined): ValidationIssue[] =>
  binding?.mode === "TEMPLATE" && binding.sheets.length > 0
    ? []
    : [{ path: "/", rule: "template-binding", message: "A template binding with at least one mapped sheet is required" }];
