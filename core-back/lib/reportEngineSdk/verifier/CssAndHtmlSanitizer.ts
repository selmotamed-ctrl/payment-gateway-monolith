import type { ReportDiagnostic } from "../types/diagnostics";

/**
 * Allow-list HTML/SVG/CSS sanitizer for report templates, chrome templates,
 * custom SVG canvases and SVG assets.
 *
 * It tokenizes the markup (no regex scanning of raw text), so unquoted
 * attributes, entity-encoded schemes, inline `style` attributes, `srcset`,
 * SVG `<image>/<use>` references and CSS escapes are all evaluated on their
 * decoded values. Only `asset://` references (and `#fragment` for SVG
 * internals) may appear in URL positions.
 */

// ---------------------------------------------------------------------------
// Allow-lists
// ---------------------------------------------------------------------------
const HTML_TAGS = [
  "div", "span", "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark",
  "code", "pre", "kbd", "samp", "blockquote", "q", "abbr", "time", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "colgroup", "col", "section", "article", "header", "footer", "aside", "main", "nav", "figure",
  "figcaption", "img", "picture", "wbr", "bdi", "bdo",
];
const SVG_TAGS = [
  "svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text",
  "tspan", "textpath", "title", "desc", "lineargradient", "radialgradient", "stop", "clippath", "mask",
  "pattern", "marker", "symbol", "use", "image", "metadata", "filter", "fegaussianblur", "feoffset",
  "feblend", "feflood", "fecomposite", "femerge", "femergenode", "fecolormatrix", "fedropshadow",
];
const ALLOWED_TAGS = new Set([...HTML_TAGS, ...SVG_TAGS]);
/** Tags whose content is dropped together with the tag by the client sanitizer. */
const RAW_CONTENT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noscript", "noembed", "noframes", "template", "foreignobject"]);
const VOID_TAGS = new Set(["br", "hr", "img", "col", "wbr"]);

const GLOBAL_ATTRS = new Set([
  "class", "id", "style", "dir", "lang", "title", "role", "colspan", "rowspan", "scope", "headers",
  "width", "height", "align", "valign", "alt", "span", "start", "reversed", "datetime", "abbr",
]);
const SVG_ATTRS = new Set([
  "viewbox", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "d", "points",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "opacity", "transform",
  "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline",
  "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "text-decoration",
  "writing-mode", "direction", "unicode-bidi", "offset", "stop-color", "stop-opacity", "gradientunits",
  "gradienttransform", "spreadmethod", "preserveaspectratio", "xmlns", "xmlns:xlink", "xmlns:svg",
  "xml:space", "xml:lang", "version", "baseprofile", "clip-path", "clip-rule", "clippathunits", "mask",
  "maskunits", "maskcontentunits", "marker-start", "marker-mid", "marker-end", "markerwidth",
  "markerheight", "markerunits", "refx", "refy", "orient", "patternunits", "patterncontentunits",
  "patterntransform", "dx", "dy", "rotate", "textlength", "lengthadjust", "vector-effect", "visibility",
  "display", "overflow", "color", "pathlength", "filter", "filterunits", "primitiveunits", "stddeviation",
  "in", "in2", "result", "mode", "operator", "values", "type", "flood-color", "flood-opacity",
  "k1", "k2", "k3", "k4", "enable-background", "shape-rendering", "text-rendering", "image-rendering",
  "color-interpolation-filters", "startoffset",
]);
/** URL-carrying attributes: only asset:// (images) or #fragment (svg use/refs). */
const URL_ATTRS = new Set(["src", "href", "xlink:href"]);
/** Editor namespaces that are inert in browsers (Inkscape / Illustrator exports). */
const INERT_NAMESPACE_PREFIX = /^(inkscape|sodipodi|rdf|dc|cc|xmlns:(inkscape|sodipodi|rdf|dc|cc|xlink|svg))(:|$)/;

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", colon: ":", tab: "\t",
  newline: "\n", sol: "/", lpar: "(", rpar: ")", period: ".", comma: ",", semi: ";", equals: "=",
  num: "#", bsol: "\\", excl: "!", quest: "?", percnt: "%", commat: "@", lowbar: "_", hyphen: "-",
  dash: "-", grave: "`", plus: "+", ast: "*", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}", vert: "|",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "\ufffd";
      return String.fromCodePoint(code === 0 ? 0xfffd : code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Removes whitespace/control characters browsers ignore inside a URL scheme. */
const compactForSchemeCheck = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, "").toLowerCase();

