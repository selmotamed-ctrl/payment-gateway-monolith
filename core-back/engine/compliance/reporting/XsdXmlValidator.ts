import { parseSafeXml, type XmlNode } from "./safeXml";
import type {
  CrossFieldAssertion,
  GoamlMappingBlueprint,
  ValidationIssue,
  XsdCompiledAst,
  XsdElementNode,
  XsdTypeFacets,
} from "./types";

const MAX_REPEAT = 5000;

const asNumber = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validateFacets = (value: string, facets: XsdTypeFacets, path: string, issues: ValidationIssue[]): void => {
  if (facets.minLength !== undefined && value.length < facets.minLength) {
    issues.push({ path, rule: "minLength", message: `Must be at least ${facets.minLength} characters`, actual: value });
  }
  if (facets.maxLength !== undefined && value.length > facets.maxLength) {
    issues.push({ path, rule: "maxLength", message: `Must be at most ${facets.maxLength} characters`, actual: value });
  }
  if (facets.length !== undefined && value.length !== facets.length) {
    issues.push({ path, rule: "length", message: `Must be exactly ${facets.length} characters`, actual: value });
  }
  if (facets.pattern !== undefined) {
    try {
      if (!new RegExp(`^(?:${facets.pattern})$`).test(value)) {
        issues.push({ path, rule: "pattern", message: "Does not match the required pattern", actual: value });
      }
    } catch {
      issues.push({ path, rule: "pattern", message: "The XSD pattern is invalid", actual: facets.pattern });
    }
  }
  if (facets.enumeration && !facets.enumeration.includes(value)) {
    issues.push({
      path,
      rule: "enumeration",
      message: `Must be one of: ${facets.enumeration.join(", ")}`,
      actual: value,
    });
  }
  const numeric = facets.baseType === "xs:decimal" || facets.baseType.endsWith("Integer") || facets.baseType === "xs:int" || facets.baseType === "xs:long";
  if (numeric) {
    const parsed = asNumber(value);
    if (parsed === null) {
      issues.push({ path, rule: "type", message: `Must be ${facets.baseType}`, actual: value });
    } else {
      if (facets.baseType === "xs:int" || facets.baseType === "xs:integer" || facets.baseType === "xs:long") {
        if (!Number.isInteger(parsed)) issues.push({ path, rule: "type", message: "Must be an integer", actual: value });
      }
      if (facets.minInclusive !== undefined && parsed < Number(facets.minInclusive)) {
        issues.push({ path, rule: "minInclusive", message: `Must be at least ${facets.minInclusive}`, actual: value });
      }
      if (facets.maxInclusive !== undefined && parsed > Number(facets.maxInclusive)) {
        issues.push({ path, rule: "maxInclusive", message: `Must be at most ${facets.maxInclusive}`, actual: value });
      }
      if (facets.fractionDigits !== undefined) {
        const fraction = value.split(".")[1] ?? "";
        if (fraction.length > facets.fractionDigits) {
          issues.push({ path, rule: "fractionDigits", message: `At most ${facets.fractionDigits} decimal places`, actual: value });
        }
      }
      if (facets.totalDigits !== undefined && value.replace(/[^0-9]/g, "").length > facets.totalDigits) {
        issues.push({ path, rule: "totalDigits", message: `At most ${facets.totalDigits} digits`, actual: value });
      }
      if ((facets.baseType === "xs:positiveInteger" && parsed <= 0) || (facets.baseType === "xs:nonNegativeInteger" && parsed < 0)) {
        issues.push({ path, rule: "type", message: `Must be ${facets.baseType}`, actual: value });
      }
    }
  }
  if (facets.baseType === "xs:date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push({ path, rule: "type", message: "Must be an ISO date (YYYY-MM-DD)", actual: value });
  }
  if (facets.baseType === "xs:dateTime" && Number.isNaN(Date.parse(value))) {
    issues.push({ path, rule: "type", message: "Must be an ISO date-time", actual: value });
  }
  if (facets.baseType === "xs:boolean" && !["true", "false", "1", "0"].includes(value)) {
    issues.push({ path, rule: "type", message: "Must be a boolean", actual: value });
  }
};

