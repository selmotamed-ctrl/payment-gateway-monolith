import { defineComponent, computed, type PropType } from "vue";
import { useLocale } from "vuetify";
import type { ReportDiagnostic } from "@/lib/reportEngineSdk";
import { MetaPill, MonoRef, StatusBadge, SurfaceCard } from "@/components/ui";
import { friendlyDiagnosticTitle } from "@/utils/reports/diagnostics";
import "./reports.css";

/**
 * One card for verification/action diagnostics: errors first, then warnings, one compact row each
 * (severity badge, friendly title, server message, code + path, layer, collapsible fix hint).
 */
export const ReportDiagnosticsPanel = defineComponent({
  name: "ReportDiagnosticsPanel",
  props: {
    diagnostics: { type: Array as PropType<ReportDiagnostic[]>, required: true },
    title: { type: String, default: "" },
    /** Render without the card frame (when embedded inside another SurfaceCard). */
    embedded: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const { t } = useLocale();
    const errors = computed(() => props.diagnostics.filter((item) => item.severity === "error"));
    const warnings = computed(() => props.diagnostics.filter((item) => item.severity === "warning"));
    const heading = computed(() =>
      [
        props.title,
        `${errors.value.length} ${t("errors")} · ${warnings.value.length} ${t("warnings")}`,
      ]
        .filter(Boolean)
        .join(" — "),
    );

    const rows = () => (
      <div class="pg-report-diagnostics" role="list" aria-label={heading.value}>
        {[...errors.value, ...warnings.value].map((diagnostic, index) => {
          const title = friendlyDiagnosticTitle(diagnostic.code, t);
          return (
            <div key={`${diagnostic.code}-${diagnostic.path}-${index}`} class="pg-report-diagnostics__row" role="listitem">
              <div class="pg-report-diagnostics__head">
                <StatusBadge
                  status={diagnostic.severity === "error" ? "ERROR" : "WARNING"}
                  label={diagnostic.severity === "error" ? t("Error") : t("Warning")}
                  toneOverride={diagnostic.severity === "error" ? "danger" : "warning"}
                />
                <span class="pg-report-diagnostics__title">{title}</span>
              </div>
              {diagnostic.message && diagnostic.message !== title && (
                <div class="pg-report-diagnostics__message">{diagnostic.message}</div>
              )}
              <div class="pg-report-diagnostics__meta">
                <MetaPill size="x-small">{`${t("Layer")} ${diagnostic.layer}`}</MetaPill>
                <MonoRef value={diagnostic.code} />
                {diagnostic.path && diagnostic.path !== "<root>" && (
                  <>
                    <span>{t("Path")}:</span>
                    <MonoRef value={diagnostic.path} truncate={64} />
                  </>
                )}
              </div>
              {diagnostic.aiFixHint && (
                <details class="pg-report-diagnostics__hint">
                  <summary>{t("How to fix")}</summary>
                  <p>{diagnostic.aiFixHint}</p>
                </details>
              )}
            </div>
          );
        })}
      </div>
    );

    return () => {
      if (props.diagnostics.length === 0) return null;
      if (props.embedded) return rows();
      return (
        <SurfaceCard
          title={heading.value}
          noPadding
          v-slots={slots.headerActions ? { headerActions: slots.headerActions } : undefined}
        >
          {rows()}
        </SurfaceCard>
      );
    };
  },
});

export default ReportDiagnosticsPanel;
