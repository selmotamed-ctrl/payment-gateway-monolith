import { defineComponent, type PropType, type VNodeChild } from "vue";
import { sanitizeReportCss } from "../sanitizer/ClientDomSanitizer";

/**
 * Isolated HTML/CSS surface for chrome previews. The markup is already
 * sanitized by the SDK, and the opaque-origin sandbox plus strict CSP means a
 * missing sanitizer rule still cannot reach the portal origin (D08).
 */
export const ReportSandboxedHtmlSurface = defineComponent({
  name: "ReportSandboxedHtmlSurface",
  props: {
    html: { type: String, required: true },
    css: { type: String, default: "" },
    locale: { type: String, default: "en" },
    minHeight: { type: Number, default: 220 },
  },
  setup(props): () => VNodeChild {
    const build = (): string => {
      const isRtl = /^(ar|he|fa|ur)(-|$)/i.test(props.locale);
      const csp = [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data: asset:",
        "font-src data:",
        "script-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      return `<!DOCTYPE html><html lang="${props.locale}" dir="${isRtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
        html,body{margin:0;padding:0;background:transparent}
        body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px;color:#0F172A;direction:${isRtl ? "rtl" : "ltr"}}
        .report-chrome{display:flex;flex-direction:column;position:relative;box-sizing:border-box;max-width:100%;min-width:0}
        .report-chrome > :first-child{flex:1 1 auto;min-height:0}
        ${sanitizeReportCss(props.css)}
      </style></head><body>${props.html}</body></html>`;
    };
    return () => (
      <iframe
        title="Report chrome preview"
        sandbox=""
        srcdoc={build()}
        class="report-sandboxed-surface"
        style={`width:100%;min-height:${props.minHeight}px;border:1px solid var(--pg-border-subtle);border-radius:8px;background:var(--pg-bg-surface);`}
      />
    );
  },
});

export default ReportSandboxedHtmlSurface;
