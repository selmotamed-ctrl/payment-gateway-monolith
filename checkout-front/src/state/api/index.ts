import { getBaseUrl } from "@/constants/baseUrl";
import axios from "axios";
import { extractApiError } from "@/utils/errors/extractor";

const tokenStorageKey = "PAYMENT_GATEWAY:CHECKOUT:TOKEN";

export const getAuthToken = (): string | null => {
    try {
        return localStorage.getItem(tokenStorageKey);
    } catch {
        return null;
    }
};

export const setAuthToken = (token: string | null) => {
    try {
        if (token) {
            localStorage.setItem(tokenStorageKey, token);
        } else {
            localStorage.removeItem(tokenStorageKey);
        }
    } catch {
        return;
    }
};

export const api = axios.create({
    baseURL: getBaseUrl(),
    timeout: 60e3,
    adapter: "fetch",
});

api.interceptors.request.use((config) => {
    const token = getAuthToken();
    if (token) {
        config.headers["Authorization"] = `Bearer ${token}`;
    }
    config.headers["X-Client-Channel"] = "checkout";
    return config;
});

api.interceptors.response.use(undefined, (error) => {
    const extractedError = extractApiError(error);
    if (extractedError && extractedError.status === 401) {
        setAuthToken(null);
        window.dispatchEvent(new CustomEvent("checkout:unauthorized"));
    }
    throw error;
});
