import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import type { RedirectClientAction } from "./types";

export type RedirectRendererProps = {
    action: RedirectClientAction;
    allowlistedHosts?: string[];
    error?: string | null;
    onRedirect?: (url: string) => void;
};

import { isAllowedRedirect } from "@/utils/redirect";

export { isAllowedRedirect } from "@/utils/redirect";

export const RedirectRenderer = dc(
    (props: RedirectRendererProps) => {
        const { t } = useLocale();
        const redirecting = ref(false);
        const localError = ref<string | null>(null);

        const allowed = () => isAllowedRedirect(props.action.url, props.allowlistedHosts);

        const perform = () => {
            if (redirecting.value) {
                return;
            }
            if (!allowed()) {
                localError.value = t("Return Url Not Allowed");
                return;
            }
            redirecting.value = true;
            props.onRedirect?.(props.action.url);

            if (props.action.method === "POST_FORM") {
                const form = document.createElement("form");
                form.method = "POST";
                form.action = props.action.url;
                form.target = props.action.target ?? "_self";
                Object.entries(props.action.form_fields ?? {}).forEach(([name, value]) => {
                    const input = document.createElement("input");
                    input.type = "hidden";
                    input.name = name;
                    input.value = value;
                    form.appendChild(input);
                });
                document.body.appendChild(form);
                form.submit();
                return;
            }

            const query = new URLSearchParams(props.action.form_fields ?? {}).toString();
            const target = query ? `${props.action.url}${props.action.url.includes("?") ? "&" : "?"}${query}` : props.action.url;
            window.location.assign(target);
        };

        onMounted(() => {
            perform();
        });

        return () => (
            <ThemedView style={{ gap: "14px", width: "100%", alignItems: "center" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                    {t("Continue To Payment")}
                </ThemedText>
                <ThemedText style={{ fontSize: "13px", opacity: 0.75, textAlign: "center" }}>
                    {t("You will be redirected")}
                </ThemedText>

                {(props.error || localError.value) && (
                    <VAlert type="error" variant="tonal" density="compact">
                        {props.error || localError.value}
                    </VAlert>
                )}

                <VBtn color="primary" size="large" block loading={redirecting.value} onClick={perform}>
                    {t("Redirecting")}
                </VBtn>
            </ThemedView>
        );
    },
    {
        props: ["action", "allowlistedHosts", "error", "onRedirect"],
    },
);

export default RedirectRenderer;
