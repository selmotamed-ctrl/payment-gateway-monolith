import { isDev } from "@/constants/env";
import { trimSlashes } from "kt-common";

export const getBaseUrl = (): string => {
    const baseUrl = location.origin + "/api/app";
    console.log("Base url", { baseUrl });
    return baseUrl;
};

export const getRealBaseUrl = () => {
    if (isDev()) {
        return import.meta.env.VITE_API_URL + "api/app";
    }
    return getBaseUrl();
};

export const resolveUploadPath = (path: string) => {
    return `${getBaseUrl()}/uploads/${trimSlashes(path)}`;
};

export const resolvePublicUploadPath = (path: string) => {
    return `${getBaseUrl()}/public-uploads/${trimSlashes(path)}`;
};
