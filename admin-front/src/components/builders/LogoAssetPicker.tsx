import { computed, defineComponent, onMounted, ref, watch, type PropType, type VNodeChild } from "vue";
import { VAlert, VBtn, VFileInput, VSelect } from "vuetify/components";
import { useLocale } from "vuetify";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { FormField } from "@/components/ui/FormField";
import { MonoRef } from "@/components/ui/MonoRef";
import { LOGO_ERROR_MESSAGES } from "./messages";
import { assetMimeToContentType, formatBytes, validateLogoFile } from "./model/assets";

export type LogoAsset = {
    id: string;
    name: string;
    mime: string;
    sizeBytes: number;
    storageKey: string;
    storageObjectId: string | null;
    sha256: string;
};

const MIME_LABEL: Record<string, string> = { "image/png": "PNG", "image/svg+xml": "SVG" };

/**
 * Picks the logo asset of a rail from the asset catalogue (`GET /assets`) and uploads a new logo to
 * the shared object-storage vault (`POST /assets/upload`). The bytes are stored once and locked by
 * the Asset row; assigning the asset to a rail adds a second `RAIL_LOGO` lock.
 */
export const LogoAssetPicker = defineComponent({
    name: "LogoAssetPicker",
    props: {
        modelValue: { type: String as PropType<string | null>, default: null },
        disabled: { type: Boolean, default: false },
        canRegister: { type: Boolean, default: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const assets = ref<LogoAsset[]>([]);
        const loading = ref(true);
        const loadError = ref("");
        const registering = ref(false);
        const registerError = ref("");
        const previewUrl = ref<string | null>(null);

        const load = async () => {
            loading.value = true;
            loadError.value = "";
            try {
                const response = await api.get(urlsMap.assetsList);
                const payload = response.data?.data ?? response.data ?? {};
                assets.value = ((payload.assets ?? []) as LogoAsset[]).filter((asset) =>
                    Boolean(asset.storageObjectId)
                    && (asset.mime === "IMAGE_PNG" || asset.mime === "IMAGE_SVG_XML" || asset.mime === "image/png" || asset.mime === "image/svg+xml"),
                );
            } catch (error) {
                loadError.value = extractApiErrorMessage(error);
            } finally {
                loading.value = false;
                void loadPreview();
            }
        };
        onMounted(() => void load());

        const selected = computed(() => assets.value.find((asset) => asset.id === props.modelValue) ?? null);
        const loadPreview = async () => {
            if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
            previewUrl.value = null;
            if (!selected.value) return;
            try {
                const response = await api.get(urlsMap.assetContent(selected.value.id), { responseType: "blob" });
                previewUrl.value = URL.createObjectURL(new Blob([response.data], { type: assetMimeToContentType(selected.value.mime) }));
            } catch {
                previewUrl.value = null;
            }
        };
        watch(() => props.modelValue, () => void loadPreview());

        const typeLabel = (asset: LogoAsset): string => MIME_LABEL[assetMimeToContentType(asset.mime)] ?? asset.mime;

        const removeSelected = async () => {
            if (!selected.value || props.disabled) return;
            if (!window.confirm(t("Delete this logo asset?"))) return;
            registerError.value = "";
            try {
                await api.delete(urlsMap.assetDelete(selected.value.id));
                emit("update:modelValue", null);
                await load();
                showSnackBar({ type: "success", message: t("Logo deleted") });
            } catch (error) {
                registerError.value = extractApiErrorMessage(error);
            }
        };

        const register = async (value: File | File[] | null) => {
            const file = Array.isArray(value) ? value[0] : value;
            if (!file || registering.value) return;
            registerError.value = "";
            const problem = validateLogoFile({ name: file.name, type: file.type, size: file.size });
            if (problem) {
                registerError.value = t(LOGO_ERROR_MESSAGES[problem]);
                return;
            }
            registering.value = true;
            try {
                const form = new FormData();
                form.append("file", file, file.name);
                form.append("name", file.name.slice(0, 120));
                const response = await api.post(urlsMap.assetsUpload, form);
                const payload = response.data?.data ?? response.data ?? {};
                await load();
                if (typeof payload.id === "string") emit("update:modelValue", payload.id);
                showSnackBar({ type: "success", message: t("Logo registered") });
            } catch (error) {
                registerError.value = extractApiErrorMessage(error);
            } finally {
                registering.value = false;
            }
        };

        return (): VNodeChild => {
            const orphan = props.modelValue && !selected.value && !loading.value;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", minInlineSize: 0 }}>
                    <FormField label={t("Logo asset")} error={loadError.value}>
                        <VSelect
                            modelValue={props.modelValue}
                            onUpdate:modelValue={(value: string | null) => emit("update:modelValue", value ?? null)}
                            items={assets.value.map((asset) => ({ title: `${asset.name} · ${typeLabel(asset)} · ${formatBytes(asset.sizeBytes)}`, value: asset.id }))}
                            loading={loading.value}
                            disabled={props.disabled}
                            clearable
                            placeholder={t("No logo")}
                            density="compact"
                            hideDetails
                        />
                    </FormField>
                    {selected.value && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--pg-ink-secondary)" }}>
                            {previewUrl.value && <img src={previewUrl.value} alt={selected.value.name} style={{ maxHeight: "64px", maxWidth: "160px", objectFit: "contain", border: "1px solid var(--pg-border-subtle)", borderRadius: "6px", padding: "4px", background: "var(--pg-surface)" }} />}
                            <span dir="auto">{selected.value.name}</span>
                            <span>{typeLabel(selected.value)}</span>
                            <span>{formatBytes(selected.value.sizeBytes)}</span>
                            <MonoRef value={selected.value.sha256.slice(0, 12)} copyable={false} />
                        </div>
                    )}
                    {orphan && (
                        <span style={{ fontSize: "12px", color: "var(--pg-status-warning-text)" }}>{t("The current logo asset is no longer in the catalogue.")}</span>
                    )}
                    {props.canRegister && !props.disabled && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            <FormField label={t("Register a new logo")} hint={t("PNG or SVG, up to 5 MB.")} error={registerError.value}>
                                <VFileInput
                                    {...{ accept: "image/png,image/svg+xml" }}
                                    modelValue={null}
                                    prependIcon="mdi-image-plus-outline"
                                    loading={registering.value}
                                    density="compact"
                                    hideDetails
                                    onUpdate:modelValue={(value: File | File[] | null) => void register(value)}
                                />
                            </FormField>
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("The logo is stored in the shared encrypted vault, checked for active content and locked by its catalogue record.")}
                            </VAlert>
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                <VBtn size="small" variant="text" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Reload assets")}</VBtn>
                                {selected.value && <VBtn size="small" variant="text" color="error" prependIcon="mdi-delete-outline" onClick={() => void removeSelected()}>{t("Delete selected logo")}</VBtn>}
                            </div>
                        </div>
                    )}
                </div>
            );
        };
    },
});
