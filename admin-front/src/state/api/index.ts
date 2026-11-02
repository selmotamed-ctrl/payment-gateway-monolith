import { getBaseUrl, resolveUploadPath } from "@/constants/baseUrl";
import axios from "axios";
import { logout, user } from "../user";
import { extractApiError, isAppSuspendedError } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import router from "@/router";

export const api = axios.create({
    baseURL: getBaseUrl(),
    timeout: 120e3,
    adapter: "fetch",
});

api.interceptors.request.use((config) => {
    if (user.value?.token) {
        config.headers["Authorization"] = `Bearer ${user.value.token}`;
    }
    config.headers["X-Client-Channel"] = "admin";
    return config;
});

api.interceptors.response.use(undefined, (error) => {
    const extractedError = extractApiError(error);
    if (extractedError) {
        const url = String(error?.config?.url ?? "");
        const isCredentialRequest = url.includes("/auth/login") || url.includes("/auth/mfa");
        if (extractedError.status == 401 && !isCredentialRequest && user.value?.token) {
            const redirect = router.currentRoute.value.fullPath;
            showSnackBar({
                type: "warning",
                message: "Your session expired. Please sign in again.",
            });
            void logout({ redirect });
        } else if (isAppSuspendedError(extractedError)) {
            void logout();
        }
    }
    throw error;
});

export const resolveUploadPathWithMat = (path: string) => {
    return `${resolveUploadPath(path)}?mat=${encodeURIComponent(user.value?.token || "")}`;
};
