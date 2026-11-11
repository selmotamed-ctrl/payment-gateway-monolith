import { assertSafeXml, parseSafeXml, type XmlNode } from "./safeXml";
import type {
  XsdAttributeNode,
  XsdCodeList,
  XsdCompiledAst,
  XsdElementNode,
  XsdPathInfo,
  XsdPrimitiveType,
  XsdTypeFacets,
} from "./types";

const MAX_XSD_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_REPEAT = 5000;
const EXTERNAL_SCHEMA_PATTERN = /<(?:xs|xsd):(?:import|include|redefine)\b[^>]*\bschemaLocation\s*=\s*["']https?:/i;
const PRIMITIVE_TYPES = new Set<string>([
  "string",
  "token",
  "normalizedString",
  "int",
  "integer",
  "long",
  "positiveInteger",
  "nonNegativeInteger",
  "decimal",
  "boolean",
  "date",
  "dateTime",
]);

export class XsdCompileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "XsdCompileError";
    this.code = code;
  }
}

interface TypeDefinitions {
  complex: Map<string, XmlNode>;
  simple: Map<string, XmlNode>;
  elements: Map<string, XmlNode>;
}

const localName = (name: string): string => {
  const index = name.indexOf(":");
  return index === -1 ? name : name.slice(index + 1);
};

const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((child) => child.localName === name);

const firstChildNamed = (node: XmlNode, name: string): XmlNode | undefined =>
  node.children.find((child) => child.localName === name);

const documentationOf = (node: XmlNode): string | undefined => {
  const annotation = firstChildNamed(node, "annotation");
  const documentation = annotation ? firstChildNamed(annotation, "documentation") : undefined;
  return documentation?.text.trim() || undefined;
};

