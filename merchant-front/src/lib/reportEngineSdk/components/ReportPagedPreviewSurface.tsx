import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { useTheme } from "vuetify";
import {
  buildPagedMediaHtmlDocument,
  type ReportExecutionBundle,
} from "../print/ClientVectorPdfExporter";

/**
 * Paged.js runs inside a sandboxed same-origin iframe. The strict meta CSP
 * allows only same-origin scripts and the report's inline styles; the report
 * cannot execute inline scripts or reach the portal DOM. Keeping the iframe
 * same-origin lets the parent print the paginated document directly and lets
 * the portal CSP (`script-src 'self'`) load the external Paged.js polyfill.
 */
export const ReportPagedPreviewSurface = defineComponent({
  name: "ReportPagedPreviewSurface",
  props: {
    bundle: { type: Object as PropType<ReportExecutionBundle>, required: true },
    selectedLocale: { type: String, required: true },
    renderedSectionsHtml: { type: String, required: true },
    renderedHeaderHtml: { type: String, default: "" },
    renderedFooterHtml: { type: String, default: "" },
  },
  emits: ["pageCountChanged"],
  setup(props, { emit, expose }) {
    const theme = useTheme();
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const totalPages = ref<number>(1);
    const rendering = ref<boolean>(false);
    const previewTheme = computed<"light" | "dark">(() => (theme.global.current.value.dark ? "dark" : "light"));
    let renderToken = 0;

    const buildSrcdoc = (token: number): string => {
      const base = buildPagedMediaHtmlDocument({
        bundle: props.bundle,
        locale: props.selectedLocale,
        renderedSectionsHtml: props.renderedSectionsHtml,
        renderedHeaderHtml: props.renderedHeaderHtml,
        renderedFooterHtml: props.renderedFooterHtml,
        previewTheme: previewTheme.value,
      });
      const csp = [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data: asset:",
        "font-src 'self' data:",
        "script-src 'self'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      // External same-origin scripts are allowed by the portal CSP
      // (`script-src 'self'`) and by the meta policy above; no inline script
      // needs a nonce or a matching header hash.
      const head = `<meta http-equiv="Content-Security-Policy" content="${csp}" />` +
        `<script src="/report-engine/paged.polyfill.min.js"></script>` +
        `<script src="/report-engine/paged-preview-bridge.js" data-report-token="${token}"></script>`;
      return base.replace("</head>", `${head}</head>`);
    };

    const renderPaginatedPreview = async () => {
      const iframe = iframeRef.value;
      if (!iframe) return;
      const token = ++renderToken;
      rendering.value = true;
      try {
        iframe.srcdoc = buildSrcdoc(token);
      } finally {
        rendering.value = false;
      }
    };

    const applyPreviewTheme = () => {
      const doc = iframeRef.value?.contentDocument;
      if (doc) doc.documentElement.dataset.reportPreviewTheme = previewTheme.value;
    };

    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.value;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: string; token?: string; pages?: number } | null;
      if (!data) return;
      if (data.token !== String(renderToken)) return;
      if (data.type !== "report:pageCount") return;
      const pages = Number(data.pages ?? 0);
      if (Number.isFinite(pages) && pages > 0 && pages !== totalPages.value) {
        totalPages.value = pages;
        emit("pageCountChanged", pages);
      }
    };

    const printClientSideVectorPdf = () => {
      const iframe = iframeRef.value;
      const win = iframe?.contentWindow;
      if (!iframe || !win) return;
      // Print a copy of the already-paginated report document in a fresh
      // same-origin window. Printing the preview iframe directly is unreliable
      // in Chrome (it can print the portal shell or a blank page).
      const doc = iframe.contentDocument;
      if (doc) {
        const html = doc.documentElement.outerHTML.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
        const printWindow = window.open("", "_blank");
        if (printWindow) {
          try {
            printWindow.document.open();
            printWindow.document.write(`<!DOCTYPE html>${html}`);
            printWindow.document.close();
            const printCopy = () => {
              try {
                printWindow.focus();
                printWindow.print();
              } catch {
                // The bridge below remains the fallback.
              }
            };
            printWindow.onafterprint = () => printWindow.close();
            if (printWindow.document.fonts?.ready) {
              printWindow.document.fonts.ready.then(printCopy).catch(printCopy);
            } else {
              setTimeout(printCopy, 300);
            }
            return;
          } catch {
            printWindow.close();
          }
        }
      }
      // Fallback: ask the bridge to call window.print() inside the iframe.
      win.postMessage({ type: "report:print" }, "*");
    };

    watch(
      () => [
        props.bundle.executionId,
        props.selectedLocale,
        props.renderedSectionsHtml,
        props.renderedHeaderHtml,
        props.renderedFooterHtml,
      ],
      () => {
        void renderPaginatedPreview();
      },
    );

    watch(previewTheme, applyPreviewTheme);

    onMounted(() => {
      window.addEventListener("message", onMessage);
      void renderPaginatedPreview();
    });
    onBeforeUnmount(() => {
      window.removeEventListener("message", onMessage);
      renderToken += 1;
    });

    expose({ printClientSideVectorPdf, renderPaginatedPreview, pageCount: totalPages });

    return () => (
      <div class="report-paged-preview-wrapper d-flex flex-column">
        <iframe
          ref={iframeRef}
          title="Report Paginated Vector Preview"
          sandbox="allow-same-origin allow-scripts allow-modals"
          class="report-paged-preview-frame"
          style="width: 100%; min-height: min(860px, 74vh); border: 1px solid var(--pg-border-subtle); border-radius: 8px; background: var(--pg-bg-surface-subtle);"
          onLoad={applyPreviewTheme}
        />
      </div>
    );
  },
});

export default ReportPagedPreviewSurface;
