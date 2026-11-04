import { isRef, ref, unref, watch, type Ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import type { Eligibility } from "@/content/academy/apiTypes";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Exam eligibility from the server; on failure `error` is set and `eligibility` stays null. */
export const useEligibility = (examId: string | Ref<string>) => {
    const eligibility = ref<Eligibility | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);

    const refresh = async (): Promise<void> => {
        const id = unref(examId);
        if (!id) {
            eligibility.value = null;
            return;
        }
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.academyExamEligibility(id));
            const body: unknown = response.data;
            const payload = isRecord(body) && "data" in body && isRecord(body.data) ? body.data : body;
            if (isRecord(payload) && typeof payload.eligible === "boolean" && Array.isArray(payload.missing)) {
                eligibility.value = payload as unknown as Eligibility;
            } else {
                eligibility.value = null;
                error.value = "Unexpected response";
            }
        } catch (caught) {
            eligibility.value = null;
            error.value = caught instanceof Error ? caught.message : "Unavailable";
        } finally {
            loading.value = false;
        }
    };

    if (isRef(examId)) watch(examId, () => void refresh());
    void refresh();

    return { eligibility, loading, error, refresh };
};