export function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_m, hex: string | undefined, char: string | undefined) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
    }
    return char === "\n" ? "" : (char ?? "");
  });
}

const isAllowedReference = (rawValue: string, allowFragment: boolean, allowAsset: boolean): boolean => {
  const value = compactForSchemeCheck(decodeHtmlEntities(rawValue));
  if (value === "") return true;
  if (allowAsset && value.startsWith("asset://")) return true;
  if (allowFragment && value.startsWith("#")) return true;
  return false;
};

// ---------------------------------------------------------------------------
// CSS checker
// ---------------------------------------------------------------------------
export interface CssFinding {
  construct: string;
}

/** Returns every forbidden construct found in a CSS stylesheet or declaration list. */
export function findUnsafeCss(rawCss: string): CssFinding[] {
  const findings: CssFinding[] = [];
  if (!rawCss) return findings;
  // `<` can only serve to break out of a <style> element (`</style>`).
  if (rawCss.includes("<")) findings.push({ construct: "'<' (style element breakout)" });
  const withoutComments = rawCss.replace(/\/\*[\s\S]*?(\*\/|$)/g, " ");
  const decoded = decodeCssEscapes(withoutComments);
  if (decoded.includes("<")) findings.push({ construct: "escaped '<'" });
  const lower = decoded.toLowerCase();
  const compact = compactForSchemeCheck(decoded);

  const forbidden: Array<[RegExp, string]> = [
    [/@import\b/, "@import"],
    [/@namespace\b/, "@namespace"],
    [/@document\b|@-moz-document\b/, "@document"],
    [/expression\s*\(/, "expression()"],
    [/(?:^|[^a-z-])(?:-webkit-)?image-set\s*\(/, "image-set()"],
    [/(?:^|[^a-z-])cross-fade\s*\(/, "cross-fade()"],
    [/(?:^|[^a-z-])element\s*\(/, "element()"],
    [/(?:^|[^a-z-])src\s*\(/, "src()"],
    [/behavior\s*:/, "behavior"],
    [/-moz-binding/, "-moz-binding"],
  ];
  for (const [pattern, construct] of forbidden) {
    if (pattern.test(lower)) findings.push({ construct });
  }
  if (/javascript:|vbscript:|livescript:/.test(compact)) findings.push({ construct: "script URL scheme" });

  for (const match of lower.matchAll(/(?:^|[^a-z0-9_-])url\s*\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)?/g)) {
    const target = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!isAllowedReference(target, true, true)) {
      findings.push({ construct: `url(${target.slice(0, 60)})` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// HTML tokenizer
// ---------------------------------------------------------------------------
type HtmlToken =
  | { kind: "text"; value: string }
  | { kind: "comment" }
  | { kind: "start"; name: string; attrs: Array<{ name: string; value: string; raw: string }>; selfClosing: boolean; raw: string }
  | { kind: "end"; name: string }
  | { kind: "declaration"; value: string }
  | { kind: "error"; message: string };

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  let text = "";
  const flushText = () => {
    if (text) tokens.push({ kind: "text", value: text });
    text = "";
  };
  while (i < html.length) {
    const char = html[i]!;
    if (char !== "<") {
      text += char;
      i += 1;
      continue;
    }
    const next = html[i + 1] ?? "";
    if (html.startsWith("<!--", i)) {
      flushText();
      const end = html.indexOf("-->", i + 4);
      if (end === -1) {
        tokens.push({ kind: "error", message: "unterminated comment" });
        return tokens;
      }
      tokens.push({ kind: "comment" });
      i = end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      flushText();
      const end = html.indexOf(">", i);
      if (end === -1) {
        tokens.push({ kind: "error", message: "unterminated declaration" });
        return tokens;
      }
      tokens.push({ kind: "declaration", value: html.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (next === "/") {
      const match = /^<\/\s*([a-zA-Z][a-zA-Z0-9:_-]*)\s*>/.exec(html.slice(i));
      if (!match) {
        // Browsers treat a malformed end tag as a bogus comment.
        tokens.push({ kind: "error", message: "malformed end tag" });
        return tokens;
      }
      flushText();
      tokens.push({ kind: "end", name: match[1]!.toLowerCase() });
      i += match[0].length;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      // A bare '<' (e.g. "a < b") is text.
      text += char;
      i += 1;
      continue;
    }
    flushText();
    const tagStart = i;
    i += 1;
    let name = "";
    while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i]!)) name += html[i++];
    const attrs: Array<{ name: string; value: string; raw: string }> = [];
    let selfClosing = false;
    let closed = false;
    while (i < html.length) {
      while (i < html.length && /[\s/]/.test(html[i]!)) {
        if (html[i] === "/" && html[i + 1] === ">") selfClosing = true;
        i += 1;
      }
      if (html[i] === ">") {
        closed = true;
        i += 1;
        break;
      }
      if (i >= html.length) break;
      let attrName = "";
      while (i < html.length && !/[\s/>=]/.test(html[i]!)) attrName += html[i++];
      while (i < html.length && /\s/.test(html[i]!)) i += 1;
      let value = "";
      if (html[i] === "=") {
        i += 1;
        while (i < html.length && /\s/.test(html[i]!)) i += 1;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          if (end === -1) {
            tokens.push({ kind: "error", message: `unterminated attribute value in <${name}>` });
            return tokens;
          }
          value = html.slice(i + 1, end);
          i = end + 1;
        } else {
          while (i < html.length && !/[\s>]/.test(html[i]!)) value += html[i++];
        }
      }
      if (attrName) attrs.push({ name: attrName.toLowerCase(), value, raw: attrName });
    }
    if (!closed) {
      tokens.push({ kind: "error", message: `unterminated <${name}> tag` });
      return tokens;
    }
    tokens.push({ kind: "start", name: name.toLowerCase(), attrs, selfClosing, raw: html.slice(tagStart, i) });
  }
  flushText();
  return tokens;
}

// ---------------------------------------------------------------------------
// Element / attribute policy
// ---------------------------------------------------------------------------
type AttributeVerdict =
  | { ok: true }
  | { ok: false; code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN" | "UNSAFE_EXTERNAL_URL_FORBIDDEN" | "UNSAFE_CSS_CONSTRUCT_FORBIDDEN"; detail: string };

const isInertNamespaced = (name: string): boolean => INERT_NAMESPACE_PREFIX.test(name);

function checkAttribute(tag: string, attr: { name: string; value: string }): AttributeVerdict {
  const name = attr.name;
  const decoded = decodeHtmlEntities(attr.value);
  if (/^on/.test(name)) return { ok: false, code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN", detail: `event handler ${name} on <${tag}>` };
  if (URL_ATTRS.has(name)) {
    if (tag === "img" && name === "src") {
      return isAllowedReference(decoded, false, true)
        ? { ok: true }
        : { ok: false, code: "UNSAFE_EXTERNAL_URL_FORBIDDEN", detail: `<img src="${decoded.slice(0, 60)}">` };
    }
    if (tag === "image" && (name === "href" || name === "xlink:href")) {
      return isAllowedReference(decoded, false, true)
        ? { ok: true }
        : { ok: false, code: "UNSAFE_EXTERNAL_URL_FORBIDDEN", detail: `<image ${name}="${decoded.slice(0, 60)}">` };
    }
    if (["use", "textpath", "lineargradient", "radialgradient", "pattern", "filter"].includes(tag) && name !== "src") {
      return isAllowedReference(decoded, true, false)
        ? { ok: true }
        : { ok: false, code: "UNSAFE_EXTERNAL_URL_FORBIDDEN", detail: `<${tag} ${name}="${decoded.slice(0, 60)}">` };
    }
    return { ok: false, code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN", detail: `${name} on <${tag}>` };
  }
  if (name === "style") {
    const findings = findUnsafeCss(decoded);
    return findings.length === 0
      ? { ok: true }
      : { ok: false, code: "UNSAFE_CSS_CONSTRUCT_FORBIDDEN", detail: `style attribute on <${tag}>: ${findings.map((f) => f.construct).join(", ")}` };
  }
  const allowed =
    GLOBAL_ATTRS.has(name) ||
    SVG_ATTRS.has(name) ||
    /^aria-[a-z-]+$/.test(name) ||
    /^data-[a-z0-9_.-]+$/.test(name) ||
    isInertNamespaced(name);
  if (!allowed) return { ok: false, code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN", detail: `${name} on <${tag}>` };
  // Any attribute value may reference url(...) (fill="url(#g)") or carry a
  // scheme; decoded values must stay inside the CSS/URL policy.
  const compact = compactForSchemeCheck(decoded);
  if (/(javascript|vbscript|livescript|data):/.test(compact) && !/^xmlns/.test(name)) {
    return { ok: false, code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN", detail: `script/data scheme in ${name} on <${tag}>` };
  }
  if (/url\s*\(/i.test(decoded)) {
    const findings = findUnsafeCss(`x:${decoded}`);
    if (findings.length > 0) {
      return { ok: false, code: "UNSAFE_EXTERNAL_URL_FORBIDDEN", detail: `${name} on <${tag}>: ${findings.map((f) => f.construct).join(", ")}` };
    }
  }
  return { ok: true };
}

function checkDeclaration(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.startsWith("<?xml")) return true;
  // A DOCTYPE without an internal subset is inert; an internal subset can
  // declare entities (billion laughs / external entities).
  if (/^<!doctype\s+[a-z]+[^[]*>$/i.test(value)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function validateSafeHtmlAndScopedCss(params: {
  html: string;
  scopedCss: string;
  basePath: string;
}): ReportDiagnostic[] {
  const diagnostics: ReportDiagnostic[] = [];
  const offenders = new Map<string, string[]>();
  const add = (code: string, detail: string) => {
    const list = offenders.get(code) ?? [];
    if (list.length < 8 && !list.includes(detail)) list.push(detail);
    offenders.set(code, list);
  };

  for (const token of tokenizeHtml(params.html)) {
    if (token.kind === "error") {
      add("MALFORMED_HTML_MARKUP", token.message);
    } else if (token.kind === "declaration") {
      if (!checkDeclaration(token.value)) add("UNSAFE_HTML_TAG_FORBIDDEN", token.value.slice(0, 40));
    } else if (token.kind === "start" || token.kind === "end") {
      if (!ALLOWED_TAGS.has(token.name) && !isInertNamespaced(token.name)) {
        add("UNSAFE_HTML_TAG_FORBIDDEN", `<${token.name}>`);
        continue;
      }
      if (token.kind === "start") {
        for (const attr of token.attrs) {
          const verdict = checkAttribute(token.name, attr);
          if (!verdict.ok) add(verdict.code, verdict.detail);
        }
      }
    }
  }

  const htmlMessages: Record<string, { message: string; aiFixHint: string }> = {
    UNSAFE_HTML_TAG_FORBIDDEN: {
      message: "HTML/SVG contains tags outside the report allow-list (script, style, iframe, object, form, foreignObject, animate, link, ... are forbidden)",
      aiFixHint:
        "Use only semantic layout/typography tags (<div>, <span>, <p>, <table>, <section>, <img>) and static SVG shapes; reference images as asset://key.",
    },
    UNSAFE_HTML_ATTRIBUTE_FORBIDDEN: {
      message: "HTML/SVG contains forbidden attributes (on* event handlers, srcset, script/data URI schemes or attributes outside the allow-list)",
      aiFixHint: "Remove event handlers, srcset and javascript:/data: values; use class/style/layout attributes only.",
    },
    UNSAFE_EXTERNAL_URL_FORBIDDEN: {
      message: "HTML/SVG references a URL other than asset://key (images) or #fragment (SVG internals)",
      aiFixHint: "Replace external, protocol-relative and data: URLs with asset://asset_key references declared in required_assets.",
    },
    UNSAFE_CSS_CONSTRUCT_FORBIDDEN: {
      message: "An inline style attribute contains a forbidden CSS construct",
      aiFixHint: "Inline styles may not use url() other than asset:///#, @import, image-set(), expression() or CSS escapes that decode to them.",
    },
    MALFORMED_HTML_MARKUP: {
      message: "HTML/SVG markup could not be parsed safely",
      aiFixHint: "Close every tag and attribute quote; do not use bogus end tags or unterminated comments.",
    },
  };
  for (const [code, list] of offenders) {
    const text = htmlMessages[code]!;
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.html`,
      code,
      message: `${text.message}: ${list.join("; ")}.`,
      aiFixHint: text.aiFixHint,
    });
  }

  const cssFindings = findUnsafeCss(params.scopedCss);
  if (cssFindings.length > 0) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.scoped_css`,
      code: "UNSAFE_CSS_CONSTRUCT_FORBIDDEN",
      message: `Scoped CSS contains forbidden constructs: ${[...new Set(cssFindings.map((f) => f.construct))].slice(0, 8).join(", ")}.`,
      aiFixHint:
        "Remove '<', @import, image-set(), expression() and url() references other than asset://key or #fragment; CSS escapes are decoded before checking.",
    });
  }

  return diagnostics;
}

const escapeText = (value: string): string => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Defense-in-depth client sanitizer: re-serialises markup through the same
 * allow-list, dropping disallowed tags (and the content of raw-text tags such
 * as <script>/<style>) and disallowed attributes.
 */
export function sanitizeHtmlForClient(html: string): string {
  const out: string[] = [];
  let skipDepth = 0;
  let skipTag: string | null = null;
  for (const token of tokenizeHtml(html)) {
    if (token.kind === "error") break;
    if (skipTag) {
      if (token.kind === "start" && token.name === skipTag && !token.selfClosing) skipDepth += 1;
      if (token.kind === "end" && token.name === skipTag) {
        skipDepth -= 1;
        if (skipDepth === 0) skipTag = null;
      }
      continue;
    }
    switch (token.kind) {
      case "text":
        out.push(escapeText(token.value));
        break;
      case "comment":
      case "declaration":
        break;
      case "start": {
        if (!ALLOWED_TAGS.has(token.name)) {
          if (RAW_CONTENT_TAGS.has(token.name) && !token.selfClosing) {
            skipTag = token.name;
            skipDepth = 1;
          }
          break;
        }
        const attrs = token.attrs
          .filter((attr) => checkAttribute(token.name, attr).ok)
          .map((attr) => ` ${attr.raw}="${escapeAttr(decodeHtmlEntities(attr.value))}"`)
          .join("");
        out.push(`<${token.name}${attrs}${token.selfClosing && !VOID_TAGS.has(token.name) ? "/" : ""}>`);
        break;
      }
      case "end":
        if (ALLOWED_TAGS.has(token.name) && !VOID_TAGS.has(token.name)) out.push(`</${token.name}>`);
        break;
    }
  }
  return out.join("");
}
