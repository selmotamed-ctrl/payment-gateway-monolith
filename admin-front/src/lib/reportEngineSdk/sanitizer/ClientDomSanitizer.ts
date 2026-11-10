/**
 * Allow-list sanitizer for report HTML/SVG and scoped CSS.
 *
 * Defense in depth only: the report is rendered inside a sandboxed iframe with a strict CSP, so even
 * markup that slipped through could not reach the portal origin. The sanitizer is a deterministic string tokenizer
 * (same output in the browser and in unit tests): every tag is re-serialised from its parsed parts, unknown tags are
 * dropped, active containers are dropped with their content, attributes are allow-listed, URL attributes are
 * entity-decoded before the scheme check and only `#fragment`, `asset://` and `data:image/*` URLs survive.
 */

const ALLOWED_TAGS = new Set(
  [
    // HTML
    "a", "abbr", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col",
    "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3",
    "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q",
    "s", "samp", "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
    "time", "tr", "u", "ul", "var", "wbr",
    // SVG
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textpath",
    "defs", "marker", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use",
    "title", "desc", "image",
  ],
);

/** Tags whose whole content is removed together with the tag. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "noscript", "template", "textarea", "xmp", "noembed",
  "noframes", "foreignobject", "math", "select", "frameset", "plaintext", "head",
]);

const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);

const ALLOWED_ATTRS = new Set([
  "class", "id", "title", "dir", "lang", "style", "role", "align", "valign", "width", "height", "colspan", "rowspan",
  "scope", "headers", "span", "alt", "datetime", "start", "reversed", "border", "cellpadding", "cellspacing",
  "src", "href", "xlink:href",
  "viewbox", "xmlns", "xmlns:xlink", "version", "preserveaspectratio", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy",
  "r", "rx", "ry", "fx", "fy", "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke",
  "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-opacity",
  "stroke-miterlimit", "opacity", "font-size", "font-family", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "dx", "dy",
  "rotate", "textlength", "lengthadjust", "offset", "stop-color", "stop-opacity", "gradientunits",
  "gradienttransform", "spreadmethod", "patternunits", "patterncontentunits", "patterntransform", "markerwidth",
  "markerheight", "markerunits", "refx", "refy", "orient", "marker-start", "marker-mid", "marker-end",
  "clip-path", "clip-rule", "clippathunits", "mask", "maskunits", "visibility", "display", "vector-effect",
  "shape-rendering", "text-rendering", "paint-order", "overflow", "pathlength", "writing-mode", "direction",
  "unicode-bidi", "color", "xml:space", "startoffset",
]);

const URL_ATTRS = new Set(["src", "href", "xlink:href"]);
/** Presentation attributes that accept `url(...)` paint references. */
const PAINT_ATTRS = new Set(["fill", "stroke", "clip-path", "mask", "marker-start", "marker-mid", "marker-end"]);

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", sol: "/", lpar: "(",
  rpar: ")", nbsp: " ", period: ".", comma: ",", semi: ";", equals: "=", num: "#", excl: "!",
};

/** Decodes HTML character references so `jav&#x61;script:` and `&colon;` cannot hide a scheme. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Decodes CSS escapes (`\75 rl(` -> `url(`) so blocked constructs cannot be spelled with escapes. */
export function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/\\(.)/g, "$1")
    .replace(/\\\n/g, "");
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const normalizeUrl = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  decodeHtmlEntities(value).replace(/[\u0000- \u007f-\u009f]+/g, "").trim();

const isSafeUrl = (raw: string, allowImageData: boolean): boolean => {
  const url = normalizeUrl(raw);
  if (url === "") return false;
  if (url.startsWith("#")) return true;
  if (/^asset:\/\/[a-zA-Z0-9_-]+$/.test(url)) return true;
  return allowImageData && SAFE_IMAGE_DATA_URL.test(url);
};

const isSafeCssUrl = (raw: string): boolean => {
  const url = raw.trim();
  if (url.startsWith("#")) return true;
  return /^data:(?:image\/(?:png|jpe?g|gif|webp|svg\+xml)|font\/[a-z0-9.+-]+|application\/font-[a-z0-9.+-]+)[;,]/i.test(url);
};

