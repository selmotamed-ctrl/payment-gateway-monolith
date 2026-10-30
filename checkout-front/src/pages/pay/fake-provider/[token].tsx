import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText } from "vuetify/components";
import CheckoutLayout from "@/layouts/checkout";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

const newIdempotencyKey = () =>
    `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const decodeToken = (token: string): Record<string, unknown> => {
    const body = token.split(".")[0] ?? "";
    const normalized = body.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
};

const FakeProviderPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const submitting = ref(false);
    const error = ref<string | null>(null);
    const completed = ref(false);

    const token = computed(() => String(route.params.token ?? ""));
    const payload = computed<Record<string, unknown>>(() => {
        try {
            return decodeToken(token.value);
        } catch {
            return {};
        }
    });
    const linkKey = computed(() => String(payload.value.link_key ?? ""));
    const attemptId = computed(() => String(payload.value.attempt_id ?? ""));
    const reference = computed(() => String(payload.value.reference ?? ""));

    const complete = async (decision: "APPROVE" | "DECLINE") => {
        if (!linkKey.value || !attemptId.value) {
            error.value = t("Invalid demo payment link");
            return;
        }
        submitting.value = true;
        error.value = null;
        try {
            await api.post(urlsMap.payConfirm(linkKey.value, attemptId.value), {
                evidence: { demo_outcome: decision },
                idempotencyKey: newIdempotencyKey(),
            });
            completed.value = true;
            if (decision === "APPROVE") {
                await router.push({ name: "Pay", params: { linkKey: linkKey.value } });
            }
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            submitting.value = false;
        }
    };

    return () => (
        <CheckoutLayout title={t("Demo Payment Provider")}>
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                        {t("Demo Payment Provider")}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "14px", opacity: 0.8 }}>
                        {reference.value
                            ? `${t("Reference")}: ${reference.value}`
                            : t("Choose how this demo payment should complete.")}
                    </ThemedText>
                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}
                    {completed.value ? (
                        <VAlert type="success" variant="tonal" density="compact">
                            {t("Demo payment completed")}
                        </VAlert>
                    ) : (
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VBtn
                                color="success"
                                loading={submitting.value}
                                disabled={!linkKey.value || !attemptId.value}
                                onClick={() => void complete("APPROVE")}
                            >
                                {t("Approve")}
                            </VBtn>
                            <VBtn
                                color="error"
                                variant="tonal"
                                loading={submitting.value}
                                disabled={!linkKey.value || !attemptId.value}
                                onClick={() => void complete("DECLINE")}
                            >
                                {t("Decline")}
                            </VBtn>
                        </ThemedView>
                    )}
                </VCardText>
            </VCard>
        </CheckoutLayout>
    );
});

export default FakeProviderPage;
