import type { UserAuthorityType, UserAuthoritiesMapType } from "@/utils/authorities";
import router from "@/router";
import { nextTick, ref } from "vue";
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
    user.value = userData;

    if (userData) {
        localStorage.setItem(userStorageKey, JSON.stringify(userData));
    } else {
        localStorage.removeItem(userStorageKey);
    }
};

export const loggingOut = ref(false);

export const logout = async () => {
    loggingOut.value = true;
    setUserState(null);
    await nextTick();
    await router.push({
        name: "Login",
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