const FORBIDDEN_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import|@namespace|image-set\s*\(|<|\\/i;

/** True when an inline `style` attribute value is free of URLs (other than `#`/data images) and active constructs. */
function isSafeInlineStyle(raw: string): boolean {
  const css = decodeCssEscapes(decodeHtmlEntities(raw));
  if (FORBIDDEN_CSS.test(css)) return false;
  const urls = css.match(/url\s*\(([^)]*)\)/gi) ?? [];
  return urls.every((entry) => {
    const inner = entry.replace(/^url\s*\(/i, "").replace(/\)$/, "").trim().replace(/^['"]|['"]$/g, "");
    return isSafeCssUrl(inner);
  });
}

const isSafePaintValue = (raw: string): boolean => {
  const value = decodeHtmlEntities(raw);
  if (!/url\s*\(/i.test(value)) return !/javascript\s*:|expression\s*\(/i.test(value);
  return /^\s*url\(\s*['"]?#[a-zA-Z0-9_.:-]+['"]?\s*\)\s*(?:[a-z#0-9(),. -]*)$/i.test(value);
};

const sanitizeAttribute = (tag: string, name: string, value: string | undefined): string | null => {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return null;
  const allowed = ALLOWED_ATTRS.has(lower) || lower.startsWith("aria-") || /^data-[a-z0-9_-]+$/.test(lower);
  if (!allowed) return null;
  const text = value ?? "";
  if (URL_ATTRS.has(lower)) {
    if (lower === "src" && tag !== "img") return null;
    const allowImage = tag === "img" || tag === "image";
    if (!isSafeUrl(text, allowImage)) return null;
    // Only fragment links on anchors and <use>.
    if ((tag === "a" || tag === "use") && !normalizeUrl(text).startsWith("#")) return null;
  }
  if (lower === "style" && !isSafeInlineStyle(text)) return null;
  if (PAINT_ATTRS.has(lower) && !isSafePaintValue(text)) return null;
  if (/javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i.test(normalizeUrl(text)) && !URL_ATTRS.has(lower)) return null;
  return value === undefined ? name : `${name}="${escapeAttr(decodeHtmlEntities(text))}"`;
};

const TAG_PATTERN =
  /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Sanitizes report HTML/SVG markup (allow-list, re-serialised). */
export function sanitizeReportHtml(html: string): string {
  const source = String(html ?? "");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt === -1) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, lt);
    index = lt;

    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", index) || source.startsWith("<?", index)) {
      const end = source.indexOf(">", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    TAG_PATTERN.lastIndex = index;
    const match = TAG_PATTERN.exec(source);
    if (!match) {
      out += "&lt;";
      index += 1;
      continue;
    }
    index = TAG_PATTERN.lastIndex;
    const closing = match[1] === "/";
    const rawName = match[2] ?? "";
    const tag = rawName.toLowerCase();
    const selfClosing = match[4] === "/";

    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !selfClosing) {
        const closer = new RegExp(`<\\/\\s*${tag}\\s*>`, "ig");
        closer.lastIndex = index;
        const found = closer.exec(source);
        index = found ? closer.lastIndex : source.length;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (closing) {
      if (!VOID_TAGS.has(tag)) out += `</${rawName}>`;
      continue;
    }
    const attrs: string[] = [];
    const attrSource = match[3] ?? "";
    ATTR_PATTERN.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_PATTERN.exec(attrSource))) {
      const name = attrMatch[1] ?? "";
      if (!name) continue;
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
      const safe = sanitizeAttribute(tag, name, value);
      if (safe) attrs.push(safe);
    }
    out += `<${rawName}${attrs.length ? ` ${attrs.join(" ")}` : ""}${selfClosing && !VOID_TAGS.has(tag) ? " />" : ">"}`;
  }
  return out;
}

/**
 * Sanitizes scoped CSS before it is placed in a `<style>` element: escapes decoded, `<` removed (no `</style>`
 * breakout), `@import`/`@namespace` dropped, `url()` limited to data images/fonts and `#` fragments, legacy active
 * constructs neutralised.
 */
export function sanitizeReportCss(css: string): string {
  const SENTINEL = "\u0000SAFEURL(";
  // eslint-disable-next-line no-control-regex
  let out = decodeCssEscapes(String(css ?? "").replace(/\u0000/g, ""));
  out = out.replace(/</g, "");
  out = out.replace(/@import[^;]*;?/gi, "").replace(/@namespace[^;]*;?/gi, "");
  out = out.replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q: string, url: string) =>
    isSafeCssUrl(url) ? `${SENTINEL}"${url.trim()}")` : "none",
  );
  // Anything still spelled url( was malformed: neutralise it.
  out = out.replace(/url\s*\(/gi, "none(");
  out = out.split(SENTINEL).join("url(");
  out = out.replace(/(?:-webkit-)?image-set\s*\(/gi, "none(");
  out = out
    .replace(/expression\s*\(/gi, "(")
    .replace(/javascript\s*:/gi, "")
    .replace(/vbscript\s*:/gi, "")
    .replace(/behavior\s*:/gi, "x-behavior:")
    .replace(/-moz-binding/gi, "x-binding");
  return out;
}
