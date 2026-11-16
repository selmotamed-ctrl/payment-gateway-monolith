import { getBaseUrl } from "@/constants/baseUrl";
import axios from "axios";
import { logout, user } from "../user";
import { sessionHeaders } from "@/utils/security/sessionToken";
import { extractApiError, isAppSuspendedError } from "@/utils/errors/extractor";
import { sandboxMirrorPath } from "@/state/sandbox";

export const api = axios.create({
    baseURL: getBaseUrl(),
    timeout: 120e3,
    adapter: "fetch",
});

api.interceptors.request.use((config) => {
    for (const [name, value] of Object.entries(sessionHeaders(user.value?.token))) {
        config.headers[name] = value;
    }
    config.headers["X-Client-Channel"] = "merchant";
    if (config.url) config.url = sandboxMirrorPath(config.url);
    return config;
});

api.interceptors.response.use(undefined, (error) => {
    const extractedError = extractApiError(error);
    if (extractedError) {
        // A 401 from the credential endpoints is a failed sign-in, not an expired session.
        const url = String(error?.config?.url ?? "");
        const isCredentialRequest = url.includes("/auth/login") || url.includes("/auth/mfa");
        if (extractedError.status == 401 && !isCredentialRequest && user.value?.token) {
            void logout();
        } else if (isAppSuspendedError(extractedError)) {
            void logout();
        }
    }
    throw error;
});
