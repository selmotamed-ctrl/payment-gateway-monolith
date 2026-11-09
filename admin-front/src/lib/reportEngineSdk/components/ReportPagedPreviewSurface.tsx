import { defineComponent, onMounted, ref, watch, type PropType } from "vue";
import { VBtn } from "vuetify/components";
import { Previewer } from "pagedjs";
import {
  buildPagedMediaHtmlDocument,
  type ReportExecutionBundle,
} from "../print/ClientVectorPdfExporter";

export const ReportPagedPreviewSurface = defineComponent({
  name: "ReportPagedPreviewSurface",
  props: {
    bundle: { type: Object as PropType<ReportExecutionBundle>, required: true },
    selectedLocale: { type: String, required: true },
    renderedSectionsHtml: { type: String, required: true },
    renderedHeaderHtml: { type: String, default: "" },
    renderedFooterHtml: { type: String, default: "" },
  },
  emits: ["pageCountChanged", "changeLocale"],
  setup(props, { emit, expose }) {
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const totalPages = ref<number>(1);
    const rendering = ref<boolean>(false);

    const renderPaginatedPreview = async () => {
      const iframe = iframeRef.value;
      if (!iframe || !iframe.contentDocument) return;
      rendering.value = true;
      try {
        const fullHtml = buildPagedMediaHtmlDocument({
          bundle: props.bundle,
          locale: props.selectedLocale,
          renderedSectionsHtml: props.renderedSectionsHtml,
          renderedHeaderHtml: props.renderedHeaderHtml,
          renderedFooterHtml: props.renderedFooterHtml,
        });

        const doc = iframe.contentDocument;
        doc.open();
        doc.write(fullHtml);
        doc.close();

        const paged = new Previewer();
        const flow = await paged.preview(doc.body.innerHTML, [], doc.body);
        totalPages.value =
          (flow as { total?: number } | undefined)?.total ??
          doc.querySelectorAll(".pagedjs_page").length ??
          1;
        emit("pageCountChanged", totalPages.value);
      } finally {
        rendering.value = false;
      }
    };

    const printClientSideVectorPdf = () => {
      const win = iframeRef.value?.contentWindow;
      if (!win) return;
      win.focus();
      win.print();
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
      void renderPaginatedPreview();
    });

    expose({ printClientSideVectorPdf, renderPaginatedPreview });

    return () => (
      <div class="report-paged-preview-wrapper d-flex flex-column ga-3">
        <div class="d-flex align-center justify-space-between px-4 py-2 bg-grey-lighten-4 rounded border">
          <div class="d-flex align-center ga-3">
            <span class="text-subtitle-2 font-weight-bold">
              Pages: {totalPages.value} ({props.bundle.spec.page_layout.paper_size}{" "}
              {props.bundle.spec.page_layout.orientation})
            </span>
            <span class="text-caption text-medium-emphasis">
              SHA-256: {props.bundle.verificationSha256.slice(0, 12)}…
            </span>
          </div>
          <div class="d-flex align-center ga-2">
            {Object.keys(props.bundle.spec.i18n.locales).map((loc) => (
              <VBtn
                key={loc}
                size="small"
                variant={props.selectedLocale === loc ? "flat" : "outlined"}
                color={props.selectedLocale === loc ? "primary" : undefined}
                onClick={() => emit("changeLocale", loc)}
              >
                {loc.toUpperCase()}
              </VBtn>
            ))}
            <VBtn
              color="primary"
              prependIcon="mdi-file-pdf-box"
              loading={rendering.value}
              onClick={printClientSideVectorPdf}
            >
              Export Vector PDF (Client-Side)
            </VBtn>
          </div>
        </div>
        <iframe
          ref={iframeRef}
          title="Report Paginated Vector Preview"
          sandbox="allow-same-origin allow-modals"
          style="width: 100%; min-height: 820px; border: 1px solid #CBD5E1; border-radius: 8px; background: #475569;"
        />
      </div>
    );
  },
});

export default ReportPagedPreviewSurface;
