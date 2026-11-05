import { safePreviewMime } from "@/utils/safeBlob";
import { dc } from "kt-dc";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VProgressCircular } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatBytes } from "../kybReviewHelp";

type PreviewDocument = {
    id: string;
    avStatus: string;
    contentAvailable: boolean;
    mime: string;
    originalFileName: string | null;
    sizeBytes: number;
};

const KybDocumentPreview = dc(
    (props: { document: PreviewDocument | null }) => {
        const { t } = useLocale();
        const loading = ref(false);
        const error = ref<string | null>(null);
        const objectUrl = ref<string | null>(null);
        const kind = computed(() => {
            const mime = props.document?.mime ?? "";
            if (mime === "application/pdf") return "pdf";
            if (mime === "image/png" || mime === "image/jpeg") return "image";
            return "other";
        });

        const revoke = () => {
            if (objectUrl.value) {
                URL.revokeObjectURL(objectUrl.value);
                objectUrl.value = null;
            }
        };

        const load = async () => {
            revoke();
            error.value = null;
            const document = props.document;
            if (!document) return;
            if (document.avStatus !== "CLEAN") {
                error.value = t("The document has not passed malware scanning and cannot be opened.");
                return;
            }
            if (!document.contentAvailable) {
                error.value = t("The encrypted document content is not available for this legacy record.");
                return;
            }
            loading.value = true;
            try {
                const response = await api.get(urlsMap.kybDocumentContent(document.id), { responseType: "blob" });
                const mime = safePreviewMime(document.mime);
                if (!mime) {
                    error.value = t("This file type cannot be previewed.");
                    return;
                }
                objectUrl.value = URL.createObjectURL(new Blob([response.data], { type: mime }));
            } catch (cause) {
                error.value = extractApiErrorMessage(cause);
            } finally {
                loading.value = false;
            }
        };

        watch(() => props.document?.id, () => void load(), { immediate: true });
        onBeforeUnmount(revoke);

        const openInNewTab = () => {
            if (objectUrl.value) window.open(objectUrl.value, "_blank", "noopener,noreferrer");
        };

        return () => {
            if (!props.document) {
                return <ThemedText style={{ opacity: 0.6 }}>{t("No document selected")}</ThemedText>;
            }
            return (
                <ThemedView style={{ gap: "10px", width: "100%" }}>
                    <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px", flex: 1 }}>
                            {props.document.originalFileName || props.document.id}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                            {props.document.mime} · {formatBytes(props.document.sizeBytes)}
                        </ThemedText>
                        {objectUrl.value && (
                            <VBtn size="x-small" variant="tonal" prependIcon="mdi-open-in-new" onClick={openInNewTab}>
                                {t("Open in new tab")}
                            </VBtn>
                        )}
                    </ThemedView>
                    {loading.value && (
                        <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "240px" }}>
                            <VProgressCircular indeterminate color="primary" />
                        </ThemedView>
                    )}
                    {!loading.value && error.value && (
                        <VAlert type="warning" variant="tonal">{error.value}</VAlert>
                    )}
                    {!loading.value && !error.value && objectUrl.value && kind.value === "pdf" && (
                        <iframe
                            title={props.document.originalFileName || "KYB document"}
                            src={objectUrl.value}
                            style={{ width: "100%", height: "72vh", border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-lg)", background: "var(--pg-bg-surface)" }}
                        />
                    )}
                    {!loading.value && !error.value && objectUrl.value && kind.value === "image" && (
                        <div style={{ width: "100%", maxHeight: "72vh", overflow: "auto", textAlign: "center" }}>
                            <img
                                src={objectUrl.value}
                                alt={props.document.originalFileName || "KYB document"}
                                style={{ maxWidth: "100%", height: "auto", borderRadius: "var(--pg-radius-lg)" }}
                            />
                        </div>
                    )}
                    {!loading.value && !error.value && objectUrl.value && kind.value === "other" && (
                        <VAlert type="info" variant="tonal">{t("This file type cannot be rendered inline. Use Open in new tab.")}</VAlert>
                    )}
                </ThemedView>
            );
        };
    },
    { props: ["document"] },
);

export default KybDocumentPreview;
