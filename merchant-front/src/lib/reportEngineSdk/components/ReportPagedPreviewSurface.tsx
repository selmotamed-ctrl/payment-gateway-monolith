import { defineComponent, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import pagedPolyfill from "../print/paged.polyfill.min.js?raw";
import {
  buildPagedMediaHtmlDocument,
  type ReportExecutionBundle,
} from "../print/ClientVectorPdfExporter";

/**
 * Paged.js runs inside an opaque-origin sandboxed iframe (no allow-same-origin):
 * the report can never touch the portal origin, its styles cannot leak into the
 * app, and communication only happens through postMessage. A strict nonce CSP
 * allows the inlined Paged.js polyfill and the report's own inline styles, and
 * nothing else.
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
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const totalPages = ref<number>(1);
    const rendering = ref<boolean>(false);
    let renderToken = 0;

    const nonceFor = (token: number): string => `report-${token}-${Math.random().toString(36).slice(2)}`;

    const buildSrcdoc = (token: number): string => {
      const base = buildPagedMediaHtmlDocument({
        bundle: props.bundle,
        locale: props.selectedLocale,
        renderedSectionsHtml: props.renderedSectionsHtml,
        renderedHeaderHtml: props.renderedHeaderHtml,
        renderedFooterHtml: props.renderedFooterHtml,
      });
      const nonce = nonceFor(token);
      const csp = [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data: asset:",
        "font-src data:",
        `script-src 'nonce-${nonce}'`,
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      const bridge = `
(function(){
  var token = ${JSON.stringify(String(token))};
  function send(pages){
    try { parent.postMessage({ type: "report:pageCount", token: token, pages: pages }, "*"); } catch (_) {}
  }
  function count(){
    var pages = document.querySelectorAll(".pagedjs_page").length;
    if (pages > 0) send(pages);
    return pages;
  }
  document.addEventListener("pagedjs:rendered", count);
  window.addEventListener("load", function(){
    setTimeout(count, 50);
    setTimeout(count, 400);
    setTimeout(count, 1200);
  });
  window.addEventListener("message", function(event){
    if (event && event.data && event.data.type === "report:print") {
      try { window.print(); } catch (_) {}
    }
  });
})();`;
      const head = `<meta http-equiv="Content-Security-Policy" content="${csp}" />` +
        `<script nonce="${nonce}">${pagedPolyfill}<\/script>` +
        `<script nonce="${nonce}">${bridge}<\/script>`;
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

    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.value;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: string; token?: string; pages?: number } | null;
      if (!data || data.type !== "report:pageCount") return;
      if (data.token !== String(renderToken)) return;
      const pages = Number(data.pages ?? 0);
      if (Number.isFinite(pages) && pages > 0 && pages !== totalPages.value) {
        totalPages.value = pages;
        emit("pageCountChanged", pages);
      }
    };

    const printClientSideVectorPdf = () => {
      iframeRef.value?.contentWindow?.postMessage({ type: "report:print" }, "*");
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
          sandbox="allow-scripts allow-modals"
          class="report-paged-preview-frame"
          style="width: 100%; min-height: min(860px, 74vh); border: 1px solid var(--pg-border-subtle); border-radius: 8px; background: var(--pg-bg-canvas);"
        />
      </div>
    );
  },
});

export default ReportPagedPreviewSurface;