const integerAttribute = (node: XmlNode, name: string, fallback: number): number => {
  const raw = node.attributes[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const maxOccursOf = (node: XmlNode): number | "unbounded" => {
  const raw = node.attributes.maxOccurs;
  if (raw === undefined) return 1;
  if (raw === "unbounded") return "unbounded";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new XsdCompileError("XSD_INVALID_MAX_OCCURS", `Invalid maxOccurs '${raw}'`);
  }
  return parsed;
};

const primitiveType = (base: string | undefined): XsdPrimitiveType => {
  const name = base ? localName(base) : "string";
  if (!PRIMITIVE_TYPES.has(name)) {
    throw new XsdCompileError("XSD_UNSUPPORTED_TYPE", `Unsupported XSD base type '${base ?? ""}'`);
  }
  return `xs:${name}` as XsdPrimitiveType;
};

const facetsOf = (
  node: XmlNode,
  definitions: TypeDefinitions,
  seen = new Set<string>(),
): XsdTypeFacets => {
  const restriction = firstChildNamed(node, "restriction");
  if (!restriction) {
    const extension = firstChildNamed(node, "extension");
    if (extension) return facetsOf(extension, definitions, seen);
    return { baseType: "xs:string" };
  }
  const base = restriction.attributes.base;
  const named = base ? definitions.simple.get(localName(base)) : undefined;
  if (named && base) {
    const name = localName(base);
    if (seen.has(name)) throw new XsdCompileError("XSD_RECURSIVE_TYPE", `Recursive simple type '${base}'`);
    seen.add(name);
    const inherited = facetsOf(named, definitions, seen);
    return applyFacets(inherited, restriction);
  }
  return applyFacets({ baseType: primitiveType(base) }, restriction);
};

const applyFacets = (base: XsdTypeFacets, restriction: XmlNode): XsdTypeFacets => {
  const facets: XsdTypeFacets = { ...base };
  const enumerations: string[] = [];
  for (const child of restriction.children) {
    const value = child.attributes.value;
    if (value === undefined) continue;
    switch (child.localName) {
      case "minLength":
        facets.minLength = Number.parseInt(value, 10);
        break;
      case "maxLength":
        facets.maxLength = Number.parseInt(value, 10);
        break;
      case "length":
        facets.length = Number.parseInt(value, 10);
        break;
      case "pattern":
        facets.pattern = value;
        break;
      case "minInclusive":
        facets.minInclusive = value;
        break;
      case "maxInclusive":
        facets.maxInclusive = value;
        break;
      case "totalDigits":
        facets.totalDigits = Number.parseInt(value, 10);
        break;
      case "fractionDigits":
        facets.fractionDigits = Number.parseInt(value, 10);
        break;
      case "enumeration":
        enumerations.push(value);
        break;
      default:
        break;
    }
  }
  if (enumerations.length > 0) facets.enumeration = enumerations;
  return facets;
};

const attributesOf = (node: XmlNode, definitions: TypeDefinitions): XsdAttributeNode[] =>
  childrenNamed(node, "attribute").map((attribute) => {
    const typeName = attribute.attributes.type;
    const namedSimple = typeName ? definitions.simple.get(localName(typeName)) : undefined;
    const facets = namedSimple ? facetsOf(namedSimple, definitions) : { baseType: primitiveType(typeName) };
    return {
      name: attribute.attributes.name ?? "",
      use: (attribute.attributes.use as XsdAttributeNode["use"] | undefined) ?? "optional",
      ...(attribute.attributes.default !== undefined ? { defaultValue: attribute.attributes.default } : {}),
      ...(attribute.attributes.fixed !== undefined ? { fixedValue: attribute.attributes.fixed } : {}),
      facets,
    };
  });

const compositorOf = (node: XmlNode): "sequence" | "choice" | "all" | undefined => {
  const direct = node.children.find((child) => ["sequence", "choice", "all"].includes(child.localName));
  if (direct) return direct.localName as "sequence" | "choice" | "all";
  const content = firstChildNamed(node, "complexContent");
  const extension = content ? firstChildNamed(content, "extension") : undefined;
  if (extension) return compositorOf(extension);
  return undefined;
};

const compositorNode = (node: XmlNode): XmlNode | undefined => {
  const direct = node.children.find((child) => ["sequence", "choice", "all"].includes(child.localName));
  if (direct) return direct;
  const content = firstChildNamed(node, "complexContent");
  const extension = content ? firstChildNamed(content, "extension") : undefined;
  return extension ? compositorNode(extension) : undefined;
};

const buildElement = (
  source: XmlNode,
  path: string,
  order: number,
  definitions: TypeDefinitions,
  depth: number,
  overrides: { name?: string; minOccurs?: number; maxOccurs?: number | "unbounded" } = {},
): XsdElementNode => {
  if (depth > MAX_DEPTH) throw new XsdCompileError("XSD_NESTING_TOO_DEEP", "The XSD nesting exceeds the limit");
  const reference = source.attributes.ref ? localName(source.attributes.ref) : null;
  const resolved = reference ? definitions.elements.get(reference) : undefined;
  if (reference && !resolved) {
    throw new XsdCompileError("XSD_UNRESOLVED_REFERENCE", `Element reference '${source.attributes.ref}' is not declared`);
  }
  const definition = resolved ?? source;
  const name = overrides.name ?? localName(definition.attributes.name ?? reference ?? "");
  if (!name) throw new XsdCompileError("XSD_ELEMENT_NAME_MISSING", "An element has no name");
  const elementPath = path === "" ? `/${name}` : `${path}/${name}`;
  const typeName = definition.attributes.type;
  const namedComplex = typeName ? definitions.complex.get(localName(typeName)) : undefined;
  const namedSimple = typeName ? definitions.simple.get(localName(typeName)) : undefined;
  const inlineComplex = firstChildNamed(definition, "complexType");
  const inlineSimple = firstChildNamed(definition, "simpleType");
  const complexNode = namedComplex ?? inlineComplex;
  const simpleNode = namedSimple ?? inlineSimple;
  const attributes = [
    ...attributesOf(definition, definitions),
    ...(complexNode ? attributesOf(complexNode, definitions) : []),
  ];
  const compositor = complexNode ? compositorOf(complexNode) : undefined;
  const compositorNodeValue = complexNode ? compositorNode(complexNode) : undefined;
  const children: XsdElementNode[] = compositorNodeValue
    ? childrenNamed(compositorNodeValue, "element")
        .map((child, index) => {
          if ((child.attributes.maxOccurs ?? "1") === "unbounded" && MAX_REPEAT <= 0) {
            throw new XsdCompileError("XSD_INVALID_REPEAT", "Repeating elements are not allowed");
          }
          return buildElement(child, elementPath, index, definitions, depth + 1);
        })
    : [];
  const facets = simpleNode
    ? facetsOf(simpleNode, definitions)
    : typeName && PRIMITIVE_TYPES.has(localName(typeName))
      ? { baseType: primitiveType(typeName) }
      : namedSimple
        ? facetsOf(namedSimple, definitions)
        : undefined;
  const kind: XsdElementNode["kind"] = children.length > 0 || Boolean(complexNode) ? "complex" : "simple";
  return {
    name,
    path: elementPath,
    sequenceOrder: order,
    minOccurs: overrides.minOccurs ?? integerAttribute(definition, "minOccurs", 1),
    maxOccurs: overrides.maxOccurs ?? maxOccursOf(definition),
    ...(definition.attributes.nillable === "true" ? { nillable: true } : {}),
    ...(documentationOf(definition) ? { documentation: documentationOf(definition) } : {}),
    kind,
    ...(compositor ? { compositor } : {}),
    ...(facets ? { facets } : {}),
    attributes,
    children,
  };
};

const indexPaths = (
  node: XsdElementNode,
  paths: Record<string, XsdPathInfo>,
  codeLists: Record<string, XsdCodeList>,
): void => {
  for (const attribute of node.attributes) {
    paths[`${node.path}/@${attribute.name}`] = {
      path: `${node.path}/@${attribute.name}`,
      kind: "simple",
      minOccurs: attribute.use === "required" ? 1 : 0,
      maxOccurs: 1,
      facets: attribute.facets,
    };
  }
  paths[node.path] = {
    path: node.path,
    kind: node.kind,
    minOccurs: node.minOccurs,
    maxOccurs: node.maxOccurs,
    ...(node.facets ? { facets: node.facets } : {}),
    ...(node.documentation ? { documentation: node.documentation } : {}),
  };
  if (node.facets?.enumeration && node.facets.enumeration.length > 0) {
    const key = node.name || node.path;
    const existing = codeLists[key];
    if (existing) {
      if (!existing.usedByPaths.includes(node.path)) existing.usedByPaths.push(node.path);
      existing.allowedValues = [...new Set([...existing.allowedValues, ...node.facets.enumeration])];
    } else {
      codeLists[key] = { name: key, usedByPaths: [node.path], allowedValues: [...node.facets.enumeration] };
    }
  }
  for (const child of node.children) indexPaths(child, paths, codeLists);
};

export const compileXsd = (xsdXml: string): XsdCompiledAst => {
  assertSafeXml(xsdXml, MAX_XSD_BYTES);
  if (EXTERNAL_SCHEMA_PATTERN.test(xsdXml)) {
    throw new XsdCompileError(
      "XSD_EXTERNAL_IMPORT_FORBIDDEN",
      "External schemaLocation imports/includes are forbidden; upload a self-contained XSD",
    );
  }
  let rootXml: XmlNode;
  try {
    rootXml = parseSafeXml(xsdXml, MAX_XSD_BYTES);
  } catch (error) {
    throw new XsdCompileError("XSD_INVALID_XML", (error as Error).message);
  }
  if (rootXml.localName !== "schema") {
    throw new XsdCompileError("XSD_ROOT_INVALID", "The document root must be xs:schema");
  }
  const definitions: TypeDefinitions = { complex: new Map(), simple: new Map(), elements: new Map() };
  for (const child of rootXml.children) {
    if (child.localName === "complexType" && child.attributes.name) definitions.complex.set(child.attributes.name, child);
    if (child.localName === "simpleType" && child.attributes.name) definitions.simple.set(child.attributes.name, child);
    if (child.localName === "element" && child.attributes.name) definitions.elements.set(child.attributes.name, child);
  }
  const rootDefinition = childrenNamed(rootXml, "element").find((child) => child.attributes.name);
  if (!rootDefinition) {
    throw new XsdCompileError("XSD_ROOT_ELEMENT_MISSING", "The XSD must declare a root xs:element");
  }
  const rootElement = buildElement(rootDefinition, "", 0, definitions, 0);
  const paths: Record<string, XsdPathInfo> = {};
  const codeLists: Record<string, XsdCodeList> = {};
  indexPaths(rootElement, paths, codeLists);
  return {
    targetNamespace: rootXml.attributes.targetNamespace ?? null,
    elementFormDefault: rootXml.attributes.elementFormDefault === "qualified" ? "qualified" : "unqualified",
    rootElement,
    paths,
    codeLists,
  };
};
