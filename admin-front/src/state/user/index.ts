import type { UserAuthorityType, UserAuthoritiesMapType } from "@/utils/authorities";
import router from "@/router";
import { nextTick, ref } from "vue";
import { getBaseUrl } from "@/constants/baseUrl";
import { urlsMap } from "@/constants/urlsMap";
import { revokeServerSession } from "@/utils/security/sessionToken";
import { mapHasAllAuthorities, mapHasAuthority, type AdminRole } from "@/utils/authorities";

export type AdminUserInfo = {
    id: string;
    name: string;
    username: string;
    role: AdminRole | string;
    email: string | null;
    phone: string | null;
    authoritiesMap: UserAuthoritiesMapType;
    isMaker: boolean;
    isChecker: boolean;
};

export type UserState = {
    token: string;
    refreshToken: string | null;
    userInfo: AdminUserInfo;
};

export const userStorageKey = "PAYMENT_GATEWAY:ADMIN:USER";

export const setUserState = (userData: UserState | null) => {
    const previousId = user.value?.userInfo?.id ?? null;
    user.value = userData;

    if (userData) {
        localStorage.setItem(userStorageKey, JSON.stringify(userData));
    } else {
        localStorage.removeItem(userStorageKey);
    }
    // Per-user client state (the Academy progress and its queue of unsent patches) resets on any change of user.
    if ((userData?.userInfo?.id ?? null) !== previousId && typeof window !== "undefined") {
        window.dispatchEvent(new Event("pg:user-changed"));
    }
};

export const loggingOut = ref(false);

export const logout = async (options?: { redirect?: string }) => {
    loggingOut.value = true;
    // Server-side revoke (GAP-019): best effort, the local session is cleared regardless.
    await revokeServerSession(fetch, `${getBaseUrl()}/${urlsMap.authLogout}`, user.value?.token);
    setUserState(null);
    await nextTick();
    const redirect = options?.redirect && options.redirect !== "/login" ? options.redirect : undefined;
    await router.push({
        name: "Login",
        ...(redirect ? { query: { redirect } } : {}),
    }).catch(() => undefined);
    loggingOut.value = false;
};

export const getUserStateFromLocalStorage = (): UserState | null => {
    try {
        const storedData = localStorage.getItem(userStorageKey);
        if (!storedData) {
            return null;
        }
        const parsed = JSON.parse(storedData) as UserState;
        if (!parsed?.token || !parsed?.userInfo) {
            return null;
        }
        return parsed;
    } catch (error) {
        console.error("Error retrieving user info from storage", error);
        localStorage.removeItem(userStorageKey);
        return null;
    }
};

export const user = ref<null | UserState>(getUserStateFromLocalStorage());

export const hasOneOfAuthorities = (required?: UserAuthorityType[] | null): boolean =>
    mapHasAuthority(user.value?.userInfo?.authoritiesMap, required);

export const hasAllAuthorities = (required?: UserAuthorityType[] | null): boolean =>
    mapHasAllAuthorities(user.value?.userInfo?.authoritiesMap, required);

export const isAuthenticated = () => !!user.value?.token && !!user.value?.userInfo;
