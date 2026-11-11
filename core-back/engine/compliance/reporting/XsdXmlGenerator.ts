import { escapeXml } from "./safeXml";
import { TransformPipeline } from "../../transforms/TransformPipeline";
import type {
  ElementFieldBinding,
  GoamlMappingBlueprint,
  RepeatingNodeBinding,
  XsdCompiledAst,
  XsdElementNode,
} from "./types";

type Scope = Record<string, unknown>;

const asRecord = (value: unknown): Scope =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Scope : {};

const resolvePath = (scope: Scope, path: string | undefined): unknown => {
  if (!path) return undefined;
  const parts = path.split(".").filter(Boolean);
  let current: unknown = scope;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[0];
      if (current === null || current === undefined) return undefined;
    }
    current = asRecord(current)[part];
  }
  return current;
};

const conditionMatches = (binding: ElementFieldBinding, scope: Scope): boolean => {
  const condition = binding.condition;
  if (!condition) return true;
  const value = resolvePath(scope, condition.contextPath);
  switch (condition.operator) {
    case "EQ":
      return String(value ?? "") === String(condition.value ?? "");
    case "NEQ":
      return String(value ?? "") !== String(condition.value ?? "");
    case "IN":
      return Array.isArray(condition.value)
        ? condition.value.map(String).includes(String(value ?? ""))
        : false;
    case "NOT_EMPTY":
      return value !== null && value !== undefined && String(value).trim() !== "";
    case "GT":
      return Number(value) > Number(condition.value);
    default:
      return true;
  }
};

export class XsdXmlGenerator {
  private readonly pipeline: TransformPipeline;

  constructor(pipeline = new TransformPipeline()) {
    this.pipeline = pipeline;
  }

  async generate(
    ast: XsdCompiledAst,
    blueprint: GoamlMappingBlueprint,
    context: Scope,
  ): Promise<string> {
    const fieldByPath = new Map(blueprint.fieldBindings.map((binding) => [binding.xsdPath, binding]));
    const repeatByPath = new Map(blueprint.repeatingNodes.map((binding) => [binding.xsdPath, binding]));
    const render = async (
      node: XsdElementNode,
      scope: Scope,
      indent: string,
      isRoot = false,
    ): Promise<string[]> => {
      const repeat = repeatByPath.get(node.path);
      if (repeat) {
        const list = resolvePath(scope, repeat.repeatOverContextPath);
        const items = Array.isArray(list) ? list.slice(0, 5000) : [];
        const output: string[] = [];
        for (const item of items) {
          output.push(...await renderSingle(node, { ...scope, [repeat.itemAlias]: item }, indent, isRoot));
        }
        return output;
      }
      return renderSingle(node, scope, indent, isRoot);
    };
    const renderSingle = async (
      node: XsdElementNode,
      scope: Scope,
      indent: string,
      isRoot: boolean,
    ): Promise<string[]> => {
      const binding = fieldByPath.get(node.path);
      if (binding && !conditionMatches(binding, scope)) return [];
      const attributeParts: string[] = [];
      if (isRoot && ast.targetNamespace) attributeParts.push(`xmlns="${escapeXml(ast.targetNamespace)}"`);
      for (const attribute of node.attributes) {
        const attributeBinding = fieldByPath.get(`${node.path}/@${attribute.name}`);
        const attributeValue = await this.resolveValue(attributeBinding, blueprint, scope);
        if (attributeValue !== null && attributeValue !== undefined && attributeValue !== "") {
          attributeParts.push(`${attribute.name}="${escapeXml(attributeValue)}"`);
        } else if (attribute.defaultValue !== undefined) {
          attributeParts.push(`${attribute.name}="${escapeXml(attribute.defaultValue)}"`);
        }
      }
      const attributes = attributeParts.length > 0 ? ` ${attributeParts.join(" ")}` : "";
      if (node.kind === "simple" || node.children.length === 0) {
        const value = await this.resolveValue(binding, blueprint, scope);
        if (value === null || value === undefined || value === "") {
          if (node.minOccurs === 0) return [];
          return [`${indent}<${node.name}${attributes}></${node.name}>`];
        }
        return [`${indent}<${node.name}${attributes}>${escapeXml(value)}</${node.name}>`];
      }
      const ordered = [...node.children].sort((left, right) => left.sequenceOrder - right.sequenceOrder);
      const childLines: string[] = [];
      for (const child of ordered) {
        childLines.push(...await render(child, scope, `${indent}  `));
      }
      if (childLines.length === 0 && node.minOccurs === 0) return [];
      return [`${indent}<${node.name}${attributes}>`, ...childLines, `${indent}</${node.name}>`];
    };
    const lines = await render(ast.rootElement, context, "", true);
    return [`<?xml version="1.0" encoding="UTF-8"?>`, ...lines].join("\n");
  }

  private async resolveValue(
    binding: ElementFieldBinding | undefined,
    blueprint: GoamlMappingBlueprint,
    scope: Scope,
  ): Promise<unknown> {
    if (!binding) return undefined;
    let value: unknown;
    switch (binding.sourceKind) {
      case "CONSTANT":
        value = binding.constantValue;
        break;
      case "CODE_MAP": {
        const raw = resolvePath(scope, binding.contextPath);
        const map = binding.codeMapKey ? blueprint.codeMaps[binding.codeMapKey] : undefined;
        if (!map) return raw;
        const key = String(raw ?? "");
        value = map.mappings[key] ?? map.defaultFallback;
        break;
      }
      case "TEMPLATE": {
        const template = binding.constantValue ?? "";
        value = template.replace(/\{([^}]+)\}/g, (_match, path: string) => String(resolvePath(scope, path) ?? ""));
        break;
      }
      case "CONTEXT_PATH":
      default:
        value = resolvePath(scope, binding.contextPath);
        break;
    }
    if (binding.transforms && binding.transforms.length > 0 && value !== null && value !== undefined) {
      value = await this.pipeline.apply(value, binding.transforms as never);
    }
    return value;
  }
}