const validateNode = (
  ast: XsdElementNode,
  xml: XmlNode,
  issues: ValidationIssue[],
): void => {
  const path = ast.path;
  if (xml.localName !== ast.name) {
    issues.push({ path, rule: "element", message: `Expected <${ast.name}>, found <${xml.localName}>` });
    return;
  }
  for (const attribute of ast.attributes) {
    const attributeValue = xml.attributes[attribute.name];
    if (attribute.use === "required" && attributeValue === undefined) {
      issues.push({ path: `${path}/@${attribute.name}`, rule: "required", message: "Required attribute is missing" });
    }
    if (attributeValue !== undefined) {
      validateFacets(attributeValue, attribute.facets, `${path}/@${attribute.name}`, issues);
    }
  }
  if (ast.kind === "simple" || ast.children.length === 0) {
    const value = xml.text.trim();
    if (value === "" && ast.minOccurs > 0) {
      issues.push({ path, rule: "minOccurs", message: "Required element is missing or empty" });
      return;
    }
    if (ast.facets && value !== "") validateFacets(value, ast.facets, path, issues);
    return;
  }
  const byName = new Map<string, XmlNode[]>();
  for (const child of xml.children) {
    const list = byName.get(child.localName);
    if (list) list.push(child);
    else byName.set(child.localName, [child]);
  }
  let choiceCount = 0;
  for (const child of ast.children) {
    const matches = byName.get(child.name) ?? [];
    if (matches.length > 0) choiceCount += 1;
    const maximum = child.maxOccurs === "unbounded" ? MAX_REPEAT : child.maxOccurs;
    if (matches.length < child.minOccurs) {
      issues.push({
        path: child.path,
        rule: "minOccurs",
        message: `Required ${child.minOccurs} occurrence(s), found ${matches.length}`,
      });
    }
    if (matches.length > maximum) {
      issues.push({
        path: child.path,
        rule: "maxOccurs",
        message: `At most ${child.maxOccurs} occurrence(s), found ${matches.length}`,
      });
    }
    for (const match of matches) validateNode(child, match, issues);
  }
  if (ast.compositor === "choice" && choiceCount === 0 && ast.minOccurs > 0) {
    issues.push({ path, rule: "choice", message: "At least one choice branch is required" });
  }
  if (ast.compositor === "choice" && choiceCount > 1) {
    issues.push({ path, rule: "choice", message: "Only one choice branch may be emitted" });
  }
};

const valueAtPath = (root: XmlNode, path: string): string | null => {
  const parts = path.split("/").filter(Boolean);
  let current: XmlNode | undefined = root;
  for (const part of parts) {
    if (!current) return null;
    current = current.children.find((child) => child.localName === part);
  }
  return current ? current.text.trim() : null;
};

const validateAssertions = (
  root: XmlNode,
  assertions: readonly CrossFieldAssertion[],
  issues: ValidationIssue[],
): void => {
  for (const assertion of assertions) {
    const value = valueAtPath(root, assertion.when.xsdPath);
    if (value === null) continue;
    const matches = Array.isArray(assertion.when.value)
      ? assertion.when.value.includes(value)
      : value === assertion.when.value;
    if (!matches) continue;
    for (const required of assertion.requirePaths) {
      const requiredValue = valueAtPath(root, required);
      if (requiredValue === null || requiredValue === "") {
        issues.push({
          path: required,
          rule: "assertion",
          message: assertion.description || `Required when ${assertion.when.xsdPath} matches`,
          actual: assertion.id,
        });
      }
    }
  }
};

export interface XmlValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export const validateXml = (
  xml: string,
  ast: XsdCompiledAst,
  blueprint?: GoamlMappingBlueprint,
): XmlValidationResult => {
  const issues: ValidationIssue[] = [];
  let root: XmlNode;
  try {
    root = parseSafeXml(xml);
  } catch (error) {
    return { valid: false, issues: [{ path: "/", rule: "xml", message: (error as Error).message }] };
  }
  validateNode(ast.rootElement, root, issues);
  if (blueprint) validateAssertions(root, blueprint.assertions, issues);
  return { valid: issues.length === 0, issues };
};
