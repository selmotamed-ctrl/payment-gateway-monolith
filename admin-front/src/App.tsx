import { devLog } from "@/utils/devLog";
import "./styles/globals/app.scss";
import { RouterView } from "vue-router";
import { dc } from "kt-dc";
import { confirmDialogInstance } from "./utils/confirm";
import { AwaitedConfirmationDialog } from "./components/ConfirmDialog";
import { snackBarInstance } from "./utils/snackBar";
import { VAlert, VApp, VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { routeError } from "@/state/route";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { SnackBar } from "@/components/SnackBar/index";
import { DetailsFieldsDialog } from "./components/detailsFieldsDialog";
import { detailsDialogRef } from "./utils/showDetails/idnex";
import { printProvider, PrintProvider } from "./utils/printJsx";

const App = dc(() => {
    const { t } = useLocale();
    return () => {
        return (
            <VApp
                style={{
                    height: "100%",
                    width: "100%",
                }}
            >
                <PrintProvider
                    ref={(r) => {
                        printProvider.value = r as any;
                    }}
                ></PrintProvider>
                <AwaitedConfirmationDialog
                    ref={(r) => {
                        confirmDialogInstance.value = r as any;
                    }}
                ></AwaitedConfirmationDialog>
                <DetailsFieldsDialog
                    ref={(r) => {
                        if (r) {
                            devLog("Setting details dialog ref", r);
                            detailsDialogRef.value = r as any;
                        }
                    }}
                ></DetailsFieldsDialog>
                <SnackBar
                    ref={(r) => {
                        snackBarInstance.value = r as any;
                    }}
                ></SnackBar>

                {routeError.value && (
                    <div class="pg-route-error-overlay">
                        <VAlert type="error" variant="tonal" prominent>
                            <ThemedView style={{ gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Page could not be loaded")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>{t(routeError.value.message)}</ThemedText>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.65, direction: "ltr", wordBreak: "break-all" }}>{routeError.value.path}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                    <VBtn
                                        color="primary"
                                        variant="flat"
                                        prependIcon="mdi-reload"
                                        onClick={() => {
                                            sessionStorage.removeItem("vuetify:dynamic-import-attempts");
                                            window.location.assign(routeError.value?.path || "/");
                                        }}
                                    >
                                        {t("Retry page")}
                                    </VBtn>
                                    <VBtn
                                        variant="tonal"
                                        prependIcon="mdi-view-dashboard-outline"
                                        onClick={() => {
                                            routeError.value = null;
                                            window.location.assign("/");
                                        }}
                                    >
                                        {t("Go to Dashboard")}
                                    </VBtn>
                                </ThemedView>
                            </ThemedView>
                        </VAlert>
                    </div>
                )}

                <RouterView />
            </VApp>
        );
    };
});

export default App;
