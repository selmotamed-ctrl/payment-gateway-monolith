import { defineComponent, computed, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VAlert } from "vuetify/components";
import type { ReportDiagnostic } from "@/lib/reportEngineSdk";
import { friendlyDiagnosticTitle } from "@/utils/reports/diagnostics";

export const ReportDiagnosticsPanel = defineComponent({
  name: "ReportDiagnosticsPanel",
  props: {
    diagnostics: { type: Array as PropType<ReportDiagnostic[]>, required: true },
    title: { type: String, default: "" },
  },
  setup(props) {
    const { t } = useLocale();
    const errors = computed(() => props.diagnostics.filter((item) => item.severity === "error"));
    const warnings = computed(() => props.diagnostics.filter((item) => item.severity === "warning"));

    return () => (
      <div class="d-flex flex-column ga-3">
        {props.title && <div class="text-subtitle-2 font-weight-bold">{props.title}</div>}
        <div class="text-caption text-medium-emphasis">
          {errors.value.length} {t("errors")} · {warnings.value.length} {t("warnings")}
        </div>
        {[...errors.value, ...warnings.value].map((diagnostic, index) => (
          <VAlert
            key={`${diagnostic.code}-${diagnostic.path}-${index}`}
            type={diagnostic.severity === "error" ? "error" : "warning"}
            variant="tonal"
            density="compact"
          >
            <div class="font-weight-bold">{t(friendlyDiagnosticTitle(diagnostic.code))}</div>
            <div class="text-body-2 mt-1">{diagnostic.message}</div>
            {diagnostic.aiFixHint && (
              <div class="text-caption mt-1">
                <strong>{t("How to fix")}:</strong> {diagnostic.aiFixHint}
              </div>
            )}
            <details class="mt-2">
              <summary class="text-caption" style={{ cursor: "pointer" }}>{t("Technical details")}</summary>
              <div class="text-caption mt-1" style={{ wordBreak: "break-word" }}>
                <div>{t("Layer")} {diagnostic.layer} · {diagnostic.code}</div>
                <div>{t("Path")}: {diagnostic.path}</div>
              </div>
            </details>
          </VAlert>
        ))}
      </div>
    );
  },
});

export default ReportDiagnosticsPanel;
