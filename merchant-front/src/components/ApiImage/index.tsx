import { resolvePublicUploadPath, resolveUploadPath } from "@/constants/baseUrl";
import { api } from "@/state/api";
import { safeRasterImageMime } from "@/utils/safeBlob";
import { dc } from "kt-dc";
import type { StyleValue } from "vue";

const ApiImage = dc(
    (props: { public?: boolean; uploadsPath: string; alt?: string; style?: StyleValue }) => {
        const loading = ref(false);
        const dataUrl = ref(null as null | string);
        const loadImage = async () => {
            if (loading.value) {
                return;
            }
            loading.value = true;
            try {
                const url = props.public ? resolvePublicUploadPath(props.uploadsPath) : resolveUploadPath(props.uploadsPath);
                const result = await api.get(url, {
                    responseType: "blob",
                });
                // Only raster images are rendered (never SVG, never an embedded object): trust the blob type, not a header.
                const blob = result.data as Blob;
                const mime = safeRasterImageMime(blob.type);
                if (!mime) {
                    return;
                }
                dataUrl.value = URL.createObjectURL(blob.slice(0, blob.size, mime));
            } catch (error) {
                console.error(error);
            } finally {
                loading.value = false;
            }
        };

        onBeforeMount(() => {
            loadImage();
        });

        onBeforeUnmount(() => {
            if (dataUrl.value) {
                URL.revokeObjectURL(dataUrl.value);
            }
        });

        return () => {
            if (dataUrl.value) {
                return <img style={props.style} src={dataUrl.value}></img>;
            }
        };
    },
    {
        props: ["alt", "public", "style", "uploadsPath"],
    },
);

export default ApiImage;
