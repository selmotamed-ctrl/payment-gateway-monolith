import { resolvePublicUploadPath, resolveUploadPath } from "@/constants/baseUrl";
import { api } from "@/state/api";
import { dc } from "kt-dc";
import type { StyleValue } from "vue";

const ApiImage = dc(
    (props: { public?: boolean; uploadsPath: string; alt?: string; style?: StyleValue }) => {
        const loading = ref(false);
        const dataUrl = ref(null as null | string);
        const svg = ref(false);
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
                const contentType = result.headers["Content-Type"];
                console.log("Content Type", result.headers);
                if (contentType === "image/svg+xml") {
                    svg.value = true;
                }
                dataUrl.value = URL.createObjectURL(result.data);
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
                if (svg.value) {
                    return <object data={dataUrl.value} style={props.style}></object>;
                }
                return <img style={props.style} src={dataUrl.value}></img>;
            }
        };
    },
    {
        props: ["alt", "public", "style", "uploadsPath"],
    },
);

export default ApiImage;
