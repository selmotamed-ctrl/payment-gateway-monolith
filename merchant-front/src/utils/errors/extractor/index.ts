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
            errorsList.push(...(error.errors[key] || []));
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
        console.log("Returning null as extracted error because there is no data", _error);
        return null;
    }

    let errorData: ApiError = _error.response?.data;

    errorData = Object.fromEntries(
        Object.entries(errorData).map(([key, value]) => {
            return [String(key).toLowerCase(), value];
        }),
    ) as any;

    const errorStatus: number | undefined = errorData?.status;
    const errorMessage: string | undefined = errorData?.error;
    const errorCode: string | undefined = errorData?.code;

    if (errorCode && errorStatus && errorMessage) {
        return {
            code: errorData.code,
            error: errorData.error,
            errors: errorData.errors,
            status: errorData.status,
        };
    }
    console.log("Returning null extracted error because there is no valid data");
    return null;
};
