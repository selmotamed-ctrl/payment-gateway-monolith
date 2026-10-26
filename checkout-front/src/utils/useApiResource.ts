import { ref, type Ref } from "vue";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

export type ApiResource<T> = {
    data: Ref<T | null>;
    loading: Ref<boolean>;
    error: Ref<string | null>;
    refresh: () => Promise<void>;
    setData: (value: T | null) => void;
};

export const useApiResource = <T>(loader: () => Promise<T>, immediate = true): ApiResource<T> => {
    const data = ref<T | null>(null) as Ref<T | null>;
    const loading = ref(false);
    const error = ref<string | null>(null);

    const refresh = async () => {
        loading.value = true;
        error.value = null;
        try {
            data.value = await loader();
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            data.value = null;
        } finally {
            loading.value = false;
        }
    };

    if (immediate) {
        void refresh();
    }

    return {
        data,
        loading,
        error,
        refresh,
        setData: (value: T | null) => {
            data.value = value;
        },
    };
};

export type ApiList<T> = ApiResource<T[]> & {
    total: Ref<number>;
    skip: Ref<number>;
    limit: Ref<number>;
    page: Ref<number>;
    setPage: (page: number) => void;
    setLimit: (limit: number) => void;
};

export const useApiList = <T>(
    loader: (params: { skip: number; limit: number }) => Promise<{ rows: T[]; total: number }>,
    initialLimit = 20,
): ApiList<T> => {
    const rows = ref<T[]>([]) as Ref<T[]>;
    const total = ref(0);
    const skip = ref(0);
    const limit = ref(initialLimit);
    const loading = ref(false);
    const error = ref<string | null>(null);

    const refresh = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await loader({ skip: skip.value, limit: limit.value });
            rows.value = response.rows ?? [];
            total.value = response.total ?? rows.value.length;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
            total.value = 0;
        } finally {
            loading.value = false;
        }
    };

    void refresh();

    return {
        data: rows,
        total,
        skip,
        limit,
        page: ref(1),
        loading,
        error,
        refresh,
        setData: (value: T[] | null) => {
            rows.value = value ?? [];
            total.value = rows.value.length;
        },
        setPage: (page: number) => {
            skip.value = Math.max(0, (page - 1) * limit.value);
            void refresh();
        },
        setLimit: (next: number) => {
            limit.value = next;
            skip.value = 0;
            void refresh();
        },
    };
};
