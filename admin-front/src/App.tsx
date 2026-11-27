import {PgAlert, PgApp, PgButton, PgConfirmDialog, PgDetailsDialog, PgProvider, PgText, PgView} from "@pg/ui";
import { useRouter } from "vue-router";
import { RouterView } from "vue-router/experimental/vapor";
import { dc } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import { devLog } from "@/utils/devLog";
import { routeError } from "@/state/route";
import { confirmDialogInstance } from "./utils/confirm";
import { detailsDialogRef } from "./utils/showDetails/idnex";
import { printProvider, PrintProvider } from "./utils/printJsx";
import { createUiConfig } from "./uiConfig";
import "./styles/globals/app.scss";

const App = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const config = createUiConfig(router);
    return () => (
        <PgProvider config={config}>
            <PgApp style={{ width: "100%" }}>
                <PrintProvider ref={(instance) => { printProvider.value = instance as any; }} />
                <PgConfirmDialog ref={(instance) => { confirmDialogInstance.value = instance as any; }} />
                <PgDetailsDialog
                    ref={(instance) => {
                        if (instance) {
                            devLog("Setting details dialog ref", instance);
                            detailsDialogRef.value = instance as any;
                        }
                    }}
                />
                {routeError.value && (
                    <div class="pg-route-error-overlay">
                        <PgAlert tone="danger">
                            <PgView class="pg-stack">
                                <PgText type="defaultSemiBold">{t("Page could not be loaded")}</PgText>
                                <PgText>{t(routeError.value.message)}</PgText>
                                <PgText muted style={{ direction: "ltr", wordBreak: "break-all" }}>{routeError.value.path}</PgText>
                                <PgView class="pg-inline">
                                    <PgButton
                                        variant="primary"
                                        prependIcon="mdi-reload"
                                        onClick={() => {
                                            sessionStorage.removeItem("vuetify:dynamic-import-attempts");
                                            window.location.assign(routeError.value?.path || "/");
                                        }}
                                    >
                                        {t("Retry page")}
                                    </PgButton>
                                    <PgButton
                                        variant="tonal"
                                        prependIcon="mdi-view-dashboard-outline"
                                        onClick={() => {
                                            routeError.value = null;
                                            window.location.assign("/");
                                        }}
                                    >
                                        {t("Go to Dashboard")}
                                    </PgButton>
                                </PgView>
                            </PgView>
                        </PgAlert>
                    </div>
                )}
                <RouterView />
            </PgApp>
        </PgProvider>
    );
});

export default App;
