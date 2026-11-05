import { getBaseUrl } from "@/constants/baseUrl";
import axios from "axios";

// The payer checkout is anonymous (the pay-link key is the capability), so there is
// no bearer-token handling here.
export const api = axios.create({
    baseURL: getBaseUrl(),
    timeout: 60e3,
    adapter: "fetch",
});

api.interceptors.request.use((config) => {
    config.headers["X-Client-Channel"] = "checkout";
    return config;
});
