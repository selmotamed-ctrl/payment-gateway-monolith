import { defineComponent, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { showSnackBar } from "@/utils/snackBar";

export const GuideCodeBlock = defineComponent({
    name: "GuideCodeBlock",
    props: {
        code: { type: String, default: "" },
        copyable: { type: Boolean, default: true },
    },
    setup(props) {
        const { t } = useLocale();

        const copy = async () => {
            if (!props.code) return;
            try {
                await navigator.clipboard.writeText(props.code);
                showSnackBar({ type: "success", message: t("Copied") });
            } catch {
                showSnackBar({ type: "error", message: t("Unable to copy") });
            }
        };

        return (): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}>
                {props.copyable && (
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <VBtn size="small" variant="tonal" onClick={() => void copy()}>
                            {t("Copy")}
                        </VBtn>
                    </div>
                )}
                <pre
                    class="pg-code-block"
                    style={{
                        direction: "ltr",
                        textAlign: "left",
                        background: "var(--pg-bg-surface-subtle)",
                        border: "1px solid var(--pg-border-subtle)",
                        borderRadius: "var(--pg-radius-sm)",
                        padding: "12px",
                        overflowX: "auto",
                        fontSize: "12px",
                        lineHeight: 1.6,
                        margin: 0,
                        whiteSpace: "pre",
                        fontFamily: "var(--pg-font-mono)",
                        color: "var(--pg-ink-primary)",
                    }}
                >
                    {props.code}
                </pre>
            </div>
        );
    },
});

export default GuideCodeBlock;
