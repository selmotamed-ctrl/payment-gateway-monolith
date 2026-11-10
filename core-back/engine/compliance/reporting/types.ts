export type ReportOutputFormat = "XML" | "XLSX" | "DOCX";
export type RegulatorySchemaStatus = "DRAFT" | "PROVISIONAL" | "PENDING_APPROVAL" | "CONFIRMED" | "SUPERSEDED" | "ARCHIVED";
export type ReportOutputValidationStatus = "NOT_GENERATED" | "PROVISIONAL_SCHEMA" | "VALIDATED" | "INVALID";

export type XsdPrimitiveType =
  | "xs:string"
  | "xs:token"
  | "xs:normalizedString"
  | "xs:int"
  | "xs:integer"
  | "xs:long"
  | "xs:positiveInteger"
  | "xs:nonNegativeInteger"
  | "xs:decimal"
  | "xs:boolean"
  | "xs:date"
  | "xs:dateTime";

export interface XsdTypeFacets {
  baseType: XsdPrimitiveType;
  minLength?: number;
  maxLength?: number;
  length?: number;
  pattern?: string;
  enumeration?: string[];
  minInclusive?: string;
  maxInclusive?: string;
  totalDigits?: number;
  fractionDigits?: number;
}

export interface XsdAttributeNode {
  name: string;
  use: "required" | "optional" | "prohibited";
  defaultValue?: string;
  fixedValue?: string;
  facets: XsdTypeFacets;
}

export interface XsdElementNode {
  name: string;
  path: string;
  sequenceOrder: number;
  minOccurs: number;
  maxOccurs: number | "unbounded";
  nillable?: boolean;
  documentation?: string;
  kind: "simple" | "complex";
  compositor?: "sequence" | "choice" | "all";
  facets?: XsdTypeFacets;
  attributes: XsdAttributeNode[];
  children: XsdElementNode[];
}

export interface XsdPathInfo {
  path: string;
  kind: "simple" | "complex";
  minOccurs: number;
  maxOccurs: number | "unbounded";
  facets?: XsdTypeFacets;
  documentation?: string;
}

export interface XsdCodeList {
  name: string;
  usedByPaths: string[];
  allowedValues: string[];
}

export interface XsdCompiledAst {
  targetNamespace: string | null;
  elementFormDefault: "qualified" | "unqualified";
  rootElement: XsdElementNode;
  paths: Record<string, XsdPathInfo>;
  codeLists: Record<string, XsdCodeList>;
}

export interface TransformPipe {
  op: string;
  args?: unknown[];
}

export interface ElementFieldCondition {
  contextPath: string;
  operator: "EQ" | "NEQ" | "IN" | "NOT_EMPTY" | "GT";
  value?: unknown;
}

export interface ElementFieldBinding {
  xsdPath: string;
  sourceKind: "CONTEXT_PATH" | "CONSTANT" | "CODE_MAP" | "TEMPLATE";
  contextPath?: string;
  constantValue?: string;
  codeMapKey?: string;
  transforms?: TransformPipe[];
  condition?: ElementFieldCondition;
}

export interface RepeatingNodeBinding {
  xsdPath: string;
  repeatOverContextPath: string;
  itemAlias: string;
}

export interface CrossFieldAssertion {
  id: string;
  description: string;
  when: { xsdPath: string; operator: "EQ" | "IN"; value: string | string[] };
  requirePaths: string[];
}

export interface GoamlMappingBlueprint {
  schemaVersion: 1;
  repeatingNodes: RepeatingNodeBinding[];
  fieldBindings: ElementFieldBinding[];
  codeMaps: Record<string, { description: string; mappings: Record<string, string>; defaultFallback?: string }>;
  assertions: CrossFieldAssertion[];
}

export interface ValidationIssue {
  path: string;
  rule: string;
  message: string;
  actual?: string;
}

export interface XlsxColumn {
  key: string;
  header: string;
  type: "string" | "number" | "date" | "boolean" | "list";
  required?: boolean;
  width?: number;
  numberFormat?: string;
  list?: string[];
}

export interface XlsxTotals {
  column: string;
  function: "sum";
}

export interface XlsxSheet {
  name: string;
  order: number;
  columns: XlsxColumn[];
  rows: { repeatOver: string };
  totals?: XlsxTotals[];
}

export interface XlsxNarrativeSection {
  key: string;
  title: string;
  required?: boolean;
  maxLength?: number;
}

export interface XlsxValidationRule {
  id: string;
  type: "TOTAL_MATCH" | "ROW_COUNT" | "REQUIRED_SECTION";
  contextPath?: string;
  column?: string;
  value?: unknown;
}

export interface DocxNarrativeSection {
  key: string;
  title: string;
  headingLevel?: 1 | 2 | 3;
  contextPath?: string;
  required?: boolean;
}

export interface DocxNarrativeTable {
  title: string;
  rowsPath: string;
  columns: Array<{ key: string; header: string }>;
}

export interface DocxNarrativeSchema {
  schemaVersion: 1;
  mode: "DOCX";
  title: string;
  subtitle?: string;
  sections: DocxNarrativeSection[];
  tables?: DocxNarrativeTable[];
}

export interface XlsxWorkbookSchema {
  schemaVersion: 1;
  mode: "TEMPLATE" | "GENERATED";
  sheets: XlsxSheet[];
  narrativeSections?: XlsxNarrativeSection[];
  validations?: XlsxValidationRule[];
}

export interface ReportSchemaRecord {
  id: string;
  authority: string;
  reportType: string;
  format: ReportOutputFormat;
  schemaCode: string;
  name: string;
  version: number;
  status: RegulatorySchemaStatus;
  definitionText: string | null;
  templateCiphertext: string | null;
  compiledDefinitionJson: unknown;
  mappingBlueprintJson: unknown;
}

export interface ReportGenerationResult {
  format: ReportOutputFormat;
  content: string | Buffer;
  sha256: string;
  validationStatus: ReportOutputValidationStatus;
  errors: ValidationIssue[];
  schemaId: string | null;
  schemaVersion: number | null;
}


export interface XlsxTemplateColumnBinding {
  key: string;
  header?: string;
  namedRange?: string;
  column?: string;
  type?: "string" | "number" | "date" | "boolean" | "list";
}

export interface XlsxTemplateSheetBinding {
  name: string;
  tableName?: string;
  rangeName?: string;
  headerRow?: number;
  dataStartRow?: number;
  prototypeRow?: number;
  columns: XlsxTemplateColumnBinding[];
  totals?: Array<{ column: string; function: "sum"; namedRange?: string; row?: number }>;
}

export interface XlsxTemplateNarrativeBinding {
  key: string;
  namedRange?: string;
  cell?: string;
}

export interface XlsxTemplateBinding {
  mode: "TEMPLATE";
  sheets: XlsxTemplateSheetBinding[];
  narrative?: XlsxTemplateNarrativeBinding[];
  namedRanges?: string[];
}
