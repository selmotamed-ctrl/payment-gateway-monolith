import { strToU8, zipSync } from "fflate";
import type { DocxNarrativeSchema, ValidationIssue } from "../../engine/compliance/reporting/types";

type Scope = Record<string, unknown>;
const asRecord = (value: unknown): Scope => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Scope : {};
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
const escapeXml = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const paragraph = (text: string, style?: string): string =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

const table = (title: string, headers: string[], rows: string[][]): string => {
  const cell = (value: string, bold = false): string =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${bold ? "<w:pPr><w:pStyle w:val=\"TableHeader\"/></w:pPr>" : ""}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p></w:tc>`;
  return `${paragraph(title, "Heading2")}<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>`
    + `<w:tr>${headers.map((header) => cell(header, true)).join("")}</w:tr>`
    + rows.map((row) => `<w:tr>${row.map((value) => cell(value)).join("")}</w:tr>`).join("")
    + "</w:tbl>";
};

export const parseDocxNarrativeSchema = (value: unknown): DocxNarrativeSchema => {
  const input = asRecord(value);
  if (input.schemaVersion !== 1 || input.mode !== "DOCX" || typeof input.title !== "string" || !Array.isArray(input.sections)) {
    throw new Error("A DOCX schema requires schemaVersion 1, mode DOCX, a title and sections");
  }
  const sections = input.sections.map((section) => {
    const entry = asRecord(section);
    if (typeof entry.key !== "string" || typeof entry.title !== "string") throw new Error("Every DOCX section requires key and title");
    return {
      key: entry.key,
      title: entry.title,
      headingLevel: (entry.headingLevel === 1 || entry.headingLevel === 2 || entry.headingLevel === 3 ? entry.headingLevel : 1) as 1 | 2 | 3,
      ...(typeof entry.contextPath === "string" ? { contextPath: entry.contextPath } : {}),
      ...(entry.required === true ? { required: true } : {}),
    };
  });
  const tables = Array.isArray(input.tables) ? input.tables.map((tableValue) => {
    const entry = asRecord(tableValue);
    if (typeof entry.title !== "string" || typeof entry.rowsPath !== "string" || !Array.isArray(entry.columns)) throw new Error("Every DOCX table requires title, rowsPath and columns");
    return {
      title: entry.title,
      rowsPath: entry.rowsPath,
      columns: entry.columns.map((column) => {
        const item = asRecord(column);
        if (typeof item.key !== "string" || typeof item.header !== "string") throw new Error("Every DOCX table column requires key and header");
        return { key: item.key, header: item.header };
      }),
    };
  }) : [];
  return {
    schemaVersion: 1,
    mode: "DOCX",
    title: input.title,
    ...(typeof input.subtitle === "string" ? { subtitle: input.subtitle } : {}),
    sections,
    tables,
  };
};

const documentXml = (schema: DocxNarrativeSchema, context: Scope, issues: ValidationIssue[]): string => {
  const body: string[] = [paragraph(schema.title, "Title")];
  if (schema.subtitle) body.push(paragraph(schema.subtitle, "Subtitle"));
  const narrative = asRecord(context.narrative);
  for (const section of schema.sections) {
    const value = section.contextPath ? resolvePath(context, section.contextPath) : narrative[section.key];
    if (section.required && (value === null || value === undefined || String(value).trim() === "")) {
      issues.push({ path: `/narrative/${section.key}`, rule: "REQUIRED_SECTION", message: `Required section '${section.key}' is missing` });
      continue;
    }
    if (value === null || value === undefined || String(value).trim() === "") continue;
    body.push(paragraph(section.title, section.headingLevel === 3 ? "Heading3" : section.headingLevel === 2 ? "Heading2" : "Heading1"));
    for (const chunk of String(value).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
      body.push(paragraph(chunk));
    }
  }
  for (const spec of schema.tables ?? []) {
    const raw = resolvePath(context, spec.rowsPath);
    const rows = Array.isArray(raw) ? raw.map(asRecord) : [];
    if (rows.length === 0) continue;
    body.push(table(spec.title, spec.columns.map((column) => column.header), rows.map((row) => spec.columns.map((column) => String(resolvePath(row, column.key) ?? "")))));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
};

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="555555"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`;

export const renderRegulatoryDocx = (schema: DocxNarrativeSchema, context: Scope): { buffer: Buffer; issues: ValidationIssue[] } => {
  const issues: ValidationIssue[] = [];
  const document = documentXml(schema, context, issues);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(stylesXml),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
  };
  return { buffer: Buffer.from(zipSync(files, { level: 6 })), issues };
};
