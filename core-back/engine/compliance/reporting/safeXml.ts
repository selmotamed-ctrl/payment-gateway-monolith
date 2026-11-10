const MAX_XML_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_XML_PATTERNS = [/<!DOCTYPE/i, /<!ENTITY/i, /\bSYSTEM\s+["']/i, /\bPUBLIC\s+["']/i];

export interface XmlNode {
  name: string;
  localName: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export class XmlSecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "XmlSecurityError";
    this.code = code;
  }
}

export const assertSafeXml = (xml: string, maximumBytes = MAX_XML_BYTES): void => {
  if (Buffer.byteLength(xml, "utf8") > maximumBytes) {
    throw new XmlSecurityError("XML_PAYLOAD_TOO_LARGE", `The XML payload exceeds ${maximumBytes} bytes`);
  }
  for (const pattern of FORBIDDEN_XML_PATTERNS) {
    if (pattern.test(xml)) {
      throw new XmlSecurityError(
        "XML_EXTERNAL_ENTITY_FORBIDDEN",
        "DOCTYPE, ENTITY declarations and external identifiers are forbidden",
      );
    }
  }
};

const decodeEntities = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export const escapeXml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const parseAttributes = (source: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
};

const localNameOf = (name: string): string => {
  const index = name.indexOf(":");
  return index === -1 ? name : name.slice(index + 1);
};

export const parseSafeXml = (input: string, maximumBytes = MAX_XML_BYTES): XmlNode => {
  assertSafeXml(input, maximumBytes);
  const xml = input.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  const root: XmlNode = { name: "#document", localName: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open === -1) {
      stack.at(-1)!.text += decodeEntities(xml.slice(index));
      break;
    }
    if (open > index) {
      stack.at(-1)!.text += decodeEntities(xml.slice(index, open));
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end === -1) throw new XmlSecurityError("XML_MALFORMED", "Unterminated CDATA section");
      stack.at(-1)!.text += xml.slice(open + 9, end);
      index = end + 3;
      continue;
    }
    if (xml.startsWith("</", open)) {
      const end = xml.indexOf(">", open);
      if (end === -1) throw new XmlSecurityError("XML_MALFORMED", "Unterminated closing tag");
      const name = xml.slice(open + 2, end).trim();
      const current = stack.pop();
      if (!current || current.name !== name || stack.length === 0) {
        throw new XmlSecurityError("XML_MALFORMED", `Unexpected closing tag </${name}>`);
      }
      index = end + 1;
      continue;
    }
    const end = xml.indexOf(">", open);
    if (end === -1) throw new XmlSecurityError("XML_MALFORMED", "Unterminated opening tag");
    const raw = xml.slice(open + 1, end).trim();
    if (raw.startsWith("!")) throw new XmlSecurityError("XML_FORBIDDEN_DECLARATION", "Unsupported XML declaration");
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body);
    if (!nameMatch) throw new XmlSecurityError("XML_MALFORMED", "Invalid element name");
    const name = nameMatch[1]!;
    const node: XmlNode = {
      name,
      localName: localNameOf(name),
      attributes: parseAttributes(body.slice(name.length)),
      children: [],
      text: "",
    };
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
    index = end + 1;
  }
  if (stack.length !== 1) throw new XmlSecurityError("XML_MALFORMED", "Unclosed element");
  const roots = root.children;
  if (roots.length !== 1) throw new XmlSecurityError("XML_MALFORMED", "XML must have exactly one root element");
  return roots[0]!;
};

export const childText = (node: XmlNode, localName: string): string | null => {
  const child = node.children.find((entry) => entry.localName === localName);
  return child ? child.text.trim() : null;
};
