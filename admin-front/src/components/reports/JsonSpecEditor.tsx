import { defineComponent } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import { PgButton, PgCodeEditor } from "@pg/ui";
import { downloadText } from "@/utils/reports/jsonSpec";
import "./reports.css";

/**
 * Code editor for AI-authored report/chrome spec JSON.
 *
 * The editor chrome (toolbar, validation status, line gutter, Format/Copy) now
 * lives in `PgCodeEditor`; this wrapper only adds the two page-specific actions
 * (Download and Clear) through the shared toolbar slot.
 */
export const JsonSpecEditor = defineComponent({
  name: "JsonSpecEditor",
  props: {
    modelValue: { type: String, required: true },
    label: { type: String, default: "" },
    /** File name used by the Download action. */
    downloadName: { type: String, default: "spec.json" },
    /** Retained for API compatibility; the shared editor owns the Copy action. */
    copiedMessage: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:modelValue", "clear"],
  setup(props, { emit }) {
    const { t } = useLocale();
    const update = (value: string) => emit("update:modelValue", value);
    const hasText = () => props.modelValue.trim().length > 0;

    const download = () => {
      if (!hasText()) return;
      downloadText(props.downloadName, props.modelValue, "application/json");
    };

    return () => (
      <PgCodeEditor
        modelValue={props.modelValue}
        label={props.label || t("Spec JSON")}
        disabled={props.disabled}
        minHeight="260px"
        onUpdate:modelValue={update}
      >
        {{
          toolbar: () => (
            <>
              <PgButton
                size="small"
                variant="text"
                prependIcon="mdi-download"
                disabled={!hasText()}
                onClick={download}
              >
                {t("Download JSON")}
              </PgButton>
              <PgButton
                size="small"
                variant="text"
                prependIcon="mdi-eraser"
                disabled={props.disabled}
                onClick={() => emit("clear")}
              >
                {t("Clear editor")}
              </PgButton>
            </>
          ),
        }}
      </PgCodeEditor>
    );
  },
});
