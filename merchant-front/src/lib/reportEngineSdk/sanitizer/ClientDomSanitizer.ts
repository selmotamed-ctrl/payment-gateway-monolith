/** Defense-in-depth sanitizer for the isolated print iframe. */
export function sanitizeReportHtml(html: string): string {
  if (typeof DOMParser === "undefined") {
    return html
      .replace(/<\s*(script|style|iframe|object|embed|applet|form|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      .replace(/<\s*(script|style|iframe|object|embed|applet|form|link|meta|base)\b[^>]*\/?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(?:javascript|vbscript)\s*:/gi, "");
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
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
        el.removeAttribute(attr.name);
      }
    }
  }
  return root.innerHTML;
}
