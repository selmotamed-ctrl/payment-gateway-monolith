import { isDev } from "@/constants/env";
import { trimSlashes } from "kt-common";

export const getBaseUrl = (): string => {
    if (isDev()) {
        const configured = (import.meta.env.VITE_API_URL as string | undefined) || "";
        if (configured) {
            return `${trimSlashes(configured)}/api`.replace(/\/+$/, "");
        }
    }
    return "/api";
};

export const getRealBaseUrl = () => {
    if (isDev()) {
        return `${trimSlashes((import.meta.env.VITE_API_URL as string | undefined) || "")}/api`;
    }
    return getBaseUrl();
};

export const resolveUploadPath = (path: string) => {
    return `${getBaseUrl()}/uploads/${trimSlashes(path)}`;
};

export const resolvePublicUploadPath = (path: string) => {
    return `${getBaseUrl()}/public-uploads/${trimSlashes(path)}`;
};
