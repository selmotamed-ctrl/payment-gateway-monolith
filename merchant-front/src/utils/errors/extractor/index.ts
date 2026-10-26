import axios from "axios";

function isNetworkError(error: any): boolean {
    return axios.isAxiosError(error) && !error.response;
}

export type ApiError = {
    code: string;
    errors: string[];
    error: string;
    status: number;
};

const networkError: ApiError = {
    error: "network error, please try again!",
    errors: [],
    status: 0,
    code: "network-error",
};

export const UnknownError: ApiError = {
    code: "UNKNOWN",
    error: "unknown error occurred",
    errors: [],
    status: 500,
};

export const extractApiError = (_error: any): ApiError | null => {
    const error: ApiError = _error;
    if (isNetworkError(_error)) {
        return networkError;
    }

    const accumulateSubErrorsList = (error: ApiError) => {
        const errorsList = [] as string[];
        for (const key in error?.errors) {
            errorsList.push(...((error.errors as any)[key] || []));
        }
        return errorsList;
    };

    if (typeof error?.error == "string" && typeof error?.status == "number") {
        return {
            code: error.code,
            error: error.error,
            errors: accumulateSubErrorsList(error),
            status: error.status,
        };
    }

    if (!_error?.response?.data || typeof _error?.response?.data != "object") {
        return null;
    }

    const errorData: ApiError = _error.response?.data;

    const normalized = Object.fromEntries(
        Object.entries(errorData).map(([key, value]) => {
            return [String(key).toLowerCase(), value];
        }),
    ) as any;

    const errorStatus: number | undefined = normalized?.status;
    const errorMessage: string | undefined = normalized?.error ?? normalized?.message;
    const errorCode: string | undefined = normalized?.code;

    if (errorCode && errorStatus && errorMessage) {
        return {
            code: normalized.code,
            error: errorMessage,
            errors: normalized.errors ?? [],
            status: errorStatus,
        };
    }
    return null;
};

export const extractApiErrorMessage = (error: any): string => {
    const extracted = extractApiError(error);
    if (!extracted) {
        return "unexpected error occurred";
    }
    return extracted.error || "unexpected error occurred";
};

export const extractApiErrorDetails = (error: any): string[] => {
    const extracted = extractApiError(error);
    if (!extracted) {
        return [];
    }
    return extracted.errors?.length ? extracted.errors : [];
};

export const isAppSuspendedError = (error: ApiError | null | undefined): boolean => {
    if (!error) {
        return false;
    }
    return ["APP_SUSPENDED", "PLATFORM_SUSPENDED"].includes(String(error.code || "").toUpperCase());
};
