import { computed, defineComponent, ref, useId } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { showSnackBar } from "@/utils/snackBar";
import { countLines, downloadText, findJsonParseIssue } from "@/utils/reports/jsonSpec";
import "./reports.css";

/**
 * Code editor for AI-authored report/chrome spec JSON. This is the one sanctioned JSON textarea in the portal
 * (see project-design/parts/03-admin-front/00-ui-system.md): the spec IS the artefact an author pastes from the
 * AI transcript, so it is edited as text with a line gutter and a located parse error.
 */
export const JsonSpecEditor = defineComponent({
  name: "JsonSpecEditor",
  props: {
    modelValue: { type: String, required: true },
    label: { type: String, default: "" },
    /** File name used by the Download action. */
    downloadName: { type: String, default: "spec.json" },
    /** Snackbar text after Copy. */
    copiedMessage: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:modelValue", "clear"],
  setup(props, { emit }) {
    const { t } = useLocale();
    const inputId = useId();
    const errorId = `${inputId}-error`;
    const gutter = ref<HTMLElement | null>(null);

    const hasText = computed(() => props.modelValue.trim().length > 0);
    const issue = computed(() => findJsonParseIssue(props.modelValue));
    const lineCount = computed(() => countLines(props.modelValue));

    const syncScroll = (event: Event) => {
      const target = event.target as HTMLTextAreaElement;
      if (gutter.value) gutter.value.scrollTop = target.scrollTop;
    };

    const update = (value: string) => emit("update:modelValue", value);

    const format = () => {
      if (!hasText.value || issue.value) return;
      update(JSON.stringify(JSON.parse(props.modelValue), null, 2));
    };

    const copy = async () => {
      if (!hasText.value) return;
      try {
        await navigator.clipboard.writeText(props.modelValue);
        showSnackBar({ message: props.copiedMessage || t("Copied"), type: "success" });
      } catch {
        showSnackBar({ message: t("Could not copy to the clipboard"), type: "error" });
      }
    };

    const download = () => {
      if (!hasText.value) return;
      downloadText(props.downloadName, props.modelValue, "application/json");
    };

    const onKeydown = (event: KeyboardEvent) => {
      // Tab inserts two spaces instead of leaving the editor (Shift+Tab still moves focus).
      if (event.key !== "Tab" || event.shiftKey) return;
      event.preventDefault();
      const target = event.target as HTMLTextAreaElement;
      const { selectionStart, selectionEnd, value } = target;
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      update(next);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = selectionStart + 2;
      });
    };

    return () => {
      const current = issue.value;
      return (
        <div class="pg-json-editor">
          <div class="pg-json-editor__toolbar">
            <label class="pg-json-editor__label" for={inputId}>{props.label || t("Spec JSON")}</label>
            <div class="pg-json-editor__actions">
              <VBtn size="small" variant="text" prependIcon="mdi-format-align-left" disabled={!hasText.value || Boolean(current) || props.disabled} onClick={format}>
                {t("Format JSON")}
              </VBtn>
              <VBtn size="small" variant="text" prependIcon="mdi-content-copy" disabled={!hasText.value} onClick={() => void copy()}>
                {t("Copy JSON")}
              </VBtn>
              <VBtn size="small" variant="text" prependIcon="mdi-download" disabled={!hasText.value} onClick={download}>
                {t("Download JSON")}
              </VBtn>
              <VBtn size="small" variant="text" prependIcon="mdi-eraser" disabled={props.disabled} onClick={() => emit("clear")}>
                {t("Clear editor")}
              </VBtn>
            </div>
          </div>
          <div class={["pg-json-editor__frame", current ? "pg-json-editor__frame--invalid" : ""]}>
            <div ref={gutter} class="pg-json-editor__gutter pg-mono" aria-hidden="true">
              {Array.from({ length: lineCount.value }, (_, index) => (
                <div
                  key={index}
                  class={["pg-json-editor__gutter-line", current?.line === index + 1 ? "pg-json-editor__gutter-line--error" : ""]}
                >
                  {index + 1}
                </div>
              ))}
            </div>
            <textarea
              id={inputId}
              class="pg-json-editor__input pg-mono"
              dir="ltr"
              spellcheck={false}
              autocomplete="off"
              autocapitalize="off"
              wrap="off"
              disabled={props.disabled}
              aria-invalid={current ? "true" : undefined}
              aria-describedby={current ? errorId : undefined}
              value={props.modelValue}
              onInput={(event: Event) => update((event.target as HTMLTextAreaElement).value)}
              onScroll={syncScroll}
              onKeydown={onKeydown}
            />
          </div>
          <div class="pg-json-editor__status">
            {current ? (
              <span id={errorId} class="pg-json-editor__error" role="alert">
                {t("Invalid JSON at line {line}, column {column}: {message}", {
                  line: current.line,
                  column: current.column,
                  message: t(current.message),
                })}
              </span>
            ) : hasText.value ? (
              <span>{t("Valid JSON · {lines} lines", { lines: lineCount.value })}</span>
            ) : (
              <span>{t("Paste the spec produced from the AI transcript, or upload a .json file")}</span>
            )}
          </div>
        </div>
      );
    };
  },
});

export default JsonSpecEditor;
