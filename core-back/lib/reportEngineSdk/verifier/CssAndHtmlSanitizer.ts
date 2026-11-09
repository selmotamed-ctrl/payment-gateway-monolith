import type { ReportDiagnostic } from "../types/diagnostics";

const FORBIDDEN_HTML_TAGS =
  /<\s*\/?\s*(script|style|iframe|object|embed|applet|meta|link|base|form|input|button|textarea|select|frame|frameset)\b/i;
const FORBIDDEN_HTML_ATTRS =
  /\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i;
const FORBIDDEN_CSS_PATTERNS =
  /@import\b|expression\s*\(|javascript\s*:|behavior\s*:|url\s*\(\s*['"]?\s*(?:https?:|ftp:|\/\/|data:text)/i;

export function validateSafeHtmlAndScopedCss(params: {
  html: string;
  scopedCss: string;
  basePath: string;
}): ReportDiagnostic[] {
  const diagnostics: ReportDiagnostic[] = [];

  if (FORBIDDEN_HTML_TAGS.test(params.html)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.html`,
      code: "UNSAFE_HTML_TAG_FORBIDDEN",
      message:
        "HTML template contains forbidden executable or active tags (<script>, <iframe>, <object>, <form>, <link>, etc.).",
      aiFixHint:
        "Use only semantic layout and typography HTML tags (<div>, <span>, <p>, <table>, <section>, <svg>, <img>) and asset:// image URLs.",
    });
  }

  if (/\b(?:src|href|xlink:href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(params.html)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.html`,
      code: "UNSAFE_EXTERNAL_URL_FORBIDDEN",
      message: "HTML/SVG contains an external network URL. Use asset:// references or self-contained markup.",
      aiFixHint: "Remove external http(s):// and protocol-relative URLs from the markup.",
    });
  }
  if (FORBIDDEN_HTML_ATTRS.test(params.html)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.html`,
      code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN",
      message:
        "HTML template contains inline event handlers (on*) or executable URI schemes (javascript:/data:text/html).",
      aiFixHint: "Remove all on* event attributes and javascript: URIs from the HTML/SVG markup.",
    });
  }

  if (FORBIDDEN_CSS_PATTERNS.test(params.scopedCss)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.scoped_css`,
      code: "UNSAFE_CSS_CONSTRUCT_FORBIDDEN",
      message:
        "Scoped CSS contains forbidden external @import or external network url() references.",
      aiFixHint:
        "Remove @import and external http(s):// url() references; use self-contained CSS rules and asset:// references only.",
    });
  }

  return diagnostics;
}

/** Defense-in-depth client sanitizer: strips active content before it reaches the preview iframe. */
export function sanitizeHtmlForClient(html: string): string {
  const Parser = (globalThis as { DOMParser?: new () => { parseFromString: (value: string, type: string) => any } }).DOMParser;
  if (!Parser) {
    return html
      .replace(/<\s*(script|style|iframe|object|embed|applet|form|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      .replace(/<\s*(script|style|iframe|object|embed|applet|form|link|meta|base)\b[^>]*\/?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(?:javascript|vbscript)\s*:/gi, "");
  }
  const doc = new Parser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  for (const el of [...root.querySelectorAll("script,style,iframe,object,embed,applet,form,link,meta,base")]) {
    el.remove();
  }
  for (const el of [...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || /^(javascript|vbscript):/i.test(value) || /^data:text\/html/i.test(value)) {
        el.removeAttribute(attr.name);
      }
      if ((name === "href" || name === "src" || name === "xlink:href") && /^(https?:|\/\/)/i.test(value) && !value.startsWith("asset://")) {
        // External network references are not allowed in the print surface.
        el.removeAttribute(attr.name);
      }
    }
  }
  return root.innerHTML;
}
