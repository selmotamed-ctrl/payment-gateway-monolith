import {PgApp, PgConfirmDialog, PgDetailsDialog, PgProvider} from "@pg/ui";
import { useRouter } from "vue-router";
import { RouterView } from "vue-router/experimental/vapor";
import { dc } from "@/utils/dc";
import { confirmDialogInstance } from "./utils/confirm";
import { detailsDialogRef } from "./utils/showDetails/idnex";
import { printProvider, PrintProvider } from "./utils/printJsx";
import { createUiConfig } from "./uiConfig";
import "./styles/globals/app.scss";

const App = dc(() => {
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
                            detailsDialogRef.value = instance as any;
                        }
                    }}
                />
                <RouterView />
            </PgApp>
        </PgProvider>
    );
});

export default App;
