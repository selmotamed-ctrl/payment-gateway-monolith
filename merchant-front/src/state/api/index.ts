import { getBaseUrl, resolveUploadPath } from "@/constants/baseUrl";
import axios from "axios";
import { logout, user } from "../user";
import { extractApiError, isAppSuspendedError } from "@/utils/errors/extractor";
import { loadAppStatus } from "../app";

export const api = axios.create({
    baseURL: getBaseUrl(),
    timeout: 120e3,
    adapter: "fetch",
});
api.interceptors.request.use((config) => {
    if (user.value?.token) {
        config.headers["Authorization"] = `Bearer ${user.value.token}`;
    }

    return config;
});

api.interceptors.response.use(undefined, (error) => {
    const extractedError = extractApiError(error);
    if (!!extractedError) {
        if (isAppSuspendedError(extractedError)) {
            loadAppStatus();
        } else if (extractedError.status == 401) {
            logout();
        }
    }

    throw error;
});

export const resolveUploadPathWithMat = (path: string) => {
    const url = `${resolveUploadPath(path)}?mat=${encodeURIComponent(user.value?.token || "")}`;
    console.log("Mat url", url);
    return url;
};
