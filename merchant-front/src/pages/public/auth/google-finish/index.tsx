import { dc } from "@/utils/dc";
import {VAlert, PgButton} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import { ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setUserState, type UserState } from "@/state/user";
import { tokenFromLoginPayload } from "@/utils/security/sessionToken";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import {SurfaceCard} from "@pg/ui";

const GoogleFinishPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const ticket = typeof route.query.ticket === "string" ? route.query.ticket : "";
    const error = ref<string | null>(null);
    const loading = ref(false);

    const finish = async () => {
        if (!ticket || loading.value) return;
        loading.value = true;
        error.value = null;
        try {
            const response = await api.post(urlsMap.authGoogleExchange, { ticket });
            const payload = response.data?.data ?? response.data ?? {};
            const session: UserState = {
                token: tokenFromLoginPayload(payload) as string,
                refreshToken: payload?.refreshToken ?? null,
                userInfo: {
                    id: String(payload?.userInfo?.id ?? payload?.user?.id ?? ""),
                    name: payload?.userInfo?.name ?? payload?.user?.name ?? "",
                    username: payload?.userInfo?.username ?? payload?.user?.username ?? "",
                    role: payload?.userInfo?.role ?? payload?.user?.role ?? "",
                    email: payload?.userInfo?.email ?? null,
                    phone: payload?.userInfo?.phone ?? null,
                    merchantId: String(payload?.userInfo?.merchantId ?? payload?.merchant?.id ?? ""),
                    merchantTradeName: payload?.userInfo?.merchantTradeName ?? payload?.merchant?.tradeName ?? "",
                    authoritiesMap: payload?.userInfo?.authoritiesMap ?? payload?.authoritiesMap ?? {},
                    appScopeIds: payload?.userInfo?.appScopeIds ?? [],
                    isMaker: !!payload?.userInfo?.isMaker,
                    isChecker: !!payload?.userInfo?.isChecker,
                },
            };
            if (!session.token) throw new Error("missing token");
            setUserState(session);
            await router.push({ name: "Dashboard" });
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    if (ticket) void finish();

    return () => (
        <AuthLayout>
            <SurfaceCard title={t("Signing in with Google")}>
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {error.value ? (
                        <>
                            <VAlert type="error" variant="tonal" density="compact">{error.value}</VAlert>
                            <PgButton onClick={() => void router.push({ name: "Login" })}>{t("Back to sign in")}</PgButton>
                        </>
                    ) : (
                        <VAlert type="info" variant="tonal" density="compact">{t("Completing sign-in…")}</VAlert>
                    )}
                    {!ticket && <VAlert type="error" variant="tonal" density="compact">{t("The sign-in link is invalid.")}</VAlert>}
                </div>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default GoogleFinishPage;
