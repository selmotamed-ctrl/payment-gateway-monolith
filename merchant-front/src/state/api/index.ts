import { getBaseUrl, resolveUploadPath } from "@/constants/baseUrl";
import axios from "axios";
import { logout, user } from "../user";
import { extractApiError, isAppSuspendedError } from "@/utils/errors/extractor";

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
        if (extractedError.status == 401) {
            void logout();
        } else if (isAppSuspendedError(extractedError)) {
            void logout();
        }
    }
    throw error;
});

export const resolveUploadPathWithMat = (path: string) => {
    return `${resolveUploadPath(path)}?mat=${encodeURIComponent(user.value?.token || "")}`;
};
